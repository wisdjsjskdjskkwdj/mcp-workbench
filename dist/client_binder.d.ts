import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";
export interface ClientAdapterRecipe {
    clientId: string;
    displayName: string;
    processKeywords: string[];
    defaultConfigCandidates: string[];
    defaultInstallDirs: string[];
    configFormat: "json_mcpServers" | "toml_mcp_servers";
    /**
     * "hot_watch": Client reloads config safely while running (e.g. Cursor, Windsurf)
     * "exit_overwrite": Client holds config in memory and may overwrite on exit (e.g. Claude Code CLI)
     */
    reloadBehavior: "hot_watch" | "exit_overwrite";
    portableConfigRelPath: string;
    isCustom?: boolean;
}
export interface DiscoveredClientStatus {
    clientId: string;
    displayName: string;
    status: "bound" | "detected_unbound" | "staged_wait_exit" | "needs_manual_path";
    /** Strictly Pre-Bind Discovery Layers (L0 ~ L4) */
    discoveryLayer: "L0_SCHEMA_FINGERPRINT" | "L1_STANDARD_PATH" | "L2_INSTALL_PREPROVISION" | "L3_RUNTIME_PROCESS" | "L4_MANUAL_PATH" | "NONE";
    detectedPid: number | null;
    reloadBehavior: "hot_watch" | "exit_overwrite";
    installPath: string | null;
    configPath: string | null;
    backupPath: string | null;
    importedServers: string[];
    warning: string | null;
    isCustom?: boolean;
}
/**
 * Resilient JSONC (JSON with Comments and Trailing Commas) Parser.
 * Safely parses human-edited configuration files from Cursor, VS Code, Windsurf, etc.
 */
export declare function parseLooseJson<T = any>(raw: string): T;
export interface ConnectedSessionAttribution {
    ppid: number;
    clientName: string;
    executablePath: string | null;
    resolvedProfile: string;
    firstSeenAt: string;
}
export interface RunningProcessInfo {
    pid: number;
    ppid: number;
    command: string;
    args: string;
    executablePath: string | null;
    cwd: string | null;
}
/**
 * Engine 0 (v0.0.3): Client Discovery, Safe Surgical Config Binder & Post-Bind Session Tracker.
 * Resolves the 3 Client-Binder conflicts:
 * 1. Separates Pre-Bind Discovery Funnel (L1~L4) from Post-Bind Session Attribution (`ppid`).
 * 2. Protects against Write-Back Overwrite Race on `exit_overwrite` clients when they are currently running.
 * 3. Prevents Takeover Blackout by enabling and reconciling runnable imported MCP servers immediately.
 */
export declare class ClientAutoBinder {
    private readonly registry;
    private readonly aggregator?;
    private readonly rootDir;
    private readonly shimScriptPath;
    private readonly bindingsStoragePath;
    private readonly customAdaptersStoragePath;
    private readonly adapters;
    private readonly bindings;
    private readonly activeSessionsByPpid;
    constructor(registry: WorkbenchRegistry, rootDir: string, aggregator?: McpAggregator);
    private loadPersistedCustomAdapters;
    private savePersistedCustomAdapters;
    addCustomClient(name?: string, configPath?: string): DiscoveredClientStatus;
    removeCustomClient(clientId: string): boolean;
    private loadPersistedBindings;
    private savePersistedBindings;
    /**
     * Surgical TOML Merger for `toml_mcp_servers` clients (such as OpenAI Codex `~/.codex/config.toml`).
     * Preserves all non-MCP TOML sections (e.g. `model = "o3"`, `[features]`), extracts existing
     * `[mcp_servers.<id>]` blocks into `WorkbenchRegistry`, and injects `[mcp_servers.mcp_workbench]`.
     */
    private mergeTomlConfig;
    private registerBuiltinAdapters;
    registerCustomAdapter(recipe: ClientAdapterRecipe): void;
    inspectRunningProcesses(): RunningProcessInfo[];
    private resolveConfigFromProcess;
    /**
     * Executes the 4-Layer Pre-Bind Discovery Funnel (L1 Standard -> L2 Pre-provision -> L3 Runtime Process -> L4 Manual).
     */
    scanClients(): DiscoveredClientStatus[];
    /**
     * Fast, targeted filesystem sweep that detects any unknown JSON configs
     * bearing valid `"mcpServers"` JSON schema signatures.
     */
    private sniffGenericMcpConfigs;
    /**
     * Post-Bind Session Attribution: identifies which already-bound host Agent launched `StdioShim` via `process.ppid`.
     */
    attributeSessionByPpid(ppid: number): ConnectedSessionAttribution | null;
    getActiveSessionAttributions(): ConnectedSessionAttribution[];
    /**
     * Surgically binds a client with Write-Back Race Protection and Zero-Blackout Takeover:
     * - If `adapter.reloadBehavior === "exit_overwrite"` and the process is currently running (`detectedPid !== null`)
     *   and `force` is false, returns status `"staged_wait_exit"` instead of risking a write-back overwrite!
     * - Supports `mode: "exclusive" | "side_by_side"` (default `"exclusive"` with automatic server import & startup).
     */
    bindClient(clientId: string, manualPath?: string, options?: Record<string, boolean | string | undefined>): Promise<DiscoveredClientStatus>;
    unbindClient(clientId: string): boolean;
}
