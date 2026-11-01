import type { WorkbenchRegistry } from "./registry.js";
import type { SecretVault } from "./secret_vault.js";
import { type ToolRecord } from "./types.js";
export interface OpenApiSpecDocument {
    openapi?: string;
    info?: {
        title?: string;
        version?: string;
    };
    servers?: Array<{
        url: string;
    }>;
    paths: Record<string, Record<string, any>>;
}
export interface PersistedOpenApiBundle {
    connectorId: string;
    spec: OpenApiSpecDocument;
    options: Record<string, any>;
}
export interface VirtualEndpointBinding {
    connectorId: string;
    toolName: string;
    method: string;
    baseUrl: string;
    pathTemplate: string;
    pathParams: string[];
    queryParams: string[];
    hasJsonBody: boolean;
    auth: Record<string, string | undefined>;
    pickFields?: string[];
    maxResponseChars: number;
}
/**
 * Module 1 (v0.0.5): Zero-Code OpenAPI / REST Virtual MCP Server Engine (`OpenApiConnector`).
 * Fixes v0.0.4 restart conflict by persisting imported OpenAPI specs under `.workbench_openapi/`
 * so virtual servers and their endpoints are automatically restored when `reconcileAll()` runs after a Daemon restart.
 */
export declare class OpenApiConnector {
    private readonly registry;
    private readonly storageDir;
    private readonly endpoints;
    secretVault?: SecretVault;
    constructor(registry: WorkbenchRegistry, rootDir: string);
    private getSpecFilePath;
    importOpenApiSpec(connectorId: string, spec: OpenApiSpecDocument, options?: Record<string, any>, persistToDisk?: boolean): ToolRecord[];
    restorePersistedConnector(connectorId: string): ToolRecord[];
    removeVirtualConnector(connectorId: string): void;
    isVirtualConnector(serverId: string): boolean;
    invokeVirtualEndpoint(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown>;
    private performHttpRequest;
}
