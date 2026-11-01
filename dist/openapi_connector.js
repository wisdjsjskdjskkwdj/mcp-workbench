import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { assertSafeIdentifier } from "./types.js";
/**
 * Module 1 (v0.0.5): Zero-Code OpenAPI / REST Virtual MCP Server Engine (`OpenApiConnector`).
 * Fixes v0.0.4 restart conflict by persisting imported OpenAPI specs under `.workbench_openapi/`
 * so virtual servers and their endpoints are automatically restored when `reconcileAll()` runs after a Daemon restart.
 */
export class OpenApiConnector {
    registry;
    storageDir;
    endpoints = new Map();
    secretVault;
    constructor(registry, rootDir) {
        this.registry = registry;
        this.storageDir = path.join(path.resolve(rootDir), ".workbench_openapi");
    }
    getSpecFilePath(connectorId) {
        assertSafeIdentifier(connectorId, "connectorId");
        const filePath = path.resolve(this.storageDir, `${connectorId}.json`);
        const resolvedDir = path.resolve(this.storageDir);
        if (!filePath.startsWith(resolvedDir)) {
            throw new Error(`PATH_TRAVERSAL_DETECTED: '${connectorId}' escapes storage directory.`);
        }
        return filePath;
    }
    importOpenApiSpec(connectorId, spec, options = {}, persistToDisk = true) {
        assertSafeIdentifier(connectorId, "connectorId");
        const baseUrl = String(options.baseUrl ?? spec.servers?.[0]?.url ?? "http://127.0.0.1:80").replace(/\/+$/, "");
        const auth = {
            type: options.authType ? String(options.authType) : "none",
            token: options.authToken ? String(options.authToken) : undefined,
            headerName: options.authHeaderName
                ? String(options.authHeaderName)
                : "X-API-Key",
        };
        const pickFields = Array.isArray(options.pickFields)
            ? options.pickFields.map(String)
            : undefined;
        const maxResponseChars = Number(options.maxResponseChars ?? 4096);
        if (persistToDisk) {
            fs.mkdirSync(this.storageDir, { recursive: true });
            const bundle = {
                connectorId,
                spec,
                options: {
                    baseUrl,
                    authType: auth.type,
                    authToken: auth.token,
                    authHeaderName: auth.headerName,
                    pickFields,
                    maxResponseChars,
                },
            };
            fs.writeFileSync(this.getSpecFilePath(connectorId), JSON.stringify(bundle, null, 2), "utf-8");
        }
        const rawTools = [];
        for (const [routePath, pathItem] of Object.entries(spec.paths ?? {})) {
            for (const [httpMethod, op] of Object.entries(pathItem ?? {})) {
                const methodUpper = httpMethod.toUpperCase();
                if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodUpper)) {
                    continue;
                }
                const sanitizedPath = routePath
                    .replace(/^\/+|\/+$/g, "")
                    .replace(/[^a-zA-Z0-9_]/g, "_");
                const toolName = (op.operationId ?? `${httpMethod.toLowerCase()}_${sanitizedPath}`).replace(/[^a-zA-Z0-9_-]/g, "_");
                const properties = {};
                const required = [];
                const pathParams = [];
                const queryParams = [];
                for (const param of op.parameters ?? []) {
                    const pType = param.schema?.type ?? "string";
                    properties[param.name] = {
                        type: pType,
                        description: param.description ?? `${param.in} parameter`,
                    };
                    if (param.required || param.in === "path") {
                        required.push(param.name);
                    }
                    if (param.in === "path") {
                        pathParams.push(param.name);
                    }
                    else if (param.in === "query") {
                        queryParams.push(param.name);
                    }
                }
                let hasJsonBody = false;
                let bodySchema = null;
                if (op.requestBody?.content) {
                    const contentEntries = Object.entries(op.requestBody.content);
                    const jsonEntry = contentEntries.find(([mime]) => {
                        const m = mime.toLowerCase();
                        return m.startsWith("application/json") || m === "*/*";
                    });
                    if (jsonEntry && jsonEntry[1]?.schema) {
                        bodySchema = jsonEntry[1].schema;
                    }
                }
                if (bodySchema && bodySchema.properties) {
                    hasJsonBody = true;
                    for (const [bKey, bVal] of Object.entries(bodySchema.properties)) {
                        properties[bKey] = bVal;
                    }
                    for (const reqKey of bodySchema.required ?? []) {
                        if (!required.includes(reqKey)) {
                            required.push(reqKey);
                        }
                    }
                }
                const bindingKey = `${connectorId}::${toolName}`;
                this.endpoints.set(bindingKey, {
                    connectorId,
                    toolName,
                    method: methodUpper,
                    baseUrl,
                    pathTemplate: routePath,
                    pathParams,
                    queryParams,
                    hasJsonBody,
                    auth,
                    pickFields,
                    maxResponseChars,
                });
                rawTools.push({
                    name: toolName,
                    description: op.summary ??
                        op.description ??
                        `OpenAPI ${methodUpper} ${routePath}`,
                    inputSchema: {
                        type: "object",
                        properties,
                        required,
                    },
                });
            }
        }
        this.registry.upsertDesiredServer({
            id: connectorId,
            serverType: "virtual_openapi",
            command: "__virtual_openapi__",
            args: [baseUrl],
            enabled: true,
            autoRestart: false,
        });
        this.registry.updateRuntimeState(connectorId, {
            serverType: "virtual_openapi",
            phase: "running",
            pid: process.pid,
            startedAt: new Date().toISOString(),
            protocolVersion: "openapi-3.x-virtual",
        });
        return this.registry.registerServerTools(connectorId, rawTools);
    }
    restorePersistedConnector(connectorId) {
        const filePath = this.getSpecFilePath(connectorId);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Persisted OpenAPI spec not found at ${filePath}`);
        }
        const bundle = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return this.importOpenApiSpec(bundle.connectorId, bundle.spec, bundle.options, false);
    }
    removeVirtualConnector(connectorId) {
        const filePath = this.getSpecFilePath(connectorId);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        for (const key of Array.from(this.endpoints.keys())) {
            if (key.startsWith(`${connectorId}::`)) {
                this.endpoints.delete(key);
            }
        }
    }
    isVirtualConnector(serverId) {
        const cfg = this.registry.getDesiredServer(serverId);
        return (cfg?.serverType === "virtual_openapi" ||
            cfg?.command === "__virtual_openapi__");
    }
    async invokeVirtualEndpoint(serverId, toolName, args) {
        const binding = this.endpoints.get(`${serverId}::${toolName}`);
        if (!binding) {
            throw new Error(`Virtual OpenAPI endpoint '${serverId}::${toolName}' not found.`);
        }
        let resolvedPath = binding.pathTemplate;
        for (const pName of binding.pathParams) {
            const val = encodeURIComponent(String(args[pName] ?? ""));
            resolvedPath = resolvedPath.replace(`{${pName}}`, val);
        }
        const urlObj = new URL(binding.baseUrl + resolvedPath);
        for (const qName of binding.queryParams) {
            if (args[qName] !== undefined) {
                urlObj.searchParams.set(qName, String(args[qName]));
            }
        }
        const bodyObj = {};
        if (binding.hasJsonBody) {
            for (const [k, v] of Object.entries(args)) {
                if (!binding.pathParams.includes(k) &&
                    !binding.queryParams.includes(k)) {
                    bodyObj[k] = v;
                }
            }
        }
        const headers = {
            Accept: "application/json",
        };
        if (binding.hasJsonBody) {
            headers["Content-Type"] = "application/json";
        }
        const resolvedToken = binding.auth.token && this.secretVault
            ? this.secretVault.resolveString(binding.auth.token)
            : binding.auth.token;
        if (binding.auth.type === "bearer" && resolvedToken) {
            headers["Authorization"] = `Bearer ${resolvedToken}`;
        }
        else if (binding.auth.type === "api_key_header" && resolvedToken) {
            headers[binding.auth.headerName ?? "X-API-Key"] = resolvedToken;
        }
        else if (binding.auth.type === "api_key_query" && resolvedToken) {
            urlObj.searchParams.set(binding.auth.headerName ?? "api_key", resolvedToken);
        }
        const rawResp = await this.performHttpRequest(urlObj, binding.method, headers, binding.hasJsonBody ? JSON.stringify(bodyObj) : undefined);
        let processedText = rawResp;
        try {
            const parsed = JSON.parse(rawResp);
            if (binding.pickFields &&
                binding.pickFields.length > 0 &&
                parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed)) {
                const picked = {};
                for (const f of binding.pickFields) {
                    if (f in parsed)
                        picked[f] = parsed[f];
                }
                processedText = JSON.stringify(picked);
            }
            else {
                processedText = JSON.stringify(parsed);
            }
        }
        catch {
            // Plain text response
        }
        if (processedText.length > binding.maxResponseChars) {
            processedText =
                processedText.slice(0, binding.maxResponseChars) +
                    "...[TRUNCATED_BY_OPENAPI_CONNECTOR]";
        }
        return {
            content: [
                {
                    type: "text",
                    text: processedText,
                },
            ],
        };
    }
    performHttpRequest(urlObj, method, headers, body, timeoutMs = 30000) {
        const proto = urlObj.protocol.toLowerCase();
        if (proto !== "http:" && proto !== "https:") {
            return Promise.reject(new Error(`SSRF_BLOCKED: Unsupported protocol '${proto}'`));
        }
        const host = urlObj.hostname.toLowerCase();
        if (host === "169.254.169.254" ||
            host.startsWith("169.254.") ||
            host === "metadata.google.internal" ||
            host === "instance-data" ||
            host === "0.0.0.0" ||
            host === "[fd00:ec2::254]") {
            return Promise.reject(new Error(`SSRF_BLOCKED: Access to instance metadata / link-local address '${host}' is prohibited.`));
        }
        const lib = urlObj.protocol === "https:" ? https : http;
        return new Promise((resolve, reject) => {
            const req = lib.request(urlObj, {
                method,
                headers,
                timeout: timeoutMs,
            }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? "Error"}: ${data.slice(0, 500)}`));
                    }
                    else {
                        resolve(data);
                    }
                });
            });
            req.on("timeout", () => {
                req.destroy(new Error(`GATEWAY_TIMEOUT: Remote OpenAPI endpoint timed out after ${timeoutMs}ms`));
            });
            req.on("error", reject);
            if (body)
                req.write(body);
            req.end();
        });
    }
}
