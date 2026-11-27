// SPDX-License-Identifier: MIT
// Noggin actions: the tools the realtime model may call, and how each one runs. Four kinds:
// local (Noggin does it), handover (another of Jibo's skills does it, then Noggin comes back),
// leaving (music, radio: the conversation ends) and cloud (Jibo's cloud answers a fixed phrase).
// Each tool's details are at TOOLS; the skills and apps they open are in lib/apps.js.
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const strings = require('./text'), apps = require('./apps'), clock = require('./clock');
const CLOCK = apps.CLOCK, NIMBUS = apps.NIMBUS, IDLE = apps.IDLE, SKILLS = apps.SKILLS, GAMES = apps.GAMES, launch = apps.launch;

const MIN_TIMER_S = 6, MAX_TIMER_S = 24 * 3600;    // @be/clock refuses 5 s or less and more than 24 h
const NO_ARGS = {type: 'object', properties: {}, additionalProperties: false};

// @be/radio's genres (its `station` entity takes these keys, case-sensitive).
const RADIO = {'alternative': 'Alternative', 'blues': 'Blues', 'christian and gospel': 'ChristianAndGospel', 'classical': 'Classical',
    'classic rock': 'ClassicRock', 'college radio': 'CollegeRadio', 'comedy': 'Comedy', 'country': 'Country', 'dance': 'Dance',
    'eighties and nineties hits': 'EightiesAndNinetiesHits', 'hip hop': 'HipHop', 'jazz': 'Jazz', 'latin': 'Latin',
    'news and talk': 'NewsAndTalk', 'npr': 'NPR', 'oldies': 'Oldies', 'pop': 'Pop', 'reggae': 'ReggaeAndIsland', 'soft rock': 'SoftRock', 'sports': 'Sports'};

// Jibo's cloud features, each asked with the fixed phrase Be's main menu sends for it: the cloud
// hears it as if said after "Hey Jibo", and @be/nimbus speaks the answer. Only the phrase goes to
// the cloud, never the model's words, except picture's subject (pictureSubject()).
const CLOUD = {
    weather: {phrase: 'tell me about the weather', topic: 'weather'},
    news: {phrase: 'tell me about the news', topic: 'news'},
    calendar: {phrase: 'tell me about my calendar', topic: 'your calendar'},
    commute: {phrase: 'what does my commute look like', topic: 'commute'},
    personal_report: {phrase: 'personal report', topic: 'a personal report'},
    // Off by default: the AI's own jokes are more varied than the cloud's small fixed set (D184).
    joke: {phrase: 'tell me a joke', topic: 'a joke'},
    surprise: {phrase: 'surprise me', topic: 'a surprise'},
    // Not on the main menu: a family-safe web image of the subject on Jibo's face. The cloud
    // matches the whole sentence, so the phrase is exactly this form.
    picture: {phrase: 'show me a picture of', topic: 'pictures of things', subject: true}
};

const key = strings.nameKey;
// The cloud features the `cloudSkills` setting switches on, in CLOUD's order (unknown names
// are left out).
function cloudSkills(config) {
    let list = config && !Array.isArray(config) ? config.cloudSkills : null;
    if (typeof list === 'string') list = list.split(',');
    if (!Array.isArray(list)) return [];
    const wanted = list.map(key);
    return Object.keys(CLOUD).filter(name => wanted.indexOf(name) >= 0);
}
// The timer and alarm tools share one switch.
const CLOCK_TOOLS = ['check_clock', 'set_timer', 'cancel_timer', 'set_alarm', 'cancel_alarm'];
// The switches of the local tools (D183, D185): name -> the label the settings page shows and the
// tools it covers. The memory tools have their own `memory` setting and the cloud ones `cloudSkills`.
const LOCAL = {
    get_time: {label: 'Time and date', tools: ['get_time']}, about_jibo: {label: 'Facts about Jibo', tools: ['about_jibo']},
    dance: {label: 'Dance', tools: ['dance']}, set_volume: {label: 'Volume', tools: ['set_volume']},
    timers: {label: 'Timers and alarms', tools: CLOCK_TOOLS}, use_skill: {label: 'Photos and skills', tools: ['use_skill']},
    games: {label: 'Games', tools: ['play_game']}, play_music: {label: 'Play a song', tools: ['play_music']},
    play_radio: {label: 'Radio', tools: ['play_radio']}, open_app: {label: 'Open apps', tools: ['open_app']},
    go_to_sleep: {label: 'Go to sleep', tools: ['go_to_sleep']}, look_away: {label: 'Look away', tools: ['look_away']}
};
// The switch a local tool belongs to; undefined for a cloud or memory tool.
const switchOf = name => Object.keys(LOCAL).filter(k => LOCAL[k].tools.indexOf(name) >= 0)[0];
// A list stored while every tool had its own switch (D185) is told by a timer or alarm tool name in
// it: those names become `timers`, and `use_skill` (word of the day was one of its skills) also
// switches `games` on. Any other list is returned as it is.
function upgradeLocal(list) {
    if (!Array.isArray(list) || !list.some(name => CLOCK_TOOLS.indexOf(key(name)) >= 0)) return list;
    const out = list.map(name => CLOCK_TOOLS.indexOf(key(name)) >= 0 ? 'timers' : name);
    if (out.map(key).indexOf('use_skill') >= 0) out.push('games');
    return out.filter((name, at) => out.indexOf(name) === at);
}
// The switch names (LOCAL's keys, not tool names) the `localSkills` setting has on, in LOCAL's order. Unlike the cloud list,
// no list (or one that is no list) means all of them, so nothing changes for an existing setup.
function localSkills(config) {
    let list = config && !Array.isArray(config) ? config.localSkills : null;
    if (typeof list === 'string') list = list.split(',');
    if (!Array.isArray(list)) return Object.keys(LOCAL);
    const wanted = upgradeLocal(list).map(key);
    return Object.keys(LOCAL).filter(name => wanted.indexOf(name) >= 0);
}
const PICTURE_MAX = 60;
// picture's subject as it goes into the cloud's sentence: "a horse", "the eiffel tower". Plain
// words only (the cloud matches the whole sentence, and speaks the subject back), lower case,
// at most PICTURE_MAX characters cut at a word; '' when nothing usable is left.
function pictureSubject(text) {
    let s = String(text || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f'&-]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^(?:(?:a|an|some) )?(?:picture|photo|photograph|image|pic)s? of(?: |$)/, '').replace(/ please$/, '').trim();
    if (s.length > PICTURE_MAX) s = s.slice(0, PICTURE_MAX + 1).replace(/ [^ ]*$/, '').trim();
    return /[a-z0-9\u00c0-\u024f]/.test(s) ? s : '';
}
// Who speaks when a tool runs: whoever performs the action, once (D118).
//   talk:   Noggin does it; the model says the result once, after.
//   skill:  another Jibo skill takes over and speaks; Noggin comes back with comebackLine.
//   leaves: opens something else for good; a short goodbye, and the conversation ends.
const VOICES = {
    talk: {tool: 'Call it without saying anything first, then say the result once, briefly.',
        you: 'call the tool without saying anything first, then say the result once, briefly.'},
    skill: {tool: 'Call it without saying anything first: another of Jibo\'s skills takes over at once and says it out loud; afterwards do not repeat or sum up what it said.',
        you: 'call the tool without saying anything first: another of your skills takes over at once and says it out loud; when you are back, do not repeat or sum up what it said.'},
    leaves: {tool: 'Say a short goodbye first: this ends the conversation.',
        you: 'say a short goodbye first; the conversation ends there.'}
};
const CLOCK_ABILITY = 'use your timer and alarm';
const MEMORY_ABILITY = 'keep, forget and look up memories';
// The argument each memory tool takes.
const MEMORY_FIELD = {remember: 'text', forget: 'about', recall: 'query'};
const enumOf = list => ({type: 'object', additionalProperties: false, required: ['name'], properties: {name: {type: 'string', enum: list}}});
// The tools, each with who speaks (`voice`) and the ability it gives (for the instructions).
const TOOLS = [
    // Jibo's clock shows it (@be/clock askForTime: a clock face; askForDate: a calendar page)
    // and says it; Noggin comes back afterwards. If the clock does not open, the failure result
    // carries the time, so the model can still say it.
    {name: 'get_time', voice: 'skill', ability: 'tell the time and date',
        description: 'Jibo\'s clock shows and says the time (a clock face) or the date (a calendar page with today\'s date and weekday), where Jibo lives. ' +
            'Use it whenever the person asks the time, the day or the date.',
        parameters: {type: 'object', additionalProperties: false, required: ['show'], properties: {show: {type: 'string', enum: ['time', 'date']}}}},
    {name: 'about_jibo', voice: 'talk', ability: 'look up facts about yourself', parameters: NO_ARGS,
        description: 'Jibo\'s own facts about himself: favorite fruit, dessert, flower, number, music, movies, TV, books, sports and teams, ' +
            'holiday, season, planet, weather, heroes and robots he likes, hobbies, dislikes, fears, pets, sleeping, eating, feelings, purpose, ' +
            'his looks, voice, name, other assistants, family and dating. Call it for any question about Jibo that your instructions do not answer, ' +
            'before answering; never make such facts up.'},
    {name: 'dance', voice: 'talk', ability: 'dance', parameters: NO_ARGS,
        description: 'Jibo dances to his own music (5 to 25 seconds). He picks the dance himself from what the person said: a style they name ' +
            '(funk, pop, robot, techno, twerk, belly dance, flamenco, country, slow, calm, silly, waltz), the same one "again", or a surprise. ' +
            'Only when the person asks him to dance.'},
    {name: 'set_volume', voice: 'talk', ability: 'change your volume',
        description: 'Sets Jibo\'s speaker volume: a level from 1 (quiet) to 10 (loud), or one step up or down.',
        parameters: {type: 'object', additionalProperties: false, properties: {
            level: {type: 'integer', minimum: 1, maximum: 10}, change: {type: 'string', enum: ['up', 'down']}}}},
    // Noggin reads the clock's record; only if it cannot, the clock answers (actions.clockQuery()).
    {name: 'check_clock', voice: 'talk', ability: CLOCK_ABILITY, parameters: NO_ARGS,
        description: 'Whether Jibo\'s timer and alarm are set: the time left on the timer, and when the alarm goes off.'},
    {name: 'set_timer', voice: 'skill', ability: CLOCK_ABILITY,
        description: 'Starts Jibo\'s timer: one timer at a time, longer than 5 seconds and at most 24 hours. Jibo\'s clock starts it and confirms it ' +
            '(if a timer is already running it asks the person whether to replace it); then the conversation continues.',
        parameters: {type: 'object', additionalProperties: false, properties: {
            hours: {type: 'integer', minimum: 0, maximum: 24}, minutes: {type: 'integer', minimum: 0}, seconds: {type: 'integer', minimum: 0}}}},
    {name: 'cancel_timer', voice: 'skill', ability: CLOCK_ABILITY, parameters: NO_ARGS,
        description: 'Stops Jibo\'s running timer. Jibo\'s clock does it and says so; then the conversation continues. If no timer is running, the result says so and you tell the person.'},
    {name: 'set_alarm', voice: 'skill', ability: CLOCK_ABILITY,
        description: 'Sets Jibo\'s alarm for a time of day within the next 24 hours (one alarm at a time); hour on the 24-hour clock. ' +
            'Jibo\'s clock sets it and confirms it (if an alarm is already set it asks whether to replace it); then the conversation continues.',
        parameters: {type: 'object', additionalProperties: false, required: ['hour'], properties: {
            hour: {type: 'integer', minimum: 0, maximum: 23}, minute: {type: 'integer', minimum: 0, maximum: 59}}}},
    {name: 'cancel_alarm', voice: 'skill', ability: CLOCK_ABILITY, parameters: NO_ARGS,
        description: 'Cancels Jibo\'s alarm. Jibo\'s clock does it and says so; then the conversation continues. If no alarm is set, the result says so and you tell the person.'},
    {name: 'use_skill', voice: 'skill', ability: 'take photos and use a few of your skills', parameters: enumOf(Object.keys(SKILLS)),
        description: 'Starts one of Jibo\'s skills: take a photo, photo booth (four photos in a row), ' +
            'sing daisy bell (Jibo sings the song), who am i (Jibo tells who the person is). It ends by itself, then the conversation continues.'},
    {name: 'play_game', voice: 'skill', ability: 'play a game with your person', parameters: enumOf(Object.keys(GAMES)),
        description: 'Starts one of Jibo\'s games: word of the day (a word guessing game), circuit saver (a one-player game in front of Jibo, ' +
            'leaning left and right). Only when the person asks to play a game; it ends by itself, then the conversation continues.'},
    // Jibo's cloud (CLOUD above), only those the `cloudSkills` setting names.
    {name: 'weather', cloud: true, voice: 'skill', parameters: NO_ARGS,
        description: 'Jibo\'s cloud tells the weather where Jibo lives (no other places).'},
    {name: 'news', cloud: true, voice: 'skill', parameters: NO_ARGS,
        description: 'Jibo\'s cloud reads the latest news headlines.'},
    {name: 'calendar', cloud: true, voice: 'skill', parameters: NO_ARGS,
        description: 'Jibo\'s cloud reads what is on the calendar linked to Jibo.'},
    {name: 'commute', cloud: true, voice: 'skill', parameters: NO_ARGS,
        description: 'Jibo\'s cloud tells what the commute to work looks like.'},
    {name: 'personal_report', cloud: true, voice: 'skill', parameters: NO_ARGS,
        description: 'Jibo\'s personal report from his cloud: weather, calendar, commute and news in one go; he may ask the person a question or two first.'},
    {name: 'joke', cloud: true, voice: 'skill', parameters: NO_ARGS,
        description: 'Jibo\'s cloud tells one of Jibo\'s own jokes. Use it when the person asks for a joke.'},
    {name: 'surprise', cloud: true, voice: 'skill', parameters: NO_ARGS,
        description: 'Jibo\'s cloud surprises the person: a fun fact or a joke. Only when they ask to be surprised.'},
    {name: 'picture', cloud: true, voice: 'skill',
        description: 'Jibo\'s cloud finds a family-safe picture on the internet, shows it on his screen and says "Here\'s a picture of" the subject. ' +
            'Use it when the person asks to see a picture or photo of something (an animal, a place, a thing). ' +
            'Not for taking a new photo with Jibo\'s camera.',
        parameters: {type: 'object', additionalProperties: false, required: ['subject'], properties: {
            subject: {type: 'string', description: 'What to show, in a few English words with its article, as Jibo will say it: "a horse", "the eiffel tower", "puppies".'}}}},
    {name: 'play_music', voice: 'leaves', ability: 'play songs or the radio',
        description: 'Plays a song the person names, on Jibo\'s music player (with the artist if they said it). Only for a named song.',
        parameters: {type: 'object', additionalProperties: false, required: ['song'], properties: {
            song: {type: 'string'}, artist: {type: 'string'}}}},
    {name: 'play_radio', voice: 'leaves', ability: 'play songs or the radio',
        description: 'Plays internet radio in a genre; without a genre, Jibo\'s last station or his station list.',
        parameters: {type: 'object', additionalProperties: false, properties: {genre: {type: 'string', enum: Object.keys(RADIO)}}}},
    {name: 'open_app', voice: 'skill', ability: 'open your apps', apps: true,
        description: 'Opens one of Jibo\'s apps on his screen; when the person is done with it, the conversation continues.'},
    // Idle's own states (D142): the same hand-off Jibo's "go to sleep" and "look away" commands make.
    {name: 'go_to_sleep', voice: 'leaves', ability: 'go to sleep',
        description: 'Puts Jibo to sleep, when the person asks him to go to sleep or to take a nap.',
        parameters: NO_ARGS},
    {name: 'look_away', voice: 'leaves', ability: 'look away',
        description: 'Jibo turns away and looks elsewhere, when the person asks him to look away, turn around or give them some privacy. He does not switch his camera or microphone off.',
        parameters: NO_ARGS},
    // Memory (lib/memory.js), offered when the `memory` setting is on. Several people talk to Jibo
    // and he cannot tell them apart, so facts are about the household, in the third person (D53).
    {name: 'remember', memory: true, voice: 'talk', ability: MEMORY_ABILITY,
        description: 'Saves a fact for later conversations, when a person asks Jibo to remember something. Write it as one short sentence ' +
            'in the third person, never "I" or "you": with the name if the person gave one ("Sam\'s birthday is March 3."), ' +
            'otherwise "someone in the house". For a fact tied to a day, set expires to the last day it matters.',
        parameters: {type: 'object', additionalProperties: false, required: ['text'], properties: {
            text: {type: 'string', description: 'The fact, at most 160 characters.'},
            expires: {type: 'string', description: 'Optional: the last day it matters, as YYYY-MM-DD.'}}}},
    {name: 'forget', memory: true, voice: 'talk', ability: MEMORY_ABILITY,
        description: 'Removes a saved fact when a person asks Jibo to forget it. Give the fact in a few words. If several facts match, ' +
            'the result lists them: ask which one, then call again with its words.',
        parameters: {type: 'object', additionalProperties: false, required: ['about'], properties: {about: {type: 'string'}}}},
    {name: 'recall', memory: true, voice: 'talk', ability: MEMORY_ABILITY,
        description: 'Looks through the notes of conversations from the last two weeks and the saved facts, when a person asks about ' +
            'an earlier conversation that the memory notes in your session note do not cover. Give a few keywords.',
        parameters: {type: 'object', additionalProperties: false, required: ['query'], properties: {query: {type: 'string'}}}}
];

// The tools on offer: all of TOOLS, except the cloud ones the `cloudSkills` setting does not name,
// the local ones `localSkills` does not name, and the memory tools unless `memory` is on.
function offered(config) {
    const cloud = cloudSkills(config), local = localSkills(config), memory = !!config && config.memory === true;
    return TOOLS.filter(t => t.cloud ? cloud.indexOf(t.name) >= 0 : t.memory ? memory : local.indexOf(switchOf(t.name)) >= 0);
}
const isOffered = (config, name) => offered(config).some(t => t.name === name);
// The function tools for session.update: each description ends with its voice rule.
function tools(config) {
    const names = Object.keys(apps.all(config));
    return offered(config).map(t => ({type: 'function', name: t.name, description: t.description + (t.apps ? apps.notes(config) : '') + ' ' + VOICES[t.voice].tool,
        parameters: t.apps ? enumOf(names) : t.parameters}));
}
const join = items => items.length > 1 ? items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1] : items[0];
// The tool part of the instructions, built from the same table: what Jibo can do, then who
// speaks, per voice. The names of apps and skills are in the tools themselves. The cloud
// tools on offer share one ability ("ask your cloud for the weather and the news").
function rules(config) {
    const list = offered(config), abilities = [], cloud = list.filter(t => t.cloud).map(t => CLOUD[t.name].topic);
    if (!list.length) return '';
    list.forEach(t => {
        const ability = t.cloud ? 'ask your cloud for ' + join(cloud) : t.ability;
        if (abilities.indexOf(ability) < 0) abilities.push(ability);
    });
    // The cloud tools go by one name here; their own descriptions say what each one does.
    const names = voice => {
        const out = list.filter(t => t.voice === voice && !t.cloud).map(t => t.name);
        if (cloud.length && voice === 'skill') out.push('your cloud tools');
        return out;
    };
    const sentence = voice => names(voice).length ? 'For ' + join(names(voice)) + ', ' + VOICES[voice].you + ' ' : '';
    return 'Only when your person asks, your tools let you ' +
        (abilities.length > 1 ? abilities.slice(0, -1).join(', ') + ', and ' : '') + abilities[abilities.length - 1] + '. ' +
        sentence('skill') + sentence('talk') + sentence('leaves');
}
function voiceOf(name) { const tool = TOOLS.filter(t => t.name === name)[0]; return tool ? tool.voice : null; }
const isCloud = name => !!CLOUD[name] && TOOLS.some(t => t.cloud && t.name === name);

const whole = v => isFinite(v) && v >= 0 && Math.floor(v) === v;
const given = (args, name) => args && args[name] !== undefined && args[name] !== null && args[name] !== '';
// set_timer's arguments -> {total, hours, minutes, seconds} or {error}.
function timerLength(args) {
    const n = name => given(args, name) ? Number(args[name]) : 0;
    const h = n('hours'), m = n('minutes'), s = n('seconds');
    if (![h, m, s].every(whole)) return {error: 'hours, minutes and seconds must be whole numbers'};
    const total = h * 3600 + m * 60 + s;
    if (!total) return {error: 'no duration given: ask the person how long'};
    if (total < MIN_TIMER_S) return {error: 'a timer must be longer than 5 seconds'};
    if (total > MAX_TIMER_S) return {error: 'a timer can be at most 24 hours'};
    return {total: total, hours: Math.floor(total / 3600), minutes: Math.floor(total % 3600 / 60), seconds: total % 60};
}
// set_alarm's arguments (24-hour clock) -> {time: "7:30", ampm: "AM", spoken: "7:30 AM"} or {error}.
// @be/clock wants a 12-hour "H:MM" and an upper-case AM/PM: its parser ignores "pm", and adds
// 12 hours again to "19:30".
function alarmTime(args) {
    if (!given(args, 'hour')) return {error: 'no time given: ask the person what time'};
    const h = Number(args.hour), m = given(args, 'minute') ? Number(args.minute) : 0;
    if (!whole(h) || !whole(m) || h > 23 || m > 59) return {error: 'hour must be 0 to 23 and minute 0 to 59'};
    const at = clock.twelveHour(h, m);
    return {time: at.time, ampm: at.ampm, spoken: at.time + ' ' + at.ampm};
}
function setTimerOptions(length) {
    // The clock parses each part with parseInt and treats "null" as absent.
    return launch('start', 'timer', {hours: String(length.hours), minutes: String(length.minutes),
        seconds: length.seconds ? String(length.seconds) : 'null', time: 'null', ampm: 'null'});
}
function setAlarmOptions(at) {
    return launch('set', 'alarm', {time: at.time, ampm: at.ampm, hours: 'null', minutes: 'null', seconds: 'null'});
}
// check_clock's fallback: the clock answers out loud, so it comes back like a `skill` tool.
function clockQuery() {
    return {kind: 'handover', target: CLOCK, options: launch('query', 'timer'), comeback: true, args: {}};
}
// cancel_timer / cancel_alarm once the record shows something to cancel (or can't be read).
function clockCancel(domain) {
    return {kind: 'handover', target: CLOCK, options: launch('stop', domain), comeback: true, args: {}};
}
function parseArgs(text) {
    if (text && typeof text === 'object') return text;
    if (!text) return {};
    try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null; } catch (_) { return null; }
}
function handover(name, target, options, args, check) {
    const out = {kind: 'handover', target: target, options: options, comeback: voiceOf(name) === 'skill', args: args || {}};
    if (check) out.check = true;
    return out;
}

// What a call means: {kind: 'local', run, args} | {kind: 'handover', target, options, comeback, args, check}
// | {kind: 'cloud', target, phrase, comeback, args} | {kind: 'error', error}.
// A cloud plan's args are {} except picture's {subject}.
// `check`: an app from the `openApps` setting; Noggin first checks that it is installed.
// `cloud`: Noggin asks Jibo's cloud the fixed `phrase` (a mimicked global turn); @be/nimbus answers.
function plan(name, argsText, config) {
    const args = parseArgs(argsText);
    if (args === null) return {kind: 'error', error: 'the arguments were not valid JSON'};
    if (isCloud(name)) {
        // Only a tool that was offered: the model never gets the others, but a call is a call.
        if (cloudSkills(config).indexOf(name) < 0) return {kind: 'error', error: name + ' is not switched on for Jibo'};
        if (!CLOUD[name].subject) return {kind: 'cloud', target: NIMBUS, phrase: CLOUD[name].phrase, comeback: voiceOf(name) === 'skill', args: {}};
        const subject = pictureSubject(args.subject);
        if (!subject) return {kind: 'error', error: 'no subject given: ask the person what they want to see'};
        return {kind: 'cloud', target: NIMBUS, phrase: CLOUD[name].phrase + ' ' + subject, comeback: voiceOf(name) === 'skill', args: {subject: subject}};
    }
    // Only a tool that was offered, as for the cloud ones above (D183).
    if (switchOf(name) && localSkills(config).indexOf(switchOf(name)) < 0) return {kind: 'error', error: name + ' is not switched on for Jibo'};
    if (name === 'get_time') {
        // The weekday is on the calendar page too: anything but "date" is the time.
        const show = args.show === 'date' ? 'date' : 'time';
        return handover(name, CLOCK, launch(show === 'date' ? 'askForDate' : 'askForTime', 'clock'), {show: show});
    }
    if (name === 'remember' || name === 'forget' || name === 'recall') {
        if (!config || config.memory !== true) return {kind: 'error', error: 'memory is switched off for Jibo'};
        const field = MEMORY_FIELD[name];
        const text = String(args[field] || '').trim().slice(0, 300);
        if (!text) return {kind: 'error', error: 'no ' + field + ' given'};
        const out = {op: name};
        out[field] = text;
        if (name === 'remember' && typeof args.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.expires)) out.expires = args.expires;
        return {kind: 'local', run: 'memory', args: out};
    }
    if (name === 'dance') return {kind: 'local', run: 'dance'};
    if (name === 'about_jibo') return {kind: 'local', run: 'facts'};
    if (name === 'check_clock') return {kind: 'local', run: 'clock'};
    if (name === 'set_volume') {
        if (given(args, 'level')) {
            const level = Number(args.level);
            if (!whole(level) || level < 1 || level > 10) return {kind: 'error', error: 'the volume level is 1 to 10'};
            return {kind: 'local', run: 'volume', args: {level: level}};
        }
        if (args.change === 'up' || args.change === 'down') return {kind: 'local', run: 'volume', args: {change: args.change}};
        return {kind: 'error', error: 'give a level from 1 to 10, or change up or down'};
    }
    if (name === 'set_timer') {
        const length = timerLength(args);
        if (length.error) return {kind: 'error', error: length.error};
        return handover(name, CLOCK, setTimerOptions(length), {seconds: length.total, duration: clock.duration(length.total)});
    }
    if (name === 'set_alarm') {
        const at = alarmTime(args);
        if (at.error) return {kind: 'error', error: at.error};
        return handover(name, CLOCK, setAlarmOptions(at), {time: at.spoken});
    }
    if (name === 'cancel_timer') return {kind: 'local', run: 'cancel', args: {domain: 'timer'}};
    if (name === 'cancel_alarm') return {kind: 'local', run: 'cancel', args: {domain: 'alarm'}};
    if (name === 'use_skill') {
        const k = key(args.name), skill = SKILLS[k];
        if (!skill) return {kind: 'error', error: 'that is not one of Jibo\'s skills (' + Object.keys(SKILLS).join(', ') + ')'};
        return handover(name, skill.pkg, apps.optionsOf(skill), {name: k});
    }
    if (name === 'play_game') {
        const k = key(args.name), game = GAMES[k];
        if (!game) return {kind: 'error', error: 'that is not one of Jibo\'s games (' + Object.keys(GAMES).join(', ') + ')'};
        return handover(name, game.pkg, apps.optionsOf(game), {name: k});
    }
    if (name === 'play_music') {
        const song = String(args.song || '').trim().slice(0, 160), artist = String(args.artist || '').trim().slice(0, 120);
        if (!song) return {kind: 'error', error: 'no song given: ask the person which song'};
        return handover(name, '@be/music', launch('playSong', 'music', artist ? {query: song, artist: artist} : {query: song}), {song: song, artist: artist || undefined});
    }
    if (name === 'play_radio') {
        const genre = given(args, 'genre') ? key(args.genre) : '';
        if (genre && !RADIO[genre]) return {kind: 'error', error: 'Jibo\'s radio has no such genre (' + Object.keys(RADIO).join(', ') + ')'};
        return handover(name, '@be/radio', launch('play', 'radio', genre ? {station: RADIO[genre]} : {}), {genre: genre || undefined});
    }
    if (name === 'go_to_sleep') return handover(name, IDLE, launch('sleep', 'idle'));
    if (name === 'look_away') return handover(name, IDLE, launch('turnAway', 'idle'));
    if (name === 'open_app') {
        const list = apps.all(config), k = key(args.name);
        if (!list[k]) return {kind: 'error', error: 'that app is not on Jibo\'s list (' + Object.keys(list).join(', ') + ')'};
        // An extra app from the `openApps` setting is checked first; a built-in one is always there.
        const builtin = apps.APPS[k] && apps.APPS[k].pkg === list[k];
        return handover(name, list[k], apps.openOptions(list[k]), {name: k}, !builtin);
    }
    return {kind: 'error', error: 'unknown tool ' + String(name).slice(0, 40)};
}

// Is a package installed? BEam resolves every @be/* request (built-in or BEacon custom skill)
// through its own resolver, so require.resolve sees what Be's loader would load; a removed
// store skill drops out at once. Other names can't be checked this way: true (the handover
// timeout still catches them).
function installed(resolve, pkg) {
    if (!/^@be\//.test(pkg)) return true;
    try { resolve(pkg); return true; } catch (_) { return false; }
}

// set_volume, through the runtime's own volume control (the click, no screen): {level} or {change}.
function setVolume(jibo, args) {
    const volume = jibo && jibo.volume;
    if (!volume || typeof volume.changeVolume !== 'function') return {ok: false, error: 'Jibo cannot change his volume right now'};
    try {
        if (args.level) volume.changeVolume('volumeToValue', String(args.level));
        else volume.changeVolume(args.change === 'up' ? 'volumeUp' : 'volumeDown');
    } catch (_) { return {ok: false, error: 'the volume did not change'}; }
    const now = typeof volume.currentVolume === 'number' ? volume.currentVolume : null;
    return now === null ? {ok: true} : {ok: true, volume: now, of: 10};
}

module.exports = {RADIO, CLOUD, LOCAL, VOICES, TOOLS, voiceOf, cloudSkills, localSkills, upgradeLocal, offered, isOffered, rules, tools,
    plan, clockQuery, clockCancel, installed, setVolume};
