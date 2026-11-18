// Jibo never stays tilted or with attention OFF, whatever order open, move and close come in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib, flush, fakeJibo } from './helpers.mjs';
const { Motion, POSE } = lib('motion');

test('up then centre: pose on the body, then cleanup and release', async () => {
  const { jibo, calls, handles } = fakeJibo();
  const motion = new Motion(jibo);
  await motion.move('up');
  await motion.move('centre');
  await flush();
  assert.deepEqual(calls, ['push OFF', 'play ' + POSE, 'cleanup', 'release']);
  assert.equal(handles[0].released, true);
});

test('close during a pose stops it, centres and releases', async () => {
  const { jibo, calls, handles } = fakeJibo({ never: true });
  const motion = new Motion(jibo);
  motion.move('up');
  await flush();
  motion.close();
  await flush();
  assert.deepEqual(calls, ['push OFF', 'play ' + POSE, 'stop', 'cleanup', 'release']);
  assert.equal(handles[0].released, true);
});

test('close while the attention push is still under way releases it once it arrives', async () => {
  const { jibo, calls, handles } = fakeJibo();
  const motion = new Motion(jibo);
  motion.move('up');
  motion.close();
  await flush();
  assert.equal(handles.length, 1);
  assert.equal(handles[0].released, true);
  assert.ok(!calls.includes('play ' + POSE), 'no pose after close');
});

test('moves after close do nothing', async () => {
  const { jibo, calls } = fakeJibo();
  const motion = new Motion(jibo);
  motion.close();
  await motion.move('up');
  assert.deepEqual(calls, []);
});

test('without the motion APIs nothing happens and nothing throws', async () => {
  const motion = new Motion({});
  await motion.move('up');
  await motion.move('centre');
  motion.close();
});
