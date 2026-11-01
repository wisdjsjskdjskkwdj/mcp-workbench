import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { assertSafeIdentifier } from "./types.js";
/**
 * Resilient JSONC (JSON with Comments and Trailing Commas) Parser.
 * Safely parses human-edited configuration files from Cursor, VS Code, Windsurf, etc.
 */
export function parseLooseJson(raw) {
    const strippedComments = raw.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m));
    const strippedCommas = strippedComments.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(strippedCommas);
}
/**
 * Engine 0 (v0.0.3): Client Discovery, Safe Surgical Config Binder & Post-Bind Session Tracker.
 * Resolves the 3 Client-Binder conflicts:
 * 1. Separates Pre-Bind Discovery Funnel (L1~L4) from Post-Bind Session Attribution (`ppid`).
 * 2. Protects against Write-Back Overwrite Race on `exit_overwrite` clients when they are currently running.
 * 3. Prevents Takeover Blackout by enabling and reconciling runnable imported MCP servers immediately.
 */
export class ClientAutoBinder {
    registry;
    aggregator;
    rootDir;
    shimScriptPath;
    bindingsStoragePath;
    customAdaptersStoragePath;
    adapters = new Map();
    bindings = new Map();
    activeSessionsByPpid = new Map();
    constructor(registry, rootDir, aggregator) {
        this.registry = registry;
        this.rootDir = path.resolve(rootDir);
        this.aggregator = aggregator;
        this.shimScriptPath = path.join(this.rootDir, "dist", "stdio_shim.js");
        this.bindingsStoragePath = path.join(this.rootDir, ".workbench-clients.json");
        this.customAdaptersStoragePath = path.join(this.rootDir, ".workbench-custom-adapters.json");
        this.registerBuiltinAdapters();
        this.loadPersistedCustomAdapters();
        this.loadPersistedBindings();
    }
    loadPersistedCustomAdapters() {
        if (!fs.existsSync(this.customAdaptersStoragePath))
            return;
        try {
            const saved = JSON.parse(fs.readFileSync(this.customAdaptersStoragePath, "utf-8"));
            for (const recipe of saved) {
                if (recipe && recipe.clientId) {
                    recipe.isCustom = true;
                    this.adapters.set(recipe.clientId, recipe);
                }
            }
        }
        catch {
            // ignore
        }
    }
    savePersistedCustomAdapters() {
        try {
            const customList = [];
            for (const a of this.adapters.values()) {
                if (a.isCustom) {
                    customList.push(a);
                }
            }
            const tmp = `${this.customAdaptersStoragePath}.tmp.${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(customList, null, 2), "utf-8");
            fs.renameSync(tmp, this.customAdaptersStoragePath);
        }
        catch {
            // ignore
        }
    }
    addCustomClient(name, configPath) {
        let displayName = (name || "").trim();
        if (!displayName) {
            displayName = crypto.randomBytes(4).toString("hex");
        }
        const cleanId = `custom_${displayName.toLowerCase().replace(/[^a-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || crypto.randomBytes(4).toString("hex")}`;
        let resolvedPath = (configPath || "").trim();
        if (resolvedPath) {
            resolvedPath = path.resolve(resolvedPath);
            if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
                resolvedPath = path.join(resolvedPath, "mcp.json");
            }
        }
        else {
            resolvedPath = null;
        }
        const adapter = {
            clientId: cleanId,
            displayName,
            processKeywords: [cleanId, displayName],
            defaultConfigCandidates: resolvedPath ? [resolvedPath] : [],
            defaultInstallDirs: resolvedPath ? [path.dirname(resolvedPath)] : [],
            configFormat: resolvedPath && resolvedPath.toLowerCase().endsWith(".toml") ? "toml_mcp_servers" : "json_mcpServers",
            reloadBehavior: "hot_watch",
            portableConfigRelPath: resolvedPath ? path.basename(resolvedPath) : "mcp.json",
            isCustom: true,
        };
        this.adapters.set(cleanId, adapter);
        this.savePersistedCustomAdapters();
        this.scanClients();
        return this.bindings.get(cleanId);
    }
    removeCustomClient(clientId) {
        const adapter = this.adapters.get(clientId);
        if (!adapter || !adapter.isCustom)
            return false;
        try {
            this.unbindClient(clientId);
        }
        catch { }
        this.adapters.delete(clientId);
        this.bindings.delete(clientId);
        this.savePersistedCustomAdapters();
        this.savePersistedBindings();
        return true;
    }
    loadPersistedBindings() {
        if (!fs.existsSync(this.bindingsStoragePath))
            return;
        try {
            const saved = JSON.parse(fs.readFileSync(this.bindingsStoragePath, "utf-8"));
            for (const item of saved) {
                if (item && item.clientId) {
                    this.bindings.set(item.clientId, item);
                }
            }
        }
        catch {
            // ignore
        }
    }
    savePersistedBindings() {
        const tmp = `${this.bindingsStoragePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(Array.from(this.bindings.values()), null, 2), "utf-8");
        fs.renameSync(tmp, this.bindingsStoragePath);
    }
    /**
     * Surgical TOML Merger for `toml_mcp_servers` clients (such as OpenAI Codex `~/.codex/config.toml`).
     * Preserves all non-MCP TOML sections (e.g. `model = "o3"`, `[features]`), extracts existing
     * `[mcp_servers.<id>]` blocks into `WorkbenchRegistry`, and injects `[mcp_servers.mcp_workbench]`.
     */
    mergeTomlConfig(rawToml, mode, shouldAutoStart) {
        const importedServers = [];
        const lines = rawToml.split(/\r?\n/);
        const keptLines = [];
        let currentSection = "";
        let currentMcpServerName = null;
        const extractedServers = new Map();
        for (const line of lines) {
            const secMatch = line.trim().match(/^\[([^\]]+)\]$/);
            if (secMatch) {
                currentSection = secMatch[1].trim();
                const mcpMatch = currentSection.match(/^mcp_servers\.([a-zA-Z0-9_-]+)$/);
                if (mcpMatch) {
                    currentMcpServerName = mcpMatch[1];
                    if (currentMcpServerName !== "mcp_workbench") {
                        extractedServers.set(currentMcpServerName, {});
                    }
                    if (mode === "side_by_side" && currentMcpServerName !== "mcp_workbench") {
                        keptLines.push(line);
                    }
                    continue;
                }
                else {
                    currentMcpServerName = null;
                }
            }
            if (currentMcpServerName) {
                if (currentMcpServerName !== "mcp_workbench") {
                    const entry = extractedServers.get(currentMcpServerName);
                    const cmdMatch = line.match(/^\s*command\s*=\s*"([^"]+)"/);
                    if (cmdMatch)
                        entry.command = cmdMatch[1];
                    const argsMatch = line.match(/^\s*args\s*=\s*\[(.*)\]/);
                    if (argsMatch) {
                        entry.args = argsMatch[1]
                            .split(",")
                            .map((s) => s.trim().replace(/^["']|["']$/g, ""))
                            .filter(Boolean);
                    }
                    if (mode === "side_by_side") {
                        keptLines.push(line);
                    }
                }
                continue;
            }
            keptLines.push(line);
        }
        for (const [srvName, srvDef] of extractedServers.entries()) {
            if (!srvDef.command)
                continue;
            if (!this.registry.getDesiredServer(srvName)) {
                this.registry.upsertDesiredServer({
                    id: srvName,
                    serverType: "stdio_process",
                    command: srvDef.command,
                    args: srvDef.args ?? [],
                    env: {},
                    enabled: shouldAutoStart,
                    autoRestart: true,
                });
            }
            importedServers.push(srvName);
        }
        const escapedShim = this.shimScriptPath.replace(/\\/g, "/");
        const escapedRoot = this.rootDir.replace(/\\/g, "/");
        const nodeBin = (process.execPath || "node").replace(/\\/g, "/");
        const workbenchTomlBlock = [
            "",
            "[mcp_servers.mcp_workbench]",
            `command = "${nodeBin}"`,
            `args = ["${escapedShim}"]`,
            `env = { MCP_WORKBENCH_ROOT = "${escapedRoot}" }`,
            "",
        ].join("\n");
        const cleanedBase = keptLines.join("\n").trimEnd();
        return {
            updatedToml: (cleanedBase ? cleanedBase + "\n" : "") + workbenchTomlBlock,
            importedServers,
        };
    }
    registerBuiltinAdapters() {
        const home = os.homedir();
        const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
        const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
        const builtins = [
            {
                clientId: "codex",
                displayName: "OpenAI Codex CLI",
                processKeywords: ["codex", "codex.exe"],
                defaultConfigCandidates: [path.join(home, ".codex", "config.toml")],
                defaultInstallDirs: [path.join(localAppData, "Programs", "codex")],
                configFormat: "toml_mcp_servers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "config.toml",
            },
            {
                clientId: "claude-code",
                displayName: "Claude Code CLI",
                processKeywords: ["claude-code", "claude"],
                defaultConfigCandidates: [path.join(home, ".claude.json")],
                defaultInstallDirs: [path.join(localAppData, "Programs", "claude-code")],
                configFormat: "json_mcpServers",
                reloadBehavior: "exit_overwrite",
                portableConfigRelPath: ".claude.json",
            },
            {
                clientId: "antigravity",
                displayName: "Google Antigravity",
                processKeywords: ["Antigravity.exe", "antigravity", "agy.exe", "agy"],
                defaultConfigCandidates: [
                    path.join(home, ".gemini", "antigravity", "mcp_config.json"),
                    path.join(home, ".gemini", "config", "mcp_config.json"),
                ],
                defaultInstallDirs: [
                    path.join(localAppData, "Programs", "antigravity"),
                    "/Applications/Antigravity.app",
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "mcp_config.json",
            },
            {
                clientId: "workbuddy",
                displayName: "WorkBuddy AI",
                processKeywords: ["WorkBuddyAI.exe", "WorkBuddyAI", "workbuddy", "codebuddy"],
                defaultConfigCandidates: [
                    path.join(home, ".workbuddy-ai", "mcp.json"),
                    path.join(home, ".codebuddy", "mcp.json"),
                ],
                defaultInstallDirs: [
                    "D:\\workbuddy\\WorkBuddyAI",
                    path.join(localAppData, "Programs", "WorkBuddyAI"),
                    path.join(localAppData, "Programs", "WorkBuddy"),
                    path.join(localAppData, "Programs", "CodeBuddy"),
                    path.join(home, ".workbuddy-ai"),
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "mcp.json",
            },
            {
                clientId: "cursor",
                displayName: "Cursor IDE",
                processKeywords: ["cursor", "Cursor.exe"],
                defaultConfigCandidates: [path.join(home, ".cursor", "mcp.json")],
                defaultInstallDirs: [
                    path.join(localAppData, "Programs", "cursor"),
                    "/Applications/Cursor.app",
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "mcp.json",
            },
            {
                clientId: "vscode-cline",
                displayName: "VS Code (Cline)",
                processKeywords: ["Code.exe", "code"],
                defaultConfigCandidates: [
                    path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
                ],
                defaultInstallDirs: [
                    path.join(localAppData, "Programs", "Microsoft VS Code"),
                    "/Applications/Visual Studio Code.app",
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "cline_mcp_settings.json",
            },
            {
                clientId: "vscode-roo",
                displayName: "VS Code (Roo Code)",
                processKeywords: ["Code.exe", "code"],
                defaultConfigCandidates: [
                    path.join(appData, "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
                ],
                defaultInstallDirs: [
                    path.join(localAppData, "Programs", "Microsoft VS Code"),
                    "/Applications/Visual Studio Code.app",
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "cline_mcp_settings.json",
            },
            {
                clientId: "trae",
                displayName: "Trae IDE",
                processKeywords: ["Trae.exe", "trae"],
                defaultConfigCandidates: [path.join(home, ".trae", "mcp.json")],
                defaultInstallDirs: [
                    path.join(localAppData, "Programs", "Trae"),
                    "/Applications/Trae.app",
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "mcp.json",
            },
            {
                clientId: "continue",
                displayName: "Continue.dev",
                processKeywords: ["continue"],
                defaultConfigCandidates: [path.join(home, ".continue", "config.json")],
                defaultInstallDirs: [],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "config.json",
            },
            {
                clientId: "claude-desktop",
                displayName: "Claude Desktop",
                processKeywords: ["Claude.exe", "Claude"],
                defaultConfigCandidates: [
                    path.join(appData, "Claude", "claude_desktop_config.json"),
                    path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
                ],
                defaultInstallDirs: [
                    path.join(localAppData, "AnthropicClaude"),
                    "/Applications/Claude.app",
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "claude_desktop_config.json",
            },
            {
                clientId: "windsurf",
                displayName: "Windsurf IDE",
                processKeywords: ["windsurf", "Windsurf.exe"],
                defaultConfigCandidates: [
                    path.join(home, ".codeium", "windsurf", "mcp_config.json"),
                ],
                defaultInstallDirs: [
                    path.join(localAppData, "Programs", "windsurf"),
                    "/Applications/Windsurf.app",
                ],
                configFormat: "json_mcpServers",
                reloadBehavior: "hot_watch",
                portableConfigRelPath: "mcp_config.json",
            },
        ];
        for (const adapter of builtins) {
            this.adapters.set(adapter.clientId, adapter);
        }
    }
    registerCustomAdapter(recipe) {
        this.adapters.set(recipe.clientId, recipe);
    }
    inspectRunningProcesses() {
        const results = [];
        if (process.platform === "win32") {
            try {
                const raw = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress"', {
                    encoding: "utf-8",
                    stdio: ["ignore", "pipe", "ignore"],
                    windowsHide: true,
                    maxBuffer: 16 * 1024 * 1024,
                    timeout: 8000,
                });
                const parsed = JSON.parse(raw);
                const list = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of list) {
                    if (!item)
                        continue;
                    results.push({
                        pid: Number(item.ProcessId ?? 0),
                        ppid: Number(item.ParentProcessId ?? 0),
                        command: String(item.Name ?? ""),
                        args: String(item.CommandLine ?? ""),
                        executablePath: item.ExecutablePath ? String(item.ExecutablePath) : null,
                        cwd: null,
                    });
                }
                return results;
            }
            catch {
                return results;
            }
        }
        try {
            const out = execSync("ps -eo pid,ppid,comm,args", {
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "ignore"],
            });
            for (const line of out.split("\n").slice(1)) {
                const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
                if (m) {
                    results.push({
                        pid: Number(m[1]),
                        ppid: Number(m[2]),
                        command: m[3],
                        args: m[4],
                        executablePath: null,
                        cwd: null,
                    });
                }
            }
        }
        catch {
            // ignore
        }
        return results;
    }
    resolveConfigFromProcess(adapter, proc) {
        const directConfigMatch = proc.args.match(/--(?:mcp-config|config)=["']?([^"'\s]+)["']?/);
        if (directConfigMatch) {
            const cfgPath = path.resolve(proc.cwd ?? this.rootDir, directConfigMatch[1]);
            return {
                installPath: proc.executablePath ?? proc.cwd,
                configPath: cfgPath,
            };
        }
        const dataDirMatch = proc.args.match(/--(?:user-data-dir|config-dir|data-dir)=["']?([^"'\s]+)["']?/);
        if (dataDirMatch) {
            const baseDir = path.resolve(proc.cwd ?? this.rootDir, dataDirMatch[1]);
            return {
                installPath: proc.executablePath ?? baseDir,
                configPath: path.join(baseDir, adapter.portableConfigRelPath),
            };
        }
        const scriptPathMatch = proc.args.match(/(\S+\.(?:js|mjs|exe|app))/i);
        const installBase = scriptPathMatch
            ? path.dirname(path.resolve(proc.cwd ?? this.rootDir, scriptPathMatch[1]))
            : proc.executablePath
                ? path.dirname(proc.executablePath)
                : proc.cwd;
        if (installBase) {
            const portableCandidate = path.join(installBase, adapter.portableConfigRelPath);
            if (fs.existsSync(portableCandidate)) {
                return {
                    installPath: installBase,
                    configPath: portableCandidate,
                };
            }
        }
        return null;
    }
    /**
     * Executes the 4-Layer Pre-Bind Discovery Funnel (L1 Standard -> L2 Pre-provision -> L3 Runtime Process -> L4 Manual).
     */
    scanClients() {
        const runningProcs = this.inspectRunningProcesses();
        const results = [];
        for (const adapter of this.adapters.values()) {
            const existing = this.bindings.get(adapter.clientId);
            if (existing && existing.status === "bound") {
                existing.isCustom = adapter.isCustom || false;
                results.push(existing);
                continue;
            }
            let foundConfigPath = null;
            let foundInstallPath = null;
            let layer = "NONE";
            let detectedPid = null;
            // Check if process is currently running (used for both L3 discovery and write-back safety check)
            for (const proc of runningProcs) {
                const hay = `${proc.command} ${proc.args}`;
                const isMatched = adapter.processKeywords.some((kw) => {
                    const lowerKw = kw.toLowerCase();
                    const lowerCmd = proc.command.toLowerCase();
                    if (lowerCmd === lowerKw || (lowerCmd.endsWith(".exe") && lowerCmd.slice(0, -4) === lowerKw)) {
                        return true;
                    }
                    // If running via node/python/cmd/powershell: check script target
                    if (lowerCmd.startsWith("node") || lowerCmd.startsWith("python") || lowerCmd === "cmd.exe" || lowerCmd === "powershell.exe") {
                        const scriptTokenMatch = proc.args.match(/(?:^|\s)(?:["']?)([^"'\s]+?\.(?:js|mjs|ts|py|ps1|sh|cmd|bat))(?:["']?)(?:\s|$)/i);
                        if (scriptTokenMatch) {
                            const scriptName = path.basename(scriptTokenMatch[1]).toLowerCase();
                            if (scriptName.includes(lowerKw)) {
                                return true;
                            }
                        }
                    }
                    return false;
                });
                if (isMatched) {
                    const isDirectExe = adapter.processKeywords.some((kw) => proc.command.toLowerCase() === kw.toLowerCase());
                    if (!detectedPid || isDirectExe) {
                        detectedPid = proc.pid;
                        foundInstallPath = proc.executablePath ? path.dirname(proc.executablePath) : proc.cwd;
                        const derived = this.resolveConfigFromProcess(adapter, proc);
                        if (derived && derived.configPath) {
                            if (fs.existsSync(derived.configPath)) {
                                foundInstallPath = derived.installPath;
                                foundConfigPath = derived.configPath;
                                layer = "L3_RUNTIME_PROCESS";
                            }
                        }
                    }
                }
            }
            // Layer 1: Standard Config File Paths (if L3 didn't override with a custom flag)
            if (!foundConfigPath) {
                for (const candidate of adapter.defaultConfigCandidates) {
                    if (fs.existsSync(candidate)) {
                        foundConfigPath = candidate;
                        layer = detectedPid !== null ? "L3_RUNTIME_PROCESS" : "L1_STANDARD_PATH";
                        break;
                    }
                }
            }
            // Layer 2: Pre-provisioning for newly installed software or active running process
            if (!foundConfigPath) {
                for (const installDir of adapter.defaultInstallDirs) {
                    if (fs.existsSync(installDir)) {
                        foundInstallPath = installDir;
                        foundConfigPath = adapter.defaultConfigCandidates[0];
                        layer = detectedPid !== null ? "L3_RUNTIME_PROCESS" : "L2_INSTALL_PREPROVISION";
                        break;
                    }
                }
                if (!foundConfigPath && detectedPid !== null && adapter.defaultConfigCandidates.length > 0) {
                    foundConfigPath = adapter.defaultConfigCandidates[0];
                    layer = "L3_RUNTIME_PROCESS";
                }
            }
            let importedServers = [];
            if (foundConfigPath && fs.existsSync(foundConfigPath)) {
                try {
                    const raw = fs.readFileSync(foundConfigPath, "utf-8");
                    const parsed = parseLooseJson(raw);
                    const srvMap = parsed?.mcpServers || parsed?.mcp_servers;
                    if (srvMap && typeof srvMap === "object") {
                        importedServers = Object.keys(srvMap).filter((k) => k !== "mcp-workbench");
                    }
                }
                catch {
                    // ignore unreadable/corrupt files during scan
                }
            }
            const statusRecord = {
                clientId: adapter.clientId,
                displayName: adapter.displayName,
                status: foundConfigPath ? "detected_unbound" : "needs_manual_path",
                discoveryLayer: layer,
                detectedPid,
                reloadBehavior: adapter.reloadBehavior,
                installPath: foundInstallPath,
                configPath: foundConfigPath,
                backupPath: foundConfigPath ? `${foundConfigPath}.workbench.bak` : null,
                importedServers,
                warning: detectedPid && adapter.reloadBehavior === "exit_overwrite"
                    ? `Process (PID=${detectedPid}) is currently running and may overwrite its config on exit. Close it before binding or pass force=true.`
                    : null,
                isCustom: adapter.isCustom || false,
            };
            this.bindings.set(adapter.clientId, statusRecord);
            results.push(statusRecord);
        }
        // Layer 0: Generic MCP Schema Fingerprint Scanner (broad-spectrum discovery)
        const foundPaths = new Set();
        for (const r of results) {
            if (r.configPath)
                foundPaths.add(r.configPath);
        }
        const genericDiscovered = this.sniffGenericMcpConfigs(foundPaths);
        results.push(...genericDiscovered);
        return results;
    }
    /**
     * Fast, targeted filesystem sweep that detects any unknown JSON configs
     * bearing valid `"mcpServers"` JSON schema signatures.
     */
    sniffGenericMcpConfigs(alreadyFoundPaths) {
        const home = os.homedir();
        const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
        const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
        const configDir = path.join(home, ".config");
        const results = [];
        const inspectedPaths = new Set();
        for (const p of alreadyFoundPaths) {
            inspectedPaths.add(path.resolve(p).toLowerCase());
        }
        const isIgnoredDir = (dirName) => {
            const lower = dirName.toLowerCase();
            return (lower === "node_modules" ||
                lower === ".git" ||
                lower === ".venv" ||
                lower === "temp" ||
                lower === "tmp" ||
                lower === "cache" ||
                lower === "logs" ||
                lower === "windows" ||
                lower === "microsoft" ||
                lower.startsWith(".system_generated"));
        };
        const checkCandidateFile = (filePath) => {
            const resolved = path.resolve(filePath).toLowerCase();
            if (inspectedPaths.has(resolved))
                return;
            inspectedPaths.add(resolved);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile() || stat.size < 10 || stat.size > 2 * 1024 * 1024)
                    return;
                if (!filePath.toLowerCase().endsWith(".json"))
                    return;
                const raw = fs.readFileSync(filePath, "utf-8");
                if (!raw.includes('"mcpServers"') && !raw.includes('"mcp_servers"'))
                    return;
                const parsed = parseLooseJson(raw);
                const mcpServers = parsed.mcpServers || parsed.mcp_servers;
                if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
                    const parentDir = path.dirname(filePath);
                    const folderName = path.basename(parentDir).replace(/^[._]/, "");
                    const fileName = path.basename(filePath, ".json").replace(/[^a-zA-Z0-9_-]/g, "_");
                    const idCandidate = `custom-${folderName}-${fileName}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
                    if (!this.adapters.has(idCandidate)) {
                        this.adapters.set(idCandidate, {
                            clientId: idCandidate,
                            displayName: `Custom MCP (${path.basename(parentDir)}/${path.basename(filePath)})`,
                            processKeywords: [folderName],
                            defaultConfigCandidates: [filePath],
                            defaultInstallDirs: [parentDir],
                            configFormat: "json_mcpServers",
                            reloadBehavior: "hot_watch",
                            portableConfigRelPath: path.basename(filePath),
                        });
                    }
                    const serverKeys = Object.keys(mcpServers).filter((s) => s !== "mcp-workbench");
                    const record = {
                        clientId: idCandidate,
                        displayName: `Custom MCP (${path.basename(parentDir)}/${path.basename(filePath)})`,
                        status: "detected_unbound",
                        discoveryLayer: "L0_SCHEMA_FINGERPRINT",
                        detectedPid: null,
                        reloadBehavior: "hot_watch",
                        installPath: parentDir,
                        configPath: filePath,
                        backupPath: `${filePath}.workbench.bak`,
                        importedServers: serverKeys,
                        warning: null,
                    };
                    this.bindings.set(idCandidate, record);
                    results.push(record);
                }
            }
            catch {
                // Ignore unreadable or malformed files
            }
        };
        // 1. Scan user home dot directories (depth <= 2): e.g. ~/.cursor, ~/.gemini, ~/.trae, ~/.workbuddy-ai
        try {
            const homeEntries = fs.readdirSync(home, { withFileTypes: true });
            for (const entry of homeEntries) {
                if (entry.isDirectory() && entry.name.startsWith(".")) {
                    if (isIgnoredDir(entry.name))
                        continue;
                    const subDir = path.join(home, entry.name);
                    try {
                        const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
                        for (const sub of subEntries) {
                            if (sub.isFile() && (sub.name.toLowerCase().includes("mcp") || sub.name.toLowerCase().includes("config"))) {
                                checkCandidateFile(path.join(subDir, sub.name));
                            }
                            else if (sub.isDirectory() && !isIgnoredDir(sub.name)) {
                                const subSubDir = path.join(subDir, sub.name);
                                try {
                                    const deepFiles = fs.readdirSync(subSubDir, { withFileTypes: true });
                                    for (const f of deepFiles) {
                                        if (f.isFile() && (f.name.toLowerCase().includes("mcp") || f.name.toLowerCase().includes("config"))) {
                                            checkCandidateFile(path.join(subSubDir, f.name));
                                        }
                                    }
                                }
                                catch { }
                            }
                        }
                    }
                    catch { }
                }
            }
        }
        catch { }
        // 2. Scan %APPDATA% (depth 1)
        try {
            if (fs.existsSync(appData)) {
                const appEntries = fs.readdirSync(appData, { withFileTypes: true });
                for (const entry of appEntries) {
                    if (entry.isDirectory() && !isIgnoredDir(entry.name)) {
                        const subDir = path.join(appData, entry.name);
                        try {
                            const files = fs.readdirSync(subDir, { withFileTypes: true });
                            for (const f of files) {
                                if (f.isFile() && f.name.toLowerCase().includes("mcp")) {
                                    checkCandidateFile(path.join(subDir, f.name));
                                }
                            }
                        }
                        catch { }
                    }
                }
            }
        }
        catch { }
        return results;
    }
    /**
     * Post-Bind Session Attribution: identifies which already-bound host Agent launched `StdioShim` via `process.ppid`.
     */
    attributeSessionByPpid(ppid) {
        if (!ppid || ppid <= 0)
            return null;
        if (this.activeSessionsByPpid.has(ppid)) {
            return this.activeSessionsByPpid.get(ppid);
        }
        const procs = this.inspectRunningProcesses();
        const match = procs.find((p) => p.pid === ppid);
        const clientName = match ? match.command : `pid_${ppid}`;
        const attribution = {
            ppid,
            clientName,
            executablePath: match?.executablePath ?? null,
            resolvedProfile: "default",
            firstSeenAt: new Date().toISOString(),
        };
        this.activeSessionsByPpid.set(ppid, attribution);
        return attribution;
    }
    getActiveSessionAttributions() {
        return Array.from(this.activeSessionsByPpid.values());
    }
    /**
     * Surgically binds a client with Write-Back Race Protection and Zero-Blackout Takeover:
     * - If `adapter.reloadBehavior === "exit_overwrite"` and the process is currently running (`detectedPid !== null`)
     *   and `force` is false, returns status `"staged_wait_exit"` instead of risking a write-back overwrite!
     * - Supports `mode: "exclusive" | "side_by_side"` (default `"exclusive"` with automatic server import & startup).
     */
    async bindClient(clientId, manualPath, options = {}) {
        assertSafeIdentifier(clientId, "clientId");
        let adapter = this.adapters.get(clientId);
        if (!adapter) {
            if (manualPath) {
                const resolvedPath = path.resolve(manualPath);
                const isDir = fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory();
                const cfgPath = isDir ? path.join(resolvedPath, "mcp.json") : resolvedPath;
                adapter = {
                    clientId,
                    displayName: `Custom (${clientId})`,
                    processKeywords: [clientId],
                    defaultConfigCandidates: [cfgPath],
                    defaultInstallDirs: [path.dirname(cfgPath)],
                    configFormat: "json_mcpServers",
                    reloadBehavior: "hot_watch",
                    portableConfigRelPath: path.basename(cfgPath),
                };
                this.adapters.set(clientId, adapter);
            }
            else {
                throw new Error(`Unknown client adapter '${clientId}'. Provide --path=<config_or_dir> to bind manually.`);
            }
        }
        this.scanClients();
        const current = this.bindings.get(clientId);
        let targetConfigPath = current.configPath;
        let discoveryLayer = current.discoveryLayer;
        let installPath = current.installPath;
        // Layer 4: Manual Path Resolution
        if (manualPath) {
            const resolvedManual = path.resolve(manualPath);
            if (resolvedManual.endsWith(".json") ||
                resolvedManual.endsWith(".toml")) {
                targetConfigPath = resolvedManual;
                installPath = path.dirname(resolvedManual);
            }
            else if (fs.existsSync(resolvedManual) &&
                fs.statSync(resolvedManual).isDirectory()) {
                installPath = resolvedManual;
                targetConfigPath = path.join(resolvedManual, adapter.portableConfigRelPath);
            }
            else {
                installPath = path.dirname(resolvedManual);
                targetConfigPath = path.join(installPath, adapter.portableConfigRelPath);
            }
            discoveryLayer = "L4_MANUAL_PATH";
        }
        if (!targetConfigPath) {
            throw new Error(`Could not automatically locate '${adapter.displayName}'. Start '${adapter.displayName}' (for L3 runtime detection) or provide 'manual_path'.`);
        }
        // Conflict 1 Fix: Write-Back Race Protection for `exit_overwrite` clients
        if (current.detectedPid !== null &&
            adapter.reloadBehavior === "exit_overwrite" &&
            !options.force) {
            const staged = {
                ...current,
                status: "staged_wait_exit",
                discoveryLayer: discoveryLayer,
                installPath,
                configPath: targetConfigPath,
                warning: `Client '${adapter.displayName}' (PID=${current.detectedPid}) overwrites config on exit. Binding is staged; close client or pass force=true.`,
            };
            this.bindings.set(clientId, staged);
            return staged;
        }
        fs.mkdirSync(path.dirname(targetConfigPath), { recursive: true });
        const backupPath = `${targetConfigPath}.workbench.bak`;
        const shouldAutoStart = options.autoStartImported !== false;
        const modeStr = String(options.mode ?? "exclusive");
        let importedServers = [];
        if (adapter.configFormat === "toml_mcp_servers") {
            let rawToml = "";
            if (fs.existsSync(targetConfigPath)) {
                rawToml = fs.readFileSync(targetConfigPath, "utf-8");
                if (!fs.existsSync(backupPath)) {
                    fs.writeFileSync(backupPath, rawToml, "utf-8");
                }
            }
            const merged = this.mergeTomlConfig(rawToml, modeStr, shouldAutoStart);
            importedServers = merged.importedServers;
            const tmpFile = `${targetConfigPath}.tmp.${process.pid}`;
            fs.writeFileSync(tmpFile, merged.updatedToml, "utf-8");
            fs.renameSync(tmpFile, targetConfigPath);
        }
        else {
            let rootObj = {};
            if (fs.existsSync(targetConfigPath)) {
                const rawContent = fs.readFileSync(targetConfigPath, "utf-8");
                if (!fs.existsSync(backupPath)) {
                    fs.writeFileSync(backupPath, rawContent, "utf-8");
                }
                try {
                    rootObj = parseLooseJson(rawContent);
                }
                catch {
                    rootObj = {};
                }
            }
            const existingMcpServers = (rootObj.mcpServers ?? {});
            for (const [srvName, srvDef] of Object.entries(existingMcpServers)) {
                if (srvName === "mcp-workbench" || !srvDef || !srvDef.command)
                    continue;
                if (!this.registry.getDesiredServer(srvName)) {
                    // Conflict 2 Fix: Enable runnable imported servers immediately and reconcile so zero tools go dark!
                    const importedConfig = {
                        id: srvName,
                        command: String(srvDef.command),
                        args: Array.isArray(srvDef.args) ? srvDef.args.map(String) : [],
                        env: srvDef.env ?? {},
                        enabled: shouldAutoStart,
                        autoRestart: true,
                    };
                    this.registry.upsertDesiredServer(importedConfig);
                }
                importedServers.push(srvName);
            }
            const workbenchEntry = {
                command: process.execPath || "node",
                args: [this.shimScriptPath],
                env: {
                    MCP_WORKBENCH_ROOT: this.rootDir,
                },
            };
            if (options.mode === "side_by_side") {
                rootObj.mcpServers = {
                    ...existingMcpServers,
                    "mcp-workbench": workbenchEntry,
                };
            }
            else {
                rootObj.mcpServers = {
                    "mcp-workbench": workbenchEntry,
                };
            }
            const tmpFile = `${targetConfigPath}.tmp.${process.pid}`;
            fs.writeFileSync(tmpFile, JSON.stringify(rootObj, null, 2), "utf-8");
            fs.renameSync(tmpFile, targetConfigPath);
        }
        if (this.aggregator && options.autoStartImported !== false) {
            try {
                await this.aggregator.reconcileAll();
            }
            catch {
                // Non-fatal if an imported legacy server binary is missing; runtime state records the failure
            }
        }
        const updatedStatus = {
            clientId: adapter.clientId,
            displayName: adapter.displayName,
            status: "bound",
            discoveryLayer: discoveryLayer,
            detectedPid: current.detectedPid,
            reloadBehavior: adapter.reloadBehavior,
            installPath,
            configPath: targetConfigPath,
            backupPath,
            importedServers,
            warning: current.detectedPid !== null
                ? `Client is currently running (PID=${current.detectedPid}); reload MCP servers or restart client to apply.`
                : null,
        };
        this.bindings.set(clientId, updatedStatus);
        this.savePersistedBindings();
        return updatedStatus;
    }
    unbindClient(clientId) {
        assertSafeIdentifier(clientId, "clientId");
        if (!this.bindings.has(clientId)) {
            this.scanClients();
        }
        const bound = this.bindings.get(clientId);
        if (!bound || !bound.configPath)
            return false;
        if (bound.backupPath && fs.existsSync(bound.backupPath)) {
            fs.copyFileSync(bound.backupPath, bound.configPath);
            fs.unlinkSync(bound.backupPath);
        }
        bound.status = "detected_unbound";
        this.savePersistedBindings();
        return true;
    }
}
