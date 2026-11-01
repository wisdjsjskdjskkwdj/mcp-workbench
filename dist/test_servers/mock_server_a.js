import readline from "node:readline";
/**
 * Mock MCP Server A (`math_ops`)
 * Provides high-frequency tools (`add`, `multiply`) and a cold tool (`fibonacci`)
 * to verify selective top-level exposure vs. `studio.tool.search` + `studio.tool.invoke`.
 */
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed)
        return;
    const req = JSON.parse(trimmed);
    if (req.id === undefined || req.id === null)
        return;
    if (req.method === "initialize") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {}, resources: {}, prompts: {} },
                serverInfo: { name: "math_ops", version: "1.0.0" },
            },
        }) + "\n");
    }
    else if (req.method === "resources/list") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                resources: [
                    {
                        uri: "math://constants/pi",
                        name: "Archimedes Constant Pi",
                        description: "High-precision value of Pi",
                        mimeType: "text/plain",
                    },
                ],
            },
        }) + "\n");
    }
    else if (req.method === "resources/read") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                contents: [
                    {
                        uri: req.params.uri,
                        mimeType: "text/plain",
                        text: "PI=3.141592653589793",
                    },
                ],
            },
        }) + "\n");
    }
    else if (req.method === "prompts/list") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                prompts: [
                    {
                        name: "explain_theorem",
                        description: "Generate a step-by-step mathematical theorem explanation",
                        arguments: [{ name: "theorem", required: true }],
                    },
                ],
            },
        }) + "\n");
    }
    else if (req.method === "prompts/get") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                description: "Theorem explanation prompt",
                messages: [
                    {
                        role: "user",
                        content: {
                            type: "text",
                            text: `Please prove theorem: ${req.params?.arguments?.theorem ?? "Pythagoras"}`,
                        },
                    },
                ],
            },
        }) + "\n");
    }
    else if (req.method === "tools/list") {
        process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
                tools: [
                    {
                        name: "add",
                        description: "Add two numbers a and b",
                        inputSchema: {
                            type: "object",
                            properties: {
                                a: { type: "number" },
                                b: { type: "number" },
                            },
                            required: ["a", "b"],
                        },
                    },
                    {
                        name: "multiply",
                        description: "Multiply two numbers a and b",
                        inputSchema: {
                            type: "object",
                            properties: {
                                a: { type: "number" },
                                b: { type: "number" },
                            },
                            required: ["a", "b"],
                        },
                    },
                    {
                        name: "fibonacci",
                        description: "Cold tool: compute the nth Fibonacci number",
                        inputSchema: {
                            type: "object",
                            properties: {
                                n: { type: "number" },
                            },
                            required: ["n"],
                        },
                    },
                ],
            },
        }) + "\n");
    }
    else if (req.method === "tools/call") {
        const { name, arguments: args } = req.params;
        if (name === "add") {
            const sum = Number(args.a) + Number(args.b);
            process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: String(sum) }] },
            }) + "\n");
        }
        else if (name === "multiply") {
            const prod = Number(args.a) * Number(args.b);
            process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: String(prod) }] },
            }) + "\n");
        }
        else if (name === "fibonacci") {
            let a = 0, b = 1;
            for (let i = 0; i < Number(args.n); i++) {
                [a, b] = [b, a + b];
            }
            process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { content: [{ type: "text", text: String(a) }] },
            }) + "\n");
        }
    }
});
