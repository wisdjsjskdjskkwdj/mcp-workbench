export interface CacheOptions {
    maxEntries?: number;
    defaultTtlMs?: number;
}
export interface RateLimiterOptions {
    capacity?: number;
    refillRatePerSec?: number;
}
/**
 * Module 7: Dynamic Result Cache & Avalanche Rate Limiter (`CacheLimiter`).
 * 1. Caches read-only / idempotent tool call results to reduce duplicate IPC overhead and avoid 429 errors.
 * 2. Token-bucket rate limiter per caller/server to protect downstream tools from agent recursion loops.
 */
export declare class ToolResultCache {
    private readonly maxEntries;
    private readonly defaultTtlMs;
    private readonly cache;
    constructor(options?: CacheOptions);
    computeKey(serverId: string, toolName: string, args: Record<string, unknown>): string;
    get(serverId: string, toolName: string, args: Record<string, unknown>): unknown | undefined;
    set(serverId: string, toolName: string, args: Record<string, unknown>, value: unknown, ttlMs?: number): void;
    clear(serverPrefix?: string): void;
    clearServer(serverId: string): void;
    size(): number;
}
export declare class TokenBucketRateLimiter {
    private readonly capacity;
    private readonly refillRatePerSec;
    private readonly buckets;
    constructor(options?: RateLimiterOptions);
    consume(bucketKey: string, tokens?: number): {
        allowed: boolean;
        remaining: number;
        retryAfterMs: number;
    };
    clear(): void;
}
