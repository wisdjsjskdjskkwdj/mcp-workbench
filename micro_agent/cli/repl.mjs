import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { C, BANNER } from "../core/config.mjs";
import { handleStatus, handleServers } from "./commands/cmd_status.mjs";
import { handleTools, handleSearch } from "./commands/cmd_tools.mjs";
import { handleCall, handleInvoke } from "./commands/cmd_call.mjs";
import { handleAddServer, handleRemoveServer } from "./commands/cmd_servers.mjs";
import { handleScan, handleBind, handleUnbind } from "./commands/cmd_clients.mjs";
import { handleTest } from "./commands/cmd_test.mjs";
import { cmdHistory, cmdSnapshot, cmdDiff, cmdRollback, cmdUndo } from "./commands/cmd_version.mjs";
import { handlePolicy, handleBridge, handleConnector } from "./commands/cmd_v005.mjs";

export class ReplSession {
  constructor(client, rootDir) {
    this.client = client;
    this.rootDir = rootDir;
    this.tools = new Map();
    this.rl = null;
    this.isClosed = false;
  }

  async refreshTools() {
    const list = await this.client.listTools();
    this.tools.clear();
    for (const t of list) {
      this.tools.set(t.name, t);
    }
  }

  setupReadline() {
    const commandList = [
      "help", "status", "servers", "tools", "call", "search", 
      "invoke", "add", "remove", "scan", "bind", "unbind", "test",
      "policy", "bridge", "connector", "dashboard", "ui", "metrics", "circuits", "vault",
      "history", "snapshot", "diff", "rollback", "undo", "restart", "stop", "clear", "exit", "quit"
    ];

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      completer: (line) => {
        const parts = line.trimStart().split(" ");
        if (parts.length === 1) {
          const hits = commandList.filter((c) => c.startsWith(parts[0]));
          return [hits.length ? hits : commandList, parts[0]];
        }
        if (parts[0] === "call" && parts.length === 2) {
          const toolNames = Array.from(this.tools.keys());
          const hits = toolNames.filter((t) => t.startsWith(parts[1]));
          return [hits.length ? hits : toolNames, parts[1]];
        }
        if ((parts[0] === "bind" || parts[0] === "unbind") && parts.length === 2) {
          const clientIds = [
            "antigravity",
            "cursor",
            "vscode-cline",
            "vscode-roo",
            "trae",
            "continue",
            "claude-code",
            "claude-desktop",
            "windsurf"
          ];
          const hits = clientIds.filter((c) => c.startsWith(parts[1]));
          return [hits.length ? hits : clientIds, parts[1]];
        }
        if (parts[0] === "test" && parts.length === 2) {
          const testSuites = ["all", "math", "clock", "cold", "weather", "client"];
          const hits = testSuites.filter((s) => s.startsWith(parts[1]));
          return [hits.length ? hits : testSuites, parts[1]];
        }
        return [[], line];
      },
      prompt: `${C.bold}${C.cyan}mcp-workbench${C.reset} ${C.gray}>${C.reset} `,
    });

    this.rl.prompt();

    this.rl.on("line", async (line) => {
      if (this.isClosed) return;
      try {
        this.rl.pause();
      } catch {}

      const trimmed = line.trim();
      if (!trimmed) {
        if (!this.isClosed) {
          try {
            this.rl.resume();
            this.rl.prompt();
          } catch {}
        }
        return;
      }

      await this.dispatch(trimmed);

      if (!this.isClosed) {
        try {
          this.rl.resume();
          this.rl.prompt();
        } catch {}
      }
    });

    this.rl.on("close", () => {
      if (this.isClosed) return;
      this.isClosed = true;
      console.log("\n" + C.yellow + "👋 正在断开连接，退出 MCP 控制台..." + C.reset);
      this.client.close().then(() => {
        process.exit(0);
      });
    });
  }

  printBanner() {
    console.log(BANNER);
  }

  printHelp() {
    console.log(C.bold + "\n📖 支持的命令与功能说明:\n" + C.reset);
    const commands = [
      ["status", "查看网关连接状态、进程与工具统计"],
      ["servers", "查看当前所有已挂载的 MCP 服务器状态 (PID, 运行状态, 工具数)"],
      ["tools [keyword]", "列出当前暴露的所有顶层工具 (可带关键词过滤)"],
      ["search <query>", "跨所有服务检索冷工具/隐藏工具 (例如: search settings)"],
      ["call <tool> [argsJSON]", "调用工具 (省略参数将自动进入交互式 Schema 向导)"],
      ["invoke <srv> <tool> [argsJSON]", "直接穿透调用冷工具 (例如: invoke math_ops fibonacci {\"n\":8})"],
      ["add <id> <cmd> [args...]", "动态挂载新 MCP 服务 (例如: add demo node ./mock.js)"],
      ["remove <id>", "动态下线卸载指定 MCP 服务"],
      ["scan", "扫描本机已安装的 AI 客户端 (Cursor, Claude 等)"],
      ["bind <client> [options]", "一键无损接管外部客户端 (例如: bind cursor)"],
      ["unbind <client>", "一键还原外部客户端配置 (例如: unbind cursor)"],
      ["dashboard / ui", "查看内置现代化 Web 控制台与遥测面板 (http://127.0.0.1:43110/ui)"],
      ["metrics [srv]", "查看工具调用耗时分布 (P50/P90/P99)、缓存命中率与 Token 消耗"],
      ["circuits", "查看下游 MCP 服务探活状态与熔断器 (Circuit Breaker) 状态"],
      ["vault <list|set>", "管理 AES-256-GCM 加密保险箱敏感凭据 (如 API Key)"],
      ["policy <list|audit>", "查看安全策略待批调用或审计日志 (例如: policy audit 10)"],
      ["bridge", "查看宿主软件反向 IPC 网桥状态"],
      ["connector import <id> <file>", "导入 OpenAPI 规范并自动挂载为虚拟 MCP 服务"],
      ["test [suite]", "快速执行测试套件 (可选: all, math, clock, cold, weather, client)"],
      ["history [limit]", "查看项目历史版本、快照记录与工作区状态"],
      ["snapshot <name> [desc]", "为当前项目创建全局原子快照 (防手抖/防改坏)"],
      ["diff [target]", "比对当前工作区与某一快照或版本的代码差异"],
      ["rollback <target>", "一键安全回退到指定快照 (自动创建回退前安全备份)"],
      ["undo", "一键撤销刚才的所有本地临时改动，秒级恢复干净状态"],
      ["restart", "彻底重启后台网关守护进程并重载最新代码与工具"],
      ["stop", "彻底关闭后台网关守护进程与网页控制台"],
      ["clear", "清空终端屏幕"],
      ["exit / quit", "安全退出控制台"],
    ];

    for (const [c, desc] of commands) {
      console.log(`  ${C.bold}${C.cyan}${c.padEnd(32)}${C.reset} ${desc}`);
    }
    console.log("");
  }

  async dispatch(cmdLine) {
    const rawTokens = cmdLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    if (rawTokens.length === 0) return;

    // 智能容错：自动识别并剥离误粘贴的 shell 启动前缀
    let tokens = rawTokens;
    const firstLower = rawTokens[0].toLowerCase().replace(/^["']|["']$/g, "");
    if (firstLower === "node" || firstLower === "npm") {
      const idx = rawTokens.findIndex((t) =>
        [
          "call", "invoke", "tools", "status", "servers", "search", "add", "remove", 
          "scan", "bind", "unbind", "test", "history", "snapshot", "diff", "rollback", 
          "undo", "discard", "clear", "cls", "help", "exit", "quit"
        ].includes(t.toLowerCase().replace(/^["']|["']$/g, ""))
      );
      if (idx !== -1) {
        tokens = rawTokens.slice(idx);
      }
    }

    const cmd = tokens[0].toLowerCase();
    const args = tokens.slice(1).map((s) => s.replace(/^["']|["']$/g, ""));

    switch (cmd) {
      case "help":
        this.printHelp();
        break;

      case "status":
        await handleStatus(this.client, this.rootDir);
        break;

      case "servers":
        await handleServers(this.client);
        break;

      case "tools":
        await this.refreshTools();
        await handleTools(this.client, this.tools, args[0]);
        break;

      case "search":
        await handleSearch(this.client, args[0]);
        break;

      case "call":
        await this.refreshTools();
        await handleCall(this.client, this.tools, args[0], args.slice(1).join(" "), this.rl);
        break;

      case "invoke":
        await handleInvoke(this.client, args[0], args[1], args.slice(2).join(" "));
        break;

      case "add":
        await handleAddServer(this.client, args);
        await this.refreshTools();
        break;

      case "remove":
        await handleRemoveServer(this.client, args[0]);
        await this.refreshTools();
        break;

      case "scan":
        await handleScan(this.client);
        break;

      case "bind":
        await handleBind(this.client, args);
        break;

      case "unbind":
        await handleUnbind(this.client, args[0]);
        break;

      case "test":
        await this.refreshTools();
        await handleTest(this.client, this.tools, args[0] || "all");
        break;

      case "policy":
      case "guard":
      case "audit":
        await handlePolicy(this.client, args);
        break;

      case "dashboard":
      case "ui": {
        console.log(`\n🖥️  ${C.bold}${C.cyan}MCP Workbench 内置 Web 控制台与遥测仪表盘:${C.reset}`);
        console.log(`  🔗 ${C.green}http://127.0.0.1:43110/ui${C.reset}\n`);
        break;
      }

      case "metrics":
      case "telemetry": {
        const srv = args[0];
        const res = await this.client.callTool("studio__metrics__get", srv ? { server_id: srv } : {});
        console.log(`\n📊 ${C.bold}性能遥测与 Token 消耗统计:${C.reset}\n`, res?.content?.[0]?.text ?? JSON.stringify(res, null, 2));
        break;
      }

      case "circuits":
      case "watchdog":
      case "health": {
        const res = await this.client.callTool("studio__circuit__status", {});
        console.log(`\n🛡️ ${C.bold}下游服务探活与熔断器状态:${C.reset}\n`, res?.content?.[0]?.text ?? JSON.stringify(res, null, 2));
        break;
      }

      case "vault":
      case "secrets": {
        const sub = (args[0] || "list").toLowerCase();
        if (sub === "set") {
          const key = args[1];
          const val = args[2];
          const desc = args.slice(3).join(" ") || undefined;
          if (!key || !val) {
            console.log(C.red + "用法: vault set <key> <value> [description]" + C.reset);
            break;
          }
          const res = await this.client.callTool("studio__vault__set", { key, value: val, description: desc });
          console.log(C.green + "✅ 凭据已安全加密入库!" + C.reset, res?.content?.[0]?.text ?? "");
        } else {
          const res = await this.client.callTool("studio__vault__list", {});
          console.log(`\n🔐 ${C.bold}SecretVault 已加密保管凭据清单 (密文受保护):${C.reset}\n`, res?.content?.[0]?.text ?? "");
        }
        break;
      }

      case "bridge":
      case "bridges":
        await handleBridge(this.client, args);
        break;

      case "connector":
      case "openapi":
        await handleConnector(this.client, args);
        await this.refreshTools();
        break;

      case "history":
      case "snapshots":
      case "versions":
      case "log":
        await cmdHistory(this.client, args);
        break;

      case "snapshot":
      case "checkpoint":
        await cmdSnapshot(this.client, args);
        break;

      case "diff":
        await cmdDiff(this.client, args);
        break;

      case "rollback":
      case "restore":
        await cmdRollback(this.client, args);
        break;

      case "undo":
      case "discard":
        await cmdUndo(this.client);
        break;

      case "restart": {
        console.log(C.yellow + "🔄 正在重启 MCP Workbench 后台网关守护进程..." + C.reset);
        const lockPath = path.join(this.rootDir, ".workbench-daemon.lock.json");
        try {
          if (fs.existsSync(lockPath)) {
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
            if (lock && lock.pid) {
              if (process.platform === "win32") {
                try { execSync(`taskkill /F /T /PID ${lock.pid}`, { stdio: "ignore" }); } catch {}
              } else {
                try { process.kill(lock.pid, "SIGKILL"); } catch {}
              }
            }
            try { fs.unlinkSync(lockPath); } catch {}
          }
        } catch {}
        try {
          await this.client.close();
        } catch {}
        await new Promise((r) => setTimeout(r, 800));
        try {
          await this.client.connect();
          await this.client.initialize({
            name: "mcp-workbench-modular-cli",
            version: "1.0.0",
          });
          await this.refreshTools();
          console.log(C.green + C.bold + `✅ 网关守护进程已成功重启，已载入最新代码并挂载 ${this.tools.size} 个工具！\n` + C.reset);
        } catch (e) {
          console.log(C.red + "重启后重连失败: " + e.message + "\n" + C.reset);
        }
        break;
      }

      case "clear":
      case "cls":
        console.clear();
        this.printBanner();
        break;

      case "stop":
      case "shutdown": {
        console.log(C.yellow + "正在彻底关闭后台网关与网页端..." + C.reset);
        const lockPath = path.join(this.rootDir, ".workbench-daemon.lock.json");
        try {
          if (fs.existsSync(lockPath)) {
            const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
            if (lock && lock.pid) {
              if (process.platform === "win32") {
                try { execSync(`taskkill /F /T /PID ${lock.pid}`, { stdio: "ignore" }); } catch {}
              } else {
                try { process.kill(lock.pid, "SIGKILL"); } catch {}
              }
            }
            try { fs.unlinkSync(lockPath); } catch {}
          }
        } catch {}
        try { await this.client.close(); } catch {}
        this.isClosed = true;
        this.rl.close();
        console.log(C.green + "✓ 后台网关及网页端已彻底关闭退出。\n" + C.reset);
        process.exit(0);
        break;
      }

      case "exit":
      case "quit":
        this.isClosed = true;
        this.rl.close();
        console.log(C.gray + "\n已退出黑窗口终端。如需彻底关闭后台网关与网页端，可双击 stop.bat 或在终端中输入 stop。\n" + C.reset);
        break;

      default:
        console.log(C.red + `未知命令: '${cmd}'。输入 ${C.bold}help${C.reset}${C.red} 查看帮助列表。` + C.reset);
    }
  }

  async start() {
    this.printBanner();
    console.log(C.gray + "正在连接 MCP Workbench 网关..." + C.reset);
    try {
      await this.client.connect();
      await this.client.initialize({
        name: "mcp-workbench-modular-cli",
        version: "1.0.0",
      });
      await this.refreshTools();
      console.log(C.green + `✅ 网关连接成功！当前挂载顶层工具: ${this.tools.size} 个` + C.reset);

      // Listen for gateway live tool change notifications
      this.client.on("tools_changed", async () => {
        await this.refreshTools();
      });

      this.client.on("disconnect", () => {
        if (!this.isClosed) {
          console.log("\n" + C.yellow + "⚠️  检测到网关连接已断开。输入 restart 可重新拉起并重连网关。" + C.reset);
          if (this.rl) {
            try { this.rl.prompt(); } catch {}
          }
        }
      });

      this.setupReadline();
    } catch (err) {
      console.log(C.red + `❌ 连接网关失败: ${err.message}` + C.reset);
      process.exit(1);
    }
  }
}
