import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { execSync, execFile } from "node:child_process";
import type {
  DaemonLockInfo,
  JsonRpcNotification,
  JsonRpcRequest,
} from "./types.js";
import { WorkbenchRegistry } from "./registry.js";
import { ProcessPool } from "./process_pool.js";
import { McpAggregator } from "./aggregator.js";
import { MetaToolsProvider } from "./meta_tools.js";
import { GatewayCore } from "./gateway_core.js";
import { ClientAutoBinder } from "./client_binder.js";
import { OpenApiConnector } from "./openapi_connector.js";
import { ContextProfileRouter } from "./profile_router.js";
import { PolicyGuard } from "./policy_guard.js";
import { SoftwareBridge } from "./software_bridge.js";
import { BuilderSandbox } from "./builder_sandbox.js";
import { HealthWatchdog } from "./health_watchdog.js";
import { ToolResultCache, TokenBucketRateLimiter } from "./cache_limiter.js";
import { TelemetryMetrics } from "./telemetry_metrics.js";
import { SecretVault } from "./secret_vault.js";
import { WebDashboard } from "./web_dashboard.js";
import { CommandResolver } from "./command_resolver.js";
import { WebConsole } from "./web_console.js";
import { ServerImporter } from "./server_importer.js";

/**
 * Single-Instance Core Daemon v0.0.5 (`mcp-workbenchd`).
 * Integrates all 5 core modules + ClientAutoBinder with out-of-band `/admin/approve`
 * and Host Software Reverse IPC Bridge (`/bridge/register`, `/bridge/stream`, `/bridge/callback`).
 */
export class WorkbenchDaemon {
  private readonly rootDir: string;
  private readonly configPath: string;
  private readonly lockPath: string;
  private readonly port: number;
  private readonly host = "127.0.0.1";
  private readonly token: string;
  private readonly adminSecret: string;

  public readonly registry: WorkbenchRegistry;
  public readonly processPool: ProcessPool;
  public readonly openApiConnector: OpenApiConnector;
  public readonly profileRouter: ContextProfileRouter;
  public readonly policyGuard: PolicyGuard;
  public readonly softwareBridge: SoftwareBridge;
  public readonly builderSandbox: BuilderSandbox;
  public readonly aggregator: McpAggregator;
  public readonly clientBinder: ClientAutoBinder;
  public readonly metaTools: MetaToolsProvider;
  public readonly gatewayCore: GatewayCore;
  public readonly secretVault: SecretVault;
  public readonly healthWatchdog: HealthWatchdog;
  public readonly toolCache: ToolResultCache;
  public readonly rateLimiter: TokenBucketRateLimiter;
  public readonly telemetryMetrics: TelemetryMetrics;
  public readonly commandResolver: CommandResolver;
  public readonly webConsole: WebConsole;
  public readonly serverImporter: ServerImporter;
  public readonly connectedClientPids = new Set<number>();

  private server: http.Server | null = null;
  private readonly sseClients = new Set<http.ServerResponse>();
  private readonly notificationLog: JsonRpcNotification[] = [];
  private lockCheckTimer: NodeJS.Timeout | null = null;

  constructor(rootDir: string, port = 43110) {
    this.rootDir = path.resolve(rootDir);
    this.configPath = path.join(this.rootDir, "workbench.json");
    this.lockPath = path.join(this.rootDir, ".workbench-daemon.lock.json");
    this.port = port;
    this.token = crypto.randomBytes(24).toString("hex");
    this.adminSecret = crypto.randomBytes(24).toString("hex");

    this.commandResolver = new CommandResolver();
    this.secretVault = new SecretVault(this.rootDir);
    this.registry = new WorkbenchRegistry(this.configPath);
    this.processPool = new ProcessPool(this.registry, this.rootDir, this.commandResolver, this.secretVault);
    this.processPool.secretVault = this.secretVault;
    this.openApiConnector = new OpenApiConnector(this.registry, this.rootDir);
    this.openApiConnector.secretVault = this.secretVault;
    this.profileRouter = new ContextProfileRouter(this.registry, this.rootDir);
    this.policyGuard = new PolicyGuard(
      this.adminSecret,
      this.secretVault,
      this.rootDir
    );
    this.softwareBridge = new SoftwareBridge(this.registry);

    this.healthWatchdog = new HealthWatchdog(this.registry, this.processPool);
    this.toolCache = new ToolResultCache();
    this.rateLimiter = new TokenBucketRateLimiter();
    this.telemetryMetrics = new TelemetryMetrics();

    this.aggregator = new McpAggregator(
      this.registry,
      this.processPool,
      this.openApiConnector,
      this.profileRouter,
      this.policyGuard,
      this.softwareBridge
    );
    this.aggregator.healthWatchdog = this.healthWatchdog;
    this.aggregator.toolCache = this.toolCache;
    this.aggregator.rateLimiter = this.rateLimiter;
    this.aggregator.telemetryMetrics = this.telemetryMetrics;

    this.builderSandbox = new BuilderSandbox(
      this.registry,
      this.aggregator,
      this.rootDir
    );
    this.clientBinder = new ClientAutoBinder(
      this.registry,
      this.rootDir,
      this.aggregator
    );
    this.metaTools = new MetaToolsProvider(
      this.registry,
      this.processPool,
      this.aggregator,
      this.clientBinder,
      this.openApiConnector,
      this.profileRouter,
      this.policyGuard,
      this.softwareBridge,
      this.builderSandbox,
      this.secretVault
    );
    this.gatewayCore = new GatewayCore(
      this.registry,
      this.aggregator,
      this.metaTools,
      this.profileRouter
    );

    this.webConsole = new WebConsole(
      this.registry,
      this.policyGuard,
      this.secretVault,
      this.clientBinder,
      this.softwareBridge,
      this.profileRouter
    );

    this.serverImporter = new ServerImporter(
      this.rootDir,
      this.registry,
      this.aggregator
    );

    this.gatewayCore.on(
      "broadcastNotification",
      (notification: JsonRpcNotification) => {
        this.notificationLog.push(notification);
        if (this.notificationLog.length > 500) {
          this.notificationLog.shift();
        }
        const frame = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
        for (const client of Array.from(this.sseClients)) {
          try {
            client.write(frame);
          } catch {
            this.sseClients.delete(client);
          }
        }
      }
    );
  }

  private verifyDaemonProcess(lock: DaemonLockInfo): Promise<boolean> {
    return new Promise((resolve) => {
      // 1. Direct HTTP health probe: authoritative, network-level and cross-session safe
      const req = http.request(
        {
          hostname: lock.host,
          port: lock.port,
          path: "/health",
          method: "GET",
          timeout: 1500,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf-8");
          });
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              if (data && data.status === "ok") {
                resolve(true);
                return;
              }
            } catch {}
            resolve(res.statusCode === 200);
          });
        }
      );
      req.on("error", () => {
        // Fallback: if network probe errored, check OS process existence
        try {
          process.kill(lock.pid, 0);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
      req.on("timeout", () => {
        req.destroy();
        try {
          process.kill(lock.pid, 0);
          resolve(true);
        } catch {
          resolve(false);
        }
      });
      req.end();
    });
  }

  private async acquireSingleInstanceLock(): Promise<void> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        const isRunning = await this.verifyDaemonProcess(existing);
        if (isRunning) {
          throw new Error(
            `ALREADY_RUNNING: MCP Workbench Daemon is already running (PID=${existing.pid}, Port=${existing.port}).`
          );
        }
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          // ignore
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("ALREADY_RUNNING:")) {
          throw err;
        }
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          // ignore
        }
      }
    }

    const lockInfo: DaemonLockInfo = {
      pid: process.pid,
      host: "127.0.0.1",
      port: this.port,
      token: this.token,
      adminSecret: this.adminSecret,
      startedAt: new Date().toISOString(),
      version: "0.3.0",
    };
    fs.writeFileSync(this.lockPath, JSON.stringify(lockInfo, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });

    if (this.lockCheckTimer) {
      clearInterval(this.lockCheckTimer);
    }
    this.lockCheckTimer = setInterval(() => {
      try {
        if (!fs.existsSync(this.lockPath)) {
          fs.writeFileSync(this.lockPath, JSON.stringify(lockInfo, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
          });
        }
      } catch {
        // ignore
      }
    }, 1000);
    this.lockCheckTimer.unref();
  }

  private safeCompare(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  private isLoopbackAddress(ip: string | undefined): boolean {
    if (!ip) return false;
    const clean = ip.replace(/^::ffff:/, "").toLowerCase();
    return clean === "127.0.0.1" || clean === "::1" || clean === "localhost";
  }

  private isAuthorizedAdmin(req: http.IncomingMessage): boolean {
    const isLoopback = this.isLoopbackAddress(req.socket.remoteAddress);
    const providedSecret = String(req.headers["x-workbench-admin-secret"] ?? "");

    // 1. Explicit human or test adminSecret validation
    if (providedSecret) {
      return this.safeCompare(providedSecret, this.adminSecret);
    }

    // 2. Loopback host direct trust (127.0.0.1 / localhost)
    if (isLoopback) {
      return true;
    }

    return false;
  }

  private readRequestBodyWithLimit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    maxBytes = (Number(process.env.MCP_MAX_BODY_MB) || 64) * 1024 * 1024
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let received = 0;
      let body = "";
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32600,
                message: `Payload Too Large: Exceeded dynamic limit of ${maxBytes / 1024 / 1024}MB. Adjust via MCP_MAX_BODY_MB.`,
              },
            })
          );
          req.destroy();
          reject(new Error("PAYLOAD_TOO_LARGE"));
          return;
        }
        body += chunk.toString("utf-8");
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  public async start(): Promise<DaemonLockInfo> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        const isRunning = await this.verifyDaemonProcess(existing);
        if (isRunning) {
          throw new Error(
            `ALREADY_RUNNING: MCP Workbench Daemon is already running (PID=${existing.pid}, Port=${existing.port}).`
          );
        }
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          // ignore
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("ALREADY_RUNNING:")) {
          throw err;
        }
      }
    }

    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);

      // 1. Public Health Check
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            pid: process.pid,
            version: "0.3.0",
            servers: this.registry.getAllRuntimeStates(),
            totalTools: this.registry.getAllTools().length,
            topLevelTools: this.registry.getTopLevelExposedTools().length,
            activeBridges: this.softwareBridge.listActiveBridges().length,
            notificationsSent: this.notificationLog.length,
          })
        );
        return;
      }

      // 1b. Embedded Modern Web Dashboard (`GET /ui`, `GET /`, `GET /dashboard`)
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        res.writeHead(302, { Location: "/ui" });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/ui") {
        if (!this.registry.isWebUiEnabled()) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              error: "WEB_UI_DISABLED",
              message:
                "Web Console (/ui) is currently disabled. Enable it in the Terminal TUI with '/webui on' or via 'studio__ui__configure'.",
            })
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(this.webConsole.renderHtmlConsole(this.port));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/webui") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        const enabled = this.registry.setWebUiEnabled(Boolean(parsed.enabled));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", webUiEnabled: enabled }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/state") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.webConsole.getDashboardState()));
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/audit-history") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam === "all" || limitParam === "0" ? 0 : Number(limitParam || 200);
        const risk = (url.searchParams.get("risk") || "").trim().toLowerCase();
        const decision = (url.searchParams.get("decision") || "").trim().toLowerCase();
        const q = (url.searchParams.get("q") || "").trim().toLowerCase();

        let allLogs = this.policyGuard.getAuditLogs(0); // get all in memory
        const totalCount = allLogs.length;

        if (risk && risk !== "all") {
          allLogs = allLogs.filter((l) => l.riskLevel === risk);
        }
        if (decision && decision !== "all") {
          if (decision === "blocked") {
            allLogs = allLogs.filter((l) => l.decision.startsWith("blocked_") || l.decision.startsWith("rejected"));
          } else if (decision === "allowed") {
            allLogs = allLogs.filter((l) => l.decision === "allowed" || l.decision.startsWith("approved"));
          } else if (decision === "error") {
            allLogs = allLogs.filter((l) => l.decision === "execution_error");
          } else {
            allLogs = allLogs.filter((l) => l.decision === decision);
          }
        }
        if (q) {
          allLogs = allLogs.filter(
            (l) =>
              (l.toolName || "").toLowerCase().includes(q) ||
              (l.serverId || "").toLowerCase().includes(q) ||
              (l.reason || "").toLowerCase().includes(q) ||
              (l.argsPreview || "").toLowerCase().includes(q) ||
              (l.callerCwd || "").toLowerCase().includes(q) ||
              (l.auditId || "").toLowerCase().includes(q)
          );
        }

        const sliced = limit > 0 ? allLogs.slice(-limit) : allLogs;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            total: totalCount,
            filteredCount: allLogs.length,
            returnedCount: sliced.length,
            retentionDays: this.policyGuard.getAuditRetentionDays(),
            storageFile: ".workbench-audit-history.json",
            logs: sliced,
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/reject") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const parsed = JSON.parse(body);
          const rejected = this.policyGuard.rejectPendingTokenWithAdminSecret(
            String(parsed.approval_token ?? ""),
            this.adminSecret
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ rejected, approvalToken: parsed.approval_token }));
        } catch (err) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/secrets") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        this.secretVault.setSecret(String(parsed.key), String(parsed.value));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", key: parsed.key }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/secret-delete") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        const deleted = this.secretVault.deleteSecret(String(parsed.key ?? ""));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", deleted }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/policy-action") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        if (parsed.action === "delete") {
          const deleted = this.policyGuard.deletePolicyRule(String(parsed.rule_id ?? ""));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", deleted }));
        } else {
          const rule = this.policyGuard.setPolicyRule({
            ruleId: String(parsed.rule_id),
            targetTool: String(parsed.target_tool ?? "*"),
            riskLevel: parsed.risk_level ?? "safe",
            denyParamRegex: parsed.deny_param_regex ? String(parsed.deny_param_regex) : undefined,
            requireApproval: Boolean(parsed.require_approval),
            waitForApprovalMs: parsed.wait_for_approval_ms ? Number(parsed.wait_for_approval_ms) : undefined,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", rule }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/server-action") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        let srvAction = "studio__server__restart";
        if (parsed.action === "stop") {
          srvAction = "studio__server__stop";
        } else if (parsed.action === "start") {
          srvAction = "studio__server__start";
        } else if (parsed.action === "remove") {
          srvAction = "studio__server__remove";
        }
        const rpcOut = await this.metaTools.executeMetaTool(srvAction, { id: parsed.id });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", result: rpcOut }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/server-upload") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        try {
          const body = await this.readRequestBodyWithLimit(req, res);
          const parsed = JSON.parse(body);
          const result = await this.serverImporter.importServer(parsed);
          res.writeHead(result.status === "ok" ? 200 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err: any) {
          if (err?.message === "PAYLOAD_TOO_LARGE") return;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", error: err.message || String(err) }));
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/client-action") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        if (parsed.action === "add") {
          const added = this.clientBinder.addCustomClient(parsed.name, parsed.config_path);
          if (parsed.auto_bind && added.configPath && fs.existsSync(added.configPath)) {
            try {
              await this.clientBinder.bindClient(added.clientId, added.configPath);
            } catch (err) {
              console.warn("Auto-bind for new client failed:", err);
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", client: added }));
          return;
        }
        if (parsed.action === "remove") {
          const removed = this.clientBinder.removeCustomClient(parsed.client_id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", removed }));
          return;
        }
        const cliAction = parsed.action === "unbind" ? "studio__client__unbind" : "studio__client__bind";
        const rpcOut = await this.metaTools.executeMetaTool(cliAction, {
          client_id: parsed.client_id,
          manual_path: parsed.manual_path,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", result: rpcOut }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/admin/browse-fs") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        const dirParam = url.searchParams.get("dir");
        let targetDir = dirParam ? path.resolve(dirParam) : os.homedir();
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          targetDir = os.homedir();
        }
        const parentDir = path.dirname(targetDir) !== targetDir ? path.dirname(targetDir) : null;
        const drives = "CDEFGHIJKLMNOPQRSTUVWXYZ"
          .split("")
          .map((d) => d + ":\\")
          .filter((d) => fs.existsSync(d));

        const home = os.homedir();
        const candidateQuick = [
          { name: "🏠 用户主目录", path: home },
          { name: "Cursor 配置", path: path.join(home, ".cursor") },
          { name: "WorkBuddy 配置", path: path.join(home, ".workbuddy-ai") },
          { name: "Codex 配置", path: path.join(home, ".codex") },
          { name: "Antigravity 配置", path: path.join(home, ".gemini", "antigravity") },
          { name: "Gemini Config", path: path.join(home, ".gemini", "config") },
          { name: "Claude 配置", path: path.join(home, "AppData", "Roaming", "Claude") },
          { name: "Trae 配置", path: path.join(home, ".trae") },
        ];
        const quickPaths = candidateQuick.filter((q) => fs.existsSync(q.path));

        const entries: Array<{
          name: string;
          isDirectory: boolean;
          isMcpConfig: boolean;
          path: string;
        }> = [];

        try {
          const dirents = fs.readdirSync(targetDir, { withFileTypes: true });
          for (const d of dirents) {
            if (d.name === "$RECYCLE.BIN" || d.name === "System Volume Information") continue;
            const fullPath = path.join(targetDir, d.name);
            const isDir = d.isDirectory();
            const lower = d.name.toLowerCase();
            const isMcpConfig =
              !isDir &&
              (lower === "mcp.json" ||
                lower === "config.toml" ||
                lower.includes("mcp_config") ||
                lower.endsWith(".json") ||
                lower.endsWith(".toml"));
            entries.push({
              name: d.name,
              isDirectory: isDir,
              isMcpConfig,
              path: fullPath,
            });
          }
        } catch {
          // ignore permission errors
        }

        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          if (!a.isDirectory) {
            if (a.isMcpConfig !== b.isMcpConfig) return a.isMcpConfig ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            currentDir: targetDir,
            parentDir,
            drives,
            quickPaths,
            entries,
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/browse-os-dialog") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = body ? JSON.parse(body) : {};
        const mode = parsed.mode || "file";

        const psScript =
          mode === "folder"
            ? `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '请选择 MCP 配置文件所在目录'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }`
            : `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Filter = 'MCP Configuration (*.json;*.toml)|*.json;*.toml|All Files (*.*)|*.*'; $f.Title = '选择 MCP 配置文件'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }`;

        execFile(
          "powershell",
          ["-NoProfile", "-Command", psScript],
          { windowsHide: false },
          (err, stdout) => {
            const selected = (stdout || "").trim();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", path: selected || null }));
          }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/tool-invoke") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
          const parsed = JSON.parse(body);
          const toolArgs = typeof parsed.arguments === "object" && parsed.arguments !== null ? parsed.arguments : {};
          const rpcOut = await this.metaTools.executeMetaTool(
            "studio__tool__invoke",
            {
              server_id: String(parsed.server_id ?? ""),
              tool_name: String(parsed.tool_name ?? ""),
              arguments: toolArgs,
            },
            null,
            null,
            "WebConsole"
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", result: rpcOut }));
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", error: err.message || String(err) }));
        }
        return;
      }

      // 1c. Telemetry Metrics Endpoint (`GET /metrics`)
      if (req.method === "GET" && url.pathname === "/metrics") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            overview: this.telemetryMetrics.getSystemOverview(),
            summaries: this.telemetryMetrics.getAllSummaries(),
          })
        );
        return;
      }

      // 1d. Circuit Breaker Health Endpoint (`GET /health/circuits`)
      if (req.method === "GET" && url.pathname === "/health/circuits") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.healthWatchdog.getHealthSummary()));
        return;
      }

      // 1e. Vault Protected Credential Endpoints (`POST /vault/set`, `GET /vault/keys`)
      if (req.method === "POST" && url.pathname === "/vault/set") {
        const providedSecret = String(req.headers["x-workbench-admin-secret"] ?? "");
        const authHeader = String(req.headers["authorization"] ?? "");
        if (!this.safeCompare(providedSecret, this.adminSecret) && !this.safeCompare(authHeader, `Bearer ${this.token}`)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or Token" }));
          return;
        }
        try {
          const body = await this.readRequestBodyWithLimit(req, res);
          const parsed = JSON.parse(body);
          if (!parsed.key || typeof parsed.key !== "string" || !parsed.value || typeof parsed.value !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid payload: 'key' and 'value' strings required." }));
            return;
          }
          this.secretVault.setSecret(parsed.key, parsed.value, parsed.description);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "stored", key: parsed.key, reference: `vault://${parsed.key}` }));
        } catch (err: any) {
          if (err?.message === "PAYLOAD_TOO_LARGE") return;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Failed to set secret: ${err.message}` }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/vault/keys") {
        const authHeader = String(req.headers["authorization"] ?? "");
        if (!this.isAuthorizedAdmin(req) && !this.safeCompare(authHeader, `Bearer ${this.token}`)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or Token" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(this.secretVault.listSecretsMetadata()));
        return;
      }

      // 2. Out-of-Band Human/GUI Admin Approval Endpoint (`POST /admin/approve`)
      if (req.method === "POST" && url.pathname === "/admin/approve") {
        if (!this.isAuthorizedAdmin(req)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or unauthorized origin" }));
          return;
        }
        try {
          const body = await this.readRequestBodyWithLimit(req, res);
          const parsed = JSON.parse(body);
          const token = String(parsed.approval_token ?? "");
          const action = String(parsed.action ?? "approve").toLowerCase();
          if (action === "reject") {
            const rejected = this.policyGuard.rejectPendingTokenWithAdminSecret(
              token,
              this.adminSecret,
              parsed.reason ? String(parsed.reason) : undefined
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ rejected, approvalToken: token }));
            return;
          }
          const approved = this.policyGuard.approvePendingTokenWithAdminSecret(
            token,
            this.adminSecret
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ approved, approvalToken: token }));
        } catch (err: any) {
          if (err?.message === "PAYLOAD_TOO_LARGE") return;
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
        return;
      }

      // 2b. Out-of-Band Admin Restart Endpoint (`POST /admin/restart`)
      if (req.method === "POST" && url.pathname === "/admin/restart") {
        const authHeader = String(req.headers["authorization"] ?? "");
        if (!this.isAuthorizedAdmin(req) && !this.safeCompare(authHeader, `Bearer ${this.token}`)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: Invalid Admin Secret or Token" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ restarting: true, pid: process.pid }));
        setTimeout(async () => {
          await this.stop();
          process.exit(0);
        }, 100);
        return;
      }

      // Graceful browser redirect: if a human opens `/mcp` directly in a browser
      const acceptHeader = String(req.headers["accept"] ?? "");
      if (req.method === "GET" && url.pathname === "/mcp" && acceptHeader.includes("text/html")) {
        res.writeHead(302, { Location: "/ui" });
        res.end();
        return;
      }

      // Verify Bearer token for `/mcp` and `/bridge/*`
      const authHeader = req.headers["authorization"] ?? "";
      if (!this.safeCompare(authHeader, `Bearer ${this.token}`)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "Unauthorized: Invalid Daemon Bearer Token" })
        );
        return;
      }

      // 3. Host Software Reverse IPC Bridge Endpoints (`/bridge/register`, `/bridge/stream`, `/bridge/callback`)
      if (req.method === "POST" && url.pathname === "/bridge/register") {
        try {
          const body = await this.readRequestBodyWithLimit(req, res);
          const reg = JSON.parse(body);
          const tools = this.softwareBridge.registerPlugin(reg);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "bridge_registered",
              bridgeId: reg.bridgeId,
              toolCount: tools.length,
            })
          );
        } catch (err: any) {
          if (err?.message === "PAYLOAD_TOO_LARGE") return;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid bridge registration: ${err.message}` }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/bridge/stream") {
        const bridgeId = String(url.searchParams.get("bridge_id") ?? "");
        this.softwareBridge.attachCommandStream(bridgeId, req, res);
        return;
      }

      if (req.method === "POST" && url.pathname === "/bridge/callback") {
        try {
          const body = await this.readRequestBodyWithLimit(req, res);
          const cb = JSON.parse(body);
          const ok = this.softwareBridge.submitBridgeCallback(
            String(cb.bridgeId),
            String(cb.callId),
            cb.result,
            cb.error
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok }));
        } catch (err: any) {
          if (err?.message === "PAYLOAD_TOO_LARGE") return;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid bridge callback: ${err.message}` }));
        }
        return;
      }

      // Attribute session by PPID and resolve client name for ContextProfileRouter
      const callerPpid = Number(req.headers["x-mcp-client-ppid"] ?? 0);
      let callerClientName: string | null = req.headers["x-mcp-client-name"]
        ? String(req.headers["x-mcp-client-name"])
        : null;
      if (callerPpid > 0) {
        this.connectedClientPids.add(callerPpid);
        const session = this.clientBinder.attributeSessionByPpid(callerPpid);
        if (!callerClientName && session) {
          callerClientName = session.clientName;
        }
      }

      // 4. Streamable HTTP MCP Notification Stream (`GET /mcp`)
      if (req.method === "GET" && url.pathname === "/mcp") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        this.sseClients.add(res);
        res.on("error", () => {
          this.sseClients.delete(res);
        });
        req.on("close", () => {
          this.sseClients.delete(res);
        });
        return;
      }

      // 5. Streamable HTTP MCP Request Endpoint (`POST /mcp`)
      if (req.method === "POST" && url.pathname === "/mcp") {
        let body: string;
        try {
          body = await this.readRequestBodyWithLimit(req, res);
        } catch (err: any) {
          if (err?.message === "PAYLOAD_TOO_LARGE") return;
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Failed to read request: ${err.message}` }));
          return;
        }
        try {
          const rpcReq = JSON.parse(body) as JsonRpcRequest;
          const callerCwd = req.headers["x-mcp-client-cwd"]
            ? String(req.headers["x-mcp-client-cwd"])
            : null;
          const rpcResp = await this.gatewayCore.handleJsonRpcRequest(rpcReq, {
            callerPpid: callerPpid > 0 ? callerPpid : null,
            callerCwd,
            callerClientName,
          });
          const sessionId =
            (req.headers["mcp-session-id"] as string) ??
            `sess_${crypto.randomBytes(8).toString("hex")}`;

          if (!rpcResp) {
            res.writeHead(202, { "Mcp-Session-Id": sessionId });
            res.end();
            return;
          }

          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
          });
          res.end(JSON.stringify(rpcResp));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: `Parse error: ${String(err)}` },
            })
          );
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.port, this.host, () => resolve());
      });
    } catch (listenErr: any) {
      if (listenErr && listenErr.code === "EADDRINUSE") {
        // Attempt to auto-heal: check if an orphaned workbench daemon is squatting on the port
        const zombiePid = await new Promise<number | null>((res) => {
          const req = http.request(
            { hostname: this.host, port: this.port, path: "/health", method: "GET", timeout: 1500 },
            (resp) => {
              let body = "";
              resp.on("data", (chunk: Buffer) => { body += chunk.toString("utf-8"); });
              resp.on("end", () => {
                try {
                  const data = JSON.parse(body);
                  if (data && typeof data.pid === "number") {
                    res(data.pid);
                    return;
                  }
                } catch {}
                res(null);
              });
            }
          );
          req.on("error", () => res(null));
          req.on("timeout", () => { req.destroy(); res(null); });
          req.end();
        });

        if (zombiePid !== null && zombiePid !== process.pid) {
          try {
            if (process.platform === "win32") {
              execSync(`taskkill /F /T /PID ${zombiePid}`, { stdio: "ignore" });
            } else {
              process.kill(zombiePid, "SIGKILL");
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 500));
          await new Promise<void>((resolve, reject) => {
            this.server!.once("error", reject);
            this.server!.listen(this.port, this.host, () => resolve());
          });
        } else {
          throw listenErr;
        }
      } else {
        throw listenErr;
      }
    }

    await this.acquireSingleInstanceLock();
    await this.aggregator.reconcileAll();
    this.healthWatchdog.startWatchdog();

    fs.watchFile(this.configPath, { interval: 250 }, () => {
      if (this.registry.reloadDesiredConfigFromDisk()) {
        void this.aggregator.reconcileAll();
      }
    });

    return JSON.parse(fs.readFileSync(this.lockPath, "utf-8")) as DaemonLockInfo;
  }

  public async stop(): Promise<void> {
    if (this.lockCheckTimer) {
      clearInterval(this.lockCheckTimer);
      this.lockCheckTimer = null;
    }
    this.healthWatchdog.stopWatchdog();
    fs.unwatchFile(this.configPath);
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();
    await this.processPool.stopAll();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
    if (fs.existsSync(this.lockPath)) {
      try {
        const lock = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        if (lock.pid === process.pid) {
          fs.unlinkSync(this.lockPath);
        }
      } catch {
        // ignore
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = process.env.MCP_WORKBENCH_ROOT ?? process.cwd();
  const port = Number(process.env.MCP_WORKBENCH_PORT ?? 43110);
  const daemon = new WorkbenchDaemon(rootDir, port);
  daemon
    .start()
    .then((lock) => {
      console.log(
        `[mcp-workbenchd v0.3.0] Listening on http://${lock.host}:${lock.port}/mcp (PID=${lock.pid})`
      );
    })
    .catch((err) => {
      console.error(`[mcp-workbenchd] Failed to start: ${err.message}`);
      process.exit(1);
    });

  const shutdown = () => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    console.error("[mcp-workbenchd] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[mcp-workbenchd] Unhandled rejection:", reason);
  });
}
