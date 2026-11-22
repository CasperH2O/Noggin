// "Hey Jibo" opens Noggin (lib/hey-jibo.js) from the background script, with Jibo's hotword and
// turn events, BEam's background api and Noggin's settings replaced by fakes.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const heyJibo = require(path.join(source, 'noggin/lib/hey-jibo.js'));
const settings = require(path.join(source, 'noggin/lib/settings.js'));

function emitter() {
    const fns = [];
    return {on: f => fns.push(f), off: f => fns.splice(fns.indexOf(f), 1), fire: (...a) => fns.slice().forEach(f => f(...a)), get count() { return fns.length; }};
}
function fakeJibo() {
    const jibo = {cancels: 0, privacyController: {enabled: false},
        jetstream: {events: {hjHeard: emitter(), globalTurnStarted: emitter(), globalTurnResult: emitter()}, cancelAnyTurn: () => { jibo.cancels++; }}};
    return jibo;
}
function fakeApi(over = {}) {
    const api = {opened: [], open: data => { if (api.isOpen()) return false; api.opened.push(data); api.showing = true; return true; },
        isOpen: () => !!api.showing, isIdle: () => api.idle !== false, showing: false, idle: true};
    return Object.assign(api, over);
}
function fakeLog() { const lines = []; return {lines, info: m => lines.push(m), warn: m => lines.push('WARN ' + m), error: m => lines.push('ERROR ' + m)}; }

test('the setting is off by default, on the Behaviour tab, and only takes true or false', () => {
    const field = settings.SCHEMA.find(f => f.key === 'heyJibo');
    assert.equal(field.default, false);
    assert.equal(field.type, 'bool');
    assert.equal(field.tab, 'behaviour');
    assert.ok(!field.advanced, 'shown, not folded away');
    assert.ok(settings.check(field, 'yes').error);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-hey-'));
    assert.equal(settings.load(dir).config.heyJibo, false);
    assert.ok(settings.update(dir, {heyJibo: true}).ok);
    assert.equal(settings.load(dir).config.heyJibo, true);
    assert.ok(settings.schemaView().some(f => f.key === 'heyJibo' && f.label));
});

test('setting off: "Hey Jibo" is left to Jibo, nothing opens, nothing is cancelled', () => {
    const jibo = fakeJibo(), api = fakeApi(), log = fakeLog();
    const w = heyJibo.watch(jibo, api, {enabled: () => false, log});
    jibo.jetstream.events.hjHeard.fire();
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(api.opened.length, 0);
    assert.equal(jibo.cancels, 0);
    w.stop();
});

test('setting on and Jibo idle: Noggin opens with the time it was heard, and the hotword\'s turn is cancelled twice', () => {
    const jibo = fakeJibo(), api = fakeApi(), log = fakeLog();
    let t = 1000;
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log, now: () => t});
    jibo.jetstream.events.hjHeard.fire();
    assert.deepEqual(api.opened, [{reason: 'hey_jibo', heardAt: 1000}]);
    assert.equal(jibo.cancels, 1, 'right away');
    t = 1600;
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 2, 'and once the turn has started');
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 2, 'a later turn is not ours');
    assert.ok(log.lines.some(l => /opening Noggin, turn cancelled/.test(l)), log.lines.join('\n'));
    assert.ok(log.lines.some(l => /cloud turn cancelled after 600 ms/.test(l)), log.lines.join('\n'));
    w.stop();
});

test('not idle, already open, privacy, or the open refused: nothing is opened or cancelled', () => {
    const cases = [
        [fakeApi({idle: false}), fakeJibo()],
        [fakeApi({showing: true}), fakeJibo()],
        [fakeApi(), Object.assign(fakeJibo(), {privacyController: {enabled: true}})],
        [fakeApi({open: () => false}), fakeJibo()],
        [fakeApi({isIdle: undefined}), fakeJibo()]   // a BEam without isIdle
    ];
    for (const [api, jibo] of cases) {
        const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog()});
        jibo.jetstream.events.hjHeard.fire();
        jibo.jetstream.events.globalTurnStarted.fire();
        assert.equal(jibo.cancels, 0);
        assert.equal((api.opened || []).length, 0);
        w.stop();
    }
});

test('review: the hotword turn ended with its result, then Noggin\'s own cloud turn starts: it is left alone (D132)', () => {
    const jibo = fakeJibo(), api = fakeApi();
    let t = 0;
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: () => t});
    jibo.jetstream.events.hjHeard.fire();
    jibo.jetstream.events.globalTurnResult.fire({status: 'CANCELED'});
    t = 4000;
    jibo.jetstream.events.globalTurnStarted.fire();   // mimicGlobalTurn of a cloud handover
    assert.equal(jibo.cancels, 1, 'only the hotword\'s cancel');
    w.stop();
});

test('review: no turn result reached the background, but the conversation\'s handover released the claim (D132)', () => {
    const jibo = fakeJibo(), api = fakeApi();
    let t = 0;
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: () => t});
    jibo.jetstream.events.hjHeard.fire();
    t = 4000;
    heyJibo.release();   // what conversation-tools.js handOver() does, from the skill's own copy of the module
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 1);
    w.stop();
});

test('a turn that starts too late after the hotword is left alone', () => {
    const jibo = fakeJibo(), api = fakeApi();
    let t = 0;
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: () => t});
    jibo.jetstream.events.hjHeard.fire();
    t = heyJibo.TURN_MS;
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 1);
    w.stop();
});

test('settings that cannot be read count as off and are logged', () => {
    const jibo = fakeJibo(), api = fakeApi(), log = fakeLog();
    const w = heyJibo.watch(jibo, api, {enabled: () => { throw Error('broken'); }, log});
    jibo.jetstream.events.hjHeard.fire();
    assert.equal(api.opened.length, 0);
    assert.ok(log.lines.some(l => /settings unreadable: broken/.test(l)));
    w.stop();
});

test('stop() removes both listeners; a runtime without the events or cancelAnyTurn does not throw', () => {
    const jibo = fakeJibo(), api = fakeApi();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog()});
    w.stop();
    assert.equal(jibo.jetstream.events.hjHeard.count, 0);
    assert.equal(jibo.jetstream.events.globalTurnStarted.count, 0);
    assert.equal(jibo.jetstream.events.globalTurnResult.count, 0);
    const log = fakeLog();
    const bare = heyJibo.watch({}, api, {enabled: () => true, log});
    assert.ok(log.lines.some(l => /no hotword event/.test(l)));
    bare.stop();
    const noCancel = {jetstream: {events: {hjHeard: emitter()}}};
    const w2 = heyJibo.watch(noCancel, fakeApi(), {enabled: () => true, log: fakeLog()});
    assert.doesNotThrow(() => noCancel.jetstream.events.hjHeard.fire());
    w2.stop();
});

test('fromResult and ownTurn: only a background open with the hey_jibo reason, only shortly after it', () => {
    const heard = {nlu: {intent: 'background', entities: {reason: 'hey_jibo', heardAt: 5000}}};
    assert.deepEqual(heyJibo.fromResult(heard), {heardAt: 5000});
    assert.equal(heyJibo.fromResult(undefined), null);
    assert.equal(heyJibo.fromResult({nlu: {intent: 'menu', entities: {reason: 'hey_jibo', heardAt: 5000}}}), null);
    assert.equal(heyJibo.fromResult({nlu: {intent: 'background', entities: {reason: 'call'}}}), null);
    assert.equal(heyJibo.fromResult({nlu: {intent: 'background', entities: {reason: 'hey_jibo', heardAt: '5000'}}}), null);
    assert.equal(heyJibo.ownTurn({heardAt: 5000}, 5800), true);
    assert.equal(heyJibo.ownTurn({heardAt: 5000}, 5000 + heyJibo.TURN_MS), false);
    assert.equal(heyJibo.ownTurn({heardAt: 5000}, 4000), false);
    assert.equal(heyJibo.ownTurn(null, 5000), false);
});

// ---- background.js, as BEam runs it, with the setting in a real settings.json ----
test('background.js watches "Hey Jibo" with the saved setting, read at each hotword, and stops watching on stop()', async () => {
    const jibo = fakeJibo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-hey-bg-'));
    const original = Module._load, dataDir = settings.dataDir, http = require('http'), createServer = http.createServer;
    Module._load = function (request) { return request === 'jibo' ? jibo : original.apply(this, arguments); };
    settings.dataDir = () => dir;
    http.createServer = undefined;   // no settings page needed here
    const file = path.join(source, 'noggin/background.js');
    delete require.cache[require.resolve(file)];
    const background = require(file);
    const api = fakeApi({skillId: '@be/noggin', log: fakeLog()});
    try {
        background.start(api);
        jibo.jetstream.events.hjHeard.fire();
        assert.equal(api.opened.length, 0, 'off by default');
        assert.ok(settings.update(dir, {heyJibo: true}).ok);
        jibo.jetstream.events.hjHeard.fire();
        assert.equal(api.opened.length, 0, 'on, but no API key: Jibo keeps his own "Hey Jibo"');
        assert.ok(settings.update(dir, {apiKey: 'sk-test-key'}).ok);
        jibo.jetstream.events.hjHeard.fire();
        assert.equal(api.opened.length, 1, 'on without a restart');
        assert.equal(api.opened[0].reason, 'hey_jibo');
        await background.stop();
        assert.equal(jibo.jetstream.events.hjHeard.count, 0, 'unwatched');
    } finally {
        Module._load = original; settings.dataDir = dataDir; http.createServer = createServer;
        await background.stop();
    }
});
