import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  assertSafeIdentifier,
  type WorkbenchDesiredConfig,
  type DesiredServerConfig,
  type ActualServerRuntimeState,
  type ToolRecord,
  type ResourceRecord,
  type PromptRecord,
  type JsonSchema,
} from "./types.js";

/**
 * State & Tool Registry with Atomic Persistence.
 * Separates Desired Config State (`workbench.json`), Actual Runtime State, and Stable-ID Tool Registry.
 */
export class WorkbenchRegistry extends EventEmitter {
  private readonly configPath: string;
  private desiredConfig: WorkbenchDesiredConfig;
  private readonly runtimeStates = new Map<string, ActualServerRuntimeState>();
  private readonly toolsById = new Map<string, ToolRecord>();
  private readonly toolIdByExposedName = new Map<string, string>();
  private readonly resourcesByExposedUri = new Map<string, ResourceRecord>();
  private readonly promptsByExposedName = new Map<string, PromptRecord>();
  private lastSavedSha256 = "";

  constructor(configPath: string) {
    super();
    this.configPath = path.resolve(configPath);
    this.desiredConfig = this.loadConfigFromDisk();
    this.initRuntimeStates();
  }

  private computeSha256(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private loadConfigFromDisk(): WorkbenchDesiredConfig {
    const raw = fs.readFileSync(this.configPath, "utf-8");
    this.lastSavedSha256 = this.computeSha256(raw);
    return JSON.parse(raw) as WorkbenchDesiredConfig;
  }

  private initRuntimeStates(): void {
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
  public saveDesiredConfigAtomically(): void {
    const nonce = crypto.randomBytes(4).toString("hex");
    const tmpPath = `${this.configPath}.tmp.${process.pid}.${Date.now()}.${nonce}`;
    const payload = JSON.stringify(this.desiredConfig, null, 2);
    this.lastSavedSha256 = this.computeSha256(payload);
    fs.writeFileSync(tmpPath, payload, { encoding: "utf-8", flag: "w" });
    fs.renameSync(tmpPath, this.configPath);
  }

  public reloadDesiredConfigFromDisk(): boolean {
    try {
      const raw = fs.readFileSync(this.configPath, "utf-8");
      const currentHash = this.computeSha256(raw);
      if (currentHash === this.lastSavedSha256) {
        // Ignore self-triggered file watcher events deterministically
        return false;
      }
      this.lastSavedSha256 = currentHash;
      this.desiredConfig = JSON.parse(raw) as WorkbenchDesiredConfig;
      this.initRuntimeStates();
      return true;
    } catch {
      return false;
    }
  }

  public isWebUiEnabled(): boolean {
    return this.desiredConfig.webUiEnabled !== false;
  }

  public setWebUiEnabled(enabled: boolean): boolean {
    this.desiredConfig.webUiEnabled = enabled;
    this.saveDesiredConfigAtomically();
    return this.isWebUiEnabled();
  }

  public getDesiredServers(): DesiredServerConfig[] {
    return Object.values(this.desiredConfig.servers);
  }

  public getDesiredServer(serverId: string): DesiredServerConfig | undefined {
    return this.desiredConfig.servers[serverId];
  }

  public upsertDesiredServer(config: DesiredServerConfig): void {
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

  public removeDesiredServer(serverId: string): boolean {
    assertSafeIdentifier(serverId, "serverId");
    if (!this.desiredConfig.servers[serverId]) return false;
    delete this.desiredConfig.servers[serverId];
    this.clearServerTools(serverId);
    this.runtimeStates.delete(serverId);
    this.saveDesiredConfigAtomically();
    return true;
  }

  public updateRuntimeState(
    serverId: string,
    patch: Partial<ActualServerRuntimeState>
  ): ActualServerRuntimeState {
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
    const next: ActualServerRuntimeState = { ...existing, ...patch };
    this.runtimeStates.set(serverId, next);
    return next;
  }

  public getRuntimeState(serverId: string): ActualServerRuntimeState | undefined {
    return this.runtimeStates.get(serverId);
  }

  public getAllRuntimeStates(): ActualServerRuntimeState[] {
    return Array.from(this.runtimeStates.values());
  }

  /**
   * Computes a deterministic stable internal tool ID independent of exposed alias formatting.
   */
  public static computeStableToolId(serverId: string, originalName: string): string {
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
  public registerServerTools(
    serverId: string,
    rawTools: Array<{ name: string; description?: string; inputSchema?: JsonSchema }>
  ): ToolRecord[] {
    this.clearServerTools(serverId, false);
    const serverConfig = this.desiredConfig.servers[serverId];
    const highFreqSet = new Set(serverConfig?.highFrequencyTools ?? []);
    const exposeAll = !serverConfig?.highFrequencyTools || serverConfig.highFrequencyTools.length === 0;

    const registered: ToolRecord[] = [];
    for (const raw of rawTools) {
      const toolId = WorkbenchRegistry.computeStableToolId(serverId, raw.name);
      const exposedName = `${serverId}__${raw.name}`;
      const record: ToolRecord = {
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

  public registerServerResources(
    serverId: string,
    rawResources: Array<{
      uri: string;
      name: string;
      description?: string;
      mimeType?: string;
    }>
  ): ResourceRecord[] {
    for (const [uri, rec] of this.resourcesByExposedUri.entries()) {
      if (rec.serverId === serverId) this.resourcesByExposedUri.delete(uri);
    }
    const out: ResourceRecord[] = [];
    for (const r of rawResources) {
      const exposedUri = `mcp-workbench://${serverId}/${r.uri}`;
      const record: ResourceRecord = {
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

  public registerServerPrompts(
    serverId: string,
    rawPrompts: Array<{
      name: string;
      description?: string;
      arguments?: Array<{ name: string; description?: string; required?: boolean }>;
    }>
  ): PromptRecord[] {
    for (const [name, rec] of this.promptsByExposedName.entries()) {
      if (rec.serverId === serverId) this.promptsByExposedName.delete(name);
    }
    const out: PromptRecord[] = [];
    for (const p of rawPrompts) {
      const exposedName = `${serverId}__${p.name}`;
      const record: PromptRecord = {
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

  public getAllResources(): ResourceRecord[] {
    return Array.from(this.resourcesByExposedUri.values());
  }

  public resolveResourceByExposedUri(exposedUri: string): ResourceRecord | undefined {
    return this.resourcesByExposedUri.get(exposedUri);
  }

  public getAllPrompts(): PromptRecord[] {
    return Array.from(this.promptsByExposedName.values());
  }

  public resolvePromptByExposedName(exposedName: string): PromptRecord | undefined {
    return this.promptsByExposedName.get(exposedName);
  }

  public clearServerTools(serverId: string, emitEvent = true): void {
    for (const [u, r] of this.resourcesByExposedUri.entries()) {
      if (r.serverId === serverId) this.resourcesByExposedUri.delete(u);
    }
    for (const [n, p] of this.promptsByExposedName.entries()) {
      if (p.serverId === serverId) this.promptsByExposedName.delete(n);
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

  public getTopLevelExposedTools(): ToolRecord[] {
    return Array.from(this.toolsById.values()).filter(
      (t) => t.enabled && t.exposeTopLevel
    );
  }

  public getAllTools(): ToolRecord[] {
    return Array.from(this.toolsById.values());
  }

  public resolveToolByExposedName(exposedName: string): ToolRecord | undefined {
    const id = this.toolIdByExposedName.get(exposedName);
    return id ? this.toolsById.get(id) : undefined;
  }

  public resolveTool(
    serverId: string,
    originalOrExposedName: string
  ): ToolRecord | undefined {
    const directId = WorkbenchRegistry.computeStableToolId(
      serverId,
      originalOrExposedName
    );
    if (this.toolsById.has(directId)) {
      return this.toolsById.get(directId);
    }
    return this.resolveToolByExposedName(originalOrExposedName);
  }

  public searchTools(query: string, serverFilter?: string): ToolRecord[] {
    const q = query.trim().toLowerCase();
    return Array.from(this.toolsById.values()).filter((t) => {
      if (!t.enabled) return false;
      if (serverFilter && t.serverId !== serverFilter) return false;
      if (!q) return true;
      return (
        t.originalName.toLowerCase().includes(q) ||
        t.exposedName.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.serverId.toLowerCase().includes(q)
      );
    });
  }
}
