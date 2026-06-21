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
