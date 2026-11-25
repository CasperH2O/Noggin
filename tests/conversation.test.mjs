// Noggin: pure helpers and the conversation controller against fakes of Jibo,
// the realtime connection, the microphone and the classifier.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const audio = require(path.join(source, 'noggin/lib/audio.js'));
const catalog = require(path.join(source, 'noggin/lib/catalog.js'));
const ttsText = require(path.join(source, 'noggin/lib/tts-text.js'));
const labels = require(path.join(source, 'noggin/lib/labels.js'));
const realtime = require(path.join(source, 'noggin/lib/realtime-session.js'));
const actions = require(path.join(source, 'noggin/lib/actions.js'));
const Conversation = require(path.join(source, 'noggin/lib/controller.js'));
const settings = require(path.join(source, 'noggin/lib/settings.js'));
const openai = require(path.join(source, 'noggin/lib/openai.js'));
const ConversationLog = require(path.join(source, 'noggin/lib/conversation-log.js'));
const Microphone = require(path.join(source, 'noggin/lib/mic.js'));
const ExpressionPlayer = require(path.join(source, 'noggin/lib/expression.js'));
const memoryLib = require(path.join(source, 'noggin/lib/memory.js'));
// Every setting's default, as a fresh install has them (secrets have none).
const DEFAULTS = {};
settings.SCHEMA.forEach(f => { if (settings.SECRETS.indexOf(f.key) < 0) DEFAULTS[f.key] = f.default; });
import {EventEmitter} from 'node:events';
import {execFileSync} from 'node:child_process';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// BEam's animation database, when this checkout sits in the jibo-resurrection workspace (or JIBO_ANIMDB).
const ANIMDB = process.env.JIBO_ANIMDB || path.resolve(source, '../../../original-assets/BEam/@be/be/node_modules/jibo-anim-db-animations/animdb.json');

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
    const text = realtime.instructions(p.soul, p.identity, {apps: ['clock']});
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

test('persona budget: the instructions stay small, and so does FACTS.md', () => {
    const p = settings.persona(null);
    const apps = ['clock', 'photos', 'radio', 'weather', 'jokes'];
    const text = realtime.instructions(p.soul, p.identity, {apps, config: {}});
    assert.ok(text.length <= 5600, 'instructions are ' + text.length + ' characters (about ' + Math.round(text.length / 4) + ' tokens); the budget is 5600');
    // Every cloud feature on: ~60 characters more, for naming what the cloud can do.
    const all = realtime.instructions(p.soul, p.identity, {apps, config: {cloudSkills: Object.keys(actions.CLOUD)}});
    assert.ok(all.length <= 5750, 'with every cloud tool the instructions are ' + all.length + ' characters; the budget is 5750');
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
function emitter() {
    const fns = [];
    return {on: f => fns.push(f), off: f => fns.splice(fns.indexOf(f), 1), fire: (...a) => fns.slice().forEach(f => f(...a)), get count() { return fns.length; }};
}
// One fixed animation per mood, so what the conversation tests expect is predictable.
const TEST_ANIM = {happy: 'excited_01', sad: 'sad_01', surprised: 'surprised_02', thinking: 'Thinking_00', heart: 'Emoji_HeartRed', hello: 'greetings_01', giggle: 'laughter_01'};
function harness(over = {}) {
    const said = [], leds = [], logs = [], sent = [], options = [], rules = [];
    let onBlock = null, released = 0, connects = 0;
    // Each connect is a new connection; emit() reaches the newest one.
    const makeRt = () => {
        let listeners = [];
        const rt = {
            listen(fn) { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn); }; },
            send(e) { sent.push(e); if (e.type === 'session.update') setTimeout(() => rt.emit({type: 'session.updated'}), 1); },
            close() { rt.closed = true; }, buffered: () => 0,
            emit: e => listeners.slice().forEach(f => f(e))
        };
        return rt;
    };
    let rt = makeRt();
    const emit = e => rt.emit(e);
    const connect = () => {
        connects++;
        if (connects > 1) rt = makeRt();
        return over.connect ? over.connect(connects, rt) : Promise.resolve(rt);
    };
    const jibo = {
        embodied: {speech: Object.assign({speak: (esml, opts, auto) => { said.push(esml); options.push(opts); rules.push(auto); return sleep(over.speakMs || 20); }, stop: () => { jibo.stopped = true; }}, over.speech || {})},
        jetstream: {setHotwordMode: () => ({activated: Promise.resolve(), release: () => { released++; }}), types: {HotwordListenMode: {Disabled: 2}},
            events: {skillSwitch: emitter(), globalTurnStarted: emitter()}},
        expression: Object.assign({setLEDColor: c => leds.push(c.join(','))}, over.expression || {}),
        animDB: over.animDB,
        privacyController: {enabled: false},
        face: {views: {forceEyeView: cb => { jibo.eye = true; cb(); }}},
        // Head touches, the action system's hold to quit (its global touchStop must stay unused),
        // the emotion system's petting query and who Jibo sees.
        system: {events: {touchOn: emitter()}},
        globalEvents: {touchStop: emitter()},
        action: over.action === undefined ? {holds: [], setHoldHeadToQuitDuration(ms) { this.holds.push(ms); }, resetHoldToQuitTime() { this.holds.push('reset'); }} : over.action,
        emotion: over.emotion, lps: over.lps, kb: over.kb
    };
    // Without an animation database (over.animDB) each clip is logged as `anim` with result 'missing',
    // so a test sees which clip played without waiting for one.
    const config = Object.assign({}, DEFAULTS, {apiKey: 'sk-test', silenceSeconds: 0.6, transcriptWaitMs: 120, echoTailMs: 10, expressionWaitMs: 60, greeting: 'Hi!', greetingExpression: 'none',
        emoji: false}, over.config || {});
    const classify = over.classify || ((person, line) => Promise.resolve({label: /dog|puppy/i.test(line) ? 'happy' : 'none', ms: 5}));
    const talk = new Conversation({jibo, config, instructions: 'be Jibo', sessionNote: over.note, connect, classify, diagnose: over.diagnose, notice: over.notice,
        mic: over.mic || {start: f => { onBlock = f; starts++; return Promise.resolve(); }, stop: () => { onBlock = null; }, label: 'arecord default', rate: 48000, kind: 'arecord'},
        log: {write: e => logs.push(e)}, actions: over.actions || null, resume: over.resume || null, heyJibo: over.heyJibo || null, openedAt: over.openedAt, startup: over.startup,
        random: over.random || (() => 0.5), version: over.version, now: over.now});
    // One known animation per mood (the catalogue's random pick has its own tests).
    if (!over.realChoose) talk.choose = label => !label || label === 'none' ? null : TEST_ANIM[label] || catalog.animFor(label);
    // A block of `samples` at 24 kHz (2048 ≈ 85 ms, one 48 kHz block of 4096 from the microphone).
    const audio = (level = -40, samples = 2048) => onBlock && onBlock(new Int16Array(samples), level);
    let starts = 0;
    const appends = () => sent.filter(e => e.type === 'input_audio_buffer.append').length;
    return {talk, get rt() { return rt; }, emit, jibo, said, options, rules, leds, logs, sent, audio, appends, released: () => released, starts: () => starts, connects: () => connects};
}
// The clips Noggin played (or tried to), as `name@line` (line null for a reaction or the greeting).
const clips = h => h.logs.filter(e => e.kind === 'anim').map(e => e.name + '@' + e.line);
async function untilListening(h) { for (let i = 0; i < 400 && h.talk.state !== 'listening'; i++) await sleep(5); assert.equal(h.talk.state, 'listening'); }
// A conversation, opened, once Jibo listens.
async function listening(over) {
    const h = harness(over);
    h.talk.open(); await untilListening(h);
    return h;
}
// The person stops speaking and their words are transcribed.
function youSay(h, words) {
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: words});
}
function reply(h, id, text, done = true) {
    h.emit({type: 'response.created', response: {id}});
    for (const w of text.match(/\S+\s*/g)) h.emit({type: 'response.output_text.delta', response_id: id, delta: w});
    if (done) h.emit({type: 'response.done', response: {id, status: 'completed', usage: {input_tokens: 800, output_tokens: 20}}});
}

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
    h.talk.leave('test'); await ended;
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
    h.talk.leave('test'); await ended;
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
    h.talk.leave('test'); await ended;
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

test('review: a fatal error during the greeting waits for it, then always says the cause (D76)', async () => {
    const h = harness({speakMs: 150});
    const ended = h.talk.open();
    while (h.said.length < 1) await sleep(2);
    h.emit({type: 'error', error: {code: 'insufficient_quota'}});
    assert.equal(await ended, 'trouble_no_credit');
    assert.equal(h.said[0], 'Hi!');
    assert.match(h.said.at(-1), /thinking money/);
    assert.ok(!h.jibo.stopped, 'the greeting was not cut off');
});

test('review: no reconnect while fail() runs (D76)', async () => {
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

test('review: a drop while a complete reply is spoken keeps the reply and listens after the reconnect (D76)', async () => {
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
    h.talk.leave('test'); await ended;
});

test('review: a drop while a done reply still waits for its transcript loses it and still listens again (D76)', async () => {
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
    h.talk.leave('test'); await ended;
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
    h3.talk.leave('test'); await ended3;
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
    h.talk.leave('test'); await ended;
    const back = harness({notice, resume: {pairs: [], tool: 'get_time', said: ''}, config: {comebackLine: 'Anything else?'}});
    const ended2 = back.talk.open(); await untilListening(back);
    assert.ok(!back.said.some(t => /money/.test(t)));
    back.talk.leave('test'); await ended2;
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

test('moods: each has a description; the smile and the dance are real animations', {skip: !fs.existsSync(ANIMDB) && 'no animdb.json here'}, () => {
    const anims = JSON.parse(fs.readFileSync(ANIMDB, 'utf8'));
    assert.equal(Object.keys(catalog.MOODS).length, 31);
    for (const [mood, when] of Object.entries(catalog.MOODS)) assert.ok(when.length > 5, mood + ' has a description');
    assert.ok(anims[catalog.EXTRA.smile] && !anims[catalog.EXTRA.smile].layers.Body && !anims[catalog.EXTRA.smile].hasAudio, 'eye-only, silent smile');
    assert.ok(anims[catalog.DANCE] && anims[catalog.DANCE].layers.Body, 'the dance');
    assert.equal(catalog.animFor('dance'), catalog.DANCE); assert.equal(catalog.animFor('smile'), 'eye_happy_00'); assert.equal(catalog.animFor('happy'), null);
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

test('a microphone stream of pure digital silence is restarted after micSilentMs while listening; repeated failure ends politely', async () => {
    const h = harness({config: {silenceSeconds: 20, micSilentMs: 1000}});
    const ended = h.talk.open(); await untilListening(h);
    assert.equal(h.starts(), 1);
    for (let i = 0; i < 11; i++) h.audio(-120);
    assert.equal(h.starts(), 1, 'under a second of zeros is fine');
    h.audio(-120); await sleep(350);
    assert.equal(h.starts(), 2, 'restarted after 1 s of zeros');
    assert.ok(h.logs.some(e => e.kind === 'microphone_silent' && e.restart === 1));
    h.audio(-55);
    assert.ok(h.logs.some(e => e.kind === 'microphone_ok'));
    for (let round = 0; round < 4; round++) { for (let i = 0; i < 12; i++) h.audio(-120); await sleep(350); }
    assert.equal(await ended, 'microphone_silent');
    assert.match(h.said.at(-1), /can't hear anything/);
});

test('zeros while Jibo speaks never restart the microphone; zeros that clear by themselves are logged', async () => {
    const h = await listening({config: {silenceSeconds: 20, micSilentMs: 1000}});
    h.talk.state = 'speaking';
    for (let i = 0; i < 40; i++) h.audio(-120);
    h.talk.listen();
    for (let i = 0; i < 5; i++) h.audio(-120);
    h.audio(-50);
    await sleep(50);
    assert.equal(h.starts(), 1, 'no restart');
    const cleared = h.logs.find(e => e.kind === 'microphone_zeros_cleared');
    assert.ok(cleared && cleared.ms > 400 && cleared.ms < 450, 'only the zeros while listening count: ' + JSON.stringify(cleared));
    h.audio(-120); h.audio(-50);
    assert.equal(h.logs.filter(e => e.kind === 'microphone_zeros_cleared').length, 1, 'a short gap later in listening is not logged');
    h.talk.close();
});

test('the arecord process ending is logged and restarted; repeated exits end politely', async () => {
    const h = harness({config: {silenceSeconds: 20}});
    const ended = h.talk.open(); await untilListening(h);
    h.talk.onMicExit({code: null, signal: 'SIGABRT', stderr: "pcm.c:2759: snd_pcm_area_copy: Assertion failed."});
    await sleep(350);
    assert.equal(h.starts(), 2);
    const exit = h.logs.find(e => e.kind === 'microphone_exit');
    assert.equal(exit.signal, 'SIGABRT'); assert.match(exit.stderr, /Assertion/);
    assert.ok(h.logs.some(e => e.kind === 'microphone_restarted'));
    h.audio(-50);
    for (let round = 0; round < 4; round++) { h.talk.onMicExit({code: 1, signal: null, stderr: ''}); await sleep(350); }
    assert.equal(await ended, 'microphone_failed');
    assert.match(h.said.at(-1), /can't hear anything/);
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

// ---- the arecord microphone ----
function fakeSpawn() {
    const calls = [];
    const spawn = (command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = signal => { child.killed = signal; };
        calls.push({command, args, options, child});
        return child;
    };
    return {spawn, calls};
}
function pcmBytes(values) { const b = Buffer.alloc(values.length * 2); values.forEach((v, i) => b.writeInt16LE(v, i * 2)); return b; }

test('arecord microphone: 48 kHz S16 from the process, reframed across odd chunk edges into 24 kHz blocks', async () => {
    const {spawn, calls} = fakeSpawn(), blocks = [];
    const mic = new Microphone.ProcessMicrophone({device: 'MediaIn', spawn});
    const started = mic.start((pcm, level) => blocks.push({pcm, level}));
    const call = calls[0];
    assert.equal(call.command, '/usr/bin/arecord');
    assert.deepEqual(call.args, ['-D', 'MediaIn', '-f', 'S16_LE', '-r', '48000', '-c', '1', '-t', 'raw', '-q', '-']);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    const bytes = pcmBytes(new Array(4096 * 2).fill(16384));
    // 3 uneven pieces, the first ending in the middle of a sample.
    call.child.stdout.emit('data', bytes.slice(0, 5001));
    await started;
    call.child.stdout.emit('data', bytes.slice(5001, 9000));
    call.child.stdout.emit('data', bytes.slice(9000));
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].pcm.length, 2048);
    assert.ok(blocks.every(b => b.pcm.every(v => v === 16384)), 'no sample lost or corrupted at the chunk edges');
    assert.ok(Math.abs(blocks[0].level - 20 * Math.log10(0.5)) < 0.1);
    assert.equal(mic.label, 'arecord MediaIn'); assert.equal(mic.kind, 'arecord');
    mic.stop();
    assert.equal(call.child.killed, 'SIGTERM');
    call.child.emit('exit', null, 'SIGTERM');
});

test('arecord microphone: an unexpected exit is reported with stderr; one before any audio fails the start', async () => {
    const {spawn, calls} = fakeSpawn(), exits = [];
    const mic = new Microphone.ProcessMicrophone({spawn, onExit: r => exits.push(r)});
    const started = mic.start(() => {});
    calls[0].child.stdout.emit('data', pcmBytes([1, 2]));
    await started;
    calls[0].child.stderr.emit('data', Buffer.from("arecord: pcm.c:2759: snd_pcm_area_copy: Assertion `dst < src' failed.\n"));
    calls[0].child.emit('exit', null, 'SIGABRT');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].signal, 'SIGABRT'); assert.match(exits[0].stderr, /snd_pcm_area_copy/);

    const failing = mic.start(() => {});
    calls[1].child.stderr.emit('data', Buffer.from('arecord: main:828: audio open error: No such file or directory'));
    calls[1].child.emit('exit', 1, null);
    await assert.rejects(failing, /audio open error/);
    assert.equal(exits.length, 1, 'a failed start is not an exit');
    await assert.rejects(new Microphone.ProcessMicrophone({spawn, device: 'x; rm -rf /'}).start(() => {}), /not allowed/);
    const silent = new Microphone.ProcessMicrophone({spawn, startTimeoutMs: 30}).start(() => {});
    await assert.rejects(silent, /no audio within/);
    assert.equal(calls.at(-1).child.killed, 'SIGTERM', 'a start that timed out kills its process');
});

test('microphone choice: arecord on the robot, Web Audio elsewhere, or as set', () => {
    const robot = {existsSync: p => p === '/usr/bin/arecord' || p === '/opt/jibo/Jibo/Skills'}, sim = {existsSync: () => false};
    assert.equal(Microphone.choose({micSource: 'auto'}, robot), 'arecord');
    assert.equal(Microphone.choose({micSource: 'auto'}, sim), 'webaudio');
    assert.equal(Microphone.choose({micSource: 'webaudio'}, robot), 'webaudio');
    assert.equal(Microphone.choose({micSource: 'arecord'}, sim), 'arecord');
});

test('the classifier is warmed at the start and after a quiet spell', async () => {
    let warmed = 0;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => { warmed++; return Promise.resolve(); };
    const h = await listening({classify});
    assert.equal(warmed, 1);
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.equal(warmed, 1, 'not again right away');
    h.talk.lastClassify -= 30000;
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.equal(warmed, 1, 'half a minute of quiet is not enough: OpenAI stays quick for minutes (D93)');
    h.talk.lastClassify -= 200000;
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.equal(warmed, 2);
    h.talk.close();
});

test('the classifier warm starts while the realtime session is still connecting, once (D93)', async () => {
    let warmed = 0, release;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => { warmed++; return Promise.resolve(); };
    const h = harness({classify, connect: (n, rt) => new Promise(resolve => { release = () => resolve(rt); })});
    h.talk.open();
    await sleep(60);
    assert.equal(warmed, 1, 'asked before the session exists');
    assert.notEqual(h.talk.state, 'listening');
    assert.deepEqual(h.said, ['Hi!'], 'the greeting does not wait for it');
    release(); await untilListening(h);
    assert.equal(warmed, 1, 'not again when the session is ready');
    h.talk.close();
});

test('the warm asks the reaction and two line questions at once with the real choices; a refused API is reported, not replaced (D93, D179)', async () => {
    const config = Object.assign({}, DEFAULTS, {apiKey: 'sk'});
    const sent = [];
    const answer = {answers: [{type: 'choice', name: 'expression', choice: 'none', confidence: 0.9}, {type: 'choice', name: 'size', choice: 'small', confidence: 0.7}]};
    const classify = openai.classifier(config, (route, body) => { sent.push({route, body}); return Promise.resolve({status: 200, ms: 40, json: answer, conn: {socket: sent.length}}); });
    const warming = classify.warm();
    assert.equal(sent.length, 3, 'all three go out before any answer');
    const result = await warming;
    assert.deepEqual(result.requests.map(r => r.kind), ['reaction', 'line', 'line']);
    assert.ok(sent.every(s => s.route === '/decisions'));
    const choicesOf = body => body.questions[0].choices.map(c => c.value);
    assert.deepEqual(choicesOf(sent[0].body), labels.choices('reaction').map(c => c.value));
    assert.deepEqual(choicesOf(sent[1].body), labels.choices('line').map(c => c.value));
    assert.notEqual(sent[1].body.input, sent[2].body.input, 'two different lines');
    assert.equal(sent[0].body.questions.length, 2, 'with the size question, as a real turn');
    assert.deepEqual(result.requests.map(r => r.conn.socket), [1, 2, 3]);
    // The account cannot use Decisions: the warm shows the error and nothing else is asked.
    const routes = [];
    const refused = openai.classifier(config, (route, body) => {
        routes.push(route);
        return Promise.resolve({status: 403, ms: 30, json: {error: {code: 'not_enabled'}}});
    });
    const warmed = await refused.warm();
    assert.ok(warmed.requests.every(r => r.label === null && r.error === 'not_enabled' && !r.switched), JSON.stringify(warmed));
    routes.length = 0;
    await refused('x', 'y', 'line');
    assert.deepEqual(routes, ['/decisions']);
    // No warm when Responses is chosen.
    const plain = openai.classifier(Object.assign({}, config, {classifierApi: 'responses'}), () => { throw Error('nothing should be sent'); });
    assert.equal(await plain.warm(), null);
    // A failing request is reported, not thrown.
    const broken = openai.classifier(config, () => Promise.reject(Error('boom')));
    assert.ok((await broken.warm()).requests.every(r => r.error === 'boom'));
});

test('a switch during the warm is logged once, however many requests switched (D93)', async () => {
    const classify = () => Promise.resolve({label: 'none'});
    const switched = 'size question refused (HTTP 400), now without it';
    classify.warm = () => Promise.resolve({ms: 900, requests: [{kind: 'reaction', ms: 400, switched}, {kind: 'line', ms: 300, switched}, {kind: 'line', ms: 310, switched}]});
    const h = await listening({classify}); await sleep(5);
    assert.equal(h.logs.filter(e => e.kind === 'classifier_warm').length, 1);
    const entries = h.logs.filter(e => e.kind === 'classifier_switch');
    assert.equal(entries.length, 1);
    assert.match(entries[0].detail, /now without it/);
    h.talk.close();
});

test('a warm that ends after the conversation closed writes nothing and throws nothing (D93)', async () => {
    let finish;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => new Promise(resolve => { finish = resolve; });
    const h = await listening({classify});
    assert.equal(typeof finish, 'function', 'the warm was asked');
    h.talk.close();
    finish({ms: 900, requests: [{kind: 'reaction', ms: 400, switched: 'decisions failed (x), now y'}]});
    await sleep(10);
    assert.equal(h.logs.filter(e => e.kind === 'classifier_warm' || e.kind === 'classifier_switch' || e.kind === 'exception').length, 0);
});

test('a conversation that closes before the eye view shows never starts the warm (D93)', async () => {
    let warmed = 0, showEye;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => { warmed++; return Promise.resolve(); };
    const h = harness({classify});
    h.jibo.face.views.forceEyeView = cb => { showEye = cb; };
    h.talk.open();
    await sleep(20);
    h.talk.close();
    showEye();
    await sleep(20);
    assert.equal(warmed, 0);
});

// ---- actions ----
// A reply with text (optional) and function calls, as response.done carries them.
function callReply(h, id, text, calls) {
    h.emit({type: 'response.created', response: {id}});
    if (text) for (const w of text.match(/\S+\s*/g)) h.emit({type: 'response.output_text.delta', response_id: id, delta: w});
    h.emit({type: 'response.done', response: {id, status: 'completed', output: calls.map(([name, args, callId]) =>
        ({type: 'function_call', name, call_id: callId || 'call_' + name, arguments: JSON.stringify(args || {})}))}});
}
function fakeActions(over = {}) {
    const a = {redirects: [], handovers: [], failed: 0,
        redirect: over.redirect || ((pkg, options) => { a.redirects.push([pkg, options]); }),
        handover: state => a.handovers.push(state),
        handoverFailed: () => { a.failed++; },
        readClock: over.readClock || (() => Promise.resolve({timer: {set: true, remaining_s: 300, remaining: '5 minutes', length_s: 600}, alarm: {set: false}})),
        setVolume: over.setVolume || (args => { a.volume = args; return {ok: true, volume: args.level || 7, of: 10}; }),
        installed: over.installed || (() => true),
        localTime: () => ({year: 2026, monthNum: 10, date: 13, dayOfWeek: 'Friday', hour: 15, minute: 7, zone: 'Europe/Amsterdam'}),
        facts: over.facts || (() => '- Movies: Wall-E.'),
        memory: over.memory || null};
    return a;
}
async function until(fn, ms = 2000) { for (let i = 0; i < ms / 5 && !fn(); i++) await sleep(5); assert.ok(fn(), 'condition not reached'); }
test('actions: tools go in session.update, open_app with the built-in apps and the openApps setting\'s extras; no tools without actions', async () => {
    const h = await listening({actions: fakeActions(), config: {cloudSkills: [], openApps: {stargazer: '@be/stargazer', bad: 'rm -rf'}}});
    const session = h.sent.find(e => e.type === 'session.update').session;
    assert.equal(session.tool_choice, 'auto');
    assert.deepEqual(session.tools.map(t => t.name), ['get_time', 'about_jibo', 'dance', 'set_volume', 'check_clock', 'set_timer', 'cancel_timer',
        'set_alarm', 'cancel_alarm', 'use_skill', 'play_music', 'play_radio', 'open_app', 'go_to_sleep', 'look_away', 'remember', 'forget', 'recall']);
    assert.deepEqual(session.tools.find(t => t.name === 'open_app').parameters.properties.name.enum, ['clock', 'settings', 'menu', 'gallery', 'yoga', 'meet someone new', 'stargazer']);
    h.talk.close();
    const plain = await listening();
    assert.equal(plain.sent.find(e => e.type === 'session.update').session.tools, undefined);
    plain.talk.close();
});

test('about_jibo runs in Noggin: FACTS.md goes back as the result, then the follow-up is spoken', async () => {
    const h = await listening({actions: fakeActions()});
    await youSay(h, 'what is your favorite movie');
    callReply(h, 'r1', '', [['about_jibo', {}, 'f1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const output = h.sent.find(e => e.type === 'conversation.item.create' && e.item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(output.item.output), {ok: true, facts: '- Movies: Wall-E.'});
    reply(h, 'r2', 'Wall-E! A robot with a big heart.');
    await untilListening(h);
    assert.deepEqual(h.said.slice(-2), ['Wall-E!', 'A robot with a big heart.']);
    h.talk.close();
    const empty = await listening({actions: fakeActions({facts: () => ''})});
    await youSay(empty, 'what is your favorite movie');
    callReply(empty, 'r1', '', [['about_jibo', {}, 'f1']]);
    await until(() => empty.sent.some(e => e.type === 'response.create'));
    assert.equal(JSON.parse(empty.sent.find(e => e.item && e.item.type === 'function_call_output').item.output).ok, false);
    empty.talk.close();
});

test('remember runs in Noggin: the memory runner gets the parsed fact, its result goes back; a thrown error is a plain failure', async () => {
    const calls = [];
    const h = await listening({actions: fakeActions({memory: args => { calls.push(args); return {ok: true, saved: 'Sam likes jazz.'}; }})});
    await youSay(h, 'remember that I am Sam and I like jazz');
    callReply(h, 'r1', '', [['remember', {text: 'Sam likes jazz', expires: 'soon'}, 'm1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.deepEqual(calls, [{op: 'remember', text: 'Sam likes jazz'}]);
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.type === 'function_call_output').item.output), {ok: true, saved: 'Sam likes jazz.'});
    h.talk.close();
    const broken = await listening({actions: fakeActions({memory: () => { throw Error('EROFS'); }})});
    await youSay(broken, 'what did we talk about last week');
    callReply(broken, 'r1', '', [['recall', {query: 'last week'}, 'm1']]);
    await until(() => broken.sent.some(e => e.type === 'response.create'));
    const out = JSON.parse(broken.sent.find(e => e.item && e.item.type === 'function_call_output').item.output);
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.error, /EROFS/);
    broken.talk.close();
});

test('instructions with memory: the notes go in the session note, the "no saved memory" line goes, tools named only when offered', () => {
    const now = new Date(2026, 10, 19, 19, 30), block = 'What you remember ... Facts:\n- Sam likes jazz.';
    const off = realtime.instructions('S', 'I', {apps: [], config: {memory: false}});
    assert.match(off, /no tools, files or saved memory/);
    const on = realtime.instructions('S', 'I', {apps: [], config: {memory: true}}, {learn: true, block});
    assert.ok(!on.includes(block), 'the instructions never carry the memory (D181)');
    const note = realtime.sessionNote(now, {learn: true, block});
    assert.ok(note.endsWith('\n\n' + block));
    assert.match(on, /the notes in the session note at the start of the conversation/);
    assert.ok(!realtime.sessionNote(now, null).includes('\n'), 'memory off: the time alone');
    assert.doesNotMatch(on, /saved memory/);
    assert.match(on, /never claim to remember something that is not in them/);
    assert.match(on, /After each conversation you keep a short note/);
    assert.match(on, /use remember or forget; for an earlier conversation your notes do not cover, use recall/);
    const noTools = realtime.instructions('S', 'I', null, {learn: false, block});
    assert.match(noTools, /You cannot keep anything new yourself/);
    assert.doesNotMatch(noTools, /use recall/);
    // The instructions are the same text in every conversation, whatever the time or memory (D181).
    assert.equal(realtime.instructions('S', 'I', null, {learn: true, block}), realtime.instructions('S', 'I', null, {learn: true, block: 'other'}));
});

test('get_time hands over to Jibo\'s clock: no words first, the clock face for the time, the calendar for the date; Noggin comes back', async () => {
    for (const [show, intent] of [['time', 'askForTime'], ['date', 'askForDate']]) {
        const acts = fakeActions();
        const h = harness({actions: acts});
        const ended = h.talk.open(); await untilListening(h);
        const before = h.said.length;
        await youSay(h, show === 'time' ? 'what time is it' : 'what day is it today');
        callReply(h, 'r1', '', [['get_time', {show}, 'c1']]);
        await until(() => acts.redirects.length === 1);
        assert.deepEqual(acts.redirects[0], ['@be/clock', {nlu: {intent, entities: {domain: 'clock'}}, match: {skipSurprises: true}}]);
        assert.equal(h.said.length, before, 'Jibo says nothing first: the clock says it');
        assert.equal(acts.handovers[0].comeback, true); assert.deepEqual(acts.handovers[0].args, {show});
        h.talk.close('closed');   // Be closes Noggin for the clock
        assert.equal(await ended, 'handover');
    }
});

test('get_time when the clock does not open: the result carries the time, so the model can still say it', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts, config: {actionTimeoutMs: 80}});
    await youSay(h, 'what time is it');
    callReply(h, 'r1', '', [['get_time', {show: 'time'}, 'c1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const output = h.sent.find(e => e.type === 'conversation.item.create' && e.item.call_id === 'c1');
    assert.deepEqual(JSON.parse(output.item.output), {ok: false, error: 'the clock did not open', time: '3:07 PM', date: 'Friday, November 13, 2026', note: 'say it yourself'});
    reply(h, 'r2', "It's seven past three.");
    await untilListening(h);
    assert.equal(h.said.at(-1), "It's seven past three.");
    h.talk.close();
});

test('back after the clock showed the time: the note says your clock took over, with no timer facts', async () => {
    const h = harness({actions: fakeActions(), resume: {pairs: [{you: 'what time is it', jibo: ''}], tool: 'get_time', args: {show: 'time'}, said: "It's 3:07."}});
    h.talk.open();
    await untilListening(h);
    const note = h.sent.find(e => e.type === 'conversation.item.create').item.content[0].text;
    assert.match(note, /you used get_time \(the time\) and your clock took over\. Your clock said: "It's 3:07\."/);
    assert.doesNotMatch(note, /timer|alarm/);
    h.talk.close();
});
const DANCE_NAMES = new Set(Object.values(catalog.DANCES).flatMap(d => d.list.map(a => a.n)));
const dancesIn = style => catalog.DANCES[style].list.map(a => a.n);
const playedDances = h => h.said.map(e => (/<anim name='([^']+)' endNeutral='true'\/>$/.exec(e) || [])[1]).filter(n => DANCE_NAMES.has(n));
const danceOutput = h => JSON.parse(h.sent.filter(e => e.type === 'conversation.item.create' && e.item.type === 'function_call_output').at(-1).item.output);
// One dance turn: the person's words, the model's dance call, and its "That was fun!" afterwards.
async function danceTurn(h, words, n) {
    await youSay(h, words);
    callReply(h, 'd' + n, '', [['dance', {}, 'call_dance_' + n]]);
    await until(() => h.sent.filter(e => e.type === 'response.create').length >= n);
    reply(h, 'f' + n, 'That was fun!');
    await untilListening(h);
}

test('dance runs in Noggin with a dance with music; the reply after it never dances again', async () => {
    const h = await listening({actions: fakeActions(), classify: () => Promise.resolve({label: 'dance'})});
    await danceTurn(h, 'can you dance for me', 1);
    assert.equal(playedDances(h).length, 1);
    assert.equal(h.said.at(-1), 'That was fun!', 'no dance expression on the line');
    const log = h.logs.find(e => e.kind === 'speak' && e.from);
    assert.equal(log.from, 'random'); assert.ok(catalog.danceStyles(log.anim).includes(log.dance));
    assert.equal(danceOutput(h).done, 'Jibo danced'); assert.match(danceOutput(h).dance, /^(a|the) /);
    h.talk.close();
});

test('dance: the style the person names, "again" replays it, otherwise no repeat of the last three', async () => {
    const h = await listening({actions: fakeActions()});
    await danceTurn(h, 'Jibo, do the robot!', 1);
    const robot = playedDances(h)[0];
    assert.ok(dancesIn('robot').includes(robot));
    assert.equal(danceOutput(h).dance, 'the robot');
    await danceTurn(h, 'do that again', 2);
    assert.equal(playedDances(h)[1], robot, 'again: the same dance');
    assert.equal(h.logs.filter(e => e.kind === 'speak' && e.from).at(-1).from, 'again');
    await danceTurn(h, 'another one please', 3);
    await danceTurn(h, 'and another dance', 4);
    const played = playedDances(h);
    assert.equal(new Set(played.slice(1)).size, 3, 'none of the last three again: ' + played.join(', '));
    await danceTurn(h, 'a slow dance', 5);
    assert.ok(dancesIn('slow').includes(playedDances(h)[4]));
    assert.ok(!h.said.some(e => /Robot mode|robot dance!/.test(e)), 'random 0.5: nothing announced');
    h.talk.close();
});

test('dance: no transcript in time means a random dance, never the previous turn\'s words', async () => {
    const h = await listening({actions: fakeActions(), random: () => 0});
    await danceTurn(h, 'do the robot', 1);
    h.emit({type: 'input_audio_buffer.speech_stopped'});   // no transcript this time
    callReply(h, 'd2', '', [['dance', {}, 'call_dance_2']]);
    await until(() => h.sent.filter(e => e.type === 'response.create').length >= 2);
    assert.equal(h.logs.filter(e => e.kind === 'speak' && e.from).at(-1).from, 'random');
    h.talk.close();
});

test('danceAnnounce: always names the dance first and tells the model; off never', async () => {
    const h = await listening({actions: fakeActions(), config: {danceAnnounce: 'always'}});
    await danceTurn(h, 'do the robot', 1);
    // ONE speak: the words, then the dance. Two speaks (the line, then the dance 6 ms later) cut the
    // dance to about half a second on the robot and in the sim.
    const spoken = h.said.filter(e => /Robot mode/.test(e) || DANCE_NAMES.has((/name='([^']+)'/.exec(e) || [])[1]));
    assert.equal(spoken.length, 1, h.said.join(' | '));
    assert.match(spoken[0], /^Robot mode: on! <anim name='[A-Za-z0-9_]+' endNeutral='true'\/>$/, 'random 0.5: the second robot line, then the dance');
    assert.match(danceOutput(h).announced, /do not name it again/);
    h.talk.close();
    const off = await listening({actions: fakeActions(), config: {danceAnnounce: 'off'}, random: () => 0});
    await danceTurn(off, 'dance for me', 1);
    assert.equal(off.said.filter(e => !/^</.test(e)).join('|'), 'Hi!|That was fun!');
    assert.equal(danceOutput(off).announced, undefined);
    off.talk.close();
});

test('dance without actions: the line\'s dance expression follows the person\'s words too', async () => {
    const h = await listening({config: {actions: false}, classify: () => Promise.resolve({label: 'dance'})});
    await youSay(h, 'can you do a twerk dance');  // without actions a dance needs the word "dance" (ExpressionPolicy)
    reply(h, 'r1', 'Watch this!');
    await untilListening(h);
    assert.ok(dancesIn('twerk').includes(playedDances(h)[0]), h.said.join(' | '));
    h.talk.close();
});

test('danceChoice, pickDance and danceAnnounce', () => {
    assert.deepEqual(catalog.danceChoice('Can you do the robot?'), {style: 'robot'});
    assert.deepEqual(catalog.danceChoice('Jibo, can you twerk'), {style: 'twerk'});
    assert.deepEqual(catalog.danceChoice('do a slow dance'), {style: 'slow'});
    assert.deepEqual(catalog.danceChoice('show me your belly dance'), {style: 'belly'});
    assert.deepEqual(catalog.danceChoice('Again!'), {again: true});
    assert.deepEqual(catalog.danceChoice('one more time'), {again: true});
    assert.deepEqual(catalog.danceChoice('do the robot again'), {again: true, style: 'robot'});
    assert.deepEqual(catalog.danceChoice('another one'), {});
    assert.deepEqual(catalog.danceChoice('dance for me'), {});
    assert.deepEqual(catalog.danceChoice('dance around the house'), {}, '"house" alone is no style');
    assert.deepEqual(catalog.danceChoice('a robotic funk dance', () => 0), {style: 'funk'}, 'two styles: one at random');
    assert.deepEqual(catalog.danceChoice('a robotic funk dance', () => 0.99), {style: 'robot'});
    assert.deepEqual(catalog.danceChoice(null), {});
    assert.equal(catalog.pickDance('waltz', {recent: ['Waltz_01_01']}), 'Waltz_01_01', 'the only one: even if recent');
    const robots = dancesIn('robot');
    assert.equal(catalog.pickDance('robot', {recent: robots.slice(1)}), robots[0]);
    assert.ok(DANCE_NAMES.has(catalog.pickDance(null)) && DANCE_NAMES.has(catalog.pickDance('nonsense')));
    assert.equal(catalog.danceName('robot'), 'the robot'); assert.equal(catalog.danceName(null), 'a dance');
    assert.ok(Object.keys(catalog.DANCES).every(style => catalog.danceLine(style, () => 0) && !/[<>&]/.test(catalog.danceLine(style, () => 0.99))));
    assert.equal(catalog.danceAnnounce('always', 'keyword', 0), true);
    assert.equal(catalog.danceAnnounce('off', 'random', 9, () => 0), false);
    assert.equal(catalog.danceAnnounce('sometimes', 'random', Infinity, () => 0.1), true);
    assert.equal(catalog.danceAnnounce('sometimes', 'random', Infinity, () => 0.5), false, 'about one in three');
    assert.equal(catalog.danceAnnounce('sometimes', 'keyword', Infinity, () => 0), false, 'not when the person named the style');
    assert.equal(catalog.danceAnnounce('sometimes', 'random', 2, () => 0), false, 'not twice within three dances');
});

test('dance catalogue: 28 dances with music in 12 styles, each a real dance with its own music', {skip: !fs.existsSync(ANIMDB) && 'no animdb.json here'}, () => {
    const anims = JSON.parse(fs.readFileSync(ANIMDB, 'utf8'));
    const withMusic = Object.values(anims).filter(a => a.categories.includes('dance') && a.hasAudio).map(a => a.name);
    assert.deepEqual([...DANCE_NAMES].sort(), withMusic.sort());
    assert.equal(Object.keys(catalog.DANCES).length, 12);
});

test('set_timer: Jibo says "Okay!", then hands over to the clock with its NLU; Noggin ends as a handover', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts});
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'set a timer for ten minutes');
    callReply(h, 'r1', 'Okay!', [['set_timer', {minutes: 10}]]);
    await until(() => acts.redirects.length === 1);
    assert.equal(h.said.at(-1), 'Okay!');
    assert.deepEqual(acts.redirects[0], ['@be/clock', {nlu: {intent: 'start', entities: {domain: 'timer', hours: '0', minutes: '10', seconds: 'null', time: 'null', ampm: 'null'}}, match: {skipSurprises: true}}]);
    assert.equal(acts.handovers[0].tool, 'set_timer');
    assert.equal(acts.handovers[0].comeback, true);
    assert.deepEqual(acts.handovers[0].args, {seconds: 600, duration: '10 minutes'});
    assert.deepEqual(acts.handovers[0].pairs, [{you: 'set a timer for ten minutes', jibo: 'Okay!'}]);
    assert.equal(h.talk.state, 'handover');
    h.talk.close('closed');   // Be closes Noggin for the clock
    assert.equal(await ended, 'handover');
    assert.ok(h.logs.some(e => e.kind === 'session_end' && e.reason === 'handover'));
});

test('a handover that does not happen in time: the model hears it failed and the conversation goes on', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts, config: {actionTimeoutMs: 80}});
    await youSay(h, 'cancel my timer');
    callReply(h, 'r1', '', [['cancel_timer', {}, 'c9']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.equal(acts.failed, 1);
    const output = h.sent.find(e => e.type === 'conversation.item.create' && e.item.call_id === 'c9');
    assert.deepEqual(JSON.parse(output.item.output), {ok: false, error: 'the clock did not open'});
    reply(h, 'r2', "Hmm, my clock didn't open.");
    await untilListening(h);
    h.talk.close();
});

test('bad timer arguments and unknown tools come back as errors, without a handover', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'set a timer for three seconds');
    callReply(h, 'r1', '', [['set_timer', {seconds: 3}, 'a'], ['format_disk', {}, 'b']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const outputs = h.sent.filter(e => e.type === 'conversation.item.create').map(e => JSON.parse(e.item.output));
    assert.deepEqual(outputs, [{ok: false, error: 'a timer must be longer than 5 seconds'}, {ok: false, error: 'unknown tool format_disk'}]);
    assert.equal(acts.redirects.length, 0);
    h.talk.close();
});

test('check_clock reads the clock in Noggin; if it cannot, the clock answers instead', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'how long is left on my timer');
    callReply(h, 'r1', '', [['check_clock']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const out = JSON.parse(h.sent.find(e => e.type === 'conversation.item.create').item.output);
    assert.equal(out.timer.remaining, '5 minutes'); assert.deepEqual(out.alarm, {set: false});
    h.talk.close();
    const blind = fakeActions({readClock: () => Promise.resolve(null)});
    const g = await listening({actions: blind});
    await youSay(g, 'how long is left on my timer');
    callReply(g, 'r1', '', [['check_clock']]);
    await until(() => blind.redirects.length === 1);
    assert.deepEqual(blind.redirects[0][1].nlu, {intent: 'query', entities: {domain: 'timer'}});
    g.talk.close();
});

test('open_app: only listed apps; Noggin comes back afterwards, like use_skill', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts, config: {openApps: {recipes: {pkg: '@be/recipe', about: 'Recipes to cook along with'}}}});
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'open recipes');
    callReply(h, 'r1', '', [['open_app', {name: 'Recipes'}]]);
    await until(() => acts.redirects.length === 1);
    assert.deepEqual(acts.redirects[0], ['@be/recipe', {nlu: {intent: 'menu', entities: {domain: '@be/recipe'}}, match: {skipSurprises: true}}]);
    assert.equal(acts.handovers[0].comeback, true);
    assert.deepEqual(acts.handovers[0].args, {name: 'recipes'});
    h.jibo.jetstream.events.skillSwitch.fire();
    assert.equal(await ended, 'handover');
    // Back: the model hears it opened the app, by name.
    assert.match(realtime.resumeNote({tool: 'open_app', args: {name: 'recipes'}, pairs: []}, null, 'Anything else?'), /Then you used open_app \(recipes\) and that app took over/);
});

test('cancel_timer / cancel_alarm: nothing set in the clock\'s record means no handover; the model says so', async () => {
    const acts = fakeActions({readClock: () => Promise.resolve({timer: {set: false}, alarm: {set: false}})});
    const h = await listening({actions: acts});
    await youSay(h, 'cancel my alarm');
    callReply(h, 'r1', '', [['cancel_alarm', {}, 'x1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 'x1').item.output), {ok: true, cancelled: false, note: 'no alarm is set'});
    assert.equal(acts.redirects.length, 0);
    h.talk.close();
    // An alarm is set: the clock cancels it and Noggin comes back.
    const set = fakeActions({readClock: () => Promise.resolve({timer: {set: false}, alarm: {set: true, time: '7:30 AM', day: 'Saturday'}})});
    const g = await listening({actions: set});
    await youSay(g, 'cancel my alarm');
    callReply(g, 'r1', '', [['cancel_alarm']]);
    await until(() => set.redirects.length === 1);
    assert.deepEqual(set.redirects[0], ['@be/clock', {nlu: {intent: 'stop', entities: {domain: 'alarm'}}, match: {skipSurprises: true}}]);
    assert.equal(set.handovers[0].tool, 'cancel_alarm'); assert.equal(set.handovers[0].comeback, true);
    g.talk.close();
});

test('set_alarm hands over to the clock with a 12-hour time and upper-case AM/PM, and comes back', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'wake me at half past seven tonight');
    callReply(h, 'r1', '', [['set_alarm', {hour: 19, minute: 30}]]);
    await until(() => acts.redirects.length === 1);
    assert.deepEqual(acts.redirects[0][1].nlu, {intent: 'set', entities: {domain: 'alarm', time: '7:30', ampm: 'PM', hours: 'null', minutes: 'null', seconds: 'null'}});
    assert.deepEqual(acts.handovers[0].args, {time: '7:30 PM'});
    assert.equal(acts.handovers[0].comeback, true);
    h.talk.close();
});

test('set_volume runs in Noggin; the result goes back to the model', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'turn your volume to three');
    callReply(h, 'r1', '', [['set_volume', {level: 3}, 'v']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.deepEqual(acts.volume, {level: 3});
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 'v').item.output), {ok: true, volume: 3, of: 10});
    h.talk.close();
});

test('use_skill hands over and comes back; play_music and play_radio leave', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'play word of the day');
    callReply(h, 'r1', '', [['use_skill', {name: 'word of the day'}]]);
    await until(() => acts.redirects.length === 1);
    assert.deepEqual(acts.redirects[0], ['@be/word-of-the-day', {nlu: {intent: 'play', entities: {domain: 'word-of-the-day'}}, match: {skipSurprises: true}}]);
    assert.equal(acts.handovers[0].comeback, true);
    h.talk.close();
    const music = fakeActions();
    const g = harness({actions: music});
    const ended = g.talk.open(); await untilListening(g);
    await youSay(g, 'play bohemian rhapsody by queen');
    callReply(g, 'r1', 'Enjoy!', [['play_music', {song: 'Bohemian Rhapsody', artist: 'Queen'}]]);
    await until(() => music.redirects.length === 1);
    assert.deepEqual(music.redirects[0], ['@be/music', {nlu: {intent: 'playSong', entities: {domain: 'music', query: 'Bohemian Rhapsody', artist: 'Queen'}}, match: {skipSurprises: true}}]);
    assert.equal(music.handovers[0].comeback, false);
    g.jibo.jetstream.events.skillSwitch.fire();
    assert.equal(await ended, 'leaves', 'music ends the conversation');
});

test('go_to_sleep and look_away leave for @be/idle with the intent Jibo\'s own commands carry', async () => {
    for (const [name, intent] of [['go_to_sleep', 'sleep'], ['look_away', 'turnAway']]) {
        const acts = fakeActions();
        const h = harness({actions: acts});
        const ended = h.talk.open(); await untilListening(h);
        await youSay(h, 'please ' + name.replace(/_/g, ' '));
        callReply(h, 'r1', 'Goodnight!', [[name, {}]]);
        await until(() => acts.redirects.length === 1);
        assert.deepEqual(acts.redirects[0], ['@be/idle', {nlu: {intent: intent, entities: {domain: 'idle'}}, match: {skipSurprises: true}}]);
        assert.equal(acts.handovers[0].comeback, false);
        h.jibo.jetstream.events.skillSwitch.fire();
        assert.equal(await ended, 'leaves', name + ' ends the conversation');
    }
});

test('open_app: an extra app that is not installed fails at once, without waiting for the timeout', async () => {
    const acts = fakeActions({installed: pkg => pkg !== '@be/stargazer'});
    const h = await listening({actions: acts, config: {openApps: {stargazer: '@be/stargazer'}, actionTimeoutMs: 60000}});
    await youSay(h, 'open stargazer');
    const asked = Date.now();
    callReply(h, 'r1', '', [['open_app', {name: 'stargazer'}, 's']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.ok(Date.now() - asked < 1000);
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 's').item.output), {ok: false, error: 'that app is not installed on Jibo'});
    assert.equal(acts.redirects.length, 0); assert.equal(acts.failed, 1);
    h.talk.close();
    // Built-in apps are part of Jibo: no check.
    const builtin = fakeActions({installed: () => false});
    const g = await listening({actions: builtin});
    await youSay(g, 'open the gallery');
    callReply(g, 'r1', 'Bye!', [['open_app', {name: 'gallery'}]]);
    await until(() => builtin.redirects.length === 1);
    assert.equal(builtin.redirects[0][0], '@be/gallery');
    g.talk.close();
});

test('back after another skill: the note names that skill, with no clock facts', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts, resume: {pairs: [{you: 'take a picture', jibo: ''}], tool: 'use_skill', args: {name: 'take a photo'}, said: 'Get ready. Three. two. one.'}});
    h.talk.open();
    await untilListening(h);
    const note = h.sent.find(e => e.type === 'conversation.item.create').item.content[0].text;
    assert.match(note, /you used use_skill \(take a photo\) and that skill took over\. That skill said: "Get ready/);
    assert.doesNotMatch(note, /timer|alarm/);
    h.talk.close();
});

test('tool rounds are limited: a third round in a row is refused and Jibo listens', async () => {
    const h = await listening({actions: fakeActions()});
    await youSay(h, 'what is your favorite movie');
    callReply(h, 'r1', '', [['about_jibo', {}, 'a']]);
    await until(() => h.sent.filter(e => e.type === 'response.create').length === 1);
    callReply(h, 'r2', '', [['about_jibo', {}, 'b']]);
    await until(() => h.sent.filter(e => e.type === 'response.create').length === 2);
    callReply(h, 'r3', '', [['about_jibo', {}, 'c']]);
    await untilListening(h);
    const last = h.sent.filter(e => e.type === 'conversation.item.create').at(-1);
    assert.deepEqual(JSON.parse(last.item.output), {ok: false, error: 'too many actions in a row'});
    assert.equal(h.sent.filter(e => e.type === 'response.create').length, 2);
    h.talk.close();
});

test('without actions, function calls are ignored as in 0.5', async () => {
    const h = await listening();
    await youSay(h, 'what time is it');
    callReply(h, 'r1', 'No idea!', [['get_time']]);
    await untilListening(h);
    assert.ok(!h.sent.some(e => e.type === 'response.create' || e.type === 'conversation.item.create'));
    h.talk.close();
});

test('resume after the clock without a comeback line: no greeting; the conversation and the timer facts go to the model, which speaks next', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts, config: {comebackLine: ''}, resume: {pairs: [{you: 'set a timer for five minutes', jibo: 'Okay!'}], tool: 'set_timer', args: {seconds: 300, duration: '5 minutes'}, said: 'You got it. 5 minutes.'}});
    h.talk.open();
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const note = h.sent.find(e => e.type === 'conversation.item.create').item;
    assert.equal(note.role, 'system');
    assert.match(note.content[0].text, /Person: set a timer for five minutes\nJibo: Okay!/);
    assert.match(note.content[0].text, /set_timer for 5 minutes/);
    assert.match(note.content[0].text, /Your clock said: "You got it. 5 minutes."/);
    assert.match(note.content[0].text, /A timer is now running with 5 minutes left/);
    reply(h, 'r1', 'Anything else?');
    await untilListening(h);
    assert.deepEqual(h.said, ['Anything else?'], 'no greeting');
    assert.ok(h.logs.some(e => e.kind === 'session' && e.resumed === 'set_timer'));
    assert.ok(h.logs.some(e => e.kind === 'resume' && e.clock.timer.set === true));
    h.talk.close();
});

test('a follow-up reply that never comes does not leave Jibo stuck', async () => {
    const h = await listening({actions: fakeActions(), config: {replyWaitMs: 80}});
    await youSay(h, 'what is your favorite movie');
    callReply(h, 'r1', '', [['about_jibo']]);
    await sleep(40); assert.equal(h.talk.state, 'thinking');
    await untilListening(h);
    assert.ok(h.logs.some(e => e.kind === 'skipped' && e.reason === 'no_reply'));
    h.talk.close();
});

test('persona with actions: the tool rules replace "no tools", and the time is the home timezone\'s', () => {
    const text = realtime.instructions('', '', {apps: ['clock']});
    assert.match(text, /use your timer and alarm, .*open your apps, go to sleep, and look away\./);
    assert.match(realtime.sessionNote({year: 2026, monthNum: 10, date: 13, dayOfWeek: 'Friday', hour: 9, minute: 5}), /Friday, November 13, 2026, 9:05 AM local time/);
    assert.doesNotMatch(text, /in this voice mode you have no tools/);
});

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

test('the greeting smiles with the eye only (no body movement), outside the classifier\'s choices', async () => {
    const h = await listening({config: {greetingExpression: DEFAULTS.greetingExpression}});
    assert.equal(h.said[0], 'Hi!'); assert.deepEqual(clips(h), ['eye_happy_00@null']);
    assert.equal(DEFAULTS.greeting, 'Hi!');
    assert.ok(!labels.choices('line').some(c => c.value === 'smile'));
    h.talk.close();
});

test('timer tools: the instructions and tool descriptions say to call them without words first', () => {
    const text = realtime.voiceSetup({apps: []});
    assert.match(text, /For get_time, set_timer, cancel_timer, set_alarm, cancel_alarm, use_skill and open_app, call the tool without saying anything first/);
    assert.doesNotMatch(text, /"Okay!"/);
    const tools = require(path.join(source, 'noggin/lib/actions.js')).tools({});
    for (const name of ['get_time', 'set_timer', 'cancel_timer', 'set_alarm', 'cancel_alarm', 'use_skill', 'open_app']) assert.match(tools.find(t => t.name === name).description, /without saying anything first/);
});
test('the instructions tell Jibo his emoji come from the words he says, and keep them apart from picture (D161)', () => {
    const text = realtime.voiceSetup({apps: [], config: {}});
    assert.match(text, /small emoji may show on your eye when you say the name of something/);
    assert.match(text, /never say you have none/);
    assert.doesNotMatch(text, /use picture/, 'no picture tool, no mention of it');
    assert.match(realtime.voiceSetup({apps: [], config: {cloudSkills: ['picture']}}), /An emoji is not a picture: for a photo use picture/);
    assert.match(realtime.voiceSetup(null, null), /small emoji may show/, 'also without tools');
    assert.doesNotMatch(realtime.voiceSetup({apps: [], config: {emoji: false}}), /small emoji may show/);
    assert.doesNotMatch(realtime.voiceSetup(null, null, {emoji: false}), /small emoji may show/);
    assert.match(text, /no markdown, lists, emoji, bracketed markers/, 'he still writes no emoji characters');
});
// ---- expressions next to speech ----
// A DOF set like jibo.expression.dofs: names, and minus() for a new set.
const dofSet = names => ({names, minus: other => dofSet(names.filter(n => other.names.indexOf(n) < 0))});
const DOFS = {ALL: dofSet(['BODY', 'EYE', 'OVERLAY', 'LED', 'BASE', 'EYE_TRANSLATE']), LED: dofSet(['LED']), BASE: dofSet(['BASE']), EYE_TRANSLATE: dofSet(['EYE_TRANSLATE'])};
// animDB with a few animations: each plays for `ms` and ends as `results[name]` (default STOPPED).
// layers: {name: {Body: true|false}} for clips whose body layer is known (else unknown).
function fakeAnimDB(results = {}, ms = 60, layers = {}) {
    const played = [], centred = [], attempts = {};
    const animDB = {getAnimByName: name => name === 'missing_01' ? null : {
        meta: {endsNeutral: name !== 'Confused_01', layers: layers[name]},
        createFromConfig: config => {
            const started = emitter();
            const playback = {instance: {events: {started}}, stopped: false,
                play: opts => {
                    played.push({name, config, opts});
                    attempts[name] = (attempts[name] || 0) + 1;
                    // {reject: n}: refused the first n times (speech's own animation holds the parts), then plays.
                    if (results[name] === 'REJECTED' || results[name] && attempts[name] <= results[name].reject) return sleep(2).then(() => 'REJECTED');
                    if (results[name] !== 'NOSTART') setTimeout(() => started.fire(), 3);
                    return new Promise(resolve => { playback.end = resolve; setTimeout(() => resolve('STOPPED'), ms); });
                },
                stop: () => { playback.stopped = true; if (playback.end) playback.end('STOPPED'); return Promise.resolve(); }};
            return sleep(5).then(() => playback);
        }}};
    const expression = {dofs: DOFS, centerRobot: c => { centred.push(c); return Promise.resolve(); }};
    return {animDB, expression, played, centred};
}

test('a line is done when its words are (dispatchComplete TTS); when speech\'s own animations end is logged', async () => {
    let finish;
    const h = await listening({config: {greetingExpression: 'hello'}, speech: {waitForAnimDispatch: () => new Promise(r => { finish = r; })}});
    assert.deepEqual(h.options[0], {dispatchComplete: 'TTS'});
    const speak = h.logs.find(e => e.kind === 'speak'), spoken = h.logs.find(e => e.kind === 'spoken');
    assert.equal(speak.play, 'greetings_01'); assert.equal(typeof speak.at, 'number');
    assert.ok(spoken.ms >= 15);
    assert.ok(h.logs.some(e => e.kind === 'listen' && typeof e.after_speech === 'number'));
    assert.ok(!h.logs.some(e => e.kind === 'speech_anims'), 'listening did not wait for the animation');
    finish(); await sleep(5);
    assert.ok(h.logs.find(e => e.kind === 'speech_anims').ms >= 15);
    h.talk.close();
});

test('animdb: the animation starts first, next to the words, with its LED channels removed; Jibo is centred only after one that ends off-neutral', async () => {
    const db = fakeAnimDB();
    const h = await listening({config: {greetingExpression: 'hello'}, animDB: db.animDB, expression: db.expression});
    assert.equal(h.said[0], 'Hi!', 'no <anim> in the words');
    assert.equal(db.played[0].name, 'greetings_01');
    assert.ok(!db.played[0].config.dofs.names.includes('LED') && db.played[0].config.dofs.names.includes('BODY'));
    assert.ok(!db.played[0].opts.forceReturnToIdle, 'no return to idle that would take the LED');
    assert.equal(db.played[0].config.cache, 'global', 'a named loader cache (without one the load never finishes on the robot)');
    assert.ok(h.logs.findIndex(e => e.kind === 'speak') > -1);
    await until(() => h.logs.some(e => e.kind === 'anim'));
    const anim = h.logs.find(e => e.kind === 'anim');
    assert.equal(anim.result, 'STOPPED'); assert.equal(anim.ledStripped, true); assert.ok(anim.start >= anim.asked && anim.end >= anim.start);
    assert.equal(db.centred.length, 0, 'greetings_01 ends neutral');
    const off = h.talk.player.play('Confused_01', {via: 'test'});
    assert.equal(await off.done, 'STOPPED');
    assert.ok(!db.centred[0].dofs.names.includes('LED') && !db.centred[0].dofs.names.includes('BASE'));
    h.talk.close();
});

test('animdb: a rejected or missing animation is logged and the words still come', async () => {
    const db = fakeAnimDB({greetings_01: 'REJECTED'});
    const h = await listening({config: {greetingExpression: 'hello', expressionLeadMs: 40}, animDB: db.animDB, expression: db.expression});
    assert.equal(h.said[0], 'Hi!');
    await until(() => h.logs.some(e => e.kind === 'anim'));
    assert.equal(h.logs.find(e => e.kind === 'anim').result, 'REJECTED');
    assert.equal(await h.talk.player.play('missing_01').done, 'missing');
    h.talk.close();
});

test('a new expression replaces the one still playing; closing Noggin stops it', async () => {
    const db = fakeAnimDB({}, 5000);
    const h = await listening({config: {greeting: ''}, animDB: db.animDB, expression: db.expression});
    const first = h.talk.player.play('excited_01'); await first.started;
    const second = h.talk.player.play('sad_01'); await second.started;
    assert.equal(await first.done, 'replaced');
    assert.ok(h.talk.player.busy());
    await h.talk.close();
    assert.equal(await second.done, 'closed');
    assert.equal(db.centred.length, 1, 'stopped half way: back to neutral (D116)');
    assert.ok(!db.centred[0].dofs.names.includes('BASE') && !db.centred[0].dofs.names.includes('LED'));
    const idle = await listening({config: {greeting: ''}, animDB: db.animDB, expression: fakeAnimDB().expression});
    const centredBefore = db.centred.length;
    await idle.talk.close();
    assert.equal(db.centred.length, centredBefore, 'nothing playing: no centring');
});

test('the reaction plays through the animation database at once and never holds up the first line', async () => {
    const db = fakeAnimDB({}, 300);
    const h = harness({speakMs: 30, animDB: db.animDB, expression: db.expression,
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'surprised', confidence: 0.9}) : Promise.resolve({label: 'none'})});
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won the lottery!');
    await sleep(15);
    assert.equal(db.played[0].name, 'surprised_02');
    assert.equal(h.said.length, 1, 'nothing spoken for the reaction');
    reply(h, 'r1', 'No way! That is wonderful.');
    await until(() => h.said.length === 3);
    assert.ok(h.talk.player.busy(), 'the lines came while the reaction still played');
    assert.deepEqual(h.said.slice(1), ['No way!', 'That is wonderful.']);
    await untilListening(h);
    assert.equal(h.logs.find(e => e.kind === 'jibo').reaction.played, 'before');
    h.talk.close();
});

test('expressionTailMs: listening waits (at most that long) for an expression still playing', async () => {
    const db = fakeAnimDB({}, 250);
    const h = await listening({config: {greetingExpression: 'hello', expressionTailMs: 1000}, animDB: db.animDB, expression: db.expression});
    const anim = h.logs.find(e => e.kind === 'anim'), listen = h.logs.find(e => e.kind === 'listen');
    assert.ok(anim && h.logs.indexOf(anim) < h.logs.indexOf(listen), 'the animation ended before listening');
    assert.equal(listen.anim_playing, false);
    h.talk.close();
});

test('an animation database that never answers: load and play time out, are logged, and Noggin is not left busy', async () => {
    const Player = require(path.join(source, 'noggin/lib/expression.js'));
    const saved = [Player.LOAD_MS, Player.SLACK_MS]; Player.LOAD_MS = 40; Player.SLACK_MS = 40;
    try {
        const logs = [], stops = [];
        const jibo = {expression: {dofs: DOFS}, animDB: {getAnimByName: name => ({meta: {duration: 3, endsNeutral: true},
            createFromConfig: () => name === 'never_loads' ? new Promise(() => {}) : Promise.resolve({instance: {events: {}}, play: () => new Promise(() => {}), stop: () => { stops.push(name); return Promise.resolve(); }})})}};
        const player = new Player(jibo, {write: e => logs.push(e)});
        const load = player.play('never_loads');
        assert.equal(await load.done, 'load_timeout'); assert.equal(await load.started, false);
        const hang = player.play('never_ends');
        assert.equal(await hang.done, 'play_timeout');
        assert.deepEqual(stops, ['never_ends']);
        assert.ok(!player.busy());
        assert.deepEqual(logs.map(e => e.result), ['load_timeout', 'play_timeout']);
    } finally { [Player.LOAD_MS, Player.SLACK_MS] = saved; }
});

// ---- moods, sizes and the catalogue ----
test('catalogue: every mood has animations, each a real, silent animation that starts neutral and fits its size', {skip: !fs.existsSync(ANIMDB) && 'no animdb.json here'}, () => {
    const anims = JSON.parse(fs.readFileSync(ANIMDB, 'utf8')), json = require(path.join(source, 'noggin/lib/catalog.json'));
    const moods = Object.keys(catalog.MOODS).filter(n => n !== 'dance');
    assert.deepEqual(Object.keys(json.moods).sort(), moods.sort(), 'one catalogue entry per mood, and only those');
    let count = 0;
    for (const mood of moods) {
        const {small, big} = json.moods[mood];
        assert.ok(small.length + big.length > 0, mood + ' has animations');
        for (const [size, list] of [['small', small], ['big', big]]) for (const a of list) {
            const m = anims[a.n]; count++;
            assert.ok(m, mood + ': ' + a.n + ' exists');
            assert.ok(!m.hasAudio && m.startsNeutral && m.duration <= json.maxFrames, mood + ': ' + a.n + ' silent, neutral start, short');
            assert.equal(a.f, m.duration); assert.equal(a.led, !!m.layers.LED); assert.equal(a.body, !!m.layers.Body); assert.equal(a.neutral, m.endsNeutral !== false);
            assert.equal(size === 'small', !a.body || a.f <= json.smallFrames, mood + ': ' + a.n + ' size');
        }
    }
    assert.ok(count >= 150, count + ' animations');
    // Generated, not hand-edited: the generator gives the same file.
    const gen = execFileSync(process.execPath, ['-e', `import('${path.join(source, 'tools/expression-catalog.mjs')}').then(m => { const db = JSON.parse(require('fs').readFileSync('${ANIMDB}', 'utf8')); process.stdout.write(JSON.stringify({moods: m.build(db).moods, emoji: m.emojiIndex(db)})); })`]);
    const fresh = JSON.parse(gen);
    assert.deepEqual(fresh.moods, json.moods, 'catalog.json is up to date: node tools/expression-catalog.mjs');
    assert.deepEqual(fresh.emoji, json.emoji, 'catalog.json emoji are up to date');
    // Emoji: pictures on the eye, silent, no body, no LED, short.
    const emojiNames = new Set(Object.values(json.emoji).flat());
    assert.ok(Object.keys(json.emoji).length > 400 && emojiNames.size > 300);
    for (const name of emojiNames) {
        const m = anims[name];
        assert.ok(m && m.categories.includes('emoji') && !m.hasAudio && !m.layers.Body && !m.layers.LED && m.duration <= json.maxFrames, name);
    }
    assert.ok(!json.emoji.dog.some(n => /hot/i.test(n)), 'a dog is not a hot dog');
});

test('pickAnimation: the asked size, no recent repeats, LED animations too, the other size or the default as fallback', () => {
    const c = catalog.CATALOG;
    const names = list => list.map(a => a.n);
    for (let i = 0; i < 20; i++) {
        assert.ok(names(c.happy.small).includes(catalog.pickAnimation('happy', 'small')));
        assert.ok(names(c.happy.big).includes(catalog.pickAnimation('happy', 'big')));
    }
    assert.equal(catalog.pickAnimation('yes', 'small', {random: () => 0.99}), 'yep_04', 'an LED animation plays too');
    const recent = names(c.thinking.big).slice(1);
    assert.equal(catalog.pickAnimation('thinking', 'big', {recent}), c.thinking.big[0].n, 'the one not played recently');
    assert.ok(names(c.laugh.big).includes(catalog.pickAnimation('laugh', 'small')), 'no small laugh: a big one');
    assert.ok([...names(c.happy.small), ...names(c.happy.big)].includes(catalog.pickAnimation('happy', null)), 'no size: either');
    assert.equal(catalog.pickAnimation('dance', 'big'), 'dance_funk_02');
    assert.equal(catalog.pickAnimation('nonsense', 'big'), null);
});

test('Decisions with the size question: small/big parsed; refused once, it is dropped for the session; Responses gives a size too', async () => {
    const sized = labels.decisionsRequest('gpt-6-luna', 'I won!', 'Wow!', 'line', true);
    assert.deepEqual(sized.questions.map(q => q.name), ['expression', 'size']);
    assert.deepEqual(sized.questions[1].choices.map(c => c.value), ['small', 'big']);
    const two = (choice, size) => ({answers: [{type: 'choice', name: 'expression', choice, confidence: 0.9}, {type: 'choice', name: 'size', choice: size, confidence: 0.7}]});
    assert.deepEqual(labels.decisionLabel(two('happy', 'big'), 0.35), {label: 'happy', confidence: 0.9, size: 'big'});
    assert.equal(labels.decisionLabel(two('none', 'big'), 0.35).size, null);
    assert.equal(labels.decisionLabel(two('happy', 'huge'), 0.35).size, null);
    const bodies = [];
    const classify = openai.classifier(Object.assign({}, DEFAULTS, {apiKey: 'sk'}), (route, body) => {
        bodies.push(body);
        return Promise.resolve(body.questions.length === 2 ? {status: 400, ms: 30, json: {error: {code: 'invalid_request'}}}
            : {status: 200, ms: 90, json: {answers: [{type: 'choice', name: 'expression', choice: 'sad', confidence: 0.8}]}});
    });
    const first = await classify('my cat died', 'I am so sorry.', 'line');
    assert.equal(first.label, 'sad'); assert.equal(first.size, null); assert.match(first.switched, /size question refused/);
    await classify('x', 'y', 'reaction');
    assert.deepEqual(bodies.map(b => b.questions.length), [2, 1, 1], 'asked once with size, then without for good');
    const responses = labels.classifierRequest('m', 'a', 'b');
    assert.deepEqual(responses.text.format.schema.required, ['expression', 'size']);
    assert.equal(labels.classifierAnswer({output_text: '{"expression":"happy","size":"small"}'}).size, 'small');
    assert.equal(labels.classifierAnswer({output_text: 'nope'}).size, null);
});

test('defaults: the catalogue, a size; a line plays a random animation of its mood and size, never the last few again', async () => {
    assert.equal(DEFAULTS.expressionSize, true); assert.equal(DEFAULTS.emoji, true);
    assert.equal(DEFAULTS.expressionPick, undefined, 'no fixed animations any more');
    const db = fakeAnimDB({}, 10);
    const h = harness({realChoose: true, animDB: db.animDB, expression: db.expression, config: {expressionGapMs: 0},
        classify: (person, line, kind) => Promise.resolve(kind === 'reaction' ? {label: 'none'} : {label: 'thinking', size: 'big', confidence: 0.9})});
    h.talk.policy.repeatMs = 0;
    h.talk.open(); await untilListening(h);
    youSay(h, 'Tell me something deep');
    reply(h, 'r1', 'Hmm. Let me see. Well. Maybe so. Who knows. Think about it.');
    await untilListening(h);
    const played = db.played.map(p => p.name), big = catalog.CATALOG.thinking.big.map(a => a.n);
    assert.equal(played.length, 2, 'the first sentence, then the rest');
    assert.ok(played.every(n => big.includes(n)) && played[0] !== played[1], 'two different big thinking animations: ' + played);
    const speak = h.logs.find(e => e.kind === 'speak' && e.turn === 1);
    assert.equal(speak.size, 'big'); assert.ok(big.includes(speak.play));
    const next = [0, 1, 2, 3, 4].map(() => h.talk.choose('thinking', 'big'));
    const all = played.concat(next);
    all.forEach((name, i) => assert.ok(all.slice(Math.max(0, i - 5), i).indexOf(name) < 0, name + ' repeats one of the five before it'));
    assert.ok(h.talk.recentAnims.length === 5);
    assert.equal(h.talk.choose('dance'), catalog.DANCE); assert.equal(h.talk.choose('smile'), 'eye_happy_00'); assert.equal(h.talk.choose('none'), null);
    h.talk.close();
});

test('size notes: a mood with one size of animation says which, so the model\'s size answer fits', () => {
    const line = labels.decisionsRequest('gpt-6-luna', 'a', 'b', 'line', true).questions[0].choices;
    const of = v => line.find(c => c.value === v).description;
    assert.match(of('giggle'), /\(always a whole-body move\)$/);
    assert.match(of('celebrate'), /\(always small: on his eye or a small nod\)$/);
    assert.doesNotMatch(of('happy'), /always/);
    for (const mood of Object.keys(catalog.CATALOG)) {
        const {small, big} = catalog.CATALOG[mood], d = catalog.moodDescription(mood);
        assert.equal(/always a whole-body/.test(d), !small.length, mood); assert.equal(/always small/.test(d), !big.length, mood);
    }
    assert.match(labels.classifierRequest('m', 'a', 'b').input[0].content, /giggle: .*always a whole-body move/);
});

test('emojiFor: the first word or two-word term with a picture, plurals, not a recent word', () => {
    const first = () => 0;
    assert.deepEqual(catalog.emojiFor('I love pizza and ice cream!', {random: first}), {word: 'pizza', name: catalog.EMOJI.pizza[0], said: ['pizza'], nth: 0});
    assert.deepEqual(catalog.emojiFor('Ice creams for everyone.').said, ['ice', 'creams'], 'said: the words as in the line');
    assert.equal(catalog.emojiFor('Ice cream is the best.').word, 'ice cream', 'two-word terms first');
    assert.equal(catalog.emojiFor('My dogs are cute.').word, 'dog');
    assert.equal(catalog.emojiFor('Do you like books?').word, 'book');
    assert.equal(catalog.emojiFor('I love pizza and ice cream!', {recent: ['pizza']}).word, 'ice cream');
    assert.equal(catalog.emojiFor('Grass is green because of chlorophyll.'), null);
    assert.equal(catalog.emojiFor('Yes, that is good news, hello!'), null, 'common words have no picture');
    assert.equal(catalog.emojiFor(''), null);
});

test('emojiFor in Dutch: Dutch words show the same pictures, with plurals, diminutives and accents (D176)', () => {
    const nl = (line, more) => catalog.emojiFor(line, Object.assign({language: 'nl', random: () => 0}, more || {}));
    assert.deepEqual(nl('Wat leuk, een hond!'), {word: 'dog', name: catalog.EMOJI.dog[0], said: ['hond'], nth: 0});
    const cases = {'Ik hou van katten.': 'cat', 'Drie bomen in de tuin.': 'tree', 'De huizen zijn groot.': 'house', 'Een lekker ijsje.': 'ice cream',
        'Wat een zonnetje!': 'sun', 'Kijk, een eitje.': 'egg', "Auto's rijden snel.": 'car', 'Rode appels!': 'red apple', 'Pinguïns zijn grappig.': 'penguin',
        'Mijn circuits zoemen.': 'circuit', 'Zullen we een kopje koffie drinken?': 'coffee'};
    for (const line of Object.keys(cases)) assert.equal((nl(line) || {}).word, cases[line], line);
    assert.deepEqual(nl('Pinguïns zijn grappig.').said, ['pinguïns'], 'said: the word as in the line, accents kept');
    assert.equal(ttsText.emojiEsml('Pinguïns zijn grappig.', ['pinguïns'], 'Emoji_Penguin', 0), "<es name='Emoji_Penguin' nonBlocking='true'/>Pinguïns zijn grappig.");
    for (const line of ['Dat is een eis.', 'Even kijken, hoor.', 'Ik zit op de bank.', 'Er komt een golf aan.', 'Tot slot nog dit.', 'Ik ben er.',
        'Zal ik verder in het Engels praten?', 'Die regels gelden ook.', 'Hij heeft twee zonen.', 'Pak het kastje.', 'Een natje en een droogje.',
        'Het was een groot succes.', 'De burgers stemden.', 'Het ijs is glad.', 'Op dun ijs.', 'Een glas jus d\'orange.'])
        assert.equal(nl(line), null, line);
    assert.equal(nl('Mijn appel iphone is stuk.'), null, 'a nearby word cancels');
    assert.equal(nl('Veel succes vandaag!').word, 'good luck');
    assert.equal(nl('Ik hou van honden.', {recent: ['dog']}), null, 'recent pictures count across languages');
    assert.equal(catalog.emojiFor('Ik hou van honden.'), null, 'an English line does not read Dutch words');
    const english = require(path.join(source, 'noggin/lib/catalog.json')).emoji, terms = require(path.join(source, 'noggin/lib/emoji-nl.js'));
    for (const word of Object.keys(terms.TERMS)) {
        assert.ok(english[terms.TERMS[word]], word + ' points at a known picture term');
        assert.match(word, /^[a-z]+( [a-z]+)?$/, word + ': lower case, no accents, at most two words');
    }
    for (const word of Object.keys(terms.CANCEL)) assert.ok(terms.TERMS[word], word + ' has cancel words and a picture');
    for (const word of terms.NOT) assert.match(word, /^[a-z]+$/, word);
});

test('emojiFor: words with another meaning or picture have none; a nearby word can cancel one (D98)', () => {
    for (const line of ['Here is a paper for you.', 'That machine is loud.', 'Let us break the ice.', 'As a rule of thumb, rest.', 'Cheers to that!'])
        assert.equal(catalog.emojiFor(line), null, line);
    assert.equal(catalog.emojiFor('That was a piece of cake.'), null, 'piece of cake');
    assert.equal(catalog.emojiFor('I will take a rain check.'), null);
    assert.equal(catalog.emojiFor('My new apple iphone is great.'), null);
    assert.equal(catalog.emojiFor('My new apple iphone, then a cake.').word, 'cake', 'the search goes on after a cancelled word');
    assert.equal(catalog.emojiFor('An apple a day.').word, 'apple');
    assert.equal(catalog.emojiFor('We baked a cake.').word, 'cake');
    assert.equal(catalog.emojiFor('Ice cream, please.').word, 'ice cream', 'the two-word term still has one');
});

test('emojiEsml: the emoji tag goes just before its word in the ESML; null when the word is not there (D98)', () => {
    const tag = n => "<es name='" + n + "' nonBlocking='true'/>";
    assert.equal(ttsText.emojiEsml('How about a pizza tonight?', ['pizza'], 'Emoji_Pizza'), 'How about a ' + tag('Emoji_Pizza') + 'pizza tonight?');
    assert.equal(ttsText.emojiEsml('My Dogs are cute.', ['dogs'], 'Emoji_Dog'), 'My ' + tag('Emoji_Dog') + 'Dogs are cute.');
    assert.equal(ttsText.emojiEsml("The dog's bone.", ['dog'], 'Emoji_Dog'), 'The ' + tag('Emoji_Dog') + "dog's bone.");
    assert.equal(ttsText.emojiEsml('Ice  cream &amp; cake.', ['ice', 'cream'], 'Emoji_IceCream'), tag('Emoji_IceCream') + 'Ice  cream &amp; cake.');
    assert.equal(ttsText.emojiEsml('A hotdog stand.', ['dog'], 'Emoji_Dog'), null, 'whole words only');
    assert.equal(ttsText.emojiEsml('A cat.', ['cat'], "x' onload='y"), null, 'only plain animation names');
    for (const [text, word] of [['A pie chart is fine, but I love pie.', 'love '], ['Rain check? No, the rain is coming.', 'the '], ['My apple iphone broke, so I ate an apple.', 'an ']]) {
        const f = catalog.emojiFor(text);
        assert.equal(f.nth, 1, text);
        assert.ok(ttsText.emojiEsml(ttsText.speechText(text), f.said, f.name, f.nth).includes(word + tag(f.name)), 'not on the cancelled one: ' + text);
    }
    const line = 'Fei Fei found a tiny door hidden in the trunk of an old tree.';
    const found = catalog.emojiFor(line), esml = ttsText.emojiEsml(ttsText.speechText(line), found.said, found.name);
    assert.ok(esml.endsWith('an old ' + tag(found.name) + 'tree.'), esml);
});

test('emoji: a line without an expression shows a picture for what Jibo names; at most one per emojiGapMs; the expression on the same line wins', async () => {
    const db = fakeAnimDB({}, 30);
    const h = harness({animDB: db.animDB, expression: db.expression, config: {emoji: true, emojiGapMs: 400},
        classify: (person, line) => Promise.resolve({label: /lovely/.test(line) ? 'happy' : 'none', size: 'small'})});
    h.talk.open(); await untilListening(h);
    youSay(h, 'What should I eat?');
    reply(h, 'r1', 'How about a pizza? Or a taco with cheese.');
    await untilListening(h);
    const emoji = h.logs.filter(e => e.kind === 'speak' && e.emoji);
    assert.equal(emoji.length, 1, 'one emoji within emojiGapMs'); assert.equal(emoji[0].emoji, 'pizza'); assert.equal(emoji[0].emoji_at, 'pizza');
    assert.ok(catalog.EMOJI.pizza.includes(emoji[0].play));
    assert.equal(h.said[1], "How about a <es name='" + emoji[0].play + "' nonBlocking='true'/>pizza?", 'at its word, in the words (D98)');
    assert.equal(db.played.length, 0, 'not played next to the line');
    assert.deepEqual(h.rules.slice(1, 3), [undefined, {hotWords: false}], "speech's own keyword emoji off within emojiGapMs");
    assert.deepEqual(h.logs.find(e => e.kind === 'jibo').expressions, ['none', 'emoji pizza', 'none']);
    await sleep(450);
    youSay(h, 'I got a dog');
    reply(h, 'r2', 'A dog, how lovely!');
    await untilListening(h);
    const second = h.logs.filter(e => e.kind === 'speak' && e.turn === 2);
    assert.equal(second[0].expression, 'happy'); assert.equal(second[0].emoji, undefined, 'the expression wins over the emoji');
    h.talk.close();
});

test('emoji after an expression: line 1 has an expression, line 2 names a cat: the cat is in line 2 at its word, nothing waits (D98)', async () => {
    const db = fakeAnimDB({}, 400);
    const h = harness({speakMs: 30, animDB: db.animDB, expression: db.expression, config: {emoji: true},
        classify: (person, line) => Promise.resolve(/Nice/.test(line) ? {label: 'thumbsup', size: 'small'} : {label: 'none'})});
    h.talk.choose = label => label === 'thumbsup' ? 'Emoji_ThumbsUp' : null;
    h.talk.open(); await untilListening(h);
    youSay(h, 'They have a cat');
    reply(h, 'r1', 'Nice! A cat makes a lively audience.');
    await untilListening(h);
    assert.deepEqual(db.played.map(p => p.name), ['Emoji_ThumbsUp']);
    const cat = h.logs.find(e => e.kind === 'speak' && e.emoji === 'cat');
    assert.ok(catalog.EMOJI.cat.includes(cat.play)); assert.equal(cat.after, undefined); assert.equal(cat.lead, undefined);
    assert.equal(h.said.at(-1), "A <es name='" + cat.play + "' nonBlocking='true'/>cat makes a lively audience.");
    h.talk.close();
});

test("emoji: a word the ESML cannot find is logged as missed and the line is said without it; speech's own keyword emoji stay on (D98)", async () => {
    const h = await listening({config: {emoji: true}, classify: () => Promise.resolve({label: 'none'})});
    await h.talk.speak('A pizza.', null, {turn: 1, line: 0, keyword: {word: 'pizza', name: 'Emoji_Pizza', said: ['pasta']}});
    const speak = h.logs.find(e => e.kind === 'speak' && e.emoji === 'pizza');
    assert.equal(speak.emoji_at, 'missed'); assert.equal(h.said.at(-1), 'A pizza.'); assert.equal(h.rules.at(-1), undefined);
    h.talk.close();
});

test("emoji off: speech's own keyword emoji are off too (D98)", async () => {
    const h = await listening({config: {emoji: false}, classify: () => Promise.resolve({label: 'none'})});
    youSay(h, 'What should I eat?');
    reply(h, 'r1', 'How about a pizza?');
    await untilListening(h);
    assert.equal(h.said.at(-1), 'How about a pizza?');
    assert.deepEqual(h.rules.at(-1), {hotWords: false}); assert.equal(h.logs.find(e => e.kind === 'speak' && e.turn === 1).hot_words, false);
    h.talk.close();
});

// ---- Jibo's cloud features ----
// A jetstream whose hotword tokens record the order of events; `release` as given (default: at once).
function cloudJetstream(h, release) {
    const order = [];
    h.jibo.jetstream.setHotwordMode = () => { order.push('off'); return {activated: Promise.resolve(), release: () => { order.push('release'); return release ? release() : Promise.resolve(); }}; };
    return order;
}

test('cloud tools: only those in cloudSkills go in session.update, and the instructions name only those', async () => {
    const h = await listening({actions: fakeActions(), config: {cloudSkills: ['surprise', 'joke']}});
    const names = h.sent.find(e => e.type === 'session.update').session.tools.map(t => t.name);
    assert.ok(names.includes('surprise')); assert.ok(!names.includes('weather') && !names.includes('news'));
    assert.ok(!names.includes('joke'), 'joke is disabled, even when listed');
    h.talk.close();
    const text = realtime.voiceSetup({apps: [], config: {cloudSkills: ['surprise']}});
    assert.match(text, /ask your cloud for a surprise/); assert.doesNotMatch(text, /weather|news|joke/);
    assert.doesNotMatch(realtime.voiceSetup({apps: [], config: {}}), /cloud/);
});

test('a cloud tool: no words first; the hotword is given back, then the cloud gets the fixed phrase; the turn Be starts ends Noggin as a handover', async () => {
    const asked = [];
    const acts = fakeActions();
    const h = harness({actions: acts, config: {cloudSkills: ['weather']}});
    const order = cloudJetstream(h);
    acts.cloud = phrase => { order.push('ask'); asked.push(phrase); return Promise.resolve(); };
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'what is the weather like in Paris tomorrow?');
    callReply(h, 'r1', '', [['weather', {city: 'Paris'}]]);
    await until(() => asked.length === 1);
    assert.deepEqual(asked, ['tell me about the weather'], 'the menu\'s phrase, never the model\'s words');
    assert.deepEqual(order, ['off', 'release', 'ask'], 'the hotword is back before the cloud is asked');
    assert.equal(acts.redirects.length, 0);
    assert.equal(acts.handovers[0].tool, 'weather'); assert.equal(acts.handovers[0].target, '@be/nimbus'); assert.equal(acts.handovers[0].comeback, true);
    assert.ok(h.logs.some(e => e.kind === 'handover' && e.tool === 'weather' && e.phrase === 'tell me about the weather'));
    assert.equal(h.talk.state, 'handover');
    h.jibo.jetstream.events.globalTurnStarted.fire();   // the robot's speech service starts the cloud's turn
    assert.equal(await ended, 'handover');
    assert.equal(order.filter(x => x === 'release').length, 1, 'released once, not again on close');
});

test('review: opened by "Hey Jibo", a quick cloud tool: its turn ends Noggin as a handover, and the shared claim is released (D132)', async () => {
    const acts = fakeActions(), asked = [];
    const h = harness({actions: acts, config: {cloudSkills: ['weather']}, heyJibo: {heardAt: Date.now()}});
    cloudJetstream(h);
    acts.cloud = phrase => { asked.push(phrase); return Promise.resolve(); };
    global.nogginHeyJibo = {claimedAt: Date.now()};
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'what is the weather?');
    callReply(h, 'r1', '', [['weather', {}]]);
    await until(() => asked.length === 1);
    assert.equal(global.nogginHeyJibo.claimedAt, null, 'background.js will not cancel this turn');
    h.jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(await ended, 'handover');
    assert.ok(!h.logs.some(e => e.kind === 'hey_jibo_turn'));
    delete global.nogginHeyJibo;
});

test('a cloud tool whose hotword release never answers (the simulator) is still asked, after at most 1.5 s', async () => {
    const asked = [];
    const acts = fakeActions();
    const h = harness({actions: acts, config: {cloudSkills: ['news']}});
    cloudJetstream(h, () => new Promise(() => {}));
    acts.cloud = phrase => { asked.push(phrase); return Promise.resolve(); };
    h.talk.open(); await untilListening(h);
    await youSay(h, 'any news?');
    const at = Date.now();
    callReply(h, 'r1', '', [['news', {}]]);
    await until(() => asked.length === 1, 2500);
    assert.ok(Date.now() - at >= 1400, 'waited for the release');
    assert.deepEqual(asked, ['tell me about the news']);
    h.talk.close();
});

test('a cloud tool that fails or is never answered: the model hears it, the hotword goes off again, and the conversation goes on', async () => {
    for (const [cloud, error] of [[() => Promise.reject(Error('jetstream down')), /^Jibo's cloud could not be asked: jetstream down$/],
        [() => Promise.resolve(), /^Jibo's cloud did not answer$/],
        // mimicGlobalTurn that never answers (the simulator): the reply after it must not wait for it.
        [() => new Promise(() => {}), /^Jibo's cloud did not answer$/]]) {
        const acts = fakeActions();
        const h = harness({actions: acts, config: {cloudSkills: ['surprise'], actionTimeoutMs: 80}});
        const order = cloudJetstream(h);
        acts.cloud = cloud;
        h.talk.open(); await untilListening(h);
        await youSay(h, 'surprise me');
        callReply(h, 'r1', '', [['surprise', {}, 'j1']]);
        await until(() => h.sent.some(e => e.type === 'conversation.item.create' && e.item.call_id === 'j1'));
        const output = JSON.parse(h.sent.find(e => e.type === 'conversation.item.create' && e.item.call_id === 'j1').item.output);
        assert.equal(output.ok, false); assert.match(output.error, error);
        assert.equal(acts.failed, 1, 'index.js stops watching and clears disableOnce');
        assert.deepEqual(order, ['off', 'release', 'off'], 'Noggin has the hotword off again');
        await until(() => h.sent.some(e => e.type === 'response.create'));
        reply(h, 'r2', 'Hmm, my surprise got stuck.');
        await untilListening(h);
        h.talk.close();
    }
});

test('a cloud tool that is not switched on is refused without asking the cloud', async () => {
    const acts = fakeActions();
    let asked = 0; acts.cloud = () => { asked++; return Promise.resolve(); };
    const h = await listening({actions: acts, config: {cloudSkills: []}});
    await youSay(h, 'what is the weather?');
    callReply(h, 'r1', '', [['weather', {}, 'w1']]);
    await until(() => h.sent.some(e => e.type === 'conversation.item.create' && e.item.call_id === 'w1'));
    assert.match(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 'w1').item.output).error, /not switched on/);
    assert.equal(asked, 0); assert.equal(acts.handovers.length, 0);
    h.talk.close();
});

test('back after the cloud: the note says your cloud took over and what it said', async () => {
    const h = harness({actions: fakeActions(), resume: {pairs: [{you: 'what is the weather?', jibo: ''}], tool: 'weather', args: {}, said: 'Today will be sunny.'}});
    h.talk.open();
    await untilListening(h);
    const note = h.sent.find(e => e.type === 'conversation.item.create').item.content[0].text;
    assert.match(note, /you used weather and your cloud took over\. Your cloud said: "Today will be sunny\."/);
    assert.match(note, /do not repeat what your cloud already said/);
    h.talk.close();
});

test('cloud tools are all on by default, except the disabled joke, and the default stays in step with actions.CLOUD', () => {
    const actions = require(path.join(source, 'noggin/lib/actions.js'));
    const live = Object.keys(actions.CLOUD).filter(name => !actions.CLOUD[name].disabled);
    assert.deepEqual(DEFAULTS.cloudSkills, live);
    assert.ok(DEFAULTS.cloudSkills.length >= 6 && DEFAULTS.cloudSkills.indexOf('joke') < 0);
    assert.deepEqual(actions.cloudSkills(DEFAULTS), live, 'every default name is really offered');
});

test('back after a picture: the note names what was shown, and that the cloud did it', () => {
    const note = realtime.resumeNote({pairs: [{you: 'show me a horse', jibo: ''}], tool: 'picture', args: {subject: 'a horse'}, said: 'Here\'s a picture of a horse.'}, null, 'Anything else?');
    assert.match(note, /you used picture \(of a horse\) and your cloud took over\. Your cloud said: "Here's a picture of a horse\."/);
});

test('a microphone that never starts ends the conversation politely, and is closed if it starts late', async () => {
    const before = Conversation.MIC_START_MS;
    Conversation.MIC_START_MS = 150;
    let resolveStart, stops = 0;
    const mic = {start: () => new Promise(resolve => { resolveStart = resolve; }), stop: () => { stops++; }, kind: 'webaudio'};
    try {
        const h = harness({mic});
        const reason = await Promise.race([h.talk.open(), sleep(3000).then(() => 'still open')]);
        assert.notEqual(reason, 'still open');
        assert.ok(h.said.some(s => /can't think straight/.test(s)), 'Jibo apologises');
        const failed = h.logs.find(e => e.kind === 'startup');
        assert.match(failed.failed, /microphone did not start/);
        const stopsBefore = stops;
        resolveStart();
        await sleep(10);
        assert.equal(stops, stopsBefore + 1, 'a late start is stopped again');
    } finally { Conversation.MIC_START_MS = before; }
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

test('a microphone still starting when the conversation closes is stopped once it starts', async () => {
    let resolveStart, stops = 0;
    const mic = {start: () => new Promise(resolve => { resolveStart = resolve; }), stop: () => { stops++; }, kind: 'webaudio'};
    const h = harness({mic});
    h.talk.open();
    await sleep(20);
    await h.talk.close('swipe');
    const before = stops;
    resolveStart();
    await sleep(10);
    assert.equal(stops, before + 1, 'stopped again once the late start completed');
    assert.equal(h.talk.audioTimer, undefined, 'no report timer for a closed conversation');
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

test('an emoji with a hold frame stays on the eye for holdMs; other animations and short holds are left alone', async () => {
    const Player = require(path.join(source, 'noggin/lib/expression.js'));
    const configs = {};
    const metas = {Emoji_Brain: {duration: 57, holdSafeKF: 32, endsNeutral: true}, happy_01: {duration: 40, holdSafeKF: -1, endsNeutral: true}};
    const jibo = {animDB: {getAnimByName: name => ({meta: metas[name], createFromConfig: config => {
        configs[name] = config;
        return Promise.resolve({instance: {events: {}}, play: () => Promise.resolve('STOPPED'), stop: () => Promise.resolve()});
    }})}};
    const logs = [];
    const player = new Player(jibo, {write: e => logs.push(e)});
    await player.play('Emoji_Brain', {via: 'emoji', holdMs: 3000}).done;
    assert.equal(configs.Emoji_Brain.duration, 90, '3 s at 30 frames a second');
    assert.equal(logs.at(-1).held, 90);
    await player.play('happy_01', {holdMs: 3000}).done;
    assert.equal(configs.happy_01.duration, undefined, 'no hold frame: played as it is');
    await player.play('Emoji_Brain', {holdMs: 1000}).done;
    assert.equal(configs.Emoji_Brain.duration, undefined, 'already longer than asked');
});

test('a notice or trouble emoji asks for a hold of about the line\'s length, between 3 and 4.5 s', async () => {
    const anim = fakeAnimDB();
    anim.animDB.getAnimByName = (base => name => Object.assign(base(name) || {}, {meta: {duration: 57, holdSafeKF: 32, endsNeutral: true}}))(anim.animDB.getAnimByName);
    const h = await listening({config: {}, animDB: anim.animDB, expression: anim.expression});
    await h.talk.speak('Ooo, a brain test.', null, {turn: 1, line: 0, anim: 'Emoji_Brain', emoji: 'brain', via: 'emoji'});
    await sleep(30);
    const asked = anim.played.find(p => p.name === 'Emoji_Brain');
    assert.equal(asked.config.duration, 90, 'a short line: the 3 s minimum');
    h.talk.close();
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
    assert.equal(h.talk.lagTimer, undefined, 'nothing measured that nobody keeps');
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

// The eye's own events (jibo.face.eye): addAnimation when something starts on the screen,
// removeAnimation when it ends, as speech's blink on the first word does.
function fakeEye() {
    const handlers = {};
    return {on: (name, f) => { (handlers[name] = handlers[name] || []).push(f); }, off: (name, f) => { handlers[name] = (handlers[name] || []).filter(x => x !== f); },
        emit: name => (handlers[name] || []).slice().forEach(f => f()), count: () => Object.values(handlers).reduce((n, l) => n + l.length, 0)};
}

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

const bodyHarness = (db, over = {}) => harness(Object.assign({animDB: db.animDB, expression: db.expression, config: Object.assign({expressionWaitMs: 0, silenceSeconds: 60}, over.config || {}),
    classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'none'}) : over.classify(line)}, over.harness || {}));
const sayTwoLines = async (h, text) => {
    h.talk.choose = label => label === 'surprised' ? 'excited_01' : null;
    h.talk.player.moves = name => name === 'excited_01';
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won');
    reply(h, 'r1', text);
};

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

// A turn's words with item ids, as the server sends them (D90).
function heardTurn(h, item) {
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'input_audio_buffer.committed', item_id: item});
}
const words = (h, item, transcript) => h.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript});

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

// ---- petting and whom Jibo sees (D144, D145) ----
const LEFT = [true, false, false, false, false, false], BACK = [false, false, false, false, false, true];
// An animation database that also answers the emotion system's petting query.
function petDB(ms = 60) {
    const db = fakeAnimDB({}, ms), queries = [];
    db.animDB.query = q => { queries.push(q); return {matching: q.category.toLowerCase() === 'touch' ? [{name: 'rub_head_l_01'}] : [{name: 'laughter_01'}]}; };
    return Object.assign(db, {queries});
}
const emotion = {asked: [], reactToHeadTouch(pads) { this.asked.push(pads); return pads[5] && !pads[0] ? {category: 'laughing', includeMeta: []} : {category: 'Touch', includeMeta: ['rub-left']}; }};
const notesSent = h => h.sent.filter(e => e.type === 'conversation.item.create' && e.item.role === 'system').map(e => e.item.content[0].text);
const touchLogs = h => h.logs.filter(e => e.kind === 'touch');

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
    assert.equal(off.talk.presence, undefined);
    off.talk.lookAround();
    assert.equal(notesSent(off).length, 0);
    off.talk.close();
});

test('instructions: with presence the setup says Jibo sees only who the notes name, and memory says the one person seen is probably the one talking', () => {
    assert.match(realtime.voiceSetup(null, null), /You cannot see the room yet/);
    assert.match(realtime.voiceSetup(null, null, {presence: true}), /You see only who the notes name, and in this voice mode/);
    assert.match(realtime.voiceSetup({apps: [], config: {}}, null, {presence: true}), /You see only who the notes name\. /);
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

// ---- BEam 3.2.0 permissions: a blocked call throws an error that names the permission ----
const BLOCKED = name => Error('@be/noggin needs the ' + name + ' permission to do this');

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
    h.talk.leave('test');
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

// ---- Dutch through the Dutch Voice skill (D169-D174) ----
// A stand-in for global.dutchVoiceService: speak() runs the caller's own speech call, as the skill does.
function dutchVoice(over = {}) {
    const v = {calls: [], cancels: 0, isReady: over.ready !== false};
    global.dutchVoiceService = {
        apiVersion: 1, version: '0.1.0', languages: ['nl'],
        ready: () => v.isReady,
        status: () => ({state: v.isReady ? 'ready' : 'starting', reason: null}),
        speak(fn, options) { v.calls.push(options); return over.refuse ? Promise.reject(Error(over.refuse)) : Promise.resolve().then(fn); },
        cancel() { v.cancels++; }
    };
    return v;
}
function deltas(h, id, parts) {
    h.emit({type: 'response.created', response: {id}});
    for (const delta of parts) h.emit({type: 'response.output_text.delta', response_id: id, delta});
    h.emit({type: 'response.done', response: {id, status: 'completed'}});
}

test('Dutch: a reply labelled [nl] is said through the Dutch voice, label never said, Noggin\'s emoji at the Dutch word (D176); the log keeps the language', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: 'Hoi!', emoji: true}});
        assert.equal(h.said[0], 'Hoi!');
        assert.equal(v.calls.length, 1, 'the greeting went through the Dutch voice too');
        youSay(h, 'Hoi Jibo, ik heb een hond');
        reply(h, 'r1', '[nl] Wat leuk, een hond! Hoe heet hij?');
        await untilListening(h);
        assert.match(h.said[1], /^Wat leuk, een <es name='[A-Za-z0-9_-]+' nonBlocking='true'\/>hond!$/, 'the dog emoji, just before "hond"');
        assert.ok(catalog.EMOJI.dog.includes(/name='([^']+)'/.exec(h.said[1])[1]));
        assert.equal(h.said[2], 'Hoe heet hij?');
        assert.equal(v.calls.length, 3);
        assert.ok(v.calls.every(c => c.limitMs > 0));
        assert.ok(h.rules.slice(1).every(r => r && r.hotWords === false), 'speech\'s English keyword rules stay off');
        const spoken = h.logs.filter(e => e.kind === 'speak' && e.turn === 1);
        assert.deepEqual(spoken.map(e => e.language), ['nl', 'nl']);
        const jibo = h.logs.find(e => e.kind === 'jibo');
        assert.equal(jibo.text, 'Wat leuk, een hond! Hoe heet hij?');
        assert.equal(jibo.language, 'nl');
        h.talk.leave('test'); await h.talk.done;
        assert.deepEqual(h.logs.find(e => e.kind === 'session_end').lines, {nl: 3, en: 0});
    } finally { delete global.dutchVoiceService; }
});

test('Dutch: a reply labelled [en] is said by the English voice; one without a label in the conversation\'s language; a label split over deltas still counts', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}});
        youSay(h, 'Hello Jibo');
        reply(h, 'r1', '[en] Hello there!');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Hello there!');
        assert.equal(v.calls.length, 0, 'English goes the usual way');
        youSay(h, 'Hoe gaat het?');
        reply(h, 'r2', 'Prima, dank je.');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Prima, dank je.');
        assert.equal(v.calls.length, 1);
        youSay(h, 'En jij?');
        deltas(h, 'r3', ['[', 'n', 'l]', ' Goed hoor.']);
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Goed hoor.');
        assert.equal(v.calls.length, 2);
        h.talk.leave('test'); await h.talk.done;
        assert.deepEqual(h.logs.find(e => e.kind === 'session_end').lines, {nl: 2, en: 1});
    } finally { delete global.dutchVoiceService; }
});

test('Dutch asked for but the Dutch voice not ready: English from the start, the unedited greeting in English, and Jibo says why once', async () => {
    dutchVoice({ready: false});
    try {
        const h = await listening({config: {language: 'nl', greeting: 'Hoi!'}});
        assert.equal(h.talk.language, 'en');
        assert.equal(h.said[0], 'Hi!');
        assert.match(h.said[1], /My Dutch voice isn't ready/);
        assert.equal(h.logs.find(e => e.kind === 'session').dutch_missing, 'not_ready');
        h.talk.leave('test');
    } finally { delete global.dutchVoiceService; }
    const h2 = await listening({config: {language: 'nl', greeting: 'Hallo allemaal'}});
    assert.equal(h2.said[0], 'Hallo allemaal', 'an edited greeting is said as written');
    assert.equal(h2.logs.find(e => e.kind === 'session').dutch_missing, 'missing');
    h2.talk.leave('test');
});

test('Dutch voice refusing mid-conversation: the line is not said in English, Jibo says so once, the model is told, and English follows (D172)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}});
        v.isReady = false;
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        youSay(h, 'Vertel eens wat');
        reply(h, 'r1', '[nl] Er was eens een robot. Hij heette Jibo.');
        await untilListening(h);
        assert.deepEqual(h.said, ["Sorry, my Dutch voice isn't working right now. Let's go on in English."], 'no Dutch words in the English voice');
        assert.equal(h.talk.language, 'en');
        const note = h.sent.find(e => e.type === 'conversation.item.create' && e.item.role === 'system' && /Dutch voice is not working/.test(e.item.content[0].text));
        assert.ok(note, 'the model is told');
        assert.ok(h.logs.some(e => e.kind === 'voice_switch' && e.reason === 'dutch_voice_not_ready'));
        assert.equal(h.logs.filter(e => e.kind === 'dutch_refused').length, 2);
        youSay(h, 'Okay');
        reply(h, 'r2', 'Sure, in English then.');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Sure, in English then.');
        assert.equal(h.said.filter(t => /Dutch voice isn't working/.test(t)).length, 1, 'said once');
        h.talk.leave('test');
    } finally { delete global.dutchVoiceService; }
});

test('Dutch: closing while a Dutch line is said ends it in the Dutch voice too', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}, speakMs: 400});
        youSay(h, 'Vertel eens');
        reply(h, 'r1', '[nl] Dit is een lange zin.');
        for (let i = 0; i < 100 && !h.talk.dutchLines; i++) await sleep(5);
        assert.equal(h.talk.dutchLines, 1);
        h.talk.close('test');
        assert.equal(v.cancels, 1);
        await sleep(5);
        assert.ok(h.jibo.stopped, 'and Jibo\'s speech');
    } finally { delete global.dutchVoiceService; }
});

test('Dutch: fixed lines follow the conversation language; stop phrases in Dutch end it', async () => {
    dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}, notice: {line: 'budget', emoji: null}});
        assert.match(h.said[0], /^Let op: mijn denkgeld/);
        for (const s of ['Doei!', 'oké doei Jibo', 'Tot ziens.', 'Hoi Jibo, stoppen.', 'Dat was het voor nu']) assert.ok(ttsText.isStop(s), s);
        for (const s of ['Dag!', 'Tot morgen dan maar weer iets anders']) assert.ok(!ttsText.isStop(s), s);
        h.talk.leave('test');
    } finally { delete global.dutchVoiceService; }
});

test('Dutch instructions ask for a language label on every reply; English ones stay as they were', () => {
    const p = settings.persona(null);
    const nl = realtime.instructions(p.soul, p.identity, null, null, null, 'nl');
    assert.match(nl, /Start every reply with \[nl\] when it is in Dutch or \[en\] when it is in English/);
    assert.match(nl, /other than the language label described below/);
    assert.match(nl, /write numbers, times, dates and abbreviations as Dutch words/);
    assert.match(nl, /Tool results are for you only and mostly in English: after one, keep answering in the language you were speaking/, 'D177');
    const en = realtime.instructions(p.soul, p.identity);
    assert.match(en, /always answer in English/);
    assert.doesNotMatch(en, /\[nl\]/);
    assert.match(realtime.englishNote(), /start every reply with \[en\]/);
    assert.equal(ttsText.speechText('Groep 3–5'), 'Groep 3 to 5');
    assert.equal(ttsText.speechText('Groep 3–5', 'nl'), 'Groep 3 tot 5');
});

test('Dutch voice refusing before OpenAI is connected (the greeting): the English line, and the model is told once the session is set up (D175)', async () => {
    const v = dutchVoice();
    global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
    try {
        const h = await listening({config: {language: 'nl', greeting: 'Hoi!'}});
        assert.deepEqual(h.said.slice(0, 2), ['Hi!', "Sorry, my Dutch voice isn't working right now. Let's go on in English."], 'the unedited greeting falls back to its English twin');
        const notes = h.sent.filter(e => e.type === 'conversation.item.create' && /Dutch voice is not working/.test(JSON.stringify(e)));
        assert.equal(notes.length, 1, 'sent once, after session.updated');
        assert.ok(h.sent.indexOf(notes[0]) > h.sent.findIndex(e => e.type === 'session.update'));
        h.talk.leave('test');
    } finally { delete global.dutchVoiceService; }
});

test('trouble during a Dutch line: the line still playing is ended and the reason is said; refused, in English (D175)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}, diagnose: () => Promise.resolve({cause: 'no_internet'})});
        // The Dutch line hangs past the 6 s wait for quiet; other lines are quick.
        h.jibo.embodied.speech.speak = esml => { h.said.push(esml); return /lange/.test(esml) ? new Promise(() => {}) : sleep(20); };
        youSay(h, 'Vertel eens');
        reply(h, 'r1', '[nl] Een lange zin.');
        for (let i = 0; i < 100 && !h.talk.dutchLines; i++) await sleep(5);
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_busy'));
        h.talk.fail(Object.assign(Error('OpenAI: down'), {openai: true}));
        await h.talk.done;
        assert.ok(v.cancels >= 1, 'the Dutch line was ended');
        assert.match(h.said.at(-1), /I can't reach the internet right now/);
    } finally { delete global.dutchVoiceService; }
});

test('a refused Dutch dance announcement: the dance without words, and the English line right after (D175)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: {}});
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        const result = await h.talk.dance('dans eens', 1);
        assert.equal(result.announced, true);
        assert.match(h.said.at(-2), /^<anim name='[^']+' endNeutral='true'\/>$/, 'the dance alone');
        assert.match(h.said.at(-1), /Dutch voice isn't working/);
        h.talk.leave('test');
    } finally { delete global.dutchVoiceService; }
});

test('a dance in a Dutch conversation: the announcement in the Dutch voice, the tool result names it in Dutch (D177)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: fakeActions()});
        await youSay(h, 'doe de robot');
        callReply(h, 'd1', '', [['dance', {}, 'call_dance_1']]);
        await until(() => h.sent.filter(e => e.type === 'response.create').length >= 1);
        reply(h, 'f1', '[nl] Dat was leuk!');
        await untilListening(h);
        assert.match(h.said[0], /^Robotstand: aan! <anim name='[A-Za-z0-9_]+' endNeutral='true'\/>$/);
        assert.equal(v.calls.length, 2, 'the announcement and the follow-up both went through the Dutch voice');
        assert.equal(danceOutput(h).dance, 'de robot');
        assert.equal(catalog.danceName('waltz', 'nl'), 'een wals'); assert.equal(catalog.danceName(null, 'nl'), 'een dans');
        assert.equal(catalog.danceName('waltz'), 'a waltz');
        h.talk.leave('test');
    } finally { delete global.dutchVoiceService; }
});

test('a dance after an [en] reply in a Dutch conversation: English announcement and name; after a refused Dutch one, the name in English (D177)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: fakeActions()});
        await youSay(h, 'do the robot');
        callReply(h, 'd1', '[en] Sure!', [['dance', {}, 'call_dance_1']]);
        await until(() => h.sent.filter(e => e.type === 'response.create').length >= 1);
        reply(h, 'f1', '[en] That was fun!');
        await untilListening(h);
        assert.ok(h.said.some(e => /^Robot mode: on! <anim name=/.test(e)), h.said.join(' | '));
        assert.equal(danceOutput(h).dance, 'the robot');
        h.talk.leave('test');
        const r = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: {}});
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        const played = await r.talk.dance('doe de robot', 1);
        assert.equal(played.language, 'en', 'the conversation switched to English');
        assert.equal(catalog.danceName(played.style, played.language), 'the robot');
        r.talk.leave('test');
    } finally { delete global.dutchVoiceService; }
});

test('line counts hold only lines that were said (D171)', async () => {
    dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}});
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        youSay(h, 'Hoi');
        reply(h, 'r1', '[nl] Hallo daar.');
        await untilListening(h);
        h.talk.leave('test'); await h.talk.done;
        assert.deepEqual(h.logs.find(e => e.kind === 'session_end').lines, {nl: 0, en: 1});
    } finally { delete global.dutchVoiceService; }
});
