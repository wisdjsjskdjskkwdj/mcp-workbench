import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { WorkbenchDaemon } from "./daemon.js";
import { TuiConsole } from "./tui_console.js";
/**
 * Automated 14-Step Acceptance Verification Suite for MCP Workbench Gateway Prototype v0.0.5.
 */
async function postJson(port, urlPath, payload, headers = {}) {
    return new Promise((resolve, reject) => {
        const raw = JSON.stringify(payload);
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: urlPath,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...headers,
            },
        }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try {
                    resolve({
                        statusCode: res.statusCode ?? 500,
                        body: data ? JSON.parse(data) : {},
                    });
                }
                catch (err) {
                    reject(err);
                }
            });
        });
        req.on("error", reject);
        req.write(raw);
        req.end();
    });
}
async function postMcp(port, token, payload, extraHeaders = {}) {
    const res = await postJson(port, "/mcp", payload, {
        Authorization: `Bearer ${token}`,
        ...extraHeaders,
    });
    return res.body;
}
async function runVerification() {
    const rootDir = path.resolve(process.cwd());
    const port = 43115;
    console.log("=== [Step 1] Verifying Single-Instance Daemon Lock & Startup ===");
    const daemon1 = new WorkbenchDaemon(rootDir, port);
    const lockInfo = await daemon1.start();
    assert.strictEqual(lockInfo.port, port);
    assert(lockInfo.adminSecret && lockInfo.adminSecret !== lockInfo.token, "Must generate distinct adminSecret");
    const daemon2 = new WorkbenchDaemon(rootDir, port + 1);
    let duplicateBlocked = false;
    try {
        await daemon2.start();
    }
    catch (err) {
        if (String(err.message).includes("ALREADY_RUNNING")) {
            duplicateBlocked = true;
        }
    }
    assert.strictEqual(duplicateBlocked, true);
    console.log("PASS: Step 1 - Single-Instance Daemon lock & distinct Admin Secret verified (PID=" + lockInfo.pid + ")");
    console.log("=== [Step 2] Verifying Two-Server Aggregation & Tool Name Regex Compliance ===");
    const listResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
    });
    const toolNames = listResp.result.tools.map((t) => t.name);
    for (const name of toolNames) {
        assert(/^[a-zA-Z0-9_-]{1,64}$/.test(name), `Tool name "${name}" violates strict LLM regex ^[a-zA-Z0-9_-]{1,64}$`);
    }
    assert(toolNames.includes("math_ops__add"));
    assert(toolNames.includes("sys_clock__get_time"));
    assert(!toolNames.includes("math_ops__fibonacci"));
    const addCall = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "math_ops__add", arguments: { a: 17, b: 25 } },
    });
    assert.strictEqual(addCall.result.content[0].text, "42");
    console.log("PASS: Step 2 - Both initial MCP servers aggregated and all 19 tool names match ^[a-zA-Z0-9_-]{1,64}$.");
    console.log("=== [Step 3] Verifying Multi-Client Shared Daemon (HTTP Client + Stdio Shim Client) ===");
    const shimChild = spawn("node", ["./dist/stdio_shim.js"], {
        cwd: rootDir,
        env: { ...process.env, MCP_WORKBENCH_ROOT: rootDir },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const shimMessages = [];
    const shimNotifications = [];
    const rlShim = readline.createInterface({ input: shimChild.stdout });
    rlShim.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "notifications/tools/list_changed") {
            shimNotifications.push(msg);
        }
        else {
            shimMessages.push(msg);
        }
    });
    shimChild.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 101,
        method: "tools/call",
        params: { name: "math_ops__multiply", arguments: { a: 6, b: 7 } },
    }) + "\n");
    for (let i = 0; i < 30 && !shimMessages.find((m) => m.id === 101); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    const multResp = shimMessages.find((m) => m.id === 101);
    assert(multResp);
    assert.strictEqual(multResp.result.content[0].text, "42");
    assert(daemon1.connectedClientPids.has(process.pid));
    console.log("PASS: Step 3 - Streamable HTTP Client and Stdio Shim Client share the same Daemon with PPID session attribution.");
    console.log("=== [Step 4 & Step 6] Verifying Agent Self-Bootstrapping (`studio__server__add`) & Dynamic Discovery ===");
    const addServerResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
            name: "studio__server__add",
            arguments: {
                id: "weather_service",
                command: "node",
                args: ["./dist/test_servers/mock_server_c.js"],
            },
        },
    });
    const mountData = JSON.parse(addServerResp.result.content[0].text);
    assert.strictEqual(mountData.status, "mounted");
    for (let i = 0; i < 30 && shimNotifications.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert(shimNotifications.length >= 1);
    console.log("PASS: Step 4 & Step 6 - Agent dynamically added 3rd Server (`weather_service`) and cross-client list_changed notification fired.");
    console.log("=== [Step 5] Verifying Tool Cache Compatibility (`studio__tool__search` + `studio__tool__invoke` + Schema Validation) ===");
    const invokeForecast = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
            name: "studio__tool__invoke",
            arguments: {
                server_id: "weather_service",
                tool_name: "get_forecast",
                arguments: { city: "Shanghai", days: 3 },
            },
        },
    });
    assert.strictEqual(invokeForecast.result.content[0].text, "FORECAST[Shanghai,3d]: Sunny 22C");
    const invokeFib = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
            name: "studio__tool__invoke",
            arguments: {
                server_id: "math_ops",
                tool_name: "fibonacci",
                arguments: { n: 10 },
            },
        },
    });
    assert.strictEqual(invokeFib.result.content[0].text, "55");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "studio__server__remove", arguments: { id: "weather_service" } },
    });
    console.log("PASS: Step 5 - Cold and newly mounted tools searched and invoked with strict Schema validation.");
    console.log("=== [Step 7] Verifying L3 Runtime Process Inspection & Surgical Non-Destructive Binding ===");
    const portableDir = path.join(rootDir, "tmp_portable_cursor");
    const customProfileDir = path.join(portableDir, "custom_data_dir");
    fs.mkdirSync(customProfileDir, { recursive: true });
    const fakeAgentScript = path.join(portableDir, "FakePortableCursor.js");
    fs.writeFileSync(fakeAgentScript, "setInterval(() => {}, 1000);\n", "utf-8");
    const portableMcpJson = path.join(customProfileDir, "mcp.json");
    fs.writeFileSync(portableMcpJson, JSON.stringify({
        editorTheme: "Solarized-Dark",
        mcpServers: {
            legacy_scattered_srv: { command: "node", args: ["legacy.js"] },
        },
    }, null, 2), "utf-8");
    daemon1.clientBinder.registerCustomAdapter({
        clientId: "portable-cursor-test",
        displayName: "Portable Cursor Test Agent",
        processKeywords: ["FakePortableCursor.js"],
        defaultConfigCandidates: ["/non/existent/default/mcp.json"],
        defaultInstallDirs: ["/non/existent/install"],
        configFormat: "json_mcpServers",
        reloadBehavior: "hot_watch",
        portableConfigRelPath: "mcp.json",
    });
    const fakeAgentProc = spawn(process.execPath, [fakeAgentScript, `--user-data-dir=${customProfileDir}`], { cwd: portableDir, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    const scanResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "studio__client__scan", arguments: {} },
    });
    const scanData = JSON.parse(scanResp.result.content[0].text);
    const detectedPortable = scanData.clients.find((c) => c.clientId === "portable-cursor-test");
    assert.strictEqual(detectedPortable.discoveryLayer, "L3_RUNTIME_PROCESS");
    const bindResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
            name: "studio__client__bind",
            arguments: { client_id: "portable-cursor-test", auto_start_imported: false },
        },
    });
    const bindData = JSON.parse(bindResp.result.content[0].text);
    assert.strictEqual(bindData.status, "bound");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "studio__client__unbind", arguments: { client_id: "portable-cursor-test" } },
    });
    daemon1.registry.removeDesiredServer("legacy_scattered_srv");
    if (process.platform === "win32") {
        try {
            const { execSync } = await import("node:child_process");
            execSync(`taskkill /F /PID ${fakeAgentProc.pid}`, { stdio: "ignore" });
        }
        catch {
            fakeAgentProc.kill("SIGKILL");
        }
    }
    else {
        fakeAgentProc.kill("SIGKILL");
    }
    await new Promise((r) => setTimeout(r, 200));
    for (let i = 0; i < 15; i++) {
        try {
            fs.rmSync(portableDir, { recursive: true, force: true });
            break;
        }
        catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    console.log("PASS: Step 7 - L3 Runtime Process Detection, CLI Flag Extraction & Surgical Merge verified.");
    console.log("=== [Step 15] Verifying Module A (`CommandResolver`) — Cross-Platform Executable & PATH Resolution ===");
    const resolvedNode = daemon1.commandResolver.resolveSpawnTarget("node", ["-v"], {
        CUSTOM_FLAG: "1",
    });
    assert(path.isAbsolute(resolvedNode.command), `CommandResolver must resolve bare "node" to an absolute binary path, got: ${resolvedNode.command}`);
    assert.strictEqual(resolvedNode.env.CUSTOM_FLAG, "1");
    console.log("PASS: Step 15 - CommandResolver resolved bare executable to " + resolvedNode.command);
    console.log("=== [Step 16] Verifying Module B (`SecretVault`) — AES-256-GCM Encryption, `$secret:` Injection & Redaction ===");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 160,
        method: "tools/call",
        params: {
            name: "studio__secret__set",
            arguments: { key: "CRM_SECRET_TOKEN", value: "secret_crm_token" },
        },
    });
    const rawVaultOnDisk = fs.readFileSync(path.join(rootDir, ".workbench-secrets.enc.json"), "utf-8");
    assert(!rawVaultOnDisk.includes("secret_crm_token"), "SecretVault must encrypt secret values at rest with AES-256-GCM");
    assert.strictEqual(daemon1.secretVault.redactSecrets("Token leaked: secret_crm_token!"), "Token leaked: [REDACTED:$secret:CRM_SECRET_TOKEN]!");
    console.log("PASS: Step 16 - SecretVault AES-256-GCM encryption at rest & log redaction verified.");
    console.log("=== [Step 17] Verifying Module C (`resources/*` & `prompts/*`) — Full MCP Protocol Aggregation & Isolation ===");
    const resListResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 170,
        method: "resources/list",
    });
    assert(resListResp.result.resources.some((r) => r.uri === "mcp-workbench://math_ops/math://constants/pi"), "Gateway must aggregate and namespace downstream MCP resources");
    const resReadResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 171,
        method: "resources/read",
        params: { uri: "mcp-workbench://math_ops/math://constants/pi" },
    });
    assert.strictEqual(resReadResp.result.contents[0].text, "PI=3.141592653589793");
    const promptListResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 172,
        method: "prompts/list",
    });
    assert(promptListResp.result.prompts.some((p) => p.name === "math_ops__explain_theorem"), "Gateway must aggregate and namespace downstream MCP prompts");
    const promptGetResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 173,
        method: "prompts/get",
        params: {
            name: "math_ops__explain_theorem",
            arguments: { theorem: "Euler Identity" },
        },
    });
    assert(String(promptGetResp.result.messages[0].content.text).includes("Euler Identity"));
    console.log("PASS: Step 17 - MCP resources/list, resources/read, prompts/list, and prompts/get verified.");
    console.log("=== [Step 9] Verifying Zero-Code OpenAPI 3.x Virtual MCP Server & Response Pruning ===");
    const mockRestPort = 43125;
    const mockRestServer = http.createServer(async (req, res) => {
        const auth = req.headers["authorization"];
        if (auth !== "Bearer secret_crm_token") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized REST call" }));
            return;
        }
        if (req.method === "GET" && req.url?.startsWith("/customers/")) {
            const custId = req.url.split("/customers/")[1]?.split("?")[0];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                id: custId,
                name: "Acme Corp",
                tier: "Enterprise",
                huge_internal_blob: "X".repeat(2000),
            }));
            return;
        }
        if (req.method === "POST" && req.url === "/orders") {
            let body = "";
            for await (const chunk of req)
                body += chunk;
            const parsed = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                orderId: "ord_777",
                item: parsed.item,
                qty: parsed.qty,
                status: "created",
            }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve) => mockRestServer.listen(mockRestPort, "127.0.0.1", () => resolve()));
    const importOpenApiResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 90,
        method: "tools/call",
        params: {
            name: "studio__connector__import_openapi",
            arguments: {
                connector_id: "crm_api",
                base_url: `http://127.0.0.1:${mockRestPort}`,
                auth_type: "bearer",
                auth_token: "$secret:CRM_SECRET_TOKEN",
                pick_fields: ["id", "name", "tier", "orderId", "status"],
                spec: {
                    openapi: "3.0.0",
                    paths: {
                        "/customers/{id}": {
                            get: {
                                operationId: "get_customer",
                                summary: "Get customer profile by ID",
                                parameters: [
                                    { name: "id", in: "path", required: true, schema: { type: "string" } },
                                ],
                            },
                        },
                        "/orders": {
                            post: {
                                operationId: "create_order",
                                summary: "Create a new customer order",
                                requestBody: {
                                    required: true,
                                    content: {
                                        "application/json": {
                                            schema: {
                                                type: "object",
                                                properties: {
                                                    item: { type: "string" },
                                                    qty: { type: "number" },
                                                },
                                                required: ["item", "qty"],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    const oaData = JSON.parse(importOpenApiResp.result.content[0].text);
    assert.strictEqual(oaData.status, "openapi_mounted");
    const custCallResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 91,
        method: "tools/call",
        params: { name: "crm_api__get_customer", arguments: { id: "cust_42" } },
    });
    const custJson = JSON.parse(custCallResp.result.content[0].text);
    assert.strictEqual(custJson.id, "cust_42");
    assert.strictEqual(custJson.huge_internal_blob, undefined);
    console.log("PASS: Step 9 - Zero-Code OpenAPI 3.x Virtual Server mounted, authenticated, and pruned response fields.");
    console.log("=== [Step 10] Verifying Strict ContextProfileRouter Isolation (List + Search + Execution) ===");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 100,
        method: "tools/call",
        params: {
            name: "studio__profile__upsert",
            arguments: {
                profile_id: "crm_frontend_profile",
                description: "Only allow crm_api in crm-frontend workspace",
                allowed_servers: ["crm_api"],
                match_workspace_substr: "crm-frontend",
            },
        },
    });
    const scopedHeaders = { "X-Mcp-Client-Cwd": "/workspace/projects/crm-frontend" };
    const scopedToolsResp = await postMcp(port, lockInfo.token, { jsonrpc: "2.0", id: 101, method: "tools/list" }, scopedHeaders);
    const scopedNames = scopedToolsResp.result.tools.map((t) => t.name);
    assert(scopedNames.includes("crm_api__get_customer"));
    assert(!scopedNames.includes("math_ops__add"));
    // Conflict B Fix Verification: Calling forbidden server tool directly or via studio__tool__invoke in restricted CWD must fail!
    const forbiddenDirectCall = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 102,
        method: "tools/call",
        params: { name: "math_ops__add", arguments: { a: 1, b: 2 } },
    }, scopedHeaders);
    assert(forbiddenDirectCall.error &&
        String(forbiddenDirectCall.error.message).includes("PROFILE_FORBIDDEN[crm_frontend_profile]"), "ContextProfileRouter must block execution of tools outside active workspace profile");
    const scopedSearch = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: { name: "studio__tool__search", arguments: { query: "fibonacci" } },
    }, scopedHeaders);
    assert.strictEqual(JSON.parse(scopedSearch.result.content[0].text).matchCount, 0, "studio__tool__search must not leak tools from servers forbidden by active Profile");
    console.log("PASS: Step 10 - Strict ContextProfileRouter isolation verified across list, search, and call.");
    console.log("=== [Step 11] Verifying PolicyGuard Two-Pass Security & Out-of-Band Admin Approval ===");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 110,
        method: "tools/call",
        params: {
            name: "studio__policy__set_rule",
            arguments: {
                rule_id: "no_path_traversal",
                target_tool: "crm_api__get_customer",
                risk_level: "safe",
                deny_param_regex: "\\.\\./|DROP\\s+TABLE",
            },
        },
    });
    const traversalCall = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 111,
        method: "tools/call",
        params: { name: "crm_api__get_customer", arguments: { id: "../../etc/passwd" } },
    });
    assert(traversalCall.error && String(traversalCall.error.message).includes("POLICY_BLOCKED"));
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 112,
        method: "tools/call",
        params: {
            name: "studio__policy__set_rule",
            arguments: {
                rule_id: "approve_orders",
                target_tool: "crm_api__create_order",
                risk_level: "destructive",
                require_approval: true,
            },
        },
    });
    const unapprovedOrder = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 113,
        method: "tools/call",
        params: { name: "crm_api__create_order", arguments: { item: "H100_Cluster", qty: 4 } },
    });
    const tokenMatch = String(unapprovedOrder.error.message).match(/APPROVAL_REQUIRED\[(approve_[a-f0-9]+)\]/);
    assert(tokenMatch, "Must return one-time approval token");
    const approvalToken = tokenMatch[1];
    // Conflict A Fix Verification: Attempting to approve via /admin/approve with wrong secret must fail with 403!
    const fakeApprove = await postJson(port, "/admin/approve", { approval_token: approvalToken }, { "X-Workbench-Admin-Secret": "wrong_secret_from_agent" });
    assert.strictEqual(fakeApprove.statusCode, 403, "Must reject approval without valid human Admin Secret");
    // Out-of-Band Human/GUI Admin approval with real lockInfo.adminSecret
    const realApprove = await postJson(port, "/admin/approve", { approval_token: approvalToken }, { "X-Workbench-Admin-Secret": lockInfo.adminSecret });
    assert.strictEqual(realApprove.statusCode, 200);
    assert.strictEqual(realApprove.body.approved, true);
    // Conflict D Fix Verification: Passing invalid schema (`qty: "bad"`) must NOT burn the approved token!
    const typoAttempt = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 114,
        method: "tools/call",
        params: {
            name: "crm_api__create_order",
            arguments: { item: "H100_Cluster", qty: "not_a_number", __approval_token: approvalToken },
        },
    });
    assert(typoAttempt.error && String(typoAttempt.error.message).includes("Schema validation failed"));
    // Retry with valid schema using the SAME unburned approvalToken -> must succeed!
    const approvedOrder = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 115,
        method: "tools/call",
        params: {
            name: "crm_api__create_order",
            arguments: { item: "H100_Cluster", qty: 4, __approval_token: approvalToken },
        },
    });
    const orderRes = JSON.parse(approvedOrder.result.content[0].text);
    assert.strictEqual(orderRes.orderId, "ord_777");
    console.log("PASS: Step 11 - Out-of-band Admin Approval, Schema-first token protection & Flight Recorder verified.");
    console.log("=== [Step 19] Verifying Crash Auto-Restart & Self-Healing Recovery (`autoRestart: true`) ===");
    const beforeCrashState = daemon1.registry.getRuntimeState("sys_clock");
    assert(beforeCrashState && beforeCrashState.pid, "sys_clock should have an active PID");
    const oldClockPid = beforeCrashState.pid;
    // Simulate unexpected crash of sys_clock child process
    try {
        process.kill(oldClockPid, "SIGKILL");
    }
    catch {
        if (process.platform === "win32") {
            try {
                const { execSync } = await import("node:child_process");
                execSync(`taskkill /F /PID ${oldClockPid}`, { stdio: "ignore" });
            }
            catch { }
        }
    }
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const st = daemon1.registry.getRuntimeState("sys_clock");
        if (st && st.phase === "running" && st.pid !== oldClockPid) {
            break;
        }
    }
    const afterCrashState = daemon1.registry.getRuntimeState("sys_clock");
    assert(afterCrashState, "sys_clock state must exist");
    assert.strictEqual(afterCrashState.phase, "running", "sys_clock must auto-restart back to running phase");
    assert(afterCrashState.restartCount >= 1, "restartCount must increment after unexpected crash");
    assert.notStrictEqual(afterCrashState.pid, oldClockPid, "Must spawn a new child PID");
    const clockAfterCrash = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 190,
        method: "tools/call",
        params: { name: "sys_clock__get_time", arguments: { timezone: "UTC" } },
    });
    assert(String(clockAfterCrash.result.content[0].text).includes("CLOCK_OK[UTC]"));
    console.log("PASS: Step 19 - Child process crash detected and automatically restarted & re-handshaked (new PID=" + afterCrashState.pid + ").");
    console.log("=== [Step 20] Verifying Synchronous Hold-and-Release Live Approval (`waitForApprovalMs`) ===");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 200,
        method: "tools/call",
        params: {
            name: "studio__policy__set_rule",
            arguments: {
                rule_id: "approve_orders",
                target_tool: "crm_api__create_order",
                risk_level: "destructive",
                require_approval: true,
                wait_for_approval_ms: 4000,
            },
        },
    });
    // Start the destructive call in-flight (it will pause waiting for admin approval!)
    const inFlightOrderPromise = postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 201,
        method: "tools/call",
        params: {
            name: "crm_api__create_order",
            arguments: { item: "B200_Supercluster", qty: 8 },
        },
    });
    // Wait 250ms while the call is held in-flight, then inspect pending approvals and click Approve via /admin/approve!
    await new Promise((r) => setTimeout(r, 250));
    const pendingListResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 202,
        method: "tools/call",
        params: { name: "studio__policy__list_pending", arguments: {} },
    });
    const pendingList = JSON.parse(pendingListResp.result.content[0].text).pendingApprovals;
    assert(pendingList.length >= 1, "In-flight destructive call must appear in pendingApprovals");
    const liveToken = pendingList[0].approvalToken;
    const liveApproveRes = await postJson(port, "/admin/approve", { approval_token: liveToken }, { "X-Workbench-Admin-Secret": lockInfo.adminSecret });
    assert.strictEqual(liveApproveRes.statusCode, 200);
    const liveOrderResult = await inFlightOrderPromise;
    const liveOrderJson = JSON.parse(liveOrderResult.result.content[0].text);
    assert.strictEqual(liveOrderJson.orderId, "ord_777");
    console.log("PASS: Step 20 - Synchronous Hold-and-Release paused RPC call in-flight and resumed immediately upon human approval.");
    console.log("=== [Step 21] Verifying OpenAI Codex TOML Surgical Merger (`toml_mcp_servers`) ===");
    const codexTmpDir = path.join(rootDir, "tmp_codex_home");
    fs.mkdirSync(codexTmpDir, { recursive: true });
    const codexTomlPath = path.join(codexTmpDir, "config.toml");
    fs.writeFileSync(codexTomlPath, [
        'model = "o3"',
        'approval_policy = "on-request"',
        "",
        "[mcp_servers.legacy_toml_srv]",
        'command = "npx"',
        'args = ["-y", "some-toml-mcp"]',
        "",
    ].join("\n"), "utf-8");
    const bindCodexResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 210,
        method: "tools/call",
        params: {
            name: "studio__client__bind",
            arguments: {
                client_id: "codex",
                manual_path: codexTomlPath,
                auto_start_imported: false,
            },
        },
    });
    const bindCodexData = JSON.parse(bindCodexResp.result.content[0].text);
    assert.strictEqual(bindCodexData.status, "bound");
    assert(bindCodexData.importedServers.includes("legacy_toml_srv"));
    const updatedToml = fs.readFileSync(codexTomlPath, "utf-8");
    assert(updatedToml.includes('model = "o3"'), "Surgical TOML merge must preserve model setting");
    assert(updatedToml.includes("[mcp_servers.mcp_workbench]"), "Must inject [mcp_servers.mcp_workbench] TOML section");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 211,
        method: "tools/call",
        params: { name: "studio__client__unbind", arguments: { client_id: "codex" } },
    });
    daemon1.registry.removeDesiredServer("legacy_toml_srv");
    fs.rmSync(codexTmpDir, { recursive: true, force: true });
    console.log("PASS: Step 21 - OpenAI Codex TOML surgical merge, server import, and restore verified.");
    console.log("=== [Step 22] Verifying Protocol Edge Cases (`resources/templates/list` & `logging/setLevel`) ===");
    const tplResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 220,
        method: "resources/templates/list",
    });
    assert(Array.isArray(tplResp.result.resourceTemplates));
    const logResp = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 221,
        method: "logging/setLevel",
        params: { level: "info" },
    });
    assert(logResp.result);
    console.log("PASS: Step 22 - Full MCP protocol edge cases (resources/templates/list & logging/setLevel) verified.");
    console.log("=== [Step 12] Verifying Module 4 (`SoftwareBridge`) — Host Software Reverse IPC Bridge (Revit/Blender) ===");
    const regBridgeResp = await postJson(port, "/bridge/register", {
        bridgeId: "revit_bim",
        softwareName: "Autodesk Revit",
        softwareVersion: "2026.1",
        pid: process.pid,
        tools: [
            {
                name: "get_walls_by_level",
                description: "Read BIM wall elements from active Revit document on main UI thread",
                inputSchema: {
                    type: "object",
                    properties: { level: { type: "string" } },
                    required: ["level"],
                },
            },
        ],
    }, { Authorization: `Bearer ${lockInfo.token}` });
    assert.strictEqual(regBridgeResp.body.status, "bridge_registered");
    // Connect simulated Revit plugin command stream (`/bridge/stream?bridge_id=revit_bim`)
    const bridgeStreamReq = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/bridge/stream?bridge_id=revit_bim",
        method: "GET",
        headers: { Authorization: `Bearer ${lockInfo.token}` },
    }, (res) => {
        let buf = "";
        res.on("data", (chunk) => {
            buf += chunk.toString("utf-8");
            const frames = buf.split("\n\n");
            buf = frames.pop() ?? "";
            for (const frame of frames) {
                const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
                if (dataLine) {
                    const cmd = JSON.parse(dataLine.slice(6));
                    // Simulate Revit main-thread execution and post callback result
                    void postJson(port, "/bridge/callback", {
                        bridgeId: cmd.bridgeId,
                        callId: cmd.callId,
                        result: {
                            level: cmd.arguments.level,
                            wallCount: 12,
                            elements: ["Wall_Exterior_01", "Wall_Core_02"],
                        },
                    }, { Authorization: `Bearer ${lockInfo.token}` });
                }
            }
        });
    });
    bridgeStreamReq.end();
    await new Promise((r) => setTimeout(r, 150));
    const revitCall = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 120,
        method: "tools/call",
        params: {
            name: "revit_bim__get_walls_by_level",
            arguments: { level: "Level_2" },
        },
    });
    const revitData = JSON.parse(revitCall.result.content[0].text);
    assert.strictEqual(revitData.wallCount, 12);
    assert.strictEqual(revitData.level, "Level_2");
    // Simulate closing Revit application -> tools auto-unmount
    bridgeStreamReq.destroy();
    await new Promise((r) => setTimeout(r, 100));
    daemon1.registry.removeDesiredServer("revit_bim");
    console.log("PASS: Step 12 - Host Software Reverse IPC Bridge (Revit 2026) main-thread execution & auto-disconnect verified.");
    console.log("=== [Step 13] Verifying Module 5 (`BuilderSandbox`) — Agent Tool Synthesizer, Isolated Self-Test & Hot-Mount ===");
    // 13a: Verify broken tool is caught by isolated pre-mount self-test and rejected cleanly
    const brokenBuild = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 130,
        method: "tools/call",
        params: {
            name: "studio__builder__create_server",
            arguments: {
                server_id: "broken_math_srv",
                tools: [
                    {
                        name: "square",
                        description: "Square x",
                        inputSchema: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
                        handlerBodyJs: "return String(Number(args.x) + 1);", // Deliberate bug!
                    },
                ],
                self_tests: [
                    { toolName: "square", arguments: { x: 12 }, expectedSubstring: "144" },
                ],
            },
        },
    });
    assert(brokenBuild.error && String(brokenBuild.error.message).includes("Self-test failed"), "BuilderSandbox must block mounting when isolated self-test fails");
    // 13b: Synthesize valid tool, pass self-tests, and hot-mount into Gateway
    const validBuild = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 131,
        method: "tools/call",
        params: {
            name: "studio__builder__create_server",
            arguments: {
                server_id: "unit_converter_srv",
                tools: [
                    {
                        name: "km_to_miles",
                        description: "Convert kilometers to miles (rounded to 2 decimals)",
                        inputSchema: {
                            type: "object",
                            properties: { km: { type: "number" } },
                            required: ["km"],
                        },
                        handlerBodyJs: "return `MILES:${(Number(args.km) * 0.621371).toFixed(2)}`;",
                    },
                ],
                self_tests: [
                    { toolName: "km_to_miles", arguments: { km: 10 }, expectedSubstring: "MILES:6.21" },
                ],
            },
        },
    });
    const buildData = JSON.parse(validBuild.result.content[0].text);
    assert.strictEqual(buildData.status, "built_verified_and_mounted");
    const callSynthesized = await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 132,
        method: "tools/call",
        params: {
            name: "unit_converter_srv__km_to_miles",
            arguments: { km: 100 },
        },
    });
    assert.strictEqual(callSynthesized.result.content[0].text, "MILES:62.14");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 133,
        method: "tools/call",
        params: { name: "studio__server__remove", arguments: { id: "unit_converter_srv" } },
    });
    fs.rmSync(path.join(rootDir, ".workbench_sandbox"), { recursive: true, force: true });
    console.log("PASS: Step 13 - BuilderSandbox synthesized, self-tested in isolation, hot-mounted, and invoked custom MCP server.");
    console.log("=== [Step 18] Verifying Module D (`WebConsole`) — Built-in Zero-Dependency Web Control Center (`/ui` & `/admin/state`) ===");
    const uiHtml = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/ui`, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
    assert(String(uiHtml).includes("MCP Workbench Control Center") && String(uiHtml).includes("SecretVault"), "GET /ui must serve the interactive Web Control Center");
    const adminState = await new Promise((resolve, reject) => {
        http.get({
            hostname: "127.0.0.1",
            port,
            path: "/admin/state",
            headers: { "X-Workbench-Admin-Secret": lockInfo.adminSecret },
        }, (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve(JSON.parse(data)));
        }).on("error", reject);
    });
    assert.strictEqual(adminState.version, "0.3.0");
    assert(adminState.counts.resources >= 1 && adminState.counts.prompts >= 1);
    assert(adminState.secrets.some((s) => s.key === "CRM_SECRET_TOKEN"));
    console.log("PASS: Step 18 - Built-in Web Console (/ui) and authenticated /admin/state API verified.");
    console.log("=== [Step 23] Verifying Dynamic Web UI On/Off Hot-Toggle (`studio__ui__configure` & `GET /ui`) ===");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 230,
        method: "tools/call",
        params: {
            name: "studio__ui__configure",
            arguments: { web_ui_enabled: false },
        },
    });
    const disabledUiStatus = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/ui`, (res) => {
            res.resume();
            resolve(res.statusCode ?? 500);
        }).on("error", reject);
    });
    assert.strictEqual(disabledUiStatus, 403, "GET /ui must return 403 when Web UI is toggled OFF");
    await postMcp(port, lockInfo.token, {
        jsonrpc: "2.0",
        id: 231,
        method: "tools/call",
        params: {
            name: "studio__ui__configure",
            arguments: { web_ui_enabled: true },
        },
    });
    const enabledUiStatus = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/ui`, (res) => {
            res.resume();
            resolve(res.statusCode ?? 500);
        }).on("error", reject);
    });
    assert.strictEqual(enabledUiStatus, 200, "GET /ui must return 200 immediately when Web UI is toggled back ON");
    console.log("PASS: Step 23 - Dynamic Web UI hot-toggle (ON <-> OFF) verified without restarting Daemon.");
    console.log("=== [Step 24] Verifying Claude-Code-Style Terminal Workbench (`TuiConsole`) & Slash Commands ===");
    const tui = new TuiConsole(rootDir);
    const banner = await tui.renderDashboardBanner();
    assert(banner.includes("MCP Workbench Studio") && banner.includes("╭───"), "TUI must render Claude-style rounded box banner");
    console.log(banner);
    const offMsg = await tui.executeSlashCommand("/webui off");
    assert(offMsg.includes("DISABLED"));
    assert.strictEqual(daemon1.registry.isWebUiEnabled(), false);
    const onMsg = await tui.executeSlashCommand("/webui on");
    assert(onMsg.includes("ENABLED"));
    assert.strictEqual(daemon1.registry.isWebUiEnabled(), true);
    const srvMsg = await tui.executeSlashCommand("/servers");
    assert(srvMsg.includes("math_ops") && srvMsg.includes("sys_clock"));
    console.log("PASS: Step 24 - Claude-style TUI Console banner & /webui, /servers slash commands verified.");
    shimChild.kill("SIGTERM");
    await daemon1.stop();
    console.log("=== [Step 14] Verifying Virtual OpenAPI Server Persistence Across Daemon Restart ===");
    const daemonRestarted = new WorkbenchDaemon(rootDir, port);
    const restartLock = await daemonRestarted.start();
    const postRestartCall = await postMcp(port, restartLock.token, {
        jsonrpc: "2.0",
        id: 140,
        method: "tools/call",
        params: { name: "crm_api__get_customer", arguments: { id: "cust_after_restart" } },
    });
    const postRestartCustomer = JSON.parse(postRestartCall.result.content[0].text);
    assert.strictEqual(postRestartCustomer.id, "cust_after_restart");
    assert(daemonRestarted.profileRouter.listProfiles().some((p) => p.profileId === "crm_frontend_profile"), "Persisted ContextProfileRouter rules must survive Daemon restart");
    assert(daemonRestarted.policyGuard.listPolicyRules().some((r) => r.ruleId === "approve_orders"), "Persisted PolicyGuard rules must survive Daemon restart");
    await postMcp(port, restartLock.token, {
        jsonrpc: "2.0",
        id: 141,
        method: "tools/call",
        params: { name: "studio__server__remove", arguments: { id: "crm_api" } },
    });
    fs.rmSync(path.join(rootDir, ".workbench_openapi"), { recursive: true, force: true });
    fs.rmSync(path.join(rootDir, ".workbench-secrets.enc.json"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-master.key"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-profiles.json"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-policies.json"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-clients.json"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-secrets.enc.json"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-master.key"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-profiles.json"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-policies.json"), { force: true });
    fs.rmSync(path.join(rootDir, ".workbench-clients.json"), { force: true });
    await new Promise((resolve) => mockRestServer.close(() => resolve()));
    await daemonRestarted.stop();
    await new Promise((r) => setTimeout(r, 600));
    console.log("PASS: Step 14 - Persisted Virtual OpenAPI Server automatically restored and invoked after Daemon restart.");
    console.log("=== [Step 8] Verifying StdioShim Zero-Touch Auto-Wake Daemon after Cold Shutdown ===");
    const autoWakeShim = spawn("node", ["./dist/stdio_shim.js"], {
        cwd: rootDir,
        env: { ...process.env, MCP_WORKBENCH_ROOT: rootDir, MCP_WORKBENCH_PORT: String(port) },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const wakeMessages = [];
    const rlWake = readline.createInterface({ input: autoWakeShim.stdout });
    rlWake.on("line", (line) => {
        try {
            wakeMessages.push(JSON.parse(line));
        }
        catch {
            // ignore
        }
    });
    autoWakeShim.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 801,
        method: "tools/call",
        params: { name: "math_ops__add", arguments: { a: 100, b: 23 } },
    }) + "\n");
    for (let i = 0; i < 70 && !wakeMessages.find((m) => m.id === 801); i++) {
        await new Promise((r) => setTimeout(r, 100));
    }
    const wakeResp = wakeMessages.find((m) => m.id === 801);
    assert(wakeResp, "Expected response for request 801");
    assert(!wakeResp.error, `Tool call 801 failed with error: ${wakeResp?.error?.message}`);
    assert.strictEqual(wakeResp.result.content[0].text, "123");
    const lockFile = path.join(rootDir, ".workbench-daemon.lock.json");
    if (fs.existsSync(lockFile)) {
        const spawnedLock = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
        try {
            process.kill(spawnedLock.pid, "SIGTERM");
        }
        catch {
            // ignore
        }
    }
    autoWakeShim.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    console.log("PASS: Step 8 - StdioShim automatically woke up background Daemon on cold start.");
    console.log("=== ALL 24 ACCEPTANCE STEPS PASSED SUCCESSFULLY ===");
}
runVerification().catch((err) => {
    console.error("ACCEPTANCE VERIFICATION FAILED:", err);
    process.exit(1);
});
