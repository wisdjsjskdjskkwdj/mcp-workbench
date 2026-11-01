import { EventEmitter } from "node:events";
import type { ProcessPool } from "./process_pool.js";
import type { WorkbenchRegistry } from "./registry.js";
import { type ServerHealthStatus } from "./types.js";
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
export declare class HealthWatchdog extends EventEmitter {
    private readonly registry;
    private readonly processPool;
    private readonly failureThreshold;
    private readonly resetTimeoutMs;
    private readonly probeIntervalMs;
    private readonly maxRestartsPerWindow;
    private readonly restartTimeWindowMs;
    private readonly healthMap;
    private readonly restartHistory;
    private probeTimer;
    private isAutoHealing;
    constructor(registry: WorkbenchRegistry, processPool: ProcessPool, options?: WatchdogOptions);
    private getOrCreateStatus;
    isCallPermitted(serverId: string): {
        permitted: boolean;
        reason?: string;
    };
    recordSuccess(serverId: string): void;
    recordFailure(serverId: string, error?: string): void;
    private triggerAutoHeal;
    probeServer(serverId: string): Promise<boolean>;
    startWatchdog(intervalMs?: number): void;
    stopWatchdog(): void;
    getHealthStatus(serverId: string): ServerHealthStatus;
    getHealthSummary(): ServerHealthStatus[];
}
