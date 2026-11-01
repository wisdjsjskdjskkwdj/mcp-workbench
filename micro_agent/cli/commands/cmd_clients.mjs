import { C } from "../../core/config.mjs";

export async function handleScan(client) {
  console.log(C.cyan + "🔎 正在执行 5 层发现漏斗扫描本机 AI 客户端..." + C.reset);
  try {
    const resp = await client.callTool("studio__client__scan", {});
    const data = JSON.parse(resp.content[0].text);
    console.log(C.green + `\n📋 扫描结果 (共探测到 ${data.clients.length} 个客户端):\n` + C.reset);
    for (const c of data.clients) {
      const isBound = c.status === "bound";
      let statusBadge = "";
      let actionTip = "";
      if (isBound) {
        statusBadge = `${C.green}[已接管 / Bound]${C.reset}`;
        actionTip = `${C.gray}👉 输入 ${C.yellow}unbind ${c.clientId}${C.gray} 可随时一键还原${C.reset}`;
      } else if (c.status === "detected_unbound") {
        statusBadge = `${C.yellow}[已发现 / 可一键接管]${C.reset}`;
        actionTip = `${C.green}👉 输入 ${C.bold}bind ${c.clientId}${C.reset}${C.green} 即可一键接入 MCP Workbench${C.reset}`;
      } else if (c.status === "staged_wait_exit") {
        statusBadge = `${C.magenta}[挂起 / 等待退出]${C.reset}`;
        actionTip = `${C.yellow}👉 客户端退出后生效，或使用 bind ${c.clientId} --force 强制写入${C.reset}`;
      } else {
        statusBadge = `${C.gray}[未安装或需手动路径]${C.reset}`;
      }

      console.log(` • ${C.bold}${c.displayName}${C.reset} (${C.cyan}${c.clientId}${C.reset}) ${statusBadge}`);
      console.log(`   - 探测层级: ${c.discoveryLayer}`);
      if (c.configPath) console.log(`   - 配置文件: ${c.configPath}`);
      if (c.detectedPid) console.log(`   - 进程存活: PID ${c.detectedPid}`);
      if (c.importedServers && c.importedServers.length > 0) {
        const srvLabel = isBound ? "已收编并运行的原服务" : "原配置包含的服务 (待执行 bind 后自动收编)";
        console.log(`   - ${srvLabel}: ${c.importedServers.join(", ")}`);
      }
      if (c.warning) console.log(`   - ${C.yellow}提示: ${c.warning}${C.reset}`);
      if (actionTip) console.log(`   ${actionTip}`);
      console.log("");
    }
  } catch (e) {
    console.log(C.red + `扫描失败: ${e.message}\n` + C.reset);
  }
}

export async function handleBind(client, args) {
  if (!args || args.length === 0 || !args[0]) {
    console.log(C.yellow + "用法: bind <客户端ID> [选项]" + C.reset);
    console.log(C.gray + "支持的客户端: cursor, claude-code, antigravity, workbuddy, windsurf, trae, continue, claude-desktop, vscode-cline, vscode-roo" + C.reset);
    console.log(C.gray + "可选参数:" + C.reset);
    console.log(C.gray + "  --mode=side_by_side   (共存模式，保留原配置中的其他 MCP 服务)" + C.reset);
    console.log(C.gray + "  --mode=exclusive      (独占接管模式，默认。原服务全部收编到 Workbench)" + C.reset);
    console.log(C.gray + "  --no-start            (收编原服务时不自动立即启动它)" + C.reset);
    console.log(C.gray + "  --force               (若检测到客户端运行，强制写入配置)" + C.reset);
    console.log(C.gray + "  --path=<path>         (手动指定客户端配置或安装目录)" + C.reset);
    console.log(C.gray + "例如: bind cursor" + C.reset);
    console.log(C.gray + "      bind cursor --mode=side_by_side" + C.reset);
    return;
  }

  const clientId = args[0].toLowerCase();
  let mode = "exclusive";
  let force = false;
  let autoStartImported = true;
  let manualPath = undefined;

  for (const opt of args.slice(1)) {
    if (opt.startsWith("--mode=")) {
      mode = opt.split("=")[1];
    } else if (opt === "--force") {
      force = true;
    } else if (opt === "--no-start") {
      autoStartImported = false;
    } else if (opt.startsWith("--path=")) {
      manualPath = opt.split("=")[1];
    }
  }

  console.log(C.cyan + `🔗 正在尝试无损接管客户端 '${clientId}' (模式: ${mode})...` + C.reset);
  try {
    const resp = await client.callTool("studio__client__bind", {
      client_id: clientId,
      mode,
      force,
      auto_start_imported: autoStartImported,
      manual_path: manualPath,
    });

    const data = JSON.parse(resp.content[0].text);
    if (data.status === "staged_wait_exit") {
      console.log(C.yellow + `⚠️  接管已挂起 (Staged): 客户端进程正在运行 (PID=${data.detectedPid})。` + C.reset);
      console.log(C.yellow + `   为防止退出时被客户端内存覆盖，请先关闭客户端窗口，或使用 bind ${clientId} --force 强制写入。\n` + C.reset);
      return;
    }

    console.log(C.green + C.bold + `🎉 客户端 '${data.displayName || clientId}' 已成功接管！` + C.reset);
    console.log(` • 配置文件已注入: ${data.configPath}`);
    if (data.backupPath) {
      console.log(` • 原始配置已安全备份: ${data.backupPath}`);
    }
    if (data.importedServers && data.importedServers.length > 0) {
      console.log(` • 已自动收编原有 MCP 服务 (${data.importedServers.length} 个): ${C.cyan}${data.importedServers.join(", ")}${C.reset}`);
    }
    console.log(` • 统一网关入口: ${C.bold}mcp-workbench -> StdioShim${C.reset}`);
    console.log(C.magenta + `\n💡 生效说明: 请在 ${data.displayName || clientId} 中重新加载 MCP（或重启客户端），所有聚合工具即可直接使用！` + C.reset);
    console.log(C.gray + `💡 随时可通过输入 ${C.yellow}unbind ${clientId}${C.gray} 100% 恢复原始配置。\n` + C.reset);
  } catch (e) {
    console.log(C.red + `❌ 接管绑定失败: ${e.message}\n` + C.reset);
  }
}

export async function handleUnbind(client, clientId) {
  if (!clientId) {
    console.log(C.yellow + "用法: unbind <客户端ID> (例如: unbind cursor)" + C.reset);
    return;
  }

  console.log(C.cyan + `🔄 正在还原客户端 '${clientId}' 的原始配置...` + C.reset);
  try {
    const resp = await client.callTool("studio__client__unbind", {
      client_id: clientId,
    });
    const data = JSON.parse(resp.content[0].text);

    if (data.restored) {
      console.log(C.green + C.bold + `✅ 客户端 '${clientId}' 已成功解绑！` + C.reset);
      console.log(` • 已从备份文件恢复原始配置，临时备份已安全清除。`);
      console.log(C.gray + ` • 客户端已完全恢复至接管前的独立状态。\n` + C.reset);
    } else {
      console.log(C.yellow + `⚠️  客户端 '${clientId}' 未找到备份配置或尚未绑定，无需还原。\n` + C.reset);
    }
  } catch (e) {
    console.log(C.red + `❌ 解绑失败: ${e.message}\n` + C.reset);
  }
}
