import test from 'node:test';
import assert from 'node:assert/strict';
import { PtydProcess } from '../src/ptyd-process.js';

test('PtydProcess alive returns false when no process is running', () => {
  const proc = new PtydProcess();
  assert.equal(proc.alive, false);
});

test('PtydProcess socketPath returns null initially', () => {
  const proc = new PtydProcess();
  assert.equal(proc.socketPath, null);
});

test('PtydProcess stop is a no-op when no process is running', async () => {
  const proc = new PtydProcess();
  // Should not throw
  await proc.stop();
  assert.equal(proc.alive, false);
});

test('PtydProcess resolves PTYD_PATH env var for binary location', async () => {
  // Set PTYD_PATH to a non-existent binary to verify it's used
  const origPath = process.env.PTYD_PATH;
  try {
    process.env.PTYD_PATH = '/tmp/nonexistent-ptyd-binary';
    const proc = new PtydProcess();
    // start() will fail because the binary doesn't exist, but that's expected
    await assert.rejects(proc.start(), /Failed to spawn ptyd|ENOENT|ptyd did not produce/);
  } finally {
    if (origPath !== undefined) {
      process.env.PTYD_PATH = origPath;
    } else {
      delete process.env.PTYD_PATH;
    }
  }
});

test('PtydProcess _cleanupSocket is a no-op when socketPath is null', async () => {
  const proc = new PtydProcess();
  // Should not throw
  await proc._cleanupSocket();
});
