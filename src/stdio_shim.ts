import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import readline from "node:readline";
import { spawn, execSync } from "node:child_process";
import type { DaemonLockInfo, JsonRpcRequest } from "./types.js";

/**
 * Lightweight Stdio-to-Daemon Shim v0.0.2 (`mcp-workbench-shim`).
 * Upgraded Capabilities:
 * 1. Auto-Wake Daemon: If `.workbench-daemon.lock.json` is missing or the Daemon PID is not alive,
 *    automatically spawns `daemon.js` in detached background mode and waits until it is healthy.
 * 2. Parent Process Attribution (`process.ppid`): Automatically attaches `X-Mcp-Client-Ppid`
 *    so the Daemon knows which host Agent process launched this Shim.
 */
export class StdioShim {
  private readonly rootDir: string;
  private readonly lockPath: string;
  private lockInfo: DaemonLockInfo | null = null;
  private sseReq: http.ClientRequest | null = null;
  private closing = false;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.lockPath = path.join(this.rootDir, ".workbench-daemon.lock.json");
  }

  private isDaemonAlive(lock: DaemonLockInfo): boolean {
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensures the single-instance Core Daemon is running; if not, spawns it silently in background.
   */
  private async ensureDaemonRunning(): Promise<DaemonLockInfo> {
    if (fs.existsSync(this.lockPath)) {
      try {
        const existing = JSON.parse(
          fs.readFileSync(this.lockPath, "utf-8")
        ) as DaemonLockInfo;
        if (await this.checkHealth(existing)) {
          return existing;
        }
      } catch {
        // Stale or corrupt lockfile
      }
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // ignore
      }
    }

    // Defensive auto-heal: detect orphaned zombie daemon holding port 43110 without lockfile
    const orphanedPid = await this.queryOrphanedDaemonPid();
    if (orphanedPid !== null) {
      try {
        if (process.platform === "win32") {
          execSync(`taskkill /F /T /PID ${orphanedPid}`, { stdio: "ignore" });
        } else {
          process.kill(orphanedPid, "SIGKILL");
        }
      } catch {
        // ignore
      }
      for (let j = 0; j < 10; j++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          process.kill(orphanedPid, 0);
        } catch {
          break;
        }
      }
    }

    // Spawn daemon.js in detached mode
    const daemonScript = path.join(this.rootDir, "dist", "daemon.js");
    const child = spawn(process.execPath, [daemonScript], {
      cwd: this.rootDir,
      env: {
        ...process.env,
        MCP_WORKBENCH_ROOT: this.rootDir,
        MCP_WORKBENCH_PORT: process.env.MCP_WORKBENCH_PORT ?? "43110",
      },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    // Poll until lockfile is written and /health responds
    for (let i = 0; i < 150; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (fs.existsSync(this.lockPath)) {
        try {
          const lock = JSON.parse(
            fs.readFileSync(this.lockPath, "utf-8")
          ) as DaemonLockInfo;
          if (await this.checkHealth(lock)) {
            return lock;
          }
        } catch {
          // continue polling
        }
      }
    }

    throw new Error("StdioShim timed out waiting for auto-spawned Core Daemon.");
  }

  private queryOrphanedDaemonPid(): Promise<number | null> {
    const targetPort = Number(process.env.MCP_WORKBENCH_PORT ?? 43110);
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: targetPort,
          path: "/health",
          method: "GET",
          timeout: 1500,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf-8");
          });
          res.on("end", () => {
            try {
              const data = JSON.parse(body);
              if (data && typeof data.pid === "number") {
                resolve(data.pid);
                return;
              }
            } catch {
              // ignore
            }
            resolve(null);
          });
        }
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  private checkHealth(lock: DaemonLockInfo): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: lock.host,
          port: lock.port,
          path: "/health",
          method: "GET",
          timeout: 1500,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk.toString("utf-8");
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              // Ensure the daemon is healthy AND the PID matches our lockfile!
              resolve(res.statusCode === 200 && parsed.pid === lock.pid);
            } catch {
              resolve(res.statusCode === 200);
            }
          });
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  private stdoutQueue: Promise<void> = Promise.resolve();

  private safeWriteStdout(payload: string): void {
    const line = payload.trim() + "\n";
    this.stdoutQueue = this.stdoutQueue
      .then(() => {
        return new Promise<void>((resolve) => {
          if (!process.stdout.write(line)) {
            process.stdout.once("drain", resolve);
          } else {
            resolve();
          }
        });
      })
      .catch(() => {});
  }

  public async start(): Promise<void> {
    const pendingLines: string[] = [];
    let ready = false;

    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!ready) {
        pendingLines.push(trimmed);
      } else {
        void this.forwardRequest(trimmed);
      }
    });

    rl.on("close", () => {
      this.closing = true;
      if (this.sseReq) this.sseReq.destroy();
      process.exit(0);
    });

    try {
      this.lockInfo = await this.ensureDaemonRunning();
      this.subscribeNotifications();
      ready = true;
      for (const buffered of pendingLines) {
        await this.forwardRequest(buffered);
      }
      pendingLines.length = 0;
    } catch (err: any) {
      process.stderr.write(`[StdioShim] Failed to start: ${err.message}\n`);
      for (const line of pendingLines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id !== undefined && parsed.id !== null) {
            process.stdout.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: parsed.id,
                error: {
                  code: -32000,
                  message: `StdioShim startup error: ${err.message}`,
                },
              }) + "\n"
            );
          }
        } catch {
          // ignore
        }
      }
      process.exit(1);
    }
  }

  private subscribeNotifications(): void {
    if (!this.lockInfo) return;
    this.sseReq = http.request(
      {
        hostname: this.lockInfo.host,
        port: this.lockInfo.port,
        path: "/mcp",
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.lockInfo.token}`,
          Accept: "text/event-stream",
          "X-Mcp-Client-Ppid": String(process.ppid),
          "X-Mcp-Client-Cwd": process.cwd(),
        },
      },
      (res) => {
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (dataLine) {
              const jsonPayload = dataLine.slice("data: ".length).trim();
              this.safeWriteStdout(jsonPayload);
            }
          }
        });
        res.on("end", () => {
          if (!this.closing) {
            setTimeout(() => {
              if (!this.closing) void this.subscribeNotifications();
            }, 1000);
          }
        });
      }
    );
    this.sseReq.on("error", () => {
      // Ignore disconnect on shutdown
    });
    this.sseReq.end();
  }

  private async forwardRequest(rawJson: string, isRetry = false): Promise<void> {
    if (!this.lockInfo) {
      this.lockInfo = await this.ensureDaemonRunning();
    }
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(rawJson) as JsonRpcRequest;
    } catch {
      return;
    }

    const req = http.request(
      {
        hostname: this.lockInfo.host,
        port: this.lockInfo.port,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.lockInfo.token}`,
          "X-Mcp-Client-Ppid": String(process.ppid),
          "X-Mcp-Client-Cwd": process.cwd(),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if ((res.statusCode === 401 || res.statusCode === 403) && !isRetry) {
            // Self-heal: Daemon restarted with a new token or stale lockfile; refresh and retry once!
            void this.ensureDaemonRunning().then((freshLock) => {
              this.lockInfo = freshLock;
              this.subscribeNotifications();
              void this.forwardRequest(rawJson, true);
            });
            return;
          }
          if (res.statusCode === 200 && body.trim()) {
            this.safeWriteStdout(body);
            return;
          }

          // Resilient Protocol Defense: Prevent AI Client from hanging indefinitely on non-200 responses
          const trimmed = body.trim();
          if (trimmed) {
            try {
              const errPayload = JSON.parse(trimmed);
              if (errPayload && (errPayload.error || errPayload.result)) {
                if (errPayload.id === undefined || errPayload.id === null) {
                  errPayload.id = parsed.id ?? null;
                }
                this.safeWriteStdout(JSON.stringify(errPayload));
                return;
              }
            } catch {
              // Fallthrough if Daemon returned plain text / HTML
            }
          }

          if (parsed.id !== undefined && parsed.id !== null) {
            const fallbackRpcErr = {
              jsonrpc: "2.0",
              id: parsed.id,
              error: {
                code: -32603,
                message: `MCP Gateway returned HTTP ${res.statusCode}: ${trimmed.slice(0, 500) || "No response body"}`,
              },
            };
            this.safeWriteStdout(JSON.stringify(fallbackRpcErr));
          }
        });
      }
    );

    req.on("error", (err) => {
      if (!isRetry) {
        void this.ensureDaemonRunning()
          .then((freshLock) => {
            this.lockInfo = freshLock;
            this.subscribeNotifications();
            void this.forwardRequest(rawJson, true);
          })
          .catch(() => {
            if (parsed.id !== undefined && parsed.id !== null) {
              this.safeWriteStdout(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: parsed.id,
                  error: {
                    code: -32000,
                    message: `StdioShim failed to reach Core Daemon: ${err.message}`,
                  },
                })
              );
            }
          });
        return;
      }
      if (parsed.id !== undefined && parsed.id !== null) {
        this.safeWriteStdout(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: {
              code: -32000,
              message: `StdioShim failed to reach Core Daemon: ${err.message}`,
            },
          })
        );
      }
    });

    req.write(rawJson);
    req.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rootDir = process.env.MCP_WORKBENCH_ROOT ?? process.cwd();
  const shim = new StdioShim(rootDir);
  void shim.start();
}
