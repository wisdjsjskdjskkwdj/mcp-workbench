/**
 * Core Domain & Interface Contracts for MCP Workbench Gateway Prototype v0.0.5
 */

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  description?: string;
  additionalProperties?: boolean;
}

export type ServerDriverType =
  | "stdio_process"
  | "virtual_openapi"
  | "software_bridge"
  | "builder_sandbox";

/** 1. Desired State (Persisted in workbench.json) */
export interface DesiredServerConfig {
  id: string;
  serverType?: ServerDriverType;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  autoRestart?: boolean;
  highFrequencyTools?: string[];
}

export interface ProfileConfig {
  exposeMode: "all" | "high_frequency";
  enabledServers: string[];
  disabledTools: string[];
}

export interface WorkbenchDesiredConfig {
  version: string;
  webUiEnabled?: boolean;
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
  servers: Record<string, DesiredServerConfig>;
}

/** 2. Actual Runtime State */
export type ServerLifecyclePhase =
  | "stopped"
  | "starting"
  | "handshaking"
  | "running"
  | "degraded"
  | "failed";

export interface ActualServerRuntimeState {
  serverId: string;
  serverType: ServerDriverType;
  phase: ServerLifecyclePhase;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  lastExitCode: number | null;
  lastError: string | null;
  protocolVersion: string | null;
  recentStderr: string[];
}

/** 3. Aggregated Tool Record with Stable Internal ID */
export interface ToolRecord {
  toolId: string;
  serverId: string;
  originalName: string;
  exposedName: string;
  description: string;
  inputSchema: JsonSchema;
  enabled: boolean;
  exposeTopLevel: boolean;
}

/** 3b. Aggregated MCP Resource & Prompt Records (Module C) */
export interface ResourceRecord {
  serverId: string;
  originalUri: string;
  /** Namespaced URI exposed to clients: mcp-workbench://<serverId>/<originalUri> */
  exposedUri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface PromptRecord {
  serverId: string;
  originalName: string;
  /** Namespaced Prompt name matching ^[a-zA-Z0-9_-]{1,64}$: <serverId>__<originalName> */
  exposedName: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** 4. Daemon Single-Instance Lock & Runtime Metadata */
export interface DaemonLockInfo {
  pid: number;
  host: string;
  port: number;
  /** Agent/Shim bearer token for `/mcp` and `/bridge` */
  token: string;
  /** Separate out-of-band Human/GUI Admin Secret for `/admin/approve` (never exposed to Agent tools) */
  adminSecret: string;
  startedAt: string;
  version: string;
}

/** 5. JSON-RPC 2.0 Standard Envelopes */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export function assertSafeIdentifier(id: string, label = "Identifier"): void {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const trimmed = id.trim();
  if (["__proto__", "prototype", "constructor"].includes(trimmed.toLowerCase())) {
    throw new Error(`ILLEGAL_IDENTIFIER: ${label} cannot be a reserved prototype property.`);
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
    throw new Error(
      `INVALID_IDENTIFIER: ${label} '${trimmed}' must match ^[a-zA-Z0-9_-]{1,64}$ without directory separators or traversal characters.`
    );
  }
}

/** 6. Circuit Breaker & Health Watchdog (Module 6) */
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface ServerHealthStatus {
  serverId: string;
  state: CircuitBreakerState;
  consecutiveFailures: number;
  lastFailureTime: number | null;
  lastCheckTime: number | null;
  lastProbeSuccess: boolean;
  totalRestarts: number;
}

/** 7. Dynamic Cache & Rate Limiter (Module 7) */
export interface CacheEntry {
  key: string;
  value: unknown;
  expiresAt: number;
  createdAt: number;
}

/** 8. Telemetry Metrics (Module 8) */
export interface ToolMetricSummary {
  serverId: string;
  toolName: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  cacheHits: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p90DurationMs: number;
  p99DurationMs: number;
  totalEstimatedTokens: number;
  lastCalledAt: string | null;
}

/** 9. Secret Vault (Module 10) */
export interface VaultSecretItem {
  key: string;
  ciphertext: string;
  iv: string;
  tag: string;
  createdAt: string;
  updatedAt: string;
}


