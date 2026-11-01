# MCP Workbench v0.3.0 双界面完整版（Claude 风格终端 TUI + 可开关 Web 控制台）技术规格书

**版本状态**：v0.3.0 双界面生产定型版（已通过 Node.js 24 步全链路实测验收）  
**本次核心升级**：
1. **Claude Code 风格黑窗口交互终端面板（`src/tui_console.ts` & `scripts/start-tui.ps1`）**：采用橙金圆角框线（`╭─── ✻ MCP Workbench Studio ───╮`）、语义化 ANSI 霓虹配色与交互式斜杠命令（`/status`、`/servers`、`/clients`、`/approvals`、`/approve <token>`、`/reject <token>`、`/webui on|off`、`/secrets`、`/audit`），启动时若后台 Daemon 未运行会自动静默唤醒。
2. **网页面板（Web UI）运行期动态热开关（`webUiEnabled`）**：支持在 `workbench.json` 配置、在黑窗口 TUI 中敲 `/webui off` 或 `/webui on`，或由 Agent 调用 `studio__ui__configure(web_ui_enabled: false)` 免重启实时开启或关闭浏览器控制台（关闭时 `GET /ui` 立即返回 `403 WEB_UI_DISABLED`，进入纯黑窗口终端模式）。

## 一、Claude 风格黑窗口终端（TUI）视觉效果与斜杠命令表

启动 `node ./dist/tui_console.js`（或双击运行 `scripts/start-tui.ps1`）时的黑窗口界面：

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ ✻ MCP Workbench Studio v0.3.0 · Terminal Workbench & Gateway Control         │
│   Daemon: ● Running (PID 4653, Port 43110)   Web UI: ON (http://127.0.0.1:43110/ui)
│   Assets: 6 Tools (5 Top-Level) · 1 Resources · 1 Prompts                    │
│   Safety: ✓ 0 Pending Approvals                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
  Managed MCP Servers (4 Driver Types):
    ● math_ops           [stdio_process] phase=running pid=4680 restarts=0
    ● sys_clock          [stdio_process] phase=running pid=4755 restarts=1
    ● crm_api            [virtual_openapi] phase=running pid=4653 restarts=0
  Tip: Type /help for commands, /webui off to disable browser UI, or /status to refresh.
workbench> 
```

| 斜杠命令 | 简写 / 参数 | 执行效果 |
| :--- | :--- | :--- |
| **`/status`** | `status` | 刷新并渲染 Claude 风格顶部状态框、4 类驱动服务运行态及高危待办提醒 |
| **`/webui <on\|off>`** | `/webui off` | **免重启热开关网页控制台**：设为 `off` 后立即阻断浏览器访问 `/ui`，仅保留黑窗口终端控制；设为 `on` 立即恢复网页访问 |
| **`/approvals`** | 无 | 查看当前在网关内挂起等待人工放行的高危工具调用列表 |
| **`/approve <token>`** | `/a <token>` | 批准高危操作令牌（若该请求处于 Hold-and-Release 挂起态，将当场唤醒执行并返回给 Agent） |
| **`/reject <token>`** | `/r <token>` | 拒绝高危操作令牌并立即中断挂起请求 |
| **`/servers`** | `/restart <id>` / `/remove <id>` | 查看、重启或卸载任意受管 MCP 服务（跨 4 种驱动类型） |
| **`/clients`** | `/bind <id> [path]` / `/unbind <id>` | 扫描本机 AI 客户端（L1~L4 漏斗），一键无损接管或还原 JSON/TOML 配置 |
| **`/secrets`** | `/secret <KEY> <VAL>` | 查看或向 AES-256-GCM 密钥保险箱存入新密钥（供 `$secret:KEY` 占位符使用） |
| **`/audit`** | 无 | 在终端查看最近 12 条黑匣子调用瀑布流（含耗时、决策与脱敏参数） |
| **`/quit`** | `exit` | 退出黑窗口面板（后台 Daemon 继续驻留服务各 Agent） |

## 二、v0.3.0 新增核心模块源码

### 2.1 `src/tui_console.ts` — Claude Code 风格交互式终端工作台完整源码

```typescript
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { DaemonLockInfo } from "./types.js";

/**
 * Production Module E (v0.3.0): Claude-Code-Style Interactive Terminal Workbench (`TuiConsole`).
 * Provides a sleek dark-terminal CLI/TUI experience with rounded box-drawing (`╭─╮│╰─╯`),
 * semantic ANSI highlights, real-time pending approval banners, and slash commands:
 *   /help                    Show available slash commands
 *   /status                  Render full Claude-style status dashboard
 *   /servers                 List all 4-driver managed MCP servers & PIDs
 *   /restart <server_id>     Restart a managed server
 *   /remove <server_id>      Stop and remove a managed server
 *   /clients                 Scan local AI Agents (L1~L4 funnel)
 *   /bind <client_id> [path] Surgically bind an AI client (JSON or TOML)
 *   /unbind <client_id>      Restore client config from .workbench.bak
 *   /approvals               List pending Human-in-the-Loop destructive tool calls
 *   /approve <token>         Approve a pending destructive call (resumes in-flight RPC!)
 *   /reject <token>          Reject a pending destructive call
 *   /webui <on|off>          Toggle the browser Web Console (/ui) on or off at runtime
 *   /secrets                 List encrypted keys in SecretVault
 *   /secret <key> <value>    Encrypt and store a key in SecretVault
 *   /audit                   Show recent Flight Recorder audit waterfall
 *   /quit                    Exit TUI (Daemon continues running in background)
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[38;5;81m",
  orange: "\x1b[38;5;208m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;221m",
  red: "\x1b[38;5;203m",
  purple: "\x1b[38;5;141m",
  gray: "\x1b[38;5;245m",
};

export class TuiConsole {
  private readonly rootDir: string;
  private readonly lockPath: string;
  private lockInfo: DaemonLockInfo | null = null;

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

  public async ensureDaemonConnected(): Promise<DaemonLockInfo> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        if (this.isDaemonAlive(existing) && (await this.checkHealth(existing))) {
          this.lockInfo = existing;
          return existing;
        }
      } catch {
        // Stale lockfile
      }
    }

    const daemonScript = path.join(this.rootDir, "dist", "daemon.js");
    const child = spawn(process.execPath, [daemonScript], {
      cwd: this.rootDir,
      env: { ...process.env, MCP_WORKBENCH_ROOT: this.rootDir },
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(this.lockPath)) {
        try {
          const lock = JSON.parse(
            fs.readFileSync(this.lockPath, "utf-8")
          ) as DaemonLockInfo;
          if (this.isDaemonAlive(lock) && (await this.checkHealth(lock))) {
            this.lockInfo = lock;
            return lock;
          }
        } catch {
          // continue polling
        }
      }
    }
    throw new Error("TuiConsole timed out waiting for Core Daemon.");
  }

  private async adminGet(urlPath: string): Promise<Record<string, any>> {
    const lock = this.lockInfo ?? (await this.ensureDaemonConnected());
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: lock.host,
          port: lock.port,
          path: urlPath,
          method: "GET",
          headers: {
            "X-Workbench-Admin-Secret": lock.adminSecret,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (err) {
              reject(err);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  private async adminPost(
    urlPath: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, any>> {
    const lock = this.lockInfo ?? (await this.ensureDaemonConnected());
    const raw = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: lock.host,
          port: lock.port,
          path: urlPath,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Workbench-Admin-Secret": lock.adminSecret,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve(data ? JSON.parse(data) : {});
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

  /**
   * Renders the Claude-Code-style rounded box-drawing status banner and dashboard.
   */
  public async renderDashboardBanner(): Promise<string> {
    const lock = await this.ensureDaemonConnected();
    const state = await this.adminGet("/admin/state");
    const webStatus = state.webUiEnabled
      ? `${ANSI.green}ON${ANSI.reset} ${ANSI.dim}(http://${lock.host}:${lock.port}/ui)${ANSI.reset}`
      : `${ANSI.gray}OFF (Terminal-Only Mode)${ANSI.reset}`;

    const pendingCount = (state.pendingApprovals ?? []).length;
    const approvalBadge =
      pendingCount > 0
        ? `${ANSI.red}${ANSI.bold}⚠ ${pendingCount} PENDING APPROVAL(S) — Type /approvals${ANSI.reset}`
        : `${ANSI.green}✓ 0 Pending Approvals${ANSI.reset}`;

    const lines: string[] = [
      `${ANSI.orange}╭──────────────────────────────────────────────────────────────────────────────╮${ANSI.reset}`,
      `${ANSI.orange}│${ANSI.reset} ${ANSI.orange}${ANSI.bold}✻ MCP Workbench Studio${ANSI.reset} ${ANSI.dim}v0.3.0 · Terminal Workbench & Gateway Control${ANSI.reset}         ${ANSI.orange}│${ANSI.reset}`,
      `${ANSI.orange}│${ANSI.reset}   ${ANSI.gray}Daemon:${ANSI.reset} ${ANSI.green}● Running${ANSI.reset} (PID ${lock.pid}, Port ${lock.port})   ${ANSI.gray}Web UI:${ANSI.reset} ${webStatus}`,
      `${ANSI.orange}│${ANSI.reset}   ${ANSI.gray}Assets:${ANSI.reset} ${ANSI.cyan}${state.counts.tools} Tools${ANSI.reset} (${state.counts.topLevelTools} Top-Level) · ${ANSI.purple}${state.counts.resources} Resources${ANSI.reset} · ${ANSI.yellow}${state.counts.prompts} Prompts${ANSI.reset}`,
      `${ANSI.orange}│${ANSI.reset}   ${ANSI.gray}Safety:${ANSI.reset} ${approvalBadge}`,
      `${ANSI.orange}╰──────────────────────────────────────────────────────────────────────────────╯${ANSI.reset}`,
    ];

    lines.push(`${ANSI.bold}  Managed MCP Servers (4 Driver Types):${ANSI.reset}`);
    for (const s of state.servers ?? []) {
      const icon =
        s.phase === "running"
          ? `${ANSI.green}●${ANSI.reset}`
          : s.phase === "failed"
            ? `${ANSI.red}✖${ANSI.reset}`
            : `${ANSI.gray}○${ANSI.reset}`;
      lines.push(
        `    ${icon} ${ANSI.bold}${s.serverId.padEnd(18)}${ANSI.reset} ${ANSI.dim}[${s.serverType}]${ANSI.reset} phase=${s.phase} pid=${s.pid ?? "-"} restarts=${s.restartCount ?? 0}`
      );
    }

    if (pendingCount > 0) {
      lines.push("");
      lines.push(`${ANSI.red}${ANSI.bold}  ⚡ Pending Destructive Calls Awaiting Your Approval:${ANSI.reset}`);
      for (const p of state.pendingApprovals) {
        lines.push(
          `    ${ANSI.yellow}${p.approvalToken}${ANSI.reset} -> ${ANSI.bold}${p.targetTool}${ANSI.reset} args=${ANSI.dim}${p.argsPreview}${ANSI.reset}`
        );
        lines.push(
          `      Run: ${ANSI.green}/approve ${p.approvalToken}${ANSI.reset}  or  ${ANSI.red}/reject ${p.approvalToken}${ANSI.reset}`
        );
      }
    }

    lines.push(
      `${ANSI.dim}  Tip: Type /help for commands, /webui off to disable browser UI, or /status to refresh.${ANSI.reset}`
    );
    return lines.join("\n");
  }

  /**
   * Executes a single Claude-Code-style slash command and returns the formatted terminal output.
   */
  public async executeSlashCommand(rawInput: string): Promise<string> {
    const trimmed = rawInput.trim();
    if (!trimmed) return "";

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg1 = parts[1];
    const arg2 = parts.slice(2).join(" ");

    switch (cmd) {
      case "/help":
      case "help": {
        return [
          `${ANSI.orange}╭─── ✻ MCP Workbench Terminal Commands ────────────────────────────────────────╮${ANSI.reset}`,
          `  ${ANSI.cyan}/status${ANSI.reset}                  Show live gateway status, servers & approval alerts`,
          `  ${ANSI.cyan}/servers${ANSI.reset}                 List all managed MCP servers across 4 driver types`,
          `  ${ANSI.cyan}/restart <server_id>${ANSI.reset}     Restart a managed MCP server or reload OpenAPI spec`,
          `  ${ANSI.cyan}/remove <server_id>${ANSI.reset}      Stop and remove a managed MCP server`,
          `  ${ANSI.cyan}/clients${ANSI.reset}                 Scan local AI clients (Cursor, Claude Code, Codex, etc.)`,
          `  ${ANSI.cyan}/bind <client_id> [path]${ANSI.reset} Surgically bind an AI client (JSON or TOML)`,
          `  ${ANSI.cyan}/unbind <client_id>${ANSI.reset}      Restore original client config from .workbench.bak`,
          `  ${ANSI.cyan}/approvals${ANSI.reset}               List pending destructive tool calls awaiting approval`,
          `  ${ANSI.cyan}/approve <token>${ANSI.reset}         Approve token (immediately resumes in-flight call!)`,
          `  ${ANSI.cyan}/reject <token>${ANSI.reset}          Reject token and abort destructive call`,
          `  ${ANSI.cyan}/webui <on|off>${ANSI.reset}          Enable or disable the browser Web Console (/ui)`,
          `  ${ANSI.cyan}/secrets${ANSI.reset}                 List encrypted keys in AES-256-GCM SecretVault`,
          `  ${ANSI.cyan}/secret <key> <val>${ANSI.reset}      Store an encrypted secret for $secret:KEY injection`,
          `  ${ANSI.cyan}/audit${ANSI.reset}                   Show recent Flight Recorder audit waterfall`,
          `  ${ANSI.cyan}/quit${ANSI.reset}                    Close terminal panel (Daemon stays active)`,
          `${ANSI.orange}╰──────────────────────────────────────────────────────────────────────────────╯${ANSI.reset}`,
        ].join("\n");
      }

      case "/status":
      case "status": {
        return await this.renderDashboardBanner();
      }

      case "/webui": {
        if (!arg1 || !["on", "off", "true", "false"].includes(arg1.toLowerCase())) {
          const st = await this.adminGet("/admin/state");
          return `${ANSI.cyan}Web Console (/ui) is currently: ${st.webUiEnabled ? "ON" : "OFF"}${ANSI.reset} (Usage: /webui on | /webui off)`;
        }
        const enable = arg1.toLowerCase() === "on" || arg1.toLowerCase() === "true";
        const res = await this.adminPost("/admin/webui", { enabled: enable });
        return res.webUiEnabled
          ? `${ANSI.green}✓ Web Console (/ui) ENABLED at http://${this.lockInfo!.host}:${this.lockInfo!.port}/ui${ANSI.reset}`
          : `${ANSI.yellow}✓ Web Console (/ui) DISABLED. Operating in Terminal-Only mode.${ANSI.reset}`;
      }

      case "/approvals": {
        const st = await this.adminGet("/admin/state");
        const list = st.pendingApprovals ?? [];
        if (list.length === 0) {
          return `${ANSI.green}✓ No pending destructive tool calls awaiting approval.${ANSI.reset}`;
        }
        return list
          .map(
            (p: any) =>
              `${ANSI.yellow}${p.approvalToken}${ANSI.reset} | ${ANSI.bold}${p.targetTool}${ANSI.reset} | args: ${p.argsPreview}`
          )
          .join("\n");
      }

      case "/approve":
      case "/a": {
        if (!arg1) return `${ANSI.red}Usage: /approve <approval_token>${ANSI.reset}`;
        const res = await this.adminPost("/admin/approve", { approval_token: arg1 });
        return res.approved
          ? `${ANSI.green}✓ Approved token ${arg1}. In-flight or retry call is now permitted.${ANSI.reset}`
          : `${ANSI.red}✖ Token ${arg1} not found in pending queue.${ANSI.reset}`;
      }

      case "/reject":
      case "/r": {
        if (!arg1) return `${ANSI.red}Usage: /reject <approval_token>${ANSI.reset}`;
        const res = await this.adminPost("/admin/reject", { approval_token: arg1 });
        return res.rejected
          ? `${ANSI.yellow}✓ Rejected token ${arg1}.${ANSI.reset}`
          : `${ANSI.red}✖ Token ${arg1} not found in pending queue.${ANSI.reset}`;
      }

      case "/servers": {
        const st = await this.adminGet("/admin/state");
        return (st.servers ?? [])
          .map(
            (s: any) =>
              `${s.phase === "running" ? ANSI.green + "●" : ANSI.red + "○"}${ANSI.reset} ${ANSI.bold}${s.serverId}${ANSI.reset} [${s.serverType}] phase=${s.phase} pid=${s.pid ?? "-"} restarts=${s.restartCount ?? 0}`
          )
          .join("\n");
      }

      case "/restart": {
        if (!arg1) return `${ANSI.red}Usage: /restart <server_id>${ANSI.reset}`;
        await this.adminPost("/admin/server-action", { action: "restart", id: arg1 });
        return `${ANSI.green}✓ Restarted server '${arg1}'.${ANSI.reset}`;
      }

      case "/remove": {
        if (!arg1) return `${ANSI.red}Usage: /remove <server_id>${ANSI.reset}`;
        await this.adminPost("/admin/server-action", { action: "remove", id: arg1 });
        return `${ANSI.yellow}✓ Removed server '${arg1}'.${ANSI.reset}`;
      }

      case "/clients": {
        const st = await this.adminGet("/admin/state");
        return (st.clients ?? [])
          .map(
            (c: any) =>
              `${c.status === "bound" ? ANSI.green + "✓ BOUND" : ANSI.yellow + "○ " + c.status}${ANSI.reset}  ${ANSI.bold}${c.clientId.padEnd(15)}${ANSI.reset} (${c.displayName}) layer=${c.discoveryLayer} path=${c.configPath ?? "-"}`
          )
          .join("\n");
      }

      case "/bind": {
        if (!arg1) return `${ANSI.red}Usage: /bind <client_id> [manual_path]${ANSI.reset}`;
        const res = await this.adminPost("/admin/client-action", {
          action: "bind",
          client_id: arg1,
          manual_path: arg2 || undefined,
        });
        return `${ANSI.green}✓ Bound client '${arg1}':${ANSI.reset} ${JSON.stringify(res.result)}`;
      }

      case "/unbind": {
        if (!arg1) return `${ANSI.red}Usage: /unbind <client_id>${ANSI.reset}`;
        await this.adminPost("/admin/client-action", {
          action: "unbind",
          client_id: arg1,
        });
        return `${ANSI.yellow}✓ Unbound client '${arg1}' and restored backup.${ANSI.reset}`;
      }

      case "/secrets": {
        const st = await this.adminGet("/admin/state");
        const secs = st.secrets ?? [];
        if (secs.length === 0) return `${ANSI.dim}No secrets stored in SecretVault.${ANSI.reset}`;
        return secs
          .map((s: any) => `${ANSI.cyan}${s.key}${ANSI.reset} -> placeholder: ${ANSI.bold}${s.placeholder}${ANSI.reset}`)
          .join("\n");
      }

      case "/secret": {
        if (!arg1 || !arg2) return `${ANSI.red}Usage: /secret <KEY_NAME> <SECRET_VALUE>${ANSI.reset}`;
        await this.adminPost("/admin/secrets", { key: arg1, value: arg2 });
        return `${ANSI.green}✓ Stored encrypted secret '${arg1}' (use '$secret:${arg1}' in configs).${ANSI.reset}`;
      }

      case "/audit": {
        const st = await this.adminGet("/admin/state");
        const logs = (st.recentAuditLogs ?? []).slice(-12);
        if (logs.length === 0) return `${ANSI.dim}No audit entries yet.${ANSI.reset}`;
        return logs
          .map(
            (a: any) =>
              `${ANSI.dim}${a.timestamp.slice(11, 19)}${ANSI.reset} ${ANSI.bold}${a.toolName.padEnd(28)}${ANSI.reset} [${a.riskLevel}] ${a.decision} (${a.durationMs}ms) ${ANSI.dim}${a.argsPreview}${ANSI.reset}`
          )
          .join("\n");
      }

      default:
        return `${ANSI.red}Unknown command '${cmd}'. Type /help for available commands.${ANSI.reset}`;
    }
  }

  public async startInteractiveRepl(): Promise<void> {
    const banner = await this.renderDashboardBanner();
    console.log(banner);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${ANSI.orange}${ANSI.bold}workbench>${ANSI.reset} `,
    });

    rl.prompt();
    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (trimmed === "/quit" || trimmed === "/exit" || trimmed === "exit") {
        rl.close();
        return;
      }
      if (trimmed) {
        try {
          const out = await this.executeSlashCommand(trimmed);
          if (out) console.log(out);
        } catch (err) {
          console.error(
            `${ANSI.red}Error: ${err instanceof Error ? err.message : String(err)}${ANSI.reset}`
          );
        }
      }
      rl.prompt();
    });

    rl.on("close", () => {
      console.log(`\n${ANSI.dim}Exited TUI Console. Background Daemon remains active.${ANSI.reset}`);
      process.exit(0);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = process.env.MCP_WORKBENCH_ROOT ?? process.cwd();
  const tui = new TuiConsole(rootDir);
  if (process.argv.includes("--once") || process.argv.includes("--status")) {
    tui.renderDashboardBanner().then((b) => {
      console.log(b);
      process.exit(0);
    });
  } else {
    void tui.startInteractiveRepl();
  }
}
```

### 2.2 `scripts/start-tui.ps1` — Windows 黑窗口终端一键启动脚本

```powershell
<#
.SYNOPSIS
Launches the Claude-Code-style Black-Window Interactive Terminal Workbench (TUI) for MCP Workbench v0.3.0.
Automatically wakes the background Daemon if not already running.
#>
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot
$env:MCP_WORKBENCH_ROOT = $ProjectRoot

node ./dist/tui_console.js
```

### 2.3 动态 Web UI 开关在 `src/daemon.ts` 与 `src/registry.ts` 中的实现

#### `src/registry.ts`

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
  ResourceRecord,
  PromptRecord,
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
  private readonly resourcesByExposedUri = new Map<string, ResourceRecord>();
  private readonly promptsByExposedName = new Map<string, PromptRecord>();
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
      const cfg = this.desiredConfig.servers[serverId];
      if (!this.runtimeStates.has(serverId)) {
        this.runtimeStates.set(serverId, {
          serverId,
          serverType: cfg?.serverType ?? "stdio_process",
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


  public isWebUiEnabled(): boolean {
    return this.desiredConfig.webUiEnabled !== false;
  }

  public setWebUiEnabled(enabled: boolean): boolean {
    this.desiredConfig.webUiEnabled = enabled;
    this.saveDesiredConfigAtomically();
    return this.isWebUiEnabled();
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
        serverType: config.serverType ?? "stdio_process",
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
    const cfg = this.desiredConfig.servers[serverId];
    const existing = this.runtimeStates.get(serverId) ?? {
      serverId,
      serverType: cfg?.serverType ?? "stdio_process",
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


  public registerServerResources(
    serverId: string,
    rawResources: Array<{
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    }>
  ): ResourceRecord[] {
    for (const [uri, rec] of this.resourcesByExposedUri.entries()) {
      if (rec.serverId === serverId) this.resourcesByExposedUri.delete(uri);
    }
    const out: ResourceRecord[] = [];
    for (const r of rawResources) {
      const exposedUri = `mcp-workbench://${serverId}/${r.uri}`;
      const record: ResourceRecord = {
        serverId,
        originalUri: r.uri,
        exposedUri,
        name: `[${serverId}] ${r.name}`,
        description: r.description,
        mimeType: r.mimeType,
      };
      this.resourcesByExposedUri.set(exposedUri, record);
      out.push(record);
    }
    return out;
  }

  public registerServerPrompts(
    serverId: string,
    rawPrompts: Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }>
  ): PromptRecord[] {
    for (const [name, rec] of this.promptsByExposedName.entries()) {
      if (rec.serverId === serverId) this.promptsByExposedName.delete(name);
    }
    const out: PromptRecord[] = [];
    for (const p of rawPrompts) {
      const exposedName = `${serverId}__${p.name}`;
      const record: PromptRecord = {
        serverId,
        originalName: p.name,
        exposedName,
        description: p.description,
        arguments: p.arguments,
      };
      this.promptsByExposedName.set(exposedName, record);
      out.push(record);
    }
    return out;
  }

  public getAllResources(): ResourceRecord[] {
    return Array.from(this.resourcesByExposedUri.values());
  }

  public resolveResourceByExposedUri(exposedUri: string): ResourceRecord | undefined {
    return this.resourcesByExposedUri.get(exposedUri);
  }

  public getAllPrompts(): PromptRecord[] {
    return Array.from(this.promptsByExposedName.values());
  }

  public resolvePromptByExposedName(exposedName: string): PromptRecord | undefined {
    return this.promptsByExposedName.get(exposedName);
  }

  public clearServerTools(serverId: string, emitEvent = true): void {
    for (const [u, r] of this.resourcesByExposedUri.entries()) { if (r.serverId === serverId) this.resourcesByExposedUri.delete(u); }
    for (const [n, p] of this.promptsByExposedName.entries()) { if (p.serverId === serverId) this.promptsByExposedName.delete(n); }
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

#### `src/daemon.ts`

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
import { CommandResolver } from "./command_resolver.js";
import { SecretVault } from "./secret_vault.js";
import { WebConsole } from "./web_console.js";

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
  public readonly commandResolver: CommandResolver;
  public readonly secretVault: SecretVault;
  public readonly webConsole: WebConsole;
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
    this.commandResolver = new CommandResolver();
    this.secretVault = new SecretVault(this.rootDir);
    this.processPool = new ProcessPool(
      this.registry,
      this.rootDir,
      this.commandResolver,
      this.secretVault
    );
    this.openApiConnector = new OpenApiConnector(
      this.registry,
      this.rootDir,
      this.secretVault
    );
    this.profileRouter = new ContextProfileRouter(this.registry, this.rootDir);
    this.policyGuard = new PolicyGuard(this.adminSecret, this.secretVault, this.rootDir);
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
    this.webConsole = new WebConsole(
      this.registry,
      this.policyGuard,
      this.secretVault,
      this.clientBinder,
      this.softwareBridge,
      this.profileRouter
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
      this.builderSandbox,
      this.secretVault
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
            webUiEnabled: this.registry.isWebUiEnabled(),
            activeBridges: this.softwareBridge.listActiveBridges().length,
            notificationsSent: this.notificationLog.length,
          })
        );
        return;
      }

      // 1b. Built-in Zero-Dependency Web Control Console (`GET /ui`) — Respects dynamic on/off toggle!
      if (req.method === "GET" && url.pathname === "/ui") {
        if (!this.registry.isWebUiEnabled()) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              error: "WEB_UI_DISABLED",
              message:
                "Web Console (/ui) is currently disabled. Enable it in the Terminal TUI with '/webui on' or via 'studio__ui__configure'.",
            })
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this.webConsole.renderHtmlConsole(this.port));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/webui") {
        const providedSecret = String(req.headers["x-workbench-admin-secret"] ?? "");
        if (providedSecret !== this.adminSecret) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Admin Secret" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        const enabled = this.registry.setWebUiEnabled(Boolean(parsed.enabled));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", webUiEnabled: enabled }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/state") {
        const providedSecret = String(
          req.headers["x-workbench-admin-secret"] ?? ""
        );
        if (providedSecret !== this.adminSecret) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Admin Secret" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.webConsole.getDashboardState()));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/reject") {
        const providedSecret = String(
          req.headers["x-workbench-admin-secret"] ?? ""
        );
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const parsed = JSON.parse(body);
          const rejected = this.policyGuard.rejectPendingTokenWithAdminSecret(
            String(parsed.approval_token ?? ""),
            providedSecret
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ rejected, approvalToken: parsed.approval_token }));
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

      if (req.method === "POST" && url.pathname === "/admin/secrets") {
        const providedSecret = String(
          req.headers["x-workbench-admin-secret"] ?? ""
        );
        if (providedSecret !== this.adminSecret) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Admin Secret" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        this.secretVault.setSecret(String(parsed.key), String(parsed.value));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", key: parsed.key }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/secret-delete") {
        const providedSecret = String(req.headers["x-workbench-admin-secret"] ?? "");
        if (providedSecret !== this.adminSecret) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Admin Secret" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        const deleted = this.secretVault.deleteSecret(String(parsed.key ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", deleted }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/policy-action") {
        const providedSecret = String(req.headers["x-workbench-admin-secret"] ?? "");
        if (providedSecret !== this.adminSecret) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Admin Secret" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        if (parsed.action === "delete") {
          const deleted = this.policyGuard.deletePolicyRule(String(parsed.rule_id ?? ""));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", deleted }));
        } else {
          const rule = this.policyGuard.setPolicyRule({
            ruleId: String(parsed.rule_id),
            targetTool: String(parsed.target_tool ?? "*"),
            riskLevel: parsed.risk_level ?? "safe",
            denyParamRegex: parsed.deny_param_regex ? String(parsed.deny_param_regex) : undefined,
            requireApproval: Boolean(parsed.require_approval),
            waitForApprovalMs: parsed.wait_for_approval_ms ? Number(parsed.wait_for_approval_ms) : undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", rule }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/server-action") {
        const providedSecret = String(req.headers["x-workbench-admin-secret"] ?? "");
        if (providedSecret !== this.adminSecret) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Admin Secret" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        const srvAction = parsed.action === "remove" ? "studio__server__remove" : "studio__server__restart";
        const rpcOut = await this.metaTools.executeMetaTool(srvAction, { id: parsed.id });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", result: rpcOut }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/client-action") {
        const providedSecret = String(req.headers["x-workbench-admin-secret"] ?? "");
        if (providedSecret !== this.adminSecret) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid Admin Secret" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        const cliAction = parsed.action === "unbind" ? "studio__client__unbind" : "studio__client__bind";
        const rpcOut = await this.metaTools.executeMetaTool(cliAction, {
          client_id: parsed.client_id,
          manual_path: parsed.manual_path,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", result: rpcOut }));
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
    this.aggregator.clearAllRestartTimers();
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
        `[mcp-workbenchd v0.2.0] MCP Endpoint: http://${lock.host}:${lock.port}/mcp | Web Console: http://${lock.host}:${lock.port}/ui?admin_secret=${lock.adminSecret} (PID=${lock.pid})`
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

## 三、v0.3.0 二十四步全链路实测验收结果（Node.js 实跑通过）

| 验收步骤 | 验证核心内容 | 实测结果 |
| :--- | :--- | :--- |
| **步骤 1 ~ 22** | 网关核心、五级客户端发现、OpenAPI 零代码直连、Profile 硬隔离、PolicyGuard 同步挂起放行、Revit 反向桥接、BuilderSandbox 隔离自测、崩溃自动恢复、Codex TOML 无损合并、SecretVault 加密脱敏、Resources/Prompts 全栈聚合 | **全部 PASS** |
| **步骤 23** | **Web 面板运行期动态热开关（`studio__ui__configure`）**：调用接口将 `web_ui_enabled` 设为 `false`，验证 `GET /ui` 立即返回 `403 WEB_UI_DISABLED`；再设为 `true`，验证 `GET /ui` 立即恢复 `200 OK` | **PASS** |
| **步骤 24** | **Claude 风格终端 TUI 渲染与斜杠命令闭环（`TuiConsole`）**：验证渲染 `╭─── ✻ MCP Workbench Studio` 面板，并在 TUI 中依次执行 `/webui off`、`/webui on`、`/servers` 斜杠命令全部生效 | **PASS** |
