# Micro-Agent for MCP Workbench (Modular Architecture)

这是一个在工作区内搭建的轻量级自主 Agent 原型与测试工具套件，用于在**纯本地、零外部 API 依赖**下，直接测试和验证 **MCP Workbench Gateway** 的全部核心能力。

## 模块化目录结构

```text
micro_agent/
├── index.mjs                   # 统一模块化导出入口
├── cli_frontend.mjs            # 命令行交互控制台主入口 (轻量门面层，向后完全兼容)
├── run_agent.mjs               # Agent 单指令任务运行器
├── test_agent.mjs              # 6 步自动化端到端测试套件
├── core/                       # 核心底层与通用协议模块
│   ├── config.mjs              # ANSI 彩色样式表、系统常量与 Banner
│   └── mcp_client.mjs          # 原生 JSON-RPC 2.0 Stdio 客户端连接器
├── cli/                        # 交互式命令行工具模块
│   ├── repl.mjs                # Readline 交互式会话引擎 (自动补全、按键拦截、容错分发)
│   ├── runner.mjs              # 命令路由执行器 (单次执行模式 vs 交互会话模式)
│   ├── wizard.mjs              # 交互式 Schema 参数收集向导 (无需手动拼 JSON)
│   └── commands/               # 各子命令独立实现
│       ├── cmd_status.mjs      # status (网关状态) 与 servers (服务拓扑)
│       ├── cmd_tools.mjs       # tools (列出工具) 与 search (冷工具检索)
│       ├── cmd_call.mjs        # call (工具调用/向导) 与 invoke (冷工具直调)
│       ├── cmd_servers.mjs     # add (动态挂载) 与 remove (服务下线)
│       ├── cmd_clients.mjs     # scan (客户端扫描), bind (接管), unbind (还原)
│       └── cmd_test.mjs        # test (测试套件调度)
└── mini_agent.mjs              # 具备“思考-规划-行动-自举”闭环的微 Agent 核心引擎
```

## 启动方式

无需任何 LLM API Key，直接启动纯本地的交互式 MCP 测试控制台：

```powershell
npm run cli
# 或双击根目录下的 start-cli.bat
```

### 控制台支持的交互命令一览：

| 命令 | 说明与示例 |
| :--- | :--- |
| `status` | 查看当前网关状态、工作区路径、已纳管的服务与可用工具总数 |
| `servers` | 打印当前纳管的服务拓扑表格（服务名、PID、健康状态、工具数） |
| `tools [keyword]` | 列出当前暴露的所有顶层工具（支持按关键词过滤，如 `tools math`） |
| `search <query>` | **跨所有服务检索冷工具/隐藏工具**（如 `search fibonacci`） |
| `call <tool> [args]` | **调用工具**（如果省略参数将**自动启动交互式参数向导**逐项询问） |
| `invoke <srv> <tool> [args]` | **穿透调用冷工具**（如 `invoke math_ops fibonacci {"n":8}`） |
| `add <id> <cmd> [args...]` | **动态热挂载新服务**（如 `add weather node ./dist/test_servers/mock_server_c.js`） |
| `remove <id>` | **动态下线指定服务**并释放子进程 |
| `scan` | 执行 5 层发现漏斗扫描本机已安装的 AI 客户端 (Cursor, Claude 等) |
| `bind <client> [options]` | 一键无损接管客户端并导入其存量服务 |
| `unbind <client>` | 一键恢复客户端原始配置并清除备份 |
| `test [suite]` | 一键运行测试套件（可选: `all`, `math`, `clock`, `cold`, `weather`, `client`） |
| `clear` | 清空控制台屏幕 |
| `exit / quit` | 安全退出控制台 |

> **特性**：
> 1. **Tab 键智能补全**：支持指令、工具名、客户端名、测试套件名的即时补全；
> 2. **参数输入向导 (Schema Wizard)**：直接输入 `call math_ops__add`，向导会根据其 JSON Schema 逐项提示参数，告别手动转义 JSON 字符串；
> 3. **智能容错**：在控制台中无论是否带有 `node` 或脚本前缀，均能自动识别执行。

---

## 单指令直出模式 (One-shot Mode)

你也可以直接在终端中附带参数快速执行单条指令：

```powershell
# 查看状态
npm run cli -- status

# 查看服务拓扑
npm run cli -- servers

# 跨服务检索冷工具
npm run cli -- search fibonacci

# 调用加法
npm run cli -- call math_ops__add '{"a":100,"b":23}'

# 执行全套测试
npm run cli -- test all
```

---

## 运行微 Agent 全自动化回归测试

在项目根目录下执行：

```powershell
npm run agent:test
```
涵盖：
1. 时钟感知感知查询
2. 多步工具链式复合运算
3. 跨服务冷工具动态检索与直调
4. 缺失能力自主发现与动态挂载自举 (Self-Bootstrapping)
5. 动态挂载服务的安全卸载与清理
6. 客户端 5 层发现漏斗扫描
