export interface VersionEntry {
    hash: string;
    shortHash: string;
    tags: string[];
    author: string;
    date: string;
    message: string;
    isCurrent: boolean;
}
export interface WorkspaceStatus {
    isClean: boolean;
    currentCommit: string;
    currentBranch: string;
    modifiedFiles: string[];
    untrackedFiles: string[];
    totalChanged: number;
}
export interface SnapshotResult {
    success: boolean;
    commitHash: string;
    shortHash: string;
    tagName: string;
    name: string;
    description: string;
    timestamp: string;
}
export interface RollbackResult {
    success: boolean;
    target: string;
    resolvedCommit: string;
    safetyBackupTag: string | null;
    message: string;
}
/**
 * Project Version & Rollback Manager (v0.0.3).
 * Provides Git-backed local atomic snapshotting, history audit, diff inspection,
 * and safe non-destructive rollback with automatic pre-revert safety checkpoints.
 * Hardened: Uses spawnSync with strict array arguments to completely eliminate Command Injection.
 */
export declare class VersionManager {
    private readonly rootDir;
    constructor(rootDir?: string);
    private runGit;
    /**
     * Checks if Git repository is properly initialized in rootDir.
     */
    isRepositoryInitialized(): boolean;
    /**
     * Retrieves workspace status (modified files, untracked files, clean state).
     */
    getStatus(): WorkspaceStatus;
    /**
     * Lists project history with commit hashes, tags, authors, timestamps, and commit messages.
     */
    listHistory(limit?: number): VersionEntry[];
    /**
     * Creates an atomic named snapshot / checkpoint with an automatic git tag.
     */
    createSnapshot(name: string, description?: string): SnapshotResult;
    /**
     * Inspects differences between current workspace and a target commit/tag.
     */
    getDiff(target?: string): {
        stat: string;
        diff: string;
    };
    /**
     * Safely rolls back the project to a specified commit, tag, or snapshot.
     * Automatically creates a pre-rollback emergency backup tag so work is never lost.
     */
    rollback(target: string, safetyBackup?: boolean): RollbackResult;
    /**
     * Discards all uncommitted changes and newly created untracked files in the workspace,
     * restoring the workspace to the exact clean state of HEAD.
     * Automatically creates an emergency backup tag so accidental undo can be reversed!
     */
    undo(): {
        success: boolean;
        safetyBackupTag: string | null;
        message: string;
    };
}
