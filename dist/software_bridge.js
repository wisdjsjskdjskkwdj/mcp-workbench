/**
 * Module 4 (v0.0.5): Host Software IPC Reverse Bridge (`SoftwareBridge`).
 * Designed for heavy desktop applications (Blender, Revit, AutoCAD, Unity, Office) whose SDKs
 * must run inside the host application's main UI/document thread:
 * 1. Host plugin connects inbound to Daemon (`/bridge/register` + `/bridge/stream?bridge_id=...`).
 * 2. Tools immediately appear in `WorkbenchRegistry` with `serverType: "software_bridge"`.
 * 3. When an Agent invokes a bridge tool, `SoftwareBridge` pushes a JSON-RPC command frame down
 *    the plugin's SSE stream and resolves when the plugin posts the main-thread result to `/bridge/callback`.
 * 4. If the host software closes (SSE stream disconnects), its tools are automatically unmarked/cleared.
 */
export class SoftwareBridge {
    registry;
    sessions = new Map();
    constructor(registry) {
        this.registry = registry;
    }
    registerPlugin(reg) {
        const existing = this.sessions.get(reg.bridgeId);
        if (existing) {
            if (existing.heartbeatTimer) {
                clearInterval(existing.heartbeatTimer);
            }
            if (existing.sseRes) {
                try {
                    existing.sseRes.end();
                }
                catch { }
            }
            for (const [, pending] of existing.pendingCalls) {
                clearTimeout(pending.timer);
                pending.reject(new Error(`Host software '${reg.softwareName}' reconnected; aborted previous session call.`));
            }
            existing.pendingCalls.clear();
        }
        this.sessions.set(reg.bridgeId, {
            registration: reg,
            sseRes: null,
            pendingCalls: new Map(),
            nextCallSeq: 1,
        });
        this.registry.upsertDesiredServer({
            id: reg.bridgeId,
            serverType: "software_bridge",
            command: "__software_bridge__",
            args: [reg.softwareName, reg.softwareVersion],
            enabled: true,
            autoRestart: false,
        });
        this.registry.updateRuntimeState(reg.bridgeId, {
            serverType: "software_bridge",
            phase: "running",
            pid: reg.pid,
            startedAt: new Date().toISOString(),
            protocolVersion: `bridge-ipc/${reg.softwareName}-${reg.softwareVersion}`,
        });
        return this.registry.registerServerTools(reg.bridgeId, reg.tools);
    }
    attachCommandStream(bridgeId, req, res) {
        const session = this.sessions.get(bridgeId);
        if (!session) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Bridge '${bridgeId}' is not registered.` }));
            return;
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        session.sseRes = res;
        // Heartbeat keepalive every 25 seconds to prevent idle socket dropouts
        if (session.heartbeatTimer)
            clearInterval(session.heartbeatTimer);
        session.heartbeatTimer = setInterval(() => {
            if (session.sseRes === res) {
                try {
                    res.write(": keepalive\n\n");
                }
                catch {
                    if (session.heartbeatTimer)
                        clearInterval(session.heartbeatTimer);
                }
            }
            else {
                if (session.heartbeatTimer)
                    clearInterval(session.heartbeatTimer);
            }
        }, 25000);
        res.on("error", () => {
            if (session.sseRes === res) {
                this.handlePluginDisconnect(bridgeId);
            }
        });
        req.on("close", () => {
            if (session.sseRes === res) {
                this.handlePluginDisconnect(bridgeId);
            }
        });
    }
    handlePluginDisconnect(bridgeId) {
        const session = this.sessions.get(bridgeId);
        if (!session)
            return;
        if (session.heartbeatTimer) {
            clearInterval(session.heartbeatTimer);
            session.heartbeatTimer = null;
        }
        for (const [, pending] of session.pendingCalls) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Host software '${bridgeId}' disconnected before completing call.`));
        }
        session.pendingCalls.clear();
        this.sessions.delete(bridgeId);
        this.registry.clearServerTools(bridgeId);
        this.registry.updateRuntimeState(bridgeId, {
            phase: "stopped",
            pid: null,
            lastError: "Host software plugin disconnected",
        });
    }
    bridgeQueues = new Map();
    isBridgeServer(serverId) {
        const cfg = this.registry.getDesiredServer(serverId);
        return (cfg?.serverType === "software_bridge" ||
            cfg?.command === "__software_bridge__" ||
            this.sessions.has(serverId));
    }
    async invokeBridgeTool(bridgeId, toolName, args, timeoutMs = Number(process.env.MCP_BRIDGE_TIMEOUT_MS) || 60000) {
        const prevTask = this.bridgeQueues.get(bridgeId) ?? Promise.resolve();
        const currentTask = (async () => {
            try {
                await prevTask;
            }
            catch {
                // Prevents a previous failed call from stalling future queued calls
            }
            return this.doInvokeBridgeTool(bridgeId, toolName, args, timeoutMs);
        })();
        this.bridgeQueues.set(bridgeId, currentTask.catch(() => { }));
        return await currentTask;
    }
    async doInvokeBridgeTool(bridgeId, toolName, args, timeoutMs) {
        const session = this.sessions.get(bridgeId);
        if (!session || !session.sseRes) {
            throw new Error(`Host software plugin '${bridgeId}' does not have an active IPC command stream.`);
        }
        const callId = `bcall_${bridgeId}_${session.nextCallSeq++}`;
        const payload = {
            callId,
            bridgeId,
            toolName,
            arguments: args,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                session.pendingCalls.delete(callId);
                reject(new Error(`Bridge call '${toolName}' to host software '${bridgeId}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            session.pendingCalls.set(callId, { resolve, reject, timer });
            try {
                session.sseRes.write(`event: invoke\ndata: ${JSON.stringify(payload)}\n\n`);
            }
            catch (writeErr) {
                clearTimeout(timer);
                session.pendingCalls.delete(callId);
                reject(new Error(`Failed to dispatch bridge call to '${bridgeId}': ${writeErr?.message ?? String(writeErr)}`));
            }
        });
    }
    submitBridgeCallback(bridgeId, callId, result, errorMsg) {
        const session = this.sessions.get(bridgeId);
        if (!session)
            return false;
        const pending = session.pendingCalls.get(callId);
        if (!pending)
            return false;
        clearTimeout(pending.timer);
        session.pendingCalls.delete(callId);
        if (errorMsg) {
            pending.reject(new Error(errorMsg));
        }
        else {
            const textOut = typeof result === "string" ? result : JSON.stringify(result);
            pending.resolve({
                content: [{ type: "text", text: textOut }],
            });
        }
        return true;
    }
    listActiveBridges() {
        return Array.from(this.sessions.values()).map((s) => ({
            bridgeId: s.registration.bridgeId,
            softwareName: s.registration.softwareName,
            softwareVersion: s.registration.softwareVersion,
            pid: s.registration.pid,
            streamConnected: Boolean(s.sseRes),
            toolCount: s.registration.tools.length,
        }));
    }
}
