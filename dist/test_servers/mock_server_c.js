import readline from "node:readline";
/**
 * Mock MCP Server C (`weather_service`)
 * Dynamically mounted at runtime during Acceptance Steps 4, 5, and 6 via `studio.server.add`.
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
                capabilities: { tools: {} },
                serverInfo: { name: "weather_service", version: "1.0.0" },
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
                        name: "get_forecast",
                        description: "Fetch live weather forecast for a given city",
                        inputSchema: {
                            type: "object",
                            properties: {
                                city: { type: "string" },
                                days: { type: "number" },
                            },
                            required: ["city", "days"],
                        },
                    },
                ],
            },
        }) + "\n");
    }
    else if (req.method === "tools/call") {
        const { name, arguments: args } = req.params;
        if (name === "get_forecast") {
            process.stdout.write(JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                    content: [
                        {
                            type: "text",
                            text: `FORECAST[${args.city},${args.days}d]: Sunny 22C`,
                        },
                    ],
                },
            }) + "\n");
        }
    }
});
