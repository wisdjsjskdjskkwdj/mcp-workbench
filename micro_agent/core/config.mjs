/**
 * ANSI Color Palette and UI Formatting Constants for Micro-Agent.
 */
export const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",

  // Foreground Colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Background Colors
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
  bgCyan: "\x1b[46m",
};

export const BANNER = `
${C.cyan}${C.bold}========================================================================${C.reset}
${C.cyan}${C.bold}   🛠️   MCP Workbench - Micro-Agent CLI Test Suite & Gateway Studio     ${C.reset}
${C.cyan}${C.bold}========================================================================${C.reset}
  ${C.gray}• Web 仪表盘:${C.reset}  ${C.cyan}${C.bold}http://127.0.0.1:43110/ui${C.reset} ${C.gray}(浏览器直接访问查看状态与审批)${C.reset}
  ${C.gray}• 单入口网关:${C.reset}  ${C.green}http://127.0.0.1:43110/mcp${C.reset} ${C.gray}(供 AI 客户端/StdioShim 挂载)${C.reset}
  ${C.gray}• 运行模式:${C.reset}    ${C.magenta}纯本地测试模式 (无外部 LLM API 依赖 / 零 Token 消耗)${C.reset}
  ${C.gray}• 快速帮助:${C.reset}    输入 ${C.bold}${C.yellow}help${C.reset} 查看指令列表，输入 ${C.bold}${C.yellow}exit${C.reset} 或 ${C.bold}${C.yellow}quit${C.reset} 退出控制台
${C.cyan}${C.bold}------------------------------------------------------------------------${C.reset}
`;
