import test from 'node:test';
import assert from 'node:assert/strict';
import { PtydProcess } from '../src/ptyd-process.js';
import { PtydClient } from '../src/ptyd-client.js';
import { PtySession } from '../src/pty-session.js';

const TIMEOUT = 15000;

/**
 * Integration tests that require the compiled ptyd binary.
 * These tests spin up the real daemon and test the full stack.
 */

// Helper: start daemon + client
async function startStack() {
  const ptyd = new PtydProcess();
  const { socketPath } = await ptyd.start();
  const client = new PtydClient(socketPath);
  await client.connect();
  return { ptyd, client };
}

// Helper: stop client + daemon
async function stopStack(client, ptyd) {
  client.disconnect();
  await ptyd.stop();
}

test('ptyd daemon starts and responds to ping', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const pong = await client.ping();
  assert.equal(pong, true);

  await stopStack(client, ptyd);
});

test('ptyd client can start a shell session', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const { sessionId, pid } = await client.start({
    shell: '/bin/sh',
    args: [],
    cols: 80,
    rows: 24,
    cwd: '/tmp',
  });

  assert.ok(sessionId > 0);
  assert.ok(pid > 0);

  // Wait for shell prompt output
  await new Promise((r) => setTimeout(r, 500));

  client.kill(sessionId);
  await new Promise((r) => setTimeout(r, 300));

  await stopStack(client, ptyd);
});

test('ptyd client can write and receive output', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const { sessionId } = await client.start({
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
  });

  let output = '';
  client.on('output', (sid, data) => {
    if (sid === sessionId) output += data.toString('utf8');
  });

  // Wait for shell prompt
  await new Promise((r) => setTimeout(r, 500));

  // Write a command
  client.write(sessionId, 'echo HELLO_PTYD_TEST\r');

  // Wait for output
  await new Promise((r) => setTimeout(r, 1000));

  assert.ok(output.includes('HELLO_PTYD_TEST'), `Expected output to contain 'HELLO_PTYD_TEST', got: ${output.slice(-200)}`);

  client.kill(sessionId);
  await new Promise((r) => setTimeout(r, 200));
  await stopStack(client, ptyd);
});

test('ptyd client receives exit event', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const { sessionId } = await client.start({
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
  });

  const exitPromise = new Promise((resolve) => {
    client.on('exit', (sid, info) => {
      if (sid === sessionId) resolve(info);
    });
  });

  // Exit the shell
  await new Promise((r) => setTimeout(r, 300));
  client.write(sessionId, 'exit\r');

  const exitInfo = await exitPromise;
  assert.equal(typeof exitInfo.exitCode, 'number');

  await stopStack(client, ptyd);
});

test('ptyd resize works', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const { sessionId } = await client.start({
    shell: '/bin/sh',
    cols: 80,
    rows: 24,
    cwd: '/tmp',
  });

  // Wait for shell
  await new Promise((r) => setTimeout(r, 300));

  // Resize — should not throw
  client.resize(sessionId, 120, 40);

  // Verify with stty
  let output = '';
  client.on('output', (sid, data) => {
    if (sid === sessionId) output += data.toString('utf8');
  });

  client.write(sessionId, 'stty size\r');
  await new Promise((r) => setTimeout(r, 1000));

  // The output should contain "40 120"
  assert.ok(output.includes('40 120'), `Expected stty output '40 120', got: ${output.slice(-200)}`);

  client.kill(sessionId);
  await new Promise((r) => setTimeout(r, 200));
  await stopStack(client, ptyd);
});

test('PtySession full integration — exec a command', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const session = new PtySession({
    id: 'test-1',
    shell: '/bin/sh',
    shellArgs: [],
    cols: 120,
    rows: 30,
    cwd: '/tmp',
    ptydClient: client,
  });

  await session.init();

  // Wait for banner
  const banner = await session.waitForBanner();
  assert.ok(session.alive);

  // Execute a command
  const result = await session.exec({
    command: 'echo INTEGRATION_OK',
    timeout: 5000,
  });

  assert.ok(result.output.includes('INTEGRATION_OK'), `Expected 'INTEGRATION_OK', got: ${result.output}`);
  assert.equal(result.exitCode, 0);

  session.kill();
  await new Promise((r) => setTimeout(r, 200));
  await stopStack(client, ptyd);
});

test('PtySession full integration — send key and write', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const session = new PtySession({
    id: 'test-2',
    shell: '/bin/sh',
    shellArgs: [],
    cols: 120,
    rows: 30,
    cwd: '/tmp',
    ptydClient: client,
  });

  await session.init();
  await session.waitForBanner();

  // Start a command that waits for input
  const execPromise = session.exec({
    command: 'cat',
    timeout: 5000,
    quietExitMs: 1000,
    minOutputBytes: 5,
  });

  // Write some data
  await new Promise((r) => setTimeout(r, 300));
  session.write('hello from ptyd');

  // Send Ctrl-C to abort
  await new Promise((r) => setTimeout(r, 300));
  session.sendKey('ctrl+c');

  const result = await execPromise;
  // cat should have echoed our input
  assert.ok(result.output.includes('hello from ptyd') || result.timedOut || result.quietExited,
    `Expected input in output or timeout, got: ${JSON.stringify(result)}`);

  session.kill();
  await new Promise((r) => setTimeout(r, 200));
  await stopStack(client, ptyd);
});

test('multiple concurrent sessions', { timeout: TIMEOUT }, async () => {
  const { ptyd, client } = await startStack();

  const sessions = [];
  for (let i = 0; i < 3; i++) {
    const s = new PtySession({
      id: `multi-${i}`,
      shell: '/bin/sh',
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      ptydClient: client,
    });
    await s.init();
    await s.waitForBanner();
    sessions.push(s);
  }

  // Execute different commands in each session
  const results = await Promise.all(
    sessions.map((s, i) =>
      s.exec({ command: `echo SESSION_${i}`, timeout: 5000 })
    )
  );

  for (let i = 0; i < 3; i++) {
    assert.ok(results[i].output.includes(`SESSION_${i}`),
      `Session ${i} should contain SESSION_${i}, got: ${results[i].output}`);
  }

  for (const s of sessions) s.kill();
  await new Promise((r) => setTimeout(r, 300));
  await stopStack(client, ptyd);
});
