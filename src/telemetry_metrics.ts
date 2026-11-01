import type { ToolMetricSummary } from "./types.js";

interface ToolAccumulator {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  cacheHits: number;
  durations: number[]; // Sliding window of up to 100 recent durations
  totalEstimatedTokens: number;
  lastCalledAt: string | null;
}

/**
 * Module 8: Telemetry Metrics & Latency Analyzer (`TelemetryMetrics`).
 * Tracks full-lifecycle tool performance, P50/P90/P99 latency distribution, and estimated LLM token footprint.
 */
export class TelemetryMetrics {
  private readonly metrics = new Map<string, ToolAccumulator>();
  private readonly maxWindow = 100;

  private getMetricKey(serverId: string, toolName: string): string {
    return `${serverId}::${toolName}`;
  }

  public recordCall(
    serverId: string,
    toolName: string,
    durationMs: number,
    success: boolean,
    details: {
      cacheHit?: boolean;
      inputChars?: number;
      outputChars?: number;
    } = {}
  ): void {
    const key = this.getMetricKey(serverId, toolName);
    let accum = this.metrics.get(key);

    if (!accum) {
      accum = {
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        cacheHits: 0,
        durations: [],
        totalEstimatedTokens: 0,
        lastCalledAt: null,
      };
      this.metrics.set(key, accum);
    }

    accum.totalCalls++;
    if (success) accum.successfulCalls++;
    else accum.failedCalls++;

    if (details.cacheHit) accum.cacheHits++;

    const inChars = details.inputChars ?? 0;
    const outChars = details.outputChars ?? 0;
    const estimatedTokens = Math.ceil((inChars + outChars) / 4);
    accum.totalEstimatedTokens += estimatedTokens;

    accum.durations.push(durationMs);
    if (accum.durations.length > this.maxWindow) {
      accum.durations.shift();
    }
    accum.lastCalledAt = new Date().toISOString();
  }

  private calculateQuantile(sorted: number[], q: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil(q * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  }

  public getSummaryForTool(serverId: string, toolName: string): ToolMetricSummary | undefined {
    const key = this.getMetricKey(serverId, toolName);
    const accum = this.metrics.get(key);
    if (!accum) return undefined;

    const sorted = [...accum.durations].sort((a, b) => a - b);
    const avg =
      sorted.length > 0
        ? Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 10) / 10
        : 0;

    return {
      serverId,
      toolName,
      totalCalls: accum.totalCalls,
      successfulCalls: accum.successfulCalls,
      failedCalls: accum.failedCalls,
      cacheHits: accum.cacheHits,
      avgDurationMs: avg,
      p50DurationMs: this.calculateQuantile(sorted, 0.5),
      p90DurationMs: this.calculateQuantile(sorted, 0.9),
      p99DurationMs: this.calculateQuantile(sorted, 0.99),
      totalEstimatedTokens: accum.totalEstimatedTokens,
      lastCalledAt: accum.lastCalledAt,
    };
  }

  public getAllSummaries(): ToolMetricSummary[] {
    const results: ToolMetricSummary[] = [];
    for (const [key] of this.metrics.entries()) {
      const [serverId, toolName] = key.split("::");
      const summary = this.getSummaryForTool(serverId, toolName);
      if (summary) results.push(summary);
    }
    return results;
  }

  public getServerSummaries(serverId: string): ToolMetricSummary[] {
    return this.getAllSummaries().filter((s) => s.serverId === serverId);
  }

  public getSystemOverview(): Record<string, any> {
    const summaries = this.getAllSummaries();
    let totalCalls = 0;
    let totalErrors = 0;
    let totalCacheHits = 0;
    let totalTokens = 0;
    let totalDurationSum = 0;

    for (const s of summaries) {
      totalCalls += s.totalCalls;
      totalErrors += s.failedCalls;
      totalCacheHits += s.cacheHits;
      totalTokens += s.totalEstimatedTokens;
      totalDurationSum += s.avgDurationMs * s.totalCalls;
    }

    const overallAvgLatency =
      totalCalls > 0 ? Math.round((totalDurationSum / totalCalls) * 10) / 10 : 0;
    const cacheHitRate =
      totalCalls > 0 ? Math.round((totalCacheHits / totalCalls) * 1000) / 10 : 0;

    return {
      totalCalls,
      totalErrors,
      errorRate: totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 1000) / 10 : 0,
      totalCacheHits,
      cacheHitRatePercent: cacheHitRate,
      overallAvgLatencyMs: overallAvgLatency,
      totalEstimatedTokens: totalTokens,
      trackedToolsCount: summaries.length,
    };
  }

  public reset(): void {
    this.metrics.clear();
  }
}
