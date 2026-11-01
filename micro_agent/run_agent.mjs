import path from "node:path";
import { MiniAgent } from "./mini_agent.mjs";

/**
 * Interactive / CLI Task Runner for Micro-Agent.
 * Usage:
 *   node ./micro_agent/run_agent.mjs time
 *   node ./micro_agent/run_agent.mjs math 25 16 120
 *   node ./micro_agent/run_agent.mjs weather Paris 5
 *   node ./micro_agent/run_agent.mjs fib 10
 *   node ./micro_agent/run_agent.mjs scan
 */
async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || "help").toLowerCase();

  const rootDir = path.resolve(".");
  const agent = new MiniAgent(rootDir, "CLI-MicroAgent");

  if (command === "help" || command === "--help") {
    console.log(`
🤖 MCP Workbench Micro-Agent CLI Usage:
  node ./micro_agent/run_agent.mjs time [timezone]        - 查询指定时区当前时间 (默认: Asia/Shanghai)
  node ./micro_agent/run_agent.mjs math <a> <b> <c>       - 执行复合链式运算: (a * b) + c
  node ./micro_agent/run_agent.mjs weather <city> [days]  - 自主装载天气服务并查询预报 (默认天数: 3)
  node ./micro_agent/run_agent.mjs fib <n>                - 跨服务检索冷工具并计算第 n 个斐波那契数
  node ./micro_agent/run_agent.mjs scan                   - 扫描本机已安装的 AI 客户端 (Cursor, Claude 等)
  node ./micro_agent/run_agent.mjs bind <client>          - 一键无损接管外部客户端 (例如: bind cursor)
  node ./micro_agent/run_agent.mjs unbind <client>        - 一键还原外部客户端配置 (例如: unbind cursor)
  node ./micro_agent/test_agent.mjs                       - 运行全套端到端自动化测试
    `);
    return;
  }

  await agent.start();

  try {
    switch (command) {
      case "time": {
        const tz = args[1] || "Asia/Shanghai";
        await agent.taskGetSystemTime(tz);
        break;
      }
      case "math": {
        const a = Number(args[1] ?? 12);
        const b = Number(args[2] ?? 8);
        const c = Number(args[3] ?? 100);
        await agent.taskCalculateCompound(a, b, c);
        break;
      }
      case "weather": {
        const city = args[1] || "Beijing";
        const days = Number(args[2] ?? 3);
        await agent.taskAcquireAndQueryWeather(city, days);
        break;
      }
      case "fib": {
        const n = Number(args[1] ?? 10);
        await agent.taskSearchAndInvokeColdTool("fibonacci", { n });
        break;
      }
      case "scan": {
        const clients = await agent.taskScanClients();
        console.log("\n📋 Local AI Clients Scan Results:");
        for (const c of clients) {
          console.log(` - [${c.clientId}] ${c.displayName}: status=${c.status}, layer=${c.discoveryLayer}, config=${c.configPath || "N/A"}`);
        }
        break;
      }
      case "bind": {
        const clientTarget = args[1] || "cursor";
        const sideBySide = args.includes("--side-by-side");
        const noStart = args.includes("--no-start");
        const force = args.includes("--force");
        await agent.taskBindClient(clientTarget, {
          mode: sideBySide ? "side_by_side" : "exclusive",
          autoStartImported: !noStart,
          force,
        });
        break;
      }
      case "unbind": {
        const clientTarget = args[1] || "cursor";
        await agent.taskUnbindClient(clientTarget);
        break;
      }
      default:
        console.log(`Unknown command: '${command}'. Run with 'help' to see options.`);
    }
  } finally {
    await agent.stop();
  }
}

main().catch((err) => {
  console.error("CLI Execution failed:", err);
  process.exit(1);
});
