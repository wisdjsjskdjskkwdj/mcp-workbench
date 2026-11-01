import type { WorkbenchRegistry } from "./registry.js";
import type { PolicyGuard } from "./policy_guard.js";
import type { SecretVault } from "./secret_vault.js";
import type { ClientAutoBinder } from "./client_binder.js";
import type { SoftwareBridge } from "./software_bridge.js";
import type { ContextProfileRouter } from "./profile_router.js";

export class WebConsole {
  private readonly registry: WorkbenchRegistry;
  private readonly policyGuard: PolicyGuard;
  private readonly secretVault: SecretVault;
  private readonly clientBinder: ClientAutoBinder;
  private readonly softwareBridge: SoftwareBridge;
  private readonly profileRouter?: ContextProfileRouter;

  constructor(
    registry: WorkbenchRegistry,
    policyGuard: PolicyGuard,
    secretVault: SecretVault,
    clientBinder: ClientAutoBinder,
    softwareBridge: SoftwareBridge,
    profileRouter?: ContextProfileRouter
  ) {
    this.registry = registry;
    this.policyGuard = policyGuard;
    this.secretVault = secretVault;
    this.clientBinder = clientBinder;
    this.softwareBridge = softwareBridge;
    this.profileRouter = profileRouter;
  }

  public getDashboardState(): Record<string, any> {
    return {
      version: "0.3.0",
      webUiEnabled: this.registry.isWebUiEnabled(),
      timestamp: new Date().toISOString(),
      servers: this.registry.getAllRuntimeStates(),
      counts: {
        tools: this.registry.getAllTools().length,
        topLevelTools: this.registry.getTopLevelExposedTools().length,
        resources: this.registry.getAllResources().length,
        prompts: this.registry.getAllPrompts().length,
      },
      tools: this.registry.getAllTools().map((t) => ({
        toolId: t.toolId,
        serverId: t.serverId,
        name: t.originalName,
        exposedName: t.exposedName,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      pendingApprovals: this.policyGuard.listPendingApprovals(),
      policyRules: this.policyGuard.listPolicyRules(),
      profiles: this.profileRouter ? this.profileRouter.listProfiles() : [],
      secrets: this.secretVault.listSecretKeys(),
      bridges: this.softwareBridge.listActiveBridges(),
      clients: this.clientBinder.scanClients(),
      recentAuditLogs: this.policyGuard.getAuditLogs(30),
    };
  }

  public renderHtmlConsole(port: number): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>MCP Workbench 控制台 (MCP Workbench Control Center)</title>
  <style>
    :root {
      --bg: #000000;
      --card: #111111;
      --border: #222222;
      --border-focus: #444444;
      --text: #ffffff;
      --muted: #888888;
      --dim: #555555;
      --ok: #22c55e;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 24px;
      line-height: 1.5;
      min-height: 100vh;
    }
    @media (max-width: 768px) {
      body { padding: 12px; }
    }

    /* Status Dot System: ONLY status dots carry color */
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
      flex-shrink: 0;
    }
    .dot-ok {
      background: var(--ok);
      box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
    }
    .dot-danger {
      background: var(--danger);
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .title-group h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.3px;
    }
    .title-group p {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      background: #181818;
      border: 1px solid var(--border);
      color: var(--text);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 18px;
      margin-bottom: 24px;
    }
    @media (max-width: 640px) {
      .grid { grid-template-columns: 1fr; }
    }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
    }
    .card h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .table-container {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scroll-behavior: smooth;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      white-space: nowrap;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
    }
    th {
      color: var(--muted);
      font-weight: 500;
      font-size: 12px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: #cccccc;
      background: #181818;
      padding: 2px 5px;
      border-radius: 4px;
      border: 1px solid #222222;
    }

    /* Buttons: Minimalist Black & White */
    button {
      background: #ffffff;
      color: #000000;
      border: none;
      border-radius: 6px;
      padding: 5px 12px;
      font-weight: 600;
      cursor: pointer;
      font-size: 12px;
      transition: opacity 0.15s ease;
    }
    button:hover { opacity: 0.88; }
    button:active { opacity: 0.75; }
    button.secondary {
      background: #1a1a1a;
      color: #ffffff;
      border: 1px solid var(--border);
    }
    button.secondary:hover {
      background: #262626;
      border-color: #383838;
    }
    button.danger {
      background: var(--danger);
      color: #ffffff;
    }

    input, select {
      background: #000000;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
    }
    input:focus, select:focus {
      border-color: var(--border-focus);
    }
    .bar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }

    /* Minimalist Toast Feedback */
    #toast {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%) translateY(-20px);
      background: #161616;
      border: 1px solid #333333;
      color: #ffffff;
      padding: 9px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 10px 25px rgba(0,0,0,0.8);
      z-index: 10000;
      pointer-events: none;
      opacity: 0;
      transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
      pointer-events: auto;
    }

    /* Searchable Tool Dropdown in Policy Guard */
    .dropdown-item {
      padding: 7px 12px;
      font-size: 12px;
      color: #dddddd;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.12s ease;
    }
    .dropdown-item:hover {
      background: #242424;
      color: #ffffff;
    }
    .dropdown-item .badge-srv {
      font-size: 10px;
      color: var(--muted);
      background: #181818;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
      flex-shrink: 0;
    }
    .dropdown-group-title {
      font-size: 11px;
      color: var(--dim);
      padding: 6px 12px 3px 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    /* Dynamic Filter Chips */
    .chip {
      font-size: 11px;
      padding: 3px 10px;
      border-radius: 12px;
      background: #141414;
      border: 1px solid var(--border);
      color: var(--dim);
      cursor: pointer;
      user-select: none;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .chip:hover {
      border-color: #555555;
      color: #ffffff;
    }
    .chip.active {
      background: #ffffff;
      color: #000000;
      border-color: #ffffff;
      font-weight: 600;
    }

    /* File & Folder Picker Modal */
    #filePickerModal {
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(4px);
      z-index: 30000;
      display: none;
      align-items: center;
      justify-content: center;
    }
    .modal-box {
      width: 740px;
      max-width: 95vw;
      height: 560px;
      max-height: 88vh;
      background: #111111;
      border: 1px solid var(--border-focus);
      border-radius: 10px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.9);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .picker-item {
      padding: 6px 10px;
      font-size: 12px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      color: #cccccc;
      transition: background 0.12s;
    }
    .picker-item:hover {
      background: #202020;
      color: #ffffff;
    }
    .picker-item.active {
      background: #282828;
      color: #ffffff;
      font-weight: 600;
    }

    /* Audit History Row Styling */
    .audit-history-row:hover {
      background: #1c1c1c;
    }
    .audit-history-row.active {
      background: #262626 !important;
      font-weight: 600;
    }

    /* Server Upload Mode Tabs */
    .server-tab {
      flex: 1;
      padding: 9px 12px;
      font-size: 12px;
      text-align: center;
      cursor: pointer;
      color: var(--muted);
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
      user-select: none;
    }
    .server-tab:hover {
      color: #fff;
      background: #181818;
    }
    .server-tab.active {
      color: #22c55e;
      font-weight: 600;
      border-bottom-color: #22c55e;
      background: #181818;
    }

    /* Interactive Breadcrumbs */
    .crumb {
      cursor: pointer;
      color: #888888;
      padding: 2px 5px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
      transition: all 0.12s;
    }
    .crumb:hover {
      color: #ffffff;
      background: #222222;
    }
    .crumb-sep {
      color: #444444;
      font-size: 10px;
      user-select: none;
    }

    /* Silky Chunky Gradient Scrollbars */
    html {
      scroll-behavior: smooth;
    }
    * {
      scrollbar-width: thin;
      scrollbar-color: #06b6d4 #0d0d0d;
    }
    ::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }
    ::-webkit-scrollbar-track {
      background: #0d0d0d;
      border-radius: 999px;
      box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.7);
    }
    ::-webkit-scrollbar-thumb {
      background: linear-gradient(135deg, #10b981 0%, #06b6d4 50%, #3b82f6 100%);
      border-radius: 999px;
      border: 2.5px solid #0d0d0d;
      background-clip: padding-box;
      box-shadow: 0 0 4px rgba(6, 182, 212, 0.25);
      transition: all 0.25s ease;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: linear-gradient(135deg, #34d399 0%, #38bdf8 50%, #818cf8 100%);
      border: 2px solid #0d0d0d;
      background-clip: padding-box;
      box-shadow: 0 0 12px rgba(6, 182, 212, 0.65), inset 0 0 4px rgba(255, 255, 255, 0.3);
    }
    ::-webkit-scrollbar-thumb:active {
      background: linear-gradient(135deg, #4ade80 0%, #22d3ee 50%, #a78bfa 100%);
      border: 2px solid #0d0d0d;
      background-clip: padding-box;
      box-shadow: 0 0 16px rgba(34, 197, 94, 0.85), inset 0 0 6px rgba(255, 255, 255, 0.5);
    }
    ::-webkit-scrollbar-corner {
      background: #0d0d0d;
    }
  </style>
</head>
<body>
  <div id="toast"><span id="toastDot" class="dot dot-ok"></span><span id="toastMsg"></span></div>

  <!-- File & Folder Picker Modal -->
  <div id="filePickerModal">
    <div class="modal-box">
      <!-- Modal Header -->
      <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: #161616;">
        <span style="font-size: 13px; font-weight: 600;">📁 本机路径选择器 (File &amp; Folder Picker)</span>
        <button class="secondary" type="button" onclick="closeFilePickerModal()" style="padding: 2px 8px; font-size: 11px;">✕ 关闭</button>
      </div>

      <!-- Quick Jump / Native Picker Toolbar -->
      <div style="padding: 10px 16px; border-bottom: 1px solid var(--border); background: #141414; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div style="font-size: 11px; color: var(--dim); display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span>快速直达:</span>
            <div id="pickerQuickChips" style="display: flex; gap: 4px; flex-wrap: wrap;"></div>
          </div>
          <button class="secondary" type="button" onclick="triggerNativeOsPicker()" style="font-size: 11px; padding: 3px 8px;">🖥️ 系统资源管理器窗口</button>
        </div>

        <!-- Breadcrumbs & Quick Filter Bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;">
          <div id="pickerBreadcrumbs" style="display: flex; gap: 2px; align-items: center; flex-wrap: wrap; font-size: 11px;"></div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <input id="pickerFilterInput" placeholder="🔍 过滤当前列表..." style="background: #000; border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; font-size: 11px; color: #fff; width: 140px;" oninput="onPickerFilterChanged()" />
            <button class="secondary" type="button" id="pickerMcpToggleBtn" onclick="togglePickerMcpFilter()" style="font-size: 11px; padding: 3px 8px;">⚡ 只看配置</button>
          </div>
        </div>

        <!-- Path Manual Jump Bar -->
        <div style="display: flex; align-items: center; gap: 6px;">
          <button class="secondary" type="button" id="pickerParentBtn" style="font-size: 11px; padding: 4px 8px;">⬆ 上一级</button>
          <input id="pickerCurrentPath" style="flex: 1; font-family: monospace; font-size: 11px; background: #000;" placeholder="当前完整路径..." onkeydown="if(event.key===&#39;Enter&#39;) navigatePickerTo(this.value)" />
          <button class="secondary" type="button" onclick="navigatePickerTo(document.getElementById(&#39;pickerCurrentPath&#39;).value)" style="font-size: 11px; padding: 4px 8px;">跳转</button>
        </div>
      </div>

      <!-- Entries List Container -->
      <div id="pickerEntriesList" style="flex: 1; overflow-y: auto; padding: 8px 16px; scroll-behavior: smooth;">
        <div style="color: var(--muted); text-align: center; padding: 20px;">正在加载目录...</div>
      </div>

      <!-- Modal Footer -->
      <div style="padding: 10px 16px; border-top: 1px solid var(--border); background: #161616; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
        <div style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dim);">
          已选: <span id="pickerSelectedDisplay" style="color: #fff; font-family: monospace;">(点击下方文件或选择当前目录)</span>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="secondary" type="button" onclick="selectCurrentPickerFolder()">✅ 选择此目录</button>
          <button type="button" id="pickerConfirmBtn" onclick="confirmPickerSelection()" disabled>确定选择</button>
          <button class="secondary" type="button" onclick="closeFilePickerModal()">取消</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Audit History Modal -->
  <div id="auditHistoryModal" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.8); backdrop-filter: blur(5px); z-index: 20000; display: none; align-items: center; justify-content: center;">
    <div style="width: 1120px; max-width: 96vw; height: 760px; max-height: 92vh; background: #111111; border: 1px solid var(--border-focus); border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,0.95); display: flex; flex-direction: column; overflow: hidden;">
      
      <!-- Modal Header -->
      <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: #161616;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 14px; font-weight: 600;">📜 飞行记录仪 · 全量调用审计历史窗口 (Flight Recorder History)</span>
          <span id="auditModalCountBadge" class="badge" style="background: rgba(34,197,94,0.15); color: #22c55e; border: 1px solid #22c55e; font-size: 11px;">准备就绪</span>
        </div>
        <button class="secondary" type="button" onclick="closeAuditHistoryModal()" style="padding: 2px 8px; font-size: 11px;">✕ 关闭</button>
      </div>

      <!-- Filter Toolbar -->
      <div style="padding: 10px 16px; border-bottom: 1px solid var(--border); background: #141414; display: flex; flex-direction: column; gap: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <!-- Search input -->
          <div style="flex: 1; min-width: 240px;">
            <input id="auditHistorySearch" placeholder="🔍 实时搜索工具名 / 服务 / 参数内容 / 来源目录 / 阻断原因..." style="width: 100%; background: #000; font-size: 11px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 4px; color: #fff;" oninput="onAuditHistorySearchInput()" />
          </div>

          <!-- Risk level filter chips -->
          <div style="display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--dim);">
            <span>风险:</span>
            <span class="chip active" data-audit-risk="" onclick="setAuditRiskFilter(&#39;&#39;)">全部</span>
            <span class="chip" data-audit-risk="safe" onclick="setAuditRiskFilter(&#39;safe&#39;)">🟢 safe</span>
            <span class="chip" data-audit-risk="mutating" onclick="setAuditRiskFilter(&#39;mutating&#39;)">🟡 mutating</span>
            <span class="chip" data-audit-risk="destructive" onclick="setAuditRiskFilter(&#39;destructive&#39;)">🔴 destructive</span>
          </div>

          <!-- Decision filter chips -->
          <div style="display: flex; gap: 4px; align-items: center; font-size: 11px; color: var(--dim);">
            <span>决策:</span>
            <span class="chip active" data-audit-dec="" onclick="setAuditDecisionFilter(&#39;&#39;)">全部</span>
            <span class="chip" data-audit-dec="allowed" onclick="setAuditDecisionFilter(&#39;allowed&#39;)">放行</span>
            <span class="chip" data-audit-dec="blocked" onclick="setAuditDecisionFilter(&#39;blocked&#39;)">拦截</span>
            <span class="chip" data-audit-dec="error" onclick="setAuditDecisionFilter(&#39;error&#39;)">异常</span>
          </div>
        </div>

        <!-- Controls: limit, refresh, export -->
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; flex-wrap: wrap; gap: 6px;">
          <div style="display: flex; gap: 8px; align-items: center;">
            <span style="color: var(--dim);">提取条数:</span>
            <select id="auditHistoryLimit" style="background: #000; font-size: 11px; padding: 2px 6px; border: 1px solid var(--border); border-radius: 4px; color: #fff;" onchange="fetchAuditHistory()">
              <option value="100">最新 100 条</option>
              <option value="200" selected>最新 200 条</option>
              <option value="500">最新 500 条</option>
              <option value="1000">最新 1000 条</option>
              <option value="0">全部历史 (最多 5000 条)</option>
            </select>
            <button class="secondary" type="button" onclick="fetchAuditHistory()" style="font-size: 11px; padding: 2px 8px;">🔄 刷新数据</button>
            <span style="color: var(--dim);">| 点击任意行可展开/复制完整参数详情</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="secondary" type="button" onclick="exportAuditHistoryJson()" style="font-size: 11px; padding: 2px 8px;">📥 导出 JSON</button>
            <button class="secondary" type="button" onclick="exportAuditHistoryCsv()" style="font-size: 11px; padding: 2px 8px;">📥 导出 CSV</button>
          </div>
        </div>
      </div>

      <!-- Main Content Area: Split Table + Detail Panel -->
      <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden;">
        <!-- Audit Table Container -->
        <div style="flex: 1; overflow-y: auto; overflow-x: auto; scroll-behavior: smooth;" id="auditHistoryTableWrap">
          <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
            <thead style="position: sticky; top: 0; background: #161616; z-index: 10;">
              <tr>
                <th style="padding: 8px 10px;">流水号</th>
                <th style="padding: 8px 10px;">时间</th>
                <th style="padding: 8px 10px;">目标工具</th>
                <th style="padding: 8px 10px;">风险等级</th>
                <th style="padding: 8px 10px;">决策判定</th>
                <th style="padding: 8px 10px;">耗时</th>
                <th style="padding: 8px 10px;">来源 (PID/CWD)</th>
                <th style="padding: 8px 10px;">参数摘要 / 详细原因</th>
                <th style="padding: 8px 10px;">详情</th>
              </tr>
            </thead>
            <tbody id="auditHistoryTableBody">
              <tr><td colspan="9" style="text-align: center; color: var(--muted); padding: 30px;">点击下方或右上角按钮载入全量记录...</td></tr>
            </tbody>
          </table>
        </div>

        <!-- Detail Inspector Panel (Collapsible / Bottom Drawer) -->
        <div id="auditDetailInspector" style="display: none; height: 200px; border-top: 1px solid var(--border-focus); background: #0c0c0c; padding: 10px 16px; flex-direction: column; gap: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-weight: 600; font-size: 12px; color: #fff;">🔍 调用条目详情: <span id="auditDetailId" style="color: var(--ok); font-family: monospace;">-</span></span>
              <span id="auditDetailMeta" style="font-size: 11px; color: var(--muted);"></span>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="secondary" type="button" onclick="copyAuditDetailParams()" style="font-size: 11px; padding: 2px 6px;">📋 复制完整参数</button>
              <button class="secondary" type="button" onclick="closeAuditDetailInspector()" style="font-size: 11px; padding: 2px 6px;">✕ 收起</button>
            </div>
          </div>
          <pre id="auditDetailJsonPre" style="flex: 1; overflow: auto; background: #000; border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; font-family: monospace; font-size: 11px; color: #22c55e; white-space: pre-wrap; margin: 0;"></pre>
        </div>
      </div>

      <!-- Modal Footer -->
      <div style="padding: 8px 16px; border-top: 1px solid var(--border); background: #161616; display: flex; justify-content: space-between; align-items: center;">
        <span id="auditModalFooterText" style="font-size: 11px; color: var(--muted);">共 0 条历史记录</span>
        <button class="secondary" type="button" onclick="closeAuditHistoryModal()" style="font-size: 11px; padding: 4px 12px;">关闭窗口</button>
      </div>

    </div>
  </div>

  <!-- Upload / Pull MCP Server Modal -->
  <div id="uploadServerModal" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.8); backdrop-filter: blur(5px); z-index: 20000; display: none; align-items: center; justify-content: center;">
    <div style="width: 780px; max-width: 95vw; max-height: 90vh; background: #111111; border: 1px solid var(--border-focus); border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,0.95); display: flex; flex-direction: column; overflow: hidden;">
      
      <!-- Modal Header -->
      <div style="padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; background: #161616;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 14px; font-weight: 600;">➕ 添加 / 上传 MCP 服务器 (Add &amp; Mount Server)</span>
        </div>
        <button class="secondary" type="button" onclick="closeUploadServerModal()" style="padding: 2px 8px; font-size: 11px;">✕ 关闭</button>
      </div>

      <!-- Mode Selection Tabs -->
      <div style="display: flex; border-bottom: 1px solid var(--border); background: #141414;">
        <div class="server-tab active" data-server-tab="upload" onclick="switchServerTab(&#39;upload&#39;)">🖥️ 电脑上传 (文件/ZIP)</div>
        <div class="server-tab" data-server-tab="url" onclick="switchServerTab(&#39;url&#39;)">🌐 项目 URL 拉取 (Git/HTTP)</div>
        <div class="server-tab" data-server-tab="local" onclick="switchServerTab(&#39;local&#39;)">📁 本地路径选择</div>
        <div class="server-tab" data-server-tab="json" onclick="switchServerTab(&#39;json&#39;)">📋 粘贴配置 JSON</div>
      </div>

      <!-- Tab Content Area -->
      <div style="flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; scroll-behavior: smooth;">
        
        <!-- Tab 1: Upload File -->
        <div id="tabUploadContent" class="server-tab-pane">
          <div style="border: 2px dashed var(--border-focus); border-radius: 8px; padding: 24px; text-align: center; background: #0a0a0a; cursor: pointer; transition: all 0.15s;" onclick="document.getElementById(&#39;serverFileInput&#39;).click()" ondragover="event.preventDefault(); this.style.borderColor=&#39;#22c55e&#39;;" ondragleave="this.style.borderColor=&#39;var(--border-focus)&#39;;" ondrop="handleServerFileDrop(event)">
            <input type="file" id="serverFileInput" style="display: none;" accept=".js,.mjs,.cjs,.py,.zip,.bat,.cmd,.sh" onchange="handleServerFileSelected(this.files)" />
            <div style="font-size: 28px; margin-bottom: 8px;">📦</div>
            <div style="font-size: 13px; font-weight: 600; color: #fff; margin-bottom: 4px;">点击或拖拽上传 MCP 服务代码文件</div>
            <div style="font-size: 11px; color: var(--muted);">支持单脚本 (<code>.js</code>, <code>.py</code>, <code>.mjs</code>) 或完整工程代码包 (<code>.zip</code>)</div>
          </div>
          <div id="uploadFileInfo" style="display: none; margin-top: 10px; padding: 8px 12px; background: #161616; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; justify-content: space-between; align-items: center;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span>📄</span>
              <span id="uploadFileName" style="font-weight: 600; color: #fff;"></span>
              <span id="uploadFileSize" style="color: var(--muted); font-size: 11px;"></span>
            </div>
            <button class="secondary" type="button" onclick="clearUploadFile()" style="padding: 2px 6px; font-size: 10px;">移除</button>
          </div>
        </div>

        <!-- Tab 2: Pull from URL -->
        <div id="tabUrlContent" class="server-tab-pane" style="display: none;">
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <label style="font-size: 12px; font-weight: 500; color: #ccc;">目标项目或文件 URL:</label>
            <input id="serverPullUrl" placeholder="例如 https://github.com/org/mcp-server-repo 或 https://.../server.py" style="width: 100%; font-size: 12px; padding: 7px 10px; background: #000;" oninput="onServerPullUrlInput()" />
            
            <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
              <span style="font-size: 11px; color: var(--dim);">快速范例:</span>
              <span class="chip" onclick="fillUrlExample(&#39;https://github.com/modelcontextprotocol/servers/tree/main/src/fetch&#39;)">⚡ Git 仓库</span>
              <span class="chip" onclick="fillUrlExample(&#39;https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/fetch/index.ts&#39;)">⚡ Raw 脚本</span>
              <span class="chip" onclick="fillUrlExample(&#39;https://petstore.swagger.io/v2/swagger.json&#39;)">⚡ OpenAPI 规范</span>
            </div>
            <div id="urlTypeHint" style="font-size: 11px; color: var(--muted); min-height: 16px;">💡 支持 Git 仓库 (自动 git clone)、Raw 代码文件直连下载或 OpenAPI/Swagger 接口</div>
          </div>
        </div>

        <!-- Tab 3: Local Path -->
        <div id="tabLocalContent" class="server-tab-pane" style="display: none;">
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <label style="font-size: 12px; font-weight: 500; color: #ccc;">电脑本地文件或目录绝对路径:</label>
            <div style="display: flex; gap: 6px;">
              <input id="serverLocalPath" placeholder="例如 D:/my_servers/weather_mcp 或 C:/scripts/server.py" style="flex: 1; font-size: 12px; padding: 7px 10px; background: #000;" />
              <button class="secondary" type="button" onclick="openFilePickerModal(&#39;serverLocalPath&#39;)">📁 浏览选择...</button>
            </div>
            <div style="font-size: 11px; color: var(--muted);">💡 可直接指定本机已存在的 node/python 脚本路径或包含 package.json 的工程目录</div>
          </div>
        </div>

        <!-- Tab 4: Paste JSON Config -->
        <div id="tabJsonContent" class="server-tab-pane" style="display: none;">
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <label style="font-size: 12px; font-weight: 500; color: #ccc;">粘贴 MCP 配置 JSON (Claude / Cursor / Smithery 格式):</label>
            <textarea id="serverRawJson" rows="6" placeholder="{&#10;  &quot;command&quot;: &quot;npx&quot;,&#10;  &quot;args&quot;: [&quot;-y&quot;, &quot;@modelcontextprotocol/server-filesystem&quot;, &quot;C:/data&quot;]&#10;}" style="width: 100%; font-family: monospace; font-size: 11px; padding: 8px; background: #000; color: #fff; border: 1px solid var(--border); border-radius: 6px; resize: vertical;"></textarea>
            <div style="font-size: 11px; color: var(--muted);">💡 支持单项 <code>{&quot;command&quot;:&quot;...&quot;,&quot;args&quot;:[...]}</code> 或标准 <code>{&quot;mcpServers&quot;:{...}}</code> 格式</div>
          </div>
        </div>

        <!-- Common Server Identity & Automation Bar -->
        <div style="border-top: 1px solid var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 10px;">
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 4px; flex: 1; min-width: 260px;">
              <span style="font-size: 12px; color: var(--dim); white-space: nowrap;">服务标识 ID:</span>
              <input id="newServerId" placeholder="英文小写 (留空自动生成8位唯一码)" style="flex: 1; font-size: 12px; padding: 5px 8px; background: #000;" />
              <button class="secondary" type="button" onclick="generateRandomServerId()" style="padding: 4px 8px; font-size: 11px;">🎲 随机</button>
            </div>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; color: #ccc; cursor: pointer; user-select: none;">
              <input type="checkbox" id="serverAutoStart" checked style="cursor: pointer;" />
              <span>登记后立即启动并发现工具</span>
            </label>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; color: #ccc; cursor: pointer; user-select: none;">
              <input type="checkbox" id="serverAutoInstallDeps" checked style="cursor: pointer;" />
              <span>自动安装依赖 (npm i)</span>
            </label>
          </div>

          <!-- Advanced Toggle -->
          <div>
            <span style="font-size: 11px; color: var(--muted); cursor: pointer; user-select: none; text-decoration: underline;" onclick="toggleServerAdvancedOptions()">⚙️ 高级自定义命令与参数 (可选覆盖) ▼</span>
            <div id="serverAdvancedPanel" style="display: none; margin-top: 8px; padding: 10px; background: #0e0e0e; border: 1px solid var(--border); border-radius: 6px; flex-direction: column; gap: 6px;">
              <div style="display: flex; gap: 6px; align-items: center;">
                <span style="font-size: 11px; color: var(--dim); width: 60px;">启动命令:</span>
                <input id="serverCustomCmd" placeholder="默认自动推断 (如 node, python, npx)" style="flex: 1; font-size: 11px; padding: 3px 6px; background: #000;" />
              </div>
              <div style="display: flex; gap: 6px; align-items: center;">
                <span style="font-size: 11px; color: var(--dim); width: 60px;">启动参数:</span>
                <input id="serverCustomArgs" placeholder="逗号或空格分隔参数，如: ./server.js --port 8080" style="flex: 1; font-size: 11px; padding: 3px 6px; background: #000;" />
              </div>
              <div style="display: flex; gap: 6px; align-items: center;">
                <span style="font-size: 11px; color: var(--dim); width: 60px;">工作目录:</span>
                <input id="serverCustomCwd" placeholder="可选工作目录 cwd" style="flex: 1; font-size: 11px; padding: 3px 6px; background: #000;" />
              </div>
            </div>
          </div>
        </div>

        <div id="serverUploadStatusMsg" style="font-size: 12px; min-height: 18px; display: none;"></div>

      </div>

      <!-- Modal Footer -->
      <div style="padding: 10px 16px; border-top: 1px solid var(--border); background: #161616; display: flex; justify-content: space-between; align-items: center;">
        <span id="uploadServerHint" style="font-size: 11px; color: var(--muted);">支持电脑代码上传、GitHub 仓库一键克隆或本地路径绑定</span>
        <div style="display: flex; gap: 8px;">
          <button type="button" id="submitUploadServerBtn" onclick="submitServerUpload()" style="font-weight: 600;">🚀 立即导入并挂载服务</button>
          <button class="secondary" type="button" onclick="closeUploadServerModal()">取消</button>
        </div>
      </div>

    </div>
  </div>

  <div id="dashboardContainer">
    <header>
      <div class="title-group">
        <h1>MCP Workbench 控制台</h1>
        <p>多驱动统一网关 · 权限策略防火墙 · 本机监控中心</p>
      </div>
      <div class="bar" style="align-items: center; margin-bottom: 0;">
        <span id="connectionBadge" class="badge">
          <span class="dot dot-ok"></span>
          <span>本机直接连接 (正常)</span>
        </span>
        <button class="secondary" onclick="refreshState()">刷新</button>
      </div>
    </header>

    <div class="grid">
      <!-- Pending High-Risk Approvals -->
      <div class="card">
        <h2>
          <span>待审批高危操作</span>
          <span id="pendingBadge" class="badge"><span id="pendingDot" class="dot dot-ok"></span><span id="pendingCountText">0</span></span>
        </h2>
        <div class="table-container">
          <table>
            <thead><tr><th>Token</th><th>目标工具</th><th>参数预览</th><th>操作</th></tr></thead>
            <tbody id="pendingTable"><tr><td colspan="4" style="color:var(--muted)">暂无待审批高危请求</td></tr></tbody>
          </table>
        </div>
      </div>

      <!-- Managed Server Matrix -->
      <div class="card">
        <h2>
          <span>受管服务矩阵</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <span id="serverStats" style="font-size: 12px; font-weight: normal; color: var(--muted);"></span>
            <button class="secondary" type="button" onclick="openUploadServerModal()" style="font-size: 11px; padding: 2px 8px;">➕ 上传 / 拉取服务...</button>
          </div>
        </h2>
        <div class="table-container">
          <table>
            <thead><tr><th>服务 ID</th><th>驱动类型</th><th>状态 (重启数)</th><th>PID</th><th>操作</th></tr></thead>
            <tbody id="serverTable"></tbody>
          </table>
        </div>
      </div>

      <!-- Client Binder Funnel -->
      <div class="card">
        <h2>
          <span>AI 客户端自动探测</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <span id="clientStats" style="font-size: 12px; font-weight: normal; color: var(--muted);"></span>
            <button class="secondary" onclick="toggleAddClientPanel()">+ 新增客户端</button>
          </div>
        </h2>

        <!-- Inline Add Client Panel -->
        <div id="addClientPanel" style="display: none; background: #121212; border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
          <div style="font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
            <span>➕ 登记自定义 AI 客户端 / 新适配器</span>
            <span style="font-size: 11px; color: var(--muted); font-weight: normal;">若未填写名称，系统将自动分配 8 位随机识别码</span>
          </div>

          <!-- Quick Presets -->
          <div style="display: flex; gap: 6px; align-items: center; margin-bottom: 10px; flex-wrap: wrap;">
            <span style="font-size: 11px; color: var(--dim);">快速预设:</span>
            <span class="chip" onclick="applyClientPreset(&#39;Zed IDE&#39;, &#39;~/.config/zed/settings.json&#39;)">⚡ Zed IDE</span>
            <span class="chip" onclick="applyClientPreset(&#39;Windsurf&#39;, &#39;~/.codeium/windsurf/mcp_config.json&#39;)">⚡ Windsurf</span>
            <span class="chip" onclick="applyClientPreset(&#39;Roo Code&#39;, &#39;~/AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json&#39;)">⚡ Roo Code</span>
            <span class="chip" onclick="applyClientPreset(&#39;Continue&#39;, &#39;~/.continue/config.json&#39;)">⚡ Continue.dev</span>
            <span class="chip" onclick="applyClientPreset(&#39;Custom Agent&#39;, &#39;mcp.json&#39;)">⚡ 自定义 Agent</span>
          </div>

          <div class="bar" style="margin-bottom: 0; align-items: center; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 4px;">
              <input id="newClientName" placeholder="客户端名称 (不填自动生成8位随机码)" style="min-width: 220px;" onkeydown="if(event.key===&#39;Enter&#39;) document.getElementById(&#39;newClientPath&#39;).focus()" />
              <button class="secondary" type="button" onclick="generateRandomClientName()" title="随机生成8位识别码" style="padding: 5px 8px;">🎲 随机</button>
            </div>
            <div style="display: flex; gap: 4px; flex: 1; min-width: 320px;">
              <input id="newClientPath" placeholder="MCP 配置文件绝对路径 (可点击右侧浏览选择)" style="flex: 1;" oninput="updateClientPathHint()" onkeydown="if(event.key===&#39;Enter&#39;) submitNewClient()" />
              <button class="secondary" type="button" onclick="openFilePickerModal(&#39;newClientPath&#39;)">📁 选择路径...</button>
            </div>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--dim); cursor: pointer; user-select: none;">
              <input type="checkbox" id="newClientAutoBind" checked style="cursor: pointer;" />
              <span>自动绑定</span>
            </label>
            <div style="display: flex; gap: 6px;">
              <button onclick="submitNewClient()">保存客户端</button>
              <button class="secondary" onclick="toggleAddClientPanel(false)">取消</button>
            </div>
          </div>
          <div id="clientPathHint" style="font-size: 11px; color: var(--muted); margin-top: 6px; min-height: 16px;">💡 提示: 支持输入或选择 .json/.toml 配置文件，或直接指定客户端所在目录</div>
        </div>

        <!-- Category Filter Chips & Client Search Bar -->
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
          <div id="clientFilterChips" style="display: flex; gap: 6px; flex-wrap: wrap;"></div>
          <input id="clientSearchInput" placeholder="🔍 搜索客户端名称或路径..." style="padding: 4px 8px; font-size: 11px; width: 190px;" oninput="onClientSearchInput()" />
        </div>
        <div class="table-container">
          <table>
            <thead><tr><th>客户端</th><th>探测层级</th><th>状态</th><th>配置文件路径</th><th>操作</th></tr></thead>
            <tbody id="clientTable"></tbody>
          </table>
        </div>
      </div>

      <!-- Policy Guard Rules -->
      <div class="card">
        <h2><span>权限防火墙规则</span></h2>
        <div class="bar" style="align-items: center;">
          <input id="polId" placeholder="规则ID" style="width:100px" />
          <div id="toolDropdownContainer" style="position: relative; display: inline-flex; align-items: center;">
            <input id="polTarget" placeholder="目标工具 (如 * 或点击选择)" style="width: 190px; padding-right: 28px;" onclick="toggleToolDropdown(true)" />
            <button type="button" id="polDropdownBtn" onclick="toggleToolDropdown()" style="position: absolute; right: 2px; top: 50%; transform: translateY(-50%); background: transparent; border: none; color: var(--muted); padding: 4px 6px; cursor: pointer; font-size: 10px; font-weight: bold;" title="选择已有工具">▼</button>
            
            <!-- Dropdown Menu with Search -->
            <div id="toolDropdownMenu" style="display: none; position: absolute; top: calc(100% + 4px); left: 0; width: 340px; max-height: 280px; background: #111111; border: 1px solid var(--border-focus); border-radius: 8px; z-index: 1000; box-shadow: 0 10px 30px rgba(0,0,0,0.85); overflow: hidden; flex-direction: column;">
              <div style="padding: 8px; border-bottom: 1px solid var(--border); background: #161616;">
                <input id="toolSearchBox" placeholder="🔍 搜索工具名或服务器..." style="width: 100%; box-sizing: border-box; background: #000; border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; font-size: 12px; color: #fff;" oninput="filterToolDropdown()" />
              </div>
              <div id="toolDropdownList" style="overflow-y: auto; max-height: 220px; padding: 4px 0; scroll-behavior: smooth;"></div>
            </div>
          </div>
          <select id="polRisk"><option value="safe">safe</option><option value="mutating">mutating</option><option value="destructive">destructive</option></select>
          <input id="polRegex" placeholder="禁用正则 (可选)" style="width:110px" />
          <button onclick="addPolicyRule()">添加</button>
        </div>
        <div class="table-container">
          <table>
            <thead><tr><th>ID</th><th>目标</th><th>等级</th><th>正则围栏</th><th>操作</th></tr></thead>
            <tbody id="policyTable"></tbody>
          </table>
        </div>
      </div>

      <!-- Tool Playground / Direct Invoker -->
      <div class="card" style="grid-column: 1 / -1;">
        <h2>
          <span>🛠️ 在线工具调试台 (Tool Playground & Direct Invoker)</span>
          <span id="playgroundStatus" style="font-size: 12px; font-weight: normal; color: var(--muted);">实时直连网关下全部 MCP 工具</span>
        </h2>
        
        <!-- Controls Bar -->
        <div class="bar" style="align-items: center;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 12px; color: var(--dim); white-space: nowrap;">所属服务:</span>
            <select id="playgroundServerSelect" style="min-width: 170px;" onchange="onPlaygroundServerChanged()">
              <option value="">全部已加载服务 (All)</option>
            </select>
          </div>
          <div style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 280px;">
            <span style="font-size: 12px; color: var(--dim); white-space: nowrap;">选择工具:</span>
            <select id="toolSelect" style="flex: 1;" onchange="onToolSelected()">
              <option value="">-- 请选择要调用的 MCP 工具 --</option>
            </select>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="secondary" onclick="generateToolTemplate()">📄 填入参数模板</button>
            <button class="secondary" onclick="formatToolArgs()">✨ 格式化 JSON</button>
            <button onclick="executeSelectedTool()">▶ 立即执行调用</button>
          </div>
        </div>

        <!-- Dynamic Server Filter Chips -->
        <div id="activeServerChips" style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px;"></div>

        <p id="toolDesc" style="font-size: 13px; color: var(--muted); margin: 4px 0 10px 0; min-height: 18px;"></p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <div style="font-size: 12px; color: var(--dim); margin-bottom: 4px;">输入参数 (JSON):</div>
            <textarea id="toolArgsInput" rows="7" style="width: 100%; background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px; color: #fff; font-family: monospace; font-size: 12px; padding: 8px; resize: vertical;">{}</textarea>
          </div>
          <div>
            <div style="font-size: 12px; color: var(--dim); margin-bottom: 4px;">网关执行结果 (Result):</div>
            <pre id="toolOutputPre" style="width: 100%; min-height: 140px; max-height: 260px; background: #0a0a0a; border: 1px solid var(--border); border-radius: 6px; color: #22c55e; font-family: monospace; font-size: 12px; padding: 8px; overflow: auto; white-space: pre-wrap; scroll-behavior: smooth;">(等待执行调用...)</pre>
          </div>
        </div>
      </div>

      <!-- Secret Vault -->
      <div class="card">
        <h2><span>本地密钥保险箱 (SecretVault)</span></h2>
        <div class="bar">
          <input id="secKey" placeholder="变量名 (如 GITHUB_TOKEN)" />
          <input id="secVal" type="password" placeholder="密钥明文" />
          <button onclick="saveSecret()">存入</button>
        </div>
        <div class="table-container">
          <table>
            <thead><tr><th>密钥名称</th><th>配置占位符</th><th>操作</th></tr></thead>
            <tbody id="secretTable"></tbody>
          </table>
        </div>
      </div>

      <!-- Flight Recorder -->
      <div class="card" style="grid-column: 1 / -1;">
        <h2>
          <span>调用审计流水 (Flight Recorder)</span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <span id="auditStats" style="font-size: 12px; font-weight: normal; color: var(--muted);"></span>
            <button class="secondary" type="button" onclick="openAuditHistoryModal()" style="font-size: 11px; padding: 2px 8px;">📜 查看全量历史...</button>
          </div>
        </h2>
        <div class="table-container">
          <table>
            <thead><tr><th>时间</th><th>工具名</th><th>风险等级</th><th>决策</th><th>耗时</th><th>参数摘要</th></tr></thead>
            <tbody id="auditTable"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    const PORT = ${port};

    function showToast(msg, isSuccess = true) {
      const toast = document.getElementById('toast');
      const toastDot = document.getElementById('toastDot');
      const toastMsg = document.getElementById('toastMsg');
      toastDot.className = isSuccess ? 'dot dot-ok' : 'dot dot-danger';
      toastMsg.textContent = msg;
      toast.className = 'show';
      clearTimeout(window.__toastTimer);
      window.__toastTimer = setTimeout(() => {
        toast.className = '';
      }, 2500);
    }

    function esc(str) {
      return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    async function adminPost(path, payload) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(err.message || err.error || '操作失败', false);
        } else if (payload && payload.action) {
          const actMap = { restart: '服务重启成功', stop: '服务已关闭', start: '服务启动成功', bind: '客户端绑定成功', unbind: '客户端已解绑', delete: '已删除', add: '客户端登记成功', remove: '客户端已移除' };
          showToast(actMap[payload.action] || '操作成功', true);
        }
      } catch (err) {
        console.error('adminPost failed:', err);
      }
      await refreshState();
    }

    async function refreshState() {
      try {
        const res = await fetch('/admin/state');
        if (!res.ok) return;

        const data = await res.json();

        // 1. Pending Approvals
        const pCount = (data.pendingApprovals || []).length;
        const pDot = document.getElementById('pendingDot');
        const pCountText = document.getElementById('pendingCountText');
        if (pCount > 0) {
          pDot.className = 'dot dot-danger';
          pCountText.textContent = pCount + ' 个待确认';
        } else {
          pDot.className = 'dot dot-ok';
          pCountText.textContent = '安全无待办';
        }

        document.getElementById('pendingTable').innerHTML = (data.pendingApprovals || []).map(p =>
          '<tr><td>' + esc(p.approvalToken) + '</td><td>' + esc(p.targetTool) + '</td><td><code>' + esc(p.argsPreview) + '</code></td>' +
          '<td><button class="btn-approve" data-token="' + esc(p.approvalToken) + '">批准</button> ' +
          '<button class="btn-reject danger" data-token="' + esc(p.approvalToken) + '">拒绝</button></td></tr>'
        ).join('') || '<tr><td colspan="4" style="color:var(--muted)">暂无待审批高危请求</td></tr>';

        // 2. Managed Servers
        document.getElementById('serverStats').textContent =
          '工具: ' + data.counts.tools + ' | 资源: ' + data.counts.resources + ' | 提示词: ' + data.counts.prompts;

        document.getElementById('serverTable').innerHTML = (data.servers || []).map(s => {
          const isRunning = s.phase === 'running';
          const dotHtml = isRunning ? '<span class="dot dot-ok"></span>' : '<span class="dot dot-danger"></span>';
          const statusText = isRunning ? '运行中' : (s.phase || '已停止');
          const actionButtons = isRunning
            ? '<button class="btn-server-action secondary" data-server="' + esc(s.serverId) + '" data-action="restart">重启</button> ' +
              '<button class="btn-server-action danger" data-server="' + esc(s.serverId) + '" data-action="stop">关闭</button>'
            : '<button class="btn-server-action" data-server="' + esc(s.serverId) + '" data-action="start">启动</button>';
          return '<tr><td><b>' + esc(s.serverId) + '</b></td><td>' + esc(s.serverType) + '</td><td>' +
            dotHtml + esc(statusText) + ' (' + Number(s.restartCount || 0) + ')</td><td>' + esc(s.pid || '-') + '</td>' +
            '<td>' + actionButtons + '</td></tr>';
        }).join('');

        // 3. Clients
        syncClients(data.clients);

        // 4. Policies
        document.getElementById('policyTable').innerHTML = (data.policyRules || []).map(r =>
          '<tr><td>' + esc(r.ruleId) + '</td><td><code>' + esc(r.targetTool) + '</code></td><td>' + esc(r.riskLevel) + '</td><td><code>' + esc(r.denyParamRegex || '-') + '</code></td>' +
          '<td><button class="btn-policy-delete danger" data-rule="' + esc(r.ruleId) + '">删除</button></td></tr>'
        ).join('');

        // 5. Secrets
        document.getElementById('secretTable').innerHTML = (data.secrets || []).map(sec =>
          '<tr><td>' + esc(sec.key) + '</td><td><code>' + esc(sec.placeholder) + '</code></td>' +
          '<td><button class="btn-secret-delete danger" data-key="' + esc(sec.key) + '">删除</button></td></tr>'
        ).join('');

        // 6. Tool Playground Options
        if (data.tools) {
          syncPlayground(data.tools);
        }

        // 7. Flight Recorder Audit
        const logCount = (data.recentAuditLogs || []).length;
        const lastTool = logCount > 0 ? data.recentAuditLogs[logCount - 1].toolName : '无';
        const lastCaller = logCount > 0 ? (data.recentAuditLogs[logCount - 1].callerClientName || 'WorkBuddy/Client') : '-';
        document.getElementById('auditStats').textContent = '总调用: ' + logCount + ' 次 | 最新: ' + lastTool + ' (' + lastCaller + ')';

        document.getElementById('auditTable').innerHTML = (data.recentAuditLogs || []).slice().reverse().map(a => {
          const isAllowed = a.decision === 'allowed' || a.decision === 'approved';
          const decDot = isAllowed ? '<span class="dot dot-ok"></span>' : '<span class="dot dot-danger"></span>';
          const isSafe = a.riskLevel === 'safe';
          const riskDot = isSafe ? '<span class="dot dot-ok"></span>' : '<span class="dot dot-danger"></span>';
          return '<tr><td>' + esc(a.timestamp.slice(11, 19)) + '</td><td><b>' + esc(a.toolName) + '</b></td><td>' +
            riskDot + esc(a.riskLevel) + '</td><td>' +
            decDot + esc(a.decision) + '</td><td>' + Number(a.durationMs) + 'ms</td><td><code>' + esc(a.argsPreview) + '</code></td></tr>';
        }).join('');
      } catch (err) {
        console.error('Failed to refresh state:', err);
      }
    }

    let cachedClients = [];
    let selectedClientFilter = 'all';
    let clientSearchKeyword = '';

    function onClientSearchInput() {
      const input = document.getElementById('clientSearchInput');
      clientSearchKeyword = input ? (input.value || '').trim() : '';
      renderClientTable();
    }

    function syncClients(clients) {
      cachedClients = clients || [];

      const detectedCount = cachedClients.filter(c => c.status === 'bound' || c.status === 'detected_unbound' || c.status === 'staged_wait_exit' || c.configPath).length;
      const boundCount = cachedClients.filter(c => c.status === 'bound').length;
      const notDetectedCount = cachedClients.filter(c => c.status === 'needs_manual_path' && !c.configPath).length;

      const chipsEl = document.getElementById('clientFilterChips');
      if (chipsEl) {
        chipsEl.innerHTML =
          '<span class="chip ' + (selectedClientFilter === 'all' ? 'active' : '') + '" data-filter-client="all">全部 (' + cachedClients.length + ')</span>' +
          '<span class="chip ' + (selectedClientFilter === 'detected' ? 'active' : '') + '" data-filter-client="detected">已探测到 (' + detectedCount + ')</span>' +
          '<span class="chip ' + (selectedClientFilter === 'bound' ? 'active' : '') + '" data-filter-client="bound">已绑定 (' + boundCount + ')</span>' +
          '<span class="chip ' + (selectedClientFilter === 'not_detected' ? 'active' : '') + '" data-filter-client="not_detected">未探测到 (' + notDetectedCount + ')</span>';
      }

      const statsEl = document.getElementById('clientStats');
      if (statsEl) {
        statsEl.textContent = '已探测: ' + detectedCount + ' | 已绑定: ' + boundCount + ' | 未探测: ' + notDetectedCount;
      }

      renderClientTable();
    }

    function renderClientTable() {
      const tableEl = document.getElementById('clientTable');
      if (!tableEl) return;

      let list = cachedClients.slice();
      if (selectedClientFilter === 'detected') {
        list = list.filter(c => c.status === 'bound' || c.status === 'detected_unbound' || c.status === 'staged_wait_exit' || c.configPath);
      } else if (selectedClientFilter === 'bound') {
        list = list.filter(c => c.status === 'bound');
      } else if (selectedClientFilter === 'not_detected') {
        list = list.filter(c => c.status === 'needs_manual_path' && !c.configPath);
      }

      if (clientSearchKeyword) {
        const q = clientSearchKeyword.toLowerCase();
        list = list.filter(c => (c.displayName || '').toLowerCase().includes(q) || (c.configPath || '').toLowerCase().includes(q));
      }

      list.sort((a, b) => {
        const order = { bound: 0, staged_wait_exit: 1, detected_unbound: 2, needs_manual_path: 3 };
        const scoreA = order[a.status] !== undefined ? order[a.status] : 4;
        const scoreB = order[b.status] !== undefined ? order[b.status] : 4;
        return scoreA - scoreB;
      });

      if (list.length === 0) {
        tableEl.innerHTML = '<tr><td colspan="5" style="color:var(--muted); text-align:center; padding:12px;">该分类下暂无客户端</td></tr>';
        return;
      }

      tableEl.innerHTML = list.map(c => {
        const isBound = c.status === 'bound';
        const isDetected = c.status === 'detected_unbound' || (Boolean(c.configPath) && !isBound);
        const isStaged = c.status === 'staged_wait_exit';

        let dotHtml = '';
        let label = '';
        let actionBtn = '';

        if (isBound) {
          dotHtml = '<span class="dot dot-ok"></span>';
          label = '已配置绑定';
          actionBtn = '<button class="btn-client-toggle danger" data-client="' + esc(c.clientId) + '" data-action="unbind">解绑</button>';
        } else if (isStaged) {
          dotHtml = '<span class="dot" style="background:#eab308; box-shadow:0 0 8px rgba(234,179,8,0.6);"></span>';
          label = '等待退出重载';
          actionBtn = '<button class="btn-client-toggle danger" data-client="' + esc(c.clientId) + '" data-action="unbind">取消</button>';
        } else if (isDetected) {
          dotHtml = '<span class="dot" style="background:#3b82f6; box-shadow:0 0 8px rgba(59,130,246,0.6);"></span>';
          label = '已探测就绪';
          actionBtn = '<button class="btn-client-toggle" data-client="' + esc(c.clientId) + '" data-action="bind">一键绑定</button>';
        } else {
          dotHtml = '<span class="dot dot-danger"></span>';
          label = '未探测到安装';
          actionBtn = '<button class="btn-client-manual secondary" data-client="' + esc(c.clientId) + '" data-name="' + esc(c.displayName) + '">📁 选择路径</button>';
        }

        if (c.isCustom || (c.clientId && c.clientId.startsWith('custom_'))) {
          actionBtn += ' <button class="btn-client-delete danger" data-client="' + esc(c.clientId) + '" style="margin-left:4px;" title="删除自定义客户端">删除</button>';
        }

        const pathHtml = c.configPath
          ? '<code style="font-size:11px;" title="' + esc(c.configPath) + '">' + esc(c.configPath) + '</code>'
          : '<span style="color:var(--muted)">-</span>';

        return '<tr><td><b>' + esc(c.displayName) + '</b></td><td><code>' + esc(c.discoveryLayer) + '</code></td><td>' +
          dotHtml + label + '</td><td>' + pathHtml + '</td><td>' + actionBtn + '</td></tr>';
      }).join('');
    }

    function generateRandom8() {
      const chars = 'abcdef0123456789';
      let res = '';
      for (let i = 0; i < 8; i++) {
        res += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return res;
    }

    function generateRandomClientName() {
      const input = document.getElementById('newClientName');
      if (input) input.value = generateRandom8();
    }

    function toggleAddClientPanel(forceState) {
      const p = document.getElementById('addClientPanel');
      if (!p) return;
      const isOpen = p.style.display !== 'none';
      const willOpen = forceState !== undefined ? forceState : !isOpen;
      p.style.display = willOpen ? 'block' : 'none';
      if (willOpen) {
        const nameInput = document.getElementById('newClientName');
        if (nameInput) {
          nameInput.value = '';
          nameInput.focus();
        }
      }
    }

    function applyClientPreset(name, pathTemplate) {
      const nameInput = document.getElementById('newClientName');
      const pathInput = document.getElementById('newClientPath');
      if (nameInput) nameInput.value = name;
      if (pathInput) pathInput.value = pathTemplate;
      updateClientPathHint();
    }

    function updateClientPathHint() {
      const hintEl = document.getElementById('clientPathHint');
      const pathInput = document.getElementById('newClientPath');
      if (!hintEl || !pathInput) return;
      const val = (pathInput.value || '').trim();
      if (!val) {
        hintEl.innerHTML = '💡 提示: 支持直接输入或选择 .json/.toml 配置文件，或直接指定客户端所在目录';
        return;
      }
      const lower = val.toLowerCase();
      if (lower.endsWith('.json')) {
        hintEl.innerHTML = '💡 <span style="color:#22c55e;">标准 JSON 格式</span>: 将自动维护 <code>mcpServers</code> 节点，兼容多数主流 AI IDE';
      } else if (lower.endsWith('.toml')) {
        hintEl.innerHTML = '💡 <span style="color:#22c55e;">TOML 格式</span>: 将自动维护 <code>[mcp_servers]</code> 表格，兼容 Zed / Codeium 等客户端';
      } else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        hintEl.innerHTML = '💡 <span style="color:#3b82f6;">YAML 格式</span>: 兼容基于 YAML 的代理配置文件';
      } else if (!val.includes('.') && (val.includes('/') || val.includes('\\\\') || val.includes(':'))) {
        hintEl.innerHTML = '💡 <span style="color:#eab308;">目录模式</span>: 指定客户端安装/工作区目录，将自动探查其子配置或生成适配器';
      } else {
        hintEl.innerHTML = '💡 路径已输入: <code>' + esc(val) + '</code>';
      }
    }

    async function submitNewClient() {
      const nameInput = document.getElementById('newClientName');
      const pathInput = document.getElementById('newClientPath');
      const autoBindCb = document.getElementById('newClientAutoBind');

      let name = (nameInput ? nameInput.value : '').trim();
      if (!name) {
        name = generateRandom8();
        if (nameInput) nameInput.value = name;
      }
      const configPath = (pathInput ? pathInput.value : '').trim();
      const autoBind = autoBindCb ? autoBindCb.checked : true;

      await adminPost('/admin/client-action', {
        action: 'add',
        name: name,
        config_path: configPath,
        auto_bind: autoBind
      });

      toggleAddClientPanel(false);
      showToast('已新增客户端: ' + name, true);
    }

    let pickerTargetInputId = null;
    let pickerTargetClientId = null;
    let pickerSelectedPath = null;
    let pickerCurrentDir = '';
    let pickerCachedEntries = [];
    let pickerFilterKeyword = '';
    let pickerFilterMcpOnly = false;

    function resetPickerFilters() {
      pickerFilterKeyword = '';
      pickerFilterMcpOnly = false;
      const filterInput = document.getElementById('pickerFilterInput');
      if (filterInput) filterInput.value = '';
      const mcpBtn = document.getElementById('pickerMcpToggleBtn');
      if (mcpBtn) {
        mcpBtn.style.background = '';
        mcpBtn.style.color = '';
        mcpBtn.style.borderColor = '';
        mcpBtn.style.fontWeight = '';
      }
    }

    function openFilePickerModal(targetInputId) {
      pickerTargetInputId = targetInputId;
      pickerTargetClientId = null;
      pickerSelectedPath = null;
      resetPickerFilters();
      showPickerModal();
    }

    function openFilePickerModalForClient(clientId, displayName) {
      pickerTargetInputId = null;
      pickerTargetClientId = clientId;
      pickerSelectedPath = null;
      resetPickerFilters();
      showPickerModal();
    }

    function showPickerModal() {
      const modal = document.getElementById('filePickerModal');
      if (!modal) return;
      modal.style.display = 'flex';
      document.getElementById('pickerSelectedDisplay').textContent = '(点击下方文件或选择当前目录)';
      document.getElementById('pickerConfirmBtn').disabled = true;
      navigatePickerTo(pickerCurrentDir || '');
    }

    function closeFilePickerModal() {
      const modal = document.getElementById('filePickerModal');
      if (modal) modal.style.display = 'none';
      pickerTargetInputId = null;
      pickerTargetClientId = null;
    }

    async function navigatePickerTo(dirPath) {
      const listEl = document.getElementById('pickerEntriesList');
      if (!listEl) return;
      listEl.innerHTML = '<div style="color:var(--muted); text-align:center; padding:20px;">正在加载目录...</div>';
      try {
        const url = '/admin/browse-fs' + (dirPath ? '?dir=' + encodeURIComponent(dirPath) : '');
        const res = await fetch(url);
        if (!res.ok) throw new Error('读取目录失败');
        const data = await res.json();
        pickerCurrentDir = data.currentDir;
        pickerCachedEntries = data.entries || [];
        document.getElementById('pickerCurrentPath').value = data.currentDir;

        renderPickerBreadcrumbs(data.currentDir);

        const parentBtn = document.getElementById('pickerParentBtn');
        if (parentBtn) {
          parentBtn.disabled = !data.parentDir;
          parentBtn.onclick = () => { if (data.parentDir) navigatePickerTo(data.parentDir); };
        }

        const quickChipsEl = document.getElementById('pickerQuickChips');
        if (quickChipsEl) {
          let quickHtml = '';
          for (const drv of (data.drives || [])) {
            quickHtml += '<span class="chip" data-nav-path="' + esc(drv) + '">' + esc(drv) + '</span>';
          }
          for (const q of (data.quickPaths || [])) {
            quickHtml += '<span class="chip" data-nav-path="' + esc(q.path) + '">' + esc(q.name) + '</span>';
          }
          quickChipsEl.innerHTML = quickHtml;
        }

        renderPickerList();
      } catch (err) {
        listEl.innerHTML = '<div style="color:var(--danger); text-align:center; padding:20px;">访问失败: ' + esc(err.message) + '</div>';
      }
    }

    function renderPickerBreadcrumbs(dirPath) {
      const el = document.getElementById('pickerBreadcrumbs');
      if (!el || !dirPath) return;

      const parts = dirPath.split('\\\\').join('/').split('/').filter(Boolean);
      const isWindowsDrive = parts.length > 0 && parts[0].endsWith(':');

      let accumulated = '';
      const crumbs = [];

      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (i === 0 && isWindowsDrive) {
          accumulated = p + '/';
          crumbs.push({ name: p, path: accumulated });
        } else {
          if (accumulated.endsWith('/')) {
            accumulated += p;
          } else {
            accumulated += '/' + p;
          }
          crumbs.push({ name: p, path: accumulated });
        }
      }

      if (crumbs.length === 0) {
        el.innerHTML = '<span class="crumb" data-nav-path="' + esc(dirPath) + '">' + esc(dirPath) + '</span>';
        return;
      }

      let html = '';
      for (let i = 0; i < crumbs.length; i++) {
        const c = crumbs[i];
        const isLast = i === crumbs.length - 1;
        html += '<span class="crumb' + (isLast ? ' active' : '') + '" data-nav-path="' + esc(c.path) + '">' + esc(c.name) + '</span>';
        if (!isLast) {
          html += '<span class="crumb-sep">&gt;</span>';
        }
      }
      el.innerHTML = html;
    }

    function renderPickerList() {
      const listEl = document.getElementById('pickerEntriesList');
      if (!listEl) return;

      let items = pickerCachedEntries.slice();

      if (pickerFilterKeyword) {
        items = items.filter(it => it.name.toLowerCase().includes(pickerFilterKeyword));
      }

      if (pickerFilterMcpOnly) {
        items = items.filter(it => it.isDirectory || it.isMcpConfig);
      }

      if (items.length === 0) {
        listEl.innerHTML = '<div style="color:var(--muted); text-align:center; padding:20px;">' +
          (pickerFilterKeyword ? '未找到匹配项' : '此目录下为空') +
          '</div>';
        return;
      }

      let html = '';
      for (const item of items) {
        const isDir = item.isDirectory;
        const icon = isDir ? '📁' : (item.isMcpConfig ? '⚡' : '📄');
        const badge = item.isMcpConfig ? '<span class="badge" style="background:rgba(34,197,94,0.15); color:#22c55e; border:1px solid #22c55e; font-size:10px;">MCP 配置</span>' : '';
        const isSelected = pickerSelectedPath === item.path;
        html += '<div class="picker-item ' + (isSelected ? 'active' : '') + '" data-picker-path="' + esc(item.path) + '" data-picker-isdir="' + isDir + '">' +
          '<div style="display:flex; align-items:center; gap:8px;"><span>' + icon + '</span><span style="font-weight:' + (item.isMcpConfig ? '600' : 'normal') + '; color:' + (item.isMcpConfig ? '#ffffff' : '#cccccc') + ';">' + esc(item.name) + '</span></div>' +
          badge + '</div>';
      }
      listEl.innerHTML = html;
    }

    function onPickerFilterChanged() {
      const input = document.getElementById('pickerFilterInput');
      pickerFilterKeyword = input ? (input.value || '').trim().toLowerCase() : '';
      renderPickerList();
    }

    function togglePickerMcpFilter() {
      pickerFilterMcpOnly = !pickerFilterMcpOnly;
      const btn = document.getElementById('pickerMcpToggleBtn');
      if (btn) {
        if (pickerFilterMcpOnly) {
          btn.style.background = '#22c55e';
          btn.style.color = '#000000';
          btn.style.borderColor = '#22c55e';
          btn.style.fontWeight = 'bold';
        } else {
          btn.style.background = '';
          btn.style.color = '';
          btn.style.borderColor = '';
          btn.style.fontWeight = '';
        }
      }
      renderPickerList();
    }

    function selectCurrentPickerFolder() {
      if (pickerCurrentDir) {
        pickerSelectedPath = pickerCurrentDir;
        confirmPickerSelection();
      }
    }

    function confirmPickerSelection() {
      if (!pickerSelectedPath) return;
      if (pickerTargetInputId) {
        const input = document.getElementById(pickerTargetInputId);
        if (input) {
          input.value = pickerSelectedPath;
          if (pickerTargetInputId === 'newClientPath') {
            updateClientPathHint();
          }
        }
      } else if (pickerTargetClientId) {
        adminPost('/admin/client-action', {
          action: 'bind',
          client_id: pickerTargetClientId,
          manual_path: pickerSelectedPath
        });
      }
      closeFilePickerModal();
    }

    async function triggerNativeOsPicker() {
      try {
        const res = await fetch('/admin/browse-os-dialog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'file' })
        });
        const data = await res.json();
        if (data.status === 'ok' && data.path) {
          pickerSelectedPath = data.path;
          confirmPickerSelection();
        }
      } catch (err) {
        showToast('调用系统文件选择窗口失败: ' + err.message, false);
      }
    }

    let currentServerTab = 'upload';
    let uploadedFileObj = null;

    function openUploadServerModal() {
      const modal = document.getElementById('uploadServerModal');
      if (!modal) return;
      modal.style.display = 'flex';
      switchServerTab('upload');
      clearUploadServerStatus();
      const srvIdInput = document.getElementById('newServerId');
      if (srvIdInput && !srvIdInput.value.trim()) {
        generateRandomServerId();
      }
    }

    function closeUploadServerModal() {
      const modal = document.getElementById('uploadServerModal');
      if (modal) modal.style.display = 'none';
      clearUploadServerStatus();
    }

    function clearUploadServerStatus() {
      const msg = document.getElementById('serverUploadStatusMsg');
      if (msg) {
        msg.style.display = 'none';
        msg.textContent = '';
      }
      const btn = document.getElementById('submitUploadServerBtn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🚀 立即导入并挂载服务';
      }
    }

    function switchServerTab(tabName) {
      currentServerTab = tabName;
      document.querySelectorAll('.server-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.serverTab === tabName);
      });
      const tabUpload = document.getElementById('tabUploadContent');
      const tabUrl = document.getElementById('tabUrlContent');
      const tabLocal = document.getElementById('tabLocalContent');
      const tabJson = document.getElementById('tabJsonContent');
      if (tabUpload) tabUpload.style.display = tabName === 'upload' ? 'block' : 'none';
      if (tabUrl) tabUrl.style.display = tabName === 'url' ? 'block' : 'none';
      if (tabLocal) tabLocal.style.display = tabName === 'local' ? 'block' : 'none';
      if (tabJson) tabJson.style.display = tabName === 'json' ? 'block' : 'none';
    }

    function handleServerFileSelected(files) {
      if (!files || files.length === 0) return;
      const file = files[0];
      const reader = new FileReader();
      reader.onload = function(e) {
        const result = e.target.result;
        const base64 = String(result).split(',')[1] || '';
        uploadedFileObj = {
          name: file.name,
          size: file.size,
          base64: base64
        };
        const info = document.getElementById('uploadFileInfo');
        if (info) info.style.display = 'flex';
        const nameEl = document.getElementById('uploadFileName');
        if (nameEl) nameEl.textContent = file.name;
        const sizeEl = document.getElementById('uploadFileSize');
        if (sizeEl) sizeEl.textContent = '(' + (file.size > 1048576 ? (file.size/1048576).toFixed(1) + ' MB' : (file.size/1024).toFixed(1) + ' KB') + ')';

        const srvIdInput = document.getElementById('newServerId');
        if (srvIdInput && (!srvIdInput.value.trim() || srvIdInput.value.startsWith('srv_'))) {
          const cleanName = file.name.split('.')[0].replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
          if (cleanName) srvIdInput.value = cleanName;
        }
      };
      reader.readAsDataURL(file);
    }

    function handleServerFileDrop(e) {
      e.preventDefault();
      e.currentTarget.style.borderColor = 'var(--border-focus)';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleServerFileSelected(e.dataTransfer.files);
      }
    }

    function clearUploadFile() {
      uploadedFileObj = null;
      const fileInput = document.getElementById('serverFileInput');
      if (fileInput) fileInput.value = '';
      const info = document.getElementById('uploadFileInfo');
      if (info) info.style.display = 'none';
    }

    function fillUrlExample(url) {
      const input = document.getElementById('serverPullUrl');
      if (input) input.value = url;
      onServerPullUrlInput();
    }

    function onServerPullUrlInput() {
      const input = document.getElementById('serverPullUrl');
      const val = input ? input.value.trim() : '';
      const hint = document.getElementById('urlTypeHint');
      if (!val) {
        if (hint) hint.innerHTML = '💡 支持 Git 仓库 (自动 git clone)、Raw 代码文件直连下载或 OpenAPI/Swagger 接口';
        return;
      }
      if (val.includes('github.com') || val.endsWith('.git')) {
        if (hint) hint.innerHTML = '💡 <span style="color:#22c55e;">Git 仓库模式</span>: 将使用 <code>git clone --depth 1</code> 快速克隆，并自动识别 entrypoint 依赖';
        const parts = val.split('/');
        const repo = parts[parts.length - 1].replace('.git', '');
        const idInput = document.getElementById('newServerId');
        if (idInput && (!idInput.value.trim() || idInput.value.startsWith('srv_'))) {
          idInput.value = repo.replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
        }
      } else if (val.endsWith('.js') || val.endsWith('.py') || val.includes('raw.githubusercontent.com')) {
        if (hint) hint.innerHTML = '💡 <span style="color:#3b82f6;">Raw 脚本下载模式</span>: 将通过 HTTP 自动下载该脚本到独立服务目录并绑定运行时';
      } else if (val.endsWith('.json') || val.endsWith('.yaml') || val.includes('swagger') || val.includes('openapi')) {
        if (hint) hint.innerHTML = '💡 <span style="color:#eab308;">OpenAPI 规范模式</span>: 将自动加载接口契约虚拟化为完整工具集合';
      } else {
        if (hint) hint.innerHTML = '💡 目标 URL: <code>' + esc(val) + '</code>';
      }
    }

    function generateRandomServerId() {
      const idInput = document.getElementById('newServerId');
      if (idInput) {
        idInput.value = 'srv_' + generateRandom8();
      }
    }

    function toggleServerAdvancedOptions() {
      const p = document.getElementById('serverAdvancedPanel');
      if (!p) return;
      const isOpen = p.style.display === 'flex';
      p.style.display = isOpen ? 'none' : 'flex';
    }

    async function submitServerUpload() {
      const statusMsg = document.getElementById('serverUploadStatusMsg');
      const submitBtn = document.getElementById('submitUploadServerBtn');
      if (!statusMsg || !submitBtn) return;

      const serverId = (document.getElementById('newServerId')?.value || '').trim();
      const autoStart = document.getElementById('serverAutoStart')?.checked ?? true;
      const autoInstallDeps = document.getElementById('serverAutoInstallDeps')?.checked ?? true;

      const customCmd = (document.getElementById('serverCustomCmd')?.value || '').trim();
      const customArgsStr = (document.getElementById('serverCustomArgs')?.value || '').trim();
      const customArgs = customArgsStr ? customArgsStr.split(' ').filter(Boolean) : undefined;
      const customCwd = (document.getElementById('serverCustomCwd')?.value || '').trim();

      const payload = {
        sourceType: currentServerTab === 'upload' ? 'upload_file' : (currentServerTab === 'url' ? 'pull_url' : (currentServerTab === 'local' ? 'local_path' : 'json_config')),
        serverId: serverId || undefined,
        autoStart: autoStart,
        autoInstallDeps: autoInstallDeps,
        command: customCmd || undefined,
        args: customArgs,
        cwd: customCwd || undefined
      };

      if (currentServerTab === 'upload') {
        if (!uploadedFileObj) {
          showToast('请先选择或拖拽要上传的代码文件/ZIP包', false);
          return;
        }
        payload.fileName = uploadedFileObj.name;
        payload.fileContentBase64 = uploadedFileObj.base64;
      } else if (currentServerTab === 'url') {
        const urlVal = (document.getElementById('serverPullUrl')?.value || '').trim();
        if (!urlVal) {
          showToast('请输入要拉取的项目或脚本 URL', false);
          return;
        }
        payload.url = urlVal;
      } else if (currentServerTab === 'local') {
        const pathVal = (document.getElementById('serverLocalPath')?.value || '').trim();
        if (!pathVal) {
          showToast('请输入或浏览选择本地已有路径', false);
          return;
        }
        payload.localPath = pathVal;
      } else if (currentServerTab === 'json') {
        const rawJson = (document.getElementById('serverRawJson')?.value || '').trim();
        if (!rawJson) {
          showToast('请粘贴 MCP 配置 JSON', false);
          return;
        }
        payload.rawJson = rawJson;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ 正在导入、构建并挂载中...';
      statusMsg.style.display = 'block';
      statusMsg.innerHTML = '<span style="color:#eab308;">正在处理服务导入与工具发现，请稍候...</span>';

      try {
        const res = await fetch('/admin/server-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || data.status === 'error') {
          throw new Error(data.error || '导入服务失败');
        }

        const toolCount = (data.discoveredTools || []).length;
        let successInfo = '🎉 服务 [' + data.serverId + '] 已成功挂载！';
        if (toolCount > 0) {
          successInfo += ' 发现 ' + toolCount + ' 个可用工具。';
        } else if (data.warning) {
          successInfo += ' (' + data.warning + ')';
        }

        showToast(successInfo, true);
        closeUploadServerModal();
        await refreshState();
      } catch (err) {
        statusMsg.style.display = 'block';
        statusMsg.innerHTML = '<span style="color:var(--danger);">❌ 导入失败: ' + esc(err.message) + '</span>';
        submitBtn.disabled = false;
        submitBtn.textContent = '🚀 重试导入并挂载服务';
      }
    }

    let cachedAuditHistory = [];
    let currentAuditHistoryRisk = '';
    let currentAuditHistoryDecision = '';
    let selectedAuditEntry = null;

    function openAuditHistoryModal() {
      const modal = document.getElementById('auditHistoryModal');
      if (!modal) return;
      modal.style.display = 'flex';
      fetchAuditHistory();
    }

    function closeAuditHistoryModal() {
      const modal = document.getElementById('auditHistoryModal');
      if (modal) modal.style.display = 'none';
      closeAuditDetailInspector();
    }

    function closeAuditDetailInspector() {
      const insp = document.getElementById('auditDetailInspector');
      if (insp) insp.style.display = 'none';
      selectedAuditEntry = null;
      document.querySelectorAll('.audit-history-row').forEach(r => r.classList.remove('active'));
    }

    async function fetchAuditHistory() {
      const tbody = document.getElementById('auditHistoryTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--muted); padding:30px;">正在获取全量审计记录...</td></tr>';

      const limitSel = document.getElementById('auditHistoryLimit');
      const limit = limitSel ? limitSel.value : '200';
      const searchInput = document.getElementById('auditHistorySearch');
      const q = searchInput ? searchInput.value.trim() : '';

      const params = new URLSearchParams();
      if (limit) params.set('limit', limit);
      if (currentAuditHistoryRisk) params.set('risk', currentAuditHistoryRisk);
      if (currentAuditHistoryDecision) params.set('decision', currentAuditHistoryDecision);
      if (q) params.set('q', q);

      try {
        const res = await fetch('/admin/audit-history?' + params.toString());
        if (!res.ok) throw new Error('拉取历史失败');
        const data = await res.json();
        cachedAuditHistory = data.logs || [];

        const badge = document.getElementById('auditModalCountBadge');
        if (badge) badge.textContent = '已载入 ' + data.returnedCount + ' / 过滤 ' + data.filteredCount + ' / 内存总 ' + data.total + ' 条';

        const footerText = document.getElementById('auditModalFooterText');
        const retDays = data.retentionDays || 7;
        if (footerText) footerText.textContent = '当前显示 ' + data.returnedCount + ' 条，匹配 ' + data.filteredCount + ' 条 | 💾 磁盘已持久化至 ' + (data.storageFile || '.workbench-audit-history.json') + ' (保留最近 ' + retDays + ' 天，重启可查)';

        renderAuditHistoryTable(cachedAuditHistory);
      } catch (err) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--danger); padding:30px;">加载失败: ' + esc(err.message) + '</td></tr>';
      }
    }

    function renderAuditHistoryTable(logs) {
      const tbody = document.getElementById('auditHistoryTableBody');
      if (!tbody) return;
      if (!logs || logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:var(--muted); padding:30px;">未找到匹配的调用流水记录</td></tr>';
        return;
      }

      const list = logs.slice().reverse();
      tbody.innerHTML = list.map(a => {
        const isAllowed = a.decision === 'allowed' || a.decision === 'approved' || a.decision === 'approved_live_hold' || a.decision === 'approved_token';
        const decDot = isAllowed ? '<span class="dot dot-ok"></span>' : '<span class="dot dot-danger"></span>';
        const isSafe = a.riskLevel === 'safe';
        const riskDot = isSafe ? '<span class="dot dot-ok"></span>' : '<span class="dot dot-danger"></span>';

        const callerInfo = (a.callerPpid ? 'PID:' + a.callerPpid : '') + (a.callerCwd ? ' ' + a.callerCwd : (a.callerPpid ? '' : '-'));
        const isSelected = selectedAuditEntry && selectedAuditEntry.auditId === a.auditId;

        return '<tr class="audit-history-row ' + (isSelected ? 'active' : '') + '" style="cursor:pointer;" data-audit-id="' + esc(a.auditId) + '">' +
          '<td><code>' + esc(a.auditId) + '</code></td>' +
          '<td style="white-space:nowrap;">' + esc((a.timestamp || '').slice(11, 19)) + '</td>' +
          '<td><b>' + esc(a.toolName) + '</b> <span style="font-size:10px; color:var(--dim);">[' + esc(a.serverId) + ']</span></td>' +
          '<td>' + riskDot + esc(a.riskLevel) + '</td>' +
          '<td>' + decDot + esc(a.decision) + '</td>' +
          '<td>' + Number(a.durationMs) + 'ms</td>' +
          '<td style="max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--muted);" title="' + esc(callerInfo) + '">' + esc(callerInfo) + '</td>' +
          '<td style="max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><code title="' + esc(a.reason || a.argsPreview) + '">' + esc(a.reason ? a.reason + ' | ' + a.argsPreview : a.argsPreview) + '</code></td>' +
          '<td><button class="secondary btn-inspect-audit" type="button" style="padding:1px 6px; font-size:10px;" data-audit-id="' + esc(a.auditId) + '">详情</button></td>' +
          '</tr>';
      }).join('');
    }

    function inspectAuditItem(auditId) {
      const item = cachedAuditHistory.find(l => l.auditId === auditId);
      if (!item) return;
      selectedAuditEntry = item;

      document.querySelectorAll('.audit-history-row').forEach(r => {
        r.classList.toggle('active', r.dataset.auditId === auditId);
      });

      const insp = document.getElementById('auditDetailInspector');
      if (insp) insp.style.display = 'flex';

      const idEl = document.getElementById('auditDetailId');
      if (idEl) idEl.textContent = item.auditId + ' (' + item.toolName + ')';

      const metaEl = document.getElementById('auditDetailMeta');
      if (metaEl) metaEl.textContent = item.timestamp + ' | 耗时: ' + item.durationMs + 'ms | 决策: ' + item.decision + (item.callerPpid ? ' | 来源PID: ' + item.callerPpid : '');

      const pre = document.getElementById('auditDetailJsonPre');
      if (pre) pre.textContent = JSON.stringify(item, null, 2);
    }

    function copyAuditDetailParams() {
      if (!selectedAuditEntry) return;
      const content = selectedAuditEntry.argsPreview || JSON.stringify(selectedAuditEntry, null, 2);
      navigator.clipboard.writeText(content).then(() => {
        showToast('已复制参数内容到剪贴板', true);
      }).catch(() => {
        showToast('复制失败，请手动选择复制', false);
      });
    }

    function onAuditHistorySearchInput() {
      clearTimeout(window.__auditSearchTimer);
      window.__auditSearchTimer = setTimeout(fetchAuditHistory, 250);
    }

    function setAuditRiskFilter(risk) {
      currentAuditHistoryRisk = risk;
      document.querySelectorAll('.chip[data-audit-risk]').forEach(c => {
        c.classList.toggle('active', (c.dataset.auditRisk || '') === risk);
      });
      fetchAuditHistory();
    }

    function setAuditDecisionFilter(dec) {
      currentAuditHistoryDecision = dec;
      document.querySelectorAll('.chip[data-audit-dec]').forEach(c => {
        c.classList.toggle('active', (c.dataset.auditDec || '') === dec);
      });
      fetchAuditHistory();
    }

    function exportAuditHistoryJson() {
      if (!cachedAuditHistory || cachedAuditHistory.length === 0) {
        showToast('当前无审计记录可导出', false);
        return;
      }
      const blob = new Blob([JSON.stringify(cachedAuditHistory, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'workbench-audit-history-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('已导出 ' + cachedAuditHistory.length + ' 条审计记录为 JSON', true);
    }

    function exportAuditHistoryCsv() {
      if (!cachedAuditHistory || cachedAuditHistory.length === 0) {
        showToast('当前无审计记录可导出', false);
        return;
      }
      const headers = ['auditId', 'timestamp', 'toolName', 'serverId', 'riskLevel', 'decision', 'durationMs', 'callerPpid', 'callerCwd', 'reason', 'argsPreview'];
      const lines = [headers.join(',')];
      for (const item of cachedAuditHistory) {
        const row = headers.map(h => {
          const val = String(item[h] ?? '').replace(/"/g, '""');
          return '"' + val + '"';
        });
        lines.push(row.join(','));
      }
      const blob = new Blob([lines.join('\\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'workbench-audit-history-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast('已导出 ' + cachedAuditHistory.length + ' 条审计记录为 CSV', true);
    }

    let cachedTools = [];
    let selectedServerFilter = '';

    function syncPlayground(tools) {
      cachedTools = tools || [];

      // Calculate tool counts per server
      const counts = {};
      for (const t of cachedTools) {
        counts[t.serverId] = (counts[t.serverId] || 0) + 1;
      }
      const serverNames = Object.keys(counts).sort();

      // 1. Populate Server Dropdown
      const srvSel = document.getElementById('playgroundServerSelect');
      if (srvSel) {
        const prevSrv = srvSel.value;
        let srvHtml = '<option value="">全部已加载服务 (' + cachedTools.length + ' 个工具)</option>';
        for (const sid of serverNames) {
          srvHtml += '<option value="' + esc(sid) + '">' + esc(sid) + ' (' + counts[sid] + ' 个工具)</option>';
        }
        srvSel.innerHTML = srvHtml;
        if (serverNames.includes(prevSrv)) {
          srvSel.value = prevSrv;
        } else if (selectedServerFilter && serverNames.includes(selectedServerFilter)) {
          srvSel.value = selectedServerFilter;
        } else {
          selectedServerFilter = '';
          srvSel.value = '';
        }
      }

      // 2. Populate Dynamic Server Filter Chips
      const chipsEl = document.getElementById('activeServerChips');
      if (chipsEl) {
        let chipHtml = '<span class="chip ' + (selectedServerFilter === '' ? 'active' : '') + '" data-filter-srv="">全部 (' + cachedTools.length + ')</span>';
        for (const sid of serverNames) {
          chipHtml += '<span class="chip ' + (selectedServerFilter === sid ? 'active' : '') + '" data-filter-srv="' + esc(sid) + '">' + esc(sid) + ' (' + counts[sid] + ')</span>';
        }
        chipsEl.innerHTML = chipHtml;
      }

      // 3. Update Tools Select
      updateToolSelect();
    }

    function setPlaygroundServerFilter(serverId) {
      selectedServerFilter = serverId || '';
      const srvSel = document.getElementById('playgroundServerSelect');
      if (srvSel) srvSel.value = selectedServerFilter;
      const chips = document.querySelectorAll('.chip[data-filter-srv]');
      chips.forEach(c => {
        c.classList.toggle('active', (c.dataset.filterSrv || '') === selectedServerFilter);
      });
      updateToolSelect();
    }

    function onPlaygroundServerChanged() {
      const srvSel = document.getElementById('playgroundServerSelect');
      if (srvSel) setPlaygroundServerFilter(srvSel.value);
    }

    function updateToolSelect() {
      const sel = document.getElementById('toolSelect');
      if (!sel) return;
      const currentVal = sel.value;
      const filtered = selectedServerFilter
        ? cachedTools.filter(t => t.serverId === selectedServerFilter)
        : cachedTools;

      let html = '<option value="">-- 请选择要调用的 MCP 工具 (' + filtered.length + ' 个可用) --</option>';
      for (const t of filtered) {
        const val = t.serverId + '::' + t.name;
        html += '<option value="' + esc(val) + '">' + esc(t.serverId + ' → ' + t.name) + '</option>';
      }
      sel.innerHTML = html;

      const exists = filtered.some(t => (t.serverId + '::' + t.name) === currentVal);
      if (exists) {
        sel.value = currentVal;
      } else {
        onToolSelected();
      }
    }

    function onToolSelected() {
      const sel = document.getElementById('toolSelect');
      const val = sel ? sel.value : '';
      if (!val) {
        document.getElementById('toolDesc').textContent = '';
        document.getElementById('toolArgsInput').value = '{}';
        return;
      }
      const parts = val.split('::');
      const serverId = parts[0];
      const toolName = parts[1];
      const tool = cachedTools.find(t => t.serverId === serverId && t.name === toolName);
      if (tool) {
        document.getElementById('toolDesc').textContent = tool.description || '无详细描述';
        generateToolTemplate();
      }
    }

    function generateToolTemplate() {
      const sel = document.getElementById('toolSelect');
      const val = sel ? sel.value : '';
      if (!val) {
        showToast('请先选择要调用的工具', false);
        return;
      }
      const parts = val.split('::');
      const serverId = parts[0];
      const toolName = parts[1];
      const tool = cachedTools.find(t => t.serverId === serverId && t.name === toolName);
      if (tool) {
        const sample = {};
        if (tool.inputSchema && tool.inputSchema.properties) {
          for (const [k, p] of Object.entries(tool.inputSchema.properties)) {
            sample[k] = p.default !== undefined ? p.default : (p.type === 'number' || p.type === 'integer' ? 0 : p.type === 'boolean' ? false : (p.type === 'array' ? [] : (p.type === 'object' ? {} : '')));
          }
        }
        document.getElementById('toolArgsInput').value = JSON.stringify(sample, null, 2);
        showToast('已填入参数模板', true);
      }
    }

    function formatToolArgs() {
      const area = document.getElementById('toolArgsInput');
      try {
        const parsed = JSON.parse(area.value || '{}');
        area.value = JSON.stringify(parsed, null, 2);
        showToast('JSON 已格式化', true);
      } catch (e) {
        showToast('JSON 格式错误: ' + e.message, false);
      }
    }

    async function executeSelectedTool() {
      const sel = document.getElementById('toolSelect');
      const val = sel ? sel.value : '';
      if (!val) {
        showToast('请先选择要调用的工具', false);
        return;
      }
      const parts = val.split('::');
      const serverId = parts[0];
      const toolName = parts[1];
      let args = {};
      try {
        args = JSON.parse(document.getElementById('toolArgsInput').value || '{}');
      } catch (e) {
        showToast('参数不是有效的 JSON 格式', false);
        return;
      }
      await runTool(serverId, toolName, args);
    }

    async function runTool(serverId, toolName, args) {
      const pre = document.getElementById('toolOutputPre');
      pre.style.color = '#888888';
      pre.textContent = '/* 正在通过 MCP Workbench 统一网关执行 [' + serverId + '::' + toolName + '] ... */';
      const t0 = performance.now();
      try {
        const res = await fetch('/admin/tool-invoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ server_id: serverId, tool_name: toolName, arguments: args })
        });
        const elapsed = Math.round(performance.now() - t0);
        const data = await res.json();
        if (res.ok && data.status === 'ok') {
          pre.style.color = '#22c55e';
          pre.textContent = '/* 状态: 成功 (耗时: ' + elapsed + 'ms) */\\n' + JSON.stringify(data.result, null, 2);
          showToast('执行成功 (' + elapsed + 'ms)', true);
        } else {
          pre.style.color = '#ef4444';
          pre.textContent = '/* 状态: 失败 (耗时: ' + elapsed + 'ms) */\\n' + JSON.stringify(data, null, 2);
          showToast(data.error || '执行出错', false);
        }
      } catch (err) {
        pre.style.color = '#ef4444';
        pre.textContent = '网络错误: ' + err.message;
        showToast('网络请求异常', false);
      }
      await refreshState();
    }

    function addPolicyRule() {
      const ruleId = document.getElementById('polId').value.trim();
      const targetTool = document.getElementById('polTarget').value.trim() || '*';
      const riskLevel = document.getElementById('polRisk').value;
      const denyParamRegex = document.getElementById('polRegex').value.trim() || undefined;
      if (!ruleId) return;
      adminPost('/admin/policy-action', {
        action: 'upsert',
        rule_id: ruleId,
        target_tool: targetTool,
        risk_level: riskLevel,
        deny_param_regex: denyParamRegex,
        require_approval: riskLevel === 'destructive'
      });
    }

    function saveSecret() {
      const key = document.getElementById('secKey').value.trim();
      const value = document.getElementById('secVal').value;
      if (!key || !value) return;
      adminPost('/admin/secrets', { key, value });
      document.getElementById('secVal').value = '';
    }

    function toggleToolDropdown(forceOpen) {
      const menu = document.getElementById('toolDropdownMenu');
      if (!menu) return;
      const isOpen = menu.style.display === 'flex';
      const willOpen = forceOpen !== undefined ? forceOpen : !isOpen;
      menu.style.display = willOpen ? 'flex' : 'none';
      if (willOpen) {
        const search = document.getElementById('toolSearchBox');
        if (search) {
          search.value = '';
          renderToolDropdownList('');
          setTimeout(() => search.focus(), 60);
        }
      }
    }

    function filterToolDropdown() {
      const search = document.getElementById('toolSearchBox');
      const q = (search ? search.value : '').trim().toLowerCase();
      renderToolDropdownList(q);
    }

    function renderToolDropdownList(query) {
      const listEl = document.getElementById('toolDropdownList');
      if (!listEl) return;
      const wildcards = [
        { name: '*', desc: '全局所有工具 (通配符)' },
        { name: 'studio__*', desc: '所有 Workbench 内置管控工具' }
      ];
      const srvIds = Array.from(new Set((cachedTools || []).map(t => t.serverId)));
      for (const sid of srvIds) {
        if (sid !== 'studio') {
          wildcards.push({ name: sid + '__*', desc: '服务 [' + sid + '] 下属全部工具' });
        }
      }

      let html = '';

      // 1. Wildcards section
      const matchedWildcards = wildcards.filter(w => !query || w.name.toLowerCase().includes(query) || w.desc.toLowerCase().includes(query));
      if (matchedWildcards.length > 0) {
        html += '<div class="dropdown-group-title">快捷通配符</div>';
        for (const w of matchedWildcards) {
          html += '<div class="dropdown-item btn-select-policy-tool" data-tool="' + esc(w.name) + '"><b>' + esc(w.name) + '</b><span class="badge-srv">' + esc(w.desc) + '</span></div>';
        }
      }

      // 2. Specific tools section
      const matchedTools = (cachedTools || []).filter(t => {
        if (!query) return true;
        const target = ((t.exposedName || (t.serverId + '__' + t.name)) + ' ' + (t.description || '')).toLowerCase();
        return target.includes(query);
      });

      if (matchedTools.length > 0) {
        html += '<div class="dropdown-group-title">具体工具 (' + matchedTools.length + ')</div>';
        for (const t of matchedTools) {
          const expName = t.exposedName || (t.serverId + '__' + t.name);
          html += '<div class="dropdown-item btn-select-policy-tool" data-tool="' + esc(expName) + '"><span>' + esc(expName) + '</span><span class="badge-srv">' + esc(t.serverId) + '</span></div>';
        }
      } else if (!matchedWildcards.length) {
        html = '<div style="padding: 12px; font-size: 12px; color: var(--muted); text-align: center;">未找到匹配工具</div>';
      }

      listEl.innerHTML = html;
    }

    function selectToolForPolicy(toolName) {
      const input = document.getElementById('polTarget');
      if (input) input.value = toolName;
      toggleToolDropdown(false);
      // Auto-suggest policy ID if empty
      const polId = document.getElementById('polId');
      if (polId && !polId.value.trim()) {
        const clean = toolName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').toLowerCase();
        polId.value = 'rule_' + clean;
      }
    }

    document.addEventListener('click', function(e) {
      // Close modal on backdrop click
      if (e.target && e.target.id === 'filePickerModal') {
        closeFilePickerModal();
        return;
      }
      if (e.target && e.target.id === 'auditHistoryModal') {
        closeAuditHistoryModal();
        return;
      }
      if (e.target && e.target.id === 'uploadServerModal') {
        closeUploadServerModal();
        return;
      }

      // Handle audit history row click
      const auditRow = e.target.closest('.audit-history-row');
      if (auditRow && auditRow.dataset.auditId) {
        inspectAuditItem(auditRow.dataset.auditId);
        return;
      }

      // Handle breadcrumbs navigation click
      const crumb = e.target.closest('.crumb[data-nav-path]');
      if (crumb) {
        navigatePickerTo(crumb.dataset.navPath);
        return;
      }

      // Handle server filter chip click in playground
      const chip = e.target.closest('.chip[data-filter-srv]');
      if (chip) {
        setPlaygroundServerFilter(chip.dataset.filterSrv);
        return;
      }

      // Handle client filter chip click
      const clientChip = e.target.closest('.chip[data-filter-client]');
      if (clientChip) {
        selectedClientFilter = clientChip.dataset.filterClient;
        const allClientChips = document.querySelectorAll('.chip[data-filter-client]');
        allClientChips.forEach(c => {
          c.classList.toggle('active', c.dataset.filterClient === selectedClientFilter);
        });
        renderClientTable();
        return;
      }

      // Handle path navigation chip in file picker
      const navChip = e.target.closest('.chip[data-nav-path]');
      if (navChip) {
        navigatePickerTo(navChip.dataset.navPath);
        return;
      }

      // Handle item click in file picker
      const pItem = e.target.closest('.picker-item');
      if (pItem) {
        const itemPath = pItem.dataset.pickerPath;
        const isDir = pItem.dataset.pickerIsdir === 'true';
        document.querySelectorAll('.picker-item').forEach(i => i.classList.remove('active'));
        pItem.classList.add('active');
        pickerSelectedPath = itemPath;
        document.getElementById('pickerSelectedDisplay').textContent = itemPath;
        document.getElementById('pickerConfirmBtn').disabled = false;
        if (isDir) {
          if (pItem.dataset.clickedOnce) {
            navigatePickerTo(itemPath);
          } else {
            pItem.dataset.clickedOnce = 'true';
            setTimeout(() => { delete pItem.dataset.clickedOnce; }, 350);
          }
        }
        return;
      }

      // Handle manual path specification for client
      const manualBtn = e.target.closest('.btn-client-manual');
      if (manualBtn) {
        const cid = manualBtn.dataset.client;
        const cname = manualBtn.dataset.name;
        openFilePickerModalForClient(cid, cname);
        return;
      }

      // Handle tool selection click in dropdown
      const toolItem = e.target.closest('.btn-select-policy-tool');
      if (toolItem && toolItem.dataset.tool) {
        selectToolForPolicy(toolItem.dataset.tool);
        return;
      }

      // Handle click outside dropdown to close
      const container = document.getElementById('toolDropdownContainer');
      if (container && !container.contains(e.target)) {
        toggleToolDropdown(false);
      }

      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.classList.contains('btn-approve')) {
        adminPost('/admin/approve', { approval_token: btn.dataset.token });
      } else if (btn.classList.contains('btn-reject')) {
        adminPost('/admin/reject', { approval_token: btn.dataset.token });
      } else if (btn.classList.contains('btn-server-action')) {
        adminPost('/admin/server-action', { action: btn.dataset.action, id: btn.dataset.server });
      } else if (btn.classList.contains('btn-server-restart')) {
        adminPost('/admin/server-action', { action: 'restart', id: btn.dataset.server });
      } else if (btn.classList.contains('btn-client-toggle')) {
        adminPost('/admin/client-action', { action: btn.dataset.action, client_id: btn.dataset.client });
      } else if (btn.classList.contains('btn-client-delete')) {
        const cid = btn.dataset.client;
        if (confirm('确定要删除该自定义客户端吗？')) {
          adminPost('/admin/client-action', { action: 'remove', client_id: cid });
        }
      } else if (btn.classList.contains('btn-policy-delete')) {
        adminPost('/admin/policy-action', { action: 'delete', rule_id: btn.dataset.rule });
      } else if (btn.classList.contains('btn-secret-delete')) {
        adminPost('/admin/secret-delete', { key: btn.dataset.key });
      }
    });

    // Double-click to open folder or confirm file selection
    document.addEventListener('dblclick', function(e) {
      const pItem = e.target.closest('.picker-item');
      if (!pItem) return;
      const itemPath = pItem.dataset.pickerPath;
      const isDir = pItem.dataset.pickerIsdir === 'true';
      if (isDir) {
        navigatePickerTo(itemPath);
      } else {
        pickerSelectedPath = itemPath;
        const disp = document.getElementById('pickerSelectedDisplay');
        if (disp) disp.textContent = itemPath;
        const confirmBtn = document.getElementById('pickerConfirmBtn');
        if (confirmBtn) confirmBtn.disabled = false;
        confirmPickerSelection();
      }
    });

    // Global keyboard shortcuts (Escape to dismiss modals/panels)
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        const pickerModal = document.getElementById('filePickerModal');
        if (pickerModal && pickerModal.style.display !== 'none') {
          closeFilePickerModal();
          return;
        }
        const uploadModal = document.getElementById('uploadServerModal');
        if (uploadModal && uploadModal.style.display !== 'none') {
          closeUploadServerModal();
          return;
        }
        const auditModal = document.getElementById('auditHistoryModal');
        if (auditModal && auditModal.style.display !== 'none') {
          closeAuditHistoryModal();
          return;
        }
        const addClient = document.getElementById('addClientPanel');
        if (addClient && addClient.style.display !== 'none') {
          toggleAddClientPanel(false);
          return;
        }
        const toolDropdown = document.getElementById('toolDropdownMenu');
        if (toolDropdown && toolDropdown.style.display !== 'none') {
          toggleToolDropdown(false);
          return;
        }
      }
    });

    // Initial load + Auto-refresh every 2.5s
    refreshState();
    setInterval(refreshState, 2500);
  </script>
</body>
</html>`;
    }
}

