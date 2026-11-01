import type { DesiredServerConfig } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";
export interface ServerUploadOptions {
    sourceType: "upload_file" | "pull_url" | "local_path" | "json_config";
    serverId?: string;
    fileName?: string;
    fileContentBase64?: string;
    url?: string;
    localPath?: string;
    rawJson?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    autoStart?: boolean;
    autoInstallDeps?: boolean;
}
export interface ServerImportResult {
    status: "ok" | "error";
    serverId: string;
    config: DesiredServerConfig;
    detectedType: string;
    targetDir?: string;
    discoveredTools?: string[];
    warning?: string;
    error?: string;
}
export declare class ServerImporter {
    private readonly rootDir;
    private readonly customServersDir;
    private readonly registry;
    private readonly aggregator;
    constructor(rootDir: string, registry: WorkbenchRegistry, aggregator: McpAggregator);
    importServer(options: ServerUploadOptions): Promise<ServerImportResult>;
    private inferRuntimeFromDir;
    private inferRuntimeFromFile;
    private parseJsonConfig;
}
