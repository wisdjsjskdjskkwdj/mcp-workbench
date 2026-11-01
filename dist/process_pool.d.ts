import { EventEmitter } from "node:events";
import type { DesiredServerConfig } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { SecretVault } from "./secret_vault.js";
import type { CommandResolver } from "./command_resolver.js";
/**
 * Lightweight Runtime Engine Process Pool.
 * Manages stdio MCP Server child processes, captures stderr diagnostics, handles JSON-RPC framing,
 * and updates Actual Runtime State in WorkbenchRegistry.
 */
export declare class ProcessPool extends EventEmitter {
    private readonly registry;
    private readonly baseCwd;
    private readonly commandResolver?;
    secretVault?: SecretVault;
    private readonly processes;
    constructor(registry: WorkbenchRegistry, baseCwd: string, commandResolver?: CommandResolver, secretVault?: SecretVault);
    startServerProcess(config: DesiredServerConfig): Promise<void>;
    sendRequest(serverId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    sendNotification(serverId: string, method: string, params?: Record<string, unknown>): void;
    stopServerProcess(serverId: string): Promise<void>;
    stopAll(): Promise<void>;
}
