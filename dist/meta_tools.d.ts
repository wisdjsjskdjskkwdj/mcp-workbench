import type { JsonSchema } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { ProcessPool } from "./process_pool.js";
import type { McpAggregator } from "./aggregator.js";
import type { ClientAutoBinder } from "./client_binder.js";
import type { OpenApiConnector } from "./openapi_connector.js";
import type { ContextProfileRouter } from "./profile_router.js";
import type { PolicyGuard } from "./policy_guard.js";
import type { SoftwareBridge } from "./software_bridge.js";
import type { BuilderSandbox } from "./builder_sandbox.js";
import type { SecretVault } from "./secret_vault.js";
export interface MetaToolDefinition {
    name: string;
    description: string;
    inputSchema: JsonSchema;
}
/**
 * Built-in Self-Bootstrapping & Governance Meta-Tools (v0.0.5).
 * Exposes 16 `studio__*` tools across all 5 core subsystems.
 * Note: Human approval of destructive tokens is intentionally restricted to out-of-band
 * `/admin/approve` (or requires `admin_secret`) so an Agent cannot self-approve its own destructive calls.
 */
export declare class MetaToolsProvider {
    private readonly registry;
    private readonly processPool;
    private readonly aggregator;
    private readonly clientBinder?;
    private readonly openApiConnector?;
    private readonly profileRouter?;
    private readonly policyGuard?;
    private readonly softwareBridge?;
    private readonly builderSandbox?;
    private readonly secretVault?;
    private readonly versionManager;
    constructor(registry: WorkbenchRegistry, processPool: ProcessPool, aggregator: McpAggregator, clientBinder?: ClientAutoBinder, openApiConnector?: OpenApiConnector, profileRouter?: ContextProfileRouter, policyGuard?: PolicyGuard, softwareBridge?: SoftwareBridge, builderSandbox?: BuilderSandbox, secretVault?: SecretVault);
    getMetaToolDefinitions(): MetaToolDefinition[];
    isMetaTool(name: string): boolean;
    executeMetaTool(rawName: string, args: Record<string, unknown>, callerPpid?: number | null, callerCwd?: string | null, callerClientName?: string | null): Promise<unknown>;
}
