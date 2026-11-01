import { EventEmitter } from "node:events";
import type { ProcessPool } from "./process_pool.js";
import type { WorkbenchRegistry } from "./registry.js";
import { assertSafeIdentifier, type CircuitBreakerState, type ServerHealthStatus } from "./types.js";

export interface WatchdogOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  probeIntervalMs?: number;
  maxRestartsPerWindow?: number;
  restartTimeWindowMs?: number;
}

/**
 * Module 6: Health Watchdog & Fast Circuit Breaker (`HealthWatchdog`).
 * Resolves the Silent Hang & Deadlock Problem in Multi-Agent environments:
 * 1. Tracks downstream server health and failure counts.
 * 2. Trips to "OPEN" circuit state upon consecutive timeouts/crashes, failing fast in 0ms instead of 60s!
 * 3. Safely transitions to "HALF_OPEN" to test recovery, auto-healing stuck services via ProcessPool.
 */
export class HealthWatchdog extends EventEmitter {
  private readonly registry: WorkbenchRegistry;
  private readonly processPool: ProcessPool;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly maxRestartsPerWindow: number;
  private readonly restartTimeWindowMs: number;

  private readonly healthMap = new Map<string, ServerHealthStatus>();
  private readonly restartHistory = new Map<string, number[]>();
  private probeTimer: NodeJS.Timeout | null = null;
  private isAutoHealing = new Set<string>();

  constructor(
    registry: WorkbenchRegistry,
    processPool: ProcessPool,
    options: WatchdogOptions = {}
  ) {
    super();
    this.registry = registry;
    this.processPool = processPool;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 15000;
    this.probeIntervalMs = options.probeIntervalMs ?? 30000;
    this.maxRestartsPerWindow = options.maxRestartsPerWindow ?? 5;
    this.restartTimeWindowMs = options.restartTimeWindowMs ?? 300000; // 5 min
  }

  private getOrCreateStatus(serverId: string): ServerHealthStatus {
    assertSafeIdentifier(serverId, "serverId");
    let status = this.healthMap.get(serverId);
    if (!status) {
      status = {
        serverId,
        state: "CLOSED",
        consecutiveFailures: 0,
        lastFailureTime: null,
        lastCheckTime: null,
        lastProbeSuccess: true,
        totalRestarts: 0,
      };
      this.healthMap.set(serverId, status);
    }
    return status;
  }

  public isCallPermitted(serverId: string): { permitted: boolean; reason?: string } {
    const status = this.getOrCreateStatus(serverId);

    if (status.state === "CLOSED") {
      return { permitted: true };
    }

    if (status.state === "OPEN") {
      const now = Date.now();
      if (status.lastFailureTime && now - status.lastFailureTime >= this.resetTimeoutMs) {
        status.state = "HALF_OPEN";
        this.emit("stateChanged", { serverId, from: "OPEN", to: "HALF_OPEN" });
        return { permitted: true };
      }
      const remainingMs = status.lastFailureTime
        ? Math.max(0, this.resetTimeoutMs - (now - status.lastFailureTime))
        : this.resetTimeoutMs;
      return {
        permitted: false,
        reason: `CIRCUIT_BREAKER_OPEN: Server '${serverId}' is in unhealthy tripped state (${status.consecutiveFailures} consecutive failures). Auto-recovery probe permitted in ${remainingMs}ms.`,
      };
    }

    // HALF_OPEN: allow trial request
    return { permitted: true };
  }

  public recordSuccess(serverId: string): void {
    const status = this.getOrCreateStatus(serverId);
    const prevState = status.state;
    status.consecutiveFailures = 0;
    status.state = "CLOSED";
    status.lastProbeSuccess = true;
    if (prevState !== "CLOSED") {
      this.emit("stateChanged", { serverId, from: prevState, to: "CLOSED" });
    }
  }

  public recordFailure(serverId: string, error?: string): void {
    const status = this.getOrCreateStatus(serverId);
    status.consecutiveFailures++;
    status.lastFailureTime = Date.now();
    status.lastProbeSuccess = false;

    if (status.state === "HALF_OPEN" || status.consecutiveFailures >= this.failureThreshold) {
      const prevState = status.state;
      status.state = "OPEN";
      if (prevState !== "OPEN") {
        this.emit("stateChanged", { serverId, from: prevState, to: "OPEN", error });
        this.triggerAutoHeal(serverId);
      }
    }
  }

  private triggerAutoHeal(serverId: string): void {
    if (this.isAutoHealing.has(serverId)) return;

    // Protection against infinite restart storm loops
    const now = Date.now();
    const history = (this.restartHistory.get(serverId) ?? []).filter(
      (ts) => now - ts < this.restartTimeWindowMs
    );
    if (history.length >= this.maxRestartsPerWindow) {
      this.emit("restartThrottled", {
        serverId,
        message: `Auto-heal suppressed: exceeded ${this.maxRestartsPerWindow} restarts in ${this.restartTimeWindowMs / 1000}s.`,
      });
      return;
    }

    history.push(now);
    this.restartHistory.set(serverId, history);
    this.isAutoHealing.add(serverId);

    const cfg = this.registry.getDesiredServer(serverId);
    if (!cfg || cfg.serverType === "software_bridge" || cfg.serverType === "virtual_openapi") {
      this.isAutoHealing.delete(serverId);
      return;
    }

    setTimeout(async () => {
      try {
        const status = this.getOrCreateStatus(serverId);
        status.totalRestarts++;
        await this.processPool.stopServerProcess(serverId);
        this.emit("autoHealed", { serverId, attempt: status.totalRestarts });
      } catch {
        // ignore
      } finally {
        this.isAutoHealing.delete(serverId);
      }
    }, 500);
  }

  public async probeServer(serverId: string): Promise<boolean> {
    const status = this.getOrCreateStatus(serverId);
    status.lastCheckTime = Date.now();
    try {
      const resp = await this.processPool.sendRequest(serverId, "ping", {}, 3000);
      this.recordSuccess(serverId);
      return true;
    } catch {
      this.recordFailure(serverId, "Liveness probe timed out or failed");
      return false;
    }
  }

  public startWatchdog(intervalMs = this.probeIntervalMs): void {
    this.stopWatchdog();
    this.probeTimer = setInterval(async () => {
      const states = this.registry.getAllRuntimeStates();
      for (const st of states) {
        if (
          st.phase === "running" &&
          (st.serverType === "stdio_process" || st.serverType === "builder_sandbox")
        ) {
          await this.probeServer(st.serverId).catch(() => {});
        }
      }
    }, intervalMs);
  }

  public stopWatchdog(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  public getHealthStatus(serverId: string): ServerHealthStatus {
    return this.getOrCreateStatus(serverId);
  }

  public getHealthSummary(): ServerHealthStatus[] {
    return Array.from(this.healthMap.values());
  }
}
