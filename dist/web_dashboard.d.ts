import type { DaemonLockInfo } from "./types.js";
import type { WorkbenchRegistry } from "./registry.js";
import type { HealthWatchdog } from "./health_watchdog.js";
import type { TelemetryMetrics } from "./telemetry_metrics.js";
import type { PolicyGuard } from "./policy_guard.js";
import type { ClientAutoBinder } from "./client_binder.js";
export interface DashboardRenderContext {
    lockInfo: DaemonLockInfo;
    registry: WorkbenchRegistry;
    watchdog?: HealthWatchdog;
    metrics?: TelemetryMetrics;
    policyGuard?: PolicyGuard;
    clientBinder?: ClientAutoBinder;
}
/**
 * Module 9: Embedded Web Dashboard & Human-in-the-Loop Console (`WebDashboard`).
 * Zero-dependency, lightweight modern GUI served directly from Daemon `/ui`.
 */
export declare class WebDashboard {
    static renderHtml(ctx: DashboardRenderContext): string;
}
