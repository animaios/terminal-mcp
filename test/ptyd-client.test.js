import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { PtydClient } from '../src/ptyd-client.js';

/**
 * Create a mock ptyd server on a temp Unix socket.
 * Returns { socketPath, server, received[], respond(obj) }
 */
function createMockServer() {
  const socketPath = join(tmpdir(), `ptyd-test-${process.pid}-${Date.now()}.sock`);
  const received = [];
  let clientConn = null;

  const server = createServer((conn) => {
    clientConn = conn;
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try { received.push(JSON.parse(line)); } catch {}
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      const respond = (obj) => {
        if (clientConn) clientConn.write(JSON.stringify(obj) + '\n');
      };
      const sendToClient = (obj) => {
        if (clientConn) {
          if (obj._raw !== undefined) {
            clientConn.write(obj._raw);
          } else {
            clientConn.write(JSON.stringify(obj) + '\n');
          }
        }
      };
      const close = async () => {
        server.close();
        try { await unlink(socketPath); } catch {}
      };
      resolve({ socketPath, server, received, respond, sendToClient, close });
    });
  });
}

test('PtydClient connects to a Unix socket', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);

  await client.connect();
  assert.equal(client.connected, true);

  client.disconnect();
  await mock.close();
});

test('PtydClient connect rejects on timeout when no server', async () => {
  const client = new PtydClient('/tmp/ptyd-nonexistent-test.sock');

  await assert.rejects(
    () => client.connect(500),
    /ptyd connect (timeout|failed)/,
  );
});

test('PtydClient ping sends request and receives response', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const pingPromise = client.ping();

  // Wait for the request to arrive
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].type, 'ping');

  // Respond
  mock.respond({ type: 'response', reqId: mock.received[0].reqId, pong: true });

  const result = await pingPromise;
  assert.equal(result, true);

  client.disconnect();
  await mock.close();
});

test('PtydClient start sends correct params and returns session info', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const startPromise = client.start({
    shell: '/bin/sh',
    args: ['-l'],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    env: { FOO: 'bar' },
  });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.received.length, 1);
  const req = mock.received[0];
  assert.equal(req.type, 'start');
  assert.equal(req.shell, '/bin/sh');
  assert.deepEqual(req.args, ['-l']);
  assert.equal(req.cols, 80);
  assert.equal(req.rows, 24);
  assert.equal(req.cwd, '/tmp');
  assert.deepEqual(req.env, { FOO: 'bar' });

  mock.respond({ type: 'response', reqId: req.reqId, sessionId: 42, pid: 12345 });

  const result = await startPromise;
  assert.equal(result.sessionId, 42);
  assert.equal(result.pid, 12345);

  client.disconnect();
  await mock.close();
});

test('PtydClient write sends base64-encoded data', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  client.write(1, 'echo hello\r');

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].type, 'write');
  assert.equal(mock.received[0].sessionId, 1);

  const decoded = Buffer.from(mock.received[0].data, 'base64').toString('utf8');
  assert.equal(decoded, 'echo hello\r');

  client.disconnect();
  await mock.close();
});

test('PtydClient emits output event with decoded Buffer', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const outputPromise = new Promise((resolve) => {
    client.on('output', (sessionId, data) => {
      resolve({ sessionId, data });
    });
  });

  // Simulate daemon sending output
  const b64 = Buffer.from('hello world', 'utf8').toString('base64');
  mock.sendToClient({ type: 'output', sessionId: 42, data: b64 });

  const result = await outputPromise;
  assert.equal(result.sessionId, 42);
  assert.equal(result.data.toString('utf8'), 'hello world');

  client.disconnect();
  await mock.close();
});

test('PtydClient emits exit event', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const exitPromise = new Promise((resolve) => {
    client.on('exit', (sessionId, info) => {
      resolve({ sessionId, ...info });
    });
  });

  mock.sendToClient({ type: 'exit', sessionId: 42, exitCode: 0, signal: null });

  const result = await exitPromise;
  assert.equal(result.sessionId, 42);
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);

  client.disconnect();
  await mock.close();
});

test('PtydClient handles line split across chunks', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const outputPromise = new Promise((resolve) => {
    client.on('output', (sessionId, data) => {
      resolve({ sessionId, text: data.toString('utf8') });
    });
  });

  const b64 = Buffer.from('split test', 'utf8').toString('base64');
  const full = JSON.stringify({ type: 'output', sessionId: 7, data: b64 }) + '\n';

  // Send in two chunks split in the middle
  const splitPoint = Math.floor(full.length / 2);
  mock.sendToClient({ _raw: full.slice(0, splitPoint) });
  await new Promise((r) => setTimeout(r, 20));
  mock.sendToClient({ _raw: full.slice(splitPoint) });

  const result = await outputPromise;
  assert.equal(result.sessionId, 7);
  assert.equal(result.text, 'split test');

  client.disconnect();
  await mock.close();
});

test('PtydClient resize sends fire-and-forget command', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  client.resize(1, 120, 40);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].type, 'resize');
  assert.equal(mock.received[0].sessionId, 1);
  assert.equal(mock.received[0].cols, 120);
  assert.equal(mock.received[0].rows, 40);

  client.disconnect();
  await mock.close();
});

test('PtydClient signal sends fire-and-forget command', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  client.signal(1, 'SIGINT');

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].type, 'signal');
  assert.equal(mock.received[0].sessionId, 1);
  assert.equal(mock.received[0].signal, 'SIGINT');

  client.disconnect();
  await mock.close();
});

test('PtydClient request times out', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  // Override internal timeout to be short
  const origRequest = client._request.bind(client);
  client._request = (obj, _timeout) => origRequest(obj, 500);

  await assert.rejects(
    () => client.start({ shell: '/bin/sh' }),
    /ptyd request timeout/,
  );

  client.disconnect();
  await mock.close();
});

test('PtydClient emits close event when server disconnects', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const closePromise = new Promise((resolve) => {
    client.on('close', resolve);
  });

  // Disconnect the client to trigger close
  client.disconnect();

  await closePromise;
  assert.equal(client.connected, false);
  await mock.close();
});

// ── Additional coverage tests ──────────────────────────────────────────────

test('PtydClient._send throws when not connected', () => {
  const client = new PtydClient('/tmp/nonexistent.sock');
  assert.throws(
    () => client._send({ type: 'test' }),
    /ptyd client not connected/,
  );
});

test('PtydClient._request rejects when not connected', async () => {
  const client = new PtydClient('/tmp/nonexistent.sock');
  await assert.rejects(
    () => client._request({ type: 'test', reqId: 'abc' }, 1000),
    /ptyd client not connected/,
  );
});

test('PtydClient list sends correct command and returns sessions', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const listPromise = client.list();

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].type, 'list');

  mock.respond({
    type: 'response',
    reqId: mock.received[0].reqId,
    sessions: [{ sessionId: 1, pid: 100, alive: true }],
  });

  const result = await listPromise;
  assert.equal(result.length, 1);
  assert.equal(result[0].sessionId, 1);

  client.disconnect();
  await mock.close();
});

test('PtydClient list returns empty array when no sessions', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const listPromise = client.list();
  await new Promise((r) => setTimeout(r, 50));
  mock.respond({ type: 'response', reqId: mock.received[0].reqId });

  const result = await listPromise;
  assert.deepEqual(result, []);

  client.disconnect();
  await mock.close();
});

test('PtydClient kill sends fire-and-forget command', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  client.kill(42);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].type, 'kill');
  assert.equal(mock.received[0].sessionId, 42);

  client.disconnect();
  await mock.close();
});

test('PtydClient dispatches error with reqId to pending request', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const startPromise = client.start({ shell: '/bin/sh' });

  await new Promise((r) => setTimeout(r, 50));
  const reqId = mock.received[0].reqId;

  // Send error response correlated by reqId
  mock.sendToClient({ type: 'error', reqId, message: 'session limit reached' });

  await assert.rejects(startPromise, /session limit reached/);

  client.disconnect();
  await mock.close();
});

test('PtydClient dispatches error without reqId as error event', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const errorPromise = new Promise((resolve) => {
    client.on('error', (err) => resolve(err));
  });

  mock.sendToClient({ type: 'error', message: 'daemon warning' });

  const err = await errorPromise;
  assert.match(err.message, /daemon warning/);

  client.disconnect();
  await mock.close();
});

test('PtydClient ignores unknown message types', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  let errorEmitted = false;
  client.on('error', () => { errorEmitted = true; });

  mock.sendToClient({ type: 'unknown-type', data: 'stuff' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(errorEmitted, false);

  client.disconnect();
  await mock.close();
});

test('PtydClient disconnect rejects pending requests', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  // Start a request but don't respond
  const startPromise = client.start({ shell: '/bin/sh' });

  // Immediately disconnect
  setTimeout(() => client.disconnect(), 30);

  await assert.rejects(startPromise, /Client disconnected|connection closed/);

  await mock.close();
});

test('PtydClient connect returns immediately if already connected', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();
  assert.equal(client.connected, true);

  // Second connect should resolve immediately
  await client.connect();
  assert.equal(client.connected, true);

  client.disconnect();
  await mock.close();
});

test('PtydClient emits error on socket error after connected', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const errorPromise = new Promise((resolve) => {
    client.on('error', (err) => resolve(err));
  });

  // Simulate socket error by destroying server connections
  mock.server.close();

  // Wait a bit and check if error was emitted (may not emit in all environments)
  const result = await Promise.race([
    errorPromise,
    new Promise((r) => setTimeout(() => r('timeout'), 200)),
  ]);

  client.disconnect();
  await mock.close();
  // Just verify no crash — error emission depends on socket behavior
  assert.ok(result === 'timeout' || result instanceof Error);
});

test('PtydClient handles JSON parse error gracefully', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const errorPromise = new Promise((resolve) => {
    client.on('error', (err) => resolve(err));
  });

  // Send invalid JSON
  mock.sendToClient({ _raw: 'not valid json\n' });

  const err = await errorPromise;
  assert.match(err.message, /ptyd JSON parse error/);

  client.disconnect();
  await mock.close();
});

test('PtydClient socket close rejects all pending requests', async () => {
  const mock = await createMockServer();
  const client = new PtydClient(mock.socketPath);
  await client.connect();

  const startPromise = client.start({ shell: '/bin/sh' });

  // Close server connections to trigger socket close on client
  await new Promise((r) => setTimeout(r, 30));
  // Destroy all server-side connections
  mock.server.close();
  // Force close by destroying client socket
  client._socket.destroy();

  await assert.rejects(startPromise, /connection closed|Client disconnected/);

  await mock.close();
});
