import path from "node:path";
import { VersionManager } from "../../../dist/version_manager.js";
import { C } from "../../core/config.mjs";

const vm = new VersionManager();

/**
 * CLI command: `history` / `snapshots`
 */
export async function cmdHistory(client, args = []) {
  const limit = Number(args[0] ?? 15);
  console.log(`\n${C.cyan}📜 正在查询项目历史快照与版本记录...${C.reset}`);

  const status = vm.getStatus();
  const history = vm.listHistory(limit);

  console.log(`\n${C.bold}📌 工作区当前状态:${C.reset}`);
  console.log(`  • 当前分支:   ${C.yellow}${status.currentBranch}${C.reset}`);
  console.log(`  • 当前提交:   ${C.cyan}${status.currentCommit}${C.reset}`);
  console.log(
    `  • 工作区状态: ${
      status.isClean
        ? `${C.green}干净 (无未提交修改)${C.reset}`
        : `${C.yellow}存在 ${status.totalChanged} 个未快照的修改文件${C.reset}`
    }`
  );

  if (!status.isClean) {
    if (status.modifiedFiles.length > 0) {
      console.log(`    - 已修改: ${status.modifiedFiles.slice(0, 5).join(", ")}${status.modifiedFiles.length > 5 ? "..." : ""}`);
    }
    if (status.untrackedFiles.length > 0) {
      console.log(`    - 新增未跟踪: ${status.untrackedFiles.slice(0, 5).join(", ")}${status.untrackedFiles.length > 5 ? "..." : ""}`);
    }
    console.log(`    ${C.gray}💡 提示: 可输入 'snapshot <名称>' 保存当前改动为快照${C.reset}`);
  }

  if (history.length === 0) {
    console.log(`\n${C.yellow}暂无历史版本记录。${C.reset}`);
    return;
  }

  console.log(`\n${C.bold}📜 历史版本与快照记录 (显示最新 ${history.length} 条):${C.reset}`);
  console.log("─".repeat(88));
  console.log(
    `  ${"状态".padEnd(4)} | ${"提交ID".padEnd(8)} | ${"标签/快照名".padEnd(26)} | ${"快照时间".padEnd(19)} | 描述`
  );
  console.log("─".repeat(88));

  history.forEach((h, idx) => {
    const isCurrentMark = h.isCurrent ? `${C.green}* 当前${C.reset}` : `  ${idx + 1}  `;
    const tagDisplay = h.tags.length > 0 ? h.tags.join(", ") : "—";
    const truncatedMsg = h.message.length > 30 ? h.message.slice(0, 27) + "..." : h.message;
    console.log(
      `  ${isCurrentMark} | ${C.cyan}${h.shortHash.padEnd(8)}${C.reset} | ${C.yellow}${tagDisplay.slice(0, 26).padEnd(26)}${C.reset} | ${h.date} | ${truncatedMsg}`
    );
  });
  console.log("─".repeat(88));
  console.log(`${C.gray}💡 回退命令: rollback <提交ID或标签名> (例如: rollback ${history[0]?.shortHash})${C.reset}\n`);
}

/**
 * CLI command: `snapshot <name> [description]`
 */
export async function cmdSnapshot(client, args = []) {
  if (args.length === 0) {
    console.log(`${C.yellow}⚠️  使用方法: snapshot <快照名称> [描述说明]${C.reset}`);
    console.log(`   示例: snapshot "before-agent-tools" "挂载智能体工具前的稳定备份"`);
    return;
  }

  const name = args[0];
  const description = args.slice(1).join(" ") || `Manual checkpoint '${name}'`;

  console.log(`\n${C.cyan}📸 正在为项目创建全局原子快照 '${name}'...${C.reset}`);

  try {
    const res = vm.createSnapshot(name, description);
    console.log(`${C.green}✅ 快照创建成功！${C.reset}`);
    console.log(`  • 快照标签: ${C.yellow}${res.tagName}${C.reset}`);
    console.log(`  • 对应提交: ${C.cyan}${res.shortHash}${C.reset}`);
    console.log(`  • 说明备注: ${description}`);
    console.log(`  • 创建时间: ${new Date().toLocaleString()}`);
    console.log(`${C.gray}💡 随时可使用 'rollback ${res.tagName}' 一键安全回滚到此状态${C.reset}\n`);
  } catch (err) {
    console.log(`${C.red}❌ 创建快照失败: ${err.message}${C.reset}`);
  }
}

/**
 * CLI command: `diff [target]`
 */
export async function cmdDiff(client, args = []) {
  const target = args[0] || "HEAD";
  console.log(`\n${C.cyan}🔍 正在比对当前工作区与 '${target}' 的代码差异...${C.reset}`);

  const diffResult = vm.getDiff(target);
  if (!diffResult.stat && !diffResult.diff) {
    console.log(`${C.green}工作区与 '${target}' 完全一致，无任何代码差异。${C.reset}\n`);
    return;
  }

  if (diffResult.stat) {
    console.log(`\n${C.bold}📊 变更统计概览:${C.reset}`);
    console.log(diffResult.stat);
  }

  if (diffResult.diff) {
    console.log(`\n${C.bold}📝 详细代码差异 (前 30 行预览):${C.reset}`);
    const previewLines = diffResult.diff.split("\n").slice(0, 30).join("\n");
    console.log(previewLines);
    if (diffResult.diff.split("\n").length > 30) {
      console.log(`${C.gray}... (余下差异已省略)${C.reset}`);
    }
  }
  console.log("");
}

/**
 * CLI command: `rollback <target>`
 */
export async function cmdRollback(client, args = []) {
  if (args.length === 0) {
    console.log(`${C.yellow}⚠️  使用方法: rollback <目标提交ID或快照标签>${C.reset}`);
    console.log(`   示例: rollback v0.0.3-baseline`);
    console.log(`   提示: 可先输入 'history' 查看所有可回退的版本ID与快照名。`);
    return;
  }

  const target = args[0];
  console.log(`\n${C.yellow}⚠️  正在准备将项目回退到: ${C.bold}${target}${C.reset}...`);

  try {
    const res = vm.rollback(target, true);
    console.log(`${C.green}✅ 项目回退成功！${C.reset}`);
    console.log(`  • 当前工作区已锁定到: ${C.cyan}${res.resolvedCommit.slice(0, 7)}${C.reset} (${res.target})`);
    if (res.safetyBackupTag) {
      console.log(`  • ${C.bold}安全保护:${C.reset} 回退前的工作区修改已自动备份为快照标签: ${C.yellow}${res.safetyBackupTag}${C.reset}`);
      console.log(`    (如需撤销回退，可输入 'rollback ${res.safetyBackupTag}')`);
    }
    console.log(`  • 状态说明: 所有源码、配置均已恢复至该快照时点！\n`);
  } catch (err) {
    console.log(`${C.red}❌ 回退失败: ${err.message}${C.reset}`);
  }
}

/**
 * CLI command: `undo` / `discard`
 * Discards all local uncommitted edits and restores clean state without needing prior snapshots.
 */
export async function cmdUndo(client) {
  console.log(`\n${C.yellow}🔄 正在为您一键撤销刚才的所有本地临时修改...${C.reset}`);
  try {
    const res = vm.undo();
    if (res.safetyBackupTag) {
      console.log(`${C.green}✅ 撤销成功！${C.reset}`);
      console.log(`  • 说明: ${res.message}`);
      console.log(`  • 安全提示: 刚才改动的内容已自动暂存为 '${res.safetyBackupTag}'，如需找回可随时 rollback。`);
    } else {
      console.log(`${C.cyan}ℹ️  ${res.message}${C.reset}`);
    }
    console.log("");
  } catch (err) {
    console.log(`${C.red}❌ 撤销失败: ${err.message}${C.reset}`);
  }
}
