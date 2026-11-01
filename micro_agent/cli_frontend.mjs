import path from "node:path";
import { CliRunner } from "./cli/runner.mjs";
import { ReplSession } from "./cli/repl.mjs";
import { McpClient } from "./core/mcp_client.mjs";

/**
 * Backwards-compatible Facade for CLI Frontend.
 * Delegates to modularized components in ./cli/ and ./core/.
 */
export class CliFrontend {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.client = new McpClient(this.rootDir);
    this.session = new ReplSession(this.client, this.rootDir);
  }

  get tools() {
    return this.session.tools;
  }

  async refreshTools() {
    return this.session.refreshTools();
  }

  async handleCommand(cmdLine) {
    return this.session.dispatch(cmdLine);
  }

  async start() {
    return this.session.start();
  }
}

// Direct CLI launch
if (process.argv[1] && process.argv[1].endsWith("cli_frontend.mjs")) {
  const rootDir = process.env.MCP_WORKBENCH_ROOT || path.resolve(".");
  const runner = new CliRunner(rootDir);
  void runner.run(process.argv.slice(2));
}
