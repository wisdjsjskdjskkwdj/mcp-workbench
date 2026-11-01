import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import type { DesiredServerConfig, ToolRecord } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { McpAggregator } from "./aggregator.js";

export interface ServerUploadOptions {
  sourceType: "upload_file" | "pull_url" | "local_path" | "json_config";
  serverId?: string;
  // For upload_file:
  fileName?: string;
  fileContentBase64?: string;
  // For pull_url:
  url?: string;
  // For local_path:
  localPath?: string;
  // For json_config:
  rawJson?: string;
  // Manual overrides:
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

export class ServerImporter {
  private readonly rootDir: string;
  private readonly customServersDir: string;
  private readonly registry: WorkbenchRegistry;
  private readonly aggregator: McpAggregator;

  constructor(
    rootDir: string,
    registry: WorkbenchRegistry,
    aggregator: McpAggregator
  ) {
    this.rootDir = path.resolve(rootDir);
    this.customServersDir = path.join(this.rootDir, "custom_servers");
    this.registry = registry;
    this.aggregator = aggregator;

    if (!fs.existsSync(this.customServersDir)) {
      try {
        fs.mkdirSync(this.customServersDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }

  public async importServer(options: ServerUploadOptions): Promise<ServerImportResult> {
    const rawOptions = options as any;
    const sourceType = (rawOptions.sourceType || rawOptions.mode || rawOptions.source_type || "").trim();

    // 1. Determine Server ID
    let serverId = (rawOptions.serverId || rawOptions.id || rawOptions.server_id || "").trim();
    if (!serverId) {
      serverId = "srv_" + crypto.randomBytes(4).toString("hex");
    } else {
      // Sanitize server ID
      serverId = serverId.replace(/[^a-zA-Z0-9_\-]/g, "_").toLowerCase();
    }

    const autoStart = rawOptions.autoStart ?? rawOptions.auto_start ?? true;
    const autoInstallDeps = rawOptions.autoInstallDeps ?? rawOptions.auto_install_deps ?? true;
    const fileName = (rawOptions.fileName || rawOptions.file_name || "server.js").trim();
    const fileContentBase64 = (rawOptions.fileContentBase64 || rawOptions.file_content_base64 || "").trim();
    const localPath = (rawOptions.localPath || rawOptions.local_path || "").trim();
    const rawJson = (rawOptions.rawJson || rawOptions.raw_json || "").trim();
    const targetUrl = (rawOptions.url || rawOptions.pullUrl || "").trim();

    const targetDir = path.join(this.customServersDir, serverId);
    fs.mkdirSync(targetDir, { recursive: true });

    let detectedCommand = "node";
    let detectedArgs: string[] = [];
    let detectedCwd = targetDir;
    let detectedType = "custom";
    let detectedEnv: Record<string, string> = {};

    try {
      if (sourceType === "upload_file") {
        const fileBuf = Buffer.from(fileContentBase64, "base64");

        if (fileName.toLowerCase().endsWith(".zip")) {
          const zipPath = path.join(targetDir, "uploaded.zip");
          fs.writeFileSync(zipPath, fileBuf);

          if (process.platform === "win32") {
            const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force"`;
            execSync(cmd, { timeout: 30000 });
          } else {
            execSync(`unzip -o "${zipPath}" -d "${targetDir}"`, { timeout: 30000 });
          }

          try { fs.unlinkSync(zipPath); } catch {}
          const inferred = this.inferRuntimeFromDir(targetDir);
          detectedCommand = inferred.command;
          detectedArgs = inferred.args;
          detectedCwd = inferred.cwd;
          detectedType = inferred.type;

          if (autoInstallDeps && fs.existsSync(path.join(targetDir, "package.json"))) {
            try {
              execSync("npm install --production", { cwd: targetDir, timeout: 60000 });
            } catch {
              // ignore dep install errors
            }
          }
        } else {
          // Single script file
          const filePath = path.join(targetDir, fileName);
          fs.writeFileSync(filePath, fileBuf);
          const inferred = this.inferRuntimeFromFile(filePath);
          detectedCommand = inferred.command;
          detectedArgs = inferred.args;
          detectedCwd = inferred.cwd;
          detectedType = inferred.type;
        }
      } else if (sourceType === "pull_url") {
        const rawUrl = targetUrl;
        if (!rawUrl) throw new Error("缺少拉取 URL 目标地址");

        const isGit = rawUrl.endsWith(".git") || rawUrl.includes("github.com") || rawUrl.includes("gitlab.com") || rawUrl.includes("gitee.com");
        const isRawScript = rawUrl.endsWith(".js") || rawUrl.endsWith(".mjs") || rawUrl.endsWith(".py") || rawUrl.includes("raw.githubusercontent.com");

        if (isGit && !isRawScript) {
          // Clone git repo
          try {
            execSync(`git clone --depth 1 "${rawUrl}" "${targetDir}"`, { timeout: 60000 });
          } catch (err: any) {
            throw new Error(`Git 克隆失败: ${err.message || String(err)}`);
          }

          const inferred = this.inferRuntimeFromDir(targetDir);
          detectedCommand = inferred.command;
          detectedArgs = inferred.args;
          detectedCwd = inferred.cwd;
          detectedType = inferred.type;

          if (autoInstallDeps && fs.existsSync(path.join(targetDir, "package.json"))) {
            try {
              execSync("npm install --production", { cwd: targetDir, timeout: 60000 });
            } catch {
              // ignore
            }
          }
        } else {
          // Fetch raw file from HTTP/HTTPS
          const res = await fetch(rawUrl);
          if (!res.ok) throw new Error(`HTTP 获取失败: ${res.status} ${res.statusText}`);
          const content = await res.text();
          let scriptFileName = path.basename(new URL(rawUrl).pathname) || "server.js";
          if (!scriptFileName.includes(".")) {
            scriptFileName = content.includes("def ") || content.includes("import ") ? "server.py" : "server.js";
          }
          const filePath = path.join(targetDir, scriptFileName);
          fs.writeFileSync(filePath, content, "utf-8");

          const inferred = this.inferRuntimeFromFile(filePath);
          detectedCommand = inferred.command;
          detectedArgs = inferred.args;
          detectedCwd = inferred.cwd;
          detectedType = inferred.type;
        }
      } else if (sourceType === "local_path") {
        const p = path.resolve(localPath);
        if (!fs.existsSync(p)) throw new Error(`本地路径不存在: ${p}`);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          const inferred = this.inferRuntimeFromDir(p);
          detectedCommand = inferred.command;
          detectedArgs = inferred.args;
          detectedCwd = inferred.cwd;
          detectedType = inferred.type;
        } else {
          const inferred = this.inferRuntimeFromFile(p);
          detectedCommand = inferred.command;
          detectedArgs = inferred.args;
          detectedCwd = inferred.cwd;
          detectedType = inferred.type;
        }
      } else if (sourceType === "json_config") {
        const parsed = this.parseJsonConfig(rawJson || "{}");
        detectedCommand = parsed.command;
        detectedArgs = parsed.args;
        detectedEnv = parsed.env;
        if (parsed.cwd) detectedCwd = parsed.cwd;
        detectedType = "json_spec";
      }

      // 4. Apply manual user overrides if present
      const finalCommand = (rawOptions.command || "").trim() || detectedCommand;
      const finalArgs = Array.isArray(rawOptions.args) && rawOptions.args.length > 0
        ? rawOptions.args.map(String)
        : detectedArgs;
      const finalEnv = { ...detectedEnv, ...(rawOptions.env || {}) };
      const finalCwd = (rawOptions.cwd || "").trim() || detectedCwd;

      // 5. Construct and Save Desired Server Config
      const newConfig: DesiredServerConfig = {
        id: serverId,
        serverType: "stdio_process",
        command: finalCommand,
        args: finalArgs,
        env: finalEnv,
        cwd: finalCwd,
        enabled: true,
        autoRestart: true,
      };

      this.registry.upsertDesiredServer(newConfig);

      // 6. Mount & Discover tools if autoStart is true
      let discoveredTools: string[] = [];
      let warning: string | undefined;

      if (autoStart) {
        try {
          const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("服务握手响应超时（5秒），后台仍可能在初始化")), 5000)
          );
          const tools: ToolRecord[] = await Promise.race([
            this.aggregator.connectAndDiscoverServer(newConfig),
            timeoutPromise,
          ]);
          discoveredTools = tools.map((t) => t.exposedName);
        } catch (err: any) {
          warning = `服务已成功保存登记，但启动握手暂未就绪 (${err.message || String(err)})。您可在矩阵中检查命令与依赖后点击重启。`;
        }
      }

      return {
        status: "ok",
        serverId,
        config: newConfig,
        detectedType,
        targetDir,
        discoveredTools,
        warning,
      };
    } catch (err: any) {
      return {
        status: "error",
        serverId,
        config: {
          id: serverId,
          command: detectedCommand,
          args: detectedArgs,
          enabled: false,
        },
        detectedType,
        error: err.message || String(err),
      };
    }
  }

  private inferRuntimeFromDir(dirPath: string): { command: string; args: string[]; cwd: string; type: string } {
    const pkgPath = path.join(dirPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const main = pkg.main || pkg.module;
        if (main && fs.existsSync(path.join(dirPath, main))) {
          return { command: "node", args: [path.join(dirPath, main)], cwd: dirPath, type: "node_package" };
        }
        if (pkg.bin) {
          const binFile = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0];
          if (binFile && fs.existsSync(path.join(dirPath, String(binFile)))) {
            return { command: "node", args: [path.join(dirPath, String(binFile))], cwd: dirPath, type: "node_package" };
          }
        }
      } catch {
        // ignore
      }
    }

    // Common standard entry points
    const candidatesNode = ["index.js", "dist/index.js", "build/index.js", "server.js", "index.mjs", "main.js"];
    for (const c of candidatesNode) {
      const full = path.join(dirPath, c);
      if (fs.existsSync(full)) {
        return { command: "node", args: [full], cwd: dirPath, type: "node_script" };
      }
    }

    const candidatesPy = ["server.py", "main.py", "app.py", "index.py", "run.py"];
    for (const c of candidatesPy) {
      const full = path.join(dirPath, c);
      if (fs.existsSync(full)) {
        return { command: "python", args: [full], cwd: dirPath, type: "python_script" };
      }
    }

    // Default fallback to node
    return { command: "node", args: [path.join(dirPath, "index.js")], cwd: dirPath, type: "generic" };
  }

  private inferRuntimeFromFile(filePath: string): { command: string; args: string[]; cwd: string; type: string } {
    const ext = path.extname(filePath).toLowerCase();
    const dir = path.dirname(filePath);

    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      return { command: "node", args: [filePath], cwd: dir, type: "node_script" };
    }
    if (ext === ".py") {
      return { command: "python", args: [filePath], cwd: dir, type: "python_script" };
    }
    if (ext === ".bat" || ext === ".cmd" || ext === ".exe") {
      return { command: filePath, args: [], cwd: dir, type: "executable" };
    }
    if (ext === ".sh") {
      return { command: "bash", args: [filePath], cwd: dir, type: "shell_script" };
    }

    return { command: "node", args: [filePath], cwd: dir, type: "unknown" };
  }

  private parseJsonConfig(rawJson: string): { command: string; args: string[]; env: Record<string, string>; cwd?: string } {
    let obj: any = {};
    try {
      obj = JSON.parse(rawJson);
    } catch {
      throw new Error("配置内容不是合法的 JSON 格式");
    }

    // Check if wrapped in mcpServers (Claude/Cursor standard format)
    if (obj.mcpServers && typeof obj.mcpServers === "object") {
      const firstKey = Object.keys(obj.mcpServers)[0];
      if (firstKey && typeof obj.mcpServers[firstKey] === "object") {
        obj = obj.mcpServers[firstKey];
      }
    }

    const command = String(obj.command || "node").trim();
    const args = Array.isArray(obj.args) ? obj.args.map(String) : [];
    const env = typeof obj.env === "object" && obj.env !== null ? obj.env : {};
    const cwd = obj.cwd ? String(obj.cwd) : undefined;

    return { command, args, env, cwd };
  }
}
