import fs from "node:fs";
import path from "node:path";
import { assertSafeIdentifier } from "./types.js";
/**
 * Module 2 (v0.3.0 Production Hardened): Multi-Dimensional Context Profile Router (`ContextProfileRouter`).
 * Features:
 * 1. Atomic disk persistence in `.workbench-profiles.json` so custom Profiles survive Daemon restarts.
 * 2. Full CRUD lifecycle (`upsertProfile`, `deleteProfile`, `listProfiles`).
 * 3. Enforces strict isolation across `tools/list`, `resources/list`, `prompts/list`, `studio__tool__search`, and `tools/call`.
 * 4. Windows path normalization (case-insensitive and forward/back-slash agnostic).
 */
export class ContextProfileRouter {
    registry;
    storagePath;
    profiles = new Map();
    cwdBindings = new Map();
    activeDefaultProfile = "default";
    constructor(registry, rootDir) {
        this.registry = registry;
        this.storagePath = path.join(path.resolve(rootDir ?? process.cwd()), ".workbench-profiles.json");
        this.profiles.set("default", {
            profileId: "default",
            description: "Default global profile exposing all high-frequency tools",
            allowedServers: ["*"],
        });
        this.loadFromDisk();
    }
    loadFromDisk() {
        if (!fs.existsSync(this.storagePath))
            return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.storagePath, "utf-8"));
            if (raw.activeDefaultProfile) {
                this.activeDefaultProfile = raw.activeDefaultProfile;
            }
            for (const rule of raw.profiles ?? []) {
                this.profiles.set(rule.profileId, rule);
                if (rule.matchWorkspaceSubstr) {
                    this.cwdBindings.set(rule.matchWorkspaceSubstr, rule.profileId);
                }
            }
        }
        catch {
            // ignore corrupt file
        }
    }
    saveToDisk() {
        const tmpPath = `${this.storagePath}.tmp.${process.pid}`;
        const payload = {
            version: "0.3.0",
            activeDefaultProfile: this.activeDefaultProfile,
            profiles: Array.from(this.profiles.values()),
        };
        fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
        fs.renameSync(tmpPath, this.storagePath);
    }
    upsertProfile(rule) {
        assertSafeIdentifier(rule.profileId, "profileId");
        this.profiles.set(rule.profileId, rule);
        this.rebuildCwdBindings();
        this.saveToDisk();
        return rule;
    }
    deleteProfile(profileId) {
        if (profileId === "default") {
            throw new Error("Cannot delete built-in 'default' profile.");
        }
        const deleted = this.profiles.delete(profileId);
        if (deleted) {
            this.rebuildCwdBindings();
            this.saveToDisk();
        }
        return deleted;
    }
    rebuildCwdBindings() {
        this.cwdBindings.clear();
        for (const rule of this.profiles.values()) {
            if (rule.matchWorkspaceSubstr) {
                this.cwdBindings.set(rule.matchWorkspaceSubstr, rule.profileId);
            }
        }
    }
    listProfiles() {
        return Array.from(this.profiles.values());
    }
    resolveProfileForContext(callerCwd, callerClientName) {
        if (callerCwd) {
            const normCwd = callerCwd.replace(/\\/g, "/").toLowerCase();
            for (const [substr, profId] of this.cwdBindings.entries()) {
                const normSubstr = substr.replace(/\\/g, "/").toLowerCase();
                if (normCwd.includes(normSubstr) && this.profiles.has(profId)) {
                    return this.profiles.get(profId);
                }
            }
        }
        if (callerClientName) {
            for (const rule of this.profiles.values()) {
                if (rule.matchClientKeyword &&
                    callerClientName
                        .toLowerCase()
                        .includes(rule.matchClientKeyword.toLowerCase())) {
                    return rule;
                }
            }
        }
        return (this.profiles.get(this.activeDefaultProfile) ??
            this.profiles.get("default"));
    }
    isServerAllowedForContext(serverId, callerCwd, callerClientName) {
        const profile = this.resolveProfileForContext(callerCwd, callerClientName);
        const allowed = profile.allowedServers.includes("*") ||
            profile.allowedServers.includes(serverId);
        return { allowed, profileId: profile.profileId };
    }
    filterToolsForContext(callerCwd, callerClientName) {
        const profile = this.resolveProfileForContext(callerCwd, callerClientName);
        const allTopLevel = this.registry.getTopLevelExposedTools();
        const allowAll = profile.allowedServers.includes("*");
        const allowedSet = new Set(profile.allowedServers);
        const filtered = allTopLevel.filter((t) => allowAll || allowedSet.has(t.serverId));
        return {
            profileId: profile.profileId,
            tools: filtered,
        };
    }
}
