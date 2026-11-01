import type { DaemonLockInfo } from "./types.js";
import { WorkbenchRegistry } from "./registry.js";
import { ProcessPool } from "./process_pool.js";
import { McpAggregator } from "./aggregator.js";
import { MetaToolsProvider } from "./meta_tools.js";
import { GatewayCore } from "./gateway_core.js";
import { ClientAutoBinder } from "./client_binder.js";
import { OpenApiConnector } from "./openapi_connector.js";
import { ContextProfileRouter } from "./profile_router.js";
import { PolicyGuard } from "./policy_guard.js";
import { SoftwareBridge } from "./software_bridge.js";
import { BuilderSandbox } from "./builder_sandbox.js";
import { HealthWatchdog } from "./health_watchdog.js";
import { ToolResultCache, TokenBucketRateLimiter } from "./cache_limiter.js";
import { TelemetryMetrics } from "./telemetry_metrics.js";
import { SecretVault } from "./secret_vault.js";
import { CommandResolver } from "./command_resolver.js";
import { WebConsole } from "./web_console.js";
import { ServerImporter } from "./server_importer.js";
/**
 * Single-Instance Core Daemon v0.0.5 (`mcp-workbenchd`).
 * Integrates all 5 core modules + ClientAutoBinder with out-of-band `/admin/approve`
 * and Host Software Reverse IPC Bridge (`/bridge/register`, `/bridge/stream`, `/bridge/callback`).
 */
export declare class WorkbenchDaemon {
    private readonly rootDir;
    private readonly configPath;
    private readonly lockPath;
    private readonly port;
    private readonly host;
    private readonly token;
    private readonly adminSecret;
    readonly registry: WorkbenchRegistry;
    readonly processPool: ProcessPool;
    readonly openApiConnector: OpenApiConnector;
    readonly profileRouter: ContextProfileRouter;
    readonly policyGuard: PolicyGuard;
    readonly softwareBridge: SoftwareBridge;
    readonly builderSandbox: BuilderSandbox;
    readonly aggregator: McpAggregator;
    readonly clientBinder: ClientAutoBinder;
    readonly metaTools: MetaToolsProvider;
    readonly gatewayCore: GatewayCore;
    readonly secretVault: SecretVault;
    readonly healthWatchdog: HealthWatchdog;
    readonly toolCache: ToolResultCache;
    readonly rateLimiter: TokenBucketRateLimiter;
    readonly telemetryMetrics: TelemetryMetrics;
    readonly commandResolver: CommandResolver;
    readonly webConsole: WebConsole;
    readonly serverImporter: ServerImporter;
    readonly connectedClientPids: Set<number>;
    private server;
    private readonly sseClients;
    private readonly notificationLog;
    private lockCheckTimer;
    constructor(rootDir: string, port?: number);
    private verifyDaemonProcess;
    private acquireSingleInstanceLock;
    private safeCompare;
    private isLoopbackAddress;
    private isAuthorizedAdmin;
    private readRequestBodyWithLimit;
    start(): Promise<DaemonLockInfo>;
    stop(): Promise<void>;
}
