import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";
import { type JsonSchema } from "./types.js";
export interface SandboxToolSpec {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    /**
     * JavaScript async function body receiving `args` and returning a string or JSON-serializable value.
     * Example: `return String(Number(args.x) * Number(args.x));`
     */
    handlerBodyJs: string;
}
export interface SandboxSelfTestCase {
    toolName: string;
    arguments: Record<string, unknown>;
    expectedSubstring: string;
}
/**
 * Module 5 (v0.0.5): Agent Tool Hot-Generator & Self-Testing Sandbox (`BuilderSandbox`).
 * Allows an Agent to synthesize a brand-new MCP Server with custom JavaScript tool handlers,
 * automatically runs mandatory self-tests in an isolated trial process before touching the live Gateway,
 * and hot-mounts the verified server into `WorkbenchRegistry` and `McpAggregator`.
 */
export declare class BuilderSandbox {
    private readonly registry;
    private readonly aggregator;
    private readonly sandboxDir;
    constructor(registry: WorkbenchRegistry, aggregator: McpAggregator, rootDir: string);
    private generateMcpServerSource;
    /**
     * Spawns the generated script in an isolated trial child process and verifies all `testCases`
     * before mounting into the live Gateway.
     */
    private runIsolatedSelfTests;
    buildVerifyAndMountServer(serverId: string, tools: SandboxToolSpec[], testCases: SandboxSelfTestCase[]): Promise<Record<string, any>>;
}
