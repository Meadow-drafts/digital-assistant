import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeClock } from './fake-clock.js';

// Contract of the controllable clock that later timer tickets rely on.
test('fake clock fires timers in order only as time advances and honours clear', async () => {
  const clock = createFakeClock(0);
  const fired = [];
  clock.setTimeout(() => fired.push('b'), 200);
  clock.setTimeout(() => fired.push('a'), 100);
  const cancelled = clock.setTimeout(() => fired.push('x'), 150);
  clock.clearTimeout(cancelled);

  await clock.advance(99);
  assert.deepEqual(fired, []);
  await clock.advance(101);
  assert.deepEqual(fired, ['a', 'b']);
  assert.equal(clock.now(), 200);
});
