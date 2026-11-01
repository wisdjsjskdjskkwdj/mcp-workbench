import crypto from "node:crypto";
import type { CacheEntry } from "./types.js";

export interface CacheOptions {
  maxEntries?: number;
  defaultTtlMs?: number;
}

export interface RateLimiterOptions {
  capacity?: number;
  refillRatePerSec?: number;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Module 7: Dynamic Result Cache & Avalanche Rate Limiter (`CacheLimiter`).
 * 1. Caches read-only / idempotent tool call results to reduce duplicate IPC overhead and avoid 429 errors.
 * 2. Token-bucket rate limiter per caller/server to protect downstream tools from agent recursion loops.
 */
export class ToolResultCache {
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: CacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.defaultTtlMs = options.defaultTtlMs ?? 5000;
  }

  public computeKey(serverId: string, toolName: string, args: Record<string, unknown>): string {
    const cleanArgs = { ...args };
    delete cleanArgs.__approval_token;
    delete cleanArgs.__no_cache;
    const sortedKeys = Object.keys(cleanArgs).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      sortedObj[k] = cleanArgs[k];
    }
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify(sortedObj))
      .digest("hex")
      .slice(0, 16);
    return `${serverId}::${toolName}::${digest}`;
  }

  public get(serverId: string, toolName: string, args: Record<string, unknown>): unknown | undefined {
    if (args.__no_cache === true) return undefined;
    const key = this.computeKey(serverId, toolName, args);
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  public set(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    value: unknown,
    ttlMs = this.defaultTtlMs
  ): void {
    if (args.__no_cache === true || ttlMs <= 0) return;
    const key = this.computeKey(serverId, toolName, args);

    // Bounded eviction
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const now = Date.now();
    this.cache.set(key, {
      key,
      value,
      expiresAt: now + ttlMs,
      createdAt: now,
    });
  }

  public clear(serverPrefix?: string): void {
    if (!serverPrefix) {
      this.cache.clear();
      return;
    }
    for (const k of Array.from(this.cache.keys())) {
      if (k.startsWith(`${serverPrefix}::`)) {
        this.cache.delete(k);
      }
    }
  }

  public clearServer(serverId: string): void {
    this.clear(serverId);
  }

  public size(): number {
    return this.cache.size;
  }
}

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(options: RateLimiterOptions = {}) {
    this.capacity = options.capacity ?? 80;
    this.refillRatePerSec = options.refillRatePerSec ?? 25;
  }

  public consume(
    bucketKey: string,
    tokens = 1
  ): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now();
    let bucket = this.buckets.get(bucketKey);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(bucketKey, bucket);
    } else {
      // Refill tokens based on elapsed time
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + elapsedSec * this.refillRatePerSec
      );
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
      };
    }

    const needed = tokens - bucket.tokens;
    const retryAfterMs = Math.ceil((needed / this.refillRatePerSec) * 1000);
    return {
      allowed: false,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs,
    };
  }

  public clear(): void {
    this.buckets.clear();
  }
}
