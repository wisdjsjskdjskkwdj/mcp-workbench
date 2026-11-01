import type { DesiredServerConfig, ToolRecord } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { ProcessPool } from "./process_pool.js";
import type { OpenApiConnector } from "./openapi_connector.js";
import type { ContextProfileRouter } from "./profile_router.js";
import type { PolicyGuard } from "./policy_guard.js";
import type { SoftwareBridge } from "./software_bridge.js";
import type { HealthWatchdog } from "./health_watchdog.js";
import type { ToolResultCache, TokenBucketRateLimiter } from "./cache_limiter.js";
import type { TelemetryMetrics } from "./telemetry_metrics.js";
/**
 * Unified Multi-Driver Tool Aggregator (v0.0.5).
 * Orchestrates 4 Server Driver Types without conflict:
 * 1. `stdio_process`: Standard MCP child processes managed by `ProcessPool`
 * 2. `virtual_openapi`: Zero-code in-memory REST connectors managed by `OpenApiConnector` (persisted across restarts)
 * 3. `software_bridge`: Reverse IPC connections from host apps (Blender/Revit) managed by `SoftwareBridge`
 * 4. `builder_sandbox`: Agent-synthesized & self-tested MCP servers managed by `BuilderSandbox` + `ProcessPool`
 */
export declare class McpAggregator {
    private readonly registry;
    private readonly processPool;
    openApiConnector?: OpenApiConnector;
    profileRouter?: ContextProfileRouter;
    policyGuard?: PolicyGuard;
    softwareBridge?: SoftwareBridge;
    healthWatchdog?: HealthWatchdog;
    toolCache?: ToolResultCache;
    rateLimiter?: TokenBucketRateLimiter;
    telemetryMetrics?: TelemetryMetrics;
    private readonly connectingLocks;
    private reconcilePromise;
    baseRestartDelayMs: number;
    maxAutoRestarts: number;
    private readonly restartTimers;
    constructor(registry: WorkbenchRegistry, processPool: ProcessPool, openApiConnector?: OpenApiConnector, profileRouter?: ContextProfileRouter, policyGuard?: PolicyGuard, softwareBridge?: SoftwareBridge);
    clearAllRestartTimers(): void;
    connectAndDiscoverServer(config: DesiredServerConfig): Promise<ToolRecord[]>;
    private doConnectAndDiscover;
    refreshServerTools(serverId: string): Promise<ToolRecord[]>;
    refreshServerResourcesAndPrompts(serverId: string, capabilities?: Record<string, unknown>): Promise<void>;
    readDownstreamResource(exposedUri: string, callerCwd?: string | null, callerClientName?: string | null): Promise<unknown>;
    getDownstreamPrompt(exposedName: string, promptArgs?: Record<string, unknown>, callerCwd?: string | null, callerClientName?: string | null): Promise<unknown>;
    reconcileAll(): Promise<void>;
    private doReconcileAll;
    validateToolArguments(tool: ToolRecord, args: Record<string, unknown>): void;
    invokeDownstreamTool(tool: ToolRecord, args: Record<string, unknown>, callerPpid?: number | null, callerCwd?: string | null, callerClientName?: string | null): Promise<unknown>;
}
