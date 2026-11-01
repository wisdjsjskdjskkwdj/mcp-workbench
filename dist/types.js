/**
 * Core Domain & Interface Contracts for MCP Workbench Gateway Prototype v0.0.5
 */
export function assertSafeIdentifier(id, label = "Identifier") {
    if (typeof id !== "string" || !id.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
    const trimmed = id.trim();
    if (["__proto__", "prototype", "constructor"].includes(trimmed.toLowerCase())) {
        throw new Error(`ILLEGAL_IDENTIFIER: ${label} cannot be a reserved prototype property.`);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
        throw new Error(`INVALID_IDENTIFIER: ${label} '${trimmed}' must match ^[a-zA-Z0-9_-]{1,64}$ without directory separators or traversal characters.`);
    }
}
