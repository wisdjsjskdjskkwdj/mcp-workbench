import path from "node:path";
import { McpClient } from "../core/mcp_client.mjs";
import { ReplSession } from "./repl.mjs";

export class CliRunner {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    this.client = new McpClient(this.rootDir);
  }

  async run(cliArgs = []) {
    if (cliArgs.length > 0) {
      // One-shot execution mode
      const session = new ReplSession(this.client, this.rootDir);
      try {
        await this.client.connect();
        await this.client.initialize({
          name: "mcp-workbench-oneshot",
          version: "1.0.0",
        });
        await session.refreshTools();
        await session.dispatch(cliArgs.join(" "));
      } catch (err) {
        console.error("Execution error:", err);
      } finally {
        await this.client.close();
        process.exit(0);
      }
    } else {
      // Interactive REPL mode
      const session = new ReplSession(this.client, this.rootDir);
      await session.start();
    }
  }
}
