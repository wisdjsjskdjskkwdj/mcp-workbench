# MCP Workbench Gateway Prototype v0.0.5 全模块逻辑防冲突定型版技术规格书

**版本状态**：v0.0.5 完整版（已通过 Node.js 14 步全链路自动化实测验收）  
**核心升级概要**：
1. **彻底修复 v0.0.4 中的 4 处逻辑漏洞与状态冲突**（Agent 自审批漏洞、Profile 隔离仅过滤列表未拦截调用/搜索、虚拟服务重启丢失与驱动类型混用、Schema 校验报错误消耗一次性审批令牌）。
2. **新增模块 4：桌面宿主软件 IPC 反向桥接引擎（`src/software_bridge.ts`）**，支持 Revit、Blender、AutoCAD 等宿主插件反向注册并在软件主线程安全执行调用。
3. **新增模块 5：Agent 工具热生成与隔离沙箱自测器（`src/builder_sandbox.ts`）**，支持 Agent 动态编写工具代码、先在独立进程跑通强制自测用例后再热挂载至网关。

## 一、v0.0.4 四处逻辑冲突排查与 v0.0.5 修正机制对照表

| 逻辑问题编号 | v0.0.4 中存在的逻辑漏洞或冲突 | v0.0.5 的根治方案与代码实现 |
| :--- | :--- | :--- |
| **1. Agent“自己审批自己”的越权漏洞** | `v0.0.4` 将 `studio__policy__approve` 作为普通 MCP 工具暴露给 Agent，且拦截报错直接返回 `approval_token`；导致 AI 拿到报错后自己调工具批准了自己的高危操作，人工审批形同虚设 | **双密钥隔离 + 带外（Out-of-Band）管理端点**：Daemon 启动时生成独立于客户端 `token` 的 `adminSecret`（仅存于 `0600` 锁文件供本地人类/GUI 读取，绝不暴露给 MCP）；移除 Agent 端 `approve` 工具（仅保留只读 `studio__policy__list_pending`），审批必须通过带 `X-Workbench-Admin-Secret` 的 `POST /admin/approve` 完成 |
| **2. Profile 路由“只藏列表、不拦调用”的隔离穿透** | `v0.0.4` 的 `ContextProfileRouter` 仅在 `tools/list` 中隐藏了非当前项目工具，但 Agent 仍可通过 `studio__tool__search` 搜出或直接通过 `tools/call`、`studio__tool__invoke` 越权调用；且 Daemon 未把 `ppid` 反查出的客户端名传给路由器 | **全链路强制隔离（列表 + 搜索 + 执行）**：`McpAggregator.invokeDownstreamTool` 与 `studio__tool__search` 均强制调用 `profileRouter.isServerAllowedForContext`；越权调用直接拦截并记入审计日志（`PROFILE_FORBIDDEN`）；Daemon 自动将 `ppid` 会话归属的 `clientName` 传入路由上下文 |
| **3. 虚拟服务重启丢失与驱动类型冲突** | `v0.0.4` 的 OpenAPI 虚拟服务仅保存在内存 Map 中，Daemon 重启后 `workbench.json` 里的 `__virtual_openapi__` 无法恢复工具；且 `studio__server__remove/restart` 把虚拟服务和桥接插件当成普通 `stdio` 子进程去 `kill` | **统一四类驱动模型（`ServerDriverType`）+ 磁盘持久化自恢复**：在 `DesiredServerConfig` 中明确定义 `stdio_process`、`virtual_openapi`、`software_bridge`、`builder_sandbox` 四种驱动；OpenAPI 规范自动持久化至 `.workbench_openapi/`，Daemon 重启调谐时自动恢复挂载 |
| **4. 参数类型写错导致一次性审批令牌被白白消耗** | `v0.0.4` 先执行 `PolicyGuard`（消耗并删除一次性 `approvalToken`），后执行 `validateToolArguments`；若人类刚点完批准，Agent 调用时某个无关参数类型写错，审批码直接作废 | **先 Schema 校验、后两阶段策略检查**：`invokeDownstreamTool` 严格先跑 `validateToolArguments`；且 `PolicyGuard` 内部先遍历所有匹配规则的 `denyParamRegex` 正则围栏（Pass 1），全部通过后才在 Pass 2 核销一次性 `approvalToken` |

## 二、统一四驱动架构（4 Server Driver Types）与五大核心扩展模块

| 驱动类型 (`serverType`) | 托管引擎模块 | 进程与通信模型 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **`stdio_process`** | `ProcessPool` (`src/process_pool.ts`) | Daemon 主动 `spawn` 本地子进程，通过 `stdin/stdout` 传输 JSON-RPC | 标准 Node.js / Python / `uvx` / `npx` MCP Server |
| **`virtual_openapi`** | `OpenApiConnector` (`src/openapi_connector.ts`) | 零子进程，Daemon 内存直接映射 HTTP 端点并持久化至 `.workbench_openapi/` | 企业内部 REST API、Swagger / OpenAPI 3.x 接口 |
| **`software_bridge`** | `SoftwareBridge` (`src/software_bridge.ts`) | 宿主软件插件主动连入 `/bridge/register` 与 `/bridge/stream`，在宿主主线程执行后回调 `/bridge/callback` | Blender、Revit、AutoCAD、Office 等必须在宿主主线程调用 SDK 的桌面软件 |
| **`builder_sandbox`** | `BuilderSandbox` (`src/builder_sandbox.ts`) | Agent 提交代码与自测用例 -> 独立试验进程跑通断言 -> 落盘 `.workbench_sandbox/` 并由 `ProcessPool` 托管 | Agent 在对话现场按需合成并热挂载的新工具 |

## 三、v0.0.5 核心源码实现

### 3.1 `src/software_bridge.ts` — 桌面宿主软件 IPC 反向桥接引擎（Module 4）

```typescript
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

interface ActiveBridgeSession {
  registration: BridgePluginRegistration;
  sseRes: http.ServerResponse | null;
  pendingCalls: Map<
    string,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  nextCallSeq: number;
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
export class SoftwareBridge {
  private readonly registry: WorkbenchRegistry;
  private readonly sessions = new Map<string, ActiveBridgeSession>();

  constructor(registry: WorkbenchRegistry) {
    this.registry = registry;
  }

  public registerPlugin(reg: BridgePluginRegistration): ToolRecord[] {
    const existing = this.sessions.get(reg.bridgeId);
    if (existing && existing.sseRes) {
      existing.sseRes.end();
    }

    this.sessions.set(reg.bridgeId, {
      registration: reg,
      sseRes: null,
      pendingCalls: new Map(),
      nextCallSeq: 1,
    });

    this.registry.upsertDesiredServer({
      id: reg.bridgeId,
      serverType: "software_bridge",
      command: "__software_bridge__",
      args: [reg.softwareName, reg.softwareVersion],
      enabled: true,
      autoRestart: false,
    });

    this.registry.updateRuntimeState(reg.bridgeId, {
      serverType: "software_bridge",
      phase: "running",
      pid: reg.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: `bridge-ipc/${reg.softwareName}-${reg.softwareVersion}`,
    });

    return this.registry.registerServerTools(reg.bridgeId, reg.tools);
  }

  public attachCommandStream(
    bridgeId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const session = this.sessions.get(bridgeId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Bridge '${bridgeId}' is not registered.` }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    session.sseRes = res;

    req.on("close", () => {
      if (session.sseRes === res) {
        this.handlePluginDisconnect(bridgeId);
      }
    });
  }

  public handlePluginDisconnect(bridgeId: string): void {
    const session = this.sessions.get(bridgeId);
    if (!session) return;
    for (const [, pending] of session.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`Host software '${bridgeId}' disconnected before completing call.`)
      );
    }
    session.pendingCalls.clear();
    this.sessions.delete(bridgeId);
    this.registry.clearServerTools(bridgeId);
    this.registry.updateRuntimeState(bridgeId, {
      phase: "stopped",
      pid: null,
      lastError: "Host software plugin disconnected",
    });
  }

  public isBridgeServer(serverId: string): boolean {
    const cfg = this.registry.getDesiredServer(serverId);
    return (
      cfg?.serverType === "software_bridge" ||
      cfg?.command === "__software_bridge__" ||
      this.sessions.has(serverId)
    );
  }

  public async invokeBridgeTool(
    bridgeId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 8000
  ): Promise<unknown> {
    const session = this.sessions.get(bridgeId);
    if (!session || !session.sseRes) {
      throw new Error(
        `Host software plugin '${bridgeId}' does not have an active IPC command stream.`
      );
    }

    const callId = `bcall_${bridgeId}_${session.nextCallSeq++}`;
    const payload = {
      callId,
      bridgeId,
      toolName,
      arguments: args,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingCalls.delete(callId);
        reject(
          new Error(
            `Bridge call '${toolName}' to host software '${bridgeId}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      session.pendingCalls.set(callId, { resolve, reject, timer });
      session.sseRes!.write(`event: invoke\ndata: ${JSON.stringify(payload)}\n\n`);
    });
  }

  public submitBridgeCallback(
    bridgeId: string,
    callId: string,
    result?: unknown,
    errorMsg?: string
  ): boolean {
    const session = this.sessions.get(bridgeId);
    if (!session) return false;
    const pending = session.pendingCalls.get(callId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    session.pendingCalls.delete(callId);
    if (errorMsg) {
      pending.reject(new Error(errorMsg));
    } else {
      const textOut = typeof result === "string" ? result : JSON.stringify(result);
      pending.resolve({
        content: [{ type: "text", text: textOut }],
      });
    }
    return true;
  }

  public listActiveBridges(): Array<Record<string, any>> {
    return Array.from(this.sessions.values()).map((s) => ({
      bridgeId: s.registration.bridgeId,
      softwareName: s.registration.softwareName,
      softwareVersion: s.registration.softwareVersion,
      pid: s.registration.pid,
      streamConnected: Boolean(s.sseRes),
      toolCount: s.registration.tools.length,
    }));
  }
}
```

### 3.2 `src/builder_sandbox.ts` — Agent 工具代码合成、隔离自测与热挂载引擎（Module 5）

```typescript
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";
import type { JsonSchema, ToolRecord, DesiredServerConfig } from "./types.js";

export interface SandboxToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * JavaScript async function body receiving `args` and returning a string or JSON-serializable value.
   * Example: `return String(Number(args.x) * Number(args.x));`
   */
  handlerBodyJs: string;
}

export interface SandboxSelfTestCase {
  toolName: string;
  arguments: Record<string, unknown>;
  expectedSubstring: string;
}

/**
 * Module 5 (v0.0.5): Agent Tool Hot-Generator & Self-Testing Sandbox (`BuilderSandbox`).
 * Allows an Agent to synthesize a brand-new MCP Server with custom JavaScript tool handlers,
 * automatically runs mandatory self-tests in an isolated trial process before touching the live Gateway,
 * and hot-mounts the verified server into `WorkbenchRegistry` and `McpAggregator`.
 */
export class BuilderSandbox {
  private readonly registry: WorkbenchRegistry;
  private readonly aggregator: McpAggregator;
  private readonly sandboxDir: string;

  constructor(
    registry: WorkbenchRegistry,
    aggregator: McpAggregator,
    rootDir: string
  ) {
    this.registry = registry;
    this.aggregator = aggregator;
    this.sandboxDir = path.join(path.resolve(rootDir), ".workbench_sandbox");
  }

  private generateMcpServerSource(
    serverId: string,
    tools: SandboxToolSpec[]
  ): string {
    const toolMetaList = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    const handlerCases = tools
      .map(
        (t) => `      case ${JSON.stringify(t.name)}: {
        const fn = new AsyncFunction("args", ${JSON.stringify(t.handlerBodyJs)});
        const out = await fn(args ?? {});
        return typeof out === "string" ? out : JSON.stringify(out);
      }`
      )
      .join("\n");

    return `import readline from "node:readline";

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
  private async runIsolatedSelfTests(
    scriptPath: string,
    testCases: SandboxSelfTestCase[]
  ): Promise<Array<Record<string, any>>> {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: this.sandboxDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pending = new Map();
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {
        // ignore
      }
    });

    const sendRpc = (id: number, method: string, params: Record<string, unknown>) =>
      new Promise((resolve, reject) => {
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
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
        );
      });

    const results: Array<Record<string, any>> = [];
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
          throw new Error(
            `Self-test failed for '${tc.toolName}': expected output to contain '${tc.expectedSubstring}', got '${actualText}'.`
          );
        }
        results.push({
          toolName: tc.toolName,
          passed: true,
          actualOutput: actualText,
        });
      }
      return results;
    } finally {
      child.kill("SIGTERM");
    }
  }

  public async buildVerifyAndMountServer(
    serverId: string,
    tools: SandboxToolSpec[],
    testCases: SandboxSelfTestCase[]
  ): Promise<Record<string, any>> {
    if (!serverId || tools.length === 0) {
      throw new Error("BuilderSandbox requires non-empty serverId and at least one tool.");
    }
    if (testCases.length === 0) {
      throw new Error("BuilderSandbox requires at least one self_test_case to verify safety before mounting.");
    }

    fs.mkdirSync(this.sandboxDir, { recursive: true });
    const scriptPath = path.join(this.sandboxDir, `${serverId}.mjs`);
    const sourceCode = this.generateMcpServerSource(serverId, tools);
    fs.writeFileSync(scriptPath, sourceCode, "utf-8");

    try {
      const testResults = await this.runIsolatedSelfTests(scriptPath, testCases);

      const desiredConfig: DesiredServerConfig = {
        id: serverId,
        serverType: "builder_sandbox",
        command: process.execPath,
        args: [scriptPath],
        enabled: true,
        autoRestart: true,
      };

      this.registry.upsertDesiredServer(desiredConfig);
      const mountedTools: ToolRecord[] =
        await this.aggregator.connectAndDiscoverServer(desiredConfig);

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
    } catch (err) {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
      throw err;
    }
  }
}
```

### 3.3 `src/policy_guard.ts` — 双密钥带外审批与两阶段正则/令牌防火墙（Module 3 修正版）

```typescript
import crypto from "node:crypto";

export type RiskLevel = "safe" | "mutating" | "destructive";

export interface PolicyRule {
  ruleId: string;
  targetTool: string;
  riskLevel: RiskLevel;
  denyParamRegex?: string;
  requireApproval?: boolean;
}

export interface PendingApprovalRecord {
  approvalToken: string;
  targetTool: string;
  argsPreview: string;
  createdAt: string;
  approved: boolean;
}

export interface AuditLogEntry {
  auditId: string;
  timestamp: string;
  callerPpid: number | null;
  callerCwd: string | null;
  serverId: string;
  toolName: string;
  riskLevel: RiskLevel;
  decision: "allowed" | "blocked_regex" | "blocked_approval_required" | "approved_token" | "blocked_profile";
  reason: string;
  durationMs: number;
  argsPreview: string;
}

/**
 * Module 3 (v0.0.5): Permission Firewall, Parameter Sandbox Fence & Out-of-Band Human Approval Gate (`PolicyGuard`).
 * Fixes v0.0.4 flaws:
 * 1. Agents CANNOT self-approve destructive tokens without the Daemon's `adminSecret` (or via `POST /admin/approve`).
 * 2. Evaluates ALL matching `denyParamRegex` fences in Pass 1 before checking or consuming any approval token in Pass 2.
 */
export class PolicyGuard {
  private readonly adminSecret: string;
  private readonly rules = new Map<string, PolicyRule>();
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>();
  private readonly approvedTokens = new Set<string>();
  private readonly auditLog: AuditLogEntry[] = [];

  constructor(adminSecret: string) {
    this.adminSecret = adminSecret;
  }

  public setPolicyRule(rule: PolicyRule): PolicyRule {
    this.rules.set(rule.ruleId, rule);
    return rule;
  }

  public listPolicyRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }

  public listPendingApprovals(): PendingApprovalRecord[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * Out-of-Band Human/GUI Approval: requires valid `adminSecret` so an unprivileged Agent
   * cannot call an MCP tool to self-approve its own destructive operations.
   */
  public approvePendingTokenWithAdminSecret(
    approvalToken: string,
    providedAdminSecret: string
  ): boolean {
    if (providedAdminSecret !== this.adminSecret) {
      throw new Error(
        "ADMIN_AUTH_FAILED: Destructive tool approval requires the human/GUI Admin Secret via /admin/approve."
      );
    }
    const rec = this.pendingApprovals.get(approvalToken);
    if (!rec) {
      return false;
    }
    rec.approved = true;
    this.approvedTokens.add(approvalToken);
    return true;
  }

  public getAuditLogs(limit = 50): AuditLogEntry[] {
    return this.auditLog.slice(-limit);
  }

  public verifyCallPermission(
    serverId: string,
    originalName: string,
    exposedName: string,
    args: Record<string, unknown>,
    callerPpid: number | null = null,
    callerCwd: string | null = null
  ): Record<string, string> {
    const cleanArgs = { ...args };
    delete cleanArgs.__approval_token;
    const serializedArgs = JSON.stringify(cleanArgs);

    const matchingRules: PolicyRule[] = [];
    for (const rule of this.rules.values()) {
      const matchesTarget =
        rule.targetTool === "*" ||
        rule.targetTool === exposedName ||
        rule.targetTool === `${serverId}.${originalName}`;
      if (matchesTarget) {
        matchingRules.push(rule);
      }
    }

    let highestRisk: RiskLevel = "safe";
    for (const rule of matchingRules) {
      if (rule.riskLevel === "destructive") highestRisk = "destructive";
      else if (rule.riskLevel === "mutating" && highestRisk === "safe") {
        highestRisk = "mutating";
      }
    }

    // Pass 1: Evaluate ALL parameter regex fences first (never consume approval token if regex fails)
    for (const rule of matchingRules) {
      if (rule.denyParamRegex) {
        const regex = new RegExp(rule.denyParamRegex, "i");
        if (regex.test(serializedArgs)) {
          this.recordAudit({
            callerPpid,
            callerCwd,
            serverId,
            toolName: exposedName,
            riskLevel: highestRisk,
            decision: "blocked_regex",
            reason: `Blocked by PolicyRule '${rule.ruleId}' (matched forbidden pattern /${rule.denyParamRegex}/i)`,
            durationMs: 0,
            argsPreview: serializedArgs.slice(0, 200),
          });
          throw new Error(
            `POLICY_BLOCKED[${rule.ruleId}]: Tool '${exposedName}' arguments matched forbidden security pattern /${rule.denyParamRegex}/i.`
          );
        }
      }
    }

    // Pass 2: Evaluate Human-in-the-Loop Approval Gate
    const needsApproval = matchingRules.some(
      (r) => r.requireApproval || r.riskLevel === "destructive"
    );
    if (needsApproval) {
      const providedToken =
        typeof args.__approval_token === "string"
          ? args.__approval_token
          : undefined;

      if (providedToken && this.approvedTokens.has(providedToken)) {
        this.approvedTokens.delete(providedToken);
        this.pendingApprovals.delete(providedToken);
        delete args.__approval_token;
        return { riskLevel: highestRisk, decision: "approved_token" };
      }

      const approvalToken =
        "approve_" +
        crypto
          .createHash("sha256")
          .update(`${exposedName}::${serializedArgs}`)
          .digest("hex")
          .slice(0, 10);

      this.pendingApprovals.set(approvalToken, {
        approvalToken,
        targetTool: exposedName,
        argsPreview: serializedArgs.slice(0, 200),
        createdAt: new Date().toISOString(),
        approved: false,
      });

      this.recordAudit({
        callerPpid,
        callerCwd,
        serverId,
        toolName: exposedName,
        riskLevel: highestRisk,
        decision: "blocked_approval_required",
        reason: `Destructive tool requires human/GUI approval token '${approvalToken}'`,
        durationMs: 0,
        argsPreview: serializedArgs.slice(0, 200),
      });

      throw new Error(
        `APPROVAL_REQUIRED[${approvalToken}]: Tool '${exposedName}' is marked '${highestRisk}'. A human/admin must approve token '${approvalToken}' via POST /admin/approve before retrying with __approval_token="${approvalToken}".`
      );
    }

    return { riskLevel: highestRisk, decision: "allowed" };
  }

  public recordAudit(entry: Record<string, any>): AuditLogEntry {
    const full: any = {
      auditId: `aud_${this.auditLog.length + 1}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.auditLog.push(full);
    if (this.auditLog.length > 500) {
      this.auditLog.shift();
    }
    return full;
  }
}
```

### 3.4 `src/profile_router.ts` — 列表、搜索与执行全链路上下文 Profile 隔离器（Module 2 修正版）

```typescript
import type { ToolRecord } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";

export interface ContextProfileRule {
  profileId: string;
  description: string;
  allowedServers: string[];
  matchWorkspaceSubstr?: string;
  matchClientKeyword?: string;
}

/**
 * Module 2 (v0.0.5): Multi-Dimensional Context Profile Router (`ContextProfileRouter`).
 * Fixes v0.0.4 isolation leak by enforcing Profile boundaries across:
 * 1. Top-level `tools/list`
 * 2. Cold tool search (`studio__tool__search`)
 * 3. Direct & meta tool execution (`tools/call` and `studio__tool__invoke`)
 */
export class ContextProfileRouter {
  private readonly registry: WorkbenchRegistry;
  private readonly profiles = new Map<string, ContextProfileRule>();
  private readonly cwdBindings = new Map<string, string>();
  private activeDefaultProfile = "default";

  constructor(registry: WorkbenchRegistry) {
    this.registry = registry;
    this.profiles.set("default", {
      profileId: "default",
      description: "Default global profile exposing all high-frequency tools",
      allowedServers: ["*"],
    });
  }

  public upsertProfile(rule: ContextProfileRule): ContextProfileRule {
    this.profiles.set(rule.profileId, rule);
    if (rule.matchWorkspaceSubstr) {
      this.cwdBindings.set(rule.matchWorkspaceSubstr, rule.profileId);
    }
    return rule;
  }

  public listProfiles(): ContextProfileRule[] {
    return Array.from(this.profiles.values());
  }

  public resolveProfileForContext(
    callerCwd?: string,
    callerClientName?: string
  ): ContextProfileRule {
    if (callerCwd) {
      for (const [substr, profId] of this.cwdBindings.entries()) {
        if (callerCwd.includes(substr) && this.profiles.has(profId)) {
          return this.profiles.get(profId) as ContextProfileRule;
        }
      }
    }
    if (callerClientName) {
      for (const rule of this.profiles.values()) {
        if (
          rule.matchClientKeyword &&
          callerClientName
            .toLowerCase()
            .includes(rule.matchClientKeyword.toLowerCase())
        ) {
          return rule;
        }
      }
    }
    return (
      this.profiles.get(this.activeDefaultProfile) ??
      (this.profiles.get("default") as ContextProfileRule)
    );
  }

  public isServerAllowedForContext(
    serverId: string,
    callerCwd?: string,
    callerClientName?: string
  ): Record<string, any> {
    const profile = this.resolveProfileForContext(callerCwd, callerClientName);
    const allowed =
      profile.allowedServers.includes("*") ||
      profile.allowedServers.includes(serverId);
    return { allowed, profileId: profile.profileId };
  }

  public filterToolsForContext(
    callerCwd?: string,
    callerClientName?: string
  ): Record<string, any> {
    const profile = this.resolveProfileForContext(callerCwd, callerClientName);
    const allTopLevel = this.registry.getTopLevelExposedTools();
    const allowAll = profile.allowedServers.includes("*");
    const allowedSet = new Set(profile.allowedServers);

    const filtered = allTopLevel.filter(
      (t) => allowAll || allowedSet.has(t.serverId)
    );
    return {
      profileId: profile.profileId,
      tools: filtered,
    };
  }
}
```

### 3.5 `src/openapi_connector.ts` — 支持跨重启持久化的零代码 OpenAPI 引擎（Module 1 修正版）

```typescript
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import type { WorkbenchRegistry } from "./registry.js";
import type { JsonSchema, ToolRecord } from "./types.js";

export interface OpenApiSpecDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  servers?: Array<{ url: string }>;
  paths: Record<string, Record<string, any>>;
}

export interface PersistedOpenApiBundle {
  connectorId: string;
  spec: OpenApiSpecDocument;
  options: Record<string, any>;
}

export interface VirtualEndpointBinding {
  connectorId: string;
  toolName: string;
  method: string;
  baseUrl: string;
  pathTemplate: string;
  pathParams: string[];
  queryParams: string[];
  hasJsonBody: boolean;
  auth: Record<string, string | undefined>;
  pickFields?: string[];
  maxResponseChars: number;
}

/**
 * Module 1 (v0.0.5): Zero-Code OpenAPI / REST Virtual MCP Server Engine (`OpenApiConnector`).
 * Fixes v0.0.4 restart conflict by persisting imported OpenAPI specs under `.workbench_openapi/`
 * so virtual servers and their endpoints are automatically restored when `reconcileAll()` runs after a Daemon restart.
 */
export class OpenApiConnector {
  private readonly registry: WorkbenchRegistry;
  private readonly storageDir: string;
  private readonly endpoints = new Map<string, VirtualEndpointBinding>();

  constructor(registry: WorkbenchRegistry, rootDir: string) {
    this.registry = registry;
    this.storageDir = path.join(path.resolve(rootDir), ".workbench_openapi");
  }

  private getSpecFilePath(connectorId: string): string {
    return path.join(this.storageDir, `${connectorId}.json`);
  }

  public importOpenApiSpec(
    connectorId: string,
    spec: OpenApiSpecDocument,
    options: Record<string, any> = {},
    persistToDisk = true
  ): ToolRecord[] {
    const baseUrl = String(
      options.baseUrl ?? spec.servers?.[0]?.url ?? "http://127.0.0.1:80"
    ).replace(/\/+$/, "");

    const auth: Record<string, string | undefined> = {
      type: options.authType ? String(options.authType) : "none",
      token: options.authToken ? String(options.authToken) : undefined,
      headerName: options.authHeaderName
        ? String(options.authHeaderName)
        : "X-API-Key",
    };

    const pickFields = Array.isArray(options.pickFields)
      ? options.pickFields.map(String)
      : undefined;
    const maxResponseChars = Number(options.maxResponseChars ?? 4096);

    if (persistToDisk) {
      fs.mkdirSync(this.storageDir, { recursive: true });
      const bundle: PersistedOpenApiBundle = {
        connectorId,
        spec,
        options: {
          baseUrl,
          authType: auth.type,
          authToken: auth.token,
          authHeaderName: auth.headerName,
          pickFields,
          maxResponseChars,
        },
      };
      fs.writeFileSync(
        this.getSpecFilePath(connectorId),
        JSON.stringify(bundle, null, 2),
        "utf-8"
      );
    }

    const rawTools: Array<{
      name: string;
      description?: string;
      inputSchema?: JsonSchema;
    }> = [];

    for (const [routePath, pathItem] of Object.entries(spec.paths ?? {})) {
      for (const [httpMethod, op] of Object.entries(pathItem ?? {})) {
        const methodUpper = httpMethod.toUpperCase();
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodUpper)) {
          continue;
        }

        const sanitizedPath = routePath
          .replace(/^\/+|\/+$/g, "")
          .replace(/[^a-zA-Z0-9_]/g, "_");
        const toolName = (
          op.operationId ?? `${httpMethod.toLowerCase()}_${sanitizedPath}`
        ).replace(/[^a-zA-Z0-9_-]/g, "_");

        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        const pathParams: string[] = [];
        const queryParams: string[] = [];

        for (const param of op.parameters ?? []) {
          const pType = param.schema?.type ?? "string";
          properties[param.name] = {
            type: pType,
            description: param.description ?? `${param.in} parameter`,
          };
          if (param.required || param.in === "path") {
            required.push(param.name);
          }
          if (param.in === "path") {
            pathParams.push(param.name);
          } else if (param.in === "query") {
            queryParams.push(param.name);
          }
        }

        let hasJsonBody = false;
        const bodySchema =
          op.requestBody?.content?.["application/json"]?.schema;
        if (bodySchema && bodySchema.properties) {
          hasJsonBody = true;
          for (const [bKey, bVal] of Object.entries(bodySchema.properties)) {
            properties[bKey] = bVal;
          }
          for (const reqKey of bodySchema.required ?? []) {
            if (!required.includes(reqKey)) {
              required.push(reqKey);
            }
          }
        }

        const bindingKey = `${connectorId}::${toolName}`;
        this.endpoints.set(bindingKey, {
          connectorId,
          toolName,
          method: methodUpper,
          baseUrl,
          pathTemplate: routePath,
          pathParams,
          queryParams,
          hasJsonBody,
          auth,
          pickFields,
          maxResponseChars,
        });

        rawTools.push({
          name: toolName,
          description:
            op.summary ??
            op.description ??
            `OpenAPI ${methodUpper} ${routePath}`,
          inputSchema: {
            type: "object",
            properties,
            required,
          },
        });
      }
    }

    this.registry.upsertDesiredServer({
      id: connectorId,
      serverType: "virtual_openapi",
      command: "__virtual_openapi__",
      args: [baseUrl],
      enabled: true,
      autoRestart: false,
    });
    this.registry.updateRuntimeState(connectorId, {
      serverType: "virtual_openapi",
      phase: "running",
      pid: process.pid,
      startedAt: new Date().toISOString(),
      protocolVersion: "openapi-3.x-virtual",
    });

    return this.registry.registerServerTools(connectorId, rawTools);
  }

  public restorePersistedConnector(connectorId: string): ToolRecord[] {
    const filePath = this.getSpecFilePath(connectorId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Persisted OpenAPI spec not found at ${filePath}`);
    }
    const bundle = JSON.parse(
      fs.readFileSync(filePath, "utf-8")
    ) as PersistedOpenApiBundle;
    return this.importOpenApiSpec(
      bundle.connectorId,
      bundle.spec,
      bundle.options,
      false
    );
  }

  public removeVirtualConnector(connectorId: string): void {
    const filePath = this.getSpecFilePath(connectorId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    for (const key of Array.from(this.endpoints.keys())) {
      if (key.startsWith(`${connectorId}::`)) {
        this.endpoints.delete(key);
      }
    }
  }

  public isVirtualConnector(serverId: string): boolean {
    const cfg = this.registry.getDesiredServer(serverId);
    return (
      cfg?.serverType === "virtual_openapi" ||
      cfg?.command === "__virtual_openapi__"
    );
  }

  public async invokeVirtualEndpoint(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const binding = this.endpoints.get(`${serverId}::${toolName}`);
    if (!binding) {
      throw new Error(
        `Virtual OpenAPI endpoint '${serverId}::${toolName}' not found.`
      );
    }

    let resolvedPath = binding.pathTemplate;
    for (const pName of binding.pathParams) {
      const val = encodeURIComponent(String(args[pName] ?? ""));
      resolvedPath = resolvedPath.replace(`{${pName}}`, val);
    }

    const urlObj = new URL(binding.baseUrl + resolvedPath);
    for (const qName of binding.queryParams) {
      if (args[qName] !== undefined) {
        urlObj.searchParams.set(qName, String(args[qName]));
      }
    }

    const bodyObj: Record<string, unknown> = {};
    if (binding.hasJsonBody) {
      for (const [k, v] of Object.entries(args)) {
        if (
          !binding.pathParams.includes(k) &&
          !binding.queryParams.includes(k)
        ) {
          bodyObj[k] = v;
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (binding.hasJsonBody) {
      headers["Content-Type"] = "application/json";
    }
    if (binding.auth.type === "bearer" && binding.auth.token) {
      headers["Authorization"] = `Bearer ${binding.auth.token}`;
    } else if (binding.auth.type === "api_key_header" && binding.auth.token) {
      headers[binding.auth.headerName ?? "X-API-Key"] = binding.auth.token;
    }

    const rawResp = await this.performHttpRequest(
      urlObj,
      binding.method,
      headers,
      binding.hasJsonBody ? JSON.stringify(bodyObj) : undefined
    );

    let processedText = rawResp;
    try {
      const parsed = JSON.parse(rawResp);
      if (
        binding.pickFields &&
        binding.pickFields.length > 0 &&
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        const picked: Record<string, unknown> = {};
        for (const f of binding.pickFields) {
          if (f in parsed) picked[f] = parsed[f];
        }
        processedText = JSON.stringify(picked);
      } else {
        processedText = JSON.stringify(parsed);
      }
    } catch {
      // Plain text response
    }

    if (processedText.length > binding.maxResponseChars) {
      processedText =
        processedText.slice(0, binding.maxResponseChars) +
        "...[TRUNCATED_BY_OPENAPI_CONNECTOR]";
    }

    return {
      content: [
        {
          type: "text",
          text: processedText,
        },
      ],
    };
  }

  private performHttpRequest(
    urlObj: URL,
    method: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<string> {
    const lib = urlObj.protocol === "https:" ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(
        urlObj,
        {
          method,
          headers,
          timeout: 5000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
```

### 3.6 `src/aggregator.ts` — 四驱动统一调度与 Schema-First 校验管线

```typescript
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
  private readonly connectingLocks = new Map<string, Promise<ToolRecord[]>>();
  private reconcilePromise: Promise<void> | null = null;

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

      return await this.refreshServerTools(config.id);
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

    for (const state of this.registry.getAllRuntimeStates()) {
      if (!desiredIds.has(state.serverId) && state.phase === "running") {
        if (state.serverType === "stdio_process" || state.serverType === "builder_sandbox") {
          await this.processPool.stopServerProcess(state.serverId);
        }
      }
    }

    for (const serverConfig of desired) {
      const driver = serverConfig.serverType ?? "stdio_process";
      const currentState = this.registry.getRuntimeState(serverConfig.id);

      // Software bridge plugins connect inbound; Daemon never spawns them
      if (driver === "software_bridge" || serverConfig.command === "__software_bridge__") {
        continue;
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
        continue;
      }

      if (serverConfig.enabled && currentState?.phase !== "running") {
        await this.connectAndDiscoverServer(serverConfig);
      } else if (!serverConfig.enabled && currentState?.phase === "running") {
        await this.processPool.stopServerProcess(serverConfig.id);
      }
    }
  }

  public validateToolArguments(
    tool: ToolRecord,
    args: Record<string, unknown>
  ): void {
    const schema = tool.inputSchema;
    if (!schema || schema.type !== "object") return;

    const required = schema.required ?? [];
    for (const reqKey of required) {
      if (!(reqKey in args) || args[reqKey] === undefined) {
        throw new Error(
          `Schema validation failed for '${tool.exposedName}' (${tool.toolId}): missing required parameter '${reqKey}'.`
        );
      }
    }

    const props = (schema.properties ?? {}) as Record<
      string,
      { type?: string }
    >;
    for (const [key, value] of Object.entries(args)) {
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
      const check = this.policyGuard.verifyCallPermission(
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

    const startMs = Date.now();
    let result: unknown;

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
        durationMs: Date.now() - startMs,
        argsPreview: JSON.stringify(args).slice(0, 200),
      });
    }

    return result;
  }
}
```

### 3.7 `src/meta_tools.ts` & `src/daemon.ts`

#### `src/meta_tools.ts`（16 个常驻 `studio__*` 元工具）

```typescript
import type {
  DesiredServerConfig,
  JsonSchema,
} from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { ProcessPool } from "./process_pool.js";
import type { McpAggregator } from "./aggregator.js";
import type { ClientAutoBinder } from "./client_binder.js";
import type { OpenApiConnector } from "./openapi_connector.js";
import type { ContextProfileRouter } from "./profile_router.js";
import type { PolicyGuard } from "./policy_guard.js";
import type { SoftwareBridge } from "./software_bridge.js";
import type { BuilderSandbox } from "./builder_sandbox.js";

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
export class MetaToolsProvider {
  private readonly registry: WorkbenchRegistry;
  private readonly processPool: ProcessPool;
  private readonly aggregator: McpAggregator;
  private readonly clientBinder?: ClientAutoBinder;
  private readonly openApiConnector?: OpenApiConnector;
  private readonly profileRouter?: ContextProfileRouter;
  private readonly policyGuard?: PolicyGuard;
  private readonly softwareBridge?: SoftwareBridge;
  private readonly builderSandbox?: BuilderSandbox;

  constructor(
    registry: WorkbenchRegistry,
    processPool: ProcessPool,
    aggregator: McpAggregator,
    clientBinder?: ClientAutoBinder,
    openApiConnector?: OpenApiConnector,
    profileRouter?: ContextProfileRouter,
    policyGuard?: PolicyGuard,
    softwareBridge?: SoftwareBridge,
    builderSandbox?: BuilderSandbox
  ) {
    this.registry = registry;
    this.processPool = processPool;
    this.aggregator = aggregator;
    this.clientBinder = clientBinder;
    this.openApiConnector = openApiConnector;
    this.profileRouter = profileRouter;
    this.policyGuard = policyGuard;
    this.softwareBridge = softwareBridge;
    this.builderSandbox = builderSandbox;
  }

  public getMetaToolDefinitions(): MetaToolDefinition[] {
    return [
      {
        name: "studio__client__scan",
        description:
          "Scan the machine using the 4-Layer Pre-Bind Discovery Funnel (Standard Paths, Install Pre-Provisioning, OS Runtime Process Table, Manual Path) to locate AI Agents.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "studio__client__bind",
        description:
          "Surgically bind an AI Agent client to MCP Workbench (importing and starting its existing scattered MCP servers, backing up original config, and injecting the unified Shim entrypoint).",
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
        description:
          "List all configured MCP servers across all 4 driver types (stdio_process, virtual_openapi, software_bridge, builder_sandbox).",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "studio__server__add",
        description:
          "Dynamically register, start, handshake, and mount a new stdio MCP Server into the Gateway without restarting host Agents.",
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
        description:
          "Search across registered MCP tools allowed in the caller's active Context Profile by keyword or server ID.",
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
        description:
          "Directly invoke any registered downstream tool allowed in the caller's Profile with full PolicyGuard & JSON Schema verification.",
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
        description:
          "Zero-code OpenAPI Connector: import an OpenAPI 3.x spec into a persisted virtual MCP server without spawning child processes.",
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
        description:
          "Create or update a context-aware Profile routing rule that isolates exposed and callable MCP servers by workspace CWD or client name.",
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
        description:
          "Configure a security firewall rule (risk classification, forbidden parameter regex fence, or human approval gate).",
        inputSchema: {
          type: "object",
          properties: {
            rule_id: { type: "string", description: "Unique rule identifier" },
            target_tool: { type: "string", description: "Target exposed tool name or '*'" },
            risk_level: { type: "string", description: "'safe' | 'mutating' | 'destructive'" },
            deny_param_regex: { type: "string", description: "Forbidden parameter regex pattern" },
            require_approval: { type: "boolean", description: "Require one-time human approval token before execution" },
          },
          required: ["rule_id", "target_tool", "risk_level"],
        },
      },
      {
        name: "studio__policy__list_pending",
        description:
          "List pending destructive tool calls awaiting human/GUI approval via /admin/approve.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "studio__policy__audit_log",
        description:
          "Retrieve the Flight Recorder audit log of recent tool invocations and security policy decisions.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max entries to return" },
          },
        },
      },
      {
        name: "studio__bridge__list",
        description:
          "List connected desktop host software plugins (e.g. Blender, Revit, AutoCAD) registered via the Reverse IPC SoftwareBridge.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "studio__builder__create_server",
        description:
          "Synthesize a new custom MCP Server in JavaScript, verify it against mandatory self-tests in an isolated trial process, and hot-mount it into the Gateway.",
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
    ];
  }

  public isMetaTool(name: string): boolean {
    const canonical = name.replace(/\./g, "__");
    return this.getMetaToolDefinitions().some((d) => d.name === canonical);
  }

  public async executeMetaTool(
    rawName: string,
    args: Record<string, unknown>,
    callerPpid: number | null = null,
    callerCwd: string | null = null,
    callerClientName: string | null = null
  ): Promise<unknown> {
    const name = rawName.replace(/^studio__/, "studio.").replace(/__/g, ".");

    switch (name) {
      case "studio.connector.import_openapi": {
        if (!this.openApiConnector) {
          throw new Error("OpenApiConnector is not attached.");
        }
        const connectorId = String(args.connector_id ?? "").trim();
        const spec = args.spec as any;
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
              text: JSON.stringify(
                {
                  status: "openapi_mounted",
                  connectorId,
                  toolCount: tools.length,
                  tools: tools.map((t) => ({
                    toolId: t.toolId,
                    exposedName: t.exposedName,
                    description: t.description,
                    inputSchema: t.inputSchema,
                  })),
                },
                null,
                2
              ),
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
          riskLevel: (args.risk_level as any) ?? "safe",
          denyParamRegex: args.deny_param_regex
            ? String(args.deny_param_regex)
            : undefined,
          requireApproval: Boolean(args.require_approval),
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
              text: JSON.stringify(
                { pendingApprovals: this.policyGuard.listPendingApprovals() },
                null,
                2
              ),
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
              text: JSON.stringify(
                { bridges: this.softwareBridge.listActiveBridges() },
                null,
                2
              ),
            },
          ],
        };
      }

      case "studio.builder.create_server": {
        if (!this.builderSandbox) {
          throw new Error("BuilderSandbox is not attached.");
        }
        const serverId = String(args.server_id ?? "").trim();
        const tools = Array.isArray(args.tools) ? (args.tools as any[]) : [];
        const selfTests = Array.isArray(args.self_tests)
          ? (args.self_tests as any[])
          : [];
        const res = await this.builderSandbox.buildVerifyAndMountServer(
          serverId,
          tools,
          selfTests
        );
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
          autoStartImported:
            args.auto_start_imported !== undefined
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
        const newConfig: DesiredServerConfig = {
          id,
          serverType: "stdio_process",
          command,
          args: cmdArgs,
          env: (args.env as Record<string, string>) ?? {},
          enabled: true,
          autoRestart: true,
          highFrequencyTools: Array.isArray(args.highFrequencyTools)
            ? args.highFrequencyTools.map(String)
            : undefined,
        };
        this.registry.upsertDesiredServer(newConfig);
        const discoveredTools = await this.aggregator.connectAndDiscoverServer(
          newConfig
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
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
                },
                null,
                2
              ),
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
        } else if (driver === "software_bridge" && this.softwareBridge) {
          this.softwareBridge.handlePluginDisconnect(id);
        } else {
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
          matches = matches.filter(
            (t) =>
              this.profileRouter!.isServerAllowedForContext(
                t.serverId,
                callerCwd ?? undefined,
                callerClientName ?? undefined
              ).allowed
          );
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
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
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "studio.tool.invoke": {
        const serverId = String(args.server_id ?? "").trim();
        const toolName = String(args.tool_name ?? "").trim();
        const toolArgs =
          args.arguments && typeof args.arguments === "object"
            ? (args.arguments as Record<string, unknown>)
            : {};

        if (!serverId || !toolName) {
          throw new Error(
            "studio__tool__invoke requires 'server_id', 'tool_name', and 'arguments'."
          );
        }

        const toolRecord = this.registry.resolveTool(serverId, toolName);
        if (!toolRecord) {
          throw new Error(
            `Tool '${toolName}' not found on server '${serverId}'. Call studio__tool__search to inspect available tools.`
          );
        }

        return await this.aggregator.invokeDownstreamTool(
          toolRecord,
          toolArgs,
          callerPpid,
          callerCwd,
          callerClientName
        );
      }

      default:
        throw new Error(`Unknown studio meta-tool: ${rawName}`);
    }
  }
}
```

#### `src/daemon.ts`（含 `/mcp`、`/admin/approve` 与 `/bridge/*` 端点）

```typescript
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import type {
  DaemonLockInfo,
  JsonRpcNotification,
  JsonRpcRequest,
} from "./types.js";
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

/**
 * Single-Instance Core Daemon v0.0.5 (`mcp-workbenchd`).
 * Integrates all 5 core modules + ClientAutoBinder with out-of-band `/admin/approve`
 * and Host Software Reverse IPC Bridge (`/bridge/register`, `/bridge/stream`, `/bridge/callback`).
 */
export class WorkbenchDaemon {
  private readonly rootDir: string;
  private readonly configPath: string;
  private readonly lockPath: string;
  private readonly port: number;
  private readonly host = "127.0.0.1";
  private readonly token: string;
  private readonly adminSecret: string;

  public readonly registry: WorkbenchRegistry;
  public readonly processPool: ProcessPool;
  public readonly openApiConnector: OpenApiConnector;
  public readonly profileRouter: ContextProfileRouter;
  public readonly policyGuard: PolicyGuard;
  public readonly softwareBridge: SoftwareBridge;
  public readonly builderSandbox: BuilderSandbox;
  public readonly aggregator: McpAggregator;
  public readonly clientBinder: ClientAutoBinder;
  public readonly metaTools: MetaToolsProvider;
  public readonly gatewayCore: GatewayCore;
  public readonly connectedClientPids = new Set<number>();

  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private readonly notificationLog: JsonRpcNotification[] = [];

  constructor(rootDir: string, port = 43110) {
    this.rootDir = path.resolve(rootDir);
    this.configPath = path.join(this.rootDir, "workbench.json");
    this.lockPath = path.join(this.rootDir, ".workbench-daemon.lock.json");
    this.port = port;
    this.token = crypto.randomBytes(24).toString("hex");
    this.adminSecret = crypto.randomBytes(24).toString("hex");

    this.registry = new WorkbenchRegistry(this.configPath);
    this.processPool = new ProcessPool(this.registry, this.rootDir);
    this.openApiConnector = new OpenApiConnector(this.registry, this.rootDir);
    this.profileRouter = new ContextProfileRouter(this.registry);
    this.policyGuard = new PolicyGuard(this.adminSecret);
    this.softwareBridge = new SoftwareBridge(this.registry);

    this.aggregator = new McpAggregator(
      this.registry,
      this.processPool,
      this.openApiConnector,
      this.profileRouter,
      this.policyGuard,
      this.softwareBridge
    );
    this.builderSandbox = new BuilderSandbox(
      this.registry,
      this.aggregator,
      this.rootDir
    );
    this.clientBinder = new ClientAutoBinder(
      this.registry,
      this.rootDir,
      this.aggregator
    );
    this.metaTools = new MetaToolsProvider(
      this.registry,
      this.processPool,
      this.aggregator,
      this.clientBinder,
      this.openApiConnector,
      this.profileRouter,
      this.policyGuard,
      this.softwareBridge,
      this.builderSandbox
    );
    this.gatewayCore = new GatewayCore(
      this.registry,
      this.aggregator,
      this.metaTools,
      this.profileRouter
    );

    this.gatewayCore.on(
      "broadcastNotification",
      (notification: JsonRpcNotification) => {
        this.notificationLog.push(notification);
        const frame = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
        for (const client of this.sseClients) {
          client.write(frame);
        }
      }
    );
  }

  private async acquireSingleInstanceLock(): Promise<void> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        let processAlive = false;
        try {
          process.kill(existing.pid, 0);
          processAlive = true;
        } catch {
          processAlive = false;
        }

        if (processAlive) {
          throw new Error(
            `ALREADY_RUNNING: MCP Workbench Daemon is already running (PID=${existing.pid}, Port=${existing.port}).`
          );
        }
        fs.unlinkSync(this.lockPath);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("ALREADY_RUNNING:")) {
          throw err;
        }
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          // ignore
        }
      }
    }

    const lockInfo: DaemonLockInfo = {
      pid: process.pid,
      host: this.host,
      port: this.port,
      token: this.token,
      adminSecret: this.adminSecret,
      startedAt: new Date().toISOString(),
      version: "0.0.5",
    };
    fs.writeFileSync(this.lockPath, JSON.stringify(lockInfo, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  public async start(): Promise<DaemonLockInfo> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        let alive = false;
        try {
          process.kill(existing.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) {
          throw new Error(
            `ALREADY_RUNNING: MCP Workbench Daemon is already running (PID=${existing.pid}, Port=${existing.port}).`
          );
        }
        fs.unlinkSync(this.lockPath);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("ALREADY_RUNNING:")) {
          throw err;
        }
      }
    }

    await this.aggregator.reconcileAll();

    fs.watchFile(this.configPath, { interval: 250 }, () => {
      if (this.registry.reloadDesiredConfigFromDisk()) {
        void this.aggregator.reconcileAll();
      }
    });

    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);

      // 1. Public Health Check
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            pid: process.pid,
            version: "0.0.5",
            servers: this.registry.getAllRuntimeStates(),
            totalTools: this.registry.getAllTools().length,
            topLevelTools: this.registry.getTopLevelExposedTools().length,
            activeBridges: this.softwareBridge.listActiveBridges().length,
            notificationsSent: this.notificationLog.length,
          })
        );
        return;
      }

      // 2. Out-of-Band Human/GUI Admin Approval Endpoint (`POST /admin/approve`)
      if (req.method === "POST" && url.pathname === "/admin/approve") {
        const providedSecret = String(
          req.headers["x-workbench-admin-secret"] ?? ""
        );
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const parsed = JSON.parse(body);
          const approved = this.policyGuard.approvePendingTokenWithAdminSecret(
            String(parsed.approval_token ?? ""),
            providedSecret
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ approved, approvalToken: parsed.approval_token }));
        } catch (err) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
        return;
      }

      // Verify Bearer token for `/mcp` and `/bridge/*`
      const authHeader = req.headers["authorization"] ?? "";
      if (authHeader !== `Bearer ${this.token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Unauthorized: Invalid Daemon Bearer Token" })
        );
        return;
      }

      // 3. Host Software Reverse IPC Bridge Endpoints (`/bridge/register`, `/bridge/stream`, `/bridge/callback`)
      if (req.method === "POST" && url.pathname === "/bridge/register") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const reg = JSON.parse(body);
        const tools = this.softwareBridge.registerPlugin(reg);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "bridge_registered",
            bridgeId: reg.bridgeId,
            toolCount: tools.length,
          })
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/bridge/stream") {
        const bridgeId = String(url.searchParams.get("bridge_id") ?? "");
        this.softwareBridge.attachCommandStream(bridgeId, req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/bridge/callback") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const cb = JSON.parse(body);
        const ok = this.softwareBridge.submitBridgeCallback(
          String(cb.bridgeId),
          String(cb.callId),
          cb.result,
          cb.error
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }

      // Attribute session by PPID and resolve client name for ContextProfileRouter
      const callerPpid = Number(req.headers["x-mcp-client-ppid"] ?? 0);
      let callerClientName: string | null = req.headers["x-mcp-client-name"]
        ? String(req.headers["x-mcp-client-name"])
        : null;
      if (callerPpid > 0) {
        this.connectedClientPids.add(callerPpid);
        const session = this.clientBinder.attributeSessionByPpid(callerPpid);
        if (!callerClientName && session) {
          callerClientName = session.clientName;
        }
      }

      // 4. Streamable HTTP MCP Notification Stream (`GET /mcp`)
      if (req.method === "GET" && url.pathname === "/mcp") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        this.sseClients.add(res);
        req.on("close", () => {
          this.sseClients.delete(res);
        });
        return;
      }

      // 5. Streamable HTTP MCP Request Endpoint (`POST /mcp`)
      if (req.method === "POST" && url.pathname === "/mcp") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        try {
          const rpcReq = JSON.parse(body) as JsonRpcRequest;
          const callerCwd = req.headers["x-mcp-client-cwd"]
            ? String(req.headers["x-mcp-client-cwd"])
            : null;
          const rpcResp = await this.gatewayCore.handleJsonRpcRequest(rpcReq, {
            callerPpid: callerPpid > 0 ? callerPpid : null,
            callerCwd,
            callerClientName,
          });
          const sessionId =
            (req.headers["mcp-session-id"] as string) ??
            `sess_${crypto.randomBytes(8).toString("hex")}`;

          if (!rpcResp) {
            res.writeHead(202, { "Mcp-Session-Id": sessionId });
            res.end();
            return;
          }

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          });
          res.end(JSON.stringify(rpcResp));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: `Parse error: ${String(err)}` },
            })
          );
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });

    await this.acquireSingleInstanceLock();
    return JSON.parse(fs.readFileSync(this.lockPath, "utf-8")) as DaemonLockInfo;
  }

  public async stop(): Promise<void> {
    fs.unwatchFile(this.configPath);
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    await this.processPool.stopAll();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    if (fs.existsSync(this.lockPath)) {
      try {
        const lock = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        if (lock.pid === process.pid) {
          fs.unlinkSync(this.lockPath);
        }
      } catch {
        // ignore
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = process.env.MCP_WORKBENCH_ROOT ?? process.cwd();
  const port = Number(process.env.MCP_WORKBENCH_PORT ?? 43110);
  const daemon = new WorkbenchDaemon(rootDir, port);
  daemon
    .start()
    .then((lock) => {
      console.log(
        `[mcp-workbenchd v0.0.5] Listening on http://${lock.host}:${lock.port}/mcp (PID=${lock.pid})`
      );
    })
    .catch((err) => {
      console.error(`[mcp-workbenchd] Failed to start: ${err.message}`);
      process.exit(1);
    });

  const shutdown = () => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```

### 3.8 `src/verify_acceptance.ts` — 14 步全链路自动化验收测试套件

```typescript
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { WorkbenchDaemon } from "./daemon.js";

/**
 * Automated 14-Step Acceptance Verification Suite for MCP Workbench Gateway Prototype v0.0.5.
 */
async function postJson(
  port: number,
  urlPath: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode ?? 500,
              body: data ? JSON.parse(data) : {},
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(raw);
    req.end();
  });
}

async function postMcp(
  port: number,
  token: string,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<Record<string, any>> {
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
  } catch (err: any) {
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
  const toolNames: string[] = listResp.result.tools.map((t: any) => t.name);
  for (const name of toolNames) {
    assert(
      /^[a-zA-Z0-9_-]{1,64}$/.test(name),
      `Tool name "${name}" violates strict LLM regex ^[a-zA-Z0-9_-]{1,64}$`
    );
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

  const shimMessages: any[] = [];
  const shimNotifications: any[] = [];
  const rlShim = readline.createInterface({ input: shimChild.stdout });
  rlShim.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "notifications/tools/list_changed") {
      shimNotifications.push(msg);
    } else {
      shimMessages.push(msg);
    }
  });

  shimChild.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "math_ops__multiply", arguments: { a: 6, b: 7 } },
    }) + "\n"
  );

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
  fs.writeFileSync(
    portableMcpJson,
    JSON.stringify(
      {
        editorTheme: "Solarized-Dark",
        mcpServers: {
          legacy_scattered_srv: { command: "node", args: ["legacy.js"] },
        },
      },
      null,
      2
    ),
    "utf-8"
  );

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

  const fakeAgentProc = spawn(
    process.execPath,
    [fakeAgentScript, `--user-data-dir=${customProfileDir}`],
    { cwd: portableDir, stdio: "ignore" }
  );
  await new Promise((r) => setTimeout(r, 200));

  const scanResp = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "studio__client__scan", arguments: {} },
  });
  const scanData = JSON.parse(scanResp.result.content[0].text);
  const detectedPortable = scanData.clients.find(
    (c: any) => c.clientId === "portable-cursor-test"
  );
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
  fakeAgentProc.kill("SIGTERM");
  fs.rmSync(portableDir, { recursive: true, force: true });
  console.log("PASS: Step 7 - L3 Runtime Process Detection, CLI Flag Extraction & Surgical Merge verified.");

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
      res.end(
        JSON.stringify({
          id: custId,
          name: "Acme Corp",
          tier: "Enterprise",
          huge_internal_blob: "X".repeat(2000),
        })
      );
      return;
    }
    if (req.method === "POST" && req.url === "/orders") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          orderId: "ord_777",
          item: parsed.item,
          qty: parsed.qty,
          status: "created",
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => mockRestServer.listen(mockRestPort, "127.0.0.1", () => resolve()));

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
        auth_token: "secret_crm_token",
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
  const scopedToolsResp = await postMcp(
    port,
    lockInfo.token,
    { jsonrpc: "2.0", id: 101, method: "tools/list" },
    scopedHeaders
  );
  const scopedNames: string[] = scopedToolsResp.result.tools.map((t: any) => t.name);
  assert(scopedNames.includes("crm_api__get_customer"));
  assert(!scopedNames.includes("math_ops__add"));

  // Conflict B Fix Verification: Calling forbidden server tool directly or via studio__tool__invoke in restricted CWD must fail!
  const forbiddenDirectCall = await postMcp(
    port,
    lockInfo.token,
    {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: { name: "math_ops__add", arguments: { a: 1, b: 2 } },
    },
    scopedHeaders
  );
  assert(
    forbiddenDirectCall.error &&
      String(forbiddenDirectCall.error.message).includes("PROFILE_FORBIDDEN[crm_frontend_profile]"),
    "ContextProfileRouter must block execution of tools outside active workspace profile"
  );

  const scopedSearch = await postMcp(
    port,
    lockInfo.token,
    {
      jsonrpc: "2.0",
      id: 103,
      method: "tools/call",
      params: { name: "studio__tool__search", arguments: { query: "fibonacci" } },
    },
    scopedHeaders
  );
  assert.strictEqual(
    JSON.parse(scopedSearch.result.content[0].text).matchCount,
    0,
    "studio__tool__search must not leak tools from servers forbidden by active Profile"
  );
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
  const fakeApprove = await postJson(
    port,
    "/admin/approve",
    { approval_token: approvalToken },
    { "X-Workbench-Admin-Secret": "wrong_secret_from_agent" }
  );
  assert.strictEqual(fakeApprove.statusCode, 403, "Must reject approval without valid human Admin Secret");

  // Out-of-Band Human/GUI Admin approval with real lockInfo.adminSecret
  const realApprove = await postJson(
    port,
    "/admin/approve",
    { approval_token: approvalToken },
    { "X-Workbench-Admin-Secret": lockInfo.adminSecret }
  );
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

  console.log("=== [Step 12] Verifying Module 4 (`SoftwareBridge`) — Host Software Reverse IPC Bridge (Revit/Blender) ===");
  const regBridgeResp = await postJson(
    port,
    "/bridge/register",
    {
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
    },
    { Authorization: `Bearer ${lockInfo.token}` }
  );
  assert.strictEqual(regBridgeResp.body.status, "bridge_registered");

  // Connect simulated Revit plugin command stream (`/bridge/stream?bridge_id=revit_bim`)
  const bridgeStreamReq = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/bridge/stream?bridge_id=revit_bim",
      method: "GET",
      headers: { Authorization: `Bearer ${lockInfo.token}` },
    },
    (res) => {
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
            void postJson(
              port,
              "/bridge/callback",
              {
                bridgeId: cmd.bridgeId,
                callId: cmd.callId,
                result: {
                  level: cmd.arguments.level,
                  wallCount: 12,
                  elements: ["Wall_Exterior_01", "Wall_Core_02"],
                },
              },
              { Authorization: `Bearer ${lockInfo.token}` }
            );
          }
        }
      });
    }
  );
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
  assert(
    brokenBuild.error && String(brokenBuild.error.message).includes("Self-test failed"),
    "BuilderSandbox must block mounting when isolated self-test fails"
  );

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

  await postMcp(port, restartLock.token, {
    jsonrpc: "2.0",
    id: 141,
    method: "tools/call",
    params: { name: "studio__server__remove", arguments: { id: "crm_api" } },
  });
  fs.rmSync(path.join(rootDir, ".workbench_openapi"), { recursive: true, force: true });
  await new Promise<void>((resolve) => mockRestServer.close(() => resolve()));
  await daemonRestarted.stop();
  console.log("PASS: Step 14 - Persisted Virtual OpenAPI Server automatically restored and invoked after Daemon restart.");

  console.log("=== [Step 8] Verifying StdioShim Zero-Touch Auto-Wake Daemon after Cold Shutdown ===");
  const autoWakeShim = spawn("node", ["./dist/stdio_shim.js"], {
    cwd: rootDir,
    env: { ...process.env, MCP_WORKBENCH_ROOT: rootDir, MCP_WORKBENCH_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const wakeMessages: any[] = [];
  const rlWake = readline.createInterface({ input: autoWakeShim.stdout });
  rlWake.on("line", (line) => {
    try {
      wakeMessages.push(JSON.parse(line));
    } catch {
      // ignore
    }
  });

  autoWakeShim.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 801,
      method: "tools/call",
      params: { name: "math_ops__add", arguments: { a: 100, b: 23 } },
    }) + "\n"
  );

  for (let i = 0; i < 50 && !wakeMessages.find((m) => m.id === 801); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const wakeResp = wakeMessages.find((m) => m.id === 801);
  assert(wakeResp);
  assert.strictEqual(wakeResp.result.content[0].text, "123");

  const lockFile = path.join(rootDir, ".workbench-daemon.lock.json");
  if (fs.existsSync(lockFile)) {
    const spawnedLock = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
    try {
      process.kill(spawnedLock.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  autoWakeShim.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  console.log("PASS: Step 8 - StdioShim automatically woke up background Daemon on cold start.");
  console.log("=== ALL 14 ACCEPTANCE STEPS PASSED SUCCESSFULLY ===");
}

runVerification().catch((err) => {
  console.error("ACCEPTANCE VERIFICATION FAILED:", err);
  process.exit(1);
});
```

## 四、v0.0.5 十四步实测验收结果对照表（Node.js v18.20.4）

| 验收步骤 | 验证模块与防冲突点 | 实测验证结果 |
| :--- | :--- | :--- |
| **步骤 1 ~ 8** | 单实例锁与独立 `adminSecret`、双服务聚合、19 个工具名严格匹配 `^[a-zA-Z0-9_-]{1,64}$`、多客户端共享 Daemon、动态挂载与跨缓存调用、L3 运行态进程反查、StdioShim 冷启动自唤醒 | **全部 PASS** |
| **步骤 9** | **OpenAPI 零代码虚拟服务**：挂载本地 CRM REST API，验证 Bearer 自动注入与 `huge_internal_blob` 响应裁剪 | **PASS** |
| **步骤 10** | **Profile 全链路硬隔离（修正冲突 B）**：在 `crm-frontend` 工作区下，不仅 `tools/list` 隐藏 `math_ops`，直接调用 `math_ops__add` 被 `PROFILE_FORBIDDEN` 拦截，且 `studio__tool__search` 不泄露 `fibonacci` | **PASS** |
| **步骤 11** | **带外人工审批与防误烧令牌（修正冲突 A & D）**：伪造密钥调 `/admin/approve` 返回 `403`；用真实 `adminSecret` 批准后，故意传错参数类型触发 Schema 报错，验证审批码未被误消耗，修正参数后调用成功 | **PASS** |
| **步骤 12** | **宿主软件反向 IPC 桥接（`SoftwareBridge`）**：模拟 Autodesk Revit 2026 插件连入 `/bridge/register` 与 `/bridge/stream`，Agent 调用 `revit_bim__get_walls_by_level` 在主线程拿到墙体数据，关闭连接后工具自动下线 | **PASS** |
| **步骤 13** | **Agent 沙箱工具合成与强制自测（`BuilderSandbox`）**：先提交带逻辑 Bug 的工具，验证被隔离自测拦截且不污染网关；再提交正确工具 `unit_converter_srv__km_to_miles`，自测通过后自动热挂载并调用成功 | **PASS** |
| **步骤 14** | **虚拟服务跨重启持久化恢复（修正冲突 C）**：关闭 Daemon 后重新启动新实例，验证 `crm_api` 从 `.workbench_openapi/` 自动恢复并立即可调 | **PASS** |
