import { EventEmitter } from "node:events";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";
import type { MetaToolsProvider } from "./meta_tools.js";
import type { ContextProfileRouter } from "./profile_router.js";
export interface GatewayCallerContext {
    callerPpid?: number | null;
    callerCwd?: string | null;
    callerClientName?: string | null;
}
/**
 * Transport-Agnostic Gateway Core (v0.0.4).
 * Integrates ContextProfileRouter for per-workspace/per-client tool filtering
 * and forwards caller context to PolicyGuard & Flight Recorder.
 */
export declare class GatewayCore extends EventEmitter {
    private readonly registry;
    private readonly aggregator;
    private readonly metaTools;
    private readonly profileRouter?;
    constructor(registry: WorkbenchRegistry, aggregator: McpAggregator, metaTools: MetaToolsProvider, profileRouter?: ContextProfileRouter);
    handleJsonRpcRequest(req: JsonRpcRequest, context?: GatewayCallerContext): Promise<JsonRpcResponse | null>;
}
