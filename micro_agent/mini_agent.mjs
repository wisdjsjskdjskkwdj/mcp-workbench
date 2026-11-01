import path from "node:path";
import { McpClient } from "./mcp_client.mjs";

/**
 * Micro-Agent: Autonomous Agent Prototype powered by MCP Workbench Gateway.
 * Demonstrates:
 * 1. Tool discovery and capability inspection.
 * 2. Multi-step tool chaining (Reasoning -> Action -> Observation loop).
 * 3. Self-Bootstrapping: dynamically mounting downstream servers when needed.
 * 4. Cache-bypassing cold-tool discovery via Studio meta-tools.
 */
export class MiniAgent {
  constructor(rootDir, agentName = "Antigravity-MiniAgent") {
    this.rootDir = path.resolve(rootDir);
    this.agentName = agentName;
    this.client = new McpClient(this.rootDir);
    this.tools = new Map();
    this.memory = [];
  }

  log(category, message, extra = null) {
    const timestamp = new Date().toLocaleTimeString();
    const badges = {
      THINK: "🧠 [THINK]",
      ACTION: "⚡ [ACTION]",
      OBSERVE: "👀 [OBSERVE]",
      SUCCESS: "✅ [SUCCESS]",
      BOOTSTRAP: "🚀 [BOOTSTRAP]",
      INFO: "ℹ️  [INFO]",
    };
    const badge = badges[category] || `[${category}]`;
    console.log(`[${timestamp}] ${badge} ${message}`);
    if (extra !== null && extra !== undefined) {
      if (typeof extra === "object") {
        console.log("   " + JSON.stringify(extra, null, 2).replace(/\n/g, "\n   "));
      } else {
        console.log(`   ${extra}`);
      }
    }
  }

  async start() {
    this.log("INFO", `Booting ${this.agentName}...`);
    await this.client.connect();

    this.log("INFO", "Performing MCP Handshake with Gateway...");
    const initRes = await this.client.initialize({
      name: this.agentName,
      version: "1.0.0",
    });
    this.log("SUCCESS", `Connected to Gateway: ${initRes.serverInfo?.name || "MCP Gateway"}`);

    // Listen for live dynamic tool changes
    this.client.on("tools_changed", async () => {
      this.log("INFO", "Received 'notifications/tools/list_changed' broadcast! Refreshing tool registry...");
      await this.refreshTools(false);
    });

    await this.refreshTools(true);
  }

  async refreshTools(verbose = false) {
    const toolList = await this.client.listTools();
    this.tools.clear();
    for (const t of toolList) {
      this.tools.set(t.name, t);
    }
    if (verbose) {
      this.log("OBSERVE", `Registered ${toolList.length} tools into local agent cache:`, [
        ...this.tools.keys(),
      ]);
    }
    return toolList;
  }

  hasTool(toolName) {
    return this.tools.has(toolName);
  }

  /**
   * Action Execution Wrapper
   */
  async executeTool(toolName, args = {}) {
    this.log("ACTION", `Calling tool '${toolName}' with arguments:`, args);
    const resp = await this.client.callTool(toolName, args);
    
    let textResult = "";
    if (resp.content && Array.isArray(resp.content)) {
      textResult = resp.content.map((c) => c.text || JSON.stringify(c)).join("\n");
    } else {
      textResult = JSON.stringify(resp);
    }

    this.log("OBSERVE", `Output from '${toolName}':`, textResult);
    return { raw: resp, text: textResult };
  }

  // ==========================================
  // High-Level Autonomous Tasks for the Agent
  // ==========================================

  /**
   * Task 1: System Perception (Current Time)
   */
  async taskGetSystemTime(timezone = "Asia/Shanghai") {
    this.log("THINK", `User requested current system time for timezone '${timezone}'. Inspecting available tools for clock/time...`);
    const targetTool = "sys_clock__get_time";

    if (!this.hasTool(targetTool)) {
      throw new Error(`Tool '${targetTool}' not found in registry!`);
    }

    const { text } = await this.executeTool(targetTool, { timezone });
    this.log("SUCCESS", `Current system time confirmed: ${text}`);
    return text;
  }

  /**
   * Task 2: Math Calculation Chaining (e.g. (a * b) + c)
   */
  async taskCalculateCompound(a, b, c) {
    this.log("THINK", `Goal: Calculate (${a} * ${b}) + ${c} using step-by-step tool invocation.`);

    // Step 1: Multiply
    this.log("THINK", `Step 1: Multiplying ${a} and ${b}...`);
    const mulRes = await this.executeTool("math_ops__multiply", { a, b });
    const product = Number(mulRes.text);

    // Step 2: Add
    this.log("THINK", `Step 2: Adding ${c} to intermediate result (${product})...`);
    const addRes = await this.executeTool("math_ops__add", { a: product, b: c });
    const finalResult = Number(addRes.text);

    this.log("SUCCESS", `Compound calculation complete: (${a} * ${b}) + ${c} = ${finalResult}`);
    return finalResult;
  }

  /**
   * Task 3: Cold Tool Discovery via Studio Meta-Tool
   */
  async taskSearchAndInvokeColdTool(keyword, args) {
    this.log("THINK", `Searching for unexposed/cold tool matching '${keyword}'...`);
    const searchRes = await this.executeTool("studio__tool__search", { query: keyword });
    const foundData = JSON.parse(searchRes.text);

    if (!foundData.tools || foundData.tools.length === 0) {
      throw new Error(`No tools found matching query '${keyword}'`);
    }

    const match = foundData.tools[0];
    this.log("THINK", `Found cold tool '${match.originalName}' on server '${match.serverId}'. Invoking directly via studio__tool__invoke...`);

    const invokeRes = await this.executeTool("studio__tool__invoke", {
      server_id: match.serverId,
      tool_name: match.originalName,
      arguments: args,
    });

    const resultValue = invokeRes.text;
    this.log("SUCCESS", `Cold tool '${match.originalName}' returned: ${resultValue}`);
    return resultValue;
  }

  /**
   * Task 4: Self-Bootstrapping (Autonomous Tool Acquisition)
   * If the agent needs weather forecasting but doesn't have it, it will dynamically mount it!
   */
  async taskAcquireAndQueryWeather(city, days = 3) {
    const targetTool = "weather_service__get_forecast";
    this.log("THINK", `Goal: Query ${days}-day weather forecast for '${city}'. Checking current capabilities...`);

    if (!this.hasTool(targetTool)) {
      this.log("THINK", `Capability missing! Tool '${targetTool}' is not present. Initiating Self-Bootstrapping...`);
      this.log("BOOTSTRAP", `Dynamically registering server 'weather_service' into Workbench Gateway via studio__server__add...`);

      const weatherServerScript = "./dist/test_servers/mock_server_c.js";
      await this.executeTool("studio__server__add", {
        id: "weather_service",
        command: "node",
        args: [weatherServerScript],
      });

      // Brief wait to ensure registration propagates
      await new Promise((r) => setTimeout(r, 400));
      await this.refreshTools();
    }

    this.log("THINK", `Tool '${targetTool}' is now ready. Executing weather forecast request...`);
    const { text } = await this.executeTool(targetTool, { city, days });

    this.log("SUCCESS", `Weather forecast retrieved for ${city}: ${text}`);
    return text;
  }

  /**
   * Task 5: Client Scan & Autonomous Binding / Unbinding
   */
  async taskScanClients() {
    this.log("THINK", "Scanning host environment for AI agent clients using 5-layer discovery funnel...");
    const res = await this.executeTool("studio__client__scan", {});
    const parsed = JSON.parse(res.text);
    this.log("SUCCESS", `Discovered ${parsed.clients.length} client adapters in environment.`);
    return parsed.clients;
  }

  async taskBindClient(clientId, options = {}) {
    this.log("THINK", `Attempting surgical non-destructive binding for client '${clientId}'...`);
    const res = await this.executeTool("studio__client__bind", {
      client_id: clientId,
      mode: options.mode || "exclusive",
      force: Boolean(options.force),
      auto_start_imported: options.autoStartImported !== false,
      manual_path: options.manualPath,
    });
    const parsed = JSON.parse(res.text);
    this.log("SUCCESS", `Client '${parsed.displayName || clientId}' bound successfully. Backup: ${parsed.backupPath || "none"}`);
    return parsed;
  }

  async taskUnbindClient(clientId) {
    this.log("THINK", `Restoring client '${clientId}' original configuration from backup...`);
    const res = await this.executeTool("studio__client__unbind", { client_id: clientId });
    const parsed = JSON.parse(res.text);
    this.log("SUCCESS", `Client '${clientId}' unbind complete. Restored: ${parsed.restored}`);
    return parsed;
  }

  async stop() {
    this.log("INFO", `Shutting down ${this.agentName}...`);
    await this.client.close();
    this.log("SUCCESS", `${this.agentName} stopped cleanly.`);
  }
}
