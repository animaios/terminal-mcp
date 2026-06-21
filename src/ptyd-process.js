import { spawn } from 'node:child_process';
import { access, constants, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const SOCKET_WAIT_TIMEOUT = 5000;
const SOCKET_POLL_INTERVAL = 50;
const STOP_GRACE_MS = 3000;

/**
 * Manages the ptyd daemon subprocess lifecycle.
 * Spawns the C binary, waits for its Unix socket, and cleans up on stop.
 */
export class PtydProcess {
  constructor() {
    /** @type {import('node:child_process').ChildProcess | null} */
    this._process = null;
    this._socketPath = null;
  }

  /**
   * Start the ptyd daemon and wait for its socket to become available.
   * @returns {Promise<{socketPath: string, pid: number}>}
   */
  async start() {
    const binPath = resolvePtydBinary();

    return new Promise((resolvePromise, reject) => {
      const proc = spawn(binPath, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this._process = proc;

      let started = false;

      const timer = setTimeout(() => {
        if (!started) {
          reject(new Error(`ptyd did not produce socket within ${SOCKET_WAIT_TIMEOUT}ms`));
          proc.kill('SIGKILL');
        }
      }, SOCKET_WAIT_TIMEOUT);

      proc.stdout.on('data', (chunk) => {
        const line = chunk.toString('utf8').trim();
        const match = line.match(/^SOCKET\s+(.+)$/);
        if (match && !started) {
          started = true;
          clearTimeout(timer);
          this._socketPath = match[1];
          resolvePromise({ socketPath: this._socketPath, pid: proc.pid });
        }
      });

      proc.stderr.on('data', (chunk) => {
        process.stderr.write(`[ptyd] ${chunk}`);
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (!started) reject(new Error(`Failed to spawn ptyd: ${err.message}`));
      });

      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (!started) {
          reject(new Error(`ptyd exited before starting (code=${code}, signal=${signal})`));
        } else {
          // Daemon died after starting — clean up socket
          this._cleanupSocket();
        }
        this._process = null;
      });
    });
  }

  /**
   * Stop the daemon gracefully (SIGTERM → wait → SIGKILL).
   */
  async stop() {
    const proc = this._process;
    if (!proc) return;

    proc.kill('SIGTERM');

    await new Promise((resolveDone) => {
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolveDone();
      }, STOP_GRACE_MS);

      proc.on('exit', () => {
        clearTimeout(killTimer);
        resolveDone();
      });
    });

    this._process = null;
    await this._cleanupSocket();
  }

  /** @returns {string | null} */
  get socketPath() {
    return this._socketPath;
  }

  /** @returns {boolean} */
  get alive() {
    return this._process !== null && this._process.exitCode === null;
  }

  async _cleanupSocket() {
    if (!this._socketPath) return;
    try {
      await unlink(this._socketPath);
    } catch {
      // Ignore — socket may already be gone
    }
  }
}

/**
 * Resolve the path to the ptyd binary.
 * Priority: PTYD_PATH env var → ptyd/ptyd relative to package → PATH fallback
 * @returns {string}
 */
function resolvePtydBinary() {
  // 1. Explicit env override
  if (process.env.PTYD_PATH) {
    return process.env.PTYD_PATH;
  }

  // 2. Standard location relative to package root
  const standard = join(PKG_ROOT, 'ptyd', 'ptyd');
  if (existsSync(standard)) return standard;

  // 3. Fall back to PATH
  return 'ptyd';
}
