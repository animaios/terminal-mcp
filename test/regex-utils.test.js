import test from 'node:test';
import assert from 'node:assert/strict';
import { compileUserRegex } from '../src/regex-utils.js';

test('compileUserRegex compiles a valid pattern', () => {
  const re = compileUserRegex('hello.*world');
  assert.ok(re instanceof RegExp);
  assert.ok(re.test('hello there world'));
});

test('compileUserRegex throws for empty string', () => {
  assert.throws(
    () => compileUserRegex(''),
    /pattern must be a non-empty string/,
  );
});

test('compileUserRegex throws for non-string input', () => {
  assert.throws(
    () => compileUserRegex(123),
    /pattern must be a non-empty string/,
  );
  assert.throws(
    () => compileUserRegex(null),
    /pattern must be a non-empty string/,
  );
  assert.throws(
    () => compileUserRegex(undefined),
    /pattern must be a non-empty string/,
  );
});

test('compileUserRegex throws for pattern exceeding max length', () => {
  const longPattern = 'a'.repeat(501);
  assert.throws(
    () => compileUserRegex(longPattern),
    /pattern is too long/,
  );
});

test('compileUserRegex accepts pattern at max length boundary', () => {
  const pattern = 'a'.repeat(500);
  const re = compileUserRegex(pattern);
  assert.ok(re instanceof RegExp);
});

test('compileUserRegex throws for nested quantifier patterns', () => {
  // Pattern like (a+)+ or (b*)* which can cause catastrophic backtracking
  assert.throws(
    () => compileUserRegex('(a+)+'),
    /Unsafe regex pattern/,
  );
  assert.throws(
    () => compileUserRegex('(ab*)*'),
    /Unsafe regex pattern/,
  );
});

test('compileUserRegex accepts safe grouped patterns', () => {
  const re = compileUserRegex('(hello|world)');
  assert.ok(re instanceof RegExp);
  assert.ok(re.test('hello'));
  assert.ok(re.test('world'));
});

test('compileUserRegex throws for invalid regex syntax', () => {
  assert.throws(
    () => compileUserRegex('('),
    /Invalid regex pattern in pattern/,
  );
  assert.throws(
    () => compileUserRegex('[unterminated'),
    /Invalid regex pattern in pattern/,
  );
});

test('compileUserRegex uses custom field name in error messages', () => {
  assert.throws(
    () => compileUserRegex('', 'trigger'),
    /trigger must be a non-empty string/,
  );
  assert.throws(
    () => compileUserRegex('('.repeat(501), 'searchPattern'),
    /searchPattern is too long/,
  );
});
