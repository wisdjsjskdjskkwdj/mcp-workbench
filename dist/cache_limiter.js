import crypto from "node:crypto";
/**
 * Module 7: Dynamic Result Cache & Avalanche Rate Limiter (`CacheLimiter`).
 * 1. Caches read-only / idempotent tool call results to reduce duplicate IPC overhead and avoid 429 errors.
 * 2. Token-bucket rate limiter per caller/server to protect downstream tools from agent recursion loops.
 */
export class ToolResultCache {
    maxEntries;
    defaultTtlMs;
    cache = new Map();
    constructor(options = {}) {
        this.maxEntries = options.maxEntries ?? 1000;
        this.defaultTtlMs = options.defaultTtlMs ?? 5000;
    }
    computeKey(serverId, toolName, args) {
        const cleanArgs = { ...args };
        delete cleanArgs.__approval_token;
        delete cleanArgs.__no_cache;
        const sortedKeys = Object.keys(cleanArgs).sort();
        const sortedObj = {};
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
    get(serverId, toolName, args) {
        if (args.__no_cache === true)
            return undefined;
        const key = this.computeKey(serverId, toolName, args);
        const entry = this.cache.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(serverId, toolName, args, value, ttlMs = this.defaultTtlMs) {
        if (args.__no_cache === true || ttlMs <= 0)
            return;
        const key = this.computeKey(serverId, toolName, args);
        // Bounded eviction
        if (this.cache.size >= this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey)
                this.cache.delete(oldestKey);
        }
        const now = Date.now();
        this.cache.set(key, {
            key,
            value,
            expiresAt: now + ttlMs,
            createdAt: now,
        });
    }
    clear(serverPrefix) {
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
    clearServer(serverId) {
        this.clear(serverId);
    }
    size() {
        return this.cache.size;
    }
}
export class TokenBucketRateLimiter {
    capacity;
    refillRatePerSec;
    buckets = new Map();
    constructor(options = {}) {
        this.capacity = options.capacity ?? 80;
        this.refillRatePerSec = options.refillRatePerSec ?? 25;
    }
    consume(bucketKey, tokens = 1) {
        const now = Date.now();
        let bucket = this.buckets.get(bucketKey);
        if (!bucket) {
            bucket = { tokens: this.capacity, lastRefill: now };
            this.buckets.set(bucketKey, bucket);
        }
        else {
            // Refill tokens based on elapsed time
            const elapsedSec = (now - bucket.lastRefill) / 1000;
            bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillRatePerSec);
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
    clear() {
        this.buckets.clear();
    }
}
