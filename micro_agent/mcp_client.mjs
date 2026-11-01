import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { EventEmitter } from "node:events";

/**
 * Lightweight MCP Client connector via Stdio Shim.
 * Communicates with MCP Workbench Gateway using the standard JSON-RPC 2.0 protocol.
 */
export class McpClient extends EventEmitter {
  constructor(rootDir) {
    super();
    this.rootDir = path.resolve(rootDir);
    this.shimScript = path.join(this.rootDir, "dist", "stdio_shim.js");
    this.child = null;
    this.rl = null;
    this.requestId = 1;
    this.pendingRequests = new Map();
  }

  /**
   * Spawns the stdio shim and sets up JSON-RPC communication lines.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.child = spawn("node", [this.shimScript], {
        cwd: this.rootDir,
        env: {
          ...process.env,
          MCP_WORKBENCH_ROOT: this.rootDir,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      this.child.on("error", (err) => {
        reject(new Error(`Failed to spawn MCP Shim: ${err.message}`));
      });

      this.child.on("exit", (code) => {
        this.emit("disconnect", code);
      });

      this.rl = readline.createInterface({
        input: this.child.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed);
          this.handleMessage(msg);
        } catch {
          // ignore non-json lines
        }
      });

      // Handle stderr
      this.child.stderr.on("data", (data) => {
        this.emit("stderr", data.toString());
      });

      // Allow a brief moment for child process pipe establishment
      setTimeout(resolve, 300);
    });
  }

  handleMessage(msg) {
    // If it's a response to a pending request
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }
    }

    // If it's a notification from the gateway
    if (msg.method) {
      this.emit("notification", msg.method, msg.params);
      if (msg.method === "notifications/tools/list_changed") {
        this.emit("tools_changed");
      }
    }
  }

  /**
   * Sends a JSON-RPC request and returns the result.
   */
  async request(method, params = {}, timeoutMs = 8000) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("McpClient is not connected.");
    }

    const id = this.requestId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out (${method}, id=${id}) after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  /**
   * Standard MCP Handshake
   */
  async initialize(clientInfo = { name: "micro-agent", version: "0.1.0" }) {
    const res = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo,
    });

    // Notify server that client initialization is complete
    this.child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }) + "\n"
    );

    return res;
  }

  /**
   * Lists exposed tools
   */
  async listTools() {
    const res = await this.request("tools/list", {});
    return res.tools || [];
  }

  /**
   * Calls a tool by name with arguments
   */
  async callTool(name, args = {}) {
    const res = await this.request("tools/call", {
      name,
      arguments: args,
    });
    return res;
  }

  /**
   * Closes the MCP Client connection cleanly
   */
  async close() {
    if (this.rl) {
      this.rl.close();
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
    }
    this.pendingRequests.clear();
  }
}
