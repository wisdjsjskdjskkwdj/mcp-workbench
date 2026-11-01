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
    } catch (err: any) {
      if (err?.code === "EPERM") return true;
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
        if ((await this.checkHealth(existing)) || this.isDaemonAlive(existing)) {
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
          if ((await this.checkHealth(lock)) || this.isDaemonAlive(lock)) {
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
          `  ${ANSI.cyan}/start <server_id>${ANSI.reset}       Start a stopped MCP server`,
          `  ${ANSI.cyan}/stop <server_id>${ANSI.reset}        Stop/close a running MCP server`,
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

      case "/start": {
        if (!arg1) return `${ANSI.red}Usage: /start <server_id>${ANSI.reset}`;
        await this.adminPost("/admin/server-action", { action: "start", id: arg1 });
        return `${ANSI.green}✓ Started server '${arg1}'.${ANSI.reset}`;
      }

      case "/stop": {
        if (!arg1) return `${ANSI.red}Usage: /stop <server_id>${ANSI.reset}`;
        await this.adminPost("/admin/server-action", { action: "stop", id: arg1 });
        return `${ANSI.yellow}✓ Stopped server '${arg1}'.${ANSI.reset}`;
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
