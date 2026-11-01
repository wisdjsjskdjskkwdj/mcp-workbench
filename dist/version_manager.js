import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
/**
 * Project Version & Rollback Manager (v0.0.3).
 * Provides Git-backed local atomic snapshotting, history audit, diff inspection,
 * and safe non-destructive rollback with automatic pre-revert safety checkpoints.
 * Hardened: Uses spawnSync with strict array arguments to completely eliminate Command Injection.
 */
export class VersionManager {
    rootDir;
    constructor(rootDir = process.cwd()) {
        this.rootDir = path.resolve(rootDir);
    }
    runGit(args) {
        const res = spawnSync("git", args, {
            cwd: this.rootDir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        if (res.error) {
            throw res.error;
        }
        if (res.status !== 0) {
            throw new Error(res.stderr ? res.stderr.trim() : `Git exited with code ${res.status}`);
        }
        return (res.stdout ?? "").trim();
    }
    /**
     * Checks if Git repository is properly initialized in rootDir.
     */
    isRepositoryInitialized() {
        const gitDir = path.join(this.rootDir, ".git");
        return fs.existsSync(gitDir);
    }
    /**
     * Retrieves workspace status (modified files, untracked files, clean state).
     */
    getStatus() {
        try {
            const branch = this.runGit(["branch", "--show-current"]) || "HEAD";
            const currentCommit = this.runGit(["rev-parse", "--short", "HEAD"]) || "unknown";
            const rawStatus = this.runGit(["status", "--porcelain"]);
            const modifiedFiles = [];
            const untrackedFiles = [];
            if (rawStatus) {
                const lines = rawStatus.split("\n");
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    const statusFlag = trimmed.slice(0, 2);
                    const filePath = trimmed.slice(2).trim();
                    if (statusFlag.includes("?")) {
                        untrackedFiles.push(filePath);
                    }
                    else {
                        modifiedFiles.push(filePath);
                    }
                }
            }
            const totalChanged = modifiedFiles.length + untrackedFiles.length;
            return {
                isClean: totalChanged === 0,
                currentCommit,
                currentBranch: branch,
                modifiedFiles,
                untrackedFiles,
                totalChanged,
            };
        }
        catch {
            return {
                isClean: false,
                currentCommit: "unknown",
                currentBranch: "unknown",
                modifiedFiles: [],
                untrackedFiles: [],
                totalChanged: 0,
            };
        }
    }
    /**
     * Lists project history with commit hashes, tags, authors, timestamps, and commit messages.
     */
    listHistory(limit = 20) {
        try {
            const currentHead = this.runGit(["rev-parse", "HEAD"]);
            const format = "%H%x09%h%x09%an%x09%ad%x09%s%x09%d";
            const raw = this.runGit([
                "log",
                "-n",
                String(limit),
                `--pretty=format:${format}`,
                "--date=format:%Y-%m-%d %H:%M:%S",
            ]);
            if (!raw)
                return [];
            const results = [];
            const lines = raw.split("\n");
            for (const line of lines) {
                const parts = line.split("\t");
                if (parts.length < 5)
                    continue;
                const hash = parts[0].trim();
                const shortHash = parts[1].trim();
                const author = parts[2].trim();
                const date = parts[3].trim();
                const message = parts[4].trim();
                const refNames = parts[5] ? parts[5].trim() : "";
                // Extract tags from refNames (e.g. "(HEAD -> main, tag: v0.0.3-baseline)")
                const tags = [];
                const tagMatches = refNames.matchAll(/tag:\s*([^,\)]+)/g);
                for (const m of tagMatches) {
                    if (m[1])
                        tags.push(m[1].trim());
                }
                results.push({
                    hash,
                    shortHash,
                    tags,
                    author,
                    date,
                    message,
                    isCurrent: hash === currentHead,
                });
            }
            return results;
        }
        catch {
            return [];
        }
    }
    /**
     * Creates an atomic named snapshot / checkpoint with an automatic git tag.
     */
    createSnapshot(name, description = "") {
        const cleanName = name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
        const timestamp = new Date()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace(/\..+/, "")
            .replace("T", "_");
        const tagName = `snapshot-${timestamp}-${cleanName}`;
        // 1. Stage all tracked and untracked files (honoring .gitignore)
        this.runGit(["add", "-A"]);
        // 2. Commit
        const commitMsg = description
            ? `snapshot(${cleanName}): ${description}`
            : `snapshot(${cleanName}): Checkpoint captured at ${new Date().toLocaleString()}`;
        // In case there were no uncommitted changes, allow empty snapshot or commit changes
        try {
            this.runGit(["commit", "-m", commitMsg]);
        }
        catch {
            // Nothing new to commit, create an annotated tag on current HEAD
        }
        const commitHash = this.runGit(["rev-parse", "HEAD"]);
        const shortHash = this.runGit(["rev-parse", "--short", "HEAD"]);
        // 3. Create annotated tag
        this.runGit(["tag", "-a", tagName, "-m", commitMsg]);
        return {
            success: true,
            commitHash,
            shortHash,
            tagName,
            name,
            description,
            timestamp: new Date().toISOString(),
        };
    }
    /**
     * Inspects differences between current workspace and a target commit/tag.
     */
    getDiff(target = "HEAD") {
        try {
            const stat = this.runGit(["diff", target, "--stat"]);
            const diff = this.runGit(["diff", target]);
            return { stat, diff };
        }
        catch (err) {
            return { stat: "", diff: `Error inspecting diff: ${err.message}` };
        }
    }
    /**
     * Safely rolls back the project to a specified commit, tag, or snapshot.
     * Automatically creates a pre-rollback emergency backup tag so work is never lost.
     */
    rollback(target, safetyBackup = true) {
        if (!target || !target.trim()) {
            throw new Error("Target commit hash, tag name, or snapshot name is required for rollback.");
        }
        const cleanTarget = target.trim();
        // 1. Verify target exists
        let resolvedCommit = "";
        try {
            resolvedCommit = this.runGit(["rev-parse", "--verify", `${cleanTarget}^{commit}`]);
        }
        catch {
            throw new Error(`Target '${cleanTarget}' was not found in git history or snapshot tags.`);
        }
        let safetyBackupTag = null;
        const status = this.getStatus();
        // 2. If workspace has uncommitted changes and safetyBackup is enabled, save current state
        if (!status.isClean && safetyBackup) {
            const ts = Date.now();
            safetyBackupTag = `backup_before_rollback_${ts}`;
            this.runGit(["add", "-A"]);
            try {
                this.runGit(["commit", "-m", `chore: automatic safety backup before rollback to ${cleanTarget}`]);
                this.runGit(["tag", "-a", safetyBackupTag, "-m", "Emergency pre-rollback snapshot"]);
            }
            catch {
                // ignore if nothing changed
            }
        }
        // 3. Perform hard reset to target
        this.runGit(["reset", "--hard", resolvedCommit]);
        return {
            success: true,
            target: cleanTarget,
            resolvedCommit,
            safetyBackupTag,
            message: `Successfully rolled back workspace to '${cleanTarget}' (${resolvedCommit.slice(0, 7)}).${safetyBackupTag ? ` Safety backup saved as tag '${safetyBackupTag}'.` : ""}`,
        };
    }
    /**
     * Discards all uncommitted changes and newly created untracked files in the workspace,
     * restoring the workspace to the exact clean state of HEAD.
     * Automatically creates an emergency backup tag so accidental undo can be reversed!
     */
    undo() {
        const status = this.getStatus();
        if (status.isClean) {
            return {
                success: true,
                safetyBackupTag: null,
                message: "工作区当前已经是干净状态，无任何需要撤销的临时修改。",
            };
        }
        const ts = Date.now();
        const safetyBackupTag = `backup_before_undo_${ts}`;
        this.runGit(["add", "-A"]);
        try {
            this.runGit(["commit", "-m", "chore: safety backup before undo"]);
            this.runGit(["tag", "-a", safetyBackupTag, "-m", "Safety backup before undo"]);
        }
        catch {
            // ignore
        }
        // Reset to HEAD commit before the backup
        this.runGit(["reset", "--hard", status.currentCommit]);
        this.runGit(["clean", "-fd"]);
        return {
            success: true,
            safetyBackupTag,
            message: `已一键撤销刚才的所有修改，工作区已恢复到初始干净状态 (${status.currentCommit})。安全备份已存为 '${safetyBackupTag}'。`,
        };
    }
}
