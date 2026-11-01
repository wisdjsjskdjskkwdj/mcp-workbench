import { C } from "../../core/config.mjs";

export async function handleStatus(client, rootDir) {
  console.log(C.cyan + "\n📊 正在查询 MCP Workbench 网关状态..." + C.reset);
  try {
    const resp = await client.callTool("studio__server__list", {});
    const data = JSON.parse(resp.content[0].text);
    const tools = await client.listTools();

    console.log(C.bold + "\n📊 MCP Workbench 网关状态:" + C.reset);
    console.log(`  • 项目工作区: ${rootDir}`);
    console.log(`  • 顶层可用工具数: ${C.green}${tools.length} 个${C.reset}`);
    console.log(`  • 纳管子服务数: ${C.cyan}${data.servers.length} 个${C.reset}`);

    for (const s of data.servers) {
      const phaseColor = s.actualPhase === "running" ? C.green : C.red;
      console.log(`    - [${C.bold}${s.serverId}${C.reset}] 状态: ${phaseColor}${s.actualPhase}${C.reset}, PID: ${s.pid || "N/A"}, 工具数: ${s.toolCount}`);
    }
    console.log("");
  } catch (e) {
    console.log(C.red + `获取状态失败: ${e.message}\n` + C.reset);
  }
}

export async function handleServers(client) {
  console.log(C.bold + "\n🖥️  当前纳管的 MCP 服务拓扑:\n" + C.reset);
  try {
    const resp = await client.callTool("studio__server__list", {});
    const data = JSON.parse(resp.content[0].text);

    console.log(" " + "-".repeat(68));
    console.log(` ${"服务ID".padEnd(16)} ${"运行状态".padEnd(12)} ${"PID".padEnd(10)} ${"工具数量".padEnd(10)} 描述/配置`);
    console.log(" " + "-".repeat(68));

    for (const s of data.servers) {
      const phase = s.actualPhase === "running" ? `${C.green}running${C.reset} ` : `${C.red}${s.actualPhase}${C.reset} `;
      const pidStr = s.pid ? String(s.pid) : "-";
      console.log(` ${C.cyan}${s.serverId.padEnd(16)}${C.reset} ${phase.padEnd(20)} ${pidStr.padEnd(10)} ${String(s.toolCount).padEnd(10)} ${s.desiredEnabled ? "启用" : "停用"}`);
    }
    console.log(" " + "-".repeat(68) + "\n");
  } catch (e) {
    console.log(C.red + `获取服务列表失败: ${e.message}\n` + C.reset);
  }
}
