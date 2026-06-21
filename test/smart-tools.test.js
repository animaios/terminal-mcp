import test from 'node:test';
import assert from 'node:assert/strict';
import { execAndDiff, execWithRetry } from '../src/smart-tools.js';

test('execWithRetry retries until the exit code and pattern succeed', async () => {
  const calls = [];
  const results = [
    { output: 'booting', exitCode: 1, cwd: 'C:/repo', timedOut: false },
    { output: 'service ready', exitCode: 0, cwd: 'C:/repo', timedOut: false },
  ];
  const session = {
    exec: async (opts) => {
      calls.push(opts);
      return results.shift();
    },
  };

  const result = await execWithRetry(session, {
    command: 'npm run dev',
    maxRetries: 2,
    backoff: 'fixed',
    delayMs: 0,
    timeout: 1234,
    maxLines: 50,
    successPattern: 'ready',
  });

  assert.deepEqual(calls, [
    { command: 'npm run dev', timeout: 1234, maxLines: 50 },
    { command: 'npm run dev', timeout: 1234, maxLines: 50 },
  ]);
  assert.equal(result.success, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.lastResult.output, 'service ready');
  assert.equal(result.history.length, 2);
});

test('execWithRetry rejects invalid success patterns', async () => {
  const session = {
    exec: async () => ({ output: 'ready', exitCode: 0, cwd: 'C:/repo', timedOut: false }),
  };

  await assert.rejects(
    execWithRetry(session, { command: 'npm test', successPattern: '(' }),
    /Invalid regex pattern in successPattern/
  );
});

test('execAndDiff returns a unified diff for changed output', async () => {
  const calls = [];
  const session = {
    exec: async (opts) => {
      calls.push(opts);
      return calls.length === 1
        ? { output: 'alpha\nbeta', exitCode: 0, cwd: 'C:/repo', timedOut: false }
        : { output: 'alpha\ngamma', exitCode: 0, cwd: 'C:/repo', timedOut: false };
    },
  };

  const result = await execAndDiff(session, {
    commandA: 'type before.txt',
    commandB: 'type after.txt',
    timeout: 500,
    maxLines: 20,
    contextLines: 1,
  });

  assert.deepEqual(calls, [
    { command: 'type before.txt', timeout: 500, maxLines: 20 },
    { command: 'type after.txt', timeout: 500, maxLines: 20 },
  ]);
  assert.equal(result.identical, false);
  assert.match(result.diff, /--- type before.txt/);
  assert.match(result.diff, /\+\+\+ type after.txt/);
  assert.match(result.diff, /-beta/);
  assert.match(result.diff, /\+gamma/);
});

test('execWithRetry returns failure when all retries are exhausted', async () => {
  const session = {
    exec: async () => ({ output: 'fail', exitCode: 1, cwd: '/tmp', timedOut: false }),
  };

  const result = await execWithRetry(session, {
    command: 'false',
    maxRetries: 2,
    backoff: 'fixed',
    delayMs: 0,
    timeout: 1000,
    maxLines: 10,
  });

  assert.equal(result.success, false);
  assert.equal(result.attempts, 3); // 1 initial + 2 retries
  assert.equal(result.history.length, 3);
  assert.equal(result.lastResult.output, 'fail');
});

test('execWithRetry uses linear backoff strategy', async () => {
  const timestamps = [];
  const session = {
    exec: async () => {
      timestamps.push(Date.now());
      return { output: 'fail', exitCode: 1, cwd: '/tmp', timedOut: false };
    },
  };

  await execWithRetry(session, {
    command: 'false',
    maxRetries: 2,
    backoff: 'linear',
    delayMs: 10,
    timeout: 1000,
    maxLines: 10,
  });

  assert.equal(timestamps.length, 3);
});

test('execWithRetry uses exponential backoff strategy', async () => {
  let calls = 0;
  const session = {
    exec: async () => {
      calls++;
      return { output: 'fail', exitCode: 1, cwd: '/tmp', timedOut: false };
    },
  };

  const result = await execWithRetry(session, {
    command: 'false',
    maxRetries: 1,
    backoff: 'exponential',
    delayMs: 1,
    timeout: 1000,
    maxLines: 10,
  });

  assert.equal(calls, 2);
  assert.equal(result.success, false);
});

test('execWithRetry succeeds when successExitCode is null (any exit code)', async () => {
  const session = {
    exec: async () => ({ output: 'done', exitCode: 42, cwd: '/tmp', timedOut: false }),
  };

  const result = await execWithRetry(session, {
    command: 'anything',
    maxRetries: 0,
    successExitCode: null,
    delayMs: 0,
  });

  assert.equal(result.success, true);
  assert.equal(result.attempts, 1);
});

test('execAndDiff reports identical outputs', async () => {
  const session = {
    exec: async () => ({ output: 'same', exitCode: 0, cwd: '/tmp', timedOut: false }),
  };

  const result = await execAndDiff(session, {
    commandA: 'echo same',
    commandB: 'echo same',
    contextLines: 3,
  });

  assert.equal(result.identical, true);
  // Header only, no hunks
  assert.match(result.diff, /--- echo same/);
  assert.match(result.diff, /\+\+\+ echo same/);
  assert.doesNotMatch(result.diff, /@@ @@/);
});

test('execAndDiff skips diff for outputs exceeding MAX_DIFF_LINES', async () => {
  const bigOutput = Array.from({ length: 401 }, (_, i) => `line ${i}`).join('\n');
  const session = {
    exec: async (opts) => ({
      output: opts.command === 'cmdA' ? bigOutput : bigOutput + '\nextra',
      exitCode: 0,
      cwd: '/tmp',
      timedOut: false,
    }),
  };

  const result = await execAndDiff(session, {
    commandA: 'cmdA',
    commandB: 'cmdB',
  });

  assert.match(result.diff, /Diff skipped: outputs exceed 400 lines/);
});

test('execAndDiff handles empty outputs', async () => {
  const session = {
    exec: async () => ({ output: '', exitCode: 0, cwd: '/tmp', timedOut: false }),
  };

  const result = await execAndDiff(session, {
    commandA: 'empty1',
    commandB: 'empty2',
  });

  assert.equal(result.identical, true);
  assert.match(result.diff, /--- empty1/);
  assert.match(result.diff, /\+\+\+ empty2/);
});