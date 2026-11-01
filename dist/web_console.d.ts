import type { WorkbenchRegistry } from "./registry.js";
import type { PolicyGuard } from "./policy_guard.js";
import type { SecretVault } from "./secret_vault.js";
import type { ClientAutoBinder } from "./client_binder.js";
import type { SoftwareBridge } from "./software_bridge.js";
import type { ContextProfileRouter } from "./profile_router.js";
export declare class WebConsole {
    private readonly registry;
    private readonly policyGuard;
    private readonly secretVault;
    private readonly clientBinder;
    private readonly softwareBridge;
    private readonly profileRouter?;
    constructor(registry: WorkbenchRegistry, policyGuard: PolicyGuard, secretVault: SecretVault, clientBinder: ClientAutoBinder, softwareBridge: SoftwareBridge, profileRouter?: ContextProfileRouter);
    getDashboardState(): Record<string, any>;
    renderHtmlConsole(port: number): string;
}
