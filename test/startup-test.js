/**
 * Start-up smoke test: validates that the server can start, connect to the ptyd
 * daemon, create a session, and run a command — all within a reasonable timeout.
 *
 * Usage:
 *   node test/startup-test.js
 *   # or via test runner:
 *   node --test test/startup-test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSandboxServer } from "../src/index.js";
import { PtydProcess } from "../src/ptyd-process.js";
import { PtydClient } from "../src/ptyd-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SERVER_START_TIMEOUT = 8000;
const CMD_TIMEOUT = 5000;
const LOG = (...args) =>
  process.stderr.write(`[startup-test] ${args.join(" ")}\n`);

// ── 1. Binary exists check ──────────────────────────────────────────

test("ptyd binary exists and is executable", () => {
  const bin = join(__dirname, "..", "ptyd", "ptyd");
  const ok = existsSync(bin) && (statSync(bin).mode & 0o111) !== 0;
  assert.ok(ok, `ptyd binary not found or not executable at ${bin}`);
});

// ── 2. PtydProcess spawns and produces a socket ─────────────────────
// This mirrors exactly what src/index.js does.

test(
  "full startup: PtydProcess → PtydClient → SessionManager → session → command",
  { timeout: 30000 },
  async () => {
    // 1. Spawn the daemon
    const ptyd = new PtydProcess();
    let daemonStart;
    try {
      daemonStart = Date.now();
      const { socketPath, pid } = await ptyd.start();
      const elapsed = Date.now() - daemonStart;
      LOG(`daemon started (pid=${pid}, socket=${socketPath}) in ${elapsed}ms`);
      assert.ok(
        elapsed < SERVER_START_TIMEOUT,
        `daemon start took ${elapsed}ms, expected < ${SERVER_START_TIMEOUT}`,
      );
    } catch (err) {
      // If daemon failed, collect diagnostics
      LOG(`FAILED to start ptyd daemon: ${err.message}`);
      // Check daemon alive
      LOG(`ptyd.alive = ${ptyd.alive}`);
      throw err;
    }

    // 2. Connect the JS client
    const clientStart = Date.now();
    const ptydClient = new PtydClient(ptyd.socketPath);
    await ptydClient.connect();
    LOG(`ptyd client connected in ${Date.now() - clientStart}ms`);

    // 3. Create the sandbox server (same as index.js does)
    const { server, manager } = createSandboxServer({ ptydClient });
    LOG("sandbox server created");

    // 4. Create a session
    const sessionStart = Date.now();
    const session = await manager.create({
      shell: "/bin/bash",
      cols: 120,
      rows: 30,
      cwd: "/tmp",
    });
    assert.ok(session, "session should be created");
    assert.ok(session.alive, "session should be alive");
    LOG(`session created (id=${session.id}) in ${Date.now() - sessionStart}ms`);

    // 5. Run a command
    const result = await session.exec({
      command: "echo 'hello-startup'",
      timeout: CMD_TIMEOUT,
    });
    assert.equal(result.exitCode, 0, "exit code should be 0");
    assert.ok(
      result.output.includes("hello-startup"),
      `output should contain "hello-startup", got: ${JSON.stringify(result.output)}`,
    );
    LOG(`command executed in session: output=${JSON.stringify(result.output)}`);

    // 6. List sessions
    const sessions = manager.list();
    assert.ok(sessions.length > 0, "should have active sessions");
    LOG(`manager.list(): ${sessions.length} session(s)`);

    // 7. Clean up
    manager.destroyAll();
    await ptyd.stop();
    LOG("clean shutdown complete");
  },
);

// ── 3. Direct npm start check (validate that the full pipeline works) ─

test(
  "npm start launches and the server is responsive via stdio",
  { timeout: 25000 },
  async () => {
    // Spawn `node src/index.js` and verify it outputs the right startup
    // messages on stderr before it waits for MCP transport.
    const proc = spawn("node", ["src/index.js"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderrLines = [];
    proc.stderr.on("data", (chunk) => {
      stderrLines.push(...chunk.toString("utf-8").split("\n").filter(Boolean));
    });

    // Wait for the server-ready log line
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error("Server did not produce startup messages within timeout"),
        );
      }, SERVER_START_TIMEOUT);
      proc.stderr.on("data", function handler(chunk) {
        const text = chunk.toString("utf-8");
        if (text.includes("Server started on stdio transport")) {
          clearTimeout(timer);
          proc.stderr.removeListener("data", handler);
          resolve();
        }
      });
    });

    // Server is now waiting for MCP protocol — kill it and wait for exit
    proc.kill("SIGTERM");
    await new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 6000);
      proc.on("exit", () => {
        clearTimeout(forceTimer);
        resolve();
      });
    });

    // Verify key startup messages appeared
    const allLogs = stderrLines.join("\n");
    LOG(`startup logs:\n${allLogs}`);

    assert.ok(
      allLogs.includes("ptyd daemon started"),
      "should contain daemon started message",
    );
    assert.ok(
      allLogs.includes("Connected to ptyd daemon"),
      "should contain connected message",
    );
    assert.ok(
      allLogs.includes("Server started on stdio transport"),
      "should contain server started message",
    );
  },
);
