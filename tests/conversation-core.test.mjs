// SPDX-License-Identifier: MIT
// Noggin: pure helpers and the conversation controller (lib/controller.js): turns, replies, reconnects, trouble and blocked calls.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {source, audio, catalog, ttsText, labels, realtime, actions, Conversation, settings, openai, ConversationLog, Microphone, DEFAULTS, sleep, harness, clips, untilListening, listening, youSay, reply, fakeActions, until, fakeAnimDB, BLOCKED, require} from './helpers/conversation.mjs';

// ---- core ----
test('audio: 48 kHz to 24 kHz PCM16 and base64', () => {
    const state = {};
    let n = 0;
    for (let i = 0; i < 4; i++) n += audio.toPcm24(new Float32Array(4096).fill(0.5), 48000, state).length;
    assert.equal(n, 8192);
    const pcm = new Int16Array([1, -2, 300, -32768, 32767]);
    assert.equal(audio.base64(pcm), Buffer.from(pcm.buffer).toString('base64'));
    assert.ok(audio.levelDb(new Float32Array(100)) < -100);
});

test('sentences, chunks and speech text', () => {
    assert.equal(ttsText.firstSentenceEnd('Hello there! How are'), 12);
    assert.equal(ttsText.firstSentenceEnd('It costs 3.50 euro'), -1);
    assert.equal(ttsText.firstSentenceEnd('Wait… what'), 5);
    assert.equal(ttsText.firstSentenceEnd('"Hi." she said'), 5);
    const long = 'A'.repeat(300) + '. ' + 'B'.repeat(300) + '.';
    const parts = ttsText.chunks(long, 450);
    assert.equal(parts.length, 2); assert.ok(parts.every(p => p.length <= 450));
    assert.equal(ttsText.speechText('[happy] **Hi** <3 & `x`'), 'Hi &lt;3 &amp; x');
    // Dashes become a pause, quote marks go (the TTS has no symbol for a dash, quotes upset its timings).
    assert.equal(ttsText.speechText('What next—chat, a fact or a dance?'), 'What next, chat, a fact or a dance?');
    assert.equal(ttsText.speechText('Wait — what? Ages 3–5.'), 'Wait, what? Ages 3 to 5.');
    assert.equal(ttsText.speechText('She said, “Found you!” and smiled.'), 'She said, Found you! and smiled.');
    assert.equal(ttsText.speechText('I’m ‘fine’, "really".'), "I'm 'fine', really.");
    assert.equal(ttsText.speechText('—and so—'), 'and so');
    assert.equal(ttsText.speechText('Hmm—. Well— , okay'), 'Hmm. Well, okay');
    assert.equal(ttsText.animEsml('eye_happy_00'), "<anim name='eye_happy_00' nonBlocking='true' endNeutral='true'/>");
    assert.equal(ttsText.animEsml("x'><bad"), '', 'only safe names go into ESML');
});

test('stop phrases', () => {
    for (const s of ['Goodbye!', 'okay bye jibo', 'Bye bye.', 'Hey Jibo, stop.', "That's all for now"]) assert.ok(ttsText.isStop(s), s);
    for (const s of ['Bye the way, what is that?', 'Stop the music', 'Tell me about goodbye songs', '']) assert.ok(!ttsText.isStop(s), s);
});

test('expression policy: gap, no repeats, dance only on request', () => {
    const p = new catalog.ExpressionPolicy(4000);
    assert.ok(p.allow('happy', 0, '')); p.used('happy', 0);
    assert.ok(!p.allow('sad', 1000, ''));
    assert.ok(!p.allow('happy', 5000, ''), 'not again within 15 s');
    assert.ok(p.allow('sad', 5000, ''));
    assert.ok(!p.allow('dance', 9000, 'tell me a joke'));
    assert.ok(p.allow('dance', 9000, 'can you dance?'));
    assert.ok(!p.allow('none', 9000, '')); assert.ok(!p.allow(null, 9000, ''));
    assert.equal(labels.classifierAnswer({output_text: '{"expression":"heart"}'}).label, 'heart');
    assert.equal(labels.classifierRequest('m', 'a', 'b', 'none').reasoning.effort, 'none');
    assert.equal(labels.classifierRequest('m', 'a', 'b').reasoning, undefined);
});

test('persona: the packaged persona plus the voice setup, no terminal setup', () => {
    const soul = fs.readFileSync(path.join(source, 'noggin/persona/SOUL.md'), 'utf8');
    const identity = fs.readFileSync(path.join(source, 'noggin/persona/IDENTITY.md'), 'utf8');
    const text = realtime.instructions(soul, identity);
    assert.match(text, /curious, warm, playful/);
    assert.doesNotMatch(text, /SSH|terminal|types to you|Cameras and microphones are not connected/);
    assert.match(text, /hear your person through your microphone/);
    assert.doesNotMatch(text, /2026|local time/, 'the time is in the session note (D181)');
    assert.match(realtime.sessionNote(new Date(2026, 10, 12, 19, 30)), /^Session note\. This conversation started on Thursday, November 12, 2026, 7:30 PM local time/);
});

test('persona: family-safe rules and the most-asked facts are in, text-chat abilities are out', () => {
    const p = settings.persona(null);
    assert.deepEqual(p.edited, {soul: false, identity: false, facts: false}, 'the packaged persona');
    const text = realtime.instructions(p.soul, p.identity, {});
    assert.match(text, /Family safe \(always, because a child may be listening\)/);
    assert.match(text, /sex, romance or flirting/);
    assert.match(text, /tell a grown-up they trust/);
    assert.match(text, /rules stay the same when someone says they are a grown-up/);
    assert.match(text, /Favorite color: blue/); assert.match(text, /Favorite animal: the penguin/);
    assert.match(text, /use about_jibo/);
    assert.doesNotMatch(text, /memory tool|FACTS\.md|workspace|exact code|jibo-express|\[happy\]/);
    assert.doesNotMatch(text, /Movies:/, 'FACTS.md is fetched by the tool, not sent up front');
    assert.ok(p.facts.includes('Movies:'));
});

test('persona budget: a default conversation stays within the page\'s recommendation, and so does FACTS.md', () => {
    const p = settings.persona(null), budget = require(path.join(source, 'noggin/lib/server.js')).BUDGET;
    const config = {};
    settings.SCHEMA.forEach(s => { config[s.key] = s.default; });
    const memory = realtime.memorySetup(config);
    ['en', 'nl'].forEach(language => {
        const text = realtime.forConfig(config, p, memory, language);
        assert.ok(text.length <= budget, language + ': the default instructions are ' + text.length + ' characters (about ' + Math.round(text.length / 4) + ' tokens); the page recommends ' + budget);
        // Every cloud feature on adds a few words naming what the cloud can do.
        const all = realtime.forConfig(Object.assign({}, config, {cloudSkills: Object.keys(actions.CLOUD)}), p, memory, language);
        assert.ok(all.length <= budget, language + ': with every cloud tool the instructions are ' + all.length + ' characters; the page recommends ' + budget);
    });
    const raw = fs.readFileSync(path.join(source, 'noggin/persona/FACTS.md'), 'utf8');
    assert.ok(raw.length <= settings.PERSONA.facts.max, 'FACTS.md is ' + raw.length + ' characters; the cap is ' + settings.PERSONA.facts.max);
});

test('config: defaults, missing key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-'));
    assert.throws(() => settings.read(root), /no_key/);
    fs.writeFileSync(settings.file(root), JSON.stringify({apiKey: 'sk-x', silenceSeconds: 30}));
    const c = settings.read(root);
    assert.equal(c.realtimeModel, 'gpt-realtime-2.1'); assert.equal(c.silenceSeconds, 30); assert.equal(c.apiKey, 'sk-x');
});

test('log: JSON lines, mode 0600, no key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-'));
    const log = new ConversationLog(root, true);
    log.write({kind: 'you', text: 'hi'});
    assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(log.file, 'utf8')).text, 'hi');
});

// ---- controller ----
test('a turn: listen, gate open while thinking and closed while speaking, wait for transcript, speak lines with expression, listen again', async () => {
    const h = harness();
    const ended = h.talk.open();
    await untilListening(h);
    assert.equal(h.said[0], 'Hi!');
    assert.ok(h.jibo.eye, 'eye shown');
    assert.ok(h.sent.some(e => e.type === 'session.update' && e.session.output_modalities[0] === 'text'));
    h.audio(); h.audio();
    assert.equal(h.appends(), 2);
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.audio();
    assert.equal(h.appends(), 3, 'audio still goes out while Jibo thinks (D89)');
    reply(h, 'r1', 'A puppy, how lovely! What is its name?');
    await sleep(30);
    assert.equal(h.said.length, 1, 'waits for the transcript');
    h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'I got a puppy'});
    await sleep(200);
    assert.deepEqual(h.said.slice(1), ['A puppy, how lovely!', 'What is its name?']);
    assert.deepEqual(clips(h), ['excited_01@0'], 'the expression next to its line');
    await untilListening(h);
    h.audio();
    assert.equal(h.appends(), 4, 'listening again');
    assert.equal(h.sent.filter(e => e.type === 'input_audio_buffer.clear').length, 2);
    const you = h.logs.find(e => e.kind === 'you'), jibo = h.logs.find(e => e.kind === 'jibo');
    assert.equal(you.text, 'I got a puppy');
    assert.equal(jibo.text, 'A puppy, how lovely! What is its name?');
    assert.deepEqual(jibo.expressions, ['happy', 'none']);
    assert.ok(jibo.ms.first_speech >= jibo.ms.transcript);
    h.talk.close('test'); assert.equal(await ended, 'test');
    assert.equal(h.released(), 1); assert.equal(h.leds.at(-1), '0,0,0');
});

test('empty transcript: reply cancelled, nothing spoken, listening again; a late orphan reply is cancelled too', async () => {
    const h = await listening();
    youSay(h, ' ');
    assert.ok(h.sent.some(e => e.type === 'response.cancel'));
    await untilListening(h);
    reply(h, 'r9', "You're welcome!");
    await sleep(150);
    assert.equal(h.said.length, 1, 'only the greeting');
    assert.ok(h.sent.some(e => e.type === 'response.cancel' && e.response_id === 'r9'));
    assert.ok(h.logs.some(e => e.kind === 'skipped' && e.reason === 'empty_transcript'));
    h.talk.close();
});

test('no transcript at all: the reply is spoken after transcriptWaitMs', async () => {
    const h = await listening();
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    reply(h, 'r1', 'Sure thing.');
    await sleep(60); assert.equal(h.said.length, 1);
    await sleep(150); assert.equal(h.said[1], 'Sure thing.');
    h.talk.close();
});

test('goodbye: the reply is spoken, then the session ends', async () => {
    const h = harness();
    const ended = h.talk.open(); await untilListening(h);
    youSay(h, 'Goodbye Jibo.');
    reply(h, 'r1', 'Bye! Talk soon.');
    assert.equal(await ended, 'goodbye');
    assert.deepEqual(h.said.slice(1), ['Bye!', 'Talk soon.']);
    assert.ok(h.rt.closed);
});

test('silence ends the session; speech start holds it open', async () => {
    const h = harness();
    const ended = h.talk.open(); await untilListening(h);
    await sleep(400); h.emit({type: 'input_audio_buffer.speech_started'});
    await sleep(400); assert.equal(h.talk.active, true);
    youSay(h, 'hm');
    reply(h, 'r1', 'Yes?');
    await untilListening(h);
    assert.equal(await ended, 'silence');
});

test('lost connection while listening: one quiet reconnect with the conversation so far, then the second drop ends it with the cause (D73)', async () => {
    let asked = 0;
    const h = harness({diagnose: () => { asked++; return Promise.resolve({cause: 'no_internet', detail: 'ENOTFOUND'}); }});
    const ended = h.talk.open(); await untilListening(h);
    youSay(h, 'I like dogs');
    reply(h, 'r1', 'Dogs are great.');
    while (h.said.length < 2) await sleep(5);
    await untilListening(h);
    const first = h.rt;
    h.emit({type: 'transport.closed', code: 1006});
    await untilListening(h);
    assert.equal(h.connects(), 2);
    assert.ok(first.closed, 'the old connection is closed');
    assert.equal(h.said.length, 2, 'nothing said: Jibo was only listening');
    const note = h.sent.filter(e => e.type === 'conversation.item.create').at(-1);
    assert.match(note.item.content[0].text, /connection dropped[\s\S]*Person: I like dogs\nJibo: Dogs are great\.[\s\S]*do not greet again/);
    assert.ok(h.logs.some(e => e.kind === 'reconnect') && h.logs.some(e => e.kind === 'reconnected'));
    // The old connection's late events are ignored.
    first.emit({type: 'input_audio_buffer.speech_stopped'});
    assert.equal(h.talk.state, 'listening');
    h.emit({type: 'transport.closed', code: 1006});
    assert.equal(await ended, 'trouble_no_internet');
    assert.equal(asked, 1);
    assert.match(h.said.at(-1), /can't reach the internet/);
    assert.ok(h.logs.some(e => e.kind === 'trouble' && e.cause === 'no_internet' && e.detail === 'ENOTFOUND'));
});

test('session note: the first item of every session, also after a reconnect, before the reconnect note (D181)', async () => {
    const h = harness({note: 'Session note. Facts: Sam likes jazz.'});
    const ended = h.talk.open(); await untilListening(h);
    const firstItem = () => h.sent[h.sent.findLastIndex(e => e.type === 'session.update') + 1];
    assert.equal(firstItem().type, 'conversation.item.create');
    assert.deepEqual(firstItem().item, {type: 'message', role: 'system', content: [{type: 'input_text', text: 'Session note. Facts: Sam likes jazz.'}]});
    assert.equal(h.sent.find(e => e.type === 'session.update').session.instructions, 'be Jibo');
    h.emit({type: 'transport.closed', code: 1006});
    while (h.connects() < 2) await sleep(5);
    await untilListening(h);
    assert.equal(firstItem().item.content[0].text, 'Session note. Facts: Sam likes jazz.', 'the same text again, so the cache keeps it');
    const items = h.sent.filter(e => e.type === 'conversation.item.create').map(e => e.item.content[0].text);
    assert.equal(items.length, 3);
    assert.match(items[2], /connection dropped/);
    h.talk.close('test'); await ended;
});

test('session note: a Dutch refusal while the session is set up sends the English note after the session note (D175, D181)', async () => {
    let release = null;
    const h = harness({note: 'Session note.', connect: (n, rt) => {
        const send = rt.send;
        rt.send = e => { if (e.type === 'session.update' && !release) { release = () => send(e); return; } send(e); };
        return Promise.resolve(rt);
    }});
    const ended = h.talk.open();
    while (!release) await sleep(5);
    h.talk.dutchFailed('dutch_voice_not_ready', {});
    assert.equal(h.sent.filter(e => e.type === 'conversation.item.create').length, 0, 'nothing before the session is set up');
    release();
    await untilListening(h);
    const items = h.sent.filter(e => e.type === 'conversation.item.create').map(e => e.item.content[0].text);
    assert.equal(items[0], 'Session note.');
    assert.equal(items.filter(text => /Dutch voice is not working/.test(text)).length, 1);
    h.talk.close('test'); await ended;
});

test('lost connection while thinking: the reply is dropped and Jibo asks again after the reconnect (D73)', async () => {
    const h = harness();
    const ended = h.talk.open(); await untilListening(h);
    youSay(h, 'tell me a story');
    h.emit({type: 'transport.closed', code: 1006});
    await untilListening(h);
    assert.match(h.said.at(-1), /lost my train of thought/);
    reply(h, 'late', 'This never plays.');
    await sleep(30);
    assert.doesNotMatch(h.said.join(' '), /never plays/);
    h.talk.close('test'); await ended;
});

test('a failed reconnect ends the conversation with the diagnosed cause', async () => {
    const h = harness({connect: (n, rt) => n === 1 ? Promise.resolve(rt) : Promise.reject(Error('connection closed (1006)')),
        diagnose: () => Promise.resolve({cause: 'openai_down', detail: 'models 503'})});
    const ended = h.talk.open(); await untilListening(h);
    h.emit({type: 'transport.closed', code: 1006});
    assert.equal(await ended, 'trouble_openai_down');
    assert.match(h.said.at(-1), /out of reach/);
});

test('trouble at the start: the cause from OpenAI\'s own code, a diagnosis for a refused socket, the old line otherwise (D70, D71)', async () => {
    // A realtime error with a code: no diagnosis needed.
    let asked = 0;
    const quota = harness({connect: () => Promise.reject(Error('OpenAI: insufficient_quota')), diagnose: () => { asked++; return Promise.resolve({cause: 'unknown'}); }});
    assert.equal(await quota.talk.open(), 'trouble_no_credit');
    assert.equal(asked, 0);
    assert.match(quota.said.at(-1), /run out of thinking money/);
    // The page's WebSocket only says "closed": asked.
    const refused = harness({connect: () => Promise.reject(Error('connection closed (1006)')), diagnose: () => Promise.resolve({cause: 'key_refused', detail: 'models 401'})});
    assert.equal(await refused.talk.open(), 'trouble_key_refused');
    assert.match(refused.said.at(-1), /key to OpenAI doesn't work/);
    // A diagnosis that throws: the old line.
    const broken = harness({connect: () => Promise.reject(Error('connection closed (1006)')), diagnose: () => Promise.reject(Error('boom'))});
    assert.equal(await broken.talk.open(), 'error');
    assert.match(broken.said.at(-1), /can't think straight/);
    // The microphone is not OpenAI's: never diagnosed.
    let micAsked = 0;
    const mic = harness({mic: {start: () => Promise.reject(Error('no microphone')), stop() {}}, diagnose: () => { micAsked++; return Promise.resolve({cause: 'no_internet'}); }});
    assert.equal(await mic.talk.open(), 'error');
    assert.equal(micAsked, 0);
});

test('a fatal error during the greeting waits for it, then always says the cause (D76)', async () => {
    const h = harness({speakMs: 150});
    const ended = h.talk.open();
    while (h.said.length < 1) await sleep(2);
    h.emit({type: 'error', error: {code: 'insufficient_quota'}});
    assert.equal(await ended, 'trouble_no_credit');
    assert.equal(h.said[0], 'Hi!');
    assert.match(h.said.at(-1), /thinking money/);
    assert.ok(!h.jibo.stopped, 'the greeting was not cut off');
});

test('no reconnect while fail() runs (D76)', async () => {
    let release;
    const h = harness({diagnose: () => new Promise(r => { release = r; })});
    const ended = h.talk.open(); await untilListening(h);
    h.talk.fail(Object.assign(Error('connection closed (1006)'), {openai: true}));
    h.emit({type: 'transport.closed', code: 1006});
    await sleep(20);
    assert.equal(h.connects(), 1);
    release({cause: 'openai_down'});
    assert.equal(await ended, 'trouble_openai_down');
    assert.ok(!h.said.some(t => /train of thought/.test(t)));
});

test('a drop while a complete reply is spoken keeps the reply and listens after the reconnect (D76)', async () => {
    const h = harness({speakMs: 80});
    const ended = h.talk.open(); await untilListening(h);
    youSay(h, 'tell me about cats');
    reply(h, 'r1', 'Cats purr. They nap a lot. They like boxes.');
    while (h.said.length < 2) await sleep(2);
    h.emit({type: 'transport.closed', code: 1006});
    await untilListening(h);
    assert.deepEqual(h.said.slice(1), ['Cats purr.', 'They nap a lot. They like boxes.']);
    assert.ok(!h.said.some(t => /train of thought/.test(t)));
    const note = h.sent.filter(e => e.type === 'conversation.item.create').at(-1).item.content[0].text;
    assert.match(note, /Person: tell me about cats\nJibo: Cats purr\. They nap a lot\. They like boxes\./);
    h.talk.close('test'); await ended;
});

test('a drop while a done reply still waits for its transcript loses it and still listens again (D76)', async () => {
    const h = harness({config: {transcriptWaitMs: 400}});
    const ended = h.talk.open(); await untilListening(h);
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    reply(h, 'r1', 'A reply without a transcript yet.');
    h.emit({type: 'transport.closed', code: 1006});
    await untilListening(h);
    assert.match(h.said.at(-1), /train of thought/);
    await sleep(450);
    assert.equal(h.talk.state, 'listening', 'the old turn\'s wait timer does not take over');
    assert.ok(!h.said.some(t => /without a transcript/.test(t)));
    h.talk.close('test'); await ended;
});

test('trouble mid-conversation: a failed response or error event with a known code ends it with the cause', async () => {
    const h = harness();
    const ended = h.talk.open(); await untilListening(h);
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'response.done', response: {id: 'r1', status: 'failed', status_details: {error: {code: 'insufficient_quota'}}}});
    assert.equal(await ended, 'trouble_no_credit');
    const h2 = harness();
    const ended2 = h2.talk.open(); await untilListening(h2);
    h2.emit({type: 'error', error: {code: 'rate_limit_exceeded', message: 'slow down'}});
    assert.equal(await ended2, 'trouble_rate_limited');
    assert.match(h2.said.at(-1), /catch my breath/);
    // An ordinary error event goes on.
    const h3 = harness();
    const ended3 = h3.talk.open(); await untilListening(h3);
    h3.emit({type: 'error', error: {code: 'response_cancel_not_active'}});
    await sleep(20);
    assert.equal(h3.talk.state, 'listening');
    h3.talk.close('test'); await ended3;
});

test('error text from OpenAI is cut to 300 characters in the log', async () => {
    const h = harness();
    const ended = h.talk.open(); await untilListening(h);
    h.emit({type: 'error', error: {code: 'some_unknown_code', message: 'x'.repeat(5000)}});
    await sleep(20);
    assert.equal(h.logs.find(e => e.kind === 'error').message.length, 300);
    assert.equal(h.talk.state, 'listening', 'an unknown code goes on');
    h.talk.close('test'); await ended;
});

test('a notice after the greeting, once, with its emoji; none on a comeback (D74)', async () => {
    let said = 0;
    const notice = {line: 'budget', emoji: 'Emoji_Money', said: () => { said++; }};
    const h = harness({notice, config: {emoji: true}});
    const ended = h.talk.open(); await untilListening(h);
    assert.equal(h.said[0], 'Hi!');
    assert.match(h.said[1], /^Heads up: my thinking money/);
    assert.ok(h.logs.some(e => e.kind === 'anim' && e.name === 'Emoji_Money' && e.via === 'notice'));
    assert.deepEqual(h.rules[1], {hotWords: false}, "no keyword emoji of speech's own over the notice's");
    assert.equal(said, 1);
    h.talk.close('test'); await ended;
    const back = harness({notice, resume: {pairs: [], tool: 'get_time', said: ''}, config: {comebackLine: 'Anything else?'}});
    const ended2 = back.talk.open(); await untilListening(back);
    assert.ok(!back.said.some(t => /money/.test(t)));
    back.talk.close('test'); await ended2;
});

test('privacy, swipe-like leave and skill switch end the session quietly', async () => {
    const h = harness();
    const ended = h.talk.open(); await untilListening(h);
    h.jibo.privacyController.enabled = true;
    assert.equal(await ended, 'privacy');
    assert.equal(h.said.length, 1);
    const h2 = harness();
    const ended2 = h2.talk.open(); await untilListening(h2);
    h2.jibo.jetstream.events.skillSwitch.fire();
    assert.equal(await ended2, 'skill_switch');
    assert.equal(h2.jibo.jetstream.events.skillSwitch.count, 0, 'unwatched');
});

test('opened by "Hey Jibo": the global turn that hotword started is ignored once, the next one ends the talk (D132)', async () => {
    const h = harness({heyJibo: {heardAt: Date.now()}});
    const ended = h.talk.open(); await untilListening(h);
    h.jibo.jetstream.events.globalTurnStarted.fire();
    await sleep(20);
    assert.equal(h.talk.state, 'listening', 'still talking');
    assert.equal(h.logs.filter(e => e.kind === 'hey_jibo_turn').length, 1);
    h.jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(await ended, 'global_turn');
});

test('opened by "Hey Jibo" long ago, or from the menu: a global turn ends the talk (D132)', async () => {
    for (const hey of [{heardAt: Date.now() - 60000}, null]) {
        const h = harness({heyJibo: hey});
        const ended = h.talk.open(); await untilListening(h);
        h.jibo.jetstream.events.globalTurnStarted.fire();
        assert.equal(await ended, 'global_turn');
        assert.ok(!h.logs.some(e => e.kind === 'hey_jibo_turn'));
    }
});

test('a slow classifier does not hold the first line beyond expressionWaitMs', async () => {
    const h = await listening({classify: () => sleep(400).then(() => ({label: 'happy', ms: 400}))});
    youSay(h, 'puppy');
    const t0 = Date.now();
    reply(h, 'r1', 'A puppy!');
    while (h.said.length < 2) await sleep(5);
    assert.ok(Date.now() - t0 < 300);
    assert.equal(h.said[1], 'A puppy!');
    h.talk.close();
});

test('a session.update error fails the start politely', async () => {
    const h = harness();
    h.rt.send = e => { h.sent.push(e); if (e.type === 'session.update') setTimeout(() => h.emit({type: 'error', error: {code: 'invalid_value'}}), 1); };
    const ended = h.talk.open();
    assert.equal(await ended, 'error');
    assert.ok(h.logs.some(e => e.kind === 'failed' && /invalid_value/.test(e.error)));
});

test('a classifier that throws or hangs only loses the expression', async () => {
    for (const classify of [() => { throw Error('boom'); }, () => new Promise(() => {})]) {
        const h = harness({classify});
        h.talk.open(); await untilListening(h);
        youSay(h, 'hi');
        reply(h, 'r1', 'Hello there.');
        await untilListening(h);
        assert.equal(h.said[1], 'Hello there.');
        h.talk.close();
    }
});

test('a hotword release that never answers does not keep the session open', async () => {
    const h = harness();
    h.jibo.jetstream.setHotwordMode = () => ({activated: new Promise(() => {}), release: () => new Promise(() => {})});
    const ended = h.talk.open();
    for (let i = 0; i < 600 && h.talk.state !== 'listening'; i++) await sleep(5);
    assert.equal(h.talk.state, 'listening', 'activation that never comes is not waited for forever');
    h.talk.close('test');
    assert.equal(await ended, 'test');
});

test('a pause, not the end: if the person goes on before Jibo speaks, keep listening without clearing', async () => {
    const h = await listening();
    const clears = () => h.sent.filter(e => e.type === 'input_audio_buffer.clear').length;
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'response.created', response: {id: 'r1'}});
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.equal(h.talk.state, 'listening');
    assert.equal(clears(), 1, 'the resumed speech is kept');
    h.audio(); assert.ok(h.appends() >= 1, 'audio flows again');
    h.emit({type: 'response.done', response: {id: 'r1', status: 'cancelled'}});
    youSay(h, 'and then some more');
    reply(h, 'r2', 'Got it.');
    await untilListening(h);
    assert.equal(h.said.at(-1), 'Got it.');
    assert.ok(h.logs.some(e => e.kind === 'continued'));
    h.talk.close();
});

test('a first-line expression that comes too late moves to the second line', async () => {
    const h = await listening({speakMs: 300, classify: (person, line) => /^Wow/.test(line) ? sleep(150).then(() => ({label: 'surprised'})) : Promise.resolve({label: 'none'})});
    youSay(h, 'I won the lottery');
    reply(h, 'r1', 'Wow, really? That is amazing news for you.');
    await untilListening(h);
    assert.deepEqual(h.said.slice(1), ['Wow, really?', 'That is amazing news for you.']);
    assert.equal(clips(h).at(-1), 'surprised_02@1');
    h.talk.close();
});

test('the same expression may come back after the repeat window, and the thinking eye can be turned off', () => {
    const p = new catalog.ExpressionPolicy(4000, 15000);
    p.used('happy', 0);
    assert.ok(!p.allow('happy', 10000, '')); assert.ok(p.allow('happy', 16000, ''));
    assert.equal(DEFAULTS.thinkingEye, false, 'the reaction replaces the thinking loop by default');
    assert.equal(realtime.sessionUpdate({transcribeModel: 'x', turnDetection: 'semantic_vad'}, 'i').session.audio.input.transcription.prompt.includes('Jibo'), true);
});

test('transcription languages: sent only to models that take them, only known codes, none when empty', () => {
    const sent = config => realtime.sessionUpdate(Object.assign({turnDetection: 'semantic_vad'}, config), 'i').session.audio.input.transcription;
    assert.deepEqual(sent({transcribeModel: 'gpt-transcribe', transcribeLanguages: ['en', 'nl']}).languages, ['en', 'nl']);
    assert.deepEqual(sent({transcribeModel: 'gpt-live-transcribe', transcribeLanguages: ['nl']}).languages, ['nl']);
    assert.deepEqual(sent({transcribeModel: 'gpt-transcribe-2026-11-01', transcribeLanguages: ['en', 'xx']}).languages, ['en'], 'a snapshot too; unknown codes dropped');
    for (const config of [{transcribeModel: 'gpt-4o-mini-transcribe', transcribeLanguages: ['en', 'nl']}, {transcribeModel: 'gpt-transcribe', transcribeLanguages: []},
        {transcribeModel: 'gpt-transcribe'}, {transcribeModel: 'gpt-transcribe', transcribeLanguages: 'en'}, {transcribeModel: 'gpt-transcribex', transcribeLanguages: ['en']}]) {
        const t = sent(config);
        assert.equal('languages' in t, false, JSON.stringify(config));
        assert.equal(t.model, config.transcribeModel); assert.ok(t.prompt.includes('Jibo'));
    }
});

test('realtime reasoning: low unless set, only to gpt-realtime-2 models, none for the model default', () => {
    const effort = config => realtime.sessionUpdate(Object.assign({turnDetection: 'semantic_vad', realtimeModel: 'gpt-realtime-2.1'}, config), 'i', [{name: 't'}]).session.reasoning;
    assert.deepEqual(effort({}), {effort: 'low'}, 'not set: low, the documented gpt-realtime-2 default');
    assert.deepEqual(effort({realtimeReasoning: 'minimal'}), {effort: 'minimal'});
    assert.deepEqual(effort({realtimeReasoning: 'xhigh', realtimeModel: 'gpt-realtime-2'}), {effort: 'xhigh'});
    assert.deepEqual(effort({realtimeModel: 'gpt-realtime-2.1-mini'}), {effort: 'low'});
    assert.deepEqual(effort({realtimeReasoning: null}), {effort: 'low'}, 'null is not set');
    for (const config of [{realtimeReasoning: 'default'}, {realtimeReasoning: 'loud'}, {realtimeModel: 'gpt-realtime'}, {realtimeModel: 'gpt-realtime-20'}, {realtimeModel: ''}]) {
        assert.equal(effort(config), undefined, JSON.stringify(config));
    }
    assert.equal(realtime.sessionUpdate({turnDetection: 'semantic_vad', realtimeModel: 'gpt-realtime-2.1'}, 'i').session.tools, undefined, 'tools unchanged');
    assert.equal(DEFAULTS.realtimeReasoning, 'low');
});

test('a model that refuses the reasoning field gets the session update again without it, once', async () => {
    // The stub answers a session.update that carries reasoning with an error event, as a model that does not know the field would.
    const refuse = (code, refused) => (n, rt) => {
        const send = rt.send;
        rt.send = e => {
            if (e.type === 'session.update' && e.session.reasoning) { refused.push(e); setTimeout(() => rt.emit({type: 'error', error: {code: code}}), 1); return; }
            return send.call(rt, e);
        };
        return Promise.resolve(rt);
    };
    const refused = [], h = harness({connect: refuse('unknown_parameter', refused)});
    h.talk.open(); await untilListening(h);
    assert.equal(refused.length, 1, 'asked once with the effort');
    const updates = h.sent.filter(e => e.type === 'session.update');
    assert.equal(updates.length, 1, 'then once without it');
    assert.equal(updates[0].session.reasoning, undefined);
    assert.deepEqual(h.logs.filter(e => e.kind === 'reasoning_refused'), [{kind: 'reasoning_refused', code: 'unknown_parameter'}]);
    assert.equal(h.talk.reasoningRefused, true, 'a reconnect does not ask again');
    h.talk.close();
    // A fatal code (a refused key) is not retried: the usual trouble path.
    const fatal = [], bad = harness({connect: refuse('invalid_api_key', fatal)});
    bad.talk.open(); await bad.talk.done;
    assert.equal(fatal.length, 1);
    assert.equal(bad.logs.filter(e => e.kind === 'reasoning_refused').length, 0);
    assert.equal(bad.sent.filter(e => e.type === 'session.update').length, 0, 'no second update');
});

test('Decisions API: request shape, answer parsing, confidence threshold', () => {
    const line = labels.decisionsRequest('gpt-6-luna', 'I got a puppy', 'A puppy, how lovely!', 'line');
    assert.equal(line.model, 'gpt-6-luna');
    assert.match(line.input, /I got a puppy/); assert.match(line.input, /how lovely/);
    const q = line.questions[0];
    assert.equal(q.type, 'choice'); assert.equal(q.name, 'expression');
    assert.equal(q.choices.length, 32); assert.ok(q.choices.every(c => c.value && c.description));
    assert.equal(line.questions.length, 1, 'no size question unless asked');
    const reaction = labels.decisionsRequest('gpt-6-luna', 'Can you dance?', null, 'reaction');
    assert.ok(!reaction.questions[0].choices.some(c => c.value === 'dance'), 'no dance as a reaction');
    assert.doesNotMatch(reaction.input, /Jibo now says/);
    const answer = (choice, confidence) => ({answers: [{type: 'choice', name: 'expression', choice, confidence, probabilities: []}], usage: {input_tokens: 400}});
    assert.deepEqual(labels.decisionLabel(answer('heart', 0.9), 0.35), {label: 'heart', confidence: 0.9, size: null});
    assert.deepEqual(labels.decisionLabel(answer('heart', 0.2), 0.35), {label: 'none', confidence: 0.2, below: 'heart', size: null});
    assert.equal(labels.decisionLabel(answer('explode', 0.9), 0.35).label, null);
    assert.equal(labels.decisionLabel({answers: [{type: 'refusal', name: 'expression'}]}, 0.35).label, null);
    assert.equal(labels.decisionLabel(null).label, null);
});

test('classifier: a refused Decisions request gives no expression and no other model is asked (D179)', async () => {
    const calls = [];
    const config = Object.assign({}, DEFAULTS, {apiKey: 'sk'});
    const ok = openai.classifier(config, (route, body) => { calls.push(route); return Promise.resolve({status: 200, ms: 120, json: {answers: [{type: 'choice', name: 'expression', choice: 'happy', confidence: 0.8}]}}); });
    assert.deepEqual(await ok('hi', 'Yay!', 'line'), {label: 'happy', confidence: 0.8, size: null, ms: 120, api: 'decisions'});
    calls.length = 0;
    const missing = openai.classifier(config, (route, body) => {
        calls.push(route + ':' + body.model);
        return Promise.resolve({status: 404, ms: 50, json: {error: {code: 'model_not_found'}}});
    });
    const first = await missing('my cat died', 'I am so sorry.', 'line');
    assert.equal(first.label, null); assert.equal(first.error, 'model_not_found'); assert.equal(first.switched, undefined);
    await missing('x', 'y', 'reaction');
    assert.deepEqual(calls, ['/decisions:gpt-6-luna', '/decisions:gpt-6-luna']);
});

test('reaction that arrives after the first line is queued goes with that line', async () => {
    const h = await listening({classify: (person, line, kind) => kind === 'reaction' ? sleep(30).then(() => ({label: 'heart', confidence: 0.9})) : Promise.resolve({label: 'happy'})});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    reply(h, 'r1', 'Aw, I love you too! You are the best.');
    h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'I love you Jibo'});
    await untilListening(h);
    assert.equal(h.said[1], 'Aw, I love you too!');
    assert.ok(clips(h).includes('Emoji_HeartRed@0'), 'the reaction with the first line');
    assert.equal(h.said[2], 'You are the best.', 'own expression held back by the 4 s gap');
    assert.equal(h.logs.find(e => e.kind === 'jibo').reaction.played, 'with first line');
    assert.equal(h.logs.find(e => e.kind === 'jibo').expressions[0], 'happy (held back)', 'the reaction played, not the line\'s own label');
    h.talk.close();
});

test('no reaction and no thinking loop when the reaction is "none"', async () => {
    const h = await listening({classify: () => Promise.resolve({label: 'none', confidence: 0.9})});
    youSay(h, 'What time is it?');
    reply(h, 'r1', 'It is half past seven.');
    await untilListening(h);
    assert.deepEqual(h.said.slice(1), ['It is half past seven.']);
    h.talk.close();
});

test('diagnostics: audio stats, realtime events and handler exceptions go to the log', async () => {
    const h = await listening();
    h.audio(); h.audio();
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'response.output_text.delta', delta: 'x'});
    h.talk.close('test'); await sleep(5);
    const audio = h.logs.filter(e => e.kind === 'audio').pop();
    assert.equal(audio.blocks, 2); assert.equal(audio.sent, 2); assert.equal(audio.db.median, -40);
    assert.ok(h.logs.some(e => e.kind === 'rt' && e.type === 'input_audio_buffer.speech_started' && e.state === 'listening'));
    assert.ok(!h.logs.some(e => e.kind === 'rt' && /delta/.test(e.type)));
    const h2 = await listening();
    h2.talk.startTurn = () => { throw Error('boom'); };
    h2.emit({type: 'input_audio_buffer.speech_stopped'});
    assert.ok(h2.logs.some(e => e.kind === 'exception' && /boom/.test(e.error)));
    assert.equal(h2.talk.active, true, 'still running');
    h2.talk.close();
    assert.deepEqual([...new Set(h.leds.filter(c => c !== '0,0,0' && c !== '0,0.45,1'))], ['1,0.55,0'], 'orange while busy, never green');
});

test('the ring colour is re-sent every ringRefreshMs (at least 100 ms), so an animation cannot leave it off (D113)', async () => {
    const h = await listening({config: {silenceSeconds: 20, ringRefreshMs: 20}});
    h.jibo.expression.setLEDColor([0, 0, 0]);          // what a glance animation's LED layer does
    await sleep(40);
    assert.equal(h.leds.at(-1), '0,0,0', 'never more often than every 100 ms');
    await sleep(100);
    assert.equal(h.leds.at(-1), '0,0.45,1', 'listening blue again');
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    await sleep(120);
    assert.equal(h.leds.at(-1), '1,0.55,0', 'busy orange while thinking');
    h.talk.close('test'); await sleep(5);
    const count = h.leds.length;
    await sleep(150);
    assert.equal(h.leds.length, count, 'no more ring updates after the conversation');
    assert.equal(h.leds.at(-1), '0,0,0');
    assert.equal(DEFAULTS.ringRefreshMs, 500);
});

test('the ring is re-sent when a line\'s words and its animations end, also with the refresh off (D113)', async () => {
    let finish;
    const h = harness({config: {silenceSeconds: 20, ringRefreshMs: 0}, speech: {waitForAnimDispatch: () => new Promise(r => { finish = r; })}});
    h.talk.open();
    await until(() => h.logs.some(e => e.kind === 'spoken'));
    const afterWords = h.leds.length;
    assert.equal(h.leds.at(-1), '1,0.55,0', 'orange again once the words are done');
    h.jibo.expression.setLEDColor([0, 0, 0]);
    finish(); await sleep(5);
    assert.ok(h.leds.length > afterWords + 1); assert.notEqual(h.leds.at(-1), '0,0,0', 'set again when speech\'s animations end');
    await untilListening(h);
    const before = h.leds.length; await sleep(150);
    assert.equal(h.leds.length, before, 'ringRefreshMs 0: no timer');
    h.talk.close();
});

test('a speak that never answers is stopped after its limit, and the conversation goes on (D114)', async () => {
    const before = Conversation.SPEAK_BASE_MS; Conversation.SPEAK_BASE_MS = 50;
    try {
        const h = harness({config: {silenceSeconds: 20}, speech: {speak: text => { h.said.push(text); return text === 'Hi!' ? new Promise(() => {}) : sleep(10); }}});
        const ended = h.talk.open();
        await untilListening(h);
        const timeout = h.logs.find(e => e.kind === 'speak_timeout');
        assert.ok(timeout && timeout.ms === 50 + 'Hi!'.length * 120, 'logged with its limit');
        assert.ok(h.jibo.stopped, 'speech stopped');
        h.talk.close('test'); assert.equal(await ended, 'test');
    } finally { Conversation.SPEAK_BASE_MS = before; }
});

test('closing while a speak is pending clears its time limit, so it never stops the next skill\'s speech (D114)', async () => {
    const before = Conversation.SPEAK_BASE_MS; Conversation.SPEAK_BASE_MS = 60;
    try {
        let stops = 0;
        const h = harness({speech: {speak: text => { h.said.push(text); return new Promise(() => {}); }, stop: () => { stops++; }}});
        const ended = h.talk.open();
        await until(() => h.said.length === 1);
        h.talk.close('test'); await ended;
        const stopsAtClose = stops;
        await sleep(60 + 3 * 120 + 150);
        assert.equal(stops, stopsAtClose, 'no stop after close');
        assert.ok(!h.logs.some(e => e.kind === 'speak_timeout'));
    } finally { Conversation.SPEAK_BASE_MS = before; }
});

test('closing during a dance centres Jibo, as for a clip (D116)', async () => {
    const db = fakeAnimDB();
    const h = await listening({animDB: db.animDB, expression: db.expression, actions: fakeActions(),
        speech: {speak: (text, opts) => { h.said.push(text); return /<anim name='dance/.test(text) ? new Promise(() => {}) : sleep(10); }}});
    h.talk.runLocal('dance', {}, null);
    await until(() => h.talk.dancing);
    await h.talk.close('test');
    assert.equal(db.centred.length, 1, 'back to neutral after the dance was stopped');
    assert.ok(!db.centred[0].dofs.names.includes('BASE'));
});

test('each speak is logged before it starts, with its turn, line and expression; audio reports carry health', async () => {
    const h = await listening();
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    reply(h, 'r1', 'A puppy, how lovely! What is its name?');
    h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'I got a puppy'});
    await sleep(200); await untilListening(h);
    const speaks = h.logs.filter(e => e.kind === 'speak');
    assert.equal(speaks[0].text, 'Hi!'); assert.equal(speaks[0].turn, null);
    assert.deepEqual(speaks.slice(1).map(e => [e.turn, e.line, e.expression]), [[1, 0, 'happy'], [1, 1, null]]);
    assert.ok(h.logs.indexOf(speaks[1]) < h.logs.findIndex(e => e.kind === 'jibo'));
    h.talk.audioReport();
    const audio = h.logs.filter(e => e.kind === 'audio').at(-1);
    assert.equal(audio.source, 'arecord'); assert.equal(audio.micStarts, 1);
    assert.ok(audio.mem && audio.mem.rss > 0);
    h.talk.close();
});

// ---- BEam 3.2.0 permissions: a blocked call throws an error that names the permission ----
test('the microphone program refused (no run-programs): Jibo says he is not allowed, ends, and the hotword is given back', async () => {
    let stopped = 0;
    const h = harness({mic: {start: () => { throw BLOCKED('run-programs'); }, stop: () => { stopped++; }, kind: 'arecord'}});
    assert.equal(await h.talk.open(), 'trouble_permission');
    assert.match(h.said.at(-1), /not allowed to do that/);
    assert.equal(h.released(), 1, 'the hotword is back');
    assert.ok(h.logs.some(e => e.kind === 'trouble' && e.cause === 'permission'));
    assert.ok(stopped >= 1);
    assert.equal(h.leds.at(-1), '0,0,0', 'the ring is off');
});

test('the hotword mode refused (no microphone permission): the conversation goes on with Jibo\'s own hotword', async () => {
    const h = harness();
    h.jibo.jetstream.setHotwordMode = () => { throw BLOCKED('microphone'); };
    const ended = h.talk.open(); await untilListening(h);
    assert.equal(h.talk.hotword, null);
    h.talk.close('test');
    assert.equal(await ended, 'test');
    assert.equal(h.released(), 0);
});

test('the realtime connection refused by the page (a private API address without local-network): the permission line, no network diagnosis', async () => {
    let asked = 0;
    const h = harness({connect: () => Promise.reject(BLOCKED('local-network')), diagnose: () => { asked++; return Promise.resolve({cause: 'no_internet'}); }});
    assert.equal(await h.talk.open(), 'trouble_permission_network');
    assert.match(h.said.at(-1), /change the address/);
    assert.equal(asked, 0);
});

test('the web microphone asks the page for audio only, never BEam\'s camera-guarded jibo.media', async () => {
    const calls = [];
    const stream = {getAudioTracks: () => [], getTracks: () => []};
    const node = () => ({connect() {}, disconnect() {}});
    class Context {
        constructor() { this.sampleRate = 48000; this.destination = {}; }
        createMediaStreamSource() { return node(); }
        createScriptProcessor() { return node(); }
        close() { return Promise.resolve(); }
    }
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {mediaDevices: {getUserMedia: c => { calls.push(c); return Promise.resolve(stream); }}}});
    try {
        const jibo = {media: {getUserMedia: () => { throw BLOCKED('camera'); }}};
        const mic = new Microphone(jibo, {AudioContext: Context});
        await mic.start(() => {});
        mic.stop();
        assert.deepEqual(calls, [{audio: true}]);
    } finally { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; }
});

// ---- moved here from other sections ----
test('the instructions tell Jibo his emoji come from the words he says, and keep them apart from picture (D161)', () => {
    const text = realtime.voiceSetup({});
    assert.match(text, /small emoji may show on your eye when you say the name of something/);
    assert.match(text, /never say you have none/);
    assert.doesNotMatch(text, /use picture/, 'no picture tool, no mention of it');
    assert.match(realtime.voiceSetup({cloudSkills: ['picture']}), /An emoji is not a picture: for a photo use picture/);
    assert.match(realtime.voiceSetup(null, null), /small emoji may show/, 'also without tools');
    assert.doesNotMatch(realtime.voiceSetup({emoji: false}), /small emoji may show/);
    assert.doesNotMatch(realtime.voiceSetup(null, null, {emoji: false}), /small emoji may show/);
    assert.match(text, /no markdown, lists, emoji, bracketed markers/, 'he still writes no emoji characters');
});
test('a reply that never comes: the turn is dropped after replyWaitMs and Jibo listens again', async () => {
    const h = await listening({config: {replyWaitMs: 150}});
    youSay(h, 'are you there?');
    assert.equal(h.talk.state, 'thinking');
    await sleep(250);
    assert.equal(h.talk.state, 'listening');
    assert.ok(h.logs.some(e => e.kind === 'skipped' && e.reason === 'no_reply'));
    assert.equal(h.said.length, 1, 'only the greeting');
    h.talk.close();
});

test('goodbye waits for the last expression to end (at most FINISH_MS), then ends', async () => {
    const h = await listening();
    let finish;
    h.talk.player.idle = () => new Promise(resolve => { finish = resolve; });
    h.talk.finishAndLeave('goodbye');
    await sleep(30);
    assert.notEqual(h.talk.state, 'closed', 'still finishing the expression');
    finish();
    await sleep(20);
    assert.equal(h.talk.state, 'closed');
    assert.ok(h.logs.some(e => e.kind === 'session_end' && e.reason === 'goodbye'));
});

test('the session entry names the skill version that wrote the log, and the transcription languages sent', async () => {
    const h = await listening({version: '9.8.7'});
    assert.equal(h.logs.find(e => e.kind === 'session').version, '9.8.7');
    h.talk.close();
    const languages = async config => {
        const t = harness({config: Object.assign({transcribeModel: 'gpt-transcribe', transcribeLanguages: ['en', 'nl']}, config)});
        t.talk.open(); await untilListening(t);
        const sent = t.logs.find(e => e.kind === 'session').transcribeLanguages;
        t.talk.close();
        return sent;
    };
    assert.deepEqual(await languages({}), ['en', 'nl'], 'the languages sent to the transcription model');
    assert.equal(await languages({transcribeModel: 'gpt-4o-mini-transcribe'}), null, 'none for a model that takes no list');
    const reasoning = async config => {
        const t = harness({config}); t.talk.open(); await untilListening(t);
        const sent = t.logs.find(e => e.kind === 'session').reasoning;
        t.talk.close();
        return sent;
    };
    assert.equal(await reasoning({realtimeModel: 'gpt-realtime-2.1'}), 'low', 'the effort asked for');
    assert.equal(await reasoning({realtimeReasoning: 'default'}), null);
    assert.equal(await reasoning({realtimeModel: 'gpt-realtime'}), null, 'none for a model that takes no effort');
    const bare = await listening();
    assert.ok(!('version' in JSON.parse(JSON.stringify(bare.logs.find(e => e.kind === 'session')))), 'left out when unknown');
    bare.talk.close();
});

