import type { ToolMetricSummary } from "./types.js";
/**
 * Module 8: Telemetry Metrics & Latency Analyzer (`TelemetryMetrics`).
 * Tracks full-lifecycle tool performance, P50/P90/P99 latency distribution, and estimated LLM token footprint.
 */
export declare class TelemetryMetrics {
    private readonly metrics;
    private readonly maxWindow;
    private getMetricKey;
    recordCall(serverId: string, toolName: string, durationMs: number, success: boolean, details?: {
        cacheHit?: boolean;
        inputChars?: number;
        outputChars?: number;
    }): void;
    private calculateQuantile;
    getSummaryForTool(serverId: string, toolName: string): ToolMetricSummary | undefined;
    getAllSummaries(): ToolMetricSummary[];
    getServerSummaries(serverId: string): ToolMetricSummary[];
    getSystemOverview(): Record<string, any>;
    reset(): void;
}
