/** `src/worker/secrets.ts`: constant-time comparison over SHA-256 digests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretsEqual } from '../../src/worker/secrets.js';

const TARGET_SECRET = 'correct-horse-battery-staple';

test('secretsEqual is true only for the identical string', async () => {
  const same = await secretsEqual(TARGET_SECRET, TARGET_SECRET);
  const differentLastChar = await secretsEqual(`${TARGET_SECRET.slice(0, -1)}X`, TARGET_SECRET);
  const prefix = await secretsEqual(TARGET_SECRET.slice(0, 5), TARGET_SECRET);
  const empty = await secretsEqual('', TARGET_SECRET);

  assert.equal(same, true);
  assert.equal(differentLastChar, false);
  assert.equal(prefix, false);
  assert.equal(empty, false);
});
