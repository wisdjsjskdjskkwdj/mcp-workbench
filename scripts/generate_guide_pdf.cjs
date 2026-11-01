const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>MCP Workbench 使用教学指南与核心架构手册</title>
<style>
  @page {
    size: A4;
    margin: 18mm 16mm 18mm 16mm;
    @bottom-center {
      content: counter(page);
      font-size: 10pt;
      color: #777;
    }
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: #1a1a1a;
    line-height: 1.6;
    font-size: 10pt;
    margin: 0;
    padding: 0;
  }
  h1, h2, h3, h4 {
    color: #0d1117;
    font-weight: 700;
    margin-top: 1.2em;
    margin-bottom: 0.5em;
    page-break-after: avoid;
  }
  h1 {
    font-size: 20pt;
    border-bottom: 2px solid #2563eb;
    padding-bottom: 8px;
    margin-top: 0;
    text-align: center;
    color: #1e3a8a;
  }
  .subtitle {
    text-align: center;
    color: #4b5563;
    font-size: 10.5pt;
    margin-top: -4px;
    margin-bottom: 20px;
  }
  h2 {
    font-size: 13pt;
    border-left: 4px solid #2563eb;
    padding-left: 10px;
    background: #f8fafc;
    padding-top: 4px;
    padding-bottom: 4px;
    margin-top: 20px;
    border-radius: 0 4px 4px 0;
  }
  h3 {
    font-size: 11pt;
    margin-top: 14px;
    color: #1e293b;
  }
  p {
    margin: 0.5em 0;
    text-align: justify;
  }
  ul, ol {
    margin: 0.5em 0;
    padding-left: 20px;
  }
  li {
    margin-bottom: 4px;
  }
  code {
    font-family: Consolas, Monaco, "Courier New", monospace;
    background: #f1f5f9;
    padding: 2px 5px;
    border-radius: 3px;
    font-size: 8.8pt;
    border: 1px solid #e2e8f0;
    color: #0f172a;
  }
  pre {
    background: #0f172a;
    color: #f8fafc;
    padding: 10px 14px;
    border-radius: 6px;
    overflow-x: auto;
    font-family: Consolas, Monaco, monospace;
    font-size: 8.5pt;
    line-height: 1.45;
    margin: 8px 0;
    page-break-inside: avoid;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 9pt;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 6px 10px;
    text-align: left;
  }
  th {
    background-color: #f1f5f9;
    font-weight: 600;
    color: #1e293b;
  }
  tr:nth-child(even) {
    background-color: #f8fafc;
  }
  .card {
    border: 1px solid #e2e8f0;
    background: #ffffff;
    padding: 12px 14px;
    border-radius: 6px;
    margin: 10px 0;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    page-break-inside: avoid;
  }
  .badge {
    display: inline-block;
    padding: 2px 7px;
    font-size: 8pt;
    font-weight: 600;
    border-radius: 4px;
    margin-right: 4px;
  }
  .badge-blue { background: #dbeafe; color: #1e40af; }
  .badge-green { background: #dcfce7; color: #166534; }
  .badge-purple { background: #f3e8ff; color: #6b21a8; }
  .badge-orange { background: #ffedd5; color: #9a3412; }
  .callout-tip {
    border-left: 4px solid #10b981;
    background: #ecfdf5;
    padding: 10px 14px;
    margin: 12px 0;
    border-radius: 0 6px 6px 0;
    font-size: 9.3pt;
  }
  .callout-warn {
    border-left: 4px solid #f59e0b;
    background: #fffbeb;
    padding: 10px 14px;
    margin: 12px 0;
    border-radius: 0 6px 6px 0;
    font-size: 9.3pt;
  }
  .page-break {
    page-break-after: always;
  }
</style>
</head>
<body>

<h1>🛠️ MCP Workbench 使用教学指南与核心架构手册</h1>
<div class="subtitle">面向大模型应用开发者的微智能体测试工作台与高可用 MCP 网关中枢 (v0.3.0)</div>

<h2>一、产品概述与核心价值</h2>
<p>
  <strong>MCP Workbench</strong> 是一款专为 Anthropic Model Context Protocol (MCP) 设计的开发者工具箱与统一代理网关。它彻底解决了在接入、调试、管理多套 MCP 服务时所面临的配置繁琐、进程黑盒崩溃、外部 AI 依赖高昂 Token 等痛点，提供了一站式的本地工作台体验。
</p>
<div class="card">
  <p><strong>核心架构三大支柱：</strong></p>
  <ul>
    <li><span class="badge badge-blue">单入口聚合网关 (Unified SSE Gateway)</span>：在本地开放统一网关端口（<code>http://127.0.0.1:43110/mcp</code>），自动汇聚注册的所有子服务器工具，并支持别名防冲突机制。</li>
    <li><span class="badge badge-green">双模交互控制台 (Web Dashboard & CLI)</span>：拥有高颜值的 Web 仪表盘（可视化管理、在线上传、审计监控、配置下发）与极速交互式终端 CLI（内置沙箱模拟执行）。</li>
    <li><span class="badge badge-orange">内置 Node.js 绿色运行环境</span>：各操作系统发行包内直接附带官方 Node.js 离线环境与一键配置脚本，无需安装环境即可开箱即用，零外部 npm 依赖，极致纯净。</li>
  </ul>
</div>

<h2>二、内置 Node.js 绿色运行环境与一键安装说明</h2>
<p>
  MCP Workbench 运行时完全采用 Node.js 原生标准库研发，<strong>不依赖任何第三方 <code>node_modules</code></strong>。为了让从未安装过 Node.js 的电脑也能一秒上手，软件包中内置了与宿主系统完全匹配的官方绿色 Node.js 离线运行包。
</p>

<h3>1. Windows 用户一键初始化</h3>
<div class="card">
  <p><strong>方式 A（全自动静默唤起 - 最推荐）：</strong></p>
  <p>直接双击 <code>start-web.bat</code> 或 <code>start-cli.bat</code>！脚本内置智能检测机制，当检测到本机未安装 Node.js 时，将<strong>自动调用内置解压器</strong>将 <code>installers/node-v24.18.0-win-x64.zip</code> 解压至 <code>runtime</code> 独立目录并自动完成启动，全程无需人工干预。</p>
  <p><strong>方式 B（手动一键配置脚本）：</strong></p>
  <p>双击软件包根目录下的 <code>install-node.bat</code>。该脚本会自动完成运行库解压与就绪校验，提示 <code>[SUCCESS] Node.js 运行环境已成功就绪！</code>。</p>
</div>

<div class="callout-tip">
  <strong>💡 绿色便携特性：</strong>
  解压后的 Node.js 独立运行在当前工作区目录下的 <code>runtime</code> 文件夹中，<strong>不修改系统环境变量 PATH，不需要系统管理员权限</strong>，不与其他全局 Node.js 版本发生任何冲突，卸载时仅需直接删除文件夹即可，实现绝对干净绿色。
</div>

<h3>2. macOS / Linux 用户一键安装</h3>
<p>macOS 与 Linux 系统附带了一键化检测与安装脚本 <code>install-node.sh</code>：</p>
<pre># 授予执行权限并运行安装脚本
chmod +x *.sh
./install-node.sh</pre>
<p>脚本将自动识别当前操作系统及包管理器（macOS Homebrew、Debian/Ubuntu APT、Fedora/RHEL DNF、Arch Linux Pacman）并一键配置环境。</p>

<h2>三、快速启动与生命周期管理</h2>
<p>软件包根目录下提供了多种启动与停止方式，满足日常开发与后台常驻需求：</p>

<table>
  <thead>
    <tr>
      <th>脚本文件 (Windows)</th>
      <th>脚本文件 (macOS/Linux)</th>
      <th>功能说明</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>start-web.bat</code></td>
      <td><code>./start-web.sh</code></td>
      <td><strong>一键体验：</strong>后台启动网关守护进程，并自动调用系统默认浏览器打开 Web 管理界面</td>
    </tr>
    <tr>
      <td><code>start-cli.bat</code></td>
      <td><code>./start-cli.sh</code></td>
      <td><strong>交互终端：</strong>启动微智能体交互测试控制台，提供快速调试、工具调用与零 Token 沙箱体验</td>
    </tr>
    <tr>
      <td><code>start-daemon.bat</code></td>
      <td><code>./start-daemon.sh</code></td>
      <td><strong>独立网关服务：</strong>仅启动后台 MCP 网关与 SSE 聚合服务，前台实时输出日志</td>
    </tr>
    <tr>
      <td><code>stop.bat</code></td>
      <td><code>./stop.sh</code></td>
      <td><strong>一键安全终止：</strong>快速关闭 43110 端口上的后台守护进程与所有子服务器，清理锁文件</td>
    </tr>
  </tbody>
</table>

<div class="callout-warn">
  <strong>⚠️ 关于后台守护进程的说明：</strong>
  当您关闭控制台黑窗口时，为了保证挂载在 Cursor、Claude 等 AI 客户端的 MCP 网关不中断，守护进程会在后台持续运行。若需要彻底关闭服务并退出网页，只需双击运行 <code>stop.bat</code> (或执行 <code>./stop.sh</code>) 即可秒级安全终止。
</div>

<div class="page-break"></div>

<h2>四、核心功能全景操作指南</h2>

<h3>1. 托管服务器生命周期管理 (Server Manager)</h3>
<p>
  在 Web 控制台的 <strong>“服务器状态”</strong> 面板中，您可以对已注册的 MCP 独立服务进行全周期管控：
</p>
<ul>
  <li><strong>健康状态与实时指标：</strong>实时查看各服务器当前运行状态（运行中 / 已停止 / 错误）、系统分配的真实 PID、内存占用、重启次数与挂载工具总数。</li>
  <li><strong>启停控制：</strong>支持单独或批量对目标服务器执行 <code>启动</code>、<code>停止</code>、<code>重启</code> 操作。</li>
  <li><strong>崩溃自动拉起 (Auto-Restart)：</strong>内置看门狗机制，当任何由工作台托管的 MCP 进程意外崩溃或退出时，守护进程将在指数退避间隔后自动拉起，保障大模型调用链路永不中断。</li>
</ul>

<h3>2. MCP 服务器上传与多种导入方式 (Server Upload & Import)</h3>
<p>
  在 Web 界面点击 <strong>“➕ 添加服务器”</strong> 按钮，进入强大的部署向导：
</p>
<ul>
  <li><strong>方式一：从本机电脑上传 (Local Upload)：</strong>
    <ul>
      <li><strong>单个脚本文件：</strong>支持直接上传 <code>.js</code>、<code>.mjs</code>、<code>.py</code> 脚本，工作台将自动放置于 <code>servers/</code> 目录并自动推导执行环境（如 node、python）。</li>
      <li><strong>压缩包 (ZIP)：</strong>支持上传包含完整工程的 <code>.zip</code> 压缩包，工作台会在服务器端自动完成解压并注册其入口文件。</li>
    </ul>
  </li>
  <li><strong>方式二：从远程 URL 拉取 (Remote Import)：</strong>
    <ul>
      <li><strong>Git 仓库自动克隆：</strong>输入任意 Git 仓库地址（如 GitHub 上的开源 MCP 服务器），后台自动执行浅克隆，并自动解析其中的 <code>package.json</code> 或 <code>pyproject.toml</code> 提取配置。</li>
      <li><strong>远程直链下载：</strong>输入单一脚本或压缩包的网络公开 URL（HTTP/HTTPS），后台自动拉取并导入。</li>
    </ul>
  </li>
  <li><strong>方式三：JSON 配置批量导入：</strong>
    <ul>
      <li>支持直接粘贴标准 <code>mcpServers</code> JSON 片段（兼容 Claude Desktop 与 Cursor 配置格式），秒级同步到工作台。</li>
    </ul>
  </li>
</ul>

<h3>3. AI 客户端自动发现与一键绑定 (Client Integrations)</h3>
<p>
  以往开发者需要在每个 IDE 和 AI 工具（Cursor、Claude、Antigravity、Cline、Windsurf 等）的复杂路径下手动查找并修改 <code>settings.json</code> 或 <code>claude_desktop_config.json</code>，格式稍有不对就会导致软件报错。
</p>
<p>
  MCP Workbench 彻底革新了这一体验：
</p>
<ul>
  <li><strong>多客户端智能侦测：</strong>守护进程启动时会自动扫描本机的各个宿主客户端配置文件路径，并识别其当前是否已正确挂载本工作台网关。</li>
  <li><strong>一键免配置绑定 (Auto-Inject)：</strong>在 Web 界面的客户端卡片上点击 <code>一键绑定 (Auto-Inject)</code>，工作台将使用 Stdio-SSE 桥接器（<code>stdio_shim.js</code>）安全、无侵入地将网关写入目标客户端配置，并自动创建备份文件。</li>
  <li><strong>统一接入地址：</strong>客户端只需连接工作台单端口，便可同时调用所有注册子服务器的全部工具，无需再为每个 MCP 服务器配置单独的命令行参数。</li>
</ul>

<h3>4. 持久化审计日志与调用历史 (Persistent Audit Logs)</h3>
<p>
  所有经由网关转发的 JSON-RPC 请求与响应（<code>tools/list</code>、<code>tools/call</code> 等）均会被完整记录并持久化保存在本地数据仓库中：
</p>
<ul>
  <li><strong>重启后数据不丢失：</strong>日志采用轻量级 JSONL 增量持久化存储，即使重启电脑或多次重启守护进程，历史调用数据依然完整保留。</li>
  <li><strong>多维度筛选与检索：</strong>支持按工具名、服务器来源、时间范围、审批状态（已执行 / 已拦截 / 异常）进行快速过滤。</li>
  <li><strong>全参数追踪与性能分析：</strong>点击任一调用记录可完整查看大模型传入的完整入参、工具返回的具体数据、耗时毫秒数以及执行时间戳。</li>
</ul>

<h3>5. 微智能体测试控制台 (Micro-Agent CLI & Sandbox)</h3>
<p>
  为了在不花费 API Token 的情况下验证 MCP 工具的可用性与入参契约，工作台提供了独特的交互式控制台：
</p>
<ul>
  <li>输入 <code>help</code> 查看所有支持的指令（<code>list</code>、<code>servers</code>、<code>call</code>、<code>inspect</code>、<code>test</code> 等）。</li>
  <li>输入 <code>list</code> 快速浏览当前网关聚合的所有可用工具及其参数 Schema 概要。</li>
  <li>输入 <code>call &lt;tool_name&gt; &lt;json_args&gt;</code> 直接对工具发起单点调用，验证真实执行结果。</li>
  <li>输入 <code>test &lt;tool_name&gt;</code> 启动智能体模拟执行流，自动生成合规模拟数据并测试边界条件。</li>
</ul>

<div class="page-break"></div>

<h2>五、企业级安全策略与高危指令审批</h2>
<div class="card">
  <p><strong>拦截与防护机制：</strong></p>
  <p>当接入外部不受信的 AI 模型时，模型可能会尝试调用具有文件删除、系统命令执行等高危操作的工具。MCP Workbench 提供了双层安全保障：</p>
  <ul>
    <li><strong>内置白名单与规则引擎：</strong>可配置危险模式识别，例如对包含 <code>rm</code>、<code>del</code>、<code>execute</code> 的高危工具强制挂起。</li>
    <li><strong>Web 实时拦截弹窗：</strong>当高危调用发生时，请求将被挂起并在 Web 仪表盘顶部弹出警报，显示调用参数与时间。管理员手动点击“批准”后方才放行，“拒绝”则向大模型返回安全受阻提示。</li>
  </ul>
</div>

<h2>六、常见问题排查与技术支持 (FAQ)</h2>

<div class="card">
  <p><strong>Q1：启动时提示“端口 43110 已被占用”或连接失败怎么处理？</strong></p>
  <p><strong>答：</strong>这是因为此前已有后台守护进程在运行。直接双击运行 <code>stop.bat</code>（Linux/macOS 运行 <code>./stop.sh</code>），脚本会自动强行终止占用 43110 端口的残留进程并清理锁文件。随后重新双击 <code>start-web.bat</code> 即可顺畅启动。</p>
</div>

<div class="card">
  <p><strong>Q2：打开网页端后，为什么黑窗口关闭了网页还能正常刷新？</strong></p>
  <p><strong>答：</strong>这是经过专门设计的守护进程常驻模式。MCP 网关是一个需要为各个 AI 客户端（如 Cursor）提供持续连接的基础服务，黑窗口仅为临时启动引导器，实际网关服务由 Node.js 独立工作在后台。如需彻底关闭服务，运行 <code>stop.bat</code> 即可。</p>
</div>

<div class="card">
  <p><strong>Q3：换了一台全新电脑，没有联网能直接使用内置的 Node.js 吗？</strong></p>
  <p><strong>答：</strong>完全可以！Windows 压缩包内置了完整的 <code>node-v24.18.0-win-x64.zip</code> 离线包。即便在完全离线的内网电脑上，双击 <code>install-node.bat</code> 也会本地就地解压并就绪，不产生任何外网请求，真正做到纯内网、开箱即用。</p>
</div>

<div class="card">
  <p><strong>Q4：打包发布的三个系统版本中，是否移除了本地私有路径与专属软件？</strong></p>
  <p><strong>答：</strong>是的！在 <code>F:\\mcp_workbench</code> 导出的 Windows、macOS、Linux 三个平台安装包中，已完全剔除宿主电脑的特定软件插件（如 Revit、REA）以及所有带有本机绝对路径、用户名的私有痕迹，保留了标准纯净的 <code>sys_clock</code>（系统时钟）和 <code>math_ops</code>（数学计算）样例服务，保证跨平台分发的通用性与绝对私密安全。</p>
</div>

<hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 30px 0 10px 0;">
<div style="text-align: center; color: #94a3b8; font-size: 8.5pt;">
  MCP Workbench (v0.3.0) • 纯本地测试模式 • 零 Token 消耗 • 零外部 npm 依赖
</div>

</body>
</html>
`;

const tempHtmlPath = path.resolve('temp_guide_doc.html');
const outputPdfPath = path.resolve('MCP_Workbench_教学文档.pdf');

fs.writeFileSync(tempHtmlPath, htmlContent, 'utf8');
console.log('Generated HTML template at:', tempHtmlPath);

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chromePath)) {
  console.error('Chrome not found at:', chromePath);
  process.exit(1);
}

const printArgs = [
  '--headless',
  '--disable-gpu',
  '--run-all-compositor-stages-before-draw',
  '--no-pdf-header-footer',
  `--print-to-pdf="${outputPdfPath}"`,
  `"${tempHtmlPath}"`
].join(' ');

console.log('Rendering PDF with Chrome headless...');
execSync(`"${chromePath}" ${printArgs}`, { stdio: 'inherit' });

if (fs.existsSync(outputPdfPath)) {
  const stat = fs.statSync(outputPdfPath);
  console.log(`[SUCCESS] Generated PDF (${stat.size} bytes): ${outputPdfPath}`);
  fs.unlinkSync(tempHtmlPath);
} else {
  console.error('[ERROR] Failed to generate PDF output.');
  process.exit(1);
}
