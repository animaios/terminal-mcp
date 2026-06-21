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
  // Force Math.random to always return 0, so every attempt picks ADJECTIVES[0]-NOUNS[0]
  // After 100 failed attempts, the fallback at line 34-35 kicks in with a hex suffix
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    const existing = new Set([`${'amber'}-${'atlas'}`]); // ADJECTIVES[0]-NOUNS[0]
    const id = generateSessionId(existing);
    // Should use fallback: amber-atlas-<4 hex chars>
    assert.match(id, /^amber-atlas-[a-f0-9]{4}$/);
  } finally {
    Math.random = origRandom;
  }
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
