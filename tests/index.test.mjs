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
    await sleep(10);
    s.open({nlu: {intent: 'menu'}});
    await sleep(10);
    s.open();
    await sleep(10);
    assert.equal(calls.length, 3);
    assert.ok(calls[0][4] && typeof calls[0][4].heardAt === 'number');
    assert.ok(calls[0][3].since_hey_jibo_ms >= 400, 'in the startup log');
    assert.equal(calls[1][4], null);
    assert.equal(calls[2][4], null);
});

test('opened again without a close (a voice launch while Noggin is up): the old conversation and screen are closed first (D160)', async () => {
    const events = [];
    const s = skill();
    s.session = {close: async reason => { events.push('session ' + reason); await sleep(15); events.push('session closed'); }};
    s.screen = {close: async () => { events.push('screen closed'); }};
    s.talk = () => { events.push('talk'); return Promise.resolve('test'); };
    s.exit = () => {};
    s.open({nlu: {intent: 'menu', entities: {}}});
    await sleep(60);
    assert.ok(events.indexOf('talk') > events.indexOf('session closed'), 'the new conversation starts after the old one is gone: ' + events);
    assert.ok(events.includes('screen closed'));
    assert.equal(s.session, null);
    assert.equal(s.screen, null);
});

test('removal (destroy) ends a comeback still waiting: the speech wrapper is undone and it gives up (D162)', async () => {
    const s = skill(), original = jibo.embodied.speech.speak, writes = [];
    s.watchHandover({comeback: true, pairs: [], tool: 'clock', args: {}}, {comebackMinutes: 5}, {write: entry => writes.push(entry)});
    assert.notEqual(jibo.embodied.speech.speak, original, 'watching what Jibo says');
    await new Promise(done => s.destroy(done));
    assert.equal(jibo.embodied.speech.speak, original);
    assert.ok(writes.some(entry => entry.kind === 'comeback' && entry.ok === false && entry.reason === 'cancelled'));
});

test('closed while a voice launch is still ending the old conversation: no new conversation starts (D166)', async () => {
    const events = [];
    const s = skill();
    s.session = {close: async () => { await sleep(30); events.push('session closed'); }};
    s.talk = () => { events.push('talk'); return Promise.resolve('test'); };
    s.exit = () => { events.push('exit'); };
    s.open({nlu: {intent: 'menu', entities: {}}});
    await sleep(5);
    await new Promise(done => s.close(done));          // Be switches away meanwhile
    await sleep(60);
    assert.deepEqual(events, ['session closed'], 'no talk and no exit for a skill that is gone: ' + events);
});

test('say() in Dutch: through the Dutch voice; refused, the English line; stopped or late, no English afterwards; close cancels it (D175)', async () => {
    const calls = [];
    let mode = 'ok';
    global.dutchVoiceService = {apiVersion: 1, version: 't', languages: ['nl'], ready: () => true, status: () => ({state: 'ready'}),
        cancel() { calls.push('cancel'); },
        speak(fn) {
            calls.push(mode);
            if (mode === 'refuse') return Promise.reject(Error('dutch_voice_not_ready'));
            if (mode === 'timeout') return Promise.reject(Error('dutch_voice_timeout'));
            if (mode === 'hang') return new Promise(() => {});
            return Promise.resolve().then(fn);
        }};
    try {
        said.length = 0;
        const s = skill();
        await s.say('later', null, 'nl');
        assert.deepEqual(said, ['Ik ben er als je zover bent.']);
        mode = 'refuse'; said.length = 0;
        await s.say('later', null, 'nl');
        assert.deepEqual(said, ["I'll be here when you're ready."]);
        mode = 'timeout'; said.length = 0;
        await s.say('later', null, 'nl');
        assert.deepEqual(said, [], 'a line past its time is not said again in English');
        mode = 'hang'; said.length = 0;
        const pending = s.say('later', null, 'nl');
        await sleep(10);
        await new Promise(done => s.close(done));
        assert.equal(calls.at(-1), 'cancel');
        assert.equal(s.dutchSay, null);
        pending.catch(() => {});
    } finally { delete global.dutchVoiceService; }
});
