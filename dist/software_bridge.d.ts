import http from "node:http";
import type { WorkbenchRegistry } from "./registry.js";
import type { JsonSchema, ToolRecord } from "./types.js";
export interface BridgePluginRegistration {
    bridgeId: string;
    softwareName: string;
    softwareVersion: string;
    pid: number;
    tools: Array<{
        name: string;
        description?: string;
        inputSchema?: JsonSchema;
    }>;
}
/**
 * Module 4 (v0.0.5): Host Software IPC Reverse Bridge (`SoftwareBridge`).
 * Designed for heavy desktop applications (Blender, Revit, AutoCAD, Unity, Office) whose SDKs
 * must run inside the host application's main UI/document thread:
 * 1. Host plugin connects inbound to Daemon (`/bridge/register` + `/bridge/stream?bridge_id=...`).
 * 2. Tools immediately appear in `WorkbenchRegistry` with `serverType: "software_bridge"`.
 * 3. When an Agent invokes a bridge tool, `SoftwareBridge` pushes a JSON-RPC command frame down
 *    the plugin's SSE stream and resolves when the plugin posts the main-thread result to `/bridge/callback`.
 * 4. If the host software closes (SSE stream disconnects), its tools are automatically unmarked/cleared.
 */
export declare class SoftwareBridge {
    private readonly registry;
    private readonly sessions;
    constructor(registry: WorkbenchRegistry);
    registerPlugin(reg: BridgePluginRegistration): ToolRecord[];
    attachCommandStream(bridgeId: string, req: http.IncomingMessage, res: http.ServerResponse): void;
    handlePluginDisconnect(bridgeId: string): void;
    private readonly bridgeQueues;
    isBridgeServer(serverId: string): boolean;
    invokeBridgeTool(bridgeId: string, toolName: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
    private doInvokeBridgeTool;
    submitBridgeCallback(bridgeId: string, callId: string, result?: unknown, errorMsg?: string): boolean;
    listActiveBridges(): Array<Record<string, any>>;
}
