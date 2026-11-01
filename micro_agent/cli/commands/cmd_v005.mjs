import fs from "node:fs";
import path from "node:path";
import { C } from "../../core/config.mjs";

export async function handlePolicy(client, args) {
  const sub = (args[0] || "audit").toLowerCase();

  if (sub === "list" || sub === "pending") {
    console.log(C.cyan + "🛡️  正在查询待人工审批的高危操作调用..." + C.reset);
    try {
      const resp = await client.callTool("studio__policy__list_pending", {});
      const data = JSON.parse(resp.content[0].text);
      const pending = data.pendingApprovals || [];
      if (pending.length === 0) {
        console.log(C.green + "✅ 当前没有挂起的高危操作请求。\n" + C.reset);
      } else {
        console.log(C.yellow + `⚠️  发现 ${pending.length} 个待人工批准的操作:\n` + C.reset);
        for (const p of pending) {
          console.log(` • 待批调用: ${C.bold}${p.toolName}${C.reset} [风险等级: ${C.red}${p.riskLevel}${C.reset}]`);
          console.log(`   - 审批令牌: ${p.approvalToken}`);
          console.log(`   - 入参预览: ${p.argsPreview}`);
          console.log(`   - 申请时间: ${p.requestedAt}`);
        }
        console.log(C.gray + "\n💡 提示: 审批需通过带外管理员接口 POST /admin/approve 提交令牌放行。\n" + C.reset);
      }
    } catch (e) {
      console.log(C.red + `查询待审批列表失败: ${e.message}\n` + C.reset);
    }
  } else if (sub === "audit" || sub === "log") {
    const limit = Number(args[1] || 15);
    console.log(C.cyan + `📜 正在读取最近 ${limit} 条安全策略与调用审计日志 (Flight Recorder)...` + C.reset);
    try {
      const resp = await client.callTool("studio__policy__audit_log", { limit });
      const data = JSON.parse(resp.content[0].text);
      const logs = data.auditLog || [];
      if (logs.length === 0) {
        console.log(C.gray + "暂无审计记录。\n" + C.reset);
      } else {
        console.log(C.green + `\n📋 审计日志列表 (共 ${logs.length} 条):\n` + C.reset);
        for (const entry of logs) {
          const badge =
            entry.decision === "allowed"
              ? `${C.green}[放行 / ALLOW]${C.reset}`
              : `${C.red}[拦截 / BLOCKED]${C.reset}`;
          console.log(` • [${entry.timestamp}] ${badge} ${C.bold}${entry.toolName}${C.reset} (Server: ${entry.serverId})`);
          console.log(`   - 风险等级: ${entry.riskLevel} | 耗时: ${entry.durationMs}ms`);
          console.log(`   - 决策判定: ${entry.reason}`);
          if (entry.argsPreview) {
            console.log(`   - 入参摘要: ${entry.argsPreview}`);
          }
        }
        console.log("");
      }
    } catch (e) {
      console.log(C.red + `读取审计日志失败: ${e.message}\n` + C.reset);
    }
  } else {
    console.log(C.yellow + "用法: policy <list|audit> [limit]" + C.reset);
    console.log(C.gray + "例如: policy list       (查看待人工审批的高危调用)" + C.reset);
    console.log(C.gray + "      policy audit 20   (查看最近20条工具调用安全审计日志)\n" + C.reset);
  }
}

export async function handleBridge(client, args) {
  console.log(C.cyan + "🔌 正在查询宿主软件反向 IPC 网桥 (SoftwareBridge) 连接状态..." + C.reset);
  try {
    const resp = await client.callTool("studio__bridge__list", {});
    const data = JSON.parse(resp.content[0].text);
    const bridges = data.bridges || [];
    if (bridges.length === 0) {
      console.log(C.gray + "当前无活动的外部宿主软件网桥插件连接 (支持外部桌面软件反向注册)。\n" + C.reset);
    } else {
      console.log(C.green + `\n📋 已连接宿主软件插件 (${bridges.length} 个):\n` + C.reset);
      for (const b of bridges) {
        console.log(` • ${C.bold}${b.softwareName} ${b.softwareVersion}${C.reset} (ID: ${C.cyan}${b.bridgeId}${C.reset}, PID: ${b.pid})`);
        console.log(`   - 命令通道: ${b.streamConnected ? C.green + "已就绪" : C.red + "未连接"}${C.reset}`);
        console.log(`   - 暴露主线程工具: ${b.toolCount} 个`);
      }
      console.log("");
    }
  } catch (e) {
    console.log(C.red + `查询宿主网桥失败: ${e.message}\n` + C.reset);
  }
}

export async function handleConnector(client, args) {
  const sub = (args[0] || "").toLowerCase();
  if (sub === "import") {
    const connectorId = args[1];
    const specPath = args[2];
    if (!connectorId || !specPath) {
      console.log(C.yellow + "用法: connector import <服务ID> <OpenAPI JSON文件路径>" + C.reset);
      return;
    }
    const fullPath = path.resolve(specPath);
    if (!fs.existsSync(fullPath)) {
      console.log(C.red + `文件不存在: ${fullPath}\n` + C.reset);
      return;
    }
    try {
      const spec = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      console.log(C.cyan + `🌐 正在将 OpenAPI 规范导入为虚拟 MCP 服务 '${connectorId}'...` + C.reset);
      const resp = await client.callTool("studio__connector__import_openapi", {
        connector_id: connectorId,
        spec,
      });
      const data = JSON.parse(resp.content[0].text);
      console.log(C.green + C.bold + `🎉 虚拟 OpenAPI 服务 '${connectorId}' 导入成功！` + C.reset);
      console.log(` • 自动映射端点工具: ${data.toolCount} 个`);
      console.log(` • 持久化存储: .workbench_openapi/${connectorId}.json`);
      console.log(C.gray + " • 已热挂载入网关，全客户端立即可调用。\n" + C.reset);
    } catch (e) {
      console.log(C.red + `导入 OpenAPI 规范失败: ${e.message}\n` + C.reset);
    }
  } else {
    console.log(C.yellow + "用法: connector import <服务ID> <OpenAPI JSON文件路径>" + C.reset);
    console.log(C.gray + "例如: connector import petstore ./petstore.json\n" + C.reset);
  }
}
