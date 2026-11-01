import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { assertSafeIdentifier } from "./types.js";
import type { SecretVault } from "./secret_vault.js";

export type RiskLevel = "safe" | "mutating" | "destructive";

export interface PolicyRule {
  ruleId: string;
  targetTool: string;
  riskLevel: RiskLevel;
  denyParamRegex?: string;
  requireApproval?: boolean;
  waitForApprovalMs?: number;
}

export interface PendingApprovalRecord {
  approvalToken: string;
  targetTool: string;
  argsPreview: string;
  createdAt: string;
  approved: boolean;
  rejected?: boolean;
}

export interface AuditLogEntry {
  auditId: string;
  timestamp: string;
  callerPpid: number | null;
  callerCwd: string | null;
  serverId: string;
  toolName: string;
  riskLevel: RiskLevel;
  decision:
    | "allowed"
    | "blocked_regex"
    | "blocked_approval_required"
    | "approved_token"
    | "approved_live_hold"
    | "rejected_by_admin"
    | "blocked_profile"
    | "blocked_admin_rejected"
    | "execution_error";
  reason: string;
  durationMs: number;
  argsPreview: string;
}

/**
 * Module 3 (v0.3.0 Production Hardened): Permission Firewall, Parameter Sandbox Fence,
 * Hold-and-Release Approval Gate & Flight Recorder (`PolicyGuard`).
 * Features:
 * 1. Atomic disk persistence in `.workbench-policies.json` so security rules survive Daemon restarts.
 * 2. Agents CANNOT self-approve destructive tokens without the Daemon's `adminSecret` (or via `POST /admin/approve`).
 * 3. Evaluates ALL matching `denyParamRegex` fences in Pass 1 before checking or consuming any approval token in Pass 2.
 * 4. Dual-mode Human-in-the-Loop approval:
 *    - Synchronous Hold-and-Release (`waitForApprovalMs > 0`): suspends the RPC call in-flight and immediately resumes
 *      when the human clicks Approve in `/ui` or TUI (or throws `APPROVAL_REJECTED` if human clicks Reject).
 *    - Async Token Fallback: issues one-time `approvalToken` when `waitForApprovalMs` is 0 or expires.
 */
export class PolicyGuard {
  private readonly adminSecret: string;
  private readonly storagePath: string;
  private readonly rules = new Map<string, PolicyRule>();
  private readonly pendingApprovals = new Map<string, PendingApprovalRecord>();
  private readonly approvedTokens = new Set<string>();
  private readonly rejectedTokens = new Set<string>();
  private readonly approvalWaiters = new Map<
    string,
    Array<{ resolve: (decision: string) => void }>
  >();
  private readonly auditLog: AuditLogEntry[] = [];
  private readonly auditStoragePath: string;
  private readonly retentionDays: number;
  private nextAuditSeq = 1;
  private auditSaveTimer?: NodeJS.Timeout;
  public secretVault?: SecretVault;

  constructor(
    adminSecret: string,
    secretVault?: SecretVault,
    rootDir?: string
  ) {
    this.adminSecret = adminSecret;
    this.secretVault = secretVault;
    const resolvedRoot = path.resolve(rootDir ?? process.cwd());
    this.storagePath = path.join(resolvedRoot, ".workbench-policies.json");
    this.auditStoragePath = path.join(resolvedRoot, ".workbench-audit-history.json");
    this.retentionDays = Number(process.env.MCP_AUDIT_RETENTION_DAYS) || 7;

    this.loadFromDisk();
    this.loadAuditFromDisk();

    // Ensure flushing to disk on process shutdown
    const flushHandler = () => {
      this.flushAuditToDisk();
    };
    process.once("beforeExit", flushHandler);
    process.once("SIGINT", flushHandler);
    process.once("SIGTERM", flushHandler);
  }

  private loadAuditFromDisk(): void {
    if (!fs.existsSync(this.auditStoragePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.auditStoragePath, "utf-8")) as {
        retentionDays?: number;
        logs?: AuditLogEntry[];
      };
      const cutoffTime = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const validLogs = (raw.logs ?? []).filter((l) => {
        const t = new Date(l.timestamp).getTime();
        return !isNaN(t) && t >= cutoffTime;
      });

      for (const l of validLogs) {
        const m = l.auditId && String(l.auditId).match(/^aud_(\d+)$/);
        if (m) {
          const num = Number(m[1]);
          if (!isNaN(num) && num >= this.nextAuditSeq) {
            this.nextAuditSeq = num + 1;
          }
        }
      }

      const maxLogs = Number(process.env.MCP_MAX_AUDIT_LOGS) || 5000;
      const sliced = validLogs.slice(-maxLogs);
      this.auditLog.push(...sliced);
    } catch {
      // ignore corrupt audit history file
    }
  }

  public flushAuditToDisk(): void {
    if (this.auditSaveTimer) {
      clearTimeout(this.auditSaveTimer);
      this.auditSaveTimer = undefined;
    }
    try {
      const cutoffTime = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      const validLogs = this.auditLog.filter((l) => {
        const t = new Date(l.timestamp).getTime();
        return !isNaN(t) && t >= cutoffTime;
      });
      const maxLogs = Number(process.env.MCP_MAX_AUDIT_LOGS) || 5000;
      const sliced = validLogs.slice(-maxLogs);

      const payload = {
        version: "0.3.0",
        savedAt: new Date().toISOString(),
        retentionDays: this.retentionDays,
        totalCount: sliced.length,
        logs: sliced,
      };

      const tmpPath = `${this.auditStoragePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.auditStoragePath);
    } catch {
      // ignore write errors during shutdown
    }
  }

  private scheduleAuditSave(): void {
    if (this.auditSaveTimer) return;
    this.auditSaveTimer = setTimeout(() => {
      this.auditSaveTimer = undefined;
      this.flushAuditToDisk();
    }, 800);
  }

  public getAuditRetentionDays(): number {
    return this.retentionDays;
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.storagePath, "utf-8")) as {
        rules?: PolicyRule[];
      };
      for (const r of raw.rules ?? []) {
        this.rules.set(r.ruleId, r);
      }
    } catch {
      // ignore corrupt file
    }
  }

  private saveToDisk(): void {
    const tmpPath = `${this.storagePath}.tmp.${process.pid}`;
    const payload = {
      version: "0.3.0",
      rules: Array.from(this.rules.values()),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.storagePath);
  }

  public setPolicyRule(rule: PolicyRule): PolicyRule {
    assertSafeIdentifier(rule.ruleId, "ruleId");
    if (rule.denyParamRegex) {
      if (rule.denyParamRegex.length > 512) {
        throw new Error("UNSAFE_REGEX: denyParamRegex exceeds maximum allowed length of 512 characters.");
      }
      // Check for catastrophic backtracking patterns (nested quantifiers like (a+)+, (.*)*)
      if (/\([^\)]*[\+\*][^\)]*\)[\+\*\{]/.test(rule.denyParamRegex)) {
        throw new Error(
          "UNSAFE_REGEX: Potential ReDoS vulnerability detected (nested quantifiers are prohibited)."
        );
      }
      try {
        new RegExp(rule.denyParamRegex, "i");
      } catch (err: any) {
        throw new Error(`INVALID_REGEX: Invalid regular expression syntax: ${err.message}`);
      }
    }
    this.rules.set(rule.ruleId, rule);
    this.saveToDisk();
    return rule;
  }

  public deletePolicyRule(ruleId: string): boolean {
    const deleted = this.rules.delete(ruleId);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  public listPolicyRules(): PolicyRule[] {
    return Array.from(this.rules.values());
  }

  public listPendingApprovals(): PendingApprovalRecord[] {
    return Array.from(this.pendingApprovals.values());
  }

  public getAdminSecret(): string {
    return this.adminSecret;
  }

  /**
   * Out-of-Band Human/GUI Approval: requires valid `adminSecret` so an unprivileged Agent
   * cannot call an MCP tool to self-approve its own destructive operations.
   */
  public approvePendingTokenWithAdminSecret(
    approvalToken: string,
    providedAdminSecret: string
  ): boolean {
    if (providedAdminSecret !== this.adminSecret) {
      throw new Error(
        "ADMIN_AUTH_FAILED: Destructive tool approval requires the human/GUI Admin Secret via /admin/approve."
      );
    }
    const rec = this.pendingApprovals.get(approvalToken);
    if (!rec) {
      return false;
    }
    rec.approved = true;
    this.approvedTokens.add(approvalToken);

    const waiters = this.approvalWaiters.get(approvalToken) ?? [];
    this.approvalWaiters.delete(approvalToken);
    for (const w of waiters) {
      w.resolve("approved");
    }
    return true;
  }

  /**
   * Out-of-Band Human/GUI Rejection: allows an admin to actively reject/dismiss a pending approval request.
   */
  public rejectPendingTokenWithAdminSecret(
    approvalToken: string,
    providedAdminSecret: string,
    reason = "Operation rejected by administrator"
  ): boolean {
    if (providedAdminSecret !== this.adminSecret) {
      throw new Error(
        "ADMIN_AUTH_FAILED: Destructive tool rejection requires the human/GUI Admin Secret via /admin/approve."
      );
    }
    const rec = this.pendingApprovals.get(approvalToken);
    if (!rec) {
      return false;
    }
    rec.rejected = true;
    this.rejectedTokens.add(approvalToken);
    this.pendingApprovals.delete(approvalToken);
    this.approvedTokens.delete(approvalToken);

    const waiters = this.approvalWaiters.get(approvalToken) ?? [];
    this.approvalWaiters.delete(approvalToken);
    for (const w of waiters) {
      w.resolve("rejected");
    }

    this.recordAudit({
      callerPpid: null,
      callerCwd: null,
      serverId: "policy_guard",
      toolName: rec.targetTool,
      riskLevel: "destructive",
      decision: "blocked_admin_rejected",
      reason: `Approval token '${approvalToken}' rejected: ${reason}`,
      durationMs: 0,
      argsPreview: rec.argsPreview,
    });
    return true;
  }

  public getAuditLogs(limit = 50): AuditLogEntry[] {
    if (limit <= 0) return this.auditLog.slice();
    return this.auditLog.slice(-limit);
  }

  public async verifyCallPermission(
    serverId: string,
    originalName: string,
    exposedName: string,
    args: Record<string, unknown>,
    callerPpid: number | null = null,
    callerCwd: string | null = null
  ): Promise<Record<string, string>> {
    const cleanArgs = { ...args };
    delete cleanArgs.__approval_token;
    const serializedArgs = JSON.stringify(cleanArgs);

    const matchingRules: PolicyRule[] = [];
    for (const rule of this.rules.values()) {
      const matchesTarget =
        rule.targetTool === "*" ||
        rule.targetTool === exposedName ||
        rule.targetTool === `${serverId}.${originalName}`;
      if (matchesTarget) {
        matchingRules.push(rule);
      }
    }

    let highestRisk: RiskLevel = "safe";
    let maxWaitMs = 0;
    for (const rule of matchingRules) {
      if (rule.riskLevel === "destructive") highestRisk = "destructive";
      else if (rule.riskLevel === "mutating" && highestRisk === "safe") {
        highestRisk = "mutating";
      }
      if (rule.waitForApprovalMs && rule.waitForApprovalMs > maxWaitMs) {
        maxWaitMs = rule.waitForApprovalMs;
      }
    }

    // Pass 1: Evaluate ALL parameter regex fences first (never consume approval token if regex fails)
    for (const rule of matchingRules) {
      if (rule.denyParamRegex) {
        let matched = false;
        try {
          const regex = new RegExp(rule.denyParamRegex, "i");
          const testSlice =
            serializedArgs.length > 8192 ? serializedArgs.slice(0, 8192) : serializedArgs;
          matched = regex.test(testSlice);
        } catch {
          matched = false;
        }
        if (matched) {
          this.recordAudit({
            callerPpid,
            callerCwd,
            serverId,
            toolName: exposedName,
            riskLevel: highestRisk,
            decision: "blocked_regex",
            reason: `Blocked by PolicyRule '${rule.ruleId}' (matched forbidden pattern /${rule.denyParamRegex}/i)`,
            durationMs: 0,
            argsPreview: serializedArgs.slice(0, 200),
          });
          throw new Error(
            `POLICY_BLOCKED[${rule.ruleId}]: Tool '${exposedName}' arguments matched forbidden security pattern /${rule.denyParamRegex}/i.`
          );
        }
      }
    }

    // Pass 2: Evaluate Human-in-the-Loop Approval Gate (Supports both Hold-and-Release and Async Token)
    const needsApproval = matchingRules.some(
      (r) => r.requireApproval || r.riskLevel === "destructive"
    );
    if (needsApproval) {
      const providedToken =
        typeof args.__approval_token === "string"
          ? args.__approval_token
          : undefined;

      if (providedToken && this.rejectedTokens.has(providedToken)) {
        this.rejectedTokens.delete(providedToken);
        throw new Error(
          `APPROVAL_REJECTED[${providedToken}]: The administrator explicitly rejected this destructive tool call.`
        );
      }

      if (providedToken && this.approvedTokens.has(providedToken)) {
        this.approvedTokens.delete(providedToken);
        this.pendingApprovals.delete(providedToken);
        delete args.__approval_token;
        return { riskLevel: highestRisk, decision: "approved_token" };
      }

      const approvalToken =
        "approve_" +
        crypto
          .createHash("sha256")
          .update(`${exposedName}::${serializedArgs}`)
          .digest("hex")
          .slice(0, 10);

      this.pendingApprovals.set(approvalToken, {
        approvalToken,
        targetTool: exposedName,
        argsPreview: serializedArgs.slice(0, 200),
        createdAt: new Date().toISOString(),
        approved: false,
        rejected: false,
      });

      // Synchronous Hold-and-Release Mode: wait up to `maxWaitMs` for human click in `/ui` or TUI `/approve`
      if (maxWaitMs > 0) {
        const holdDecision = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            resolve("timeout");
          }, maxWaitMs);

          const list = this.approvalWaiters.get(approvalToken) ?? [];
          list.push({
            resolve: (dec) => {
              clearTimeout(timer);
              resolve(dec);
            },
          });
          this.approvalWaiters.set(approvalToken, list);
        });

        if (holdDecision === "approved") {
          this.approvedTokens.delete(approvalToken);
          this.pendingApprovals.delete(approvalToken);
          delete args.__approval_token;
          return { riskLevel: highestRisk, decision: "approved_live_hold" };
        }

        if (holdDecision === "rejected") {
          this.rejectedTokens.delete(approvalToken);
          this.recordAudit({
            callerPpid,
            callerCwd,
            serverId,
            toolName: exposedName,
            riskLevel: highestRisk,
            decision: "rejected_by_admin",
            reason: `Rejected live by admin (${approvalToken})`,
            durationMs: 0,
            argsPreview: serializedArgs.slice(0, 200),
          });
          throw new Error(
            `APPROVAL_REJECTED[${approvalToken}]: The administrator explicitly rejected this operation.`
          );
        }
      }

      this.recordAudit({
        callerPpid,
        callerCwd,
        serverId,
        toolName: exposedName,
        riskLevel: highestRisk,
        decision: "blocked_approval_required",
        reason: `Destructive tool requires human/GUI approval token '${approvalToken}'`,
        durationMs: 0,
        argsPreview: serializedArgs.slice(0, 200),
      });

      throw new Error(
        `APPROVAL_REQUIRED[${approvalToken}]: Tool '${exposedName}' is marked '${highestRisk}'. A human/admin must approve token '${approvalToken}' via POST /admin/approve before retrying with __approval_token="${approvalToken}".`
      );
    }

    return { riskLevel: highestRisk, decision: "allowed" };
  }

  private sweepExpiredApprovals(ttlMs = 24 * 3600 * 1000): void {
    const now = Date.now();
    for (const [token, rec] of this.pendingApprovals.entries()) {
      if (now - new Date(rec.createdAt).getTime() > ttlMs) {
        this.pendingApprovals.delete(token);
        this.approvedTokens.delete(token);
      }
    }
  }

  public recordAudit(entry: Record<string, any>): AuditLogEntry {
    this.sweepExpiredApprovals();
    const safePreview =
      typeof entry.argsPreview === "string" && this.secretVault
        ? this.secretVault.redactSecrets(entry.argsPreview)
        : entry.argsPreview;
    const auditId = entry.auditId || `aud_${this.nextAuditSeq++}`;
    const full: any = {
      auditId,
      timestamp: new Date().toISOString(),
      ...entry,
      argsPreview: safePreview,
    };
    this.auditLog.push(full);
    const maxAuditLogs = Number(process.env.MCP_MAX_AUDIT_LOGS) || 5000;
    if (this.auditLog.length > maxAuditLogs) {
      this.auditLog.splice(0, this.auditLog.length - maxAuditLogs);
    }
    this.scheduleAuditSave();
    return full;
  }
}
