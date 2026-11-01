import { C } from "../../core/config.mjs";

export async function handleAddServer(client, args) {
  if (!args || args.length < 2) {
    console.log(C.yellow + "用法: add <服务ID> <命令> [参数...]\n(例如: add weather node ./dist/test_servers/mock_server_c.js)" + C.reset);
    return;
  }

  const id = args[0];
  const command = args[1];
  const cmdArgs = args.slice(2);

  console.log(C.cyan + `🚀 正在动态挂载新 MCP 服务 '${id}'...` + C.reset);
  try {
    const resp = await client.callTool("studio__server__add", {
      id,
      command,
      args: cmdArgs,
    });
    console.log(C.green + `✅ 服务 '${id}' 已成功挂载并就绪！` + C.reset);
    const data = JSON.parse(resp.content[0].text);
    console.log(`   PID: ${data.runtimeState?.pid}, 发现工具: ${data.discoveredTools?.length || 0} 个`);
  } catch (e) {
    console.log(C.red + `❌ 挂载失败: ${e.message}` + C.reset);
  }
  console.log("");
}

export async function handleRemoveServer(client, id) {
  if (!id) {
    console.log(C.yellow + "用法: remove <服务ID> (例如: remove weather)" + C.reset);
    return;
  }

  console.log(C.yellow + `🗑️  正在下线卸载服务 '${id}'...` + C.reset);
  try {
    await client.callTool("studio__server__remove", { id });
    console.log(C.green + `✅ 服务 '${id}' 已从网关移除并安全下线。\n` + C.reset);
  } catch (e) {
    console.log(C.red + `❌ 卸载失败: ${e.message}\n` + C.reset);
  }
}
