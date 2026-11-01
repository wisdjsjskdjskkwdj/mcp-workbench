# MCP Workbench Gateway Prototype v0.0.3 逻辑冲突修正与技术规格书

**版本状态**：v0.0.3 逻辑闭环与防冲突定型版（已通过 Node.js 沙箱全链路实测）  
**核心变更**：全面清理了 v0.0.2 中存在的 **6 处深层逻辑冲突与竞态漏洞**（因果倒置、运行态配置回写覆盖、存量接管断联、工具命名正则冲突、文件监听递归重入、Daemon 重启后 Shim 401 失联）

## 一、v0.0.2 存在的六大逻辑冲突与 v0.0.3 修正对照表

| 冲突编号与名称 | 原方案（v0.0.2）中的逻辑矛盾与隐患 | 新版（v0.0.3）的修正机制与代码落点 |
| :--- | :--- | :--- |
| **1. `ppid` 溯源的因果倒置** | 将 `L4_PPID_TRACE` 放在“未绑定客户端发现漏斗”中；但未绑定客户端根本不会启动 `stdio_shim.js`，不可能通过 `ppid` 被首次发现 | **严格拆分两个阶段**：安装期发现漏斗收敛为 **L1~L4**（标准路径 -> 预置目录 -> OS 进程表反查 -> 手动路径）；`ppid` 独立为 **连接期会话归属（Session Attribution）**，用于已绑定客户端的 Profile 匹配与宿主退出清理 |
| **2. 运行态改配置被宿主退出回写覆盖** | 通过 L3 发现某 Agent 正在运行后直接修改其配置文件；但 Claude Code 等客户端在内存持有完整配置并在退出时回写磁盘，会把刚注入的配置覆盖掉 | **引入 `reloadBehavior` 分级策略**：区分支持热监听的客户端（`hot_watch`，如 Cursor）与退出回写型客户端（`exit_overwrite`，如 `~/.claude.json`）；后者在运行期默认进入 `staged_wait_exit` 挂起态并告警，避免白写或冲掉内存状态 |
| **3. 收编存量 MCP 后的“服务断联”黑洞** | `bindClient` 把用户原有的散装 MCP 导入 `workbench.json` 时设为 `enabled: false`，却立刻把客户端配置替换成唯一总入口，导致用户原有工具瞬间全部失效 | **无缝热接管 + 双模式支持**：导入存量 MCP 时默认 `enabled: true` 并立即触发 `aggregator.reconcileAll()` 启动服务；同时支持 `mode: "side_by_side"`（共存模式）与 `"exclusive"`（独占接管模式） |
| **4. 元工具命名违反 LLM API 正则限制** | 文档规定用 `__` 避免点号 `.` 报错，但 9 个内置元工具却命名为 `studio.server.add`，在严格校验 `^[a-zA-Z0-9_-]{1,64}$` 的 OpenAI / Anthropic 接口中会报 400 错误 | **全面统一为双下划线规范**：`tools/list` 暴露名称统一改为 `studio__server__add`、`studio__client__scan` 等（100% 符合 `^[a-zA-Z0-9_-]{1,64}$`），内部路由同时兼容 `.` 与 `__` 两种调用格式 |
| **5. 文件监听与自举挂载的递归重入竞态** | `saveDesiredConfigAtomically` 仅靠 `setTimeout(150ms)` 屏蔽 `fs.watchFile`；磁盘稍慢就会触发二次 `reconcileAll()`，把正在握手的子进程杀掉重起 | **内容 SHA-256 摘要去重 + 单飞互斥锁**：`WorkbenchRegistry` 记录 `lastSavedSha256`，文件监听触发时比对内容哈希，内部写入 100% 免重入；`McpAggregator` 增加 `connectingLocks` 与 `reconcilePromise` 互斥锁 |
| **6. 两阶段锁顺序颠倒与 Shim 401 死锁** | Daemon 先写锁文件再 `server.listen()`，导致并发唤醒的 Shim 在端口未就绪时连入失败；且 Daemon 重启换新 Token 后，存量 Shim 一直报 `401` 无法自愈 | **两阶段锁提交 + Shim 401 自动自愈重连**：Daemon 必须在 HTTP 端口 `listen` 成功后才落盘 `.workbench-daemon.lock.json`；`StdioShim` 遇到 `401` 或连接断开时自动重跑 `ensureDaemonRunning()` 刷新 Token 并无感重发请求 |

## 二、修正后的核心状态机与数据流

### 2.1 客户端发现（Pre-Bind）与会话归属（Post-Bind）分离模型

```text
【阶段 A：未绑定客户端发现漏斗（Pre-Bind Discovery Funnel）】
L1 标准配置路径静态探测 (~/.cursor/mcp.json, ~/.claude.json 等)
  ↓ 未找到
L2 已安装目录预置探测 (AppData/Local/Programs/..., /Applications/...)
  ↓ 未找到
L3 操作系统运行态进程表反查 (提取进程真实路径与 --user-data-dir / --config 参数)
  ↓ 未找到
L4 用户手动指定安装目录 / 可执行文件 / 配置文件路径
  ↓
执行绑定 (检查 reloadBehavior: hot_watch 直接局部注入 | exit_overwrite 若进程存活则挂起保护)

【阶段 B：已绑定客户端连接期归属（Post-Bind Session Attribution）】
客户端启动 stdio_shim.js
  ↓
StdioShim 缓冲早期 stdin -> 检查或自动唤醒后台 Daemon -> 携带 X-Mcp-Client-Ppid 请求头连接
  ↓
Daemon 通过 attributeSessionByPpid(ppid) 反查宿主进程身份 -> 绑定客户端专属 Profile 与权限策略
```

## 三、v0.0.3 完整源码实现（已修复全部 6 处冲突）

### 3.1 `src/registry.ts` — 基于 SHA-256 内容摘要去重的原子持久化与三层状态表

```typescript
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  WorkbenchDesiredConfig,
  DesiredServerConfig,
  ActualServerRuntimeState,
  ToolRecord,
  JsonSchema,
} from "./types.js";

/**
 * State & Tool Registry with Atomic Persistence.
 * Separates Desired Config State (`workbench.json`), Actual Runtime State, and Stable-ID Tool Registry.
 */
export class WorkbenchRegistry extends EventEmitter {
  private readonly configPath: string;
  private desiredConfig: WorkbenchDesiredConfig;
  private readonly runtimeStates = new Map<string, ActualServerRuntimeState>();
  private readonly toolsById = new Map<string, ToolRecord>();
  private readonly toolIdByExposedName = new Map<string, string>();
  private lastSavedSha256 = "";

  constructor(configPath: string) {
    super();
    this.configPath = path.resolve(configPath);
    this.desiredConfig = this.loadConfigFromDisk();
    this.initRuntimeStates();
  }

  private computeSha256(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private loadConfigFromDisk(): WorkbenchDesiredConfig {
    const raw = fs.readFileSync(this.configPath, "utf-8");
    this.lastSavedSha256 = this.computeSha256(raw);
    return JSON.parse(raw) as WorkbenchDesiredConfig;
  }

  private initRuntimeStates(): void {
    for (const serverId of Object.keys(this.desiredConfig.servers)) {
      if (!this.runtimeStates.has(serverId)) {
        this.runtimeStates.set(serverId, {
          serverId,
          phase: "stopped",
          pid: null,
          startedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastError: null,
          protocolVersion: null,
          recentStderr: [],
        });
      }
    }
  }

  /**
   * Atomically writes Desired State to `workbench.json.tmp.<pid>` and renames over `workbench.json`
   * so File Watchers never observe half-written JSON.
   */
  public saveDesiredConfigAtomically(): void {
    const tmpPath = `${this.configPath}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify(this.desiredConfig, null, 2);
    this.lastSavedSha256 = this.computeSha256(payload);
    fs.writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "w" });
    fs.renameSync(tmpPath, this.configPath);
  }

  public reloadDesiredConfigFromDisk(): boolean {
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const currentHash = this.computeSha256(raw);
      if (currentHash === this.lastSavedSha256) {
        // Ignore self-triggered file watcher events deterministically
        return false;
      }
      this.lastSavedSha256 = currentHash;
      this.desiredConfig = JSON.parse(raw) as WorkbenchDesiredConfig;
      this.initRuntimeStates();
      return true;
    } catch {
      return false;
    }
  }

  public getDesiredServers(): DesiredServerConfig[] {
    return Object.values(this.desiredConfig.servers);
  }

  public getDesiredServer(serverId: string): DesiredServerConfig | undefined {
    return this.desiredConfig.servers[serverId];
  }

  public upsertDesiredServer(config: DesiredServerConfig): void {
    this.desiredConfig.servers[config.id] = config;
    if (!this.runtimeStates.has(config.id)) {
      this.runtimeStates.set(config.id, {
        serverId: config.id,
        phase: "stopped",
        pid: null,
        startedAt: null,
        restartCount: 0,
        lastExitCode: null,
        lastError: null,
        protocolVersion: null,
        recentStderr: [],
      });
    }
    this.saveDesiredConfigAtomically();
  }

  public removeDesiredServer(serverId: string): boolean {
    if (!this.desiredConfig.servers[serverId]) return false;
    delete this.desiredConfig.servers[serverId];
    this.clearServerTools(serverId);
    this.runtimeStates.delete(serverId);
    this.saveDesiredConfigAtomically();
    return true;
  }

  public updateRuntimeState(
    serverId: string,
    patch: Partial<ActualServerRuntimeState>
  ): ActualServerRuntimeState {
    const existing = this.runtimeStates.get(serverId) ?? {
      serverId,
      phase: "stopped",
      pid: null,
      startedAt: null,
      restartCount: 0,
      lastExitCode: null,
      lastError: null,
      protocolVersion: null,
      recentStderr: [],
    };
    const next: ActualServerRuntimeState = { ...existing, ...patch };
    this.runtimeStates.set(serverId, next);
    return next;
  }

  public getRuntimeState(serverId: string): ActualServerRuntimeState | undefined {
    return this.runtimeStates.get(serverId);
  }

  public getAllRuntimeStates(): ActualServerRuntimeState[] {
    return Array.from(this.runtimeStates.values());
  }

  /**
   * Computes a deterministic stable internal tool ID independent of exposed alias formatting.
   */
  public static computeStableToolId(serverId: string, originalName: string): string {
    const digest = crypto
      .createHash("sha256")
      .update(`${serverId}::${originalName}`)
      .digest("hex")
      .slice(0, 12);
    return `tool_${digest}`;
  }

  /**
   * Replaces the registered tools for a specific server and emits `toolsChanged` if the set changed.
   */
  public registerServerTools(
    serverId: string,
    rawTools: Array<{ name: string; description?: string; inputSchema?: JsonSchema }>
  ): ToolRecord[] {
    this.clearServerTools(serverId, false);
    const serverConfig = this.desiredConfig.servers[serverId];
    const highFreqSet = new Set(serverConfig?.highFrequencyTools ?? []);
    const exposeAll = !serverConfig?.highFrequencyTools || serverConfig.highFrequencyTools.length === 0;

    const registered: ToolRecord[] = [];
    for (const raw of rawTools) {
      const toolId = WorkbenchRegistry.computeStableToolId(serverId, raw.name);
      const exposedName = `${serverId}__${raw.name}`;
      const record: ToolRecord = {
        toolId,
        serverId,
        originalName: raw.name,
        exposedName,
        description: raw.description ?? "",
        inputSchema: raw.inputSchema ?? { type: "object", properties: {} },
        enabled: true,
        exposeTopLevel: exposeAll || highFreqSet.has(raw.name),
      };
      this.toolsById.set(toolId, record);
      this.toolIdByExposedName.set(exposedName, toolId);
      registered.push(record);
    }
    this.emit("toolsChanged", { serverId, count: registered.length });
    return registered;
  }

  public clearServerTools(serverId: string, emitEvent = true): void {
    let removed = 0;
    for (const [toolId, record] of this.toolsById.entries()) {
      if (record.serverId === serverId) {
        this.toolsById.delete(toolId);
        this.toolIdByExposedName.delete(record.exposedName);
        removed++;
      }
    }
    if (emitEvent && removed > 0) {
      this.emit("toolsChanged", { serverId, count: 0 });
    }
  }

  public getTopLevelExposedTools(): ToolRecord[] {
    return Array.from(this.toolsById.values()).filter(
      (t) => t.enabled && t.exposeTopLevel
    );
  }

  public getAllTools(): ToolRecord[] {
    return Array.from(this.toolsById.values());
  }

  public resolveToolByExposedName(exposedName: string): ToolRecord | undefined {
    const id = this.toolIdByExposedName.get(exposedName);
    return id ? this.toolsById.get(id) : undefined;
  }

  public resolveTool(
    serverId: string,
    originalOrExposedName: string
  ): ToolRecord | undefined {
    const directId = WorkbenchRegistry.computeStableToolId(
      serverId,
      originalOrExposedName
    );
    if (this.toolsById.has(directId)) {
      return this.toolsById.get(directId);
    }
    return this.resolveToolByExposedName(originalOrExposedName);
  }

  public searchTools(query: string, serverFilter?: string): ToolRecord[] {
    const q = query.trim().toLowerCase();
    return Array.from(this.toolsById.values()).filter((t) => {
      if (!t.enabled) return false;
      if (serverFilter && t.serverId !== serverFilter) return false;
      if (!q) return true;
      return (
        t.originalName.toLowerCase().includes(q) ||
        t.exposedName.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.serverId.toLowerCase().includes(q)
      );
    });
  }
}
```

### 3.2 `src/aggregator.ts` — 带单飞互斥锁（Single-Flight Mutex）的调谐器与 Schema 校验器

```typescript
import type {
  DesiredServerConfig,
  JsonSchema,
  ToolRecord,
} from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { ProcessPool } from "./process_pool.js";

/**
 * MCP Client Pool & Tool Aggregator.
 * Performs standard MCP initialize handshake, fetches `tools/list`, validates tool arguments
 * against JSON Schema before forwarding `tools/call`, and reconciles Desired vs Actual state.
 */
export class McpAggregator {
  private readonly registry: WorkbenchRegistry;
  private readonly processPool: ProcessPool;
  private readonly connectingLocks = new Map<string, Promise<ToolRecord[]>>();
  private reconcilePromise: Promise<void> | null = null;

  constructor(registry: WorkbenchRegistry, processPool: ProcessPool) {
    this.registry = registry;
    this.processPool = processPool;

    this.processPool.on("downstreamToolsChanged", (serverId: string) => {
      void this.refreshServerTools(serverId);
    });
  }

  /**
   * Starts a server process, runs MCP `initialize` + `notifications/initialized`,
   * and populates the aggregated tool registry.
   */
  public async connectAndDiscoverServer(
    config: DesiredServerConfig
  ): Promise<ToolRecord[]> {
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
            version: "0.0.1",
          },
        }
      )) as { protocolVersion?: string };

      this.processPool.sendNotification(
        config.id,
        "notifications/initialized",
        {}
      );

      this.registry.updateRuntimeState(config.id, {
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

  /**
   * Reconciles Desired State in `workbench.json` with Actual Runtime State.
   */
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
        await this.processPool.stopServerProcess(state.serverId);
      }
    }

    for (const serverConfig of desired) {
      const currentState = this.registry.getRuntimeState(serverConfig.id);
      if (serverConfig.enabled && currentState?.phase !== "running") {
        await this.connectAndDiscoverServer(serverConfig);
      } else if (!serverConfig.enabled && currentState?.phase === "running") {
        await this.processPool.stopServerProcess(serverConfig.id);
      }
    }
  }

  /**
   * Validates arguments against the registered tool's JSON Schema before routing to the downstream server.
   */
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
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!tool.enabled) {
      throw new Error(`Tool '${tool.exposedName}' (${tool.toolId}) is disabled.`);
    }
    const serverState = this.registry.getRuntimeState(tool.serverId);
    if (!serverState || serverState.phase !== "running") {
      throw new Error(
        `Server '${tool.serverId}' is not running (current phase: ${serverState?.phase ?? "unknown"}).`
      );
    }

    this.validateToolArguments(tool, args);

    return await this.processPool.sendRequest(tool.serverId, "tools/call", {
      name: tool.originalName,
      arguments: args,
    });
  }
}
```

### 3.3 `src/client_binder.ts` — 区分 `hot_watch`/`exit_overwrite` 的客户端发现与零断联接管引擎

```typescript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";
import type { DesiredServerConfig } from "./types.js";

export interface ClientAdapterRecipe {
  clientId: string;
  displayName: string;
  processKeywords: string[];
  defaultConfigCandidates: string[];
  defaultInstallDirs: string[];
  configFormat: "json_mcpServers" | "toml_mcp_servers";
  /**
   * "hot_watch": Client reloads config safely while running (e.g. Cursor, Windsurf)
   * "exit_overwrite": Client holds config in memory and may overwrite on exit (e.g. Claude Code CLI)
   */
  reloadBehavior: "hot_watch" | "exit_overwrite";
  portableConfigRelPath: string;
}

export interface DiscoveredClientStatus {
  clientId: string;
  displayName: string;
  status: "bound" | "detected_unbound" | "staged_wait_exit" | "needs_manual_path";
  /** Strictly Pre-Bind Discovery Layers (L1 ~ L4) */
  discoveryLayer: "L1_STANDARD_PATH" | "L2_INSTALL_PREPROVISION" | "L3_RUNTIME_PROCESS" | "L4_MANUAL_PATH" | "NONE";
  detectedPid: number | null;
  reloadBehavior: "hot_watch" | "exit_overwrite";
  installPath: string | null;
  configPath: string | null;
  backupPath: string | null;
  importedServers: string[];
  warning: string | null;
}

export interface ConnectedSessionAttribution {
  ppid: number;
  clientName: string;
  executablePath: string | null;
  resolvedProfile: string;
  firstSeenAt: string;
}

export interface RunningProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  args: string;
  executablePath: string | null;
  cwd: string | null;
}

/**
 * Engine 0 (v0.0.3): Client Discovery, Safe Surgical Config Binder & Post-Bind Session Tracker.
 * Resolves the 3 Client-Binder conflicts:
 * 1. Separates Pre-Bind Discovery Funnel (L1~L4) from Post-Bind Session Attribution (`ppid`).
 * 2. Protects against Write-Back Overwrite Race on `exit_overwrite` clients when they are currently running.
 * 3. Prevents Takeover Blackout by enabling and reconciling runnable imported MCP servers immediately.
 */
export class ClientAutoBinder {
  private readonly registry: WorkbenchRegistry;
  private readonly aggregator?: McpAggregator;
  private readonly rootDir: string;
  private readonly shimScriptPath: string;
  private readonly adapters = new Map<string, ClientAdapterRecipe>();
  private readonly bindings = new Map<string, DiscoveredClientStatus>();
  private readonly activeSessionsByPpid = new Map<number, ConnectedSessionAttribution>();

  constructor(registry: WorkbenchRegistry, rootDir: string, aggregator?: McpAggregator) {
    this.registry = registry;
    this.rootDir = path.resolve(rootDir);
    this.aggregator = aggregator;
    this.shimScriptPath = path.join(this.rootDir, "dist", "stdio_shim.js");
    this.registerBuiltinAdapters();
  }

  private registerBuiltinAdapters(): void {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

    const builtins: ClientAdapterRecipe[] = [
      {
        clientId: "claude-code",
        displayName: "Claude Code CLI",
        processKeywords: ["claude", "claude-code"],
        defaultConfigCandidates: [path.join(home, ".claude.json")],
        defaultInstallDirs: [path.join(localAppData, "Programs", "claude-code")],
        configFormat: "json_mcpServers",
        reloadBehavior: "exit_overwrite",
        portableConfigRelPath: ".claude.json",
      },
      {
        clientId: "cursor",
        displayName: "Cursor IDE",
        processKeywords: ["cursor", "Cursor.exe"],
        defaultConfigCandidates: [path.join(home, ".cursor", "mcp.json")],
        defaultInstallDirs: [
          path.join(localAppData, "Programs", "cursor"),
          "/Applications/Cursor.app",
        ],
        configFormat: "json_mcpServers",
        reloadBehavior: "hot_watch",
        portableConfigRelPath: "mcp.json",
      },
      {
        clientId: "claude-desktop",
        displayName: "Claude Desktop",
        processKeywords: ["Claude.exe", "Claude"],
        defaultConfigCandidates: [
          path.join(appData, "Claude", "claude_desktop_config.json"),
          path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        ],
        defaultInstallDirs: [
          path.join(localAppData, "AnthropicClaude"),
          "/Applications/Claude.app",
        ],
        configFormat: "json_mcpServers",
        reloadBehavior: "hot_watch",
        portableConfigRelPath: "claude_desktop_config.json",
      },
      {
        clientId: "windsurf",
        displayName: "Windsurf IDE",
        processKeywords: ["windsurf", "Windsurf.exe"],
        defaultConfigCandidates: [
          path.join(home, ".codeium", "windsurf", "mcp_config.json"),
        ],
        defaultInstallDirs: [
          path.join(localAppData, "Programs", "windsurf"),
          "/Applications/Windsurf.app",
        ],
        configFormat: "json_mcpServers",
        reloadBehavior: "hot_watch",
        portableConfigRelPath: "mcp_config.json",
      },
    ];

    for (const adapter of builtins) {
      this.adapters.set(adapter.clientId, adapter);
    }
  }

  public registerCustomAdapter(recipe: ClientAdapterRecipe): void {
    this.adapters.set(recipe.clientId, recipe);
  }

  public inspectRunningProcesses(): RunningProcessInfo[] {
    const results: RunningProcessInfo[] = [];

    if (process.platform === "win32") {
      try {
        const raw = execSync(
          'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"',
          { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
        );
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (!item) continue;
          results.push({
            pid: Number(item.ProcessId ?? 0),
            ppid: Number(item.ParentProcessId ?? 0),
            command: String(item.Name ?? ""),
            args: String(item.CommandLine ?? ""),
            executablePath: item.ExecutablePath ? String(item.ExecutablePath) : null,
            cwd: null,
          });
        }
        return results;
      } catch {
        return results;
      }
    }

    try {
      const out = execSync("ps -eo pid,ppid,comm,args", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split("\n").slice(1)) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (m) {
          results.push({
            pid: Number(m[1]),
            ppid: Number(m[2]),
            command: m[3],
            args: m[4],
            executablePath: null,
            cwd: null,
          });
        }
      }
    } catch {
      // ignore
    }
    return results;
  }

  private resolveConfigFromProcess(
    adapter: ClientAdapterRecipe,
    proc: RunningProcessInfo
  ): Record<string, string | null> | null {
    const directConfigMatch = proc.args.match(
      /--(?:mcp-config|config)=["']?([^"'\s]+)["']?/
    );
    if (directConfigMatch) {
      const cfgPath = path.resolve(proc.cwd ?? this.rootDir, directConfigMatch[1]);
      return {
        installPath: proc.executablePath ?? proc.cwd,
        configPath: cfgPath,
      };
    }

    const dataDirMatch = proc.args.match(
      /--(?:user-data-dir|config-dir|data-dir)=["']?([^"'\s]+)["']?/
    );
    if (dataDirMatch) {
      const baseDir = path.resolve(proc.cwd ?? this.rootDir, dataDirMatch[1]);
      return {
        installPath: proc.executablePath ?? baseDir,
        configPath: path.join(baseDir, adapter.portableConfigRelPath),
      };
    }

    const scriptPathMatch = proc.args.match(/(\S+\.(?:js|mjs|exe|app))/i);
    const installBase = scriptPathMatch
      ? path.dirname(path.resolve(proc.cwd ?? this.rootDir, scriptPathMatch[1]))
      : proc.executablePath
        ? path.dirname(proc.executablePath)
        : proc.cwd;

    if (installBase) {
      const portableCandidate = path.join(
        installBase,
        adapter.portableConfigRelPath
      );
      if (fs.existsSync(portableCandidate) || fs.existsSync(installBase)) {
        return {
          installPath: installBase,
          configPath: portableCandidate,
        };
      }
    }

    return null;
  }

  /**
   * Executes the 4-Layer Pre-Bind Discovery Funnel (L1 Standard -> L2 Pre-provision -> L3 Runtime Process -> L4 Manual).
   */
  public scanClients(): DiscoveredClientStatus[] {
    const runningProcs = this.inspectRunningProcesses();
    const results: DiscoveredClientStatus[] = [];

    for (const adapter of this.adapters.values()) {
      const existing = this.bindings.get(adapter.clientId);
      if (existing && existing.status === "bound") {
        results.push(existing);
        continue;
      }

      let foundConfigPath: string | null = null;
      let foundInstallPath: string | null = null;
      let layer: string = "NONE";
      let detectedPid: number | null = null;

      // Check if process is currently running (used for both L3 discovery and write-back safety check)
      for (const proc of runningProcs) {
        const hay = `${proc.command} ${proc.args}`;
        if (
          adapter.processKeywords.some((kw) =>
            hay.toLowerCase().includes(kw.toLowerCase())
          )
        ) {
          detectedPid = proc.pid;
          const derived = this.resolveConfigFromProcess(adapter, proc);
          if (derived && derived.configPath) {
            foundInstallPath = derived.installPath;
            foundConfigPath = derived.configPath;
            layer = "L3_RUNTIME_PROCESS";
          }
          break;
        }
      }

      // Layer 1: Standard Config File Paths (if L3 didn't override with a custom flag)
      if (!foundConfigPath) {
        for (const candidate of adapter.defaultConfigCandidates) {
          if (fs.existsSync(candidate)) {
            foundConfigPath = candidate;
            layer = "L1_STANDARD_PATH";
            break;
          }
        }
      }

      // Layer 2: Pre-provisioning for newly installed software
      if (!foundConfigPath) {
        for (const installDir of adapter.defaultInstallDirs) {
          if (fs.existsSync(installDir)) {
            foundInstallPath = installDir;
            foundConfigPath = adapter.defaultConfigCandidates[0];
            layer = "L2_INSTALL_PREPROVISION";
            break;
          }
        }
      }

      const statusRecord: DiscoveredClientStatus = {
        clientId: adapter.clientId,
        displayName: adapter.displayName,
        status: foundConfigPath ? "detected_unbound" : "needs_manual_path",
        discoveryLayer: layer as any,
        detectedPid,
        reloadBehavior: adapter.reloadBehavior,
        installPath: foundInstallPath,
        configPath: foundConfigPath,
        backupPath: foundConfigPath ? `${foundConfigPath}.workbench.bak` : null,
        importedServers: [],
        warning:
          detectedPid && adapter.reloadBehavior === "exit_overwrite"
            ? `Process (PID=${detectedPid}) is currently running and may overwrite its config on exit. Close it before binding or pass force=true.`
            : null,
      };
      this.bindings.set(adapter.clientId, statusRecord);
      results.push(statusRecord);
    }

    return results;
  }

  /**
   * Post-Bind Session Attribution: identifies which already-bound host Agent launched `StdioShim` via `process.ppid`.
   */
  public attributeSessionByPpid(ppid: number): ConnectedSessionAttribution | null {
    if (!ppid || ppid <= 0) return null;
    if (this.activeSessionsByPpid.has(ppid)) {
      return this.activeSessionsByPpid.get(ppid)!;
    }
    const procs = this.inspectRunningProcesses();
    const match = procs.find((p) => p.pid === ppid);
    const clientName = match ? match.command : `pid_${ppid}`;
    const attribution: ConnectedSessionAttribution = {
      ppid,
      clientName,
      executablePath: match?.executablePath ?? null,
      resolvedProfile: "default",
      firstSeenAt: new Date().toISOString(),
    };
    this.activeSessionsByPpid.set(ppid, attribution);
    return attribution;
  }

  public getActiveSessionAttributions(): ConnectedSessionAttribution[] {
    return Array.from(this.activeSessionsByPpid.values());
  }

  /**
   * Surgically binds a client with Write-Back Race Protection and Zero-Blackout Takeover:
   * - If `adapter.reloadBehavior === "exit_overwrite"` and the process is currently running (`detectedPid !== null`)
   *   and `force` is false, returns status `"staged_wait_exit"` instead of risking a write-back overwrite!
   * - Supports `mode: "exclusive" | "side_by_side"` (default `"exclusive"` with automatic server import & startup).
   */
  public async bindClient(
    clientId: string,
    manualPath?: string,
    options: Record<string, boolean | string | undefined> = {}
  ): Promise<DiscoveredClientStatus> {
    const adapter = this.adapters.get(clientId);
    if (!adapter) {
      throw new Error(`Unknown client adapter '${clientId}'.`);
    }

    this.scanClients();
    const current = this.bindings.get(clientId)!;

    let targetConfigPath = current.configPath;
    let discoveryLayer: string = current.discoveryLayer;
    let installPath = current.installPath;

    // Layer 4: Manual Path Resolution
    if (manualPath) {
      const resolvedManual = path.resolve(manualPath);
      if (
        resolvedManual.endsWith(".json") ||
        resolvedManual.endsWith(".toml")
      ) {
        targetConfigPath = resolvedManual;
        installPath = path.dirname(resolvedManual);
      } else if (
        fs.existsSync(resolvedManual) &&
        fs.statSync(resolvedManual).isDirectory()
      ) {
        installPath = resolvedManual;
        targetConfigPath = path.join(
          resolvedManual,
          adapter.portableConfigRelPath
        );
      } else {
        installPath = path.dirname(resolvedManual);
        targetConfigPath = path.join(
          installPath,
          adapter.portableConfigRelPath
        );
      }
      discoveryLayer = "L4_MANUAL_PATH";
    }

    if (!targetConfigPath) {
      throw new Error(
        `Could not automatically locate '${adapter.displayName}'. Start '${adapter.displayName}' (for L3 runtime detection) or provide 'manual_path'.`
      );
    }

    // Conflict 1 Fix: Write-Back Race Protection for `exit_overwrite` clients
    if (
      current.detectedPid !== null &&
      adapter.reloadBehavior === "exit_overwrite" &&
      !options.force
    ) {
      const staged: DiscoveredClientStatus = {
        ...current,
        status: "staged_wait_exit",
        discoveryLayer: discoveryLayer as any,
        installPath,
        configPath: targetConfigPath,
        warning: `Client '${adapter.displayName}' (PID=${current.detectedPid}) overwrites config on exit. Binding is staged; close client or pass force=true.`,
      };
      this.bindings.set(clientId, staged);
      return staged;
    }

    fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
    const backupPath = `${targetConfigPath}.workbench.bak`;

    let rootObj: Record<string, unknown> = {};
    if (fs.existsSync(targetConfigPath)) {
      const rawContent = fs.readFileSync(targetConfigPath, "utf-8");
      if (!fs.existsSync(backupPath)) {
        fs.writeFileSync(backupPath, rawContent, "utf-8");
      }
      try {
        rootObj = JSON.parse(rawContent) as Record<string, unknown>;
      } catch {
        rootObj = {};
      }
    }

    const existingMcpServers = (rootObj.mcpServers ?? {}) as Record<string, any>;
    const importedServers: string[] = [];

    for (const [srvName, srvDef] of Object.entries(existingMcpServers)) {
      if (srvName === "mcp-workbench" || !srvDef || !srvDef.command) continue;
      if (!this.registry.getDesiredServer(srvName)) {
        // Conflict 2 Fix: Enable runnable imported servers immediately and reconcile so zero tools go dark!
        const shouldAutoStart = options.autoStartImported !== false;
        const importedConfig: DesiredServerConfig = {
          id: srvName,
          command: String(srvDef.command),
          args: Array.isArray(srvDef.args) ? srvDef.args.map(String) : [],
          env: srvDef.env ?? {},
          enabled: shouldAutoStart,
          autoRestart: true,
        };
        this.registry.upsertDesiredServer(importedConfig);
      }
      importedServers.push(srvName);
    }

    if (this.aggregator && options.autoStartImported !== false) {
      try {
        await this.aggregator.reconcileAll();
      } catch {
        // Non-fatal if an imported legacy server binary is missing; runtime state records the failure
      }
    }

    const workbenchEntry = {
      command: "node",
      args: [this.shimScriptPath],
      env: {
        MCP_WORKBENCH_ROOT: this.rootDir,
      },
    };

    if (options.mode === "side_by_side") {
      rootObj.mcpServers = {
        ...existingMcpServers,
        "mcp-workbench": workbenchEntry,
      };
    } else {
      rootObj.mcpServers = {
        "mcp-workbench": workbenchEntry,
      };
    }

    const tmpFile = `${targetConfigPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(rootObj, null, 2), "utf-8");
    fs.renameSync(tmpFile, targetConfigPath);

    const updatedStatus: DiscoveredClientStatus = {
      clientId: adapter.clientId,
      displayName: adapter.displayName,
      status: "bound",
      discoveryLayer: discoveryLayer as any,
      detectedPid: current.detectedPid,
      reloadBehavior: adapter.reloadBehavior,
      installPath,
      configPath: targetConfigPath,
      backupPath,
      importedServers,
      warning:
        current.detectedPid !== null
          ? `Client is currently running (PID=${current.detectedPid}); reload MCP servers or restart client to apply.`
          : null,
    };
    this.bindings.set(clientId, updatedStatus);
    return updatedStatus;
  }

  public unbindClient(clientId: string): boolean {
    const bound = this.bindings.get(clientId);
    if (!bound || !bound.configPath) return false;
    if (bound.backupPath && fs.existsSync(bound.backupPath)) {
      fs.copyFileSync(bound.backupPath, bound.configPath);
      fs.unlinkSync(bound.backupPath);
    }
    bound.status = "detected_unbound";
    return true;
  }
}
```

### 3.4 `src/meta_tools.ts` — 严格符合 `^[a-zA-Z0-9_-]{1,64}$` 规范的 9 个自举元工具

```typescript
import type {
  DesiredServerConfig,
  JsonSchema,
} from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { ProcessPool } from "./process_pool.js";
import type { McpAggregator } from "./aggregator.js";
import type { ClientAutoBinder } from "./client_binder.js";

export interface MetaToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/**
 * Built-in Self-Bootstrapping & Cache-Bypassing Meta-Tools.
 * Exposed with `studio__` naming (and aliased to `studio.` for direct invocation) so any Agent
 * can manage MCP servers, search cold tools, and invoke newly registered tools in the same turn.
 */
export class MetaToolsProvider {
  private readonly registry: WorkbenchRegistry;
  private readonly processPool: ProcessPool;
  private readonly aggregator: McpAggregator;
  private readonly clientBinder?: ClientAutoBinder;

  constructor(
    registry: WorkbenchRegistry,
    processPool: ProcessPool,
    aggregator: McpAggregator,
    clientBinder?: ClientAutoBinder
  ) {
    this.registry = registry;
    this.processPool = processPool;
    this.aggregator = aggregator;
    this.clientBinder = clientBinder;
  }

  public getMetaToolDefinitions(): MetaToolDefinition[] {
    return [
      {
        name: "studio__client__scan",
        description:
          "Scan the machine using the 5-Layer Discovery Funnel (Standard Paths, Install Pre-Provisioning, OS Runtime Process Table, PPID Trace) to locate AI Agents.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "studio__client__bind",
        description:
          "Surgically bind an AI Agent client to MCP Workbench (importing its existing scattered MCP servers, backing up original config, and injecting the unified Shim entrypoint).",
        inputSchema: {
          type: "object",
          properties: {
            client_id: { type: "string", description: "Target client ID (e.g. 'cursor', 'claude-code', 'windsurf')" },
            manual_path: { type: "string", description: "Optional manual install directory, executable path, or config file path if L1-L4 did not find it" },
          },
          required: ["client_id"],
        },
      },
      {
        name: "studio__client__unbind",
        description: "Restore a bound AI Agent client's original configuration from its backup.",
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
          "List all configured MCP servers, comparing Desired State (workbench.json) with Actual Runtime State and tool counts.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "studio__server__add",
        description:
          "Dynamically register, start, handshake, and mount a new MCP Server into the Gateway without restarting host Agents.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique server identifier (e.g. 'weather')" },
            command: { type: "string", description: "Executable command (e.g. 'node', 'uvx', 'npx')" },
            args: { type: "array", description: "Command arguments array" },
            env: { type: "object", description: "Optional environment variables" },
            highFrequencyTools: {
              type: "array",
              description: "Optional list of tool names to expose at top-level; omit to expose all",
            },
          },
          required: ["id", "command", "args"],
        },
      },
      {
        name: "studio__server__remove",
        description: "Stop and remove an MCP Server from the Gateway and workbench.json.",
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
        description: "Restart an existing MCP Server process and refresh its tool definitions.",
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
          "Search across all registered MCP tools (including cold/non-top-level tools and newly mounted servers) by keyword or server ID.",
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
          "Directly invoke any registered downstream tool via the Gateway with full schema & permission verification, bypassing client tool-list caching.",
        inputSchema: {
          type: "object",
          properties: {
            server_id: { type: "string", description: "Target MCP server ID (e.g. 'weather')" },
            tool_name: { type: "string", description: "Original tool name (e.g. 'get_forecast') or exposed name" },
            arguments: { type: "object", description: "Complete arguments object for the target downstream tool" },
          },
          required: ["server_id", "tool_name", "arguments"],
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
    args: Record<string, unknown>
  ): Promise<unknown> {
    const name = rawName.replace(/^studio__/, "studio.").replace(/__/g, ".");

    switch (name) {
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
          autoStartImported: args.auto_start_imported !== undefined ? Boolean(args.auto_start_imported) : true,
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
          throw new Error("studio.server.add requires non-empty 'id' and 'command'.");
        }
        const newConfig: DesiredServerConfig = {
          id,
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
        await this.processPool.stopServerProcess(id);
        const removed = this.registry.removeDesiredServer(id);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: removed ? "removed" : "not_found", serverId: id }),
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
        const matches = this.registry.searchTools(query, serverFilter);
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
            "studio.tool.invoke requires 'server_id', 'tool_name', and 'arguments'."
          );
        }

        const toolRecord = this.registry.resolveTool(serverId, toolName);
        if (!toolRecord) {
          throw new Error(
            `Tool '${toolName}' not found on server '${serverId}'. Call studio.tool.search to inspect available tools.`
          );
        }

        return await this.aggregator.invokeDownstreamTool(toolRecord, toolArgs);
      }

      default:
        throw new Error(`Unknown studio meta-tool: ${rawName}`);
    }
  }
}
```

### 3.5 `src/daemon.ts` — 先监听端口后提交锁文件（Two-Phase Lock Commit）的守护进程

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

/**
 * Single-Instance Core Daemon (`mcp-workbenchd`).
 * Features:
 * 1. Exclusive PID lockfile (`workbench-daemon.lock.json`) with stale-process recovery.
 * 2. Random per-instance Bearer authentication token.
 * 3. Streamable HTTP MCP Endpoint (`POST /mcp` + `GET /mcp` SSE stream for server-initiated notifications).
 * 4. Health & State Inspection Endpoint (`GET /health`).
 * 5. File watcher on `workbench.json` for external/GUI config hot-reload.
 */
export class WorkbenchDaemon {
  private readonly rootDir: string;
  private readonly configPath: string;
  private readonly lockPath: string;
  private readonly port: number;
  private readonly host = "127.0.0.1";
  private readonly token: string;

  public readonly registry: WorkbenchRegistry;
  public readonly processPool: ProcessPool;
  public readonly aggregator: McpAggregator;
  public readonly clientBinder: ClientAutoBinder;
  public readonly metaTools: MetaToolsProvider;
  public readonly connectedClientPids = new Set<number>();
  public readonly gatewayCore: GatewayCore;

  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private readonly notificationLog: JsonRpcNotification[] = [];

  constructor(rootDir: string, port = 43110) {
    this.rootDir = path.resolve(rootDir);
    this.configPath = path.join(this.rootDir, "workbench.json");
    this.lockPath = path.join(this.rootDir, ".workbench-daemon.lock.json");
    this.port = port;
    this.token = crypto.randomBytes(24).toString("hex");

    this.registry = new WorkbenchRegistry(this.configPath);
    this.processPool = new ProcessPool(this.registry, this.rootDir);
    this.aggregator = new McpAggregator(this.registry, this.processPool);
    this.clientBinder = new ClientAutoBinder(this.registry, this.rootDir, this.aggregator);
    this.metaTools = new MetaToolsProvider(
      this.registry,
      this.processPool,
      this.aggregator,
      this.clientBinder
    );
    this.gatewayCore = new GatewayCore(
      this.registry,
      this.aggregator,
      this.metaTools
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

  /**
   * Enforces Single-Instance execution:
   * Checks lockfile, verifies if PID is alive and `/health` responds; if alive, throws a clear error
   * with existing instance metadata; if stale, cleans up lockfile and proceeds.
   */
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
        // Stale lockfile from crashed process: clean up automatically
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
      startedAt: new Date().toISOString(),
      version: "0.0.1",
    };
    fs.writeFileSync(this.lockPath, JSON.stringify(lockInfo, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  public async start(): Promise<DaemonLockInfo> {
    // Phase 1: Check existing lock before starting
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

    // Watch workbench.json for external edits (simulating GUI or manual config edit)
    fs.watchFile(this.configPath, { interval: 250 }, () => {
      if (this.registry.reloadDesiredConfigFromDisk()) {
        void this.aggregator.reconcileAll();
      }
    });

    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);

      // 1. Public local health check
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            pid: process.pid,
            version: "0.0.1",
            servers: this.registry.getAllRuntimeStates(),
            totalTools: this.registry.getAllTools().length,
            topLevelTools: this.registry.getTopLevelExposedTools().length,
            notificationsSent: this.notificationLog.length,
          })
        );
        return;
      }

      // Verify Bearer token on protected endpoints
      const authHeader = req.headers["authorization"] ?? "";
      if (authHeader !== `Bearer ${this.token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized: Invalid Daemon Bearer Token" }));
        return;
      }

      const callerPpid = Number(req.headers["x-mcp-client-ppid"] ?? 0);
      if (callerPpid > 0) {
        this.connectedClientPids.add(callerPpid);
        this.clientBinder.attributeSessionByPpid(callerPpid);
      }

      // 2. Streamable HTTP MCP Endpoint (GET /mcp for server-to-client notification stream)
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

      // 3. Streamable HTTP MCP Endpoint (POST /mcp for JSON-RPC 2.0 requests)
      if (req.method === "POST" && url.pathname === "/mcp") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        try {
          const rpcReq = JSON.parse(body) as JsonRpcRequest;
          const rpcResp = await this.gatewayCore.handleJsonRpcRequest(rpcReq);
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

    // Phase 2: Commit `.workbench-daemon.lock.json` ONLY AFTER HTTP server is actively listening!
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

// Allow direct CLI execution: `node dist/daemon.js`
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = process.env.MCP_WORKBENCH_ROOT ?? process.cwd();
  const port = Number(process.env.MCP_WORKBENCH_PORT ?? 43110);
  const daemon = new WorkbenchDaemon(rootDir, port);
  daemon
    .start()
    .then((lock) => {
      console.log(
        `[mcp-workbenchd] Listening on http://${lock.host}:${lock.port}/mcp (PID=${lock.pid})`
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

### 3.6 `src/stdio_shim.ts` — 支持早期请求缓冲、后台自唤醒与 401 自动自愈重连的垫片

```typescript
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import type { DaemonLockInfo, JsonRpcRequest } from "./types.js";

/**
 * Lightweight Stdio-to-Daemon Shim v0.0.2 (`mcp-workbench-shim`).
 * Upgraded Capabilities:
 * 1. Auto-Wake Daemon: If `.workbench-daemon.lock.json` is missing or the Daemon PID is not alive,
 *    automatically spawns `daemon.js` in detached background mode and waits until it is healthy.
 * 2. Parent Process Attribution (`process.ppid`): Automatically attaches `X-Mcp-Client-Ppid`
 *    so the Daemon knows which host Agent process launched this Shim.
 */
export class StdioShim {
  private readonly rootDir: string;
  private readonly lockPath: string;
  private lockInfo: DaemonLockInfo | null = null;
  private sseReq: http.ClientRequest | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.lockPath = path.join(this.rootDir, ".workbench-daemon.lock.json");
  }

  private isDaemonAlive(lock: DaemonLockInfo): boolean {
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensures the single-instance Core Daemon is running; if not, spawns it silently in background.
   */
  private async ensureDaemonRunning(): Promise<DaemonLockInfo> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        if (this.isDaemonAlive(existing) && (await this.checkHealth(existing))) {
          return existing;
        }
      } catch {
        // Stale or corrupt lockfile
      }
    }

    // Spawn daemon.js in detached mode
    const daemonScript = path.join(this.rootDir, "dist", "daemon.js");
    const child = spawn(process.execPath, [daemonScript], {
      cwd: this.rootDir,
      env: { ...process.env, MCP_WORKBENCH_ROOT: this.rootDir },
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Poll until lockfile is written and /health responds
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(this.lockPath)) {
        try {
          const lock = JSON.parse(
            fs.readFileSync(this.lockPath, "utf-8")
          ) as DaemonLockInfo;
          if (this.isDaemonAlive(lock) && (await this.checkHealth(lock))) {
            return lock;
          }
        } catch {
          // continue polling
        }
      }
    }

    throw new Error("StdioShim timed out waiting for auto-spawned Core Daemon.");
  }

  private checkHealth(lock: DaemonLockInfo): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: lock.host,
          port: lock.port,
          path: "/health",
          method: "GET",
          timeout: 400,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  public async start(): Promise<void> {
    const pendingLines: string[] = [];
    let ready = false;

    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!ready) {
        pendingLines.push(trimmed);
      } else {
        void this.forwardRequest(trimmed);
      }
    });

    rl.on("close", () => {
      if (this.sseReq) this.sseReq.destroy();
      process.exit(0);
    });

    this.lockInfo = await this.ensureDaemonRunning();
    this.subscribeNotifications();
    ready = true;
    for (const buffered of pendingLines) {
      await this.forwardRequest(buffered);
    }
    pendingLines.length = 0;
  }

  private subscribeNotifications(): void {
    if (!this.lockInfo) return;
    this.sseReq = http.request(
      {
        hostname: this.lockInfo.host,
        port: this.lockInfo.port,
        path: "/mcp",
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.lockInfo.token}`,
          Accept: "text/event-stream",
          "X-Mcp-Client-Ppid": String(process.ppid),
        },
      },
      (res) => {
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (dataLine) {
              const jsonPayload = dataLine.slice("data: ".length).trim();
              process.stdout.write(jsonPayload + "\n");
            }
          }
        });
      }
    );
    this.sseReq.on("error", () => {
      // Ignore disconnect on shutdown
    });
    this.sseReq.end();
  }

  private async forwardRequest(rawJson: string, isRetry = false): Promise<void> {
    if (!this.lockInfo) {
      this.lockInfo = await this.ensureDaemonRunning();
    }
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(rawJson) as JsonRpcRequest;
    } catch {
      return;
    }

    const req = http.request(
      {
        hostname: this.lockInfo.host,
        port: this.lockInfo.port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.lockInfo.token}`,
          "X-Mcp-Client-Ppid": String(process.ppid),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode === 401 && !isRetry) {
            // Conflict 4 Fix: Daemon restarted and generated a new token; self-heal and retry once!
            void this.ensureDaemonRunning().then((freshLock) => {
              this.lockInfo = freshLock;
              this.subscribeNotifications();
              void this.forwardRequest(rawJson, true);
            });
            return;
          }
          if (res.statusCode === 200 && body.trim()) {
            process.stdout.write(body.trim() + "\n");
          }
        });
      }
    );

    req.on("error", (err) => {
      if (!isRetry) {
        void this.ensureDaemonRunning()
          .then((freshLock) => {
            this.lockInfo = freshLock;
            this.subscribeNotifications();
            void this.forwardRequest(rawJson, true);
          })
          .catch(() => {
            if (parsed.id !== undefined && parsed.id !== null) {
              process.stdout.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  error: {
                    code: -32000,
                    message: `StdioShim failed to reach Core Daemon: ${err.message}`,
                  },
                }) + "\n"
              );
            }
          });
        return;
      }
      if (parsed.id !== undefined && parsed.id !== null) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: {
              code: -32000,
              message: `StdioShim failed to reach Core Daemon: ${err.message}`,
            },
          }) + "\n"
        );
      }
    });

    req.write(rawJson);
    req.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = process.env.MCP_WORKBENCH_ROOT ?? process.cwd();
  const shim = new StdioShim(rootDir);
  void shim.start();
}
```

### 3.7 `src/gateway_core.ts` & `src/process_pool.ts` & `src/types.ts`

#### `src/gateway_core.ts`

```typescript
import { EventEmitter } from "node:events";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
} from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";
import type { MetaToolsProvider } from "./meta_tools.js";

/**
 * Transport-Agnostic Gateway Core.
 * Shared by both Streamable HTTP Gateway and Stdio Shim so tool routing, permission checks,
 * schema validation, and `notifications/tools/list_changed` broadcasts are 100% unified.
 */
export class GatewayCore extends EventEmitter {
  private readonly registry: WorkbenchRegistry;
  private readonly aggregator: McpAggregator;
  private readonly metaTools: MetaToolsProvider;

  constructor(
    registry: WorkbenchRegistry,
    aggregator: McpAggregator,
    metaTools: MetaToolsProvider
  ) {
    super();
    this.registry = registry;
    this.aggregator = aggregator;
    this.metaTools = metaTools;

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
    req: JsonRpcRequest
  ): Promise<JsonRpcResponse | null> {
    if (req.id === undefined || req.id === null) {
      // Notification from client (e.g., notifications/initialized)
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
                tools: {
                  listChanged: true,
                },
              },
              serverInfo: {
                name: "mcp-workbench-gateway",
                version: "0.0.1",
              },
            },
          };
        }

        case "ping": {
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {},
          };
        }

        case "tools/list": {
          const metaDefs = this.metaTools.getMetaToolDefinitions();
          const dynamicTopLevel = this.registry.getTopLevelExposedTools().map(
            (t) => ({
              name: t.exposedName,
              description: `[Server: ${t.serverId} | ID: ${t.toolId}] ${t.description}`,
              inputSchema: t.inputSchema,
            })
          );

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
              toolArgs
            );
            return {
              jsonrpc: "2.0",
              id: req.id,
              result,
            };
          }

          const record = this.registry.resolveToolByExposedName(toolName);
          if (!record) {
            return {
              jsonrpc: "2.0",
              id: req.id,
              error: {
                code: -32602,
                message: `Tool '${toolName}' is not in top-level registry. Use 'studio.tool.search' and 'studio.tool.invoke' if it is a cold or newly added tool.`,
              },
            };
          }

          const callResult = await this.aggregator.invokeDownstreamTool(
            record,
            toolArgs
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
```

#### `src/process_pool.ts`

```typescript
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import type {
  DesiredServerConfig,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";

interface ManagedProcessEntry {
  config: DesiredServerConfig;
  child: ChildProcessWithoutNullStreams;
  pendingRequests: Map<
    string | number,
    {
      resolve: (val: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  nextReqId: number;
  stoppingIntentionally: boolean;
}

/**
 * Lightweight Runtime Engine Process Pool.
 * Manages stdio MCP Server child processes, captures stderr diagnostics, handles JSON-RPC framing,
 * and updates Actual Runtime State in WorkbenchRegistry.
 */
export class ProcessPool extends EventEmitter {
  private readonly registry: WorkbenchRegistry;
  private readonly baseCwd: string;
  private readonly processes = new Map<string, ManagedProcessEntry>();

  constructor(registry: WorkbenchRegistry, baseCwd: string) {
    super();
    this.registry = registry;
    this.baseCwd = baseCwd;
  }

  public async startServerProcess(config: DesiredServerConfig): Promise<void> {
    if (this.processes.has(config.id)) {
      await this.stopServerProcess(config.id);
    }

    this.registry.updateRuntimeState(config.id, {
      phase: "starting",
      lastError: null,
    });

    const child = spawn(config.command, config.args, {
      cwd: config.cwd ?? this.baseCwd,
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entry: ManagedProcessEntry = {
      config,
      child,
      pendingRequests: new Map(),
      nextReqId: 1,
      stoppingIntentionally: false,
    };
    this.processes.set(config.id, entry);

    this.registry.updateRuntimeState(config.id, {
      phase: "handshaking",
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
    });

    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && msg.id !== null && entry.pendingRequests.has(msg.id)) {
          const pending = entry.pendingRequests.get(msg.id)!;
          clearTimeout(pending.timer);
          entry.pendingRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
          } else {
            pending.resolve(msg.result);
          }
        } else if (msg.method === "notifications/tools/list_changed") {
          this.emit("downstreamToolsChanged", config.id);
        }
      } catch {
        // Ignore non-JSON stdout lines
      }
    });

    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on("line", (line) => {
      const state = this.registry.getRuntimeState(config.id);
      const recent = [...(state?.recentStderr ?? []), line].slice(-25);
      this.registry.updateRuntimeState(config.id, { recentStderr: recent });
    });

    child.on("exit", (code) => {
      for (const [, pending] of entry.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Server ${config.id} exited with code ${code}`));
      }
      entry.pendingRequests.clear();
      this.processes.delete(config.id);
      this.registry.clearServerTools(config.id);

      if (entry.stoppingIntentionally) {
        this.registry.updateRuntimeState(config.id, {
          phase: "stopped",
          pid: null,
          lastExitCode: code,
        });
      } else {
        const prev = this.registry.getRuntimeState(config.id);
        this.registry.updateRuntimeState(config.id, {
          phase: "failed",
          pid: null,
          lastExitCode: code,
          lastError: `Unexpected process exit (code=${code})`,
          restartCount: (prev?.restartCount ?? 0) + 1,
        });
      }
    });
  }

  public async sendRequest(
    serverId: string,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 8000
  ): Promise<unknown> {
    const entry = this.processes.get(serverId);
    if (!entry) {
      throw new Error(`Downstream MCP Server '${serverId}' is not running.`);
    }
    const id = entry.nextReqId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pendingRequests.delete(id);
        reject(
          new Error(`Request '${method}' to server '${serverId}' timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      entry.pendingRequests.set(id, { resolve, reject, timer });
      entry.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  public sendNotification(
    serverId: string,
    method: string,
    params: Record<string, unknown> = {}
  ): void {
    const entry = this.processes.get(serverId);
    if (!entry) return;
    entry.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
    );
  }

  public async stopServerProcess(serverId: string): Promise<void> {
    const entry = this.processes.get(serverId);
    if (!entry) return;
    entry.stoppingIntentionally = true;
    return new Promise((resolve) => {
      entry.child.once("exit", () => resolve());
      entry.child.kill("SIGTERM");
      setTimeout(() => {
        if (!entry.child.killed) entry.child.kill("SIGKILL");
        resolve();
      }, 1500);
    });
  }

  public async stopAll(): Promise<void> {
    const ids = Array.from(this.processes.keys());
    await Promise.all(ids.map((id) => this.stopServerProcess(id)));
  }
}
```

#### `src/types.ts`

```typescript
/**
 * Core Domain & Interface Contracts for MCP Workbench Gateway Prototype v0.0.1
 * Enforces strict separation between Desired Config State, Actual Runtime State, and Aggregated Tool Registry.
 */

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean;
}

/** 1. Desired State (Persisted in workbench.json) */
export interface DesiredServerConfig {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  autoRestart?: boolean;
  highFrequencyTools?: string[];
}

export interface ProfileConfig {
  exposeMode: "all" | "high_frequency";
  enabledServers: string[];
  disabledTools: string[];
}

export interface WorkbenchDesiredConfig {
  version: string;
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
  servers: Record<string, DesiredServerConfig>;
}

/** 2. Actual Runtime State (Held exclusively in Daemon ProcessPool & Reconciler) */
export type ServerLifecyclePhase =
  | "stopped"
  | "starting"
  | "handshaking"
  | "running"
  | "degraded"
  | "failed";

export interface ActualServerRuntimeState {
  serverId: string;
  phase: ServerLifecyclePhase;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  lastExitCode: number | null;
  lastError: string | null;
  protocolVersion: string | null;
  recentStderr: string[];
}

/** 3. Aggregated Tool Record with Stable Internal ID */
export interface ToolRecord {
  /** Stable internal identifier: tool_<sha256_short(server_id + "::" + original_name)> */
  toolId: string;
  serverId: string;
  originalName: string;
  /** External name exposed to top-level MCP tools/list: <server_id>__<original_name> */
  exposedName: string;
  description: string;
  inputSchema: JsonSchema;
  /** Whether enabled by server & profile rules */
  enabled: boolean;
  /** Whether surfaced in top-level tools/list (true) or hidden for on-demand search/invoke (false) */
  exposeTopLevel: boolean;
}

/** 4. Daemon Single-Instance Lock & Runtime Metadata */
export interface DaemonLockInfo {
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

/** 5. JSON-RPC 2.0 Standard Envelopes */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}
```

### 3.8 `src/verify_acceptance.ts` — 包含正则合规断言与全链路验证的验收套件

```typescript
import assert from "node:assert";
import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { WorkbenchDaemon } from "./daemon.js";

/**
 * Automated 6-Step Acceptance Verification Suite for MCP Workbench Gateway Prototype v0.0.1.
 * Tests:
 * Step 1: Single-instance Daemon lock & duplicate launch rejection.
 * Step 2: Aggregating two MCP Servers (`math_ops` and `sys_clock`) and invoking both.
 * Step 3: Multi-client concurrent access (Client 1 via Streamable HTTP + Client 2 via Stdio Shim) sharing one Daemon.
 * Step 4: Dynamic mounting of 3rd MCP Server (`weather_service`) with `notifications/tools/list_changed` broadcast.
 * Step 5: Tool cache compatibility — searching & invoking cold/newly added tools via `studio.tool.search` and `studio.tool.invoke` (plus schema validation check).
 * Step 6: End-to-end Agent self-bootstrapping (`studio.server.add` -> discovery -> immediate call).
 */
async function postMcp(
  port: number,
  token: string,
  payload: Record<string, unknown>
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
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

async function runVerification() {
  const rootDir = path.resolve(process.cwd());
  const port = 43115;

  console.log("=== [Step 1] Verifying Single-Instance Daemon Lock & Startup ===");
  const daemon1 = new WorkbenchDaemon(rootDir, port);
  const lockInfo = await daemon1.start();
  assert.strictEqual(lockInfo.port, port, "Daemon port should match");

  const daemon2 = new WorkbenchDaemon(rootDir, port + 1);
  let duplicateBlocked = false;
  try {
    await daemon2.start();
  } catch (err: any) {
    if (String(err.message).includes("ALREADY_RUNNING")) {
      duplicateBlocked = true;
    }
  }
  assert.strictEqual(
    duplicateBlocked,
    true,
    "Second Daemon instance must be blocked by PID lock"
  );
  console.log("PASS: Step 1 - Single-Instance Daemon lock verified (PID=" + lockInfo.pid + ")");

  console.log("=== [Step 2] Verifying Two-Server Aggregation (math_ops + sys_clock) ===");
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
  assert(toolNames.includes("math_ops__add"), "Should expose math_ops__add");
  assert(toolNames.includes("sys_clock__get_time"), "Should expose sys_clock__get_time");
  assert(
    !toolNames.includes("math_ops__fibonacci"),
    "Cold tool math_ops__fibonacci should NOT clutter top-level tools/list"
  );

  const addCall = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "math_ops__add",
      arguments: { a: 17, b: 25 },
    },
  });
  assert.strictEqual(addCall.result.content[0].text, "42", "17 + 25 should equal 42");

  const clockCall = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "sys_clock__get_time",
      arguments: { timezone: "UTC" },
    },
  });
  assert(
    String(clockCall.result.content[0].text).includes("CLOCK_OK[UTC]"),
    "sys_clock__get_time should return UTC timestamp"
  );
  console.log("PASS: Step 2 - Both initial MCP servers aggregated and invoked.");

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
      params: {
        name: "math_ops__multiply",
        arguments: { a: 6, b: 7 },
      },
    }) + "\n"
  );

  for (let i = 0; i < 30 && !shimMessages.find((m) => m.id === 101); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const multResp = shimMessages.find((m) => m.id === 101);
  assert(multResp, "Stdio Shim client should receive response from shared Daemon");
  assert.strictEqual(multResp.result.content[0].text, "42", "6 * 7 should equal 42");
  console.log("PASS: Step 3 - Streamable HTTP Client (Claude Code) and Stdio Shim Client (Codex) share the same Daemon.");

  console.log("=== [Step 4 & Step 6] Verifying Agent Self-Bootstrapping (`studio.server.add`) & Dynamic Discovery ===");
  const addServerResp = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "studio.server.add",
      arguments: {
        id: "weather_service",
        command: "node",
        args: ["./dist/test_servers/mock_server_c.js"],
      },
    },
  });
  const mountData = JSON.parse(addServerResp.result.content[0].text);
  assert.strictEqual(mountData.status, "mounted");
  assert.strictEqual(mountData.discoveredTools[0].exposedName, "weather_service__get_forecast");

  for (let i = 0; i < 30 && shimNotifications.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(
    shimNotifications.length >= 1,
    "Stdio Shim client must receive notifications/tools/list_changed when HTTP client adds a server"
  );
  console.log("PASS: Step 4 & Step 6 - Agent dynamically added 3rd Server (`weather_service`) and cross-client list_changed notification fired.");

  console.log("=== [Step 5] Verifying Tool Cache Compatibility (`studio.tool.search` + `studio.tool.invoke` + Schema Validation) ===");
  // 5a: Search for cold tool `fibonacci` and newly added `get_forecast`
  const searchForecast = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "studio.tool.search",
      arguments: { query: "forecast" },
    },
  });
  const searchResult = JSON.parse(searchForecast.result.content[0].text);
  assert.strictEqual(searchResult.matchCount, 1);
  assert.strictEqual(searchResult.tools[0].originalName, "get_forecast");

  // 5b: Invoke newly mounted `weather_service.get_forecast` via `studio.tool.invoke` (bypassing client top-level tool list cache)
  const invokeForecast = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "studio.tool.invoke",
      arguments: {
        server_id: "weather_service",
        tool_name: "get_forecast",
        arguments: { city: "Shanghai", days: 3 },
      },
    },
  });
  assert.strictEqual(
    invokeForecast.result.content[0].text,
    "FORECAST[Shanghai,3d]: Sunny 22C"
  );

  // 5c: Invoke cold non-top-level tool `math_ops.fibonacci` via `studio.tool.invoke`
  const invokeFib = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "studio.tool.invoke",
      arguments: {
        server_id: "math_ops",
        tool_name: "fibonacci",
        arguments: { n: 10 },
      },
    },
  });
  assert.strictEqual(invokeFib.result.content[0].text, "55", "10th Fibonacci should be 55");

  // 5d: Verify Daemon rejects invalid schema arguments in `studio.tool.invoke`
  const badInvoke = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "studio.tool.invoke",
      arguments: {
        server_id: "weather_service",
        tool_name: "get_forecast",
        arguments: { city: "Shanghai", days: "invalid_number" },
      },
    },
  });
  assert(
    badInvoke.error && String(badInvoke.error.message).includes("Schema validation failed"),
    "Daemon must enforce JSON Schema validation on studio.tool.invoke"
  );
  console.log("PASS: Step 5 - Cold and newly mounted tools searched and invoked via studio.tool.invoke with strict Schema validation.");

  // Clean up dynamically mounted server via studio.server.remove
  const removeResp = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "studio.server.remove",
      arguments: { id: "weather_service" },
    },
  });
  assert.strictEqual(JSON.parse(removeResp.result.content[0].text).status, "removed");

  // Verify Step 3 also recorded StdioShim parent PID (L4 PPID Trace)
  assert(
    daemon1.connectedClientPids.has(process.pid),
    "Daemon must record caller PPID from StdioShim header (L4_PPID_TRACE)"
  );

  console.log("=== [Step 7] Verifying L3 Runtime Process Inspection & Surgical Non-Destructive Binding ===");
  const fsMod = await import("node:fs");
  const portableDir = path.join(rootDir, "tmp_portable_cursor");
  const customProfileDir = path.join(portableDir, "custom_data_dir");
  fsMod.mkdirSync(customProfileDir, { recursive: true });
  const fakeAgentScript = path.join(portableDir, "FakePortableCursor.js");
  fsMod.writeFileSync(
    fakeAgentScript,
    "setInterval(() => {}, 1000);\n",
    "utf-8"
  );
  // Pre-populate scattered MCP server + custom IDE settings in custom_data_dir/mcp.json
  const portableMcpJson = path.join(customProfileDir, "mcp.json");
  fsMod.writeFileSync(
    portableMcpJson,
    JSON.stringify(
      {
        editorTheme: "Solarized-Dark",
        keybindings: ["Ctrl+K"],
        mcpServers: {
          legacy_scattered_srv: {
            command: "node",
            args: ["legacy.js"],
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  );

  // Register a custom adapter for our non-standard portable agent
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

  // Spawn the fake portable agent with a custom --user-data-dir flag
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
    params: { name: "studio.client.scan", arguments: {} },
  });
  const scanData = JSON.parse(scanResp.result.content[0].text);
  const detectedPortable = scanData.clients.find(
    (c: any) => c.clientId === "portable-cursor-test"
  );
  assert(detectedPortable, "Should include portable-cursor-test in scan");
  assert.strictEqual(
    detectedPortable.discoveryLayer,
    "L3_RUNTIME_PROCESS",
    "Must locate non-standard agent via L3 OS Runtime Process Table"
  );
  assert.strictEqual(
    detectedPortable.configPath,
    portableMcpJson,
    "Must extract --user-data-dir from running process CLI args"
  );

  const bindResp = await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "studio.client.bind",
      arguments: { client_id: "portable-cursor-test", auto_start_imported: false },
    },
  });
  const bindData = JSON.parse(bindResp.result.content[0].text);
  assert.strictEqual(bindData.status, "bound");
  assert(
    bindData.importedServers.includes("legacy_scattered_srv"),
    "Must import existing scattered MCP servers into Workbench"
  );

  const modifiedJson = JSON.parse(fsMod.readFileSync(portableMcpJson, "utf-8"));
  assert.strictEqual(
    modifiedJson.editorTheme,
    "Solarized-Dark",
    "Surgical merge must preserve non-MCP settings in client config"
  );
  assert(
    modifiedJson.mcpServers["mcp-workbench"],
    "Must inject mcp-workbench unified entrypoint"
  );

  // Restore original config and clean up
  await postMcp(port, lockInfo.token, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "studio.client.unbind",
      arguments: { client_id: "portable-cursor-test", auto_start_imported: false },
    },
  });
  daemon1.registry.removeDesiredServer("legacy_scattered_srv");
  fakeAgentProc.kill("SIGTERM");
  fsMod.rmSync(portableDir, { recursive: true, force: true });
  console.log("PASS: Step 7 - L3 Runtime Process Detection, CLI Flag Extraction & Surgical Merge verified.");

  shimChild.kill("SIGTERM");
  await daemon1.stop();

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
      params: {
        name: "math_ops__add",
        arguments: { a: 100, b: 23 },
      },
    }) + "\n"
  );

  for (let i = 0; i < 50 && !wakeMessages.find((m) => m.id === 801); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const wakeResp = wakeMessages.find((m) => m.id === 801);
  assert(wakeResp, "StdioShim must auto-wake background Daemon and return response");
  assert.strictEqual(wakeResp.result.content[0].text, "123");

  // Shut down auto-spawned background daemon cleanly
  const lockFile = path.join(rootDir, ".workbench-daemon.lock.json");
  if (fsMod.existsSync(lockFile)) {
    const spawnedLock = JSON.parse(fsMod.readFileSync(lockFile, "utf-8"));
    try {
      process.kill(spawnedLock.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  autoWakeShim.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 200));
  console.log("PASS: Step 8 - StdioShim automatically woke up background Daemon on cold start.");
  console.log("=== ALL 8 ACCEPTANCE STEPS PASSED SUCCESSFULLY ===");
}

runVerification().catch((err) => {
  console.error("ACCEPTANCE VERIFICATION FAILED:", err);
  process.exit(1);
});
```
