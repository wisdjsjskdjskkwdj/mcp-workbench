import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
export class CommandResolver {
  private readonly extraSearchDirs: string[];

  constructor(customSearchDirs: string[] = []) {
    const home = os.homedir();
    const platformDirs =
      process.platform === "win32"
        ? [
            path.join(process.env.APPDATA ?? "", "npm"),
            path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Python"),
            path.join(home, ".local", "bin"),
            path.join(home, ".cargo", "bin"),
            path.join(home, ".bun", "bin"),
          ]
        : [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            path.join(home, ".local", "bin"),
            path.join(home, ".cargo", "bin"),
            path.join(home, ".bun", "bin"),
            path.join(home, ".nvm", "current", "bin"),
            path.join(home, ".volta", "bin"),
          ];

    this.extraSearchDirs = [...customSearchDirs, ...platformDirs].filter(
      (d) => d && d.length > 0
    );
  }

  /**
   * Merges current process environment, server-specific environment overrides,
   * and standard developer tool directories into a unified PATH.
   */
  public buildAugmentedEnv(
    baseEnv: NodeJS.ProcessEnv,
    overrideEnv: Record<string, string> = {}
  ): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries(baseEnv)) {
      if (v !== undefined) merged[k] = v;
    }
    for (const [k, v] of Object.entries(overrideEnv)) {
      if (v !== undefined) merged[k] = v;
    }

    const pathKey =
      Object.keys(merged).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const currentPath = merged[pathKey] ?? "";
    const sep = path.delimiter;
    const segments = currentPath.split(sep).filter(Boolean);
    const seen = new Set(segments);

    for (const dir of this.extraSearchDirs) {
      if (!seen.has(dir) && fs.existsSync(dir)) {
        segments.push(dir);
        seen.add(dir);
      }
    }

    merged[pathKey] = segments.join(sep);
    return merged;
  }

  /**
   * Resolves a bare command name (e.g. `npx`, `uvx`, `node`, `my-tool`) to its exact
   * executable path across the augmented PATH and Windows `PATHEXT`.
   */
  public resolveExecutablePath(
    command: string,
    env: Record<string, string>
  ): string {
    if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
      return command;
    }

    const pathKey =
      Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    const pathDirs = (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);

    const extensions =
      process.platform === "win32"
        ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter(Boolean)
            .map((e) => e.toLowerCase())
        : [""];

    // On Windows, also check exact filename first in case command already has `.exe` or `.cmd`
    const extCandidates =
      process.platform === "win32" && !extensions.includes("")
        ? ["", ...extensions]
        : extensions;

    for (const dir of pathDirs) {
      for (const ext of extCandidates) {
        const candidate = path.join(dir, command + ext);
        if (fs.existsSync(candidate)) {
          try {
            const stat = fs.statSync(candidate);
            if (stat.isFile()) {
              return candidate;
            }
          } catch {
            // ignore inaccessible path
          }
        }
      }
    }

    return command;
  }

  /**
   * Prepares the exact spawn target (`command`, `args`, `env`, `shell`) for `child_process.spawn`.
   */
  public resolveSpawnTarget(
    rawCommand: string,
    rawArgs: string[],
    overrideEnv: Record<string, string> = {}
  ): ResolvedSpawnTarget {
    const env = this.buildAugmentedEnv(process.env, overrideEnv);
    const resolvedCmd = this.resolveExecutablePath(rawCommand, env);
    const lower = resolvedCmd.toLowerCase();
    const isWinBatch =
      process.platform === "win32" &&
      (lower.endsWith(".cmd") || lower.endsWith(".bat"));

    return {
      command: resolvedCmd,
      args: [...rawArgs],
      env,
      shell: isWinBatch,
    };
  }
}
