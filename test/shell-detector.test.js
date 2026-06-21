import test from 'node:test';
import assert from 'node:assert/strict';
import { getShellType, isAvailable, detectShell } from '../src/shell-detector.js';

// ── getShellType ────────────────────────────────────────────────────────────

test('getShellType identifies PowerShell variants', () => {
  assert.equal(getShellType('pwsh'), 'powershell');
  assert.equal(getShellType('pwsh.exe'), 'powershell');
  assert.equal(getShellType('/usr/bin/pwsh'), 'powershell');
  assert.equal(getShellType('powershell'), 'powershell');
  assert.equal(getShellType('powershell.exe'), 'powershell');
  assert.equal(getShellType('PowerShell'), 'powershell');
});

test('getShellType identifies cmd', () => {
  assert.equal(getShellType('cmd'), 'cmd');
  assert.equal(getShellType('cmd.exe'), 'cmd');
  assert.equal(getShellType('CMD'), 'cmd');
});

test('getShellType defaults to bash for unknown shells', () => {
  assert.equal(getShellType('/bin/bash'), 'bash');
  assert.equal(getShellType('/bin/zsh'), 'bash');
  assert.equal(getShellType('sh'), 'bash');
  assert.equal(getShellType('fish'), 'bash');
  assert.equal(getShellType('unknown-shell'), 'bash');
});

// ── isAvailable ─────────────────────────────────────────────────────────────

test('isAvailable returns true for a known command', () => {
  assert.equal(isAvailable('sh'), true);
});

test('isAvailable returns false for a nonexistent command', () => {
  assert.equal(isAvailable('nonexistent-command-xyz-123'), false);
});

// ── detectShell ─────────────────────────────────────────────────────────────

test('detectShell returns a shell and args object', () => {
  const result = detectShell();
  assert.ok(typeof result.shell === 'string');
  assert.ok(Array.isArray(result.args));
  assert.ok(result.shell.length > 0);
});

test('detectShell falls back to bash or sh when SHELL is unset on Unix', { skip: process.platform === 'win32' }, () => {
  const origShell = process.env.SHELL;
  try {
    delete process.env.SHELL;
    const result = detectShell();
    // Should fall back to bash (available) or sh
    assert.ok(result.shell === 'bash' || result.shell === 'sh');
    assert.deepEqual(result.args, []);
  } finally {
    if (origShell !== undefined) process.env.SHELL = origShell;
  }
});

test('detectShell uses SHELL env var on Unix', { skip: process.platform === 'win32' }, () => {
  const origShell = process.env.SHELL;
  try {
    process.env.SHELL = '/bin/zsh';
    const result = detectShell();
    assert.equal(result.shell, '/bin/zsh');
    assert.deepEqual(result.args, []);
  } finally {
    if (origShell !== undefined) {
      process.env.SHELL = origShell;
    } else {
      delete process.env.SHELL;
    }
  }
});
