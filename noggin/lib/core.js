// SPDX-License-Identifier: MIT
// Noggin: pure helpers. Microphone samples to the realtime API's PCM16 24 kHz
// base64, the realtime session settings, reply text to Jibo speech, the expression
// whitelist, classifier requests and limits, the voice persona and stop phrases.
// No robot or network access. Runs on the robot's Node 6 / Chrome 53: ES2015 only.
'use strict';
const actions = require('./actions');
// catalog.json (tools/expression-catalog.mjs): mood -> {small, big}, the animations that fit
// each mood; emoji: word -> the eye emoji that show it.
const CATALOG = require('./catalog.json').moods, EMOJI = require('./catalog.json').emoji;
// dances: style -> {words, list}, Jibo's dances with their own music (danceChoice, pickDance).
const DANCES = require('./catalog.json').dances || {};

const RATE = 24000;

// The moods the decision model picks from, and when each fits. Noggin plays a random animation
// of the mood and size from catalog.json (pickAnimation). The dance plays on its own, with its
// music, and only on request.
const MOODS = {
    happy: 'glad, excited, good news',
    sad: 'sad news, feeling down',
    surprised: 'really unexpected, startled, "no way!"',
    scared: 'scared, spooky, frightened, "eek!"',
    laugh: 'a really funny joke, big laugh',
    confused: 'puzzled, did not understand, "come again?"',
    thinking: 'pondering, "let me think", "hmm"',
    yes: 'agreeing, "yes", "exactly", "sure"',
    no: 'disagreeing, refusing, "no", "nope"',
    heart: 'love, deep affection, "I love you", heartfelt thanks (a heart on his eye)',
    dance: 'only when the person asks Jibo to dance',
    content: 'calm, pleased, cosy, "that sounds nice"',
    proud: 'proud, confident, showing off a little',
    giggle: 'a small chuckle, light humour, a pun',
    sorry: 'oops, apologising, a small mistake',
    worried: 'concerned, unsure, nervous about something',
    embarrassed: 'shy, awkward, a little embarrassed',
    blush: 'flattered by a compliment, touched',
    frustrated: 'annoyed, "ugh", things not working',
    relieved: 'phew, relieved, tired',
    dontknow: '"I don\'t know", no idea, a shrug',
    curious: 'asking a question back, curious, interested',
    idea: 'a bright idea, a suggestion (a lightbulb on his eye)',
    gotit: 'understood, "got it", "okay, done"',
    welcome: '"you\'re welcome", "no problem", polite reply to thanks',
    hello: 'greeting someone, "hi", "nice to see you"',
    goodbye: 'saying goodbye, "see you", "good night"',
    love: 'sweet, romantic, adorable, "aww"',
    thumbsup: 'approval, "great choice", "good job", "nice" (a thumbs up on his eye)',
    celebrate: 'celebrations, birthdays, big news, congratulations (fireworks, a party or a trophy on his eye)',
    clap: 'applause, "well done", "bravo" (clapping hands on his eye)'
};
const DANCE = 'dance_funk_02';   // 175 frames, with its own music; the dance when catalog.json has none (pickDance)

// Animations Noggin plays itself, outside the decision model's choice: the greeting's eye-only
// smile (a body move would add 1.5–2 s to "Hi!" when played inside the speech).
const EXTRA = {smile: 'eye_happy_00'};
function animFor(label) { return !label ? null : EXTRA[label] || (label === 'dance' ? DANCE : null); }
// A random animation of `mood` in `size` ('small' or 'big'; anything else: either), not one of
// options.recent (names). options.led: animations with an LED layer may play (only with their
// LED channels removed, expressionPlay animdb). The other size when one has none.
function pickAnimation(mood, size, options) {
    options = options || {};
    const entry = CATALOG[mood], recent = options.recent || [], random = options.random || Math.random;
    if (!entry) return animFor(mood);
    const usable = list => (list || []).filter(a => options.led || !a.led);
    const both = usable(entry.small).concat(usable(entry.big));
    let pool = size === 'small' || size === 'big' ? usable(entry[size]) : both;
    if (!pool.length) pool = both;
    if (!pool.length) return null;
    const fresh = pool.filter(a => recent.indexOf(a.n) < 0), from = fresh.length ? fresh : pool;
    return from[Math.min(from.length - 1, Math.floor(random() * from.length))].n;
}
// ---- dances ----
// Which dance: the person's words decide (approach "keywords, otherwise random"); the model only
// decides that Jibo dances. danceChoice(text): {again} for "again", "the same one", "one more
// time"; {style} when the words name a style (funk, robot, twerk, a slow dance, ...; with two
// styles named, one of them at random); {} otherwise ("dance for me", "another one": random).
const DANCE_AGAIN = / (?:again|encore|same one|same dance|that one|one more time) /;
function danceWords(text) { return ' ' + String(text || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim() + ' '; }
function danceChoice(text, random) {
    const words = danceWords(text), choice = {};
    random = random || Math.random;
    if (DANCE_AGAIN.test(words)) choice.again = true;
    const named = Object.keys(DANCES).filter(style => DANCES[style].words.some(w => words.indexOf(' ' + w + ' ') >= 0));
    if (named.length) choice.style = named[Math.min(named.length - 1, Math.floor(random() * named.length))];
    return choice;
}
// Every dance once (a dance may sit in more than one style), and the styles it sits in.
function allDances() {
    const seen = {}, list = [];
    Object.keys(DANCES).forEach(style => DANCES[style].list.forEach(a => { if (!seen[a.n]) { seen[a.n] = true; list.push(a); } }));
    return list;
}
function danceStyles(name) { return Object.keys(DANCES).filter(style => DANCES[style].list.some(a => a.n === name)); }
// A random dance of `style` (none or unknown: any of them), not one of options.recent (names)
// when there is another. DANCE when the catalogue has no dances.
function pickDance(style, options) {
    options = options || {};
    const recent = options.recent || [], random = options.random || Math.random;
    const pool = style && DANCES[style] ? DANCES[style].list : allDances();
    if (!pool.length) return DANCE;
    const fresh = pool.filter(a => recent.indexOf(a.n) < 0), from = fresh.length ? fresh : pool;
    return from[Math.min(from.length - 1, Math.floor(random() * from.length))].n;
}
// What the dance is called (for the model: "what dance was that?") and what Jibo may say just
// before it (danceAnnounce). Plain words only: they go straight into ESML.
const DANCE_NAMES = {funk: 'a funk dance', pop: 'a pop dance', robot: 'the robot', techno: 'a techno dance', twerk: 'a twerk',
    belly: 'a belly dance', flamenco: 'a flamenco', country: 'a country dance', slow: 'a slow dance', calm: 'a calm, zen dance',
    silly: 'a silly dance', waltz: 'a waltz'};
const DANCE_LINES = {
    funk: ['Time to get funky!', 'Here comes the funk!', 'Feel the groove!'],
    pop: ['Here is my pop dance!', 'Pop star mode!', 'This one is catchy!'],
    robot: ['Here is my robot dance!', 'Robot mode: on!', 'Beep boop, robot dance!'],
    techno: ['Turn it up!', 'Time to rave!', 'Here is my techno dance!'],
    twerk: ['Watch me twerk!', 'Shake it!', 'Here is my twerk!'],
    belly: ['Here is my belly dance!', 'Belly dance time!', 'Watch these moves!'],
    flamenco: ['Ole!', 'Here is my flamenco!', 'A little flamenco!'],
    country: ['Yee haw!', 'Grab your boots!', 'Here is my country dance!'],
    slow: ['Here is a slow one.', 'Something smooth.', 'Time for a slow dance.'],
    calm: ['Something calm.', 'Very zen.', 'A peaceful little dance.'],
    silly: ['Here is a silly one!', 'This one is goofy!', 'Try not to laugh!'],
    waltz: ['May I have this dance?', 'Here is my waltz!', 'A little waltz!']
};
function danceName(style) { return DANCE_NAMES[style] || 'a dance'; }
function danceLine(style, random) {
    const lines = DANCE_LINES[style] || ['Here we go!'];
    return lines[Math.min(lines.length - 1, Math.floor((random || Math.random)() * lines.length))];
}
// Whether Jibo names the dance before it (the `danceAnnounce` setting): 'always'; 'off'; 'sometimes'
// (the default): only for a dance he picked himself (from 'random'), about one in three, and
// never twice within three dances (`since`: dances since the last announced one).
const ANNOUNCE_GAP = 3, ANNOUNCE_CHANCE = 1 / 3;
function danceAnnounce(mode, from, since, random) {
    if (mode === 'always') return true;
    if (mode === 'off') return false;
    return from === 'random' && since >= ANNOUNCE_GAP && (random || Math.random)() < ANNOUNCE_CHANCE;
}

const SIZES = [{value: 'small',description: 'subtle: a look, a small nod or something on his eye'},
    {value: 'big', description: 'a whole-body move, for strong or clear feelings'}];
const SIZE_INSTRUCTIONS = 'How big should the expression be? Small for mild feelings and ordinary moments, big only when the feeling is strong or the moment is special.';
// What the decision model reads for a mood: when it fits, and, for a mood with only one size of
// animation, which size it always is (so its size answer matches what Jibo can do).
function moodDescription(mood) {
    const entry = CATALOG[mood];
    const note = !entry ? '' : !entry.small.length ? ' (always a whole-body move)' : !entry.big.length ? ' (always small: on his eye or a small nod)' : '';
    return MOODS[mood] + note;
}
// The first word or two-word term of Jibo's line that has an eye emoji, not one of
// options.recent (words): {word, name} or null. Plurals find their singular ("dogs" -> dog).
function emojiFor(text, options) {
    options = options || {};
    const recent = options.recent || [], random = options.random || Math.random;
    const words = String(text || '').toLowerCase().replace(/[\u2019']s\b/g, '').split(/[^a-z]+/).filter(Boolean);
    const lookup = term => {
        if (recent.indexOf(term) >= 0) return null;
        if (EMOJI[term]) return term;
        const singular = term.replace(/(ies)$/, 'y').replace(/(ches|shes|xes|ses)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1');
        return singular !== term && EMOJI[singular] && recent.indexOf(singular) < 0 ? singular : null;
    };
    for (let i = 0; i < words.length; i++) {
        const found = (i + 1 < words.length && lookup(words[i] + ' ' + words[i + 1])) || lookup(words[i]);
        if (found) { const names = EMOJI[found]; return {word: found, name: names[Math.min(names.length - 1, Math.floor(random() * names.length))]}; }
    }
    return null;
}

// Float samples at `rate` -> mono Int16 at 24 kHz. Down-sampling averages the input
// samples each output sample covers (a box filter); up-sampling interpolates. `state`
// carries the position and partial sums across blocks, so block edges are seamless.
function toPcm24(samples, rate, state) {
    const step = rate / RATE, out = [];
    if (step < 1) {
        let pos = state.pos || 0, last = state.last || 0;
        for (; pos < samples.length; pos += step) {
            const i = Math.floor(pos), f = pos - i, a = i > 0 ? samples[i - 1] : last, b = samples[i];
            out.push(a + (b - a) * f);
        }
        state.pos = pos - samples.length;
        if (samples.length) state.last = samples[samples.length - 1];
    } else {
        let edge = state.edge === undefined ? step : state.edge, sum = state.sum || 0, count = state.count || 0;
        for (let n = 0; n < samples.length; n++) {
            sum += samples[n]; count++;
            if (n + 1 >= edge) { out.push(sum / count); sum = 0; count = 0; edge += step; }
        }
        state.edge = edge - samples.length; state.sum = sum; state.count = count;
    }
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) pcm[k] = Math.round(Math.max(-1, Math.min(1, out[k])) * 32767);
    return pcm;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Little-endian bytes of an Int16Array as base64, in plain JS (works the same in the
// simulator, whose Buffer is a shim, and in Chrome 53).
function base64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let out = '', i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) { const a = bytes[i] << 16; out += ALPHABET[a >> 18] + ALPHABET[(a >> 12) & 63] + '=='; }
    else if (rest === 2) { const b = (bytes[i] << 16) | (bytes[i + 1] << 8); out += ALPHABET[b >> 18] + ALPHABET[(b >> 12) & 63] + ALPHABET[(b >> 6) & 63] + '='; }
    return out;
}
function levelDb(samples) {
    let sq = 0;
    for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
    return 10 * Math.log(sq / (samples.length || 1) + 1e-12) / Math.LN10;
}

// The transcript is for the log and stop phrases; the hint stops "Jibo" becoming "Thibaut".
const TRANSCRIBE_HINT = 'A person talking to Jibo, a small social robot.';
// session.update for text-out voice turns (GA realtime schema).
// `tools`: the function tools Noggin offers (lib/actions.js), or none.
function sessionUpdate(config, instructions, tools) {
    const session = {
        type: 'realtime',
        output_modalities: ['text'],
        instructions: instructions,
        audio: {input: {
            format: {type: 'audio/pcm', rate: RATE},
            transcription: {model: config.transcribeModel, prompt: TRANSCRIBE_HINT},
            turn_detection: {type: config.turnDetection}
        }}
    };
    if (tools && tools.length) { session.tools = tools; session.tool_choice = 'auto'; }
    return {type: 'session.update', session: session};
}
function textDelta(event) {
    return event && (event.type === 'response.output_text.delta' || event.type === 'response.text.delta') ? String(event.delta || '') : null;
}

// Where the first complete sentence of `text` ends (after its punctuation), or -1. A
// sentence end is . ! ? or an ellipsis, optionally closing quotes/brackets, then space.
function firstSentenceEnd(text) {
    const match = /[.!?…]+["'’”)\]]*\s/.exec(text);
    return match ? match.index + match[0].length - 1 : -1;
}
// Plain words for Jibo's TTS: drop markdown, symbols that read badly and any
// bracketed markers, escape what the speech engine reads as markup.
function speechText(text) {
    return String(text).replace(/```[\s\S]*?```/g, ' ').replace(/\[[a-z]{2,12}\]/gi, ' ').replace(/[*`#_~|\\{}]/g, '')
        .replace(/\s+/g, ' ').trim()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Text -> pieces of at most `max` characters, split after sentences, then words.
function chunks(text, max) {
    max = max || 450;
    const out = [];
    let rest = String(text).replace(/\s+/g, ' ').trim();
    while (rest.length > max) {
        const head = rest.slice(0, max);
        let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
        if (cut < max / 3) cut = head.lastIndexOf(' ');
        if (cut < 1) cut = max - 1;
        out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
}
// One animation by name, played alongside the words that follow it.
function animEsml(name) { return /^[A-Za-z0-9_-]+$/.test(name || '') ? "<anim name='" + name + "' nonBlocking='true' endNeutral='true'/>" : ''; }
function esml(text, label) { return (animFor(label) ? animEsml(animFor(label)) : '') + speechText(text); }

// ---- expressions ----
const CLASSIFIER_SYSTEM = 'You pick the body or eye expression Jibo, a small friendly social robot, performs while saying a line. ' +
    'Answer "none" for plain, factual or neutral lines; choose an expression only when the line clearly carries that feeling or moment. ' +
    'Prefer the most specific fitting expression. Also give its size: small (subtle: a look, a small nod or something on his eye) ' +
    'or big (a whole-body move, only for strong feelings or special moments). The expressions:\n' +
    Object.keys(MOODS).map(name => name + ': ' + moodDescription(name)).join('\n');
// Jibo's quick reaction the moment he has heard the person, before he answers. The
// dance (music, 6 s) is never a reaction.
const REACTION_INSTRUCTIONS = 'Jibo, a small friendly social robot, has just heard what the person said and is about to answer. ' +
    'Pick the quick expression he shows right away, the way a person reacts on their face before replying. ' +
    'Choose "none" when the words carry no particular feeling (a plain question or statement); thinking only for questions that need some thought.';
const LINE_INSTRUCTIONS = 'Pick the expression Jibo, a small friendly social robot, performs while saying this line. ' +
    'Choose "none" for plain, factual or neutral lines; choose an expression only when the line clearly carries that feeling or moment. Prefer the most specific fitting expression.';
const REACTION_SYSTEM = REACTION_INSTRUCTIONS + ' person_said is what they said; jibo_says is empty. ' +
    'Also give its size: small (subtle) or big (a whole-body move, only for strong feelings). The expressions:\n' +
    Object.keys(MOODS).filter(n => n !== 'dance').map(name => name + ': ' + moodDescription(name)).join('\n');
function choices(kind) {
    return Object.keys(MOODS).filter(n => kind !== 'reaction' || n !== 'dance')
        .map(n => ({value: n, description: moodDescription(n)}))
        .concat([{value: 'none', description: 'no particular feeling: plain, factual or neutral'}]);
}
// OpenAI's Decisions API (POST /v1/decisions, gpt-6-luna): one choice question over a
// fixed set of values, answered with a confidence.
// withSize: a second question, how big (small or big).
function decisionsRequest(model, personSaid, jiboSays, kind, withSize) {
    const reaction = kind === 'reaction';
    const questions = [{type: 'choice', name: 'expression', instructions: reaction ? REACTION_INSTRUCTIONS : LINE_INSTRUCTIONS, choices: choices(kind)}];
    if (withSize) questions.push({type: 'choice', name: 'size', instructions: SIZE_INSTRUCTIONS, choices: SIZES});
    return {
        model: model,
        input: reaction ? 'The person just said to Jibo: ' + JSON.stringify(personSaid || '')
            : 'The person said: ' + JSON.stringify(personSaid || '') + '\nJibo now says: ' + JSON.stringify(jiboSays || ''),
        questions: questions
    };
}
// {label, confidence, size}. Below `minConfidence` a real expression counts as "none". size is
// 'small', 'big' or null (not asked, or no clear answer).
function decisionLabel(body, minConfidence) {
    const answers = body && Array.isArray(body.answers) ? body.answers : [];
    const answer = answers.filter(a => a && a.name === 'expression')[0], sized = answers.filter(a => a && a.name === 'size')[0];
    const size = sized && sized.type === 'choice' && (sized.choice === 'small' || sized.choice === 'big') ? sized.choice : null;
    if (!answer || answer.type !== 'choice') return {label: null, confidence: null, size: null};
    const label = answer.choice, confidence = typeof answer.confidence === 'number' ? answer.confidence : null;
    if (label !== 'none' && !MOODS[label]) return {label: null, confidence: confidence, size: null};
    if (label !== 'none' && confidence !== null && confidence < (minConfidence || 0)) return {label: 'none', confidence: confidence, below: label, size: null};
    return {label: label, confidence: confidence, size: label === 'none' ? null : size};
}
function classifierRequest(model, userText, jiboText, reasoning, kind) {
    const reaction = kind === 'reaction';
    const request = {
        model: model,
        input: [
            {role: 'system', content: reaction ? REACTION_SYSTEM : CLASSIFIER_SYSTEM},
            {role: 'user', content: JSON.stringify({person_said: userText || '', jibo_says: jiboText || ''})}
        ],
        text: {format: {type: 'json_schema', name: 'expression', strict: true, schema: {
            type: 'object', additionalProperties: false, required: ['expression', 'size'],
            properties: {expression: {type: 'string', enum: choices(kind).map(c => c.value)}, size: {type: 'string', enum: ['small', 'big']}}
        }}},
        max_output_tokens: 300,
        store: false
    };
    if (reasoning) request.reasoning = {effort: reasoning};
    return request;
}
function classifierLabel(body) {
    let text = body && typeof body.output_text === 'string' ? body.output_text : null;
    if (text === null && body && Array.isArray(body.output)) {
        body.output.forEach(item => (item.content || []).forEach(part => { if (part.type === 'output_text' && text === null) text = part.text; }));
    }
    let label;
    try { label = JSON.parse(text).expression; } catch (_) { return null; }
    return label === 'none' || MOODS[label] ? label : null;
}
function classifierSize(body) {
    let text = body && typeof body.output_text === 'string' ? body.output_text : null;
    if (text === null && body && Array.isArray(body.output)) {
        body.output.forEach(item => (item.content || []).forEach(part => { if (part.type === 'output_text' && text === null) text = part.text; }));
    }
    try { const size = JSON.parse(text).size; return size === 'small' || size === 'big' ? size : null; } catch (_) { return null; }
}
// At most one expression per `gapMs`, not the same one again within `repeatMs`, and dance only
// when the person mentioned dancing.
class ExpressionPolicy {
    constructor(gapMs, repeatMs) { this.gapMs = gapMs; this.repeatMs = repeatMs === undefined ? 15000 : repeatMs; this.lastAt = -Infinity; this.last = null; }
    allow(label, now, personSaid) {
        if (!label || label === 'none' || !MOODS[label]) return false;
        if (now - this.lastAt < this.gapMs || (label === this.last && now - this.lastAt < this.repeatMs)) return false;
        if (label === 'dance' && !/danc/i.test(personSaid || '')) return false;
        return true;
    }
    used(label, now) { this.last = label; this.lastAt = now; }
}

// ---- persona ----
// The persona as the person wrote it (SOUL, then IDENTITY); voiceSetup() adds what is true in
// this voice conversation after it.
function personaText(soul, identity) {
    const parts = [soul, identity].map(text => String(text || '').trim()).filter(Boolean);
    return parts.join('\n\n') || 'You are Jibo, the little social robot: curious, warm, playful and a bit silly.';
}
// now: a Date or actions.localTime() (Jibo's home timezone). abilities: null (no tools) or
// {apps: [names], config} when Noggin offers its tools (lib/actions.js); config's cloudSkills
// says which cloud tools are named. memory: null (off) or {learn, block}: block (lib/memory.js)
// goes after everything else and stays the same all session, so the prompt cache keeps it (D44).
function voiceSetup(now, abilities, memory) {
    const at = actions.describeTime(now);
    const memoryTools = !!(memory && abilities && abilities.config && abilities.config.memory === true);
    const notes = !memory ? ''
        : 'Your memory is the notes after this setup; never claim to remember something that is not in them. ' +
          (memory.learn ? 'After each conversation you keep a short note of it and the facts worth keeping, so what people tell you stays with you. ' : '') +
          (memoryTools ? 'When someone asks you to remember or forget something, use remember or forget; for an earlier conversation your notes do not cover, use recall. '
              : memory.learn ? '' : 'You cannot keep anything new yourself. ');
    const none = memory ? 'tools or files: never claim to look something up or do something you cannot. '
        : 'tools, files or saved memory: never claim to look something up, remember something for later, or do something you cannot. ';
    // Which tools, and who speaks for each, come from the tool table (lib/actions.js).
    const tools = abilities
        ? actions.rules(abilities.config) +
          'Never say something is done unless a tool result says so. For the time or date, always use get_time; ' +
          'for a question about yourself that the facts above do not answer, use about_jibo. ' + notes +
          'Apart from these you have no ' + none
        : notes + 'You cannot see the room yet, and in this voice mode you have no ' + none;
    return 'Your current setup:\n' +
        'You are in a spoken conversation on your physical Jibo body. You hear your person through your microphone, ' +
        'and every word you write is spoken aloud in your own voice, so write only words meant to be heard: ' +
        'no markdown, lists, emoji, bracketed markers or stage directions. Your face and body react on their own while you speak. ' +
        'Keep replies short, as your personality says. ' +
        'You understand English and Dutch; always answer in English. ' +
        (abilities ? 'You cannot see the room yet. ' : '') + tools +
        'When the session started it was ' + at.date + ', ' + at.time + ' local time on the robot (the clock may be off if Jibo was offline). ' +
        'Your person ends the conversation by saying goodbye.';
}
function instructions(soul, identity, now, abilities, memory) {
    return personaText(soul, identity) + '\n\n' + voiceSetup(now, abilities, memory) + (memory && memory.block ? '\n\n' + memory.block : '');
}

// Back in Noggin after another skill did something: one system message with the conversation so
// far, what happened and, for the clock, what is true now, so the model carries on from there.
// resume: {pairs: [{you, jibo}], tool, args, said}; clock: actions.readClock() result or null.
// said: what Jibo already said on coming back (e.g. "Anything else?"), or '' to let the model speak.
function resumeNote(resume, clock, said) {
    const lines = (resume.pairs || []).map(p => (p.you ? 'Person: ' + p.you + '\n' : '') + (p.jibo ? 'Jibo: ' + p.jibo : '')).join('\n').slice(-6000);
    const args = resume.args || {}, tool = String(resume.tool || 'a tool');
    const timer = /_timer$|^check_clock$/.test(tool), alarm = /_alarm$|^check_clock$/.test(tool);
    const did = tool === 'get_time' ? 'get_time (the ' + (args.show === 'date' ? 'date' : 'time') + ')'
        : tool === 'set_timer' ? 'set_timer for ' + (args.duration || 'the time asked')
        : tool === 'set_alarm' ? 'set_alarm for ' + (args.time || 'the time asked')
        : (tool === 'use_skill' || tool === 'open_app') && args.name ? tool + ' (' + args.name + ')'
        : tool === 'picture' && args.subject ? 'picture (of ' + args.subject + ')' : tool;
    const who = timer || alarm || tool === 'get_time' ? 'your clock' : actions.CLOUD[tool] ? 'your cloud' : tool === 'open_app' ? 'that app' : 'that skill', Who = who.charAt(0).toUpperCase() + who.slice(1);
    let now = '';
    if (timer && clock && clock.timer) now += clock.timer.set ? 'A timer is now running with ' + clock.timer.remaining + ' left. ' : 'No timer is running now. ';
    if (alarm && clock && clock.alarm) now += clock.alarm.set ? 'Your alarm is now set for ' + clock.alarm.time + ', ' + clock.alarm.day + '. ' : 'No alarm is set now. ';
    return 'This is the conversation so far, in which you are Jibo:\n' + (lines || '(nothing yet)') + '\n\n' +
        'Then you used ' + did + ' and ' + who + ' took over. ' +
        (resume.said ? Who + ' said: "' + String(resume.said).slice(0, 600) + '". ' : '') + now +
        (said
            ? 'Now you are back in the conversation and have just said: "' + said + '". Wait for your person\'s answer; ' +
              'do not repeat what ' + who + ' already said, and do not claim anything the facts above do not show.'
            : 'Now you are back in the conversation. Continue in one short sentence, for example by asking whether there is anything else; ' +
              'do not repeat what ' + who + ' already said, and do not claim anything the facts above do not show.');
}

// Stop phrases, as BEam's Agent Mode recognises them (BSD-3, @be/be skills/agent/runtime.js).
const STOP = ['stop', 'stop chatting', 'stop talking', 'end conversation', 'cancel', 'goodbye', 'good bye', 'bye', 'bye bye', 'that is all', 'thats all'];
function isStop(text) {
    if (typeof text !== 'string') return false;
    let normalized = text.toLowerCase().replace(/[’']/g, '').replace(/[-_]/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    normalized = normalized.replace(/^(?:okay|ok|alright|well) /, '').replace(/^(?:hey )?jibo /, '').replace(/ jibo$/, '').replace(/ (?:then|now|for now)$/, '');
    return STOP.indexOf(normalized) >= 0;
}

module.exports = {RATE, MOODS, DANCE, EXTRA, CATALOG, EMOJI, DANCES, animFor, pickAnimation, danceChoice, danceStyles, pickDance, danceName, danceLine, danceAnnounce, moodDescription, emojiFor, toPcm24, base64, levelDb, sessionUpdate, textDelta, firstSentenceEnd, speechText, chunks, esml, animEsml,
    choices, decisionsRequest, decisionLabel, classifierRequest, classifierLabel, classifierSize, ExpressionPolicy, personaText, voiceSetup, instructions, resumeNote, isStop};
