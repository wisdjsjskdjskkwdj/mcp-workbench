import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import type {
  DesiredServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { SecretVault } from "./secret_vault.js";
import type { CommandResolver } from "./command_resolver.js";

interface ManagedProcessEntry {
  config: DesiredServerConfig;
  child: ChildProcessWithoutNullStreams;
  pendingRequests: Map<
    string | number,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  nextReqId: number;
  stoppingIntentionally: boolean;
}

/**
 * Lightweight Runtime Engine Process Pool.
 * Manages stdio MCP Server child processes, captures stderr diagnostics, handles JSON-RPC framing,
 * and updates Actual Runtime State in WorkbenchRegistry.
 */
export class ProcessPool extends EventEmitter {
  private readonly registry: WorkbenchRegistry;
  private readonly baseCwd: string;
  private readonly commandResolver?: CommandResolver;
  public secretVault?: SecretVault;
  private readonly processes = new Map<string, ManagedProcessEntry>();

  constructor(
    registry: WorkbenchRegistry,
    baseCwd: string,
    commandResolver?: CommandResolver,
    secretVault?: SecretVault
  ) {
    super();
    this.registry = registry;
    this.baseCwd = baseCwd;
    this.commandResolver = commandResolver;
    this.secretVault = secretVault;
  }

  public async startServerProcess(config: DesiredServerConfig): Promise<void> {
    if (this.processes.has(config.id)) {
      await this.stopServerProcess(config.id);
    }

    this.registry.updateRuntimeState(config.id, {
      phase: "starting",
      lastError: null,
    });

    // 1. Resolve `$secret:KEY` placeholders in memory without modifying `workbench.json` on disk
    const resolvedArgs = this.secretVault
      ? this.secretVault.resolveStringArray(config.args)
      : [...config.args];
    const resolvedEnvOverrides = this.secretVault
      ? this.secretVault.resolveEnvRecord(config.env ?? {})
      : { ...(config.env ?? {}) };

    // 2. Resolve cross-platform executable path & augmented PATH environment
    const spawnTarget = this.commandResolver
      ? this.commandResolver.resolveSpawnTarget(
          config.command,
          resolvedArgs,
          resolvedEnvOverrides
        )
      : {
          command: config.command,
          args: resolvedArgs,
          env: { ...process.env, ...resolvedEnvOverrides } as Record<string, string>,
          shell: false,
        };

    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd: config.cwd ?? this.baseCwd,
      env: spawnTarget.env,
      shell: spawnTarget.shell,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.on("error", (err) => {
      this.registry.updateRuntimeState(config.id, {
        phase: "failed",
        lastError: `Process spawn/lifecycle error: ${err.message}`,
      });
    });

    child.stdin.on("error", () => {
      // Suppress unhandled EPIPE if child process terminates unexpectedly while writing
    });

    const entry: ManagedProcessEntry = {
      config,
      child,
      pendingRequests: new Map(),
      nextReqId: 1,
      stoppingIntentionally: false,
    };
    this.processes.set(config.id, entry);

    this.registry.updateRuntimeState(config.id, {
      phase: "handshaking",
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
    });

    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && msg.id !== null && entry.pendingRequests.has(msg.id)) {
          const pending = entry.pendingRequests.get(msg.id)!;
          clearTimeout(pending.timer);
          entry.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        } else if ((msg as any).method === "notifications/tools/list_changed") {
          this.emit("downstreamToolsChanged", config.id);
        }
      } catch {
        // Ignore non-JSON stdout lines
      }
    });

    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      const safeLine = this.secretVault
        ? this.secretVault.redactSecrets(line)
        : line;
      const state = this.registry.getRuntimeState(config.id);
      const recent = [...(state?.recentStderr ?? []), safeLine].slice(-25);
      this.registry.updateRuntimeState(config.id, { recentStderr: recent });
    });

    child.on("exit", (code) => {
      for (const [, pending] of entry.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Server ${config.id} exited with code ${code}`));
      }
      entry.pendingRequests.clear();
      this.processes.delete(config.id);
      this.registry.clearServerTools(config.id);

      if (entry.stoppingIntentionally) {
        this.registry.updateRuntimeState(config.id, {
          phase: "stopped",
          pid: null,
          lastExitCode: code,
        });
      } else {
        const prev = this.registry.getRuntimeState(config.id);
        const newRestartCount = (prev?.restartCount ?? 0) + 1;
        this.registry.updateRuntimeState(config.id, {
          phase: "failed",
          pid: null,
          lastExitCode: code,
          lastError: `Unexpected process exit (code=${code})`,
          restartCount: newRestartCount,
        });
        this.emit("unexpectedExit", {
          serverId: config.id,
          exitCode: code,
          restartCount: newRestartCount,
        });
      }
    });
  }

  public async sendRequest(
    serverId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = Number(process.env.MCP_TOOL_TIMEOUT_MS) || 60000
  ): Promise<unknown> {
    const entry = this.processes.get(serverId);
    if (!entry) {
      throw new Error(`Downstream MCP Server '${serverId}' is not running.`);
    }
    if (!entry.child.stdin || !entry.child.stdin.writable || entry.child.killed) {
      throw new Error(
        `Downstream MCP Server '${serverId}' stdin is not writable or process is terminated.`
      );
    }
    const id = entry.nextReqId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingRequests.delete(id);
        reject(
          new Error(`Request '${method}' to server '${serverId}' timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      entry.pendingRequests.set(id, { resolve, reject, timer });
      try {
        entry.child.stdin.write(JSON.stringify(payload) + "\n");
      } catch (writeErr: any) {
        clearTimeout(timer);
        entry.pendingRequests.delete(id);
        reject(
          new Error(`Failed to write to server '${serverId}': ${writeErr?.message ?? String(writeErr)}`)
        );
      }
    });
  }

  public sendNotification(
    serverId: string,
    method: string,
    params: Record<string, unknown> = {}
  ): void {
    const entry = this.processes.get(serverId);
    if (!entry || !entry.child.stdin || !entry.child.stdin.writable || entry.child.killed) return;
    try {
      entry.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
      );
    } catch {}
  }

  public async stopServerProcess(serverId: string): Promise<void> {
    const entry = this.processes.get(serverId);
    if (!entry) return;
    entry.stoppingIntentionally = true;
    return new Promise((resolve) => {
      if (entry.child.killed || entry.child.exitCode !== null) {
        this.processes.delete(serverId);
        resolve();
        return;
      }
      const exitTimer = setTimeout(() => {
        this.processes.delete(serverId);
        resolve();
      }, 2000);
      entry.child.once("exit", () => {
        clearTimeout(exitTimer);
        this.processes.delete(serverId);
        resolve();
      });
      if (process.platform === "win32" && entry.child.pid) {
        try {
          execSync(`taskkill /F /T /PID ${entry.child.pid}`, { stdio: "ignore" });
        } catch {
          entry.child.kill("SIGKILL");
        }
      } else {
        entry.child.kill("SIGTERM");
        setTimeout(() => {
          if (!entry.child.killed) entry.child.kill("SIGKILL");
          resolve();
        }, 1000);
      }
    });
  }

  public async stopAll(): Promise<void> {
    const ids = Array.from(this.processes.keys());
    await Promise.all(ids.map((id) => this.stopServerProcess(id)));
  }
}
