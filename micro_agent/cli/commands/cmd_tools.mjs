import { C } from "../../core/config.mjs";

export async function handleTools(client, toolsMap, filter = "") {
  console.log(C.bold + `\n🔧 已暴露的顶层工具列表 ${filter ? `(过滤: '${filter}')` : ""}:\n` + C.reset);

  let count = 0;
  for (const [name, def] of toolsMap.entries()) {
    if (filter && !name.toLowerCase().includes(filter.toLowerCase()) && !def.description?.toLowerCase().includes(filter.toLowerCase())) {
      continue;
    }
    count++;
    const isStudio = name.startsWith("studio__");
    const tag = isStudio ? `${C.magenta}[Studio]${C.reset}` : `${C.blue}[MCP]${C.reset}   `;
    console.log(` ${tag} ${C.bold}${name}${C.reset}`);
    if (def.description) {
      console.log(`       ${C.gray}${def.description.split("\n")[0].slice(0, 80)}${C.reset}`);
    }
  }

  if (count === 0) {
    console.log(C.yellow + "  (未找到匹配的工具)" + C.reset);
  } else {
    console.log(C.gray + `\n共显示 ${count} / ${toolsMap.size} 个工具。\n` + C.reset);
  }
}

export async function handleSearch(client, keyword) {
  if (!keyword) {
    console.log(C.yellow + "用法: search <关键词> (例如: search settings 或 search weather)" + C.reset);
    return;
  }

  console.log(C.cyan + `🔍 正在跨所有服务检索匹配 '${keyword}' 的工具...` + C.reset);
  try {
    const resp = await client.callTool("studio__tool__search", { query: keyword });
    const data = JSON.parse(resp.content[0].text);

    console.log(C.green + `✅ 匹配到 ${data.matchCount} 个工具:` + C.reset);
    for (const t of data.tools) {
      const levelTag = t.exposeTopLevel ? `${C.green}[顶层直出]${C.reset}` : `${C.yellow}[冷工具/需invoke]${C.reset}`;
      console.log(`\n  • ${C.bold}${t.originalName}${C.reset} (来源服务: ${C.cyan}${t.serverId}${C.reset}) ${levelTag}`);
      if (t.exposedName) console.log(`    完整标识: ${t.exposedName}`);
      if (t.description) console.log(`    功能说明: ${C.gray}${t.description.split("\n")[0]}${C.reset}`);
    }
    console.log("");
  } catch (e) {
    console.log(C.red + `检索失败: ${e.message}\n` + C.reset);
  }
}
