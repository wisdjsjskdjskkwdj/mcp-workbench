import { VersionManager } from "./version_manager.js";
/**
 * Built-in Self-Bootstrapping & Governance Meta-Tools (v0.0.5).
 * Exposes 16 `studio__*` tools across all 5 core subsystems.
 * Note: Human approval of destructive tokens is intentionally restricted to out-of-band
 * `/admin/approve` (or requires `admin_secret`) so an Agent cannot self-approve its own destructive calls.
 */
export class MetaToolsProvider {
    registry;
    processPool;
    aggregator;
    clientBinder;
    openApiConnector;
    profileRouter;
    policyGuard;
    softwareBridge;
    builderSandbox;
    secretVault;
    versionManager;
    constructor(registry, processPool, aggregator, clientBinder, openApiConnector, profileRouter, policyGuard, softwareBridge, builderSandbox, secretVault) {
        this.registry = registry;
        this.processPool = processPool;
        this.aggregator = aggregator;
        this.clientBinder = clientBinder;
        this.openApiConnector = openApiConnector;
        this.profileRouter = profileRouter;
        this.policyGuard = policyGuard;
        this.softwareBridge = softwareBridge;
        this.builderSandbox = builderSandbox;
        this.secretVault = secretVault;
        this.versionManager = new VersionManager(process.env.MCP_WORKBENCH_ROOT ?? process.cwd());
    }
    getMetaToolDefinitions() {
        return [
            {
                name: "studio__ui__configure",
                description: "Enable or disable the built-in Web Console (/ui) at runtime without restarting the Daemon, or query current UI status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        web_ui_enabled: {
                            type: "boolean",
                            description: "Set true to enable http://127.0.0.1:<port>/ui, or false to disable web access (TUI remains active)",
                        },
                    },
                },
            },
            {
                name: "studio__secret__set",
                description: "Store an encrypted secret in the local AES-256-GCM SecretVault so configs can reference '$secret:KEY_NAME' without plaintext exposure.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: { type: "string", description: "Secret key identifier (e.g. 'CRM_API_TOKEN')" },
                        value: { type: "string", description: "Secret plaintext value to encrypt at rest" },
                    },
                    required: ["key", "value"],
                },
            },
            {
                name: "studio__secret__list",
                description: "List all secret key names and their '$secret:KEY' placeholders stored in SecretVault (values are never returned).",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "studio__secret__delete",
                description: "Delete a secret key from the local SecretVault.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: { type: "string", description: "Secret key identifier to delete" },
                    },
                    required: ["key"],
                },
            },
            {
                name: "studio__client__scan",
                description: "Scan the machine using the 4-Layer Pre-Bind Discovery Funnel (Standard Paths, Install Pre-Provisioning, OS Runtime Process Table, Manual Path) to locate AI Agents.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "studio__client__bind",
                description: "Surgically bind an AI Agent client to MCP Workbench (importing and starting its existing scattered MCP servers, backing up original config, and injecting the unified Shim entrypoint).",
                inputSchema: {
                    type: "object",
                    properties: {
                        client_id: { type: "string", description: "Target client ID (e.g. 'cursor', 'claude-code', 'windsurf')" },
                        manual_path: { type: "string", description: "Optional manual install directory, executable path, or config file path" },
                        mode: { type: "string", description: "'exclusive' (default) or 'side_by_side'" },
                        force: { type: "boolean", description: "Force write even if an exit_overwrite client is currently running" },
                        auto_start_imported: { type: "boolean", description: "Immediately start imported MCP servers (default true)" },
                    },
                    required: ["client_id"],
                },
            },
            {
                name: "studio__client__unbind",
                description: "Restore a bound AI Agent client's original configuration from its .workbench.bak backup.",
                inputSchema: {
                    type: "object",
                    properties: {
                        client_id: { type: "string", description: "Target client ID to unbind" },
                    },
                    required: ["client_id"],
                },
            },
            {
                name: "studio__server__list",
                description: "List all configured MCP servers across all 4 driver types (stdio_process, virtual_openapi, software_bridge, builder_sandbox).",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "studio__server__add",
                description: "Dynamically register, start, handshake, and mount a new stdio MCP Server into the Gateway without restarting host Agents.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "Unique server identifier" },
                        command: { type: "string", description: "Executable command (e.g. 'node', 'uvx', 'npx')" },
                        args: { type: "array", description: "Command arguments array" },
                        env: { type: "object", description: "Optional environment variables" },
                        highFrequencyTools: { type: "array", description: "Optional list of tool names to expose at top-level" },
                    },
                    required: ["id", "command", "args"],
                },
            },
            {
                name: "studio__server__remove",
                description: "Stop and remove any MCP Server (stdio, virtual OpenAPI, bridge, or sandbox) from the Gateway.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "Server ID to remove" },
                    },
                    required: ["id"],
                },
            },
            {
                name: "studio__server__stop",
                description: "Stop an active MCP Server process without deleting it from configuration.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "Server ID to stop" },
                    },
                    required: ["id"],
                },
            },
            {
                name: "studio__server__start",
                description: "Start a stopped MCP Server process and discover its tools.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "Server ID to start" },
                    },
                    required: ["id"],
                },
            },
            {
                name: "studio__server__restart",
                description: "Restart an existing MCP Server or reload a virtual OpenAPI connector.",
                inputSchema: {
                    type: "object",
                    properties: {
                        id: { type: "string", description: "Server ID to restart" },
                    },
                    required: ["id"],
                },
            },
            {
                name: "studio__tool__search",
                description: "Search across registered MCP tools allowed in the caller's active Context Profile by keyword or server ID.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Keyword to match against tool name, server ID, or description" },
                        server_id: { type: "string", description: "Optional server ID filter" },
                    },
                    required: ["query"],
                },
            },
            {
                name: "studio__tool__invoke",
                description: "Directly invoke any registered downstream tool allowed in the caller's Profile with full PolicyGuard & JSON Schema verification.",
                inputSchema: {
                    type: "object",
                    properties: {
                        server_id: { type: "string", description: "Target MCP server ID" },
                        tool_name: { type: "string", description: "Original tool name or exposed name" },
                        arguments: { type: "object", description: "Complete arguments object for the target downstream tool" },
                    },
                    required: ["server_id", "tool_name", "arguments"],
                },
            },
            {
                name: "studio__connector__import_openapi",
                description: "Zero-code OpenAPI Connector: import an OpenAPI 3.x spec into a persisted virtual MCP server without spawning child processes.",
                inputSchema: {
                    type: "object",
                    properties: {
                        connector_id: { type: "string", description: "Unique virtual server ID (e.g. 'crm_api')" },
                        spec: { type: "object", description: "OpenAPI 3.x JSON specification object" },
                        base_url: { type: "string", description: "Optional base URL override" },
                        auth_type: { type: "string", description: "'none' | 'bearer' | 'api_key_header'" },
                        auth_token: { type: "string", description: "Optional Bearer token or API key" },
                        pick_fields: { type: "array", description: "Optional whitelist of top-level JSON response fields to keep" },
                    },
                    required: ["connector_id", "spec"],
                },
            },
            {
                name: "studio__profile__upsert",
                description: "Create or update a context-aware Profile routing rule that isolates exposed and callable MCP servers by workspace CWD or client name.",
                inputSchema: {
                    type: "object",
                    properties: {
                        profile_id: { type: "string", description: "Profile identifier" },
                        description: { type: "string", description: "Human-readable description" },
                        allowed_servers: { type: "array", description: "List of server IDs allowed in this profile" },
                        match_workspace_substr: { type: "string", description: "Substring in caller CWD that activates this profile" },
                        match_client_keyword: { type: "string", description: "Client name keyword that activates this profile" },
                    },
                    required: ["profile_id", "allowed_servers"],
                },
            },
            {
                name: "studio__policy__set_rule",
                description: "Configure a security firewall rule (risk classification, forbidden parameter regex fence, or human approval gate).",
                inputSchema: {
                    type: "object",
                    properties: {
                        rule_id: { type: "string", description: "Unique rule identifier" },
                        target_tool: { type: "string", description: "Target exposed tool name or '*'" },
                        risk_level: { type: "string", description: "'safe' | 'mutating' | 'destructive'" },
                        deny_param_regex: { type: "string", description: "Forbidden parameter regex pattern" },
                        require_approval: { type: "boolean", description: "Require one-time human approval token before execution" },
                        wait_for_approval_ms: { type: "number", description: "Optional synchronous hold window (in ms) to wait for human approval in-flight before returning an error." },
                    },
                    required: ["rule_id", "target_tool", "risk_level"],
                },
            },
            {
                name: "studio__policy__list_pending",
                description: "List pending destructive tool calls awaiting human/GUI approval via /admin/approve.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "studio__policy__audit_log",
                description: "Retrieve the Flight Recorder audit log of recent tool invocations and security policy decisions.",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number", description: "Max entries to return" },
                    },
                },
            },
            {
                name: "studio__bridge__list",
                description: "List connected desktop host software plugins (e.g. Blender, Revit, AutoCAD) registered via the Reverse IPC SoftwareBridge.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "studio__builder__create_server",
                description: "Synthesize a new custom MCP Server in JavaScript, verify it against mandatory self-tests in an isolated trial process, and hot-mount it into the Gateway.",
                inputSchema: {
                    type: "object",
                    properties: {
                        server_id: { type: "string", description: "Unique server ID for the synthesized MCP server" },
                        tools: {
                            type: "array",
                            description: "Array of { name, description, inputSchema, handlerBodyJs }",
                        },
                        self_tests: {
                            type: "array",
                            description: "Mandatory array of { toolName, arguments, expectedSubstring } verified before mounting",
                        },
                    },
                    required: ["server_id", "tools", "self_tests"],
                },
            },
            {
                name: "studio__project__history",
                description: "Query local project version history, checkpoints, commits, and current workspace status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        limit: { type: "number", description: "Maximum number of historical records to return (default: 15)" },
                    },
                },
            },
            {
                name: "studio__project__snapshot",
                description: "Create an atomic, named project checkpoint/snapshot with automatic git commit & tag for safe rollback.",
                inputSchema: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Snapshot identifier (e.g. 'before-major-refactor')" },
                        description: { type: "string", description: "Optional notes about this checkpoint" },
                    },
                    required: ["name"],
                },
            },
            {
                name: "studio__project__rollback",
                description: "Safely roll back the project workspace to a specified commit ID, tag name, or snapshot. Automatically creates a pre-rollback backup tag.",
                inputSchema: {
                    type: "object",
                    properties: {
                        target: { type: "string", description: "Commit ID, tag name, or snapshot name to roll back to" },
                        safety_backup: { type: "boolean", description: "Whether to create an emergency backup before rolling back (default: true)" },
                    },
                    required: ["target"],
                },
            },
            {
                name: "studio__metrics__get",
                description: "Retrieve comprehensive telemetry metrics, latency percentiles (P50/P90/P99), cache hit rates, and estimated LLM tokens.",
                inputSchema: {
                    type: "object",
                    properties: {
                        server_id: { type: "string", description: "Optional filter by server ID" },
                    },
                },
            },
            {
                name: "studio__cache__clear",
                description: "Clear cached tool execution results across all servers or for a specific server.",
                inputSchema: {
                    type: "object",
                    properties: {
                        server_id: { type: "string", description: "Optional server ID to clear" },
                    },
                },
            },
            {
                name: "studio__circuit__status",
                description: "Get real-time health watchdog and circuit breaker status across all downstream MCP servers.",
                inputSchema: { type: "object", properties: {} },
            },
            {
                name: "studio__vault__set",
                description: "Securely store or update an encrypted secret/API token in the SecretVault using AES-256-GCM authenticated encryption.",
                inputSchema: {
                    type: "object",
                    properties: {
                        key: { type: "string", description: "Identifier key for the secret" },
                        value: { type: "string", description: "Plaintext secret value to encrypt" },
                        description: { type: "string", description: "Optional human-readable description" },
                    },
                    required: ["key", "value"],
                },
            },
            {
                name: "studio__vault__list",
                description: "List all encrypted secret keys and metadata in the SecretVault (never exposes plaintext secrets).",
                inputSchema: { type: "object", properties: {} },
            },
        ];
    }
    isMetaTool(name) {
        const canonical = name.replace(/\./g, "__");
        return this.getMetaToolDefinitions().some((d) => d.name === canonical);
    }
    async executeMetaTool(rawName, args, callerPpid = null, callerCwd = null, callerClientName = null) {
        const name = rawName.replace(/^studio__/, "studio.").replace(/__/g, ".");
        switch (name) {
            case "studio.ui.configure": {
                if (args.web_ui_enabled !== undefined) {
                    this.registry.setWebUiEnabled(Boolean(args.web_ui_enabled));
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "ok",
                                webUiEnabled: this.registry.isWebUiEnabled(),
                            }),
                        },
                    ],
                };
            }
            case "studio.secret.set": {
                if (!this.secretVault) {
                    throw new Error("SecretVault is not attached.");
                }
                const key = String(args.key ?? "").trim();
                const val = String(args.value ?? "");
                this.secretVault.setSecret(key, val);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "secret_encrypted",
                                key,
                                placeholder: `$secret:${key}`,
                            }),
                        },
                    ],
                };
            }
            case "studio.secret.list": {
                if (!this.secretVault) {
                    throw new Error("SecretVault is not attached.");
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ secrets: this.secretVault.listSecretKeys() }, null, 2),
                        },
                    ],
                };
            }
            case "studio.secret.delete": {
                if (!this.secretVault) {
                    throw new Error("SecretVault is not attached.");
                }
                const key = String(args.key ?? "").trim();
                const deleted = this.secretVault.deleteSecret(key);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ status: "secret_deleted", key, deleted }),
                        },
                    ],
                };
            }
            case "studio.connector.import_openapi": {
                if (!this.openApiConnector) {
                    throw new Error("OpenApiConnector is not attached.");
                }
                const connectorId = String(args.connector_id ?? "").trim();
                const spec = args.spec;
                const tools = this.openApiConnector.importOpenApiSpec(connectorId, spec, {
                    baseUrl: args.base_url,
                    authType: args.auth_type,
                    authToken: args.auth_token,
                    pickFields: args.pick_fields,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "openapi_mounted",
                                connectorId,
                                toolCount: tools.length,
                                tools: tools.map((t) => ({
                                    toolId: t.toolId,
                                    exposedName: t.exposedName,
                                    description: t.description,
                                    inputSchema: t.inputSchema,
                                })),
                            }, null, 2),
                        },
                    ],
                };
            }
            case "studio.profile.upsert": {
                if (!this.profileRouter) {
                    throw new Error("ContextProfileRouter is not attached.");
                }
                const rule = this.profileRouter.upsertProfile({
                    profileId: String(args.profile_id),
                    description: String(args.description ?? ""),
                    allowedServers: Array.isArray(args.allowed_servers)
                        ? args.allowed_servers.map(String)
                        : ["*"],
                    matchWorkspaceSubstr: args.match_workspace_substr
                        ? String(args.match_workspace_substr)
                        : undefined,
                    matchClientKeyword: args.match_client_keyword
                        ? String(args.match_client_keyword)
                        : undefined,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ status: "profile_upserted", rule }, null, 2),
                        },
                    ],
                };
            }
            case "studio.policy.set_rule": {
                if (!this.policyGuard) {
                    throw new Error("PolicyGuard is not attached.");
                }
                const rule = this.policyGuard.setPolicyRule({
                    ruleId: String(args.rule_id),
                    targetTool: String(args.target_tool),
                    riskLevel: args.risk_level ?? "safe",
                    denyParamRegex: args.deny_param_regex
                        ? String(args.deny_param_regex)
                        : undefined,
                    requireApproval: Boolean(args.require_approval),
                    waitForApprovalMs: args.wait_for_approval_ms ? Number(args.wait_for_approval_ms) : undefined,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ status: "policy_rule_active", rule }, null, 2),
                        },
                    ],
                };
            }
            case "studio.policy.list_pending": {
                if (!this.policyGuard) {
                    throw new Error("PolicyGuard is not attached.");
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ pendingApprovals: this.policyGuard.listPendingApprovals() }, null, 2),
                        },
                    ],
                };
            }
            case "studio.policy.audit_log": {
                if (!this.policyGuard) {
                    throw new Error("PolicyGuard is not attached.");
                }
                const limit = Number(args.limit ?? 50);
                const logs = this.policyGuard.getAuditLogs(limit);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ count: logs.length, logs }, null, 2),
                        },
                    ],
                };
            }
            case "studio.bridge.list": {
                if (!this.softwareBridge) {
                    throw new Error("SoftwareBridge is not attached.");
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ bridges: this.softwareBridge.listActiveBridges() }, null, 2),
                        },
                    ],
                };
            }
            case "studio.builder.create_server": {
                if (!this.builderSandbox) {
                    throw new Error("BuilderSandbox is not attached.");
                }
                const serverId = String(args.server_id ?? "").trim();
                const tools = Array.isArray(args.tools) ? args.tools : [];
                const selfTests = Array.isArray(args.self_tests)
                    ? args.self_tests
                    : [];
                const res = await this.builderSandbox.buildVerifyAndMountServer(serverId, tools, selfTests);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(res, null, 2),
                        },
                    ],
                };
            }
            case "studio.client.scan": {
                if (!this.clientBinder) {
                    throw new Error("ClientAutoBinder is not attached.");
                }
                const statuses = this.clientBinder.scanClients();
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ clients: statuses }, null, 2),
                        },
                    ],
                };
            }
            case "studio.client.bind": {
                if (!this.clientBinder) {
                    throw new Error("ClientAutoBinder is not attached.");
                }
                const clientId = String(args.client_id ?? "").trim();
                const manualPath = args.manual_path ? String(args.manual_path) : undefined;
                const bound = await this.clientBinder.bindClient(clientId, manualPath, {
                    force: Boolean(args.force),
                    mode: args.mode ? String(args.mode) : "exclusive",
                    autoStartImported: args.auto_start_imported !== undefined
                        ? Boolean(args.auto_start_imported)
                        : true,
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(bound, null, 2),
                        },
                    ],
                };
            }
            case "studio.client.unbind": {
                if (!this.clientBinder) {
                    throw new Error("ClientAutoBinder is not attached.");
                }
                const clientId = String(args.client_id ?? "").trim();
                const restored = this.clientBinder.unbindClient(clientId);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ clientId, restored }),
                        },
                    ],
                };
            }
            case "studio.server.list": {
                const desiredList = this.registry.getDesiredServers();
                const allTools = this.registry.getAllTools();
                const summary = desiredList.map((desired) => {
                    const actual = this.registry.getRuntimeState(desired.id);
                    const serverTools = allTools.filter((t) => t.serverId === desired.id);
                    return {
                        serverId: desired.id,
                        serverType: desired.serverType ?? "stdio_process",
                        desiredEnabled: desired.enabled,
                        actualPhase: actual?.phase ?? "stopped",
                        pid: actual?.pid ?? null,
                        toolCount: serverTools.length,
                        tools: serverTools.map((t) => ({
                            toolId: t.toolId,
                            originalName: t.originalName,
                            exposedName: t.exposedName,
                            exposeTopLevel: t.exposeTopLevel,
                        })),
                    };
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ servers: summary }, null, 2),
                        },
                    ],
                };
            }
            case "studio.server.add": {
                const id = String(args.id ?? "").trim();
                const command = String(args.command ?? "").trim();
                const cmdArgs = Array.isArray(args.args)
                    ? args.args.map((a) => String(a))
                    : [];
                if (!id || !command) {
                    throw new Error("studio__server__add requires non-empty 'id' and 'command'.");
                }
                const newConfig = {
                    id,
                    serverType: "stdio_process",
                    command,
                    args: cmdArgs,
                    env: args.env ?? {},
                    enabled: true,
                    autoRestart: true,
                    highFrequencyTools: Array.isArray(args.highFrequencyTools)
                        ? args.highFrequencyTools.map(String)
                        : undefined,
                };
                this.registry.upsertDesiredServer(newConfig);
                const discoveredTools = await this.aggregator.connectAndDiscoverServer(newConfig);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "mounted",
                                serverId: id,
                                runtimeState: this.registry.getRuntimeState(id),
                                discoveredTools: discoveredTools.map((t) => ({
                                    toolId: t.toolId,
                                    originalName: t.originalName,
                                    exposedName: t.exposedName,
                                    exposeTopLevel: t.exposeTopLevel,
                                    description: t.description,
                                    inputSchema: t.inputSchema,
                                })),
                            }, null, 2),
                        },
                    ],
                };
            }
            case "studio.server.remove": {
                const id = String(args.id ?? "").trim();
                const cfg = this.registry.getDesiredServer(id);
                const driver = cfg?.serverType ?? "stdio_process";
                if (driver === "virtual_openapi" && this.openApiConnector) {
                    this.openApiConnector.removeVirtualConnector(id);
                }
                else if (driver === "software_bridge" && this.softwareBridge) {
                    this.softwareBridge.handlePluginDisconnect(id);
                }
                else {
                    await this.processPool.stopServerProcess(id);
                }
                const removed = this.registry.removeDesiredServer(id);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: removed ? "removed" : "not_found",
                                serverId: id,
                            }),
                        },
                    ],
                };
            }
            case "studio.server.stop": {
                const id = String(args.id ?? "").trim();
                const cfg = this.registry.getDesiredServer(id);
                const driver = cfg?.serverType ?? "stdio_process";
                if (driver === "virtual_openapi" && this.openApiConnector) {
                    this.registry.clearServerTools(id);
                    this.registry.updateRuntimeState(id, { phase: "stopped", pid: null });
                }
                else if (driver === "software_bridge" && this.softwareBridge) {
                    this.softwareBridge.handlePluginDisconnect(id);
                    this.registry.clearServerTools(id);
                    this.registry.updateRuntimeState(id, { phase: "stopped", pid: null });
                }
                else {
                    await this.processPool.stopServerProcess(id);
                    this.registry.clearServerTools(id);
                    this.registry.updateRuntimeState(id, { phase: "stopped", pid: null });
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "stopped",
                                serverId: id,
                            }),
                        },
                    ],
                };
            }
            case "studio.server.start":
            case "studio.server.restart": {
                const id = String(args.id ?? "").trim();
                const cfg = this.registry.getDesiredServer(id);
                if (!cfg) {
                    throw new Error(`Server '${id}' not found in workbench.json.`);
                }
                const driver = cfg.serverType ?? "stdio_process";
                if (driver === "virtual_openapi" && this.openApiConnector) {
                    const tools = this.openApiConnector.restorePersistedConnector(id);
                    return {
                        content: [
                            {
                                type: "text",
                                text: JSON.stringify({
                                    status: "reloaded_virtual_openapi",
                                    serverId: id,
                                    toolCount: tools.length,
                                }),
                            },
                        ],
                    };
                }
                await this.processPool.stopServerProcess(id);
                const tools = await this.aggregator.connectAndDiscoverServer(cfg);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "restarted",
                                serverId: id,
                                toolCount: tools.length,
                            }),
                        },
                    ],
                };
            }
            case "studio.tool.search": {
                const query = String(args.query ?? "");
                const serverFilter = args.server_id ? String(args.server_id) : undefined;
                let matches = this.registry.searchTools(query, serverFilter);
                // Conflict Fix: Filter search results by caller's active Context Profile!
                if (this.profileRouter) {
                    matches = matches.filter((t) => this.profileRouter.isServerAllowedForContext(t.serverId, callerCwd ?? undefined, callerClientName ?? undefined).allowed);
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                query,
                                matchCount: matches.length,
                                tools: matches.map((t) => ({
                                    toolId: t.toolId,
                                    serverId: t.serverId,
                                    originalName: t.originalName,
                                    exposedName: t.exposedName,
                                    exposeTopLevel: t.exposeTopLevel,
                                    description: t.description,
                                    inputSchema: t.inputSchema,
                                })),
                            }, null, 2),
                        },
                    ],
                };
            }
            case "studio.tool.invoke": {
                const serverId = String(args.server_id ?? "").trim();
                const toolName = String(args.tool_name ?? "").trim();
                const toolArgs = args.arguments && typeof args.arguments === "object"
                    ? args.arguments
                    : {};
                if (!serverId || !toolName) {
                    throw new Error("studio__tool__invoke requires 'server_id', 'tool_name', and 'arguments'.");
                }
                const toolRecord = this.registry.resolveTool(serverId, toolName);
                if (!toolRecord) {
                    throw new Error(`Tool '${toolName}' not found on server '${serverId}'. Call studio__tool__search to inspect available tools.`);
                }
                return await this.aggregator.invokeDownstreamTool(toolRecord, toolArgs, callerPpid, callerCwd, callerClientName);
            }
            case "studio.project.history": {
                const limit = Number(args.limit ?? 15);
                const status = this.versionManager.getStatus();
                const history = this.versionManager.listHistory(limit);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ status, history }, null, 2),
                        },
                    ],
                };
            }
            case "studio.project.snapshot": {
                const name = String(args.name ?? "").trim();
                const description = String(args.description ?? "");
                if (!name) {
                    throw new Error("studio.project.snapshot requires a 'name'.");
                }
                const res = this.versionManager.createSnapshot(name, description);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(res, null, 2),
                        },
                    ],
                };
            }
            case "studio.project.rollback": {
                const target = String(args.target ?? "").trim();
                const safetyBackup = args.safety_backup !== false;
                if (!target) {
                    throw new Error("studio.project.rollback requires a 'target'.");
                }
                const res = this.versionManager.rollback(target, safetyBackup);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(res, null, 2),
                        },
                    ],
                };
            }
            case "studio.metrics.get": {
                const metrics = this.aggregator.telemetryMetrics;
                if (!metrics) {
                    throw new Error("Telemetry metrics module is not enabled.");
                }
                const serverId = args.server_id ? String(args.server_id) : undefined;
                const res = serverId
                    ? metrics.getServerSummaries(serverId)
                    : {
                        overview: metrics.getSystemOverview(),
                        summaries: metrics.getAllSummaries(),
                    };
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(res, null, 2),
                        },
                    ],
                };
            }
            case "studio.cache.clear": {
                const cache = this.aggregator.toolCache;
                if (!cache) {
                    throw new Error("Result cache module is not enabled.");
                }
                const serverId = args.server_id ? String(args.server_id) : undefined;
                if (serverId) {
                    cache.clearServer(serverId);
                }
                else {
                    cache.clear();
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({ cleared: true, serverId: serverId ?? "all" }, null, 2),
                        },
                    ],
                };
            }
            case "studio.circuit.status": {
                const watchdog = this.aggregator.healthWatchdog;
                if (!watchdog) {
                    throw new Error("Health watchdog module is not enabled.");
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(watchdog.getHealthSummary(), null, 2),
                        },
                    ],
                };
            }
            case "studio.vault.set": {
                if (!this.secretVault) {
                    throw new Error("Secret vault module is not configured.");
                }
                const key = String(args.key ?? "").trim();
                const value = String(args.value ?? "");
                const description = args.description ? String(args.description) : undefined;
                if (!key || !value) {
                    throw new Error("studio.vault.set requires both 'key' and 'value'.");
                }
                this.secretVault.setSecret(key, value, description);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                status: "stored",
                                key,
                                reference: `vault://${key}`,
                                message: `Secret stored securely. Reference it in environment variables or API headers as 'vault://${key}'.`,
                            }, null, 2),
                        },
                    ],
                };
            }
            case "studio.vault.list": {
                if (!this.secretVault) {
                    throw new Error("Secret vault module is not configured.");
                }
                const list = this.secretVault.listSecretsMetadata();
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(list, null, 2),
                        },
                    ],
                };
            }
            default:
                throw new Error(`Unknown studio meta-tool: ${rawName}`);
        }
    }
}
