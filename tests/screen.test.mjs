// The open/close lifecycle: a failed or slow close never leaves a dead view behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lib, flush, fakeJibo, fakeViews, FakeBeSkill } from './helpers.mjs';
const createScreen = lib('screen');

function setup(remove, closeMs = 20) {
  const views = fakeViews({ remove });
  const { jibo, calls } = fakeJibo();
  jibo.face = { views };
  const Skill = createScreen(jibo, FakeBeSkill, { closeMs });
  return { skill: new Skill(), views, calls };
}
const close = (skill) => new Promise((resolve) => skill.close(resolve));

test('open shows one view with a swipe-down action', () => {
  const { skill, views } = setup('ok');
  skill.open();
  assert.equal(views.currentView, skill.view);
  assert.equal(skill.view.actions[0].gesture, 'swipeDown');
});

test('a close that never finishes times out and still clears the view', async () => {
  const { skill } = setup('never');
  skill.open();
  const error = await close(skill);
  assert.match(String(error), /close_timeout/);
  assert.equal(skill.view, null);
});

test('a failed close clears the view, so the next open is a live one', async () => {
  const { skill, views } = setup('fail');
  skill.open();
  await close(skill);
  assert.equal(skill.view, null);
  skill.open();
  assert.equal(views.created.length, 2);
  assert.equal(views.currentView, skill.view);
});

test('open during a close waits for it', async () => {
  const { skill, views } = setup('never', 30);
  skill.open();
  skill.close(() => {});
  skill.open();
  assert.equal(views.created.length, 1, 'no second view while closing');
  await new Promise((r) => setTimeout(r, 60));
  await flush();
  assert.equal(views.created.length, 2);
});

test('close stops the motion: Jibo is centred and attention released', async () => {
  const { skill, calls } = setup('ok');
  skill.open();
  skill.lookUp();
  await flush();
  await close(skill);
  await flush();
  assert.ok(calls.includes('cleanup'));
  assert.equal(calls.filter((c) => c === 'release').length, 1);
  assert.equal(skill.lookTimer, null);
});
