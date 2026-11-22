// Noggin's skill entry (index.js) with the platform modules replaced by fakes: what happens when
// there is no key, and when the skill closes while Jibo is still saying why.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
const source = path.resolve(import.meta.dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const said = [], created = [];
const jibo = {
    embodied: {speech: {speak: text => { said.push(text); return sleep(60); }}},
    face: {views: {forceEyeView: done => done(), ActionData: {CALLBACK: 'cb'}, createView: (...args) => { created.push(args); throw Error('no views in this test'); }, changeView() {}}}
};
class BeSkill { exit() { this.exited = true; } }
const fakes = {'jibo': jibo, '@be/be-framework': {BeSkill}, 'jibo-embodied-dialog': {}};
const load = Module._load;
Module._load = function (request, parent, isMain) {
    return Object.prototype.hasOwnProperty.call(fakes, request) ? fakes[request] : load.call(this, request, parent, isMain);
};
const Noggin = Module.createRequire(import.meta.url)(path.join(source, 'noggin/index.js'));
Module._load = load;

function skill() {
    const s = new Noggin();
    s.generation = 1;
    s.tagged = {info() {}, warn() {}, error() {}};
    return s;
}
// Enough for the screen to get as far as asking for a view.
global.PIXI = {}; global.document = {};
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-index-'));

test('no key: Jibo says so with the brain emoji, then the setup screen (here the view fails: error)', async () => {
    said.length = 0; created.length = 0;
    const reason = await skill().talk(emptyDir(), null, Date.now(), {});
    assert.match(said[0], /Emoji_Brain[\s\S]*I need a brain/);
    assert.equal(created.length, 1, 'the screen was asked for');
    assert.equal(reason, 'setup_error');
});

test('review: closed while Jibo says the line, no setup screen appears afterwards (D76)', async () => {
    said.length = 0; created.length = 0;
    const s = skill();
    const talking = s.talk(emptyDir(), null, Date.now(), {});
    await sleep(10);
    await new Promise(done => s.close(done));
    assert.equal(await talking, 'closed');
    assert.equal(created.length, 0);
    assert.ok(!s.screen);
});

test('opened by "Hey Jibo" through background.js: the conversation gets when it was heard (D132)', async () => {
    const calls = [];
    const s = skill();
    s.talk = (...args) => { calls.push(args); return Promise.resolve('test'); };
    s.exit = () => {};
    s.open({nlu: {intent: 'background', entities: {reason: 'hey_jibo', heardAt: Date.now() - 400}}});
    s.open({nlu: {intent: 'menu'}});
    s.open();
    await sleep(20);
    assert.equal(calls.length, 3);
    assert.ok(calls[0][4] && typeof calls[0][4].heardAt === 'number');
    assert.ok(calls[0][3].since_hey_jibo_ms >= 400, 'in the startup log');
    assert.equal(calls[1][4], null);
    assert.equal(calls[2][4], null);
});
