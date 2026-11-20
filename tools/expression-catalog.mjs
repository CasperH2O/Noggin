#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Builds noggin/lib/catalog.json: Noggin's moods, each with the animations from Jibo's
// animation database (jibo-anim-db-animations' animdb.json) that fit it, split by size.
//   node tools/expression-catalog.mjs [animdb.json]   (default: the BEam copy in this workspace)
//
// An animation qualifies when it has no sound of its own (it would clash with Jibo's voice),
// starts in the neutral pose, lasts at most MAX_FRAMES and is not a sound-only clip. One that
// ends off-neutral is fine: Noggin returns Jibo to neutral afterwards. One with an LED layer is
// marked: Noggin plays it only with its LED channels removed (expressionPlay animdb).
// Size: `small` is eye-only or at most SMALL_FRAMES long; `big` is a body move.
// It also holds an emoji index: word -> the eye emoji (pictures on Jibo's eye, no body move)
// that show it, from each emoji's meta terms and name. Noggin shows one when Jibo says the word.
// The file holds names, words and timing facts only, no animation data.
import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve(import.meta.dirname, '..');
const DEFAULT_DB = path.resolve(source, '../../../original-assets/BEam/@be/be/node_modules/jibo-anim-db-animations/animdb.json');
const MAX_FRAMES = 120, SMALL_FRAMES = 40;

// mood -> the animation database categories it draws from, extra animations by name, and names left out by hand (posture shifts, slow "no" headshakes,
// near-duplicates that belong to another mood). What each mood means for the decision model
// is in noggin/lib/core.js (EXPRESSIONS).
export const MOODS = {
    happy: {categories: ['happy', 'excited'], exclude: ['content_01', 'shift_15', 'success_01']},
    content: {names: ['content_01', 'eye_happy_00', 'eye_happy_01', 'eye_happy_02']},
    proud: {categories: ['proud']},
    laugh: {names: ['Laughter_04', 'laughter_03']},
    giggle: {names: ['laughter_01', 'laughter_02']},
    surprised: {categories: ['surprised'], exclude: ['scared_00']},
    scared: {categories: ['scared'], exclude: ['Emoji_ExclamationBlue', 'Emoji_ExclamationYellow']},
    sad: {categories: ['sad']},
    sorry: {categories: ['sorry', 'oops'], exclude: ['dont_understand_02', 'no_4']},
    worried: {categories: ['worried'], exclude: ['scared_00']},
    embarrassed: {categories: ['embarrassed']},
    blush: {names: ['blush_01', 'blush_02', 'blush_03', 'blush_04']},
    frustrated: {categories: ['frustrated'], exclude: ['shift_09']},
    relieved: {categories: ['relieved', 'tired']},
    thinking: {categories: ['thinking']},
    confused: {categories: ['confused'], exclude: ['Emoji_Question', 'Curious_01', 'Curious_02']},
    dontknow: {categories: ['dontknow'], exclude: ['dont_understand_02', 'no_4']},
    curious: {categories: ['question', 'curious'], exclude: ['Puzzled_01', 'Puzzled_02']},
    idea: {names: ['Emoji_Lightbulb']},
    yes: {names: ['yep_01', 'yep_02', 'yep_03', 'yep_04']},
    no: {names: ['Nope_00', 'Nope_01', 'Nope_02', 'Nope_03']},
    gotit: {names: ['GotIt_01', 'GotIt_02', 'Emoji_Checkmark', 'emoji-checkmark-hf-01']},
    welcome: {names: ['Youre_Welcome_01', 'Youre_Welcome_02']},
    hello: {categories: ['greeting']},
    goodbye: {categories: ['goodbye']},
    heart: {names: ['Emoji_HeartRed', 'Emoji_HeartRed2', 'Emoji_HeartBlue', 'emoji-heart-hf-01']},
    love: {names: ['Emoji_HeartArrow', 'emoji-arrow-heart-hf-01', 'affection_01', 'affection_02', 'affection_03', 'affection_04']},
    thumbsup: {names: ['Emoji_ThumbsUp']},
    celebrate: {names: ['Emoji_Fireworks', 'Emoji_PartyPink', 'emoji-party-hf-01', 'emoji-balloons-hf-01', 'Emoji_Trophy', 'Emoji_Star']},
    clap: {names: ['Emoji_Clap']}
};

// Dance styles: the dances with their own music (category dance, hasAudio), grouped by style,
// each with the words that ask for it ("do the robot", "a slow dance"). Noggin plays a dance of the
// style the person names, otherwise any of them (core.danceChoice / pickDance). A dance may sit in
// more than one style; every dance with music must sit in at least one. Words are lower case and
// matched as whole words or phrases; keep them specific ("house" alone would catch "around the house").
export const DANCES = {
    funk: {names: ['BBox_Music_Dance_01', 'dance_funk_00', 'dance_funk_01', 'dance_funk_02'],
        words: ['funk', 'funky', 'groove', 'groovy', 'beatbox', 'beat box', 'reggae', 'motown', 'disco', 'boogie']},
    pop: {names: ['dance_pop_00', 'dance_funk_02', 'dance_techno_02'], words: ['pop', 'pop music', 'happy dance', 'cheerful']},
    robot: {names: ['Robotic_music_dance_01', 'dance_circuit_saver_00', 'dance_funk_03'],
        words: ['robot', 'robotic', 'robot dance', 'the robot', 'dubstep', 'dub step', 'video game', 'arcade']},
    techno: {names: ['electronic_house_music_dance_01', 'electronic_techno_music_dance_01', 'dance_techno_00', 'dance_techno_01', 'dance_techno_02'],
        words: ['techno', 'electronic', 'house music', 'edm', 'rave', 'trance']},
    twerk: {names: ['dance_twerk_00', 'Twerking_music_dance_01'], words: ['twerk', 'twerking', 'booty']},
    belly: {names: ['Belly_Dancing_music_dance_01', 'Belly_Dancing_music_dance_02', 'Belly_Dancing_music_dance_03'],
        words: ['belly', 'belly dance', 'belly dancing', 'middle eastern']},
    flamenco: {names: ['Flamenco_music_dance_01', 'dance_flamenco_guitar_00'], words: ['flamenco', 'spanish', 'spain', 'salsa']},
    country: {names: ['country_music_dance_01'], words: ['country', 'cowboy', 'rockabilly', 'hoedown', 'line dance', 'line dancing']},
    slow: {names: ['Groovy_music_dance_01', 'dance_smooth_jazz_00', 'Smooth_Jazz_music_dance_01'],
        words: ['slow', 'slowly', 'slow dance', 'smooth', 'jazz', 'jazzy', 'romantic']},
    calm: {names: ['dance_japanese_water_garden_00'], words: ['calm', 'relaxing', 'relaxed', 'zen', 'peaceful', 'meditation', 'japanese']},
    silly: {names: ['dance_funny_00', 'dance_funny_01'], words: ['silly', 'funny', 'goofy', 'weird']},
    waltz: {names: ['Waltz_01_01'], words: ['waltz', 'ballroom', 'classical']}
};
export function buildDances(db) {
    const byName = new Map(Object.values(db).map(a => [a.name, a])), dances = {}, problems = [], placed = new Set(), seen = new Map();
    for (const [style, spec] of Object.entries(DANCES)) {
        const list = [];
        for (const name of spec.names) {
            const a = byName.get(name);
            if (!a) { problems.push('dance ' + style + ': no animation ' + name); continue; }
            if (!a.categories.includes('dance') || !a.hasAudio) { problems.push('dance ' + style + ': ' + name + ' is not a dance with music'); continue; }
            list.push({n: a.name, f: a.duration, led: !!a.layers.LED}); placed.add(name);
        }
        for (const word of spec.words) {
            if (word !== word.toLowerCase().trim()) problems.push('dance ' + style + ': word "' + word + '" is not lower case');
            if (seen.has(word)) problems.push('dance word "' + word + '" is in ' + seen.get(word) + ' and ' + style);
            seen.set(word, style);
        }
        dances[style] = {words: spec.words, list: list};
    }
    for (const a of Object.values(db)) if (a.categories.includes('dance') && a.hasAudio && !placed.has(a.name)) problems.push('dance with music in no style: ' + a.name);
    return {dances, problems};
}

// Words too common or too abstract to show a picture for (and the database's own tags).
const EMOJI_STOP = new Set(('eye-only hf hot-frame emoji blink blink-to-reveal quick short medium long food animal nature sports weather holiday ' +
    'celebration transportation technology fast-food meal snack eat drink hot cold warm blue red green yellow white pink purple orange black brown bright ' +
    'night dark light art jibo cute sweet wow warning exclamation exclamation-mark punctuation hand hands love heart i-love-you valentines seasonal ' +
    'good bad new old time on off up down fun win default loop pop single double big small clear top can jack stand glass years life saver various ' +
    'activity game present show mark question-mark question unknown check checkmark star sparkle shine agree disagree yes sad hello goodbye thinking ' +
    'idea success left right late early open find run running power call ring fix wave slow soft strong smart heavy retro processing delete chill ' +
    'piece hope fight shock home wipe app cap tee fore bball hog pee poo potty searching treat fuel ' +
    // Words with another everyday meaning, or whose picture is something else (paper -> toilet
    // paper, machine -> robot), and the database's internal tags.
    'paper ice box chip punch cane thumb fork mac machine arrow cube holes ball bolt cream toast cheers water ' +
    'deal-with-it ib-idle-long-time ib-idle-short-time nye-ball-down nye-ball-up maracas-left maracas-right').split(' '));
// Words whose tag points at the wrong picture: word -> emoji (by name) it must not show.
const EMOJI_NOT = {dog: /hot.?dog/i, apple: /mac/i, computer: /mac128k/i, mouse: /cheese/i};
// word -> emoji names. Words are lower case; multi-word terms ("ice cream") keep their space.
export function emojiIndex(db) {
    const index = {};
    for (const a of Object.values(db)) {
        if (!a.categories.includes('emoji') || a.layers.Body || a.layers.LED || /prototype|test/i.test(a.name + ' ' + a.metaTerms.join(' ')) || fits(a).length) continue;
        const name = a.name.replace(/(-hf-\d+|_\d+)$/, '').replace(/^(Emoji_|emoji-)/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
        for (const raw of new Set([name, ...a.metaTerms])) {
            const word = raw.replace(/[-_]/g, ' ').trim().toLowerCase();
            if (word.length < 3 || /\d/.test(word) || /^emoji /.test(word) || EMOJI_STOP.has(word) || EMOJI_STOP.has(word.replace(/ /g, '-'))) continue;
            if (EMOJI_NOT[word] && EMOJI_NOT[word].test(a.name)) continue;
            (index[word] = index[word] || []).push(a.name);
        }
    }
    const sorted = {};
    for (const word of Object.keys(index).sort()) sorted[word] = [...new Set(index[word])].sort();
    return sorted;
}

function fits(a) {
    const why = [];
    if (a.hasAudio) why.push('sound');
    if (!a.startsNeutral) why.push('starts off-neutral');
    if (a.duration > MAX_FRAMES) why.push('longer than ' + MAX_FRAMES + ' frames');
    if ((a.metaTerms || []).some(m => m === 'ssa-only' || m === 'sfx-only')) why.push('sound-only');
    return why;
}

export function build(db) {
    const all = Object.values(db), byName = new Map(all.map(a => [a.name, a])), moods = {}, problems = [];
    for (const [mood, spec] of Object.entries(MOODS)) {
        const picked = new Map();
        for (const a of all) if ((spec.categories || []).some(c => a.categories.includes(c))) picked.set(a.name, a);
        for (const name of spec.names || []) {
            const a = byName.get(name);
            if (!a) { problems.push(mood + ': no animation ' + name); continue; }
            picked.set(name, a);
        }
        for (const name of spec.exclude || []) picked.delete(name);
        const small = [], big = [];
        for (const a of [...picked.values()].sort((x, y) => x.name.localeCompare(y.name))) {
            const why = fits(a);
            if (why.length) { if ((spec.names || []).includes(a.name)) problems.push(mood + ': ' + a.name + ' does not fit (' + why.join(', ') + ')'); continue; }
            const body = !!a.layers.Body, entry = {n: a.name, f: a.duration, body: body, neutral: a.endsNeutral !== false, led: !!a.layers.LED};
            (!body || a.duration <= SMALL_FRAMES ? small : big).push(entry);
        }
        if (!small.length && !big.length) problems.push(mood + ': no animation fits');
        moods[mood] = {small: small, big: big};
    }
    return {moods, problems};
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const file = path.resolve(process.argv[2] || DEFAULT_DB);
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    let version = null;
    try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'package.json'), 'utf8')).version; } catch (_) {}
    const {moods, problems} = build(db), emoji = emojiIndex(db), built = buildDances(db), dances = built.dances;
    problems.push(...built.problems);
    if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
    const out = path.join(source, 'noggin/lib/catalog.json');
    fs.writeFileSync(out, JSON.stringify({animdb: version, maxFrames: MAX_FRAMES, smallFrames: SMALL_FRAMES, moods, emoji, dances}, null, 1) + '\n');
    let count = 0;
    for (const [mood, m] of Object.entries(moods)) {
        count += m.small.length + m.big.length;
        console.log(mood.padEnd(12) + ' small ' + String(m.small.length).padStart(2) + '  big ' + String(m.big.length).padStart(2) + '   ' + m.small.concat(m.big).map(a => a.n + (a.led ? '*' : '')).join(' '));
    }
    console.log(count + ' animations in ' + Object.keys(moods).length + ' moods (* has an LED layer)');
    console.log(Object.keys(emoji).length + ' emoji words for ' + new Set(Object.values(emoji).flat()).size + ' emoji');
    for (const [style, d] of Object.entries(dances)) console.log('dance ' + style.padEnd(9) + d.list.map(a => a.n + ' ' + (a.f / 30).toFixed(1) + 's' + (a.led ? '*' : '')).join(', '));
    console.log(new Set(Object.values(dances).flatMap(d => d.list.map(a => a.n))).size + ' dances with music in ' + Object.keys(dances).length + ' styles -> ' + path.relative(process.cwd(), out));
}
