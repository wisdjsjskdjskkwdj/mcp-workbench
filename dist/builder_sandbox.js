import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import readline from "node:readline";
import { assertSafeIdentifier } from "./types.js";
/**
 * Module 5 (v0.0.5): Agent Tool Hot-Generator & Self-Testing Sandbox (`BuilderSandbox`).
 * Allows an Agent to synthesize a brand-new MCP Server with custom JavaScript tool handlers,
 * automatically runs mandatory self-tests in an isolated trial process before touching the live Gateway,
 * and hot-mounts the verified server into `WorkbenchRegistry` and `McpAggregator`.
 */
export class BuilderSandbox {
    registry;
    aggregator;
    sandboxDir;
    constructor(registry, aggregator, rootDir) {
        this.registry = registry;
        this.aggregator = aggregator;
        this.sandboxDir = path.join(path.resolve(rootDir), ".workbench_sandbox");
    }
    generateMcpServerSource(serverId, tools) {
        const toolMetaList = tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }));
        const handlerCases = tools
            .map((t) => `      case ${JSON.stringify(t.name)}: {
        const fn = new AsyncFunction("args", ${JSON.stringify(t.handlerBodyJs)});
        const out = await fn(args ?? {});
        return typeof out === "string" ? out : JSON.stringify(out);
      }`)
            .join("\n");
        return `import readline from "node:readline";

// Safely divert user console.log/info/debug to stderr so stdout is strictly clean JSON-RPC
console.log = (...args) => process.stderr.write(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ") + "\\n");
console.info = console.log;
console.debug = console.log;

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const TOOLS = ${JSON.stringify(toolMetaList, null, 2)};

async function dispatchTool(name, args) {
  switch (name) {
${handlerCases}
    default:
      throw new Error("Unknown sandbox tool: " + name);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (req.id === undefined || req.id === null) return;

  try {
    if (req.method === "initialize") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: ${JSON.stringify(serverId)}, version: "1.0.0-sandbox" }
        }
      }) + "\\n");
    } else if (req.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { tools: TOOLS }
      }) + "\\n");
    } else if (req.method === "tools/call") {
      const { name, arguments: args } = req.params ?? {};
      const textOut = await dispatchTool(name, args);
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: textOut }] }
      }) + "\\n");
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) }
    }) + "\\n");
  }
});
`;
    }
    /**
     * Spawns the generated script in an isolated trial child process and verifies all `testCases`
     * before mounting into the live Gateway.
     */
    async runIsolatedSelfTests(scriptPath, testCases) {
        const child = spawn(process.execPath, [scriptPath], {
            cwd: this.sandboxDir,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        });
        const pending = new Map();
        const rl = readline.createInterface({ input: child.stdout });
        rl.on("line", (line) => {
            try {
                const msg = JSON.parse(line);
                if (msg.id && pending.has(msg.id)) {
                    const p = pending.get(msg.id);
                    pending.delete(msg.id);
                    if (msg.error)
                        p.reject(new Error(msg.error.message));
                    else
                        p.resolve(msg.result);
                }
            }
            catch {
                // ignore
            }
        });
        const sendRpc = (id, method, params) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`Sandbox self-test timed out on ${method}`));
            }, 3000);
            pending.set(id, {
                resolve: (val) => {
                    clearTimeout(timer);
                    resolve(val);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
        const results = [];
        try {
            await sendRpc(1, "initialize", {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "sandbox-self-tester", version: "0.0.5" },
            });
            let seq = 2;
            for (const tc of testCases) {
                const res = await sendRpc(seq++, "tools/call", {
                    name: tc.toolName,
                    arguments: tc.arguments,
                });
                const actualText = String(res?.content?.[0]?.text ?? "");
                if (!actualText.includes(tc.expectedSubstring)) {
                    throw new Error(`Self-test failed for '${tc.toolName}': expected output to contain '${tc.expectedSubstring}', got '${actualText}'.`);
                }
                results.push({
                    toolName: tc.toolName,
                    passed: true,
                    actualOutput: actualText,
                });
            }
            return results;
        }
        finally {
            if (child.pid) {
                if (process.platform === "win32") {
                    try {
                        execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
                    }
                    catch { }
                }
                else {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch { }
                }
            }
        }
    }
    async buildVerifyAndMountServer(serverId, tools, testCases) {
        assertSafeIdentifier(serverId, "serverId");
        if (!tools || tools.length === 0) {
            throw new Error("BuilderSandbox requires at least one tool.");
        }
        for (const tool of tools) {
            assertSafeIdentifier(tool.name, "tool.name");
        }
        if (testCases.length === 0) {
            throw new Error("BuilderSandbox requires at least one self_test_case to verify safety before mounting.");
        }
        fs.mkdirSync(this.sandboxDir, { recursive: true });
        const resolvedDir = path.resolve(this.sandboxDir);
        const scriptPath = path.resolve(this.sandboxDir, `${serverId}.mjs`);
        if (!scriptPath.startsWith(resolvedDir)) {
            throw new Error(`PATH_TRAVERSAL_DETECTED: '${serverId}' escapes sandbox directory.`);
        }
        const sourceCode = this.generateMcpServerSource(serverId, tools);
        fs.writeFileSync(scriptPath, sourceCode, "utf-8");
        try {
            const testResults = await this.runIsolatedSelfTests(scriptPath, testCases);
            const desiredConfig = {
                id: serverId,
                serverType: "builder_sandbox",
                command: process.execPath,
                args: [scriptPath],
                enabled: true,
                autoRestart: true,
            };
            this.registry.upsertDesiredServer(desiredConfig);
            const mountedTools = await this.aggregator.connectAndDiscoverServer(desiredConfig);
            return {
                status: "built_verified_and_mounted",
                serverId,
                scriptPath,
                selfTests: testResults,
                mountedTools: mountedTools.map((t) => ({
                    toolId: t.toolId,
                    exposedName: t.exposedName,
                    description: t.description,
                })),
            };
        }
        catch (err) {
            if (fs.existsSync(scriptPath)) {
                fs.unlinkSync(scriptPath);
            }
            throw err;
        }
    }
}
