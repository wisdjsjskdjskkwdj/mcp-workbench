import type { DaemonLockInfo } from "./types.js";
export declare class TuiConsole {
    private readonly rootDir;
    private readonly lockPath;
    private lockInfo;
    constructor(rootDir: string);
    private isDaemonAlive;
    private checkHealth;
    ensureDaemonConnected(): Promise<DaemonLockInfo>;
    private adminGet;
    private adminPost;
    /**
     * Renders the Claude-Code-style rounded box-drawing status banner and dashboard.
     */
    renderDashboardBanner(): Promise<string>;
    /**
     * Executes a single Claude-Code-style slash command and returns the formatted terminal output.
     */
    executeSlashCommand(rawInput: string): Promise<string>;
    startInteractiveRepl(): Promise<void>;
}
