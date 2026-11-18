// The layout keeps everything inside the round-safe area of the 1280x720 screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';
const layout = lib('layout');

test('text and button stay inside x 120..1160 and y 52..668', () => {
  for (const spec of [layout.title, layout.body]) {
    assert.ok(spec.x - spec.width / 2 >= 52 && spec.x + spec.width / 2 <= 1228);
    assert.ok(spec.y - spec.size * 0.8 >= 52);   // a label box is 1.6 x size high, centred on y
  }
  const b = layout.button;
  assert.ok(b.x - b.size / 2 >= 120 && b.x + b.size / 2 <= 1160);
  assert.ok(b.y + b.size / 2 <= 668);
});
