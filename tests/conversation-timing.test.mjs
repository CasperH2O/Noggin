// SPDX-License-Identifier: MIT
// Noggin: startup timing and the timing log of a turn, with clips beside the lines.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {audio, openai, ExpressionPlayer, DEFAULTS, sleep, harness, clips, untilListening, listening, youSay, reply, fakeActions, until, fakeAnimDB, fakeEye, bodyHarness, sayTwoLines, heardTurn, words} from './helpers/conversation.mjs';

// ---- startup timing ----
test('startup: one log line with each step\'s time since the skill opened, in order, and what each wait ended on', async () => {
    const h = await listening({openedAt: Date.now() - 50, startup: {source: 'test', since_comeback_ms: 12}});
    h.audio();
    const s = h.logs.filter(e => e.kind === 'startup');
    assert.equal(s.length, 1);
    const st = s[0];
    assert.equal(st.source, 'test'); assert.equal(st.since_comeback_ms, 12); assert.equal(st.eye, 'shown'); assert.equal(st.hotword, 'off'); assert.equal(st.resumed, false);
    // Side by side after talk_open: the eye then the greeting; the connection; the microphone; the hotword.
    const chains = [['talk_created', 'talk_open', 'eye', 'first_speech_queued', 'first_speech', 'first_speech_done', 'listening'],
        ['talk_open', 'session_created', 'session_updated', 'listening'], ['talk_open', 'mic_start', 'mic_ready', 'listening'], ['talk_open', 'hotword', 'listening']];
    chains.forEach(order => {
        order.forEach(k => assert.equal(typeof st.ms[k], 'number', k));
        for (let i = 1; i < order.length; i++) assert.ok(st.ms[order[i]] >= st.ms[order[i - 1]], order[i] + ' after ' + order[i - 1]);
    });
    assert.ok(st.ms.talk_created >= 50, 'counted from openedAt');
    assert.ok(st.ms.first_speech_done - st.ms.first_speech >= 15, 'the greeting took its time');
    assert.equal(h.logs.indexOf(st), h.logs.findIndex(e => e.kind === 'startup'));
    h.talk.close();
});

test('startup: waits that time out are named, and only listening waits for the hotword; a failed start still logs its steps', async () => {
    const h = harness();
    h.jibo.face.views.forceEyeView = () => {};                      // never calls back
    h.jibo.jetstream.setHotwordMode = () => ({activated: new Promise(() => {}), release() {}});
    h.talk.open(); await untilListening(h);
    const st = h.logs.find(e => e.kind === 'startup');
    assert.equal(st.eye, 'timeout'); assert.equal(st.hotword, 'timeout');
    assert.ok(st.ms.eye >= 1450 && st.ms.hotword >= 1950 && st.ms.listening >= st.ms.hotword);
    assert.ok(st.ms.session_updated < 1000, 'connected without waiting for the eye or the hotword');
    h.talk.close();
    const f = harness({config: {greeting: ''}});
    f.talk.connectFn = () => Promise.reject(Error('no session from OpenAI within 15 s'));
    assert.equal(await f.talk.open(), 'error');
    const failed = f.logs.find(e => e.kind === 'startup');
    assert.match(failed.failed, /no session/);
    assert.equal(failed.ms.session_created, undefined);
});

test('startup after the clock: since_comeback_ms, the timer read, the model\'s first text and words', async () => {
    const h = harness({actions: fakeActions(), config: {comebackLine: ''}, resume: {pairs: [], tool: 'set_timer', args: {}, said: ''}, startup: {since_comeback_ms: 420}});
    h.talk.open();
    await until(() => h.sent.some(e => e.type === 'response.create'));
    reply(h, 'r1', 'Anything else?');
    await untilListening(h);
    const st = h.logs.find(e => e.kind === 'startup');
    assert.equal(st.resumed, 'set_timer'); assert.equal(st.since_comeback_ms, 420);
    ['resume_timer_read', 'first_text', 'first_speech', 'first_speech_done', 'listening'].forEach(k => assert.equal(typeof st.ms[k], 'number', k));
    h.talk.close();
});

test('realtime connect records socket open and session.created times', async () => {
    class FakeSocket { constructor() { FakeSocket.last = this; this.readyState = 1; setTimeout(() => { this.onopen && this.onopen(); setTimeout(() => this.onmessage({data: JSON.stringify({type: 'session.created', session: {}})}), 15); }, 10); } send() {} close() {} }
    const before = Date.now();
    const rt = await openai.connect({apiBase: 'https://x/v1', realtimeModel: 'm', apiKey: 'k'}, FakeSocket);
    assert.ok(rt.timing.start >= before && rt.timing.open >= rt.timing.start + 5 && rt.timing.created >= rt.timing.open + 10);
});

test('after the greeting the microphone stays closed for echoTailMs, as after any other line', async () => {
    const h = harness({config: {echoTailMs: 150}});
    h.talk.open();
    await until(() => h.logs.some(e => e.kind === 'startup' || e.kind === 'speak') && h.talk.speaking === false && h.said.length === 1);
    await sleep(60);
    assert.notEqual(h.talk.state, 'listening'); h.audio(); assert.equal(h.appends(), 0, 'nothing sent during the echo tail');
    await untilListening(h);
    const st = h.logs.find(e => e.kind === 'startup');
    assert.ok(st.ms.listening - st.ms.first_speech_done >= 140, 'listening ' + (st.ms.listening - st.ms.first_speech_done) + ' ms after the greeting');
    h.talk.close();
});

test('fast start: the greeting (with its expression) begins once the eye shows, before OpenAI has even answered', async () => {
    const h = harness({config: {greetingExpression: 'hello', echoTailMs: 50}});
    let connectAsked = null, answer;
    h.talk.connectFn = () => { connectAsked = Date.now(); return new Promise(resolve => { answer = () => resolve(h.rt); }); };
    h.talk.open();
    await until(() => h.said.length === 1);
    assert.equal(h.said[0], 'Hi!'); assert.deepEqual(clips(h), ['greetings_01@null']);
    assert.ok(connectAsked, 'connecting while Jibo greets');
    await sleep(80);
    assert.notEqual(h.talk.state, 'listening', 'no listening before OpenAI is ready');
    answer();
    await untilListening(h);
    const st = h.logs.find(e => e.kind === 'startup');
    assert.ok(st.ms.first_speech <= st.ms.session_updated, 'greeting started before the session was ready');
    assert.ok(st.ms.listening >= st.ms.session_updated);
    assert.equal(h.talk.policy.last, 'hello', 'the greeting expression counts for the expression limits');
    h.talk.close();
});

test('a connection that fails during the greeting lets Jibo finish it, then he apologises', async () => {
    const h = harness({speakMs: 120});
    h.talk.connectFn = () => Promise.reject(Error('connection closed (1006)'));
    const ended = h.talk.open();
    assert.equal(await ended, 'error');
    assert.equal(h.said[0], 'Hi!');
    assert.match(h.said[1], /can't think straight/);
    assert.ok(h.logs.some(e => e.kind === 'startup' && /1006/.test(e.failed)));
});

test('no greeting: listening starts as soon as everything is ready', async () => {
    const h = await listening({config: {greeting: ''}});
    assert.equal(h.said.length, 0);
    h.talk.close();
});

test('back after the clock: Jibo says "Anything else?" at once, while OpenAI connects; the model only hears that he did', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts, resume: {pairs: [{you: 'set a timer for five minutes', jibo: ''}], tool: 'set_timer', args: {seconds: 300, duration: '5 minutes'}, said: 'You got it. 5 minutes.'}});
    let answer;
    h.talk.connectFn = () => new Promise(resolve => { answer = () => resolve(h.rt); });
    h.talk.open();
    await until(() => h.said.length === 1);
    assert.equal(h.said[0], 'Anything else?', 'spoken before the session exists, with no animation');
    answer();
    await untilListening(h);
    assert.ok(!h.sent.some(e => e.type === 'response.create'), 'no reply asked of the model');
    const note = h.sent.find(e => e.type === 'conversation.item.create').item.content[0].text;
    assert.match(note, /have just said: "Anything else\?"\. Wait for your person's answer/);
    assert.match(note, /A timer is now running with 5 minutes left/);
    assert.deepEqual(h.talk.pairs.at(-1), {you: '', jibo: 'Anything else?'});
    const st = h.logs.find(e => e.kind === 'startup');
    assert.ok(st.ms.listening - st.ms.first_speech_done >= 5, 'echo tail after the line');
    h.talk.close();
});

// ---- timing log (where a turn's time goes) ----
test('timing log: each line says what it waited for and whose expression it got', async () => {
    const h = harness({config: {expressionWaitMs: 300}, classify: (person, line, kind) => kind === 'reaction'
        ? sleep(10).then(() => ({label: 'thinking', confidence: 0.4})) : sleep(40).then(() => ({label: 'none'}))});
    h.talk.open(); await untilListening(h);
    assert.equal(h.logs.find(e => e.kind === 'session').timing.expressionWaitMs, 300);
    youSay(h, 'Do you have a favourite bird?');
    reply(h, 'r1', 'Yes, the penguin. It is black and white.');
    await untilListening(h);
    const waits = h.logs.filter(e => e.kind === 'line_wait');
    assert.equal(waits.length, 2);
    assert.equal(waits[0].by, 'reaction', 'the reaction decided the first line'); assert.equal(waits[0].used, 'thinking');
    assert.equal(waits[0].reaction, 'thinking'); assert.equal(waits[0].label, null, 'the line classifier was not waited for');
    assert.ok(waits[0].released - waits[0].reached < 30, 'released when the reaction came, not the label');
    assert.ok(waits[0].reaction_at <= waits[0].released && waits[0].queued <= waits[0].reached && waits[0].reached <= waits[0].released);
    assert.equal(waits[1].reaction, undefined);
    assert.equal(typeof h.logs.find(e => e.kind === 'jibo').reaction.at, 'number');
    h.talk.close();
});

test('timing log: a line label that comes after the wait is logged as late', async () => {
    const h = harness({config: {expressionWaitMs: 20}, classify: (person, line, kind) => kind === 'reaction'
        ? Promise.resolve({label: 'none'}) : sleep(120).then(() => ({label: 'happy'}))});
    h.talk.open(); await untilListening(h);
    youSay(h, 'Hello');
    reply(h, 'r1', 'Hello there.');
    await until(() => h.logs.some(e => e.kind === 'label_late'));
    const wait = h.logs.find(e => e.kind === 'line_wait'), late = h.logs.find(e => e.kind === 'label_late');
    assert.equal(wait.by, 'reaction', 'released by the "none" reaction, not by the label'); assert.equal(wait.label_ms, null); assert.equal(wait.label, null);
    assert.equal(late.label, 'happy'); assert.equal(late.line, 0); assert.ok(late.ms >= 100);
    h.talk.close();
});

test('timing log: the speak entry says whether the animation started or the lead ran out', async () => {
    // started: the fake fires `started` 3 ms after play
    const db = fakeAnimDB();
    const h = await listening({config: {greetingExpression: 'hello', expressionLeadMs: 200}, animDB: db.animDB, expression: db.expression});
    const first = h.logs.find(e => e.kind === 'speak');
    assert.equal(first.lead, 'started'); assert.ok(first.lead_ms < 200);
    h.talk.close();
    // failed: rejected before it started
    const rejected = fakeAnimDB({greetings_01: 'REJECTED'});
    const r = await listening({config: {greetingExpression: 'hello', expressionLeadMs: 200}, animDB: rejected.animDB, expression: rejected.expression});
    assert.equal(r.logs.find(e => e.kind === 'speak').lead, 'failed');
    r.talk.close();
    // timeout: no `started` within the lead
    const slow = {getAnimByName: () => ({meta: {endsNeutral: true}, createFromConfig: () => Promise.resolve({instance: {events: {}},
        play: () => sleep(150).then(() => 'STOPPED'), stop: () => Promise.resolve()})})};
    const s = await listening({config: {greetingExpression: 'hello', expressionLeadMs: 20}, animDB: slow, expression: db.expression});
    const late = s.logs.find(e => e.kind === 'speak');
    assert.equal(late.lead, 'timeout'); assert.ok(late.lead_ms >= 15);
    s.talk.close();
});

test('timing log: the thinking eye logs when it loaded, played, stopped and was centred', async () => {
    const db = fakeAnimDB();
    const h = await listening({config: {thinkingEye: true}, animDB: db.animDB, expression: db.expression});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    await sleep(30);
    h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello'});
    reply(h, 'r1', 'Hello there.');
    await untilListening(h);
    const eye = h.logs.find(e => e.kind === 'thinking_eye');
    assert.ok(eye, 'logged');
    assert.equal(eye.turn, 1);
    assert.ok(eye.asked <= eye.loaded && eye.loaded <= eye.stop && eye.stop <= eye.stopped && eye.stopped <= eye.centred, JSON.stringify(eye));
    h.talk.close();
});

test('timing log: a blocked thread shows as lag in the turn and the 10 s report; the probe stops on close', async () => {
    const h = await listening();
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    await sleep(60);
    const until = Date.now() + 150; while (Date.now() < until) { /* block the thread */ }
    await sleep(60);
    h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello'});
    reply(h, 'r1', 'Hello there.');
    await untilListening(h);
    const lag = h.logs.find(e => e.kind === 'jibo').lag;
    assert.ok(Array.isArray(lag) && lag.some(spike => spike[1] >= 80), JSON.stringify(lag));
    h.talk.audioReport();
    const audio = h.logs.filter(e => e.kind === 'audio').pop();
    assert.equal(typeof audio.lagMax, 'number');
    assert.ok(audio.load === null || typeof audio.load === 'number');
    await h.talk.close();
    const last = h.talk.lag.last;
    await sleep(3 * 50);
    assert.equal(h.talk.lag.last, last, 'the lag probe stopped');
});

test('timing log: no lag probe when the full log is off; lines without a classifier say so', async () => {
    const h = harness({config: {expressions: false}});
    h.talk.log.enabled = false;
    h.talk.open(); await untilListening(h);
    assert.equal(h.talk.lagTimer, null, 'nothing measured that nobody keeps');
    youSay(h, 'Hello');
    reply(h, 'r1', 'Hello there.');
    await untilListening(h);
    const wait = h.logs.find(e => e.kind === 'line_wait');
    assert.equal(wait.by, 'no_classifier'); assert.equal(wait.label, null); assert.equal(wait.used, null);
    assert.equal(h.logs.find(e => e.kind === 'jibo').lag, undefined);
    h.talk.close();
});

test('first line: after a "none" reaction the line does not wait for its own expression; the label comes late (D104)', async () => {
    const h = harness({config: {expressionWaitMs: 300}, classify: (person, line, kind) => kind === 'reaction'
        ? sleep(5).then(() => ({label: 'none'})) : sleep(40).then(() => ({label: /dog/.test(line) ? 'happy' : 'none'}))});
    h.talk.open(); await untilListening(h);
    youSay(h, 'I got a dog');
    reply(h, 'r1', 'A dog, how lovely!');
    await untilListening(h);
    const wait = h.logs.find(e => e.kind === 'line_wait');
    assert.equal(wait.by, 'reaction'); assert.equal(wait.label, null); assert.equal(wait.used, null);
    assert.ok(wait.released - wait.reached < 30, JSON.stringify(wait));
    assert.equal(h.said[1], 'A dog, how lovely!');
    await until(() => h.logs.some(e => e.kind === 'label_late'));
    assert.equal(h.logs.find(e => e.kind === 'label_late').label, 'happy');
    assert.equal(h.logs.find(e => e.kind === 'jibo').expressions[0], 'late');
    h.talk.close();
});

test('first line: after a reaction that already played, the line does not wait for its label', async () => {
    const db = fakeAnimDB({}, 300);
    let replied = null;
    const h = harness({speakMs: 20, config: {expressionWaitMs: 500}, animDB: db.animDB, expression: db.expression,
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'surprised', confidence: 0.9}) : sleep(250).then(() => ({label: 'none'}))});
    h.talk.open(); await untilListening(h);
    youSay(h, 'Guess what happened!');
    await until(() => h.logs.some(e => e.kind === 'anim' || (e.kind === 'speak' && e.turn === 1)) || db.played.length > 1);
    reply(h, 'r1', 'Oh, tell me!');
    await untilListening(h);
    const wait = h.logs.find(e => e.kind === 'line_wait');
    assert.equal(h.logs.find(e => e.kind === 'jibo').reaction.played, 'before');
    assert.equal(wait.by, 'reaction'); assert.ok(wait.released - wait.reached < 100, JSON.stringify(wait));
    h.talk.close();
});

test('lead: the words never wait for an eye animation (D99); for one that moves the body only until it is handed over', async () => {
    const make = body => ({getAnimByName: () => ({meta: {endsNeutral: true, layers: {Eye: true, Body: body}}, createFromConfig: () => Promise.resolve({instance: {events: {}},
        play: () => sleep(150).then(() => 'STOPPED'), stop: () => Promise.resolve()})})});
    const expression = fakeAnimDB().expression;
    const eye = await listening({config: {greetingExpression: 'hello', expressionLeadMs: 40}, animDB: make(false), expression});
    const e1 = eye.logs.find(e => e.kind === 'speak');
    assert.equal(e1.lead, 'none'); assert.ok(e1.lead_ms < 30, JSON.stringify(e1));
    eye.talk.close();
    const body = await listening({config: {greetingExpression: 'hello', expressionLeadMs: 40}, animDB: make(true), expression});
    const b1 = body.logs.find(e => e.kind === 'speak');
    assert.equal(b1.lead, 'body'); assert.ok(b1.lead_ms < 30, 'spoken once handed over, not after it started');
    await until(() => body.logs.some(e => e.kind === 'anim'));
    assert.equal(body.logs.find(e => e.kind === 'anim').body, true);
    body.talk.close();
    assert.equal(DEFAULTS.expressionLeadMs, 100);
});

test('lead: a clip that moves the body is handed to the body before the words, so speech cannot take it first', async () => {
    const order = [];
    const animDB = {getAnimByName: () => ({meta: {endsNeutral: true, layers: {Body: true}}, createFromConfig: () => sleep(30).then(() => ({instance: {events: {}},
        play: () => { order.push('play'); return sleep(200).then(() => 'STOPPED'); }, stop: () => Promise.resolve()}))})};
    const h = harness({config: {greetingExpression: 'hello', expressionLeadMs: 100}, animDB, expression: fakeAnimDB().expression,
        speech: {speak: (esml, opts) => { order.push('speak'); h.said.push(esml); return sleep(20); }}});
    h.talk.open(); await untilListening(h);
    assert.deepEqual(order.slice(0, 2), ['play', 'speak']);
    const speak = h.logs.find(e => e.kind === 'speak');
    assert.equal(speak.lead, 'body'); assert.ok(speak.lead_ms >= 25 && speak.lead_ms < 100, JSON.stringify(speak));
    h.talk.close();
});

test('first line: after a reaction that played longer ago than the expression gap, the line still does not wait for its label (D104)', async () => {
    const db = fakeAnimDB({}, 20);
    const h = harness({speakMs: 20, config: {expressionWaitMs: 500, expressionGapMs: 30}, animDB: db.animDB, expression: db.expression,
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'surprised', confidence: 0.9}) : sleep(60).then(() => ({label: 'happy'}))});
    h.talk.open(); await untilListening(h);
    youSay(h, 'Guess what happened!');
    await sleep(80);
    reply(h, 'r1', 'Oh, tell me!');
    await untilListening(h);
    assert.equal(h.logs.find(e => e.kind === 'jibo').reaction.played, 'before');
    const wait = h.logs.find(e => e.kind === 'line_wait');
    assert.equal(wait.by, 'reaction'); assert.equal(wait.used, null); assert.ok(wait.released - wait.reached < 30, JSON.stringify(wait));
    assert.equal(h.logs.find(e => e.kind === 'jibo').expressions[0], null, 'not "late": the reaction stood in for it');
    h.talk.close();
});

test('first line: a label that comes after the reaction decided the line goes to the second line', async () => {
    const h = harness({config: {expressionWaitMs: 500, expressionGapMs: 0}, classify: (person, line, kind) => kind === 'reaction'
        ? sleep(5).then(() => ({label: 'thinking', confidence: 0.6})) : sleep(/penguin/.test(line) ? 30 : 5).then(() => ({label: /penguin/.test(line) ? 'happy' : 'none'}))});
    h.talk.open(); await untilListening(h);
    youSay(h, 'Favourite bird?');
    h.emit({type: 'response.created', response: {id: 'r1'}});
    h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: 'Yes, the penguin. '});
    await sleep(60);
    h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: 'It is black and white.'});
    h.emit({type: 'response.done', response: {id: 'r1', status: 'completed', usage: {}}});
    await untilListening(h);
    const jibo = h.logs.find(e => e.kind === 'jibo');
    assert.equal(h.logs.find(e => e.kind === 'line_wait').by, 'reaction');
    assert.equal(jibo.expressions[0], null, 'not "late": the reaction decided it');
    assert.equal(h.logs.filter(e => e.kind === 'line_wait')[1].used, 'happy', 'the late label went to line 2');
    h.talk.close();
});

test('a keyword emoji never holds the words: no animation next to the line, no lead, first line or later (D98)', async () => {
    const db = fakeAnimDB({}, 30);
    for (const text of ['Good question. How about a pizza tonight?', 'Pizza sounds great. Enjoy it.']) {
        const h = harness({animDB: db.animDB, expression: db.expression, config: {emoji: true, expressionLeadMs: 80},
            classify: () => Promise.resolve({label: 'none'})});
        h.talk.open(); await untilListening(h);
        youSay(h, 'What should I eat?');
        reply(h, 'r1', text);
        await untilListening(h);
        const speak = h.logs.find(e => e.kind === 'speak' && e.emoji === 'pizza');
        assert.equal(speak.lead, undefined, text); assert.ok(h.said.some(t => /nonBlocking='true'\/>[Pp]izza/.test(t)), text);
        h.talk.close();
    }
    assert.equal(db.played.length, 0);
});

test('first line: a reaction that comes while the line waits plays first, and the words follow at once (D104)', async () => {
    const db = fakeAnimDB({}, 30, {surprised_02: {Eye: true}});
    const h = harness({speakMs: 20, config: {expressionWaitMs: 300}, animDB: db.animDB, expression: db.expression,
        classify: (person, line, kind) => kind === 'reaction' ? sleep(60).then(() => ({label: 'surprised', confidence: 0.9})) : sleep(400).then(() => ({label: 'none'}))});
    h.talk.choose = label => label === 'surprised' ? 'surprised_02' : null;
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won the lottery!');
    reply(h, 'r1', 'No way!');
    await untilListening(h);
    const wait = h.logs.find(e => e.kind === 'line_wait' && e.turn === 1);
    assert.equal(wait.by, 'reaction'); assert.equal(wait.used, 'surprised'); assert.equal(wait.label, null, 'its own label was not waited for');
    assert.ok(wait.released - wait.reached >= 30 && wait.released - wait.reached < 250, JSON.stringify(wait));
    assert.equal(h.logs.find(e => e.kind === 'jibo').reaction.played, 'with first line');
    await until(() => h.logs.some(e => e.kind === 'anim' && e.turn === 1));
    const anim = h.logs.find(e => e.kind === 'anim' && e.turn === 1), speak = h.logs.find(e => e.kind === 'speak' && e.turn === 1);
    assert.equal(anim.name, 'surprised_02'); assert.ok(anim.asked <= speak.at, 'the clip is asked before the words');
    assert.equal(speak.lead, 'none', 'an eye clip does not hold the words');
    h.talk.close();
});

test('first line: a reaction slower than the expression wait does not hold the words; it is not played late (D104)', async () => {
    const h = harness({config: {expressionWaitMs: 80}, classify: (person, line, kind) => kind === 'reaction'
        ? sleep(300).then(() => ({label: 'surprised', confidence: 0.9})) : Promise.resolve({label: 'none'})});
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won the lottery!');
    reply(h, 'r1', 'No way!');
    await untilListening(h); await sleep(320);
    const wait = h.logs.find(e => e.kind === 'line_wait' && e.turn === 1);
    assert.equal(wait.by, 'timeout'); assert.ok(wait.released - wait.reached >= 70 && wait.released - wait.reached < 200, JSON.stringify(wait));
    assert.equal(h.said[1], 'No way!');
    assert.ok(!h.said.some(t => /surprised/.test(t)));
    h.talk.close();
});

test('first line: with the quick reaction off it does not wait for its label (D104)', async () => {
    const h = await listening({config: {reaction: false, expressionWaitMs: 300}, classify: () => sleep(200).then(() => ({label: 'happy'}))});
    youSay(h, 'Hello');
    reply(h, 'r1', 'Hello there.');
    await untilListening(h);
    const wait = h.logs.find(e => e.kind === 'line_wait' && e.turn === 1);
    assert.equal(wait.by, 'no_wait'); assert.ok(wait.released - wait.reached < 30, JSON.stringify(wait));
    assert.equal(wait.reaction, undefined);
    h.talk.close();
});

test('expression wait: the first line waits at most 300 ms for the quick reaction by default (D104)', () => {
    assert.equal(DEFAULTS.expressionWaitMs, 300);
});

test('late first-line expression (D99): the words go at once; an eye expression that comes later plays once the eye is free, on that line', async () => {
    const db = fakeAnimDB({}, 30, {eye_happy_01: {Eye: true}}), eye = fakeEye();
    let answer;
    const h = harness({speakMs: 400, animDB: db.animDB, expression: db.expression, config: {expressionWaitMs: 0},
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'none'}) : /fun/.test(line) ? new Promise(r => { answer = r; }) : Promise.resolve({label: 'none'})});
    h.jibo.face.eye = eye;
    h.talk.choose = label => label === 'happy' ? 'eye_happy_01' : null;
    h.talk.open(); await untilListening(h);
    assert.equal(eye.count(), 2, 'watching the eye');
    youSay(h, 'Let us play');
    reply(h, 'r1', 'That sounds fun! You start.');
    await until(() => h.said.includes('That sounds fun!'));
    const wait = h.logs.find(e => e.kind === 'line_wait' && e.turn === 1);
    assert.equal(wait.by, 'reaction'); assert.equal(wait.used, null);
    eye.emit('addAnimation');          // speech's blink on the first word
    answer({label: 'happy'});
    await sleep(60);
    assert.equal(db.played.length, 0, 'not while the blink holds the eye');
    eye.emit('removeAnimation');
    await until(() => h.logs.some(e => e.kind === 'anim' && e.via === 'late'));
    const late = h.logs.find(e => e.kind === 'anim' && e.via === 'late');
    assert.equal(late.name, 'eye_happy_01'); assert.equal(late.line, 0); assert.equal(late.eye.how, 'free'); assert.ok(late.eye.ms >= 50, JSON.stringify(late));
    await untilListening(h);
    assert.equal(h.logs.find(e => e.kind === 'jibo').expressions[0], 'happy (late)');
    assert.equal(h.logs.filter(e => e.kind === 'line_wait')[1].used, null, 'not again on line 2');
    h.talk.close();
    assert.equal(eye.count(), 0, 'the eye listeners are removed on close');
});

test('late first-line expression (D99): a line that ends while the eye is busy drops it, and it is not counted', async () => {
    const db = fakeAnimDB({}, 30, {eye_happy_01: {Eye: true}}), eye = fakeEye();
    let answer;
    const h = harness({speakMs: 60, animDB: db.animDB, expression: db.expression, config: {expressionWaitMs: 0},
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'none'}) : /fun/.test(line) ? new Promise(r => { answer = r; }) : Promise.resolve({label: 'none'})});
    h.jibo.face.eye = eye;
    h.talk.choose = label => label === 'happy' ? 'eye_happy_01' : null;
    h.talk.open(); await untilListening(h);
    youSay(h, 'Let us play');
    reply(h, 'r1', 'That sounds fun!');
    await until(() => h.said.includes('That sounds fun!'));
    eye.emit('addAnimation');
    answer({label: 'happy'});
    await untilListening(h);
    eye.emit('removeAnimation');
    await until(() => h.logs.some(e => e.kind === 'late_dropped'));
    assert.equal(h.logs.find(e => e.kind === 'late_dropped').eye.how, 'free');
    assert.equal(h.logs.find(e => e.kind === 'jibo').expressions[0], 'late');
    assert.ok(h.talk.policy.allow('happy', h.talk.now(), ''), 'the expression gap did not start');
    assert.equal(db.played.length, 0);
    h.talk.close();
});

test('late first-line expression (D99): the eye wait ends after 1 s at most; a body move or a line already over goes to the next line', async () => {
    const watch = ExpressionPlayer.watchEye(fakeEye());
    assert.equal(await watch.free(10), 'free');
    assert.equal(await ExpressionPlayer.watchEye(null).free(10), 'unknown');
    const eye = fakeEye(), w2 = ExpressionPlayer.watchEye(eye);
    eye.emit('addAnimation');
    const t = Date.now(); assert.equal(await w2.free(40), 'timeout'); assert.ok(Date.now() - t >= 35);
    const pending = w2.free(1000); w2.stop(); assert.equal(await pending, 'stopped');
    // A body move that comes late and is refused until the line is over: dropped, and offered to line 2 (D102).
    const db = fakeAnimDB({excited_01: 'REJECTED'}, 30);
    let answer;
    const h = harness({speakMs: 100, animDB: db.animDB, expression: db.expression, config: {expressionWaitMs: 0},
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'none'}) : /Wow/.test(line) ? new Promise(r => { answer = r; }) : Promise.resolve({label: 'none'})});
    h.jibo.face.eye = fakeEye();
    h.talk.choose = label => label === 'surprised' ? 'excited_01' : null;
    h.talk.player.moves = name => name === 'excited_01';
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won');
    reply(h, 'r1', 'Wow! That is great news.');
    await until(() => h.said.includes('Wow!'));
    answer({label: 'surprised'});
    await untilListening(h);
    assert.equal(h.logs.filter(e => e.kind === 'line_wait')[1].used, 'surprised', 'went to line 2');
    assert.ok(h.logs.some(e => e.kind === 'late_dropped' && e.line === 0 && e.name === 'excited_01'), 'dropped on line 1');
    h.talk.close();
});

// A late body clip (D102): speech's opening pose refuses it, so it is asked again until the parts are free.
test('late first-line body clip (D102): refused while speech holds the body, asked again every 150 ms, played on that line', async () => {
    const db = fakeAnimDB({excited_01: {reject: 2}}, 30);
    let answer;
    const h = harness({speakMs: 900, animDB: db.animDB, expression: db.expression, config: {expressionWaitMs: 0},
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'none'}) : /Wow/.test(line) ? new Promise(r => { answer = r; }) : Promise.resolve({label: 'none'})});
    h.jibo.face.eye = fakeEye();
    h.talk.choose = label => label === 'surprised' ? 'excited_01' : null;
    h.talk.player.moves = name => name === 'excited_01';
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won');
    reply(h, 'r1', 'Wow!');
    await until(() => h.said.includes('Wow!'));
    answer({label: 'surprised'});
    await until(() => h.logs.filter(e => e.kind === 'anim' && e.name === 'excited_01').length === 3);
    const anims = h.logs.filter(e => e.kind === 'anim' && e.name === 'excited_01');
    assert.deepEqual(anims.map(e => e.result), ['REJECTED', 'REJECTED', 'STOPPED']);
    assert.deepEqual(anims.map(e => e.tries), [undefined, 2, 3]);
    assert.ok(anims[1].asked - anims[0].end >= 140, 'a pause between tries');
    assert.ok(anims.every(e => e.via === 'late' && e.line === 0));
    await untilListening(h);
    assert.equal(h.logs.find(e => e.kind === 'jibo').expressions[0], 'surprised (late)');
    assert.ok(!h.logs.some(e => e.kind === 'late_dropped'));
    h.talk.close();
});

test('late first-line body clip (D102): it stops asking when another clip took over', async () => {
    const db = fakeAnimDB({excited_01: 'REJECTED'}, 400);
    const h = await listening({speakMs: 1500, animDB: db.animDB, expression: db.expression, config: {expressionWaitMs: 0, silenceSeconds: 60}, classify: () => Promise.resolve({label: 'none'})});
    h.talk.player.moves = () => true;
    // Another clip starts while the first try waits to be asked again.
    setTimeout(() => h.talk.player.play('happy_01', {via: 'test'}), 60);
    const result = await h.talk.playBesideLine('excited_01', {via: 'line', turn: 1, line: 1}, () => true);
    assert.equal(result.played, false); assert.equal(result.result, 'REJECTED');
    assert.equal(db.played.filter(p => p.name === 'excited_01').length, 1, 'asked once, then another clip was playing');
    h.talk.close();
});

test('late clips (D102): at most 8 tries, and none once the line is over', async () => {
    const db = fakeAnimDB({excited_01: 'REJECTED'}, 30);
    const h = await listening({animDB: db.animDB, expression: db.expression, config: {silenceSeconds: 60}, classify: () => Promise.resolve({label: 'none'})});
    const all = await h.talk.playBesideLine('excited_01', {via: 'line', turn: 1, line: 1}, () => true);
    assert.deepEqual([all.played, all.tries], [false, 8]);
    assert.equal(db.played.filter(p => p.name === 'excited_01').length, 8);
    let live = true;
    const over = h.talk.playBesideLine('excited_01', {via: 'line', turn: 1, line: 1}, () => live);
    await sleep(30); live = false;
    const result = await over;
    assert.equal(result.played, false); assert.ok(result.tries >= 1 && result.tries < 8, JSON.stringify(result));
    h.talk.close();
});

test('line 2 clip (D102): the words never wait for it, it is asked once they are on their way and again while refused', async () => {
    const db = fakeAnimDB({excited_01: {reject: 2}}, 30);
    const h = harness({speakMs: 700, animDB: db.animDB, expression: db.expression, config: {expressionWaitMs: 0, expressionLeadMs: 500},
        classify: (person, line, kind) => kind === 'reaction' || !/great/.test(line) ? Promise.resolve({label: 'none'}) : Promise.resolve({label: 'surprised'})});
    h.talk.choose = label => label === 'surprised' ? 'excited_01' : null;
    h.talk.player.moves = () => true;
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won');
    reply(h, 'r1', 'Nice. That is great news.');
    await until(() => h.said.includes('That is great news.'));
    const speak = h.logs.find(e => e.kind === 'speak' && e.line === 1);
    assert.equal(speak.lead, 'beside'); assert.ok(speak.lead_ms < 100, 'no wait for a body clip: ' + speak.lead_ms);
    assert.equal(speak.play, 'excited_01');
    await until(() => h.logs.filter(e => e.kind === 'anim' && e.name === 'excited_01').length === 3);
    const anims = h.logs.filter(e => e.kind === 'anim' && e.name === 'excited_01');
    assert.deepEqual(anims.map(e => e.result), ['REJECTED', 'REJECTED', 'STOPPED']);
    assert.ok(anims.every(e => e.via === 'line' && e.line === 1));
    assert.ok(anims[0].asked >= speak.at - 5, 'asked with the words, not before');
    await untilListening(h);
    assert.ok(!h.logs.some(e => e.kind === 'late_dropped'));
    h.talk.close();
});

test('line 2 clip (D102): a clip that is refused until the line is over is dropped and logged; the first line keeps its lead', async () => {
    const db = fakeAnimDB({excited_01: 'REJECTED'}, 30);
    const h = harness({speakMs: 150, animDB: db.animDB, expression: db.expression, config: {expressionWaitMs: 0, expressionLeadMs: 80},
        classify: (person, line, kind) => kind === 'reaction' || !/great/.test(line) ? Promise.resolve({label: 'none'}) : Promise.resolve({label: 'surprised'})});
    h.talk.choose = label => label === 'surprised' ? 'excited_01' : null;
    h.talk.player.moves = () => true;
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won');
    reply(h, 'r1', 'Nice. That is great news.');
    await untilListening(h);
    await sleep(200);
    const speaks = h.logs.filter(e => e.kind === 'speak' && e.turn === 1);
    assert.notEqual(speaks[0].lead, 'beside', 'line 1 still goes before its words');
    assert.equal(speaks[1].lead, 'beside');
    const dropped = h.logs.find(e => e.kind === 'late_dropped' && e.line === 1);
    assert.ok(dropped && dropped.name === 'excited_01' && dropped.tries >= 1 && dropped.result === 'REJECTED', JSON.stringify(dropped));
    assert.equal(h.logs.filter(e => e.kind === 'anim' && e.name === 'excited_01').length, dropped.tries, 'one log entry per try, none after');
    h.talk.close();
});

test('clips beside a line (D102): closing during the pause before a try ends the asking', async () => {
    const db = fakeAnimDB({excited_01: 'REJECTED'}, 30);
    const h = bodyHarness(db, {harness: {speakMs: 1500}, classify: line => Promise.resolve({label: /great/.test(line) ? 'surprised' : 'none'})});
    await sayTwoLines(h, 'Nice. That is great news.');
    await until(() => h.logs.some(e => e.kind === 'anim' && e.name === 'excited_01'));
    h.talk.close();
    const before = db.played.length;
    await sleep(500);
    assert.equal(db.played.length, before, 'no try after close');
    assert.ok(!h.logs.some(e => e.kind === 'anim' && e.name === 'excited_01' && e.tries > 1));
});

test('late first-line body clip (D102): one that played is not played again on line 2', async () => {
    const db = fakeAnimDB({}, 30);
    let answer;
    const h = bodyHarness(db, {harness: {speakMs: 300}, classify: line => /^Wow/.test(line) ? new Promise(r => { answer = r; }) : Promise.resolve({label: 'none'})});
    await sayTwoLines(h, 'Wow! That is great news.');
    await until(() => h.said.includes('Wow!'));
    answer({label: 'surprised'});
    await untilListening(h);
    assert.equal(db.played.filter(p => p.name === 'excited_01').length, 1, 'once');
    assert.equal(h.logs.filter(e => e.kind === 'line_wait')[1].used, null, 'not offered to line 2');
    h.talk.close();
});

test('late first-line body clip (D102): a try still in flight when the line ends is not carried to line 2 as well', async () => {
    const db = fakeAnimDB({excited_01: 'NOSTART'}, 400);
    let answer;
    const h = bodyHarness(db, {harness: {speakMs: 100}, classify: line => /^Wow/.test(line) ? new Promise(r => { answer = r; }) : Promise.resolve({label: 'none'})});
    await sayTwoLines(h, 'Wow! That is great news.');
    await until(() => h.said.includes('Wow!'));
    answer({label: 'surprised'});
    await untilListening(h);
    await sleep(500);
    assert.equal(db.played.filter(p => p.name === 'excited_01').length, 1, 'not played a second time');
    assert.equal(h.logs.filter(e => e.kind === 'line_wait')[1].used, null);
    h.talk.close();
});

test('late first-line clip (D102): it does not replace a clip that is playing; a body clip goes to line 2 instead', async () => {
    const db = fakeAnimDB({}, 400);
    let answer;
    const h = bodyHarness(db, {harness: {speakMs: 150}, classify: line => /^Wow/.test(line) ? new Promise(r => { answer = r; }) : Promise.resolve({label: 'none'})});
    await sayTwoLines(h, 'Wow! That is great news.');
    await until(() => h.said.includes('Wow!'));
    h.talk.player.play('happy_01', {via: 'test'});
    answer({label: 'surprised'});
    await untilListening(h);
    assert.equal(h.logs.filter(e => e.kind === 'line_wait')[1].used, 'surprised', 'offered to line 2');
    assert.ok(!h.logs.some(e => e.kind === 'anim' && e.via === 'late'), 'nothing played over the other clip');
    h.talk.close();
});

test('clips beside a line (D102): a line whose speak call fails stops asking', async () => {
    const db = fakeAnimDB({excited_01: 'REJECTED'}, 30);
    let calls = 0;
    const h = bodyHarness(db, {harness: {speech: {speak: (esml) => { h.said.push(esml); return ++calls === 3 ? sleep(10).then(() => { throw Error('speech failed'); }) : sleep(40); }}},   // 1 greeting, 2 line 1, 3 line 2
        classify: line => Promise.resolve({label: /great/.test(line) ? 'surprised' : 'none'})});
    await sayTwoLines(h, 'Nice. That is great news.');
    await until(() => calls >= 3);
    await sleep(60);
    const tries = db.played.filter(p => p.name === 'excited_01').length;
    assert.ok(tries >= 1, 'line 2 asked for its clip');
    await sleep(500);
    assert.equal(db.played.filter(p => p.name === 'excited_01').length, tries, 'no try after the failure');
    assert.ok(tries < 8);
    h.talk.close();
});

test('timing log (D89): warm and label connections, and where the server placed speech in the sent audio', async () => {
    const conn = {socket: 3, reused: true, idle_ms: 900, socket_ms: 1, ttfb_ms: 140};
    const classify = () => Promise.resolve({label: 'none', ms: 5, conn});
    classify.warm = () => Promise.resolve({ms: 1200, status: 200, conn: {socket: 3, reused: false, dns_ms: 30, tcp_ms: 90, tls_ms: 120, ttfb_ms: 1100}});
    const h = await listening({classify, config: {silenceSeconds: 5}});
    await sleep(5);
    const warm = h.logs.find(e => e.kind === 'classifier_warm');
    assert.equal(warm.why, 'start'); assert.equal(warm.conn.tls_ms, 120);
    assert.equal(h.logs.find(e => e.kind === 'listen').sent_ms, 0);
    h.audio(); h.audio(); h.audio();
    h.emit({type: 'input_audio_buffer.speech_started', audio_start_ms: 100});
    h.emit({type: 'input_audio_buffer.speech_stopped', audio_end_ms: 200});
    const stopped = h.logs.find(e => e.kind === 'rt' && e.type === 'input_audio_buffer.speech_stopped');
    assert.equal(stopped.audio_ms, 200); assert.equal(stopped.sent_ms, 256);
    assert.ok(stopped.behind_ms >= 0 && stopped.behind_ms < 100, JSON.stringify(stopped));
    h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hello'});
    reply(h, 'r1', 'Hello there.');
    await untilListening(h);
    assert.deepEqual(h.logs.find(e => e.kind === 'line_wait').conn, conn);
    assert.deepEqual(h.logs.find(e => e.kind === 'jibo').reaction.conn, conn);
    h.talk.close();
});

test('timing log (D89): a closed kept connection is logged while the conversation runs; nothing measured with the log off', async () => {
    let watcher = null, unwatched = 0;
    const classify = () => Promise.resolve({label: 'none'});
    classify.watch = fn => { watcher = fn; return () => { unwatched++; }; };
    const h = await listening({classify});
    watcher({socket: 2, uses: 4, age_ms: 70000, idle_ms: 60000});
    const closed = h.logs.find(e => e.kind === 'conn_closed');
    assert.equal(closed.socket, 2); assert.equal(closed.idle_ms, 60000);
    h.talk.close();
    assert.equal(unwatched, 1);
    const off = harness({classify});
    off.talk.log.enabled = false;
    off.talk.open(); await untilListening(off);
    assert.equal(off.talk.clock, null);
    off.talk.close();
});

test('going on after a pause while Jibo thinks: the queued answer is dropped and the whole thought is answered (D89)', async () => {
    let answer = null;
    const classify = (person, line, kind) => kind === 'reaction' ? new Promise(resolve => { answer = answer || resolve; }) : Promise.resolve({label: 'none'});
    const h = await listening({classify, config: {expressionWaitMs: 300}});
    h.emit({type: 'input_audio_buffer.speech_started'});
    youSay(h, 'I went to the shop');
    reply(h, 'r1', 'Nice, what did you buy?');
    await sleep(20);
    assert.equal(h.talk.state, 'thinking'); assert.equal(h.said.length, 1, 'the line waits for the reaction');
    const before = h.appends();
    h.audio();
    assert.equal(h.appends(), before + 1, 'the person is still heard');
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.ok(h.logs.some(e => e.kind === 'continued' && e.turn === 1));
    assert.equal(h.talk.state, 'listening');
    await sleep(350);
    assert.equal(h.said.length, 1, 'the dropped answer is never spoken');
    youSay(h, 'and then I bought bread');
    reply(h, 'r2', 'Bread sounds good.');
    if (answer) answer({label: 'none'});
    await untilListening(h);
    assert.deepEqual(h.said.slice(1), ['Bread sounds good.']);
    h.talk.close();
});

test('hear me while Jibo thinks: off closes the microphone at the end of the turn, as before (D89)', async () => {
    const h = await listening({config: {listenWhileThinking: false}});
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    const before = h.appends();
    h.audio();
    assert.equal(h.appends(), before, 'nothing sent while thinking');
    h.talk.close();
});

test('a reaction that may move the body closes the microphone until it is done (D89)', async () => {
    const classify = (person, line, kind) => Promise.resolve({label: kind === 'reaction' ? 'happy' : 'none'});
    const db = fakeAnimDB({}, 80);
    const h = await listening({classify, animDB: db.animDB, expression: db.expression, config: {silenceSeconds: 5, transcriptWaitMs: 400}});
    h.emit({type: 'input_audio_buffer.speech_started'});
    youSay(h, 'I won the game');
    await sleep(20);
    assert.ok(db.played.some(p => p.name === 'excited_01'), 'the reaction plays');
    const before = h.appends();
    h.audio();
    assert.equal(h.appends(), before, 'closed while the reaction plays');
    await sleep(100);
    h.audio();
    assert.equal(h.appends(), before + 1, 'open again once it is done');
    assert.ok(h.logs.some(e => e.kind === 'mic_reopened' && e.turn === 1));
    h.talk.close();
});

test('a reply the server cancelled because the person went on is never spoken (D89)', async () => {
    const h = await listening();
    youSay(h, 'So anyway');
    h.emit({type: 'response.created', response: {id: 'r1'}});
    h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: 'Half a'});
    h.emit({type: 'response.done', response: {id: 'r1', status: 'cancelled'}});
    await sleep(150);
    assert.equal(h.said.length, 1);
    assert.equal(h.talk.state, 'listening');
    assert.ok(h.logs.some(e => e.kind === 'continued'));
    h.talk.close();
});

test('going on: words that come after the turn was dropped are carried to the next turn, never given to it as its own (D90)', async () => {
    const asked = [];
    const classify = (person, line, kind) => { asked.push([kind, person]); return Promise.resolve({label: 'none'}); };
    const h = await listening({classify, config: {silenceSeconds: 5}});
    heardTurn(h, 'i1');
    h.emit({type: 'input_audio_buffer.speech_started'});           // goes on before the first words are known
    assert.equal(h.talk.state, 'listening');
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'input_audio_buffer.committed', item_id: 'i2'});
    words(h, 'i1', 'I went to the shop');                         // late: the dropped turn's words
    assert.equal(h.talk.turn.transcript, undefined, 'not taken as the new turn\'s words');
    words(h, 'i2', 'and bought bread');
    assert.equal(h.talk.turn.transcript, 'I went to the shop and bought bread');
    const you = h.logs.filter(e => e.kind === 'you');
    assert.deepEqual(you.map(e => [e.turn, e.text, !!e.carried, !!e.before]), [[1, 'I went to the shop', true, false], [2, 'and bought bread', false, true]]);
    await sleep(5);
    assert.deepEqual(asked.find(a => a[0] === 'reaction'), ['reaction', 'I went to the shop and bought bread']);
    reply(h, 'r2', 'Fresh bread, nice.');
    await untilListening(h);
    assert.deepEqual(h.said.slice(1), ['Fresh bread, nice.']);
    h.talk.close();
});

test('going on with only noise: the carried words keep the turn, and its reply is spoken (D90)', async () => {
    const h = await listening({config: {silenceSeconds: 5}});
    heardTurn(h, 'i1');
    words(h, 'i1', 'Tell me a joke');
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'input_audio_buffer.committed', item_id: 'i2'});
    words(h, 'i2', '');
    assert.ok(!h.logs.some(e => e.kind === 'skipped'), 'not skipped as an empty turn');
    reply(h, 'r2', 'Why did the robot cross the road?');
    await untilListening(h);
    assert.deepEqual(h.said.slice(1), ['Why did the robot cross the road?']);
    assert.equal(h.logs.find(e => e.kind === 'jibo').turn, 2);
    h.talk.close();
});

test('going on, then goodbye: the carried words in front do not hide the goodbye', async () => {
    const h = harness({config: {silenceSeconds: 5}});
    const ended = h.talk.open(); await untilListening(h);
    heardTurn(h, 'i1');
    words(h, 'i1', 'That topic is not for me');
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'input_audio_buffer.committed', item_id: 'i2'});
    words(h, 'i2', 'Goodbye.');
    assert.equal(h.talk.turn.transcript, 'That topic is not for me Goodbye.');
    reply(h, 'r2', 'Goodbye! Talk soon.');
    assert.equal(await ended, 'goodbye');
    assert.deepEqual(h.said.slice(1), ['Goodbye!', 'Talk soon.']);
});

test('going on after a goodbye: the person is not done, so the session stays open', async () => {
    const h = await listening({config: {silenceSeconds: 5}});
    heardTurn(h, 'i1');
    words(h, 'i1', 'Goodbye.');
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'input_audio_buffer.committed', item_id: 'i2'});
    words(h, 'i2', 'Oh wait, one more thing');
    reply(h, 'r2', 'Sure, what is it?');
    await untilListening(h);
    assert.ok(!h.logs.some(e => e.kind === 'session_end'));
    h.talk.close();
});

test('going on: the dropped reply is deleted from the conversation, complete or still coming (D90)', async () => {
    let answer = null;
    const classify = (person, line, kind) => kind === 'reaction' ? new Promise(resolve => { answer = answer || resolve; }) : Promise.resolve({label: 'none'});
    const h = await listening({classify, config: {expressionWaitMs: 300, silenceSeconds: 5}});
    heardTurn(h, 'i1'); words(h, 'i1', 'I went to the shop');
    h.emit({type: 'response.created', response: {id: 'r1'}});
    h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: 'Nice, what did you buy? '});
    h.emit({type: 'response.done', response: {id: 'r1', status: 'completed', output: [{id: 'm1', type: 'message'}]}});
    await sleep(10);
    h.emit({type: 'input_audio_buffer.speech_started'});       // the complete reply waited for the reaction
    const deleted = () => h.sent.filter(e => e.type === 'conversation.item.delete').map(e => e.item_id);
    assert.deepEqual(deleted(), ['m1']);
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'input_audio_buffer.committed', item_id: 'i2'});
    h.emit({type: 'response.created', response: {id: 'r2'}});
    h.emit({type: 'input_audio_buffer.speech_started'});       // goes on again while r2 is still coming
    assert.ok(h.sent.some(e => e.type === 'response.cancel'));
    h.emit({type: 'response.done', response: {id: 'r2', status: 'cancelled', output: [{id: 'm2', type: 'message'}, {id: 'f2', type: 'function_call', name: 'set_volume'}]}});
    assert.deepEqual(deleted(), ['m1', 'm2', 'f2']);
    if (answer) answer({label: 'none'});
    assert.equal(h.said.length, 1, 'nothing of either reply was said');
    h.talk.close();
});

test('a reply the server cancels after Jibo began speaking: no more of it is said and its tools do not run (D90)', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts, speakMs: 60});
    heardTurn(h, 'i1'); words(h, 'i1', 'Make it quieter');
    h.emit({type: 'response.created', response: {id: 'r1'}});
    h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: 'Sure thing. '});
    await until(() => h.talk.state === 'speaking');
    h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: 'Turning it down to'});
    h.emit({type: 'response.done', response: {id: 'r1', status: 'cancelled', output: [{id: 'f1', type: 'function_call', name: 'set_volume', call_id: 'c1', arguments: '{"lev'}]}});
    await untilListening(h);
    assert.deepEqual(h.said.slice(1), ['Sure thing.']);
    assert.equal(acts.volume, undefined, 'the cut tool call did not run');
    assert.ok(h.logs.some(e => e.kind === 'cut' && e.turn === 1));
    assert.equal(h.logs.find(e => e.kind === 'jibo').text, 'Sure thing.', 'the log and the pairs keep only what was said');
    h.talk.close();
});

test('the microphone hold is the conversation\'s: going on during a body reaction keeps it closed, and the ring orange, until the clip ends (D90, D91)', async () => {
    const db = fakeAnimDB({}, 150, {excited_01: {Body: true}});
    const classify = (person, line, kind) => Promise.resolve({label: kind === 'reaction' ? 'happy' : 'none'});
    const h = await listening({classify, config: {silenceSeconds: 5, transcriptWaitMs: 1000}, animDB: db.animDB, expression: db.expression});
    heardTurn(h, 'i1'); words(h, 'i1', 'I won the game');
    await until(() => db.played.some(p => p.name === 'excited_01'));
    const before = h.appends();
    h.audio();
    assert.equal(h.appends(), before, 'closed while the reaction moves the body');
    h.emit({type: 'input_audio_buffer.speech_started'});          // goes on (or the motors were heard)
    assert.equal(h.talk.state, 'listening');
    h.audio();
    assert.equal(h.appends(), before, 'still closed after the carry-on');
    assert.equal(h.leds.at(-1), '1,0.55,0', 'the ring stays orange while the microphone is closed (D91)');
    await until(() => h.logs.some(e => e.kind === 'mic_reopened'));
    h.audio();
    assert.equal(h.appends(), before + 1, 'open once the clip ended');
    assert.equal(h.leds.at(-1), '0,0.45,1', 'blue once it is open');
    assert.equal(h.logs.find(e => e.kind === 'mic_reopened').state, 'listening');
    h.talk.close();
});

test('animdb: a reaction known to leave the body still keeps the microphone open while Jibo thinks (D89)', async () => {
    const db = fakeAnimDB({}, 150, {excited_01: {Body: false}});
    const classify = (person, line, kind) => Promise.resolve({label: kind === 'reaction' ? 'happy' : 'none'});
    const h = await listening({classify, config: {silenceSeconds: 5, transcriptWaitMs: 1000}, animDB: db.animDB, expression: db.expression});
    heardTurn(h, 'i1'); words(h, 'i1', 'I won the game');
    await until(() => db.played.some(p => p.name === 'excited_01'));
    const before = h.appends();
    h.audio();
    assert.equal(h.appends(), before + 1);
    assert.ok(!h.logs.some(e => e.kind === 'mic_reopened'));
    h.talk.close();
});

test('listening starts while a reaction still holds the microphone: orange until it opens, then blue (D91)', async () => {
    const h = await listening({config: {silenceSeconds: 5}});
    h.talk.state = 'thinking';
    let end = null;
    h.talk.holdMic(new Promise(resolve => { end = resolve; }));
    h.talk.listen();
    assert.equal(h.talk.state, 'listening'); assert.equal(h.talk.gate, false);
    assert.equal(h.leds.at(-1), '1,0.55,0');
    end();
    await until(() => h.talk.gate === true);
    assert.equal(h.leds.at(-1), '0,0.45,1');
    h.talk.close();
});

test('a hold that ends while Jibo handles a failure leaves the microphone closed and the ring orange (D92)', async () => {
    let answer = null;
    const h = await listening({config: {silenceSeconds: 5}, diagnose: () => new Promise(resolve => { answer = resolve; })});
    h.talk.state = 'thinking';
    let end = null;
    h.talk.holdMic(new Promise(resolve => { end = resolve; }));
    h.talk.listen();
    try {
        h.talk.fail(Object.assign(Error('connection_lost'), {openai: true}));
        end();
        await sleep(20);
        assert.equal(h.talk.gate, false);
        assert.ok(!h.logs.some(e => e.kind === 'mic_reopened'));
        assert.notEqual(h.leds.at(-1), '0,0.45,1', 'not blue');
    } finally {
        if (answer) answer({cause: 'openai_down'});
        h.talk.close();
    }
});

