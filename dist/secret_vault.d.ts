/**
 * Production Module B (v0.1.0): Local AES-256-GCM Secret Vault & Placeholder Injector (`SecretVault`).
 * Prevents plaintext credential leakage in `workbench.json` and `.workbench_openapi/*.json`:
 * 1. Encrypts secrets at rest in `.workbench-secrets.enc.json` (mode `0600`) using AES-256-GCM
 *    with a machine-local 32-byte key in `.workbench-master.key` (mode `0600`).
 * 2. Resolves `$secret:KEY_NAME` and `${secret:KEY_NAME}` placeholders in memory right before
 *    spawning child processes or sending OpenAPI HTTP requests.
 * 3. Redacts any active secret values from audit logs and stderr diagnostics so secrets never leak to Agents.
 */
export declare class SecretVault {
    private readonly keyPath;
    private readonly vaultPath;
    private readonly masterKey;
    private readonly cache;
    constructor(rootDir: string);
    private loadOrCreateMasterKey;
    private loadVaultFromDisk;
    private persistVaultToDisk;
    setSecret(name: string, value: string, _description?: string): void;
    deleteSecret(name: string): boolean;
    listSecretKeys(): Array<Record<string, any>>;
    listSecretsMetadata(): Array<Record<string, any>>;
    resolveString(input: string): string;
    resolveVaultString(input: string): string;
    resolveEnvRecord(env?: Record<string, string>): Record<string, string>;
    resolveEnvSecrets(env?: Record<string, string>): Record<string, string>;
    resolveStringArray(arr?: string[]): string[];
    /**
     * Redacts any known secret values from strings (e.g. audit logs or error messages)
     * so plaintext secrets are never exposed in logs or returned to Agents.
     */
    redactSecrets(text: string): string;
}
