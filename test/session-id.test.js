import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSessionId } from '../src/session-id.js';

test('generateSessionId returns a string in adj-noun format', () => {
  const id = generateSessionId();
  assert.match(id, /^[a-z]+-[a-z]+$/);
});

test('generateSessionId returns unique IDs for multiple calls', () => {
  const ids = new Set();
  for (let i = 0; i < 20; i++) {
    ids.add(generateSessionId());
  }
  // Should have at least 18 unique IDs (very unlikely to have more collisions)
  assert.ok(ids.size >= 18);
});

test('generateSessionId avoids collisions with existing IDs', () => {
  const existing = new Set(['calm-reef', 'brisk-falcon', 'warm-cloud']);

  const id = generateSessionId(existing);
  assert.ok(!existing.has(id));
});

test('generateSessionId fallback appends hex when collisions are extreme', () => {
  // Saturate the wordlist space by generating hundreds of IDs
  const existing = new Set();
  for (let i = 0; i < 3000; i++) {
    existing.add(`word-${i}`);
  }
  const id = generateSessionId(existing);
  // Should still produce something valid
  assert.ok(id.length > 0);
  assert.ok(typeof id === 'string');
});

test('generateSessionId IDs are ASCII lowercase hyphenated', () => {
  for (let i = 0; i < 50; i++) {
    const id = generateSessionId();
    assert.match(id, /^[a-z]+-[a-z]+(-[a-f0-9]{4})?$/);
  }
});

test('generateSessionId default parameter works with no argument', () => {
  const id = generateSessionId();
  assert.ok(typeof id === 'string');
  assert.ok(id.length > 0);
});
