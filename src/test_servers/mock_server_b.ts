import readline from "node:readline";

/**
 * Mock MCP Server B (`sys_clock`)
 * Provides `get_time` and `format_iso` tools.
 */
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const req = JSON.parse(trimmed);
  if (req.id === undefined || req.id === null) return;

  if (req.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "sys_clock", version: "1.0.0" },
        },
      }) + "\n"
    );
  } else if (req.method === "tools/list") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            {
              name: "get_time",
              description: "Return deterministic UTC timestamp for timezone",
              inputSchema: {
                type: "object",
                properties: {
                  timezone: { type: "string" },
                },
                required: ["timezone"],
              },
            },
          ],
        },
      }) + "\n"
    );
  } else if (req.method === "tools/call") {
    const { name, arguments: args } = req.params;
    if (name === "get_time") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            content: [
              {
                type: "text",
                text: `CLOCK_OK[${args.timezone}]:2026-10-30T23:59:00Z`,
              },
            ],
          },
        }) + "\n"
      );
    }
  }
});
