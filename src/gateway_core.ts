import { EventEmitter } from "node:events";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./types.js";
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
export class GatewayCore extends EventEmitter {
  private readonly registry: WorkbenchRegistry;
  private readonly aggregator: McpAggregator;
  private readonly metaTools: MetaToolsProvider;
  private readonly profileRouter?: ContextProfileRouter;

  constructor(
    registry: WorkbenchRegistry,
    aggregator: McpAggregator,
    metaTools: MetaToolsProvider,
    profileRouter?: ContextProfileRouter
  ) {
    super();
    this.registry = registry;
    this.aggregator = aggregator;
    this.metaTools = metaTools;
    this.profileRouter = profileRouter;

    this.registry.on("toolsChanged", () => {
      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: {},
      };
      this.emit("broadcastNotification", notification);
    });
  }

  public async handleJsonRpcRequest(
    req: JsonRpcRequest,
    context: GatewayCallerContext = {}
  ): Promise<JsonRpcResponse | null> {
    if (req.id === undefined || req.id === null) {
      return null;
    }

    try {
      switch (req.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {
                tools: { listChanged: true },
                resources: { listChanged: true },
                prompts: { listChanged: true },
              },
              serverInfo: {
                name: "mcp-workbench-gateway",
                version: "0.1.0",
              },
            },
          };
        }

        case "resources/templates/list": {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: { resourceTemplates: [] },
          };
        }

        case "logging/setLevel": {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {},
          };
        }

        case "ping": {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {},
          };
        }

        case "resources/list": {
          const allRes = this.registry.getAllResources();
          const filtered = this.profileRouter
            ? allRes.filter(
                (r) =>
                  this.profileRouter!.isServerAllowedForContext(
                    r.serverId,
                    context.callerCwd ?? undefined,
                    context.callerClientName ?? undefined
                  ).allowed
              )
            : allRes;
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              resources: filtered.map((r) => ({
                uri: r.exposedUri,
                name: r.name,
                description: r.description,
                mimeType: r.mimeType,
              })),
            },
          };
        }

        case "resources/read": {
          const uri = String((req.params as any)?.uri ?? "");
          const readResult = await this.aggregator.readDownstreamResource(
            uri,
            context.callerCwd ?? null,
            context.callerClientName ?? null
          );
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: readResult,
          };
        }

        case "prompts/list": {
          const allPrompts = this.registry.getAllPrompts();
          const filtered = this.profileRouter
            ? allPrompts.filter(
                (p) =>
                  this.profileRouter!.isServerAllowedForContext(
                    p.serverId,
                    context.callerCwd ?? undefined,
                    context.callerClientName ?? undefined
                  ).allowed
              )
            : allPrompts;
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              prompts: filtered.map((p) => ({
                name: p.exposedName,
                description: p.description,
                arguments: p.arguments,
              })),
            },
          };
        }

        case "prompts/get": {
          const name = String((req.params as any)?.name ?? "");
          const promptArgs = ((req.params as any)?.arguments ?? {}) as Record<
            string,
            unknown
          >;
          const promptResult = await this.aggregator.getDownstreamPrompt(
            name,
            promptArgs,
            context.callerCwd ?? null,
            context.callerClientName ?? null
          );
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: promptResult,
          };
        }

        case "tools/list": {
          const metaDefs = this.metaTools.getMetaToolDefinitions();
          const filteredRecords = this.profileRouter
            ? this.profileRouter.filterToolsForContext(
                context.callerCwd ?? undefined,
                context.callerClientName ?? undefined
              ).tools
            : this.registry.getTopLevelExposedTools();

          const dynamicTopLevel = filteredRecords.map((t: any) => ({
            name: t.exposedName,
            description: `[Server: ${t.serverId} | ID: ${t.toolId}] ${t.description}`,
            inputSchema: t.inputSchema,
          }));

          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              tools: [...metaDefs, ...dynamicTopLevel],
            },
          };
        }

        case "tools/call": {
          const params = (req.params ?? {}) as {
            name?: string;
            arguments?: Record<string, unknown>;
          };
          const toolName = String(params.name ?? "");
          const toolArgs = params.arguments ?? {};

          if (this.metaTools.isMetaTool(toolName)) {
            const result = await this.metaTools.executeMetaTool(
              toolName,
              toolArgs,
              context.callerPpid ?? null,
              context.callerCwd ?? null,
              context.callerClientName ?? null
            );
            return {
              jsonrpc: "2.0",
              id: req.id,
              result,
            };
          }

          let record = this.registry.resolveToolByExposedName(toolName);
          if (!record) {
            // Defensive cold-start grace period: wait up to 3.5s if any enabled downstream server is still starting/handshaking
            for (let i = 0; i < 35; i++) {
              const anyStarting = this.registry
                .getDesiredServers()
                .filter((ds) => ds.enabled)
                .some((ds) => {
                  const state = this.registry.getRuntimeState(ds.id);
                  return !state || state.phase === "handshaking" || state.phase === "stopped";
                });
              if (!anyStarting) break;
              await new Promise((r) => setTimeout(r, 100));
              record = this.registry.resolveToolByExposedName(toolName);
              if (record) break;
            }
          }
          if (!record) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: {
                code: -32602,
                message: `Tool '${toolName}' is not in top-level registry. Use 'studio__tool__search' and 'studio__tool__invoke' if it is a cold or newly added tool.`,
              },
            };
          }

          const callResult = await this.aggregator.invokeDownstreamTool(
            record,
            toolArgs,
            context.callerPpid ?? null,
            context.callerCwd ?? null,
            context.callerClientName ?? null
          );
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: callResult,
          };
        }

        default:
          return {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: -32000,
          message: msg,
        },
      };
    }
  }
}
