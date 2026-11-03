import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, similarityIndex } from '../server/domain.mjs';
test('similarity is a bounded display index; exact threshold determines the decision', () => {
  assert.equal(similarityIndex(0, 0.5), 100);
  assert.equal(similarityIndex(0.5, 0.5), 50);
  assert.equal(similarityIndex(100, 0.5), 1);
  assert.ok(similarityIndex(0.2, 0.5) > similarityIndex(0.3, 0.5));
  assert.throws(() => similarityIndex(NaN, 0.5));
  const ref = Array(128).fill(0),
    at = [0.5, ...Array(127).fill(0)],
    over = [0.50001, ...Array(127).fill(0)];
  assert.equal(compare([ref], at, 0.5).match, true);
  assert.equal(compare([ref], over, 0.5).match, false);
});
