// SPDX-License-Identifier: MIT
// Shared fakes and helpers for the conversation tests (tests/conversation-*.test.mjs): a harness
// around lib/controller.js with fakes of Jibo, the realtime connection, the microphone and the
// classifier, and fakes for tools, the animation database, the cloud, the eye, petting and the Dutch voice.
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '../..');
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
// BEam's animation database, when this checkout sits in the jibo-resurrection workspace (or JIBO_ANIMDB).
const ANIMDB = process.env.JIBO_ANIMDB || path.resolve(source, '../../../original-assets/BEam/@be/be/node_modules/jibo-anim-db-animations/animdb.json');

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

// A jetstream whose hotword tokens record the order of events; `release` as given (default: at once).
function cloudJetstream(h, release) {
    const order = [];
    h.jibo.jetstream.setHotwordMode = () => { order.push('off'); return {activated: Promise.resolve(), release: () => { order.push('release'); return release ? release() : Promise.resolve(); }}; };
    return order;
}

// The eye's own events (jibo.face.eye): addAnimation when something starts on the screen,
// removeAnimation when it ends, as speech's blink on the first word does.
function fakeEye() {
    const handlers = {};
    return {on: (name, f) => { (handlers[name] = handlers[name] || []).push(f); }, off: (name, f) => { handlers[name] = (handlers[name] || []).filter(x => x !== f); },
        emit: name => (handlers[name] || []).slice().forEach(f => f()), count: () => Object.values(handlers).reduce((n, l) => n + l.length, 0)};
}

const bodyHarness = (db, over = {}) => harness(Object.assign({animDB: db.animDB, expression: db.expression, config: Object.assign({expressionWaitMs: 0, silenceSeconds: 60}, over.config || {}),
    classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'none'}) : over.classify(line)}, over.harness || {}));
const sayTwoLines = async (h, text) => {
    h.talk.choose = label => label === 'surprised' ? 'excited_01' : null;
    h.talk.player.moves = name => name === 'excited_01';
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won');
    reply(h, 'r1', text);
};

// A turn's words with item ids, as the server sends them (D90).
function heardTurn(h, item) {
    h.emit({type: 'input_audio_buffer.speech_started'});
    h.emit({type: 'input_audio_buffer.speech_stopped'});
    h.emit({type: 'input_audio_buffer.committed', item_id: item});
}
const words = (h, item, transcript) => h.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript});

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

const BLOCKED = name => Error('@be/noggin needs the ' + name + ' permission to do this');

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

export {source, audio, catalog, ttsText, labels, realtime, actions, Conversation, settings, openai, ConversationLog, Microphone, ExpressionPlayer, memoryLib, DEFAULTS, sleep, ANIMDB, harness, clips, untilListening, listening, youSay, reply, fakeSpawn, pcmBytes, callReply, fakeActions, until, DANCE_NAMES, dancesIn, playedDances, danceOutput, danceTurn, DOFS, fakeAnimDB, cloudJetstream, fakeEye, bodyHarness, sayTwoLines, heardTurn, words, LEFT, BACK, petDB, emotion, notesSent, touchLogs, BLOCKED, dutchVoice, deltas, require};
