/**
 * Lightweight Stdio-to-Daemon Shim v0.0.2 (`mcp-workbench-shim`).
 * Upgraded Capabilities:
 * 1. Auto-Wake Daemon: If `.workbench-daemon.lock.json` is missing or the Daemon PID is not alive,
 *    automatically spawns `daemon.js` in detached background mode and waits until it is healthy.
 * 2. Parent Process Attribution (`process.ppid`): Automatically attaches `X-Mcp-Client-Ppid`
 *    so the Daemon knows which host Agent process launched this Shim.
 */
export declare class StdioShim {
    private readonly rootDir;
    private readonly lockPath;
    private lockInfo;
    private sseReq;
    private closing;
    constructor(rootDir: string);
    private isDaemonAlive;
    /**
     * Ensures the single-instance Core Daemon is running; if not, spawns it silently in background.
     */
    private ensureDaemonRunning;
    private queryOrphanedDaemonPid;
    private checkHealth;
    private stdoutQueue;
    private safeWriteStdout;
    start(): Promise<void>;
    private subscribeNotifications;
    private forwardRequest;
}
