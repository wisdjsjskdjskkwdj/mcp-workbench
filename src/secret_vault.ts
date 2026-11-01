import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

interface EncryptedRecord {
  iv: string;
  authTag: string;
  ciphertext: string;
  updatedAt: string;
}

interface VaultFileFormat {
  version: string;
  secrets: Record<string, EncryptedRecord>;
}

/**
 * Production Module B (v0.1.0): Local AES-256-GCM Secret Vault & Placeholder Injector (`SecretVault`).
 * Prevents plaintext credential leakage in `workbench.json` and `.workbench_openapi/*.json`:
 * 1. Encrypts secrets at rest in `.workbench-secrets.enc.json` (mode `0600`) using AES-256-GCM
 *    with a machine-local 32-byte key in `.workbench-master.key` (mode `0600`).
 * 2. Resolves `$secret:KEY_NAME` and `${secret:KEY_NAME}` placeholders in memory right before
 *    spawning child processes or sending OpenAPI HTTP requests.
 * 3. Redacts any active secret values from audit logs and stderr diagnostics so secrets never leak to Agents.
 */
export class SecretVault {
  private readonly keyPath: string;
  private readonly vaultPath: string;
  private readonly masterKey: Buffer;
  private readonly cache = new Map<string, string>();

  constructor(rootDir: string) {
    const resolvedRoot = path.resolve(rootDir);
    this.keyPath = path.join(resolvedRoot, ".workbench-master.key");
    this.vaultPath = path.join(resolvedRoot, ".workbench-secrets.enc.json");
    this.masterKey = this.loadOrCreateMasterKey();
    this.loadVaultFromDisk();
  }

  private loadOrCreateMasterKey(): Buffer {
    if (fs.existsSync(this.keyPath)) {
      const hex = fs.readFileSync(this.keyPath, "utf-8").trim();
      if (hex.length === 64) {
        return Buffer.from(hex, "hex");
      }
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key.toString("hex"), {
      encoding: "utf-8",
      mode: 0o600,
    });
    return key;
  }

  private loadVaultFromDisk(): void {
    this.cache.clear();
    if (!fs.existsSync(this.vaultPath)) return;
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.vaultPath, "utf-8")
      ) as VaultFileFormat;
      for (const [name, enc] of Object.entries(raw.secrets ?? {})) {
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          this.masterKey,
          Buffer.from(enc.iv, "hex")
        );
        decipher.setAuthTag(Buffer.from(enc.authTag, "hex"));
        const decrypted = Buffer.concat([
          decipher.update(Buffer.from(enc.ciphertext, "hex")),
          decipher.final(),
        ]).toString("utf-8");
        this.cache.set(name, decrypted);
      }
    } catch {
      // Ignore corrupt vault file
    }
  }

  private persistVaultToDisk(): void {
    const secretsObj: Record<string, EncryptedRecord> = {};
    for (const [name, plain] of this.cache.entries()) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", this.masterKey, iv);
      const encrypted = Buffer.concat([
        cipher.update(plain, "utf-8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      secretsObj[name] = {
        iv: iv.toString("hex"),
        authTag: authTag.toString("hex"),
        ciphertext: encrypted.toString("hex"),
        updatedAt: new Date().toISOString(),
      };
    }

    const payload: VaultFileFormat = {
      version: "0.1.0",
      secrets: secretsObj,
    };
    const tmpPath = `${this.vaultPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.vaultPath);
  }

  public setSecret(name: string, value: string, _description?: string): void {
    const cleanName = name.trim();
    if (!/^[a-zA-Z0-9_]+$/.test(cleanName)) {
      throw new Error(
        `Invalid secret name '${cleanName}'. Use alphanumeric and underscore characters only.`
      );
    }
    this.cache.set(cleanName, value);
    this.persistVaultToDisk();
  }

  public deleteSecret(name: string): boolean {
    const existed = this.cache.delete(name.trim());
    if (existed) {
      this.persistVaultToDisk();
    }
    return existed;
  }

  public listSecretKeys(): Array<Record<string, any>> {
    return Array.from(this.cache.keys()).map((key) => ({
      key,
      placeholder: `$secret:${key}`,
      configured: true,
    }));
  }

  public listSecretsMetadata(): Array<Record<string, any>> {
    return this.listSecretKeys();
  }

  public resolveString(input: string): string {
    return input.replace(
      /\$\{?secret:([a-zA-Z0-9_]+)\}?/g,
      (_match, secretName: string) => {
        if (!this.cache.has(secretName)) {
          throw new Error(
            `SECRET_NOT_FOUND: Placeholder '$secret:${secretName}' is not set in SecretVault.`
          );
        }
        return this.cache.get(secretName) as string;
      }
    );
  }

  public resolveVaultString(input: string): string {
    return this.resolveString(input);
  }

  public resolveEnvRecord(
    env: Record<string, string> = {}
  ): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      resolved[k] = typeof v === "string" ? this.resolveString(v) : v;
    }
    return resolved;
  }

  public resolveEnvSecrets(env: Record<string, string> = {}): Record<string, string> {
    return this.resolveEnvRecord(env);
  }

  public resolveStringArray(arr: string[] = []): string[] {
    return arr.map((item) => this.resolveString(item));
  }

  /**
   * Redacts any known secret values from strings (e.g. audit logs or error messages)
   * so plaintext secrets are never exposed in logs or returned to Agents.
   */
  public redactSecrets(text: string): string {
    let out = text;
    for (const [name, val] of this.cache.entries()) {
      if (val && val.length >= 4 && out.includes(val)) {
        out = out.split(val).join(`[REDACTED:$secret:${name}]`);
      }
    }
    return out;
  }
}
