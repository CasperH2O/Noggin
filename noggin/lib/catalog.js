// SPDX-License-Identifier: MIT
// Noggin: what Jibo can show. The moods the classifier picks from and the animations of each
// (catalog.json, made by tools/expression-catalog.mjs), his dances with their own music, the eye
// emoji for words in a line, and the policy for how often an expression may play.
// Pure: no I/O. Node 6 / Chrome 53: ES2015 only.
'use strict';
// catalog.json (tools/expression-catalog.mjs): mood -> {small, big}, the animations that fit
// each mood; emoji: word -> the eye emoji that show it.
const CATALOG = require('./catalog.json').moods, EMOJI = require('./catalog.json').emoji;
// dances: style -> {words, list}, Jibo's dances with their own music (danceChoice, pickDance).
const DANCES = require('./catalog.json').dances || {};

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
// options.recent (names); the other size when one has none. Clips with an LED layer play too:
// Noggin removes their LED channels (lib/expression.js).
function pickAnimation(mood, size, options) {
    options = options || {};
    const entry = CATALOG[mood], recent = options.recent || [], random = options.random || Math.random;
    if (!entry) return animFor(mood);
    const usable = list => list || [];
    const both = usable(entry.small).concat(usable(entry.big));
    let pool = size === 'small' || size === 'big' ? usable(entry[size]) : both;
    if (!pool.length) pool = both;
    if (!pool.length) return null;
    const fresh = pool.filter(a => recent.indexOf(a.n) < 0), from = fresh.length ? fresh : pool;
    return from[Math.min(from.length - 1, Math.floor(random() * from.length))].n;
}

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

// What the decision model reads for a mood: when it fits, and, for a mood with only one size of
// animation, which size it always is (so its size answer matches what Jibo can do).
function moodDescription(mood) {
    const entry = CATALOG[mood];
    const note = !entry ? '' : !entry.small.length ? ' (always a whole-body move)' : !entry.big.length ? ' (always small: on his eye or a small nod)' : '';
    return MOODS[mood] + note;
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

// Words that, within two words of an emoji word, mean something else ("apple" next to "iphone",
// "piece of cake", "rain check").
const EMOJI_CANCEL = {
    apple: ['computer', 'computers', 'iphone', 'ipad', 'mac', 'macbook', 'watch', 'company'],
    party: ['political', 'third', 'republican', 'democratic', 'labour', 'labor'],
    cake: ['piece'], pie: ['chart'], rain: ['check'], tree: ['family'], fire: ['away'],
    rocket: ['science'], space: ['personal', 'parking', 'storage', 'disk'],
    mouse: ['computer', 'click', 'keyboard'], bug: ['software', 'code', 'fix', 'computer'],
    turkey: ['country', 'istanbul', 'ankara']
};
// The first word or two-word term of Jibo's line that has an eye emoji, not one of
// options.recent (words): {word, name, said, nth} or null; `said` is the term as it is in the line
// (words) and `nth` how many times it came before (skipped as cancelled), to place the emoji
// there. Plurals find their singular ("dogs" -> dog).
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
    const cancelled = (term, from, to) => {
        const near = words.slice(Math.max(0, from - 2), to + 2);
        return (EMOJI_CANCEL[term] || []).some(w => near.indexOf(w) >= 0);
    };
    for (let i = 0; i < words.length; i++) {
        const pair = i + 1 < words.length ? lookup(words[i] + ' ' + words[i + 1]) : null;
        const found = pair && !cancelled(pair, i, i + 2) ? pair : lookup(words[i]);
        if (!found || (found !== pair && cancelled(found, i, i + 1))) continue;
        const names = EMOJI[found], said = words.slice(i, found === pair ? i + 2 : i + 1), term = said.join(' ');
        let nth = 0;
        for (let j = 0; j < i; j++) if (words.slice(j, j + said.length).join(' ') === term) nth++;
        return {word: found, name: names[Math.min(names.length - 1, Math.floor(random() * names.length))], said: said, nth: nth};
    }
    return null;
}

module.exports = {MOODS, DANCE, EXTRA, CATALOG, EMOJI, DANCES, animFor, pickAnimation, danceChoice, danceStyles, pickDance, danceName,
    danceLine, danceAnnounce, moodDescription, ExpressionPolicy, emojiFor};
