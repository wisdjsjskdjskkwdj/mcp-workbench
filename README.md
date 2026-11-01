# 🛠️ MCP Workbench (v0.3.0)

> **面向大模型开发者的本地 MCP 网关、子服务器管理中心与零 Token 微智能体测试工作台**
>
> 聚合多子服务为统一 SSE 网关，支持 Cursor / Claude Desktop / Antigravity / Windsurf 一键免配置挂载，内置官方绿色 Node.js 离线环境与沙箱测试套件。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![Status](https://img.shields.io/badge/Status-Stable%20Verified-blue.svg)]()
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-orange.svg)]()
[![License](https://img.shields.io/badge/License-MIT-lightgrey.svg)]()

---

## 🌟 核心价值与亮点

- 🎯 **单入口聚合网关 (Unified SSE Gateway)**：开放本地单端口（默认 `http://127.0.0.1:43110/mcp`），一站式汇聚纳管的所有子服务器工具，并提供工具命名空间防冲突保护。
- ⚡ **零 Token 纯本地微智能体 (Local Sandbox Test)**：提供交互式 REPL 控制台，不依赖外部付费 LLM API 即可完成工具调用、参数 Schema 契约校验与边界模拟测试。
- 🖥️ **双模交互界面 (Web UI & CLI)**：高颜值现代 Web 仪表盘（可视化启停、配置分发、审计日志追踪）与极速终端 CLI，满足不同调试场景。
- 🌐 **多源部署与一键导入**：支持电脑本地单脚本 / ZIP 压缩包上传与自动推导，支持远程 Git 仓库（GitHub/GitLab）浅克隆与直接直链拉取。
- 🔌 **AI 客户端一键免配绑定**：智能扫描 Cursor、Claude Desktop、Antigravity、Cline、Windsurf 的配置文件，一键写入 Stdio-SSE 网关桥接配置并自动备份原文件。
- 📦 **纯净零外部依赖 + 内置绿色 Node.js**：基于 Node.js 原生标准库研发，**无需执行 `npm install` 下载庞大的 `node_modules`**；软件包内附带官方绿色离线包与一键配置脚本，离线也能开箱即用。

---

## 💡 为什么黑窗口关了，网页还在运行？（核心机制解读）

很多初次使用的用户会好奇：“**为什么关闭了命令行的黑窗口，浏览器打开的控制台网页依然可以正常刷新和交互？**”

这是经过专门设计的**后台守护架构（Daemon Architecture）与系统进程机制**：

### 1. 架构需求：AI 网关是底层基础设施
MCP Workbench 的核心使命是**为 Cursor、Claude Desktop 等 AI 客户端提供持续稳定的 MCP 工具连接**。
如果用户不小心随手关掉了某个 CMD 命令行窗口，导致网关瞬间死亡，那么您在 Cursor 里和大模型写代码、调工具的上下文链路就会立即中断报错。因此，工作台被设计为**无感常驻的本地守护服务**。

### 2. 操作系统层面的进程脱钩
当您双击 `start-web.bat` 时，CMD 黑窗口只是一个短暂的“启动引导器”。
脚本唤起 Node.js 后，实际执行网关监听的 `node.exe` 已经作为一个**独立的操作系统进程在后台平稳运行**，并绑定在本地 `43110` 端口上。即便黑窗口关闭，后台进程依然健康存活。浏览器只是向该本地端口请求界面的“展示器”，因此网页依然能够全功能实时交互。

---

## 🛑 如何彻底关闭服务的 3 种方法

如果您调试完毕，想要彻底释放 `43110` 端口并退出后台服务，可以使用以下任意一种方式：

### 方式 1：一键脚本安全关闭（⭐ 最推荐）
软件包根目录下已内置安全终止脚本，双击即可秒级关闭：
- **Windows 用户**：双击根目录下的 **`stop.bat`**。
- **macOS / Linux 用户**：终端执行 **`./stop.sh`**。

脚本会自动检索占用 `43110` 端口的后台进程 PID 并执行安全清理，同时清除运行锁文件。关闭后再刷新浏览器，页面将显示“无法访问此网站（连接已断开）”。

### 方式 2：在 Web 仪表盘中操作
在 Web 界面（`http://127.0.0.1:43110/ui`）右上角的快捷操作菜单中，点击 **“重启守护进程”** 或调用管理接口停止服务。

### 方式 3：系统任务管理器 / 命令行强退
- **Windows**：打开 Windows 任务管理器，在后台进程中找到名为 **`Node.js JavaScript Runtime`** 的进程，点击“结束任务”；或者以管理员身份在 CMD 执行：
  ```cmd
  for /f "tokens=5" %a in ('netstat -aon ^| findstr :43110 ^| findstr LISTENING') do taskkill /F /PID %a
  ```
- **macOS / Linux**：
  ```bash
  lsof -ti:43110 | xargs kill -9
  ```

---

## 🚀 快速启动指南

### 1. 运行环境准备
本项目运行时基于 Node.js 18 或更高版本：
- **Windows 用户**：
  - **自动静默就绪**：若电脑没有 Node.js，直接双击 `start-web.bat`，脚本会自动调用内置解压器将 `installers/node-v24.18.0-win-x64.zip` 解压至本地 `runtime/` 目录并自启动，**无需管理员权限，不修改系统环境变量**。
  - **手动一键安装**：双击运行 **`install-node.bat`** 即可就地解压。
- **macOS / Linux 用户**：
  - 终端运行 `./install-node.sh`，脚本将自动识别系统的包管理器（Homebrew、APT、DNF、Pacman）完成环境配置。

### 2. 常用启动入口

| 启动脚本 (Windows) | 启动脚本 (macOS/Linux) | 功能与用途 |
| :--- | :--- | :--- |
| **`start-web.bat`** | **`./start-web.sh`** | **最常用：** 启动后台网关守护进程，并自动调用系统默认浏览器打开 Web 仪表盘 |
| **`start-cli.bat`** | **`./start-cli.sh`** | **终端交互：** 启动微智能体交互测试控制台，提供快速调试与零 Token 沙箱体验 |
| **`start-daemon.bat`** | **`./start-daemon.sh`** | **独立前台：** 前台启动网关守护进程，实时滚动输出详细访问日志与 JSON-RPC 追踪 |
| **`stop.bat`** | **`./stop.sh`** | **一键终止：** 安全杀死占用 43110 端口的后台守护进程并清理锁文件 |

---

## 🖥️ 核心功能全景

### 1. 托管服务器生命周期 (Server Manager)
- 实时监控纳管子服务的运行状态（运行中 / 已停止 / 异常）、真实系统 PID、重启计数与工具量。
- 内置看门狗自动拉起崩溃子进程（Auto-Restart），保障调用链路高可用。

### 2. MCP 服务器上传与多种导入方式 (Upload & Import)
- **本地单脚本上传**：支持 `.js`, `.mjs`, `.py` 脚本，工作台自动推断运行环境（node/python）。
- **本地 ZIP 压缩包**：支持完整工程压缩包上传，服务端自动解压并注册入口。
- **远程 URL / Git 导入**：输入任意公开 Git 仓库地址（如 GitHub 上的 MCP 仓库），后台浅克隆并自动解析配置；亦支持单文件直链下载。
- **JSON 配置批量同步**：直接粘贴 Claude Desktop 或 Cursor 的 `mcpServers` 配置片段快速导入。

### 3. AI 客户端自动发现与一键绑定 (Client Binder)
- 自动扫描本地宿主环境中的 Cursor、Claude Desktop、Antigravity、Cline、Windsurf。
- 点击卡片上的 **“一键绑定 (Auto-Inject)”**，安全注入统一 Stdio-SSE 桥接器（`stdio_shim.js`），自动完成备份与热生效。

### 4. 持久化审计日志与调用历史 (Persistent Audit Logs)
- 记录所有由网关处理的 RPC 请求与响应（工具名、大模型传入的参数、返回值、执行耗时、时间戳）。
- 增量持久化存储在本地，**守护进程重启或电脑关机后历史调用数据依然完整保留**。

### 5. 微智能体测试沙箱 (Micro-Agent Sandbox)
- 在终端输入 `start-cli.bat` 唤起。
- 常用控制台指令：
  - `help`：查看指令大全
  - `status`：查看当前网关与所有子服务状态
  - `list`：列出当前挂载的所有顶层工具及其参数概要
  - `call <工具名>`：向导式入参提示并执行工具调用
  - `test <工具名>`：触发智能体边界测试与模拟数据调用

### 6. 企业级高危操作审批与安全护栏
- 内置高危模式拦截引擎（检测包含危险系统指令或文件操作的工具）。
- Web 端实时弹窗拦截与安全审批，需管理员手动点击“批准”方才放行，“拒绝”则向大模型返回安全防护提示。

---

## 📂 工程目录结构

```text
mcp-workbench/
├── dist/                      # 编译生成 / 运行时的 JavaScript 模块
├── src/                       # TypeScript 核心源码 (Daemon, ProcessPool, Shim, Binder)
├── micro_agent/               # 纯本地微智能体与交互式控制台模块
│   ├── cli/                   # REPL 交互引擎、参数向导与命令路由
│   ├── core/                  # JSON-RPC 客户端底层通讯
│   └── cli_frontend.mjs       # 控制台交互入口
├── scripts/                   # 维护与自动化构建脚本
├── installers/                # 官方绿色 Node.js 离线运行安装包
├── docs/                      # 规格说明与架构设计文档
├── MCP_Workbench_教学文档.pdf   # 随附高清图文教学手册
├── workbench.json             # 网关配置文件与纳管服务清单
├── start-web.bat / .sh        # Web 仪表盘启动脚本
├── start-cli.bat / .sh        # 交互控制台启动脚本
├── start-daemon.bat / .sh     # 守护进程启动脚本
├── stop.bat / .sh             # 一键安全关闭脚本
├── install-node.bat / .sh     # Node.js 绿色运行环境一键配置脚本
└── package.json               # 项目包定义与依赖配置
```

---

## 📄 授权与许可

本项目采用 [MIT License](LICENSE) 开源许可证。
欢迎提交 Issue 与 Pull Request 共同打造更好用的 MCP 本地中枢与微智能体开发环境！
