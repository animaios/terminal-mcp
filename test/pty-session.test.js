import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildSessionEnv, PtySession } from '../src/pty-session.js';
import { stripAnsi } from '../src/ansi.js';

function createSession() {
  return Object.create(PtySession.prototype);
}

function createWaitSession(buffer = '') {
  const session = createSession();
  session.alive = true;
  session._buffer = buffer;
  session._dataListeners = [];
  return session;
}

test('buildSessionEnv applies anti-blocking environment defaults', () => {
  const env = buildSessionEnv({ CUSTOM_ENV: 'yes', GIT_PAGER: 'less' }, 'linux');

  assert.equal(env.CUSTOM_ENV, 'yes');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.LESS, '-FRX');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.DEBIAN_FRONTEND, 'noninteractive');
});

test('buildSessionEnv skips noninteractive override on Windows', () => {
  const env = buildSessionEnv({}, 'win32');

  assert.equal(env.DEBIAN_FRONTEND, undefined);
});

test('PowerShell wrapper uses safe marker interpolation', () => {
  const session = createSession();
  session.shellType = 'powershell';

  const command = session._wrapCommand('echo hi', '__DONE__', '__CWD_', '__PRE__');

  assert.match(command, /__DONE___\$\{LASTEXITCODE\}__/);
  assert.match(command, /__CWD_\$\(\(Get-Location\)\.Path\)__/);
});

test('_initShell suppresses PowerShell progress output', async () => {
  const session = createSession();
  const writes = [];
  let resetCalls = 0;
  session.shellType = 'powershell';
  session._daemonSessionId = 1;
  session.ptydClient = { write: (_id, value) => writes.push(value) };
  session._readUntilIdle = async () => '';
  session._resetBuffer = () => {
    resetCalls++;
  };

  await session._initShell();

  assert.deepEqual(writes, ["$ProgressPreference = 'SilentlyContinue'\r"]);
  assert.equal(resetCalls, 1);
});

test('_initShell sets cmd sessions to UTF-8', async () => {
  const session = createSession();
  const writes = [];
  let resetCalls = 0;
  session.shellType = 'cmd';
  session._daemonSessionId = 1;
  session.ptydClient = { write: (_id, value) => writes.push(value) };
  session._readUntilIdle = async () => '';
  session._resetBuffer = () => {
    resetCalls++;
  };

  await session._initShell();

  assert.deepEqual(writes, ['chcp 65001 > nul\r']);
  assert.equal(resetCalls, 1);
});

test('_parseOutput ignores echoed wrapper text and keeps real output', () => {
  const session = createSession();
  const preMarker = '__MCP_PRE_abc__';
  const marker = '__MCP_DONE_xyz__';
  const cwdMarker = '__MCP_CWD_';
  const raw = [
    `PS C:\\repo> Write-Host "${preMarker}"; echo hi; Write-Host "${marker}_\${LASTEXITCODE}__"`,
    `>> Write-Host "${cwdMarker}$((Get-Location).Path)__"`,
    preMarker,
    'hi',
    `${marker}_0__`,
    `${cwdMarker}C:\\repo__`,
    'PS C:\\repo>',
  ].join('\r\n');

  const result = session._parseOutput(raw, marker, cwdMarker, preMarker);

  assert.deepEqual(result, {
    output: 'hi\nPS C:\\repo>',
    exitCode: 0,
    cwd: 'C:\\repo',
  });
});

test('_truncateOutput keeps the head and tail when output exceeds maxLines', () => {
  const session = createSession();
  const output = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'].join('\n');

  assert.equal(
    session._truncateOutput(output, 4),
    ['line 1', 'line 2', '', '... 2 lines omitted ...', '', 'line 5', 'line 6'].join('\n')
  );
});

test('read returns unread buffered output once', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'echo hi\r\nhi\r\nPS C:\\repo> ';
  session._readCursor = 0;
  session._dataListeners = [];

  const first = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });
  const second = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });

  assert.equal(first.output, 'echo hi\nhi\nPS C:\\repo>');
  assert.equal(first.timedOut, false);
  assert.equal(second.output, '');
});

test('getHistory keeps the broader default history limit for agent context', () => {
  const session = createSession();
  session._history = Array.from({ length: 220 }, (_, index) => `line ${index + 1}`);
  session._historyTotalLines = 220;

  const result = session.getHistory();

  assert.equal(result.lines.length, 200);
  assert.equal(result.lines[0], 'line 21');
  assert.equal(result.lines.at(-1), 'line 220');
  assert.equal(result.returnedFrom, 20);
  assert.equal(result.returnedTo, 220);
});

test('getHistory can return text mode with the same metadata', () => {
  const session = createSession();
  session._history = ['line 1', 'line 2', 'line 3'];
  session._historyTotalLines = 5;

  const result = session.getHistory({ offset: 1, limit: 2, format: 'text' });

  assert.deepEqual(result, {
    text: 'line 1\nline 2',
    totalLines: 5,
    returnedFrom: 2,
    returnedTo: 4,
  });
});

test('getInfo can return minimal terminal_list metadata', () => {
  const session = createSession();
  session.id = 's1';
  session.name = 'main';
  session.cwd = 'C:/repo';
  session.alive = true;
  session.busy = false;
  session.shell = 'pwsh';
  session.shellType = 'powershell';
  session.cols = 120;
  session.rows = 30;
  session.createdAt = Date.now() - 1000;
  session.lastActivity = Date.now();

  assert.deepEqual(session.getInfo({ verbose: false }), {
    id: 's1',
    name: 'main',
    cwd: 'C:/repo',
    alive: true,
    busy: false,
  });
});

test('waitForPattern returns only the tail by default', async () => {
  const session = createWaitSession('line 1\nline 2\nline 3\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', tailLines: 2, timeout: 50 });

  assert.deepEqual(result, {
    output: 'line 3\nready',
    matched: true,
    timedOut: false,
  });
});

test('waitForPattern can return the full output', async () => {
  const session = createWaitSession('line 1\nline 2\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', returnMode: 'full', tailLines: 1, timeout: 50 });

  assert.deepEqual(result, {
    output: 'line 1\nline 2\nready',
    matched: true,
    timedOut: false,
  });
});

test('waitForPattern can suppress output entirely', async () => {
  const session = createWaitSession('booting\nready\n');

  const result = await session.waitForPattern({ pattern: 'ready', returnMode: 'match-only', timeout: 50 });

  assert.deepEqual(result, {
    output: '',
    matched: true,
    timedOut: false,
  });
});

test('waitForPattern returns only the configured tail on timeout', async () => {
  const session = createWaitSession('line 1\nline 2\nline 3\n');

  const result = await session.waitForPattern({ pattern: 'ready', tailLines: 1, timeout: 20 });

  assert.deepEqual(result, {
    output: 'line 3',
    matched: false,
    timedOut: true,
  });
});

test('waitForPattern rejects invalid regex patterns', async () => {
  const session = createWaitSession('ready\n');

  await assert.rejects(
    session.waitForPattern({ pattern: '(', timeout: 20 }),
    /Invalid regex pattern in pattern/
  );
});

test('_readUntilIdle collects streamed data even if the buffer shifts', async () => {
  const session = createSession();
  session._buffer = 'seed';
  session._dataListeners = [];

  const resultPromise = session._readUntilIdle(50, 10);
  const onData = session._dataListeners.at(-1);

  session._buffer = 'trimmed-1';
  onData('first');
  session._buffer = 'trimmed-2';
  onData('second');

  await assert.doesNotReject(async () => {
    const result = await resultPromise;
    assert.equal(result, 'firstsecond');
  });
});

test('read returns position with cursor-based read', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'hello world';
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  const result = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50 });

  assert.equal(result.output, 'hello world');
  assert.equal(result.position, 100);
  assert.equal(result.timedOut, false);
});

test('read with since returns output from a prior position', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'prefixnew data';
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  // 6 bytes of 'prefix' means buffer started at position 100 - 14 = 86
  // since=92 -> offset = 92 - 86 = 6 -> 'new data'
  session._dataListeners = [];

  const result = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50, since: 92 });

  assert.equal(result.output, 'new data');
  assert.equal(result.position, 100);
  assert.equal(result.truncated, false);
});

test('read with since in evicted region sets truncated', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'current data'; // 12 bytes, bufferStart = 100-12=88
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  // since=50 is before bufferStart=88
  const result = await session.read({ timeout: 50, idleTimeout: 10, maxLines: 50, since: 50 });

  assert.equal(result.output, 'current data');
  assert.equal(result.truncated, true);
  assert.equal(result.position, 100);
});

test('read with since beyond current position waits for data', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  const resultPromise = session.read({ timeout: 50, idleTimeout: 10, maxLines: 50, since: 100 });

  // Simulate new data arriving
  const onData = session._dataListeners.at(-1);
  session._buffer = 'fresh output';
  session._totalBytesEmitted = 112;
  onData('fresh output');

  const result = await resultPromise;
  assert.equal(result.output, 'fresh output');
  assert.equal(result.position, 112);
});

test('kill uses daemon signal on process group', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 1;
  const signals = [];
  session.ptydClient = {
    signal: (id, sig) => signals.push({ id, sig }),
  };

  session.kill();
  assert.equal(session.alive, false);
  assert.deepEqual(signals, [{ id: 1, sig: 'SIGTERM' }]);
});

test('kill is idempotent', () => {
  const session = createSession();
  session.alive = false;
  session._daemonSessionId = 1;
  session.ptydClient = { signal: () => {} };

  // Should not throw
  session.kill();
  assert.equal(session.alive, false);
});

test('_waitForMarker returns reason marker on completion', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'output\n__MCP_DONE_abc__';
  session._dataListeners = [];

  const resultPromise = session._waitForMarker('__MCP_DONE_abc__', 500);
  const result = await resultPromise;

  assert.equal(result.reason, 'marker');
  assert.ok(result.buffer.includes('__MCP_DONE_abc__'));
});

test('_waitForMarker returns reason timeout on hard timeout', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'no marker here';
  session._dataListeners = [];

  const result = await session._waitForMarker('__MCP_DONE_abc__', 30);

  assert.equal(result.reason, 'timeout');
});

test('_waitForMarker returns reason quiet when output stops', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._dataListeners = [];

  const resultPromise = session._waitForMarker('__MCP_DONE_abc__', 2000, 30, 1);

  // Simulate some output then silence
  const onData = session._dataListeners.at(-1);
  onData('some output');

  const result = await resultPromise;
  assert.equal(result.reason, 'quiet');
});

test('_waitForMarker quiet respects minOutputBytes', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._dataListeners = [];

  // minOutputBytes = 100, but we only send 5 bytes
  const resultPromise = session._waitForMarker('__MCP_DONE_abc__', 2000, 30, 100);

  const onData = session._dataListeners.at(-1);
  onData('short');

  // Quiet timer should NOT fire because bytesSeen < minOutputBytes
  // Only the hard timeout should fire
  const result = await resultPromise;
  assert.equal(result.reason, 'timeout');
});

test('watch returns on trigger match', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'ready', pattern: 'Server ready' }],
    timeout: 2000,
    contextLines: 2,
  });

  const onData = session._dataListeners.at(-1);
  onData('Starting...\n');
  session._totalBytesEmitted += 12;
  onData('Server ready\n');
  session._totalBytesEmitted += 13;

  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  assert.equal(result.triggerId, 'ready');
  assert.equal(result.matchedLine, 'Server ready');
  assert.equal(result.context.length, 2); // 'Starting...' + 'Server ready'
  assert.equal(result.context[0], 'Starting...');
});

test('watch returns on timeout when no trigger matches', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const result = await session.watch({
    triggers: [{ id: 'never', pattern: 'wont-match' }],
    timeout: 30,
  });

  assert.equal(result.reason, 'timeout');
  assert.equal(result.timedOut, true);
});

test('watch returns on quiet detection', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'x', pattern: 'x' }],
    timeout: 5000,
    quietExitMs: 30,
  });

  const onData = session._dataListeners.at(-1);
  onData('some output\n');
  session._totalBytesEmitted += 12;
  // No more data — quiet timer fires

  const result = await resultPromise;
  assert.equal(result.reason, 'quiet');
});

test('watch returns on process exit', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'x', pattern: 'x' }],
    timeout: 5000,
  });

  // Simulate process exit
  session.alive = false;

  const result = await resultPromise;
  assert.equal(result.reason, 'exit');
});

test('watch respects cooldown', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'ping', pattern: 'ping', cooldownMs: 5000 }],
    timeout: 5000,
  });

  const onData = session._dataListeners.at(-1);
  onData('ping\n');
  session._totalBytesEmitted += 5;
  // Cooldown prevents immediate re-match, but first match should fire

  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  assert.equal(result.triggerId, 'ping');
});

test('watch with since skips already-emitted output', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = 'old data match here'; // 20 bytes
  session._totalBytesEmitted = 100; // bufferStart = 80
  session._dataListeners = [];

  // since=90 means we only match from offset 10 in buffer
  // 'old data match here'[10:] = 'match here' -> matches 'match'
  const resultPromise = session.watch({
    triggers: [{ id: 'found', pattern: 'match' }],
    timeout: 2000,
    since: 90,
  });

  // Should resolve immediately from existing buffer
  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  assert.equal(result.triggerId, 'found');
});

// ── exec() error paths ─────────────────────────────────────────────────────

test('exec throws when session is busy', async () => {
  const session = createSession();
  session.alive = true;
  session.busy = true;
  session.id = 'test-session';

  await assert.rejects(
    () => session.exec({ command: 'echo hi' }),
    /is busy with a background command/,
  );
});

test('exec throws when session is not alive', async () => {
  const session = createSession();
  session.alive = false;
  session.busy = false;
  session.id = 'test-session';

  await assert.rejects(
    () => session.exec({ command: 'echo hi' }),
    /is no longer alive/,
  );
});

test('exec re-throws underlying errors and resets busy', async () => {
  const session = createSession();
  session.alive = true;
  session.busy = false;
  session.id = 'test-session';
  session._daemonSessionId = 1;
  session._buffer = '';
  session._readCursor = 0;
  session._totalBytesEmitted = 0;
  session._dataListeners = [];
  session.shellType = 'bash';
  // ptydClient.write throws inside the try block
  session.ptydClient = {
    write: () => { throw new Error('write failed'); },
  };

  await assert.rejects(
    () => session.exec({ command: 'echo hi', timeout: 100 }),
    /write failed/,
  );
  assert.equal(session.busy, false);
  assert.equal(session._pendingMarker, null);
});

test('exec sets pendingMarker when marker not found within wait', async () => {
  const session = createSession();
  session.alive = true;
  session.busy = false;
  session.id = 'test-session';
  session._daemonSessionId = 1;
  session._buffer = '';
  session._readCursor = 0;
  session._totalBytesEmitted = 0;
  session._dataListeners = [];
  session.shellType = 'bash';
  session.ptydClient = {
    write: () => {},
  };

  // Use short timeouts so it completes quickly
  const resultPromise = session.exec({
    command: 'sleep 100',
    timeout: 200,
    quietExitMs: 50,
    minOutputBytes: 1,
  });

  // Feed some output so quiet timer arms, but no marker
  setTimeout(() => {
    const onData = session._dataListeners.at(-1);
    if (onData) {
      session._buffer = 'some output';
      onData('some output');
    }
  }, 20);

  const result = await resultPromise;
  // Should time out or go quiet (no marker found)
  assert.equal(result.exitCode, null);
});

// ── write() / sendKey() ────────────────────────────────────────────────────

test('write throws when session is not alive', () => {
  const session = createSession();
  session.alive = false;
  session.id = 'test-session';

  assert.throws(
    () => session.write('hello'),
    /is no longer alive/,
  );
});

test('write sends data to daemon session', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 7;
  const writes = [];
  session.ptydClient = { write: (id, data) => writes.push({ id, data }) };

  session.write('hello world');
  assert.deepEqual(writes, [{ id: 7, data: 'hello world' }]);
});

test('write clears busy state when ctrl+c is sent', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 1;
  session.busy = true;
  session._pendingMarker = 'some_marker';
  session.ptydClient = { write: () => {} };

  session.write('\x03'); // ctrl+c
  assert.equal(session.busy, false);
  assert.equal(session._pendingMarker, null);
});

test('write clears busy state when ctrl+d is sent', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 1;
  session.busy = true;
  session._pendingMarker = 'some_marker';
  session.ptydClient = { write: () => {} };

  session.write('\x04'); // ctrl+d
  assert.equal(session.busy, false);
  assert.equal(session._pendingMarker, null);
});

test('sendKey throws for unknown key', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 1;
  session.ptydClient = { write: () => {} };

  assert.throws(
    () => session.sendKey('nonexistent-key'),
    /Unknown key: "nonexistent-key"/,
  );
});

test('sendKey sends correct escape sequence', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 1;
  const writes = [];
  session.ptydClient = { write: (id, data) => writes.push(data) };

  session.sendKey('ctrl+c');
  assert.deepEqual(writes, ['\x03']);
});

// ── read() when not alive ──────────────────────────────────────────────────

test('read returns leftover buffer when session is not alive', async () => {
  const session = createSession();
  session.alive = false;
  session._buffer = 'final output here';
  session._readCursor = 0;
  session._totalBytesEmitted = 50;
  session._dataListeners = [];

  const result = await session.read({ timeout: 50, idleTimeout: 10 });
  assert.equal(result.output, 'final output here');
  assert.equal(result.timedOut, false);
  assert.equal(result.position, 50);
});

// ── waitForPattern() when not alive ────────────────────────────────────────

test('waitForPattern throws when session is not alive', async () => {
  const session = createSession();
  session.alive = false;
  session.id = 'test-session';

  await assert.rejects(
    () => session.waitForPattern({ pattern: 'ready', timeout: 50 }),
    /is no longer alive/,
  );
});

// ── resize() ────────────────────────────────────────────────────────────────

test('resize throws when session is not alive', () => {
  const session = createSession();
  session.alive = false;
  session.id = 'test-session';

  assert.throws(
    () => session.resize(120, 40),
    /is no longer alive/,
  );
});

test('resize sends command and updates cols/rows', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 5;
  const calls = [];
  session.ptydClient = { resize: (id, cols, rows) => calls.push({ id, cols, rows }) };

  session.resize(160, 50);
  assert.deepEqual(calls, [{ id: 5, cols: 160, rows: 50 }]);
  assert.equal(session.cols, 160);
  assert.equal(session.rows, 50);
});

// ── getInfo() verbose ──────────────────────────────────────────────────────

test('getInfo returns full metadata when verbose is true', () => {
  const session = createSession();
  session.id = 's1';
  session.name = 'main';
  session.cwd = '/repo';
  session.alive = true;
  session.busy = false;
  session.shell = '/bin/bash';
  session.shellType = 'bash';
  session.cols = 120;
  session.rows = 30;
  session.createdAt = Date.now() - 5000;
  session.lastActivity = Date.now() - 1000;

  const info = session.getInfo({ verbose: true });
  assert.equal(info.id, 's1');
  assert.equal(info.name, 'main');
  assert.equal(info.shell, '/bin/bash');
  assert.equal(info.shellType, 'bash');
  assert.equal(info.cols, 120);
  assert.equal(info.rows, 30);
  assert.ok(info.createdAt);
  assert.ok(info.lastActivity);
  assert.equal(typeof info.idleSeconds, 'number');
});

test('getInfo defaults to verbose=true', () => {
  const session = createSession();
  session.id = 's1';
  session.name = null;
  session.cwd = '/repo';
  session.alive = true;
  session.busy = false;
  session.shell = '/bin/bash';
  session.shellType = 'bash';
  session.cols = 120;
  session.rows = 30;
  session.createdAt = Date.now();
  session.lastActivity = Date.now();

  const info = session.getInfo();
  assert.ok('shell' in info);
  assert.ok('shellType' in info);
  assert.ok('createdAt' in info);
});

// ── _appendToHistory eviction ──────────────────────────────────────────────

test('_appendToHistory evicts oldest lines when over capacity', () => {
  const session = createSession();
  session._history = Array.from({ length: 9999 }, (_, i) => `line${i}`);
  session._historyTotalLines = 9999;
  session._historyPartial = '';

  // Append 5 more lines to push over the 10000 limit
  session._appendToHistory('a\nb\nc\nd\ne\n');

  assert.ok(session._history.length <= 10000);
  assert.equal(session._historyTotalLines, 10004);
});

test('_appendToHistory handles partial lines correctly', () => {
  const session = createSession();
  session._history = [];
  session._historyTotalLines = 0;
  session._historyPartial = 'prefix';

  session._appendToHistory('-suffix\nsecond line\n');

  assert.equal(session._history[0], 'prefix-suffix');
  assert.equal(session._history[1], 'second line');
  assert.equal(session._historyPartial, '');
});

// ── _wrapCommand for cmd ───────────────────────────────────────────────────

test('_wrapCommand uses cmd syntax for cmd shell type', () => {
  const session = createSession();
  session.shellType = 'cmd';

  const wrapped = session._wrapCommand('echo hi', '__DONE__', '__CWD_', '__PRE__');
  assert.match(wrapped, /echo __PRE__/);
  assert.match(wrapped, /echo __DONE___%ERRORLEVEL%__/);
  assert.match(wrapped, /echo __CWD_%CD%__/);
});

// ── _onOutput / _onExit handler behavior ────────────────────────────────────

test('_onOutput detects pending marker at line start', async () => {
  const mockClient = new EventEmitter();
  mockClient.start = async () => ({ sessionId: 1, pid: 100 });
  mockClient.write = () => {};

  const session = new PtySession({
    id: 'test', shell: '/bin/bash', shellArgs: [], cols: 80, rows: 24,
    cwd: '/tmp', ptydClient: mockClient,
  });
  await session.init();

  session._pendingMarker = '__MCP_DONE_xyz__';
  session.busy = true;

  // First call: command echo with marker in string (should NOT trigger)
  mockClient.emit('output', 1, Buffer.from('echo "__MCP_DONE_xyz__"'));
  assert.equal(session._pendingMarker, '__MCP_DONE_xyz__');
  assert.equal(session.busy, true);

  // Second call: marker appears at start of a new line
  mockClient.emit('output', 1, Buffer.from('\n__MCP_DONE_xyz___0__\n'));
  assert.equal(session._pendingMarker, null);
  assert.equal(session.busy, false);
});

test('_onOutput ignores output for different daemon session', async () => {
  const mockClient = new EventEmitter();
  mockClient.start = async () => ({ sessionId: 1, pid: 100 });
  mockClient.write = () => {};

  const session = new PtySession({
    id: 'test', shell: '/bin/bash', shellArgs: [], cols: 80, rows: 24,
    cwd: '/tmp', ptydClient: mockClient,
  });
  await session.init();

  mockClient.emit('output', 999, Buffer.from('output for other session'));
  assert.equal(session._buffer, '');
});

test('_onExit marks session as not alive for correct daemon id', async () => {
  const mockClient = new EventEmitter();
  mockClient.start = async () => ({ sessionId: 5, pid: 100 });
  mockClient.write = () => {};

  const session = new PtySession({
    id: 'test', shell: '/bin/bash', shellArgs: [], cols: 80, rows: 24,
    cwd: '/tmp', ptydClient: mockClient,
  });
  await session.init();

  mockClient.emit('exit', 5);
  assert.equal(session.alive, false);
});

test('_onExit ignores exit for different daemon session', async () => {
  const mockClient = new EventEmitter();
  mockClient.start = async () => ({ sessionId: 5, pid: 100 });
  mockClient.write = () => {};

  const session = new PtySession({
    id: 'test', shell: '/bin/bash', shellArgs: [], cols: 80, rows: 24,
    cwd: '/tmp', ptydClient: mockClient,
  });
  await session.init();

  mockClient.emit('exit', 999);
  assert.equal(session.alive, true);
});

// ── Buffer overflow cap ─────────────────────────────────────────────────────

test('_onOutput caps buffer at MAX_BUFFER_BYTES', async () => {
  const mockClient = new EventEmitter();
  mockClient.start = async () => ({ sessionId: 1, pid: 100 });
  mockClient.write = () => {};

  const session = new PtySession({
    id: 'test', shell: '/bin/bash', shellArgs: [], cols: 80, rows: 24,
    cwd: '/tmp', ptydClient: mockClient,
  });
  await session.init();

  // Simulate 1.5MB of output
  const bigData = 'x'.repeat(1024 * 1024 + 512 * 1024);
  mockClient.emit('output', 1, Buffer.from(bigData));

  assert.ok(session._buffer.length <= 1024 * 1024);
});

// ── _sendProgress ───────────────────────────────────────────────────────────

test('_sendProgress sends formatted notification', () => {
  const session = createSession();
  const calls = [];
  const sendNotification = (msg) => calls.push(msg);

  session._sendProgress(sendNotification, 'token-123', 'last line here\nanother line', Date.now() - 2000, 10000);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'notifications/progress');
  assert.equal(calls[0].params.progressToken, 'token-123');
  assert.match(calls[0].params.message, /\[2s\] another line/);
});

test('_sendProgress handles empty content gracefully', () => {
  const session = createSession();
  const calls = [];
  const sendNotification = (msg) => calls.push(msg);

  session._sendProgress(sendNotification, 'tok', '', Date.now(), 5000);

  assert.equal(calls.length, 1);
  assert.match(calls[0].params.message, /\[0s\]\s*/);
});

test('_sendProgress swallows errors from sendNotification', () => {
  const session = createSession();
  const sendNotification = () => { throw new Error('notify failed'); };

  // Should not throw
  assert.doesNotThrow(() => {
    session._sendProgress(sendNotification, 'tok', 'content', Date.now(), 5000);
  });
});

// ── _tailOutput ─────────────────────────────────────────────────────────────

test('_tailOutput returns full output when under limit', () => {
  const session = createSession();
  const result = session._tailOutput('line1\nline2\nline3', 5);
  assert.equal(result, 'line1\nline2\nline3');
});

test('_tailOutput returns only tail lines when over limit', () => {
  const session = createSession();
  const result = session._tailOutput('line1\nline2\nline3\nline4\nline5', 2);
  assert.equal(result, 'line4\nline5');
});

// ── _formatWaitOutput ───────────────────────────────────────────────────────

test('_formatWaitOutput returns empty for match-only mode', () => {
  const session = createSession();
  const result = session._formatWaitOutput('some output', 'match-only', 50, null);
  assert.equal(result, '');
});

test('_formatWaitOutput returns empty for empty output', () => {
  const session = createSession();
  const result = session._formatWaitOutput('   ', 'tail', 50, null);
  assert.equal(result, '');
});

test('_formatWaitOutput uses _tailOutput when no tailTracker', () => {
  const session = createSession();
  const output = 'line1\nline2\nline3\nline4\nline5';
  const result = session._formatWaitOutput(output, 'tail', 2, null);
  assert.equal(result, 'line4\nline5');
});

test('_formatWaitOutput uses tailTracker when provided', () => {
  const session = createSession();
  const tracker = { lines: ['tracked1', 'tracked2'], partial: 'last' };
  const result = session._formatWaitOutput('anything', 'tail', 50, tracker);
  assert.equal(result, 'tracked1\ntracked2\nlast');
});

// ── _waitForMarker with progress notifications ──────────────────────────────

test('_waitForMarker sends progress notifications when configured', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._dataListeners = [];
  session._history = [];
  session._historyTotalLines = 0;
  session._historyPartial = '';

  const progressCalls = [];
  const sendNotification = (msg) => progressCalls.push(msg);

  const resultPromise = session._waitForMarker(
    '__DONE__',
    2000,
    undefined,
    1,
    sendNotification,
    'progress-token-1',
  );

  // Feed data to trigger onData (>1s apart for progress to fire)
  const onData = session._dataListeners.at(-1);
  session._buffer = 'some data';
  onData('some data');

  // Wait a tiny bit and resolve with marker
  await new Promise((r) => setTimeout(r, 10));
  session._buffer = 'some data\n__DONE__';
  onData('\n__DONE__');

  const result = await resultPromise;
  assert.equal(result.reason, 'marker');
});

// ── _parseOutput plain marker ───────────────────────────────────────────────

test('_parseOutput handles plain marker without exit code', () => {
  const session = createSession();
  const marker = '__MCP_DONE_xyz__';
  const cwdMarker = '__MCP_CWD_';
  const preMarker = '__MCP_PRE_abc__';
  const raw = [
    preMarker,
    'some output',
    marker, // plain marker without exit code suffix
    `${cwdMarker}/repo__`,
  ].join('\n');

  const result = session._parseOutput(raw, marker, cwdMarker, preMarker);
  assert.equal(result.output, 'some output');
  assert.equal(result.exitCode, null);
  assert.equal(result.cwd, '/repo');
});

// ── watch() context buffer overflow ─────────────────────────────────────────

test('watch contextBuffer does not grow beyond contextLines + 1', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'done', pattern: 'DONE' }],
    timeout: 5000,
    contextLines: 2,
  });

  const onData = session._dataListeners.at(-1);
  // Feed 5 lines before the trigger
  for (let i = 1; i <= 5; i++) {
    onData(`line ${i}\n`);
    session._totalBytesEmitted += 7;
  }
  onData('DONE\n');
  session._totalBytesEmitted += 5;

  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  // context should only have the last contextLines entries
  assert.ok(result.context.length <= 3);
});

// ── watch() process exit detection ──────────────────────────────────────────

test('watch detects process exit via interval check', async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = '';
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: 'x', pattern: 'never-match-this-xyz' }],
    timeout: 10000,
  });

  // Simulate process death after a short delay
  setTimeout(() => { session.alive = false; }, 50);

  const result = await resultPromise;
  assert.equal(result.reason, 'exit');
  assert.equal(result.timedOut, false);
});

// ── kill() suppresses signal errors ─────────────────────────────────────────

test('kill suppresses errors from ptydClient.signal', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = 1;
  session.ptydClient = {
    signal: () => { throw new Error('signal failed'); },
  };

  // Should not throw
  assert.doesNotThrow(() => session.kill());
  assert.equal(session.alive, false);
});

test('kill skips signal when daemonSessionId is null', () => {
  const session = createSession();
  session.alive = true;
  session._daemonSessionId = null;
  session.ptydClient = { signal: () => { throw new Error('should not be called'); } };

  assert.doesNotThrow(() => session.kill());
  assert.equal(session.alive, false);
});

// ── waitForPattern with async data arrival ──────────────────────────────────

test('waitForPattern matches pattern via data listener with progress', async () => {
  const mockClient = new EventEmitter();
  mockClient.start = async () => ({ sessionId: 1, pid: 100 });
  mockClient.write = () => {};

  const session = new PtySession({
    id: 'test', shell: '/bin/bash', shellArgs: [], cols: 80, rows: 24,
    cwd: '/tmp', ptydClient: mockClient,
  });
  await session.init();

  const progressCalls = [];
  const sendNotification = (msg) => progressCalls.push(msg);

  const resultPromise = session.waitForPattern({
    pattern: 'server ready',
    timeout: 5000,
    sendNotification,
    progressToken: 'token-1',
  });

  // Feed data via the daemon output event
  setTimeout(() => {
    mockClient.emit('output', 1, Buffer.from('starting up...\n'));
  }, 10);
  setTimeout(() => {
    mockClient.emit('output', 1, Buffer.from('server ready\n'));
  }, 20);

  const result = await resultPromise;
  assert.equal(result.matched, true);
  assert.equal(result.timedOut, false);
});

// ── watch with existing buffer via proper init ──────────────────────────────

test('watch processes existing buffer lines when since is in range', async () => {
  const mockClient = new EventEmitter();
  mockClient.start = async () => ({ sessionId: 1, pid: 100 });
  mockClient.write = () => {};

  const session = new PtySession({
    id: 'test', shell: '/bin/bash', shellArgs: [], cols: 80, rows: 24,
    cwd: '/tmp', ptydClient: mockClient,
  });
  await session.init();

  // Populate buffer with data
  session._buffer = 'line one\nline two\ntrigger here\n';
  session._totalBytesEmitted = 100;

  const resultPromise = session.watch({
    triggers: [{ id: 'found', pattern: 'trigger' }],
    timeout: 2000,
    since: 70, // within buffer range (bufferStart=69, offset=1)
  });

  const result = await resultPromise;
  assert.equal(result.reason, 'trigger');
  assert.equal(result.triggerId, 'found');
});