import { EventEmitter } from "node:events";
import { type DesiredServerConfig, type ActualServerRuntimeState, type ToolRecord, type ResourceRecord, type PromptRecord, type JsonSchema } from "./types.js";
/**
 * State & Tool Registry with Atomic Persistence.
 * Separates Desired Config State (`workbench.json`), Actual Runtime State, and Stable-ID Tool Registry.
 */
export declare class WorkbenchRegistry extends EventEmitter {
    private readonly configPath;
    private desiredConfig;
    private readonly runtimeStates;
    private readonly toolsById;
    private readonly toolIdByExposedName;
    private readonly resourcesByExposedUri;
    private readonly promptsByExposedName;
    private lastSavedSha256;
    constructor(configPath: string);
    private computeSha256;
    private loadConfigFromDisk;
    private initRuntimeStates;
    /**
     * Atomically writes Desired State to `workbench.json.tmp.<pid>` and renames over `workbench.json`
     * so File Watchers never observe half-written JSON.
     */
    saveDesiredConfigAtomically(): void;
    reloadDesiredConfigFromDisk(): boolean;
    isWebUiEnabled(): boolean;
    setWebUiEnabled(enabled: boolean): boolean;
    getDesiredServers(): DesiredServerConfig[];
    getDesiredServer(serverId: string): DesiredServerConfig | undefined;
    upsertDesiredServer(config: DesiredServerConfig): void;
    removeDesiredServer(serverId: string): boolean;
    updateRuntimeState(serverId: string, patch: Partial<ActualServerRuntimeState>): ActualServerRuntimeState;
    getRuntimeState(serverId: string): ActualServerRuntimeState | undefined;
    getAllRuntimeStates(): ActualServerRuntimeState[];
    /**
     * Computes a deterministic stable internal tool ID independent of exposed alias formatting.
     */
    static computeStableToolId(serverId: string, originalName: string): string;
    /**
     * Replaces the registered tools for a specific server and emits `toolsChanged` if the set changed.
     */
    registerServerTools(serverId: string, rawTools: Array<{
        name: string;
        description?: string;
        inputSchema?: JsonSchema;
    }>): ToolRecord[];
    registerServerResources(serverId: string, rawResources: Array<{
        uri: string;
        name: string;
        description?: string;
        mimeType?: string;
    }>): ResourceRecord[];
    registerServerPrompts(serverId: string, rawPrompts: Array<{
        name: string;
        description?: string;
        arguments?: Array<{
            name: string;
            description?: string;
            required?: boolean;
        }>;
    }>): PromptRecord[];
    getAllResources(): ResourceRecord[];
    resolveResourceByExposedUri(exposedUri: string): ResourceRecord | undefined;
    getAllPrompts(): PromptRecord[];
    resolvePromptByExposedName(exposedName: string): PromptRecord | undefined;
    clearServerTools(serverId: string, emitEvent?: boolean): void;
    getTopLevelExposedTools(): ToolRecord[];
    getAllTools(): ToolRecord[];
    resolveToolByExposedName(exposedName: string): ToolRecord | undefined;
    resolveTool(serverId: string, originalOrExposedName: string): ToolRecord | undefined;
    searchTools(query: string, serverFilter?: string): ToolRecord[];
}
