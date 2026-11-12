import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndSanitizeSql } from '../services/sqlGuard.js';

test('allows valid SELECT query and injects LIMIT 1000', () => {
  const res = validateAndSanitizeSql('SELECT id, name FROM users');
  assert.equal(res.safe, true);
  assert.match(res.sanitizedSql, /LIMIT 1000$/);
});

test('caps excessive LIMIT to 1000', () => {
  const res = validateAndSanitizeSql('SELECT * FROM orders LIMIT 50000');
  assert.equal(res.safe, true);
  assert.match(res.sanitizedSql, /LIMIT 1000$/);
});

test('blocks destructive DROP statement', () => {
  const res = validateAndSanitizeSql('DROP TABLE users');
  assert.equal(res.safe, false);
});

test('blocks stacked multi-statement SQL injection', () => {
  const res = validateAndSanitizeSql('SELECT * FROM users; DELETE FROM orders;');
  assert.equal(res.safe, false);
});

test('blocks system tables and internal history table', () => {
  const res = validateAndSanitizeSql('SELECT name FROM sqlite_master');
  assert.equal(res.safe, false);
});
