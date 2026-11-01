import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { assertSafeIdentifier, } from "./types.js";
/**
 * State & Tool Registry with Atomic Persistence.
 * Separates Desired Config State (`workbench.json`), Actual Runtime State, and Stable-ID Tool Registry.
 */
export class WorkbenchRegistry extends EventEmitter {
    configPath;
    desiredConfig;
    runtimeStates = new Map();
    toolsById = new Map();
    toolIdByExposedName = new Map();
    resourcesByExposedUri = new Map();
    promptsByExposedName = new Map();
    lastSavedSha256 = "";
    constructor(configPath) {
        super();
        this.configPath = path.resolve(configPath);
        this.desiredConfig = this.loadConfigFromDisk();
        this.initRuntimeStates();
    }
    computeSha256(content) {
        return crypto.createHash("sha256").update(content).digest("hex");
    }
    loadConfigFromDisk() {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        this.lastSavedSha256 = this.computeSha256(raw);
        return JSON.parse(raw);
    }
    initRuntimeStates() {
        for (const serverId of Object.keys(this.desiredConfig.servers)) {
            const cfg = this.desiredConfig.servers[serverId];
            if (!this.runtimeStates.has(serverId)) {
                this.runtimeStates.set(serverId, {
                    serverId,
                    serverType: cfg?.serverType ?? "stdio_process",
                    phase: "stopped",
                    pid: null,
                    startedAt: null,
                    restartCount: 0,
                    lastExitCode: null,
                    lastError: null,
                    protocolVersion: null,
                    recentStderr: [],
                });
            }
        }
    }
    /**
     * Atomically writes Desired State to `workbench.json.tmp.<pid>` and renames over `workbench.json`
     * so File Watchers never observe half-written JSON.
     */
    saveDesiredConfigAtomically() {
        const nonce = crypto.randomBytes(4).toString("hex");
        const tmpPath = `${this.configPath}.tmp.${process.pid}.${Date.now()}.${nonce}`;
        const payload = JSON.stringify(this.desiredConfig, null, 2);
        this.lastSavedSha256 = this.computeSha256(payload);
        fs.writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "w" });
        fs.renameSync(tmpPath, this.configPath);
    }
    reloadDesiredConfigFromDisk() {
        try {
            const raw = fs.readFileSync(this.configPath, "utf-8");
            const currentHash = this.computeSha256(raw);
            if (currentHash === this.lastSavedSha256) {
                // Ignore self-triggered file watcher events deterministically
                return false;
            }
            this.lastSavedSha256 = currentHash;
            this.desiredConfig = JSON.parse(raw);
            this.initRuntimeStates();
            return true;
        }
        catch {
            return false;
        }
    }
    isWebUiEnabled() {
        return this.desiredConfig.webUiEnabled !== false;
    }
    setWebUiEnabled(enabled) {
        this.desiredConfig.webUiEnabled = enabled;
        this.saveDesiredConfigAtomically();
        return this.isWebUiEnabled();
    }
    getDesiredServers() {
        return Object.values(this.desiredConfig.servers);
    }
    getDesiredServer(serverId) {
        return this.desiredConfig.servers[serverId];
    }
    upsertDesiredServer(config) {
        assertSafeIdentifier(config.id, "serverId");
        this.desiredConfig.servers[config.id] = config;
        if (!this.runtimeStates.has(config.id)) {
            this.runtimeStates.set(config.id, {
                serverId: config.id,
                serverType: config.serverType ?? "stdio_process",
                phase: "stopped",
                pid: null,
                startedAt: null,
                restartCount: 0,
                lastExitCode: null,
                lastError: null,
                protocolVersion: null,
                recentStderr: [],
            });
        }
        this.saveDesiredConfigAtomically();
    }
    removeDesiredServer(serverId) {
        assertSafeIdentifier(serverId, "serverId");
        if (!this.desiredConfig.servers[serverId])
            return false;
        delete this.desiredConfig.servers[serverId];
        this.clearServerTools(serverId);
        this.runtimeStates.delete(serverId);
        this.saveDesiredConfigAtomically();
        return true;
    }
    updateRuntimeState(serverId, patch) {
        const cfg = this.desiredConfig.servers[serverId];
        const existing = this.runtimeStates.get(serverId) ?? {
            serverId,
            serverType: cfg?.serverType ?? "stdio_process",
            phase: "stopped",
            pid: null,
            startedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastError: null,
            protocolVersion: null,
            recentStderr: [],
        };
        const next = { ...existing, ...patch };
        this.runtimeStates.set(serverId, next);
        return next;
    }
    getRuntimeState(serverId) {
        return this.runtimeStates.get(serverId);
    }
    getAllRuntimeStates() {
        return Array.from(this.runtimeStates.values());
    }
    /**
     * Computes a deterministic stable internal tool ID independent of exposed alias formatting.
     */
    static computeStableToolId(serverId, originalName) {
        const digest = crypto
            .createHash("sha256")
            .update(`${serverId}::${originalName}`)
            .digest("hex")
            .slice(0, 12);
        return `tool_${digest}`;
    }
    /**
     * Replaces the registered tools for a specific server and emits `toolsChanged` if the set changed.
     */
    registerServerTools(serverId, rawTools) {
        this.clearServerTools(serverId, false);
        const serverConfig = this.desiredConfig.servers[serverId];
        const highFreqSet = new Set(serverConfig?.highFrequencyTools ?? []);
        const exposeAll = !serverConfig?.highFrequencyTools || serverConfig.highFrequencyTools.length === 0;
        const registered = [];
        for (const raw of rawTools) {
            const toolId = WorkbenchRegistry.computeStableToolId(serverId, raw.name);
            const exposedName = `${serverId}__${raw.name}`;
            const record = {
                toolId,
                serverId,
                originalName: raw.name,
                exposedName,
                description: raw.description ?? "",
                inputSchema: raw.inputSchema ?? { type: "object", properties: {} },
                enabled: true,
                exposeTopLevel: exposeAll || highFreqSet.has(raw.name),
            };
            this.toolsById.set(toolId, record);
            this.toolIdByExposedName.set(exposedName, toolId);
            registered.push(record);
        }
        this.emit("toolsChanged", { serverId, count: registered.length });
        return registered;
    }
    registerServerResources(serverId, rawResources) {
        for (const [uri, rec] of this.resourcesByExposedUri.entries()) {
            if (rec.serverId === serverId)
                this.resourcesByExposedUri.delete(uri);
        }
        const out = [];
        for (const r of rawResources) {
            const exposedUri = `mcp-workbench://${serverId}/${r.uri}`;
            const record = {
                serverId,
                originalUri: r.uri,
                exposedUri,
                name: `[${serverId}] ${r.name}`,
                description: r.description,
                mimeType: r.mimeType,
            };
            this.resourcesByExposedUri.set(exposedUri, record);
            out.push(record);
        }
        return out;
    }
    registerServerPrompts(serverId, rawPrompts) {
        for (const [name, rec] of this.promptsByExposedName.entries()) {
            if (rec.serverId === serverId)
                this.promptsByExposedName.delete(name);
        }
        const out = [];
        for (const p of rawPrompts) {
            const exposedName = `${serverId}__${p.name}`;
            const record = {
                serverId,
                originalName: p.name,
                exposedName,
                description: p.description,
                arguments: p.arguments,
            };
            this.promptsByExposedName.set(exposedName, record);
            out.push(record);
        }
        return out;
    }
    getAllResources() {
        return Array.from(this.resourcesByExposedUri.values());
    }
    resolveResourceByExposedUri(exposedUri) {
        return this.resourcesByExposedUri.get(exposedUri);
    }
    getAllPrompts() {
        return Array.from(this.promptsByExposedName.values());
    }
    resolvePromptByExposedName(exposedName) {
        return this.promptsByExposedName.get(exposedName);
    }
    clearServerTools(serverId, emitEvent = true) {
        for (const [u, r] of this.resourcesByExposedUri.entries()) {
            if (r.serverId === serverId)
                this.resourcesByExposedUri.delete(u);
        }
        for (const [n, p] of this.promptsByExposedName.entries()) {
            if (p.serverId === serverId)
                this.promptsByExposedName.delete(n);
        }
        let removed = 0;
        for (const [toolId, record] of this.toolsById.entries()) {
            if (record.serverId === serverId) {
                this.toolsById.delete(toolId);
                this.toolIdByExposedName.delete(record.exposedName);
                removed++;
            }
        }
        if (emitEvent && removed > 0) {
            this.emit("toolsChanged", { serverId, count: 0 });
        }
    }
    getTopLevelExposedTools() {
        return Array.from(this.toolsById.values()).filter((t) => t.enabled && t.exposeTopLevel);
    }
    getAllTools() {
        return Array.from(this.toolsById.values());
    }
    resolveToolByExposedName(exposedName) {
        const id = this.toolIdByExposedName.get(exposedName);
        return id ? this.toolsById.get(id) : undefined;
    }
    resolveTool(serverId, originalOrExposedName) {
        const directId = WorkbenchRegistry.computeStableToolId(serverId, originalOrExposedName);
        if (this.toolsById.has(directId)) {
            return this.toolsById.get(directId);
        }
        return this.resolveToolByExposedName(originalOrExposedName);
    }
    searchTools(query, serverFilter) {
        const q = query.trim().toLowerCase();
        return Array.from(this.toolsById.values()).filter((t) => {
            if (!t.enabled)
                return false;
            if (serverFilter && t.serverId !== serverFilter)
                return false;
            if (!q)
                return true;
            return (t.originalName.toLowerCase().includes(q) ||
                t.exposedName.toLowerCase().includes(q) ||
                t.description.toLowerCase().includes(q) ||
                t.serverId.toLowerCase().includes(q));
        });
    }
}
