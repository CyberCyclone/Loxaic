import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, subtract } from '../src/math.js';

test('add', () => {
  assert.equal(add(2, 2), 4);
});

test('subtract', () => {
  assert.equal(subtract(5, 3), 2);
});
