import { C } from "../../core/config.mjs";
import { promptToolArguments } from "../wizard.mjs";

export async function handleCall(client, toolsMap, toolName, rawArgs = "", rl = null) {
  if (!toolName) {
    console.log(C.yellow + "用法: call <工具名> [参数JSON]  (例如: call math_ops__add {\"a\":10,\"b\":20})" + C.reset);
    console.log(C.gray + "提示: 如果不提供参数 JSON，将自动进入交互式参数引导向导！" + C.reset);
    return;
  }

  let parsedArgs = {};
  if (rawArgs.trim()) {
    try {
      parsedArgs = JSON.parse(rawArgs.trim());
    } catch (err) {
      console.log(C.red + `❌ JSON 参数解析错误: ${err.message}` + C.reset);
      console.log(C.gray + `你输入的参数是: ${rawArgs}` + C.reset);
      return;
    }
  } else if (rl && toolsMap.has(toolName)) {
    // Interactive Wizard Mode
    const def = toolsMap.get(toolName);
    if (def.inputSchema && def.inputSchema.properties && Object.keys(def.inputSchema.properties).length > 0) {
      try {
        parsedArgs = await promptToolArguments(toolName, def.inputSchema, rl);
      } catch (e) {
        console.log(C.red + `参数收集取消或失败: ${e.message}` + C.reset);
        return;
      }
    }
  }

  console.log(C.cyan + `⚡ 正在调用工具 '${toolName}'...` + C.reset);
  const start = Date.now();
  try {
    const resp = await client.callTool(toolName, parsedArgs);
    const elapsed = Date.now() - start;
    console.log(C.green + `✅ 调用成功 (耗时: ${elapsed}ms):` + C.reset);
    if (resp.content && Array.isArray(resp.content)) {
      for (const item of resp.content) {
        if (item.type === "text") {
          try {
            const formatted = JSON.stringify(JSON.parse(item.text), null, 2);
            console.log(formatted);
          } catch {
            console.log(item.text);
          }
        } else {
          console.log(item);
        }
      }
    } else {
      console.log(resp);
    }
  } catch (e) {
    console.log(C.red + `❌ 调用失败: ${e.message}` + C.reset);
  }
  console.log("");
}

export async function handleInvoke(client, serverId, toolName, rawArgs = "") {
  if (!serverId || !toolName) {
    console.log(C.yellow + "用法: invoke <服务名> <原始工具名> [参数JSON]\n(例如: invoke math_ops fibonacci {\"n\":8})" + C.reset);
    return;
  }

  let parsedArgs = {};
  if (rawArgs.trim()) {
    try {
      parsedArgs = JSON.parse(rawArgs.trim());
    } catch (err) {
      console.log(C.red + `❌ JSON 参数解析错误: ${err.message}` + C.reset);
      return;
    }
  }

  console.log(C.cyan + `⚡ 正在穿透调用 [${serverId}] -> '${toolName}'...` + C.reset);
  const start = Date.now();
  try {
    const resp = await client.callTool("studio__tool__invoke", {
      server_id: serverId,
      tool_name: toolName,
      arguments: parsedArgs,
    });
    const elapsed = Date.now() - start;
    console.log(C.green + `✅ 穿透调用成功 (耗时: ${elapsed}ms):` + C.reset);
    if (resp.content && Array.isArray(resp.content)) {
      for (const item of resp.content) {
        if (item.type === "text") {
          try {
            console.log(JSON.stringify(JSON.parse(item.text), null, 2));
          } catch {
            console.log(item.text);
          }
        }
      }
    } else {
      console.log(resp);
    }
  } catch (e) {
    console.log(C.red + `❌ 穿透调用失败: ${e.message}` + C.reset);
  }
  console.log("");
}
