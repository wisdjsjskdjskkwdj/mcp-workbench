import assert from "node:assert";
import path from "node:path";
import { MiniAgent } from "./mini_agent.mjs";

/**
 * End-to-End Test Suite for Micro-Agent running against MCP Workbench.
 */
async function main() {
  console.log("==================================================================");
  console.log("🤖  Starting MCP Workbench Micro-Agent End-to-End Verification  🤖");
  console.log("==================================================================\n");

  const rootDir = path.resolve(".");
  const agent = new MiniAgent(rootDir, "Prototype-MicroAgent-v1");

  try {
    // 1. Start agent and connect to MCP Workbench
    await agent.start();
    console.log("\n------------------------------------------------------------------");
    console.log("🧪  TEST CASE 1: Perception & Clock Query");
    console.log("------------------------------------------------------------------");
    const timeStr = await agent.taskGetSystemTime();
    assert(timeStr && timeStr.length > 0, "Time string must not be empty");
    console.log("👉 Test 1 Passed: Agent successfully sensed system time.\n");

    console.log("------------------------------------------------------------------");
    console.log("🧪  TEST CASE 2: Multi-Step Tool Chaining Math ((35 * 14) + 110)");
    console.log("------------------------------------------------------------------");
    const mathResult = await agent.taskCalculateCompound(35, 14, 110);
    assert.strictEqual(mathResult, 600, "35 * 14 + 110 should equal 600");
    console.log("👉 Test 2 Passed: Multi-step tool chaining executed correctly.\n");

    console.log("------------------------------------------------------------------");
    console.log("🧪  TEST CASE 3: Cold Tool Discovery via Studio Meta-Tools (fibonacci)");
    console.log("------------------------------------------------------------------");
    const fibResult = await agent.taskSearchAndInvokeColdTool("fibonacci", { n: 8 });
    assert.strictEqual(Number(fibResult), 21, "8th Fibonacci number should be 21");
    console.log("👉 Test 3 Passed: Cold tool found and invoked bypassing cache.\n");

    console.log("------------------------------------------------------------------");
    console.log("🧪  TEST CASE 4: Autonomous Self-Bootstrapping (Weather Service)");
    console.log("------------------------------------------------------------------");
    const weatherReport = await agent.taskAcquireAndQueryWeather("Tokyo", 3);
    assert(weatherReport && weatherReport.includes("Tokyo"), "Report should include city Tokyo");
    assert(weatherReport.includes("3d"), "Report should include days");
    console.log("👉 Test 4 Passed: Missing capability self-bootstrapped & executed.\n");

    console.log("------------------------------------------------------------------");
    console.log("🧪  TEST CASE 5: Cleanup & Unmounting Dynamically Added Server");
    console.log("------------------------------------------------------------------");
    agent.log("ACTION", "Cleaning up dynamically mounted 'weather_service'...");
    await agent.executeTool("studio__server__remove", { id: "weather_service" });
    await new Promise((r) => setTimeout(r, 400));
    await agent.refreshTools();
    assert(!agent.hasTool("weather_service__get_forecast"), "Weather tool should no longer be registered");
    console.log("👉 Test 5 Passed: Dynamic server cleanly unmounted.\n");

    console.log("------------------------------------------------------------------");
    console.log("🧪  TEST CASE 6: Client 5-Layer Discovery Funnel Scan");
    console.log("------------------------------------------------------------------");
    const clients = await agent.taskScanClients();
    assert(Array.isArray(clients) && clients.length > 0, "Clients list must be non-empty");
    const cursorClient = clients.find((c) => c.clientId === "cursor");
    assert(cursorClient, "Cursor client must be in registered adapter catalog");
    console.log(`👉 Test 6 Passed: Found ${clients.length} client definitions including ${cursorClient.displayName}.\n`);

    console.log("==================================================================");
    console.log("🎉  ALL MICRO-AGENT TESTS PASSED SUCCESSFULLY!  🎉");
    console.log("==================================================================");
  } catch (err) {
    console.error("\n❌ MICRO-AGENT TEST SUITE FAILED:", err);
    process.exitCode = 1;
  } finally {
    await agent.stop();
  }
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
