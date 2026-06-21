import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import { randomUUID } from 'node:crypto';

const DEFAULT_CONNECT_TIMEOUT = 5000;
const DEFAULT_REQUEST_TIMEOUT = 10000;

/**
 * Client for the ptyd C daemon.
 * Communicates via JSON-lines over a Unix domain socket.
 *
 * Events:
 *   'output' (sessionId: number, data: Buffer)
 *   'exit'   (sessionId: number, { exitCode: number, signal: string|null })
 *   'error'  (Error)
 *   'close'  ()
 */
export class PtydClient extends EventEmitter {
  /**
   * @param {string} socketPath — Path to the Unix domain socket
   */
  constructor(socketPath) {
    super();
    this._socketPath = socketPath;
    this._socket = null;
    this._recvBuffer = '';
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this._pending = new Map();
    this._connected = false;
    this._closed = false;
  }

  /**
   * Connect to the daemon's Unix socket.
   * @param {number} [timeout=5000]
   * @returns {Promise<void>}
   */
  connect(timeout = DEFAULT_CONNECT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (this._connected) return resolve();

      const timer = setTimeout(() => {
        if (this._socket) this._socket.destroy();
        reject(new Error(`ptyd connect timeout after ${timeout}ms`));
      }, timeout);

      this._socket = netConnect({ path: this._socketPath });

      this._socket.on('connect', () => {
        clearTimeout(timer);
        this._connected = true;
        resolve();
      });

      this._socket.on('error', (err) => {
        clearTimeout(timer);
        if (!this._connected) {
          reject(new Error(`ptyd connect failed: ${err.message}`));
        } else {
          this.emit('error', err);
        }
      });

      this._socket.on('data', (chunk) => this._onData(chunk));

      this._socket.on('close', () => {
        this._connected = false;
        this._closed = true;
        // Reject all pending requests
        for (const [reqId, pending] of this._pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error('ptyd connection closed'));
        }
        this._pending.clear();
        this.emit('close');
      });
    });
  }

  /**
   * Disconnect from the daemon.
   */
  disconnect() {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._connected = false;
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Client disconnected'));
    }
    this._pending.clear();
  }

  /**
   * Start a new PTY session.
   * @param {object} opts
   * @param {string} opts.shell
   * @param {string[]} [opts.args]
   * @param {number} [opts.cols=120]
   * @param {number} [opts.rows=30]
   * @param {string} [opts.cwd]
   * @param {Record<string, string>} [opts.env]
   * @returns {Promise<{sessionId: number, pid: number}>}
   */
  async start({ shell, args = [], cols = 120, rows = 30, cwd, env = {} }) {
    const reqId = randomUUID();
    const resp = await this._request({
      type: 'start',
      reqId,
      shell,
      args,
      cols,
      rows,
      cwd: cwd || process.cwd(),
      env,
    }, DEFAULT_REQUEST_TIMEOUT);

    return { sessionId: resp.sessionId, pid: resp.pid };
  }

  /**
   * Write data to a PTY session (base64-encoded).
   * @param {number} sessionId
   * @param {string} data
   */
  write(sessionId, data) {
    this._send({
      type: 'write',
      sessionId,
      data: Buffer.from(data, 'utf8').toString('base64'),
    });
  }

  /**
   * Resize a PTY session's terminal.
   * @param {number} sessionId
   * @param {number} cols
   * @param {number} rows
   */
  resize(sessionId, cols, rows) {
    this._send({ type: 'resize', sessionId, cols, rows });
  }

  /**
   * Send a signal to a PTY session's process group.
   * @param {number} sessionId
   * @param {string} signal — e.g. 'SIGTERM', 'SIGKILL', 'SIGINT'
   */
  signal(sessionId, signal) {
    this._send({ type: 'signal', sessionId, signal });
  }

  /**
   * Kill a PTY session (sends SIGTERM to process group).
   * @param {number} sessionId
   */
  kill(sessionId) {
    this._send({ type: 'kill', sessionId });
  }

  /**
   * List active sessions.
   * @returns {Promise<Array<{sessionId: number, pid: number, alive: boolean}>>}
   */
  async list() {
    const reqId = randomUUID();
    const resp = await this._request({ type: 'list', reqId }, 5000);
    return resp.sessions || [];
  }

  /**
   * Ping the daemon.
   * @returns {Promise<boolean>}
   */
  async ping() {
    const reqId = randomUUID();
    const resp = await this._request({ type: 'ping', reqId }, 3000);
    return resp.pong === true;
  }

  /** @returns {boolean} */
  get connected() {
    return this._connected;
  }

  // ── Private ──────────────────────────────────────────────────────────

  /**
   * Handle incoming data from the socket.
   * Implements incremental JSON-lines parsing.
   * @param {Buffer} chunk
   */
  _onData(chunk) {
    this._recvBuffer += chunk.toString('utf8');

    let nlIdx;
    while ((nlIdx = this._recvBuffer.indexOf('\n')) !== -1) {
      const line = this._recvBuffer.slice(0, nlIdx).trim();
      this._recvBuffer = this._recvBuffer.slice(nlIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        this._dispatch(msg);
      } catch (err) {
        this.emit('error', new Error(`ptyd JSON parse error: ${err.message}`));
      }
    }
  }

  /**
   * Dispatch a parsed message from the daemon.
   * @param {object} msg
   */
  _dispatch(msg) {
    switch (msg.type) {
      case 'response': {
        const pending = this._pending.get(msg.reqId);
        if (pending) {
          clearTimeout(pending.timer);
          this._pending.delete(msg.reqId);
          pending.resolve(msg);
        }
        break;
      }
      case 'output': {
        const data = Buffer.from(msg.data, 'base64');
        this.emit('output', msg.sessionId, data);
        break;
      }
      case 'exit': {
        this.emit('exit', msg.sessionId, {
          exitCode: msg.exitCode ?? 0,
          signal: msg.signal ?? null,
        });
        break;
      }
      case 'error': {
        const err = new Error(msg.message || 'ptyd error');
        if (msg.reqId) {
          const pending = this._pending.get(msg.reqId);
          if (pending) {
            clearTimeout(pending.timer);
            this._pending.delete(msg.reqId);
            pending.reject(err);
            break;
          }
        }
        this.emit('error', err);
        break;
      }
      default:
        // Unknown message type — ignore
        break;
    }
  }

  /**
   * Send a fire-and-forget JSON message.
   * @param {object} obj
   */
  _send(obj) {
    if (!this._connected || !this._socket) {
      throw new Error('ptyd client not connected');
    }
    this._socket.write(JSON.stringify(obj) + '\n');
  }

  /**
   * Send a request and wait for a correlated response.
   * @param {object} obj — Must include `reqId`
   * @param {number} timeout
   * @returns {Promise<object>}
   */
  _request(obj, timeout) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this._socket) {
        return reject(new Error('ptyd client not connected'));
      }

      const timer = setTimeout(() => {
        this._pending.delete(obj.reqId);
        reject(new Error(`ptyd request timeout (${obj.type})`));
      }, timeout);

      this._pending.set(obj.reqId, { resolve, reject, timer });
      this._socket.write(JSON.stringify(obj) + '\n');
    });
  }
}
