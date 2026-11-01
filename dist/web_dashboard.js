function escapeHtml(str) {
    if (str === null || str === undefined)
        return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
/**
 * Module 9: Embedded Web Dashboard & Human-in-the-Loop Console (`WebDashboard`).
 * Zero-dependency, lightweight modern GUI served directly from Daemon `/ui`.
 */
export class WebDashboard {
    static renderHtml(ctx) {
        const servers = ctx.registry.getAllRuntimeStates();
        const desired = ctx.registry.getDesiredServers();
        const allTools = ctx.registry.getAllTools();
        const pendingApprovals = ctx.policyGuard ? ctx.policyGuard.listPendingApprovals() : [];
        const overview = ctx.metrics ? ctx.metrics.getSystemOverview() : {};
        const healthSummary = ctx.watchdog ? ctx.watchdog.getHealthSummary() : [];
        const serverCards = desired
            .map((d) => {
            const actual = servers.find((s) => s.serverId === d.id);
            const health = healthSummary.find((h) => h.serverId === d.id);
            const serverTools = allTools.filter((t) => t.serverId === d.id);
            const phase = actual?.phase ?? "stopped";
            const isRunning = phase === "running";
            const circuitState = health?.state ?? "CLOSED";
            let badgeClass = "badge-stopped";
            if (circuitState === "OPEN")
                badgeClass = "badge-tripped";
            else if (isRunning)
                badgeClass = "badge-running";
            return `
          <div class="card">
            <div class="card-header">
              <span class="server-title">${escapeHtml(d.id)}</span>
              <span class="badge ${badgeClass}">${escapeHtml(circuitState === "OPEN" ? "TRIPPED" : phase)}</span>
            </div>
            <div class="card-body">
              <p><strong>Driver:</strong> ${escapeHtml(d.serverType ?? "stdio_process")}</p>
              <p><strong>PID:</strong> ${actual?.pid ?? "-"}</p>
              <p><strong>Tools:</strong> ${serverTools.length} exposed</p>
              ${health && health.consecutiveFailures > 0 ? `<p class="warn">Failures: ${health.consecutiveFailures}</p>` : ""}
            </div>
          </div>
        `;
        })
            .join("\n");
        const approvalItems = pendingApprovals.length === 0
            ? `<div class="empty-state">✅ No pending human approvals required at this time.</div>`
            : pendingApprovals
                .map((p) => `
          <div class="approval-card">
            <div class="approval-header">
              <span class="danger-pill">DESTRUCTIVE</span>
              <strong>${escapeHtml(p.targetTool)}</strong>
              <span class="token-code">${escapeHtml(p.approvalToken)}</span>
            </div>
            <div class="approval-args">
              <code>${escapeHtml(p.argsPreview)}</code>
            </div>
            <div class="approval-actions">
              <button class="btn btn-approve" onclick="handleApproval('${escapeHtml(p.approvalToken)}', 'approve')">Approve Call</button>
              <button class="btn btn-reject" onclick="handleApproval('${escapeHtml(p.approvalToken)}', 'reject')">Reject</button>
            </div>
          </div>
        `)
                .join("\n");
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Workbench — Autonomous Agent Gateway Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-bright: #f0f6fc;
      --accent: #58a6ff;
      --success: #2ea043;
      --danger: #f85149;
      --warning: #d29922;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 24px; line-height: 1.5; }
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
    h1 { color: var(--text-bright); font-size: 20px; display: flex; align-items: center; gap: 8px; }
    .header-meta { font-size: 13px; color: #8b949e; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .server-title { font-weight: 600; color: var(--text-bright); }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 12px; }
    .badge-running { background: rgba(46,160,67,0.2); color: #3fb950; border: 1px solid rgba(46,160,67,0.4); }
    .badge-stopped { background: rgba(139,148,158,0.2); color: #8b949e; border: 1px solid rgba(139,148,158,0.4); }
    .badge-tripped { background: rgba(248,81,73,0.2); color: #f85149; border: 1px solid rgba(248,81,73,0.4); }
    .card-body p { font-size: 13px; margin-bottom: 4px; }
    .warn { color: var(--warning); font-weight: bold; }
    .section-title { font-size: 16px; color: var(--text-bright); margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .stat-box { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; text-align: center; }
    .stat-num { font-size: 24px; font-weight: bold; color: var(--accent); }
    .stat-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .approval-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 10px; }
    .approval-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 14px; }
    .danger-pill { background: rgba(248,81,73,0.2); color: #f85149; font-size: 10px; padding: 1px 6px; border-radius: 4px; font-weight: bold; }
    .token-code { font-family: monospace; font-size: 12px; color: var(--accent); margin-left: auto; }
    .approval-args code { display: block; background: #090d13; padding: 8px; border-radius: 4px; font-size: 12px; color: #7ee787; word-break: break-all; margin-bottom: 10px; }
    .approval-actions { display: flex; gap: 8px; }
    .btn { padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; }
    .btn-approve { background: var(--success); color: white; }
    .btn-reject { background: #21262d; color: var(--danger); border: 1px solid var(--danger); }
    .btn-approve:hover { filter: brightness(1.1); }
    .empty-state { background: var(--card-bg); border: 1px dashed var(--border); border-radius: 8px; padding: 20px; text-align: center; font-size: 13px; color: #8b949e; margin-bottom: 24px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>⚡ MCP Workbench Gateway Console</h1>
      <div class="header-meta">Daemon PID: ${ctx.lockInfo.pid} &bull; Endpoint: http://${escapeHtml(ctx.lockInfo.host)}:${ctx.lockInfo.port} &bull; v${escapeHtml(ctx.lockInfo.version)}</div>
    </div>
    <div>
      <button class="btn btn-approve" onclick="location.reload()">Refresh Data</button>
    </div>
  </header>

  <div class="stat-row">
    <div class="stat-box">
      <div class="stat-num">${overview.totalCalls ?? 0}</div>
      <div class="stat-label">Total Tool Calls</div>
    </div>
    <div class="stat-box">
      <div class="stat-num">${overview.overallAvgLatencyMs ?? 0}ms</div>
      <div class="stat-label">Avg Tool Latency</div>
    </div>
    <div class="stat-box">
      <div class="stat-num">${overview.cacheHitRatePercent ?? 0}%</div>
      <div class="stat-label">Cache Hit Rate</div>
    </div>
    <div class="stat-box">
      <div class="stat-num">${overview.totalEstimatedTokens ?? 0}</div>
      <div class="stat-label">Estimated Tokens</div>
    </div>
  </div>

  <div class="section-title">
    <span>🛡️ Human-in-the-Loop Policy Approvals</span>
  </div>
  ${approvalItems}

  <div class="section-title" style="margin-top: 24px;">
    <span>🖥️ Registered MCP Service Topology</span>
  </div>
  <div class="grid">
    ${serverCards}
  </div>

  <script>
    async function handleApproval(token, action) {
      let secret = sessionStorage.getItem("wb_secret");
      if (!secret) {
        secret = prompt("Please enter Workbench Admin Secret:");
        if (!secret) return;
        sessionStorage.setItem("wb_secret", secret);
      }
      try {
        const resp = await fetch("/admin/approve", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-workbench-admin-secret": secret
          },
          body: JSON.stringify({ approval_token: token, action: action })
        });
        const data = await resp.json();
        if (resp.ok) {
          alert("Action " + action + " succeeded!");
          location.reload();
        } else {
          alert("Error: " + (data.error || "Failed to submit approval"));
        }
      } catch (err) {
        alert("Network error: " + err.message);
      }
    }
  </script>
</body>
</html>`;
    }
}
