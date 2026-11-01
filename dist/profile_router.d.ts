import type { WorkbenchRegistry } from "./registry.js";
export interface ContextProfileRule {
    profileId: string;
    description: string;
    allowedServers: string[];
    matchWorkspaceSubstr?: string;
    matchClientKeyword?: string;
}
/**
 * Module 2 (v0.3.0 Production Hardened): Multi-Dimensional Context Profile Router (`ContextProfileRouter`).
 * Features:
 * 1. Atomic disk persistence in `.workbench-profiles.json` so custom Profiles survive Daemon restarts.
 * 2. Full CRUD lifecycle (`upsertProfile`, `deleteProfile`, `listProfiles`).
 * 3. Enforces strict isolation across `tools/list`, `resources/list`, `prompts/list`, `studio__tool__search`, and `tools/call`.
 * 4. Windows path normalization (case-insensitive and forward/back-slash agnostic).
 */
export declare class ContextProfileRouter {
    private readonly registry;
    private readonly storagePath;
    private readonly profiles;
    private readonly cwdBindings;
    private activeDefaultProfile;
    constructor(registry: WorkbenchRegistry, rootDir?: string);
    private loadFromDisk;
    private saveToDisk;
    upsertProfile(rule: ContextProfileRule): ContextProfileRule;
    deleteProfile(profileId: string): boolean;
    private rebuildCwdBindings;
    listProfiles(): ContextProfileRule[];
    resolveProfileForContext(callerCwd?: string, callerClientName?: string): ContextProfileRule;
    isServerAllowedForContext(serverId: string, callerCwd?: string, callerClientName?: string): Record<string, any>;
    filterToolsForContext(callerCwd?: string, callerClientName?: string): Record<string, any>;
}
