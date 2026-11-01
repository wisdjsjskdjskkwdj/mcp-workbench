export interface ResolvedSpawnTarget {
    command: string;
    args: string[];
    env: Record<string, string>;
    shell: boolean;
}
/**
 * Production Module A (v0.1.0): Cross-Platform Command & PATH Resolver (`CommandResolver`).
 * Solves two ubiquitous desktop MCP failures:
 * 1. macOS/Linux GUI apps launched from Dock/Desktop inherit a minimal PATH (`/usr/bin:/bin`)
 *    missing `npx`, `uvx`, `bun`, `cargo`, `homebrew`, or `nvm` node binaries.
 * 2. Windows `child_process.spawn("npx", ...)` throws `ENOENT` unless resolved via `PATHEXT`
 *    (`npx.cmd` / `uvx.exe`) and wrapped appropriately when invoking `.cmd`/`.bat` batch scripts.
 */
export declare class CommandResolver {
    private readonly extraSearchDirs;
    constructor(customSearchDirs?: string[]);
    /**
     * Merges current process environment, server-specific environment overrides,
     * and standard developer tool directories into a unified PATH.
     */
    buildAugmentedEnv(baseEnv: NodeJS.ProcessEnv, overrideEnv?: Record<string, string>): Record<string, string>;
    /**
     * Resolves a bare command name (e.g. `npx`, `uvx`, `node`, `my-tool`) to its exact
     * executable path across the augmented PATH and Windows `PATHEXT`.
     */
    resolveExecutablePath(command: string, env: Record<string, string>): string;
    /**
     * Prepares the exact spawn target (`command`, `args`, `env`, `shell`) for `child_process.spawn`.
     */
    resolveSpawnTarget(rawCommand: string, rawArgs: string[], overrideEnv?: Record<string, string>): ResolvedSpawnTarget;
}
