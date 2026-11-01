import type {
  DesiredServerConfig,
  JsonSchema,
  ToolRecord,
} from "./types.js";
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
export class McpAggregator {
  private readonly registry: WorkbenchRegistry;
  private readonly processPool: ProcessPool;
  public openApiConnector?: OpenApiConnector;
  public profileRouter?: ContextProfileRouter;
  public policyGuard?: PolicyGuard;
  public softwareBridge?: SoftwareBridge;
  public healthWatchdog?: HealthWatchdog;
  public toolCache?: ToolResultCache;
  public rateLimiter?: TokenBucketRateLimiter;
  public telemetryMetrics?: TelemetryMetrics;
  private readonly connectingLocks = new Map<string, Promise<ToolRecord[]>>();
  private reconcilePromise: Promise<void> | null = null;
  public baseRestartDelayMs = 150;
  public maxAutoRestarts = 5;
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    registry: WorkbenchRegistry,
    processPool: ProcessPool,
    openApiConnector?: OpenApiConnector,
    profileRouter?: ContextProfileRouter,
    policyGuard?: PolicyGuard,
    softwareBridge?: SoftwareBridge
  ) {
    this.registry = registry;
    this.processPool = processPool;
    this.openApiConnector = openApiConnector;
    this.profileRouter = profileRouter;
    this.policyGuard = policyGuard;
    this.softwareBridge = softwareBridge;

    this.processPool.on("downstreamToolsChanged", (serverId: string) => {
      void this.refreshServerTools(serverId);
    });

    this.processPool.on(
      "unexpectedExit",
      (evt: Record<string, any>) => {
        const cfg = this.registry.getDesiredServer(evt.serverId);
        if (
          cfg &&
          cfg.enabled &&
          cfg.autoRestart !== false &&
          evt.restartCount <= this.maxAutoRestarts
        ) {
          const delay = Math.min(
            this.baseRestartDelayMs * Math.pow(2, evt.restartCount - 1),
            5000
          );
          const existingTimer = this.restartTimers.get(evt.serverId);
          if (existingTimer) clearTimeout(existingTimer);
          const timer = setTimeout(() => {
            this.restartTimers.delete(evt.serverId);
            const latestCfg = this.registry.getDesiredServer(evt.serverId);
            if (latestCfg && latestCfg.enabled) {
              void this.connectAndDiscoverServer(latestCfg).catch(() => {
                // Runtime state already updated to failed on error
              });
            }
          }, delay);
          this.restartTimers.set(evt.serverId, timer);
        }
      }
    );
  }

  public clearAllRestartTimers(): void {
    for (const timer of this.restartTimers.values()) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();
  }

  public async connectAndDiscoverServer(
    config: DesiredServerConfig
  ): Promise<ToolRecord[]> {
    const driver = config.serverType ?? "stdio_process";
    if (driver === "virtual_openapi" || config.command === "__virtual_openapi__") {
      if (this.openApiConnector) {
        return this.openApiConnector.restorePersistedConnector(config.id);
      }
      return [];
    }
    if (driver === "software_bridge" || config.command === "__software_bridge__") {
      return this.registry.getAllTools().filter((t) => t.serverId === config.id);
    }

    const inFlight = this.connectingLocks.get(config.id);
    if (inFlight) {
      return await inFlight;
    }
    const task = this.doConnectAndDiscover(config).finally(() => {
      this.connectingLocks.delete(config.id);
    });
    this.connectingLocks.set(config.id, task);
    return await task;
  }

  private async doConnectAndDiscover(
    config: DesiredServerConfig
  ): Promise<ToolRecord[]> {
    await this.processPool.startServerProcess(config);
    try {
      const initResult = (await this.processPool.sendRequest(
        config.id,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "mcp-workbench-gateway",
            version: "0.0.5",
          },
        }
      )) as { protocolVersion?: string };

      this.processPool.sendNotification(
        config.id,
        "notifications/initialized",
        {}
      );

      this.registry.updateRuntimeState(config.id, {
        serverType: config.serverType ?? "stdio_process",
        phase: "running",
        protocolVersion: initResult?.protocolVersion ?? "2025-06-18",
      });

      const tools = await this.refreshServerTools(config.id);
      await this.refreshServerResourcesAndPrompts(config.id, (initResult as any)?.capabilities);
      return tools;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.registry.updateRuntimeState(config.id, {
        phase: "failed",
        lastError: msg,
      });
      await this.processPool.stopServerProcess(config.id);
      throw err;
    }
  }

  public async refreshServerTools(serverId: string): Promise<ToolRecord[]> {
    const listResp = (await this.processPool.sendRequest(
      serverId,
      "tools/list",
      {}
    )) as {
      tools?: Array<{
        name: string;
        description?: string;
        inputSchema?: JsonSchema;
      }>;
    };

    const tools = listResp?.tools ?? [];
    return this.registry.registerServerTools(serverId, tools);
  }

  public async refreshServerResourcesAndPrompts(
    serverId: string,
    capabilities?: Record<string, unknown>
  ): Promise<void> {
    if (capabilities && capabilities.resources) {
      try {
        const resList = (await this.processPool.sendRequest(
          serverId,
          "resources/list",
          {},
          2000
        )) as { resources?: Array<any> };
        if (Array.isArray(resList?.resources)) {
          this.registry.registerServerResources(serverId, resList.resources);
        }
      } catch {
        // Downstream server does not implement resources/list
      }
    }

    if (capabilities && capabilities.prompts) {
      try {
        const promptList = (await this.processPool.sendRequest(
          serverId,
          "prompts/list",
          {},
          2000
        )) as { prompts?: Array<any> };
        if (Array.isArray(promptList?.prompts)) {
          this.registry.registerServerPrompts(serverId, promptList.prompts);
        }
      } catch {
        // Downstream server does not implement prompts/list
      }
    }
  }

  public async readDownstreamResource(
    exposedUri: string,
    callerCwd: string | null = null,
    callerClientName: string | null = null
  ): Promise<unknown> {
    const rec = this.registry.resolveResourceByExposedUri(exposedUri);
    if (!rec) {
      throw new Error(`Resource '${exposedUri}' not found in Gateway registry.`);
    }
    if (this.profileRouter) {
      const check = this.profileRouter.isServerAllowedForContext(
        rec.serverId,
        callerCwd ?? undefined,
        callerClientName ?? undefined
      );
      if (!check.allowed) {
        throw new Error(
          `PROFILE_FORBIDDEN[${check.profileId}]: Resource from server '${rec.serverId}' is not permitted in active profile.`
        );
      }
    }
    return await this.processPool.sendRequest(rec.serverId, "resources/read", {
      uri: rec.originalUri,
    });
  }

  public async getDownstreamPrompt(
    exposedName: string,
    promptArgs: Record<string, unknown> = {},
    callerCwd: string | null = null,
    callerClientName: string | null = null
  ): Promise<unknown> {
    const rec = this.registry.resolvePromptByExposedName(exposedName);
    if (!rec) {
      throw new Error(`Prompt '${exposedName}' not found in Gateway registry.`);
    }
    if (this.profileRouter) {
      const check = this.profileRouter.isServerAllowedForContext(
        rec.serverId,
        callerCwd ?? undefined,
        callerClientName ?? undefined
      );
      if (!check.allowed) {
        throw new Error(
          `PROFILE_FORBIDDEN[${check.profileId}]: Prompt from server '${rec.serverId}' is not permitted in active profile.`
        );
      }
    }
    return await this.processPool.sendRequest(rec.serverId, "prompts/get", {
      name: rec.originalName,
      arguments: promptArgs,
    });
  }

  public async reconcileAll(): Promise<void> {
    if (this.reconcilePromise) {
      return await this.reconcilePromise;
    }
    this.reconcilePromise = this.doReconcileAll().finally(() => {
      this.reconcilePromise = null;
    });
    return await this.reconcilePromise;
  }

  private async doReconcileAll(): Promise<void> {
    const desired = this.registry.getDesiredServers();
    const desiredIds = new Set(desired.map((d) => d.id));

    // 1. Concurrently stop any removed servers
    const stopTasks: Promise<void>[] = [];
    for (const state of this.registry.getAllRuntimeStates()) {
      if (!desiredIds.has(state.serverId) && state.phase === "running") {
        if (state.serverType === "stdio_process" || state.serverType === "builder_sandbox") {
          stopTasks.push(this.processPool.stopServerProcess(state.serverId));
        }
      }
    }
    await Promise.allSettled(stopTasks);

    // 2. Concurrently reconcile and start all servers with Fault-Domain Isolation
    const reconcileTasks = desired.map(async (serverConfig) => {
      const driver = serverConfig.serverType ?? "stdio_process";
      const currentState = this.registry.getRuntimeState(serverConfig.id);

      // Software bridge plugins connect inbound; Daemon never spawns them
      if (driver === "software_bridge" || serverConfig.command === "__software_bridge__") {
        return;
      }

      // Virtual OpenAPI servers restore their persisted specs from `.workbench_openapi/` on Daemon startup!
      if (driver === "virtual_openapi" || serverConfig.command === "__virtual_openapi__") {
        if (serverConfig.enabled && currentState?.phase !== "running" && this.openApiConnector) {
          try {
            this.openApiConnector.restorePersistedConnector(serverConfig.id);
          } catch (err) {
            this.registry.updateRuntimeState(serverConfig.id, {
              phase: "failed",
              lastError: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return;
      }

      if (serverConfig.enabled && currentState?.phase !== "running") {
        try {
          await this.connectAndDiscoverServer(serverConfig);
        } catch (err) {
          // Fault Isolation: a single broken MCP server must NEVER crash startup or block healthy servers
          this.registry.updateRuntimeState(serverConfig.id, {
            phase: "failed",
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (!serverConfig.enabled && currentState?.phase === "running") {
        try {
          await this.processPool.stopServerProcess(serverConfig.id);
        } catch {}
      }
    });

    await Promise.allSettled(reconcileTasks);
  }

  public validateToolArguments(
    tool: ToolRecord,
    args: Record<string, unknown>
  ): void {
    const schema = tool.inputSchema;
    if (!schema || schema.type !== "object") return;
    const safeArgs = args && typeof args === "object" ? args : {};

    const required = schema.required ?? [];
    for (const reqKey of required) {
      if (!(reqKey in safeArgs) || safeArgs[reqKey] === undefined) {
        throw new Error(
          `Schema validation failed for '${tool.exposedName}' (${tool.toolId}): missing required parameter '${reqKey}'.`
        );
      }
    }

    const props = (schema.properties ?? {}) as Record<
      string,
      { type?: string }
    >;
    for (const [key, value] of Object.entries(safeArgs)) {
      if (key === "__approval_token") continue;
      const propSchema = props[key];
      if (!propSchema || !propSchema.type) continue;
      const actualType = Array.isArray(value) ? "array" : typeof value;
      if (propSchema.type === "number" && typeof value !== "number") {
        throw new Error(
          `Schema validation failed for '${tool.exposedName}': parameter '${key}' must be of type number, got ${actualType}.`
        );
      }
      if (propSchema.type === "string" && typeof value !== "string") {
        throw new Error(
          `Schema validation failed for '${tool.exposedName}': parameter '${key}' must be of type string, got ${actualType}.`
        );
      }
      if (propSchema.type === "boolean" && typeof value !== "boolean") {
        throw new Error(
          `Schema validation failed for '${tool.exposedName}': parameter '${key}' must be of type boolean, got ${actualType}.`
        );
      }
    }
  }

  public async invokeDownstreamTool(
    tool: ToolRecord,
    args: Record<string, unknown>,
    callerPpid: number | null = null,
    callerCwd: string | null = null,
    callerClientName: string | null = null
  ): Promise<unknown> {
    if (!tool.enabled) {
      throw new Error(`Tool '${tool.exposedName}' (${tool.toolId}) is disabled.`);
    }

    // Step 1: Enforce ContextProfileRouter Isolation (both direct call and studio__tool__invoke)
    if (this.profileRouter) {
      const check = this.profileRouter.isServerAllowedForContext(
        tool.serverId,
        callerCwd ?? undefined,
        callerClientName ?? undefined
      );
      if (!check.allowed) {
        if (this.policyGuard) {
          this.policyGuard.recordAudit({
            callerPpid,
            callerCwd,
            serverId: tool.serverId,
            toolName: tool.exposedName,
            riskLevel: "safe",
            decision: "blocked_profile",
            reason: `Server '${tool.serverId}' is not allowed in active Profile '${check.profileId}'`,
            durationMs: 0,
            argsPreview: JSON.stringify(args).slice(0, 200),
          });
        }
        throw new Error(
          `PROFILE_FORBIDDEN[${check.profileId}]: Server '${tool.serverId}' is not permitted in active context profile '${check.profileId}'.`
        );
      }
    }

    // Step 1b: Avalanche Rate Limiter Check (Module 7)
    if (this.rateLimiter) {
      const bucketKey = `${callerPpid ?? "global"}::${tool.serverId}`;
      const rateCheck = this.rateLimiter.consume(bucketKey);
      if (!rateCheck.allowed) {
        throw new Error(
          `RATE_LIMIT_EXCEEDED: Rate limit exceeded for server '${tool.serverId}'. Try again in ${rateCheck.retryAfterMs}ms.`
        );
      }
    }

    // Step 1c: Circuit Breaker Fail-Fast Check (Module 6)
    if (this.healthWatchdog) {
      const healthCheck = this.healthWatchdog.isCallPermitted(tool.serverId);
      if (!healthCheck.permitted) {
        throw new Error(
          healthCheck.reason ?? `CIRCUIT_BREAKER_OPEN: Server '${tool.serverId}' is unhealthy.`
        );
      }
    }

    const serverState = this.registry.getRuntimeState(tool.serverId);
    if (!serverState || serverState.phase !== "running") {
      throw new Error(
        `Server '${tool.serverId}' is not running (current phase: ${serverState?.phase ?? "unknown"}).`
      );
    }

    // Step 2: Validate JSON Schema BEFORE checking/consuming one-time approval tokens!
    this.validateToolArguments(tool, args);

    // Step 3: PolicyGuard Firewall & Two-Pass Approval Check
    let riskLevel = "safe";
    let decision = "allowed";
    if (this.policyGuard) {
      const check = await this.policyGuard.verifyCallPermission(
        tool.serverId,
        tool.originalName,
        tool.exposedName,
        args,
        callerPpid,
        callerCwd
      );
      riskLevel = check.riskLevel;
      decision = check.decision;
    }

    // Step 3b: Idempotent Result Cache Check (Module 7)
    if (this.toolCache && decision !== "approved_token" && decision !== "approved_live_hold") {
      const cached = this.toolCache.get(tool.serverId, tool.originalName, args);
      if (cached !== undefined) {
        if (this.telemetryMetrics) {
          this.telemetryMetrics.recordCall(tool.serverId, tool.originalName, 0, true, {
            cacheHit: true,
            inputChars: JSON.stringify(args).length,
            outputChars: JSON.stringify(cached).length,
          });
        }
        return cached;
      }
    }

    const startMs = Date.now();
    let result: unknown;

    try {
      // Step 4: Dispatch by Server Driver Type
      if (
        this.openApiConnector &&
        this.openApiConnector.isVirtualConnector(tool.serverId)
      ) {
        result = await this.openApiConnector.invokeVirtualEndpoint(
          tool.serverId,
          tool.originalName,
          args
        );
      } else if (
        this.softwareBridge &&
        this.softwareBridge.isBridgeServer(tool.serverId)
      ) {
        result = await this.softwareBridge.invokeBridgeTool(
          tool.serverId,
          tool.originalName,
          args
        );
      } else {
        result = await this.processPool.sendRequest(tool.serverId, "tools/call", {
          name: tool.originalName,
          arguments: args,
        });
      }

      const durationMs = Date.now() - startMs;

      // Telemetry & Watchdog Success Notifications
      if (this.healthWatchdog) {
        this.healthWatchdog.recordSuccess(tool.serverId);
      }
      if (this.telemetryMetrics) {
        this.telemetryMetrics.recordCall(tool.serverId, tool.originalName, durationMs, true, {
          cacheHit: false,
          inputChars: JSON.stringify(args).length,
          outputChars: JSON.stringify(result).length,
        });
      }
      if (this.toolCache && riskLevel === "safe" && decision !== "approved_token") {
        this.toolCache.set(tool.serverId, tool.originalName, args, result);
      }

      // Step 5: Record execution in Flight Recorder
      if (this.policyGuard) {
        this.policyGuard.recordAudit({
          callerPpid,
          callerCwd,
          serverId: tool.serverId,
          toolName: tool.exposedName,
          riskLevel,
          decision,
          reason: "Executed successfully",
          durationMs,
          argsPreview: JSON.stringify(args).slice(0, 200),
        });
      }

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startMs;

      if (this.healthWatchdog) {
        this.healthWatchdog.recordFailure(tool.serverId, err?.message);
      }
      if (this.telemetryMetrics) {
        this.telemetryMetrics.recordCall(tool.serverId, tool.originalName, durationMs, false, {
          inputChars: JSON.stringify(args).length,
        });
      }

      if (this.policyGuard) {
        this.policyGuard.recordAudit({
          callerPpid,
          callerCwd,
          serverId: tool.serverId,
          toolName: tool.exposedName,
          riskLevel,
          decision: "execution_error",
          reason: `Execution failed: ${err?.message ?? String(err)}`,
          durationMs,
          argsPreview: JSON.stringify(args).slice(0, 200),
        });
      }
      throw err;
    }
  }
}
