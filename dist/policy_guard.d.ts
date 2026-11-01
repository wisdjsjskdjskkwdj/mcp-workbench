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
    decision: "allowed" | "blocked_regex" | "blocked_approval_required" | "approved_token" | "approved_live_hold" | "rejected_by_admin" | "blocked_profile" | "blocked_admin_rejected" | "execution_error";
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
export declare class PolicyGuard {
    private readonly adminSecret;
    private readonly storagePath;
    private readonly rules;
    private readonly pendingApprovals;
    private readonly approvedTokens;
    private readonly rejectedTokens;
    private readonly approvalWaiters;
    private readonly auditLog;
    private readonly auditStoragePath;
    private readonly retentionDays;
    private nextAuditSeq;
    private auditSaveTimer?;
    secretVault?: SecretVault;
    constructor(adminSecret: string, secretVault?: SecretVault, rootDir?: string);
    private loadAuditFromDisk;
    flushAuditToDisk(): void;
    private scheduleAuditSave;
    getAuditRetentionDays(): number;
    private loadFromDisk;
    private saveToDisk;
    setPolicyRule(rule: PolicyRule): PolicyRule;
    deletePolicyRule(ruleId: string): boolean;
    listPolicyRules(): PolicyRule[];
    listPendingApprovals(): PendingApprovalRecord[];
    getAdminSecret(): string;
    /**
     * Out-of-Band Human/GUI Approval: requires valid `adminSecret` so an unprivileged Agent
     * cannot call an MCP tool to self-approve its own destructive operations.
     */
    approvePendingTokenWithAdminSecret(approvalToken: string, providedAdminSecret: string): boolean;
    /**
     * Out-of-Band Human/GUI Rejection: allows an admin to actively reject/dismiss a pending approval request.
     */
    rejectPendingTokenWithAdminSecret(approvalToken: string, providedAdminSecret: string, reason?: string): boolean;
    getAuditLogs(limit?: number): AuditLogEntry[];
    verifyCallPermission(serverId: string, originalName: string, exposedName: string, args: Record<string, unknown>, callerPpid?: number | null, callerCwd?: string | null): Promise<Record<string, string>>;
    private sweepExpiredApprovals;
    recordAudit(entry: Record<string, any>): AuditLogEntry;
}
