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

// A clock the test steps by hand.
function fakeClock() {
    const c = {t: 0, timers: [], now: () => c.t,
        setTimeout: (fn, ms) => { const id = {fn, at: c.t + ms}; c.timers.push(id); return id; },
        clearTimeout: id => { c.timers = c.timers.filter(x => x !== id); },
        advance(ms) { const end = c.t + ms; for (;;) { const next = c.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!next) break; c.timers = c.timers.filter(x => x !== next); c.t = next.at; next.fn(); } c.t = end; }};
    return c;
}
// Noggin's screen comes up only when the test says so (Be queues the switch behind Jibo's own "Hey Jibo" action).
function slowApi() {
    const api = {opened: [], showing: false, open: data => { api.opened.push(data); return true; }, isOpen: () => api.showing, isIdle: () => true};
    return api;
}
const ORANGE = '1,0.55,0', RING_OFF = '0,0,0';
function ledJibo() {
    const jibo = fakeJibo();
    jibo.leds = [];
    jibo.expression = {setLEDColor: c => jibo.leds.push(c.join(','))};
    return jibo;
}


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

test('setting on and Jibo idle: Noggin opens with the time it was heard; the turn is cancelled 600 ms later, not at once (D136)', () => {
    const jibo = fakeJibo(), api = fakeApi(), log = fakeLog(), clock = fakeClock();
    clock.t = 1000;
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log, now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    assert.deepEqual(api.opened, [{reason: 'hey_jibo', heardAt: 1000}]);
    assert.equal(jibo.cancels, 0, 'not before Jibo\'s own action has restarted');
    clock.advance(600);
    assert.equal(jibo.cancels, 1, 'cancelled at 600 ms');
    clock.advance(200);
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 2, 'a turn that only starts after that cancel was not running for it: cancelled again');
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 2, 'a later turn is not ours');
    assert.ok(log.lines.some(l => /: opening Noggin$/.test(l)), log.lines.join('\n'));
    assert.ok(log.lines.some(l => /: turn cancelled after 600 ms$/.test(l)), log.lines.join('\n'));
    assert.ok(log.lines.some(l => /: its cloud turn cancelled after 800 ms$/.test(l)), log.lines.join('\n'));
    w.stop();
});

test('review: the turn started during the delay is the one the delayed cancel ends; a later turn is not cancelled (D138)', () => {
    const jibo = fakeJibo(), api = fakeApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(400);
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 0, 'left to the delayed cancel');
    clock.advance(200);
    assert.equal(jibo.cancels, 1);
    clock.advance(2000);
    jibo.jetstream.events.globalTurnStarted.fire();   // no CANCELED result reached us (D134): still not ours
    assert.equal(jibo.cancels, 1);
    w.stop();
});

test('review: Jibo\'s own blue at turn start and off at the cancel are painted orange again at once while waiting (D138)', () => {
    const jibo = ledJibo(), api = slowApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(100);
    const n = jibo.leds.length;
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.leds.length, n + 1, 'at the turn start');
    clock.advance(500);   // the delayed cancel at 600 ms (and one ring step at 400)
    assert.equal(jibo.leds.at(-1), ORANGE);
    assert.equal(jibo.leds.length, n + 3, 'step at 400 ms, then at the cancel');
    api.showing = true;
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.leds.length, n + 3, 'not once Noggin is open');
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
    const jibo = fakeJibo(), api = fakeApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(600);
    jibo.jetstream.events.globalTurnResult.fire({status: 'CANCELED'});
    clock.advance(3400);
    jibo.jetstream.events.globalTurnStarted.fire();   // mimicGlobalTurn of a cloud handover
    assert.equal(jibo.cancels, 1, 'only the hotword\'s cancel');
    w.stop();
});

test('a turn that ended by itself before the delayed cancel (no network): no cancel is sent (D136)', () => {
    const jibo = fakeJibo(), api = fakeApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(300);
    jibo.jetstream.events.globalTurnResult.fire({status: 'FAILED'});
    clock.advance(1000);
    assert.equal(jibo.cancels, 0);
    clock.advance(10000);
    assert.equal(clock.timers.length, 0);
    w.stop();
});

test('review: no turn result reached the background, but the conversation\'s handover released the claim (D132)', () => {
    const jibo = fakeJibo(), api = fakeApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(4000);
    heyJibo.release();   // what conversation-tools.js handOver() does, from the skill's own copy of the module
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 1);
    w.stop();
});

test('the ring is orange from "Hey Jibo" until Noggin is open, re-sent while Jibo\'s own listening ends (D135)', () => {
    const jibo = ledJibo(), api = slowApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    assert.ok(jibo.leds.length >= 1 && jibo.leds.every(c => c === ORANGE), 'at once: ' + jibo.leds.join(' '));
    clock.advance(4400);
    assert.ok(jibo.leds.length >= 10 && jibo.leds.every(c => c === ORANGE), jibo.leds.join(' '));
    api.showing = true;   // the conversation owns the ring now
    const before = jibo.leds.length;
    clock.advance(8000);
    assert.equal(jibo.leds.length, before, 'never touched while Noggin is open');
    assert.equal(clock.timers.length, 0, 'no timer left after 10 s');
    w.stop();
});

test('review: Noggin was made current but its open failed and Be went back to idle: the ring goes off (D137)', () => {
    const jibo = ledJibo(), api = slowApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(2000);
    api.showing = true;    // Be's scheduler names Noggin current before Noggin's code runs
    clock.advance(800);
    api.showing = false;   // 'skill open failed': back to idle
    clock.advance(400);
    assert.equal(jibo.leds.at(-1), RING_OFF);
    assert.equal(clock.timers.length, 0);
    w.stop();
});

test('review: another skill wins the switch (a menu tap): the hold ends without touching its ring (D137)', () => {
    const jibo = ledJibo(), api = slowApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(1200);
    const before = jibo.leds.length;
    api.isIdle = () => false;   // neither idle nor Noggin
    clock.advance(12000);
    assert.equal(jibo.leds.length, before, 'no orange over it, no off at 10 s');
    assert.equal(clock.timers.length, 0);
    w.stop();
    assert.equal(jibo.leds.length, before, 'stop() leaves it alone too');
});

test('review: privacy switched on during the hold stops the colour; a second "Hey Jibo" keeps one timer (D137)', () => {
    const jibo = ledJibo(), api = slowApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(500);
    jibo.jetstream.events.hjHeard.fire();
    assert.equal(api.opened.length, 1, 'the second one is ignored while Noggin is opening');
    assert.equal(clock.timers.length, 2, 'one ring timer and one cancel timer');
    jibo.privacyController.enabled = true;
    const before = jibo.leds.length;
    clock.advance(12000);
    assert.equal(jibo.leds.length, before, 'nothing sent in privacy, also not the off at 10 s');
    assert.equal(clock.timers.length, 0);
    w.stop();
});

test('the ring is orange before api.open() is called (BEam may load Noggin inside it); a refused open sets it off again (D139)', () => {
    const jibo = ledJibo(), clock = fakeClock();
    let ledsAtOpen = null;
    const api = Object.assign(slowApi(), {open: data => { ledsAtOpen = jibo.leds.slice(); api.opened.push(data); return true; }});
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    assert.deepEqual(ledsAtOpen, [ORANGE]);
    w.stop();
    const refused = ledJibo(), log = fakeLog();
    const w2 = heyJibo.watch(refused, fakeApi({open: () => false}), {enabled: () => true, log, now: clock.now, clock});
    refused.jetstream.events.hjHeard.fire();
    assert.deepEqual(refused.leds, [ORANGE, RING_OFF]);
    assert.ok(log.lines.some(l => /did not open/.test(l)));
    w2.stop();
    const thrown = ledJibo(), log3 = fakeLog();
    const w3 = heyJibo.watch(thrown, fakeApi({open: () => { throw Error('boom'); }}), {enabled: () => true, log: log3, now: clock.now, clock});
    assert.doesNotThrow(() => thrown.jetstream.events.hjHeard.fire());
    assert.deepEqual(thrown.leds, [ORANGE, RING_OFF], 'review: a throwing open leaves no orange');
    assert.ok(log3.lines.some(l => /open threw: boom/.test(l)));
    w3.stop();
});

test('Noggin never opens: the ring goes back off after 10 s and the hold ends (D135)', () => {
    const jibo = ledJibo(), api = slowApi(), clock = fakeClock(), log = fakeLog();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log, now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(12000);
    assert.equal(jibo.leds.at(-1), RING_OFF);
    assert.equal(clock.timers.length, 0);
    assert.ok(log.lines.some(l => /did not open within 10000 ms/.test(l)));
    w.stop();
});

test('stopped while orange (an update): the ring goes off and nothing is left running; privacy: the ring is never touched (D135)', () => {
    const jibo = ledJibo(), api = slowApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(1000);
    w.stop();
    assert.equal(jibo.leds.at(-1), RING_OFF);
    assert.equal(clock.timers.length, 0);
    const quiet = ledJibo(), clock2 = fakeClock(), api2 = slowApi();
    const w2 = heyJibo.watch(quiet, api2, {enabled: () => true, log: fakeLog(), now: clock2.now, clock: clock2});
    quiet.privacyController.enabled = true;
    quiet.jetstream.events.hjHeard.fire();
    clock2.advance(1000);
    assert.deepEqual(quiet.leds, []);
    w2.stop();
});

test('a turn that starts too late after the hotword is left alone', () => {
    const jibo = fakeJibo(), api = fakeApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    clock.advance(heyJibo.TURN_MS);
    jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(jibo.cancels, 1);
    w.stop();
});

test('stopped before the delayed cancel (an update): no cancel and no timer left (D136)', () => {
    const jibo = fakeJibo(), api = fakeApi(), clock = fakeClock();
    const w = heyJibo.watch(jibo, api, {enabled: () => true, log: fakeLog(), now: clock.now, clock});
    jibo.jetstream.events.hjHeard.fire();
    w.stop();
    clock.advance(1000);
    assert.equal(jibo.cancels, 0);
    assert.equal(clock.timers.length, 0);
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
