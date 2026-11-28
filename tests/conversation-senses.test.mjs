// SPDX-License-Identifier: MIT
// Noggin: petting and whom Jibo sees (conversation-senses.js, D144, D145).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {realtime, ExpressionPlayer, memoryLib, sleep, untilListening, listening, youSay, reply, until, LEFT, BACK, petDB, emotion, notesSent, touchLogs} from './helpers/conversation.mjs';

// ---- petting and whom Jibo sees (D144, D145) ----
test('petting: the touch is heard on touchOn, never the global touchStop; holding the head quits after 3 s while Noggin is open, Jibo\'s own time after', async () => {
    const h = await listening();
    assert.equal(h.jibo.system.events.touchOn.count, 1);
    assert.equal(h.jibo.globalEvents.touchStop.count, 0, 'touchStop has one listener at a time: the action system\'s hold to quit');
    assert.deepEqual(h.jibo.action.holds, [3000]);
    await h.talk.close();
    assert.deepEqual(h.jibo.action.holds, [3000, 'reset']);
    assert.equal(h.jibo.system.events.touchOn.count, 0);
});

test('petting: without the action system\'s hold time, nothing is set or reset', async () => {
    const h = await listening({action: null});
    h.jibo.system.events.touchOn.fire(LEFT);
    await h.talk.close();
    assert.equal(h.talk.state, 'closed');
});

test('petting while Jibo listens: his own petting clip plays at once with the microphone closed, then it reopens fresh and the model gets a note', async () => {
    const db = petDB(80);
    const h = await listening({animDB: db.animDB, expression: db.expression, emotion: Object.create(emotion, {asked: {value: []}})});
    const clearsBefore = h.sent.filter(e => e.type === 'input_audio_buffer.clear').length;
    h.jibo.system.events.touchOn.fire(LEFT);
    await until(() => db.played.length === 1);
    assert.equal(db.played[0].name, 'rub_head_l_01');
    assert.deepEqual(h.jibo.emotion.asked, [LEFT], 'the emotion system picks, as in Jibo\'s idle skill');
    assert.equal(db.queries[0].category, 'Touch'); assert.deepEqual(db.queries[0].includeMeta, ['rub-left']);
    assert.equal(h.talk.gate, false, 'its motors and sounds are not sent to OpenAI');
    assert.equal(h.leds[h.leds.length - 1], '1,0.55,0', 'orange while the microphone is closed');
    h.audio(); assert.equal(h.appends(), 0);
    await until(() => h.logs.some(e => e.kind === 'mic_reopened'));
    assert.equal(h.talk.gate, true);
    assert.ok(h.sent.filter(e => e.type === 'input_audio_buffer.clear').length > clearsBefore, 'the audio so far is dropped');
    const t = touchLogs(h)[0];
    assert.equal(t.side, 'left'); assert.equal(t.at, 'touch'); assert.equal(t.clip, 'rub_head_l_01'); assert.equal(t.result, 'STOPPED');
    assert.deepEqual(notesSent(h), ['[A note, not speech: someone petted your head. You may mention it; never answer this note alone.]']);
    assert.ok(!h.sent.some(e => e.type === 'response.create'), 'a note never asks for a reply');
    h.talk.close();
});

test('petting: touches during the clip only count, and its end tells the model how often; a tickle is told apart', async () => {
    const db = petDB(80);
    const h = await listening({animDB: db.animDB, expression: db.expression, emotion: Object.create(emotion, {asked: {value: []}})});
    const touchOn = h.jibo.system.events.touchOn;
    touchOn.fire(LEFT); await sleep(10); touchOn.fire(LEFT); touchOn.fire(BACK);
    await until(() => touchLogs(h).length === 1);
    assert.equal(db.played.length, 1, 'one clip');
    assert.deepEqual(notesSent(h), ['[A note, not speech: someone petted your head 2 times, and someone tickled the back of your head. You may mention it; never answer this note alone.]']);
    h.talk.close();
});

test('petting: the back pad alone is a tickle and plays a laughing clip', async () => {
    const db = petDB();
    const h = await listening({animDB: db.animDB, expression: db.expression, emotion: Object.create(emotion, {asked: {value: []}})});
    h.jibo.system.events.touchOn.fire(BACK);
    await until(() => touchLogs(h).length === 1);
    assert.equal(db.played[0].name, 'laughter_01'); assert.equal(touchLogs(h)[0].side, 'tickle');
    h.talk.close();
});

test('petting while the person is talking: the clip waits for their turn, so their words are not cut', async () => {
    const db = petDB();
    const h = await listening({animDB: db.animDB, expression: db.expression});
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.jibo.system.events.touchOn.fire(LEFT);
    await sleep(20);
    assert.equal(db.played.length, 0);
    assert.equal(h.talk.gate, true, 'still hearing the person');
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    await until(() => db.played.length === 1);
    assert.equal(h.talk.state, 'thinking'); assert.equal(h.talk.gate, false);
    await until(() => touchLogs(h).length === 1);
    assert.equal(touchLogs(h)[0].at, 'turn'); assert.equal(touchLogs(h)[0].state, 'listening');
    h.talk.close();
});

test('petting while Jibo thinks: the quick reaction gives way, and the first line waits for the clip to end', async () => {
    const db = petDB(80);
    const h = await listening({animDB: db.animDB, expression: db.expression, classify: (person, line) => sleep(30).then(() => ({label: line === null ? 'happy' : 'none'}))});
    youSay(h, 'I got a puppy');
    h.jibo.system.events.touchOn.fire(LEFT);
    await until(() => db.played.length === 1);
    reply(h, 'r1', 'How lovely!');
    await until(() => h.said.length === 2);
    const order = h.logs.filter(e => e.kind === 'touch' || (e.kind === 'speak' && e.turn === 1)).map(e => e.kind);
    assert.deepEqual(order, ['touch', 'speak'], 'the clip ended before the words');
    // Given way to the clip, or held back by the expression gap the clip started.
    assert.ok(['pet', 'limit'].includes((h.talk.turn || h.logs.find(e => e.kind === 'jibo')).reaction.played));
    assert.deepEqual(db.played.map(p => p.name), ['rub_head_l_01'], 'the reaction never replaced it');
    h.talk.close();
});

test('petting while Jibo speaks: the clip plays after the current line, and the next line and listening wait for it', async () => {
    const db = petDB(60);
    const h = await listening({animDB: db.animDB, expression: db.expression, speakMs: 80});
    youSay(h, 'Tell me something');
    reply(h, 'r1', 'Here is one thing. And here is another.');
    await until(() => h.said.length === 2);
    h.jibo.system.events.touchOn.fire(LEFT);
    await sleep(20);
    assert.equal(db.played.length, 0, 'not during the words');
    await untilListening(h);
    const order = h.logs.filter(e => (e.kind === 'spoken' || e.kind === 'speak') && e.turn === 1 || e.kind === 'touch' || e.kind === 'listen').map(e => e.kind + (e.line === undefined ? '' : e.line));
    const i = order.indexOf('touch');
    assert.equal(order[i - 1], 'spoken0'); assert.equal(order[i + 1], 'speak1');
    assert.equal(touchLogs(h)[0].at, 'line_end'); assert.equal(touchLogs(h)[0].played_in, 'speaking');
    h.talk.close();
});

test('petting during a dance, while privacy is on, or with nothing touched: no clip; the dance is logged', async () => {
    const db = petDB();
    const h = await listening({animDB: db.animDB, expression: db.expression});
    h.talk.dancing = true;
    h.jibo.system.events.touchOn.fire(LEFT);
    assert.equal(touchLogs(h)[0].result, 'dancing');
    h.talk.dancing = false;
    h.jibo.system.events.touchOn.fire([false, false, false, false, false, false]);
    h.jibo.privacyController.enabled = true;
    h.jibo.system.events.touchOn.fire(LEFT);
    h.jibo.privacyController.enabled = false;
    await sleep(20);
    assert.equal(db.played.length, 0);
    assert.equal(touchLogs(h).length, 1);
    h.talk.close();
});

test('a petting clip is never replaced by another expression; it may replace one', async () => {
    const db = petDB(60);
    const logs = [];
    const player = new ExpressionPlayer({animDB: db.animDB, expression: db.expression}, {write: e => logs.push(e)});
    const other = player.play('excited_01', {via: 'line'});
    await other.started;
    const pet = player.play('rub_head_l_01', {via: 'pet', keep: true});
    assert.equal(await other.done, 'replaced');
    const late = player.play('sad_01', {via: 'line'});
    assert.equal(await late.done, 'kept');
    assert.equal(await pet.done, 'STOPPED');
    assert.equal(player.play('sad_01').body, null);
});

test('whom Jibo sees: a recognised face seen for 2 s becomes one note with the name; leaving is told too; the log keeps it', async () => {
    let offset = 0, visible = [{id: 'u1', entityId: 7}];
    const lps = {identity: {getVisiblePersons: () => visible}};
    const kb = {loop: {getUserNodeById: id => Promise.resolve(id === 'u1' ? {firstName: 'Emma', nickName: ''} : null)}};
    const h = await listening({lps, kb, now: () => Date.now() + offset});
    offset += 2500; h.talk.lookAround(); await sleep(5); h.talk.lookAround();
    assert.deepEqual(notesSent(h), ['[A note, not speech: your camera now sees Emma. Who you see is not always who is talking. Never answer this note alone.]']);
    h.talk.lookAround();
    assert.equal(notesSent(h).length, 1, 'only changes are told');
    visible = [];
    offset += 21000; h.talk.lookAround();
    assert.equal(notesSent(h)[1], '[A note, not speech: your camera sees no one now.]');
    assert.deepEqual(h.logs.filter(e => e.kind === 'presence').map(e => e.names), [['Emma'], []]);
    h.talk.close();
});

test('whom Jibo sees: notes wait while Jibo thinks or speaks, and go before the next listening; with the setting off nothing is read', async () => {
    let offset = 0;
    const lps = {identity: {getVisiblePersons: () => [{id: 'UNKNOWN', entityId: 3}]}};
    const h = await listening({lps, now: () => Date.now() + offset, speakMs: 60});
    youSay(h, 'Hello');
    reply(h, 'r1', 'Hi there.');
    await until(() => h.talk.state === 'speaking');
    offset += 2500; h.talk.lookAround(); h.talk.lookAround();
    assert.equal(notesSent(h).length, 0, 'not while Jibo speaks');
    await untilListening(h);
    assert.deepEqual(notesSent(h), ["[A note, not speech: your camera now sees someone you don't recognise. Who you see is not always who is talking. Never answer this note alone.]"]);
    h.talk.close();
    const off = await listening({lps, config: {presence: false}});
    assert.equal(off.talk.presence, null);
    off.talk.lookAround();
    assert.equal(notesSent(off).length, 0);
    off.talk.close();
});

test('instructions: with presence the setup says Jibo sees only who the notes name, and memory says the one person seen is probably the one talking', () => {
    assert.match(realtime.voiceSetup(null, null), /You cannot see the room yet/);
    assert.match(realtime.voiceSetup(null, null, {presence: true}), /You see only who the notes name, and in this voice mode/);
    assert.match(realtime.voiceSetup({}, null, {presence: true}), /You see only who the notes name\. /);
    const state = {facts: [], summaries: []};
    assert.match(memoryLib.block(state, '2026-11-12', ''), /you cannot tell who is speaking, so never assume/);
    assert.match(memoryLib.block(state, '2026-11-12', '', true), /see just one person, that is probably who is talking/);
});

test('petting right after a line: the clip holds the microphone, so listening that starts during it stays closed and orange until it ends', async () => {
    const db = petDB(150);
    const h = await listening({animDB: db.animDB, expression: db.expression, config: {echoTailMs: 60}});
    youSay(h, 'Hello');
    reply(h, 'r1', 'Hi there.');
    await until(() => h.logs.some(e => e.kind === 'spoken' && e.turn === 1));
    assert.equal(h.talk.state, 'speaking'); assert.equal(h.talk.speaking, false);
    h.jibo.system.events.touchOn.fire(LEFT);
    await until(() => db.played.length === 1);
    await untilListening(h);
    assert.equal(h.talk.gate, false, 'closed while the clip plays');
    assert.equal(h.leds[h.leds.length - 1], '1,0.55,0');
    await until(() => h.logs.some(e => e.kind === 'mic_reopened'));
    assert.equal(h.talk.gate, true);
    assert.ok(touchLogs(h)[0].played_in === 'speaking');
    h.talk.close();
});

test('petting: touches in the second after a clip only count; they go with the next clip\'s note', async () => {
    const db = petDB(40);
    const h = await listening({animDB: db.animDB, expression: db.expression, config: {silenceSeconds: 5}});
    const touchOn = h.jibo.system.events.touchOn;
    touchOn.fire(LEFT);
    await until(() => notesSent(h).length === 1);
    touchOn.fire(LEFT); touchOn.fire(LEFT);
    await sleep(30);
    assert.equal(notesSent(h).length, 1, 'no note per pat');
    assert.equal(db.played.length, 1);
    await sleep(1000);
    touchOn.fire(LEFT);
    await until(() => notesSent(h).length === 2);
    assert.match(notesSent(h)[1], /petted your head 3 times/);
    h.talk.close();
});

test('petting: a touch that waited longer than 10 s is dropped, and still told', async () => {
    let offset = 0;
    const db = petDB();
    const h = await listening({animDB: db.animDB, expression: db.expression, now: () => Date.now() + offset});
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.jibo.system.events.touchOn.fire(LEFT);
    offset += 11000;
    youSay(h, 'Hello');
    await sleep(20);
    assert.equal(db.played.length, 0);
    assert.equal(touchLogs(h)[0].result, 'stale');
    h.talk.close();
});

test('petting: a line and the dance wait for a clip at most petWaitMs; the microphone hold ends after petHoldMaxMs', async () => {
    const h = await listening();
    h.talk.petWaitMs = 60; h.talk.petHoldMaxMs = 80;
    const never = {done: new Promise(() => {})};
    h.talk.petting = never;
    const started = Date.now();
    await h.talk.petDone();
    assert.ok(Date.now() - started >= 55);
    h.talk.holdMic(never.done, {maxMs: h.talk.petHoldMaxMs, fresh: true});
    assert.equal(h.talk.gate, false);
    await until(() => h.talk.gate === true, 500);
    h.talk.petting = null;
    h.talk.close();
});

test('the dance tool waits for a petting clip still playing', async () => {
    const h = await listening();
    let end;
    h.talk.petting = {done: new Promise(r => { end = r; })};
    let danced = false;
    h.talk.dance = () => { danced = true; return Promise.resolve({style: 'pop'}); };
    const run = h.talk.runLocal('dance', {}, null);
    await sleep(20);
    assert.equal(danced, false);
    end('STOPPED');
    await run;
    assert.equal(danced, true);
    h.talk.close();
});

test('whom Jibo sees: after a reconnect the new session is told again; after close nobody is looked for', async () => {
    let offset = 0, looks = 0;
    const lps = {identity: {getVisiblePersons: () => { looks++; return [{id: 'u1', entityId: 7}]; }}};
    const kb = {loop: {getUserNodeById: () => Promise.resolve({firstName: 'Emma'})}};
    const h = await listening({lps, kb, now: () => Date.now() + offset});
    offset += 2500; h.talk.lookAround(); await sleep(5); h.talk.lookAround();
    assert.equal(notesSent(h).length, 1);
    h.emit({type: 'transport.closed'});
    await until(() => h.connects() === 2 && h.talk.state === 'listening');
    h.talk.lookAround();
    await until(() => notesSent(h).filter(t => /now sees Emma/.test(t)).length === 2);
    await h.talk.close();
    const after = looks;
    await sleep(1100);
    assert.equal(looks, after, 'the 1 s look stopped with the conversation');
});

