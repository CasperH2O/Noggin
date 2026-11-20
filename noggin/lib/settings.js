// SPDX-License-Identifier: MIT
// Noggin's settings: one schema for every setting (default, type, limits, and the label and
// help the settings page shows), stored in settings.json in Noggin's data folder, and the
// persona: the packaged SOUL, IDENTITY and FACTS, each replaced by an edited copy when there is one.
// Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
const core = require('./core'), actions = require('./actions');

const ROBOT_SKILLS = '/opt/jibo/Jibo/Skills';
const ROBOT_DATA = '/opt/jibo/Knowledge/beacon/custom-skills/noggin';
const DEV_DATA = '/tmp/beam-beacon/custom-skills/noggin';
const FILE = 'settings.json';
const PACKAGED_PERSONA = path.join(__dirname, '../persona');
const MODEL = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_MS = 600000;

function greetingExpressions() {
    return ['none'].concat(Object.keys(core.EXTRA), Object.keys(core.MOODS).filter(name => name !== 'dance'));
}
function cloudOptions() {
    return Object.keys(actions.CLOUD).map(name => ({value: name, disabled: actions.CLOUD[name].disabled || null}));
}

// group: the page section; tab: the page tab. advanced: folded away under Advanced.
// empty: '' is a real value (no greeting), not "use the default".
const SCHEMA = [
    {key: 'apiKey', type: 'secret', default: '', tab: 'brain', group: 'OpenAI', label: 'API key',
        help: 'Your OpenAI API key. It stays on Jibo and is never shown again.'},
    {key: 'apiBase', type: 'url', default: 'https://api.openai.com/v1', tab: 'brain', group: 'OpenAI', label: 'API address',
        help: 'Change only for a compatible proxy.', advanced: true},
    {key: 'realtimeModel', type: 'text', pattern: MODEL, default: 'gpt-realtime-2.1', tab: 'brain', group: 'Models', label: 'Conversation model',
        help: 'Hears Jibo\'s microphone and writes what he says.', suggestions: ['gpt-realtime-2.1', 'gpt-realtime-2.1-mini', 'gpt-realtime']},
    {key: 'transcribeModel', type: 'text', pattern: MODEL, default: 'gpt-4o-mini-transcribe', tab: 'brain', group: 'Models', label: 'Transcription model',
        help: 'Turns your words into text for the log and Jibo\'s skills.', suggestions: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe']},
    {key: 'turnDetection', type: 'enum', default: 'semantic_vad', tab: 'brain', group: 'Models', label: 'When you are done talking',
        help: 'Semantic waits for the end of a thought; silence waits for a pause.',
        options: [{value: 'semantic_vad', label: 'Semantic (end of a thought)'}, {value: 'server_vad', label: 'Silence (a pause)'}]},
    {key: 'classifierApi', type: 'enum', default: 'decisions', tab: 'brain', group: 'Models', label: 'Expression picker',
        help: 'How a fast model picks Jibo\'s face and body expression for each line.',
        options: [{value: 'decisions', label: 'Decisions API'}, {value: 'responses', label: 'Responses API'}]},
    {key: 'classifierModel', type: 'text', pattern: MODEL, default: 'gpt-6-luna', tab: 'brain', group: 'Models', label: 'Expression model',
        help: 'The Decisions API\'s model, or a Responses model.', suggestions: ['gpt-6-luna', 'gpt-4o-mini', 'gpt-4.1-mini']},
    {key: 'fallbackModel', type: 'text', pattern: MODEL, default: 'gpt-4o-mini', tab: 'brain', group: 'Models', label: 'Fallback model',
        help: 'Picks expressions when the Decisions API is not available.', suggestions: ['gpt-4o-mini', 'gpt-4.1-mini']},
    {key: 'classifierReasoning', type: 'enum', default: null, tab: 'brain', group: 'Models', label: 'Expression model reasoning',
        help: 'Responses API with a reasoning model only.', advanced: true,
        options: [{value: null, label: 'Model default'}, {value: 'none', label: 'None'}, {value: 'minimal', label: 'Minimal'}, {value: 'low', label: 'Low'}]},
    {key: 'minConfidence', type: 'number', min: 0, max: 1, step: 0.05, default: 0.35, tab: 'brain', group: 'Models', label: 'Expression confidence',
        help: 'Decisions API only: below this, no expression.', advanced: true},

    {key: 'greeting', type: 'text', max: 200, empty: true, default: 'Hi!', tab: 'behaviour', group: 'Conversation', label: 'Greeting',
        help: 'Said as soon as Noggin opens. Empty: none.'},
    {key: 'greetingExpression', type: 'enum', default: 'smile', tab: 'behaviour', group: 'Conversation', label: 'Greeting expression',
        help: 'Smile is quick and eye only.', options: greetingExpressions},
    {key: 'comebackLine', type: 'text', max: 200, empty: true, default: 'Anything else?', tab: 'behaviour', group: 'Conversation', label: 'Coming back',
        help: 'Said when Noggin comes back after another skill. Empty: the model says something.'},
    {key: 'silenceSeconds', type: 'number', min: 5, max: 3600, unit: 's', default: 60, tab: 'behaviour', group: 'Conversation', label: 'End after silence',
        help: 'The conversation ends after this many seconds of quiet.'},
    {key: 'expressions', type: 'bool', default: true, tab: 'behaviour', group: 'Expressions', label: 'Expressions',
        help: 'Jibo moves his face and body with what he says.'},
    {key: 'reaction', type: 'bool', default: true, tab: 'behaviour', group: 'Expressions', label: 'Quick reaction',
        help: 'A quick expression on hearing you, before Jibo answers.'},
    {key: 'expressionSize', type: 'bool', default: true, tab: 'behaviour', group: 'Expressions', label: 'Small and big expressions',
        help: 'The model also picks how big an expression is.'},
    {key: 'emoji', type: 'bool', default: true, tab: 'behaviour', group: 'Expressions', label: 'Eye emoji',
        help: 'An emoji on Jibo\'s eye at the word, when he names something that has one: pizza, rain, a dog. Off: no emoji for words at all, also not Jibo\'s own (and none of the small nods he makes at some words).'},
    {key: 'danceAnnounce', type: 'enum', default: 'sometimes', tab: 'behaviour', group: 'Expressions', label: 'Name the dance',
        help: 'Jibo names a dance he picked himself before he dances.',
        options: [{value: 'sometimes', label: 'Sometimes'}, {value: 'always', label: 'Always'}, {value: 'off', label: 'Never'}]},
    {key: 'thinkingEye', type: 'bool', default: false, tab: 'behaviour', group: 'Expressions', label: 'Thinking eye',
        help: 'Jibo\'s thinking loop on his eye while he waits for the reply.', advanced: true},
    {key: 'expressionPlay', type: 'enum', default: 'animdb', tab: 'behaviour', group: 'Expressions', label: 'How expressions play',
        help: 'Next to the words (recommended), or inside the speech.', advanced: true,
        options: [{value: 'animdb', label: 'Next to the words'}, {value: 'esml-tts', label: 'In the speech, ends with the words'}, {value: 'esml', label: 'In the speech'}]},
    {key: 'expressionWaitMs', type: 'number', min: 0, max: 5000, unit: 'ms', default: 0, tab: 'behaviour', group: 'Expressions', label: 'Expression wait',
        help: 'How long the first line may wait for its expression. With 0 Jibo never waits: an eye expression that comes later shows once his eye is free.', advanced: true},
    {key: 'expressionGapMs', type: 'number', min: 0, max: 60000, unit: 'ms', default: 4000, tab: 'behaviour', group: 'Expressions', label: 'Time between expressions', advanced: true},
    {key: 'emojiGapMs', type: 'number', min: 0, max: 120000, unit: 'ms', default: 6000, tab: 'behaviour', group: 'Expressions', label: 'Time between emoji', advanced: true},
    {key: 'expressionLeadMs', type: 'number', min: 0, max: 5000, unit: 'ms', default: 100, tab: 'behaviour', group: 'Expressions', label: 'Expression lead',
        help: 'How long the words wait for an animation that moves the body to be handed over. They never wait for an eye animation.', advanced: true},
    {key: 'expressionTailMs', type: 'number', min: 0, max: 10000, unit: 'ms', default: 0, tab: 'behaviour', group: 'Expressions', label: 'Expression tail',
        help: 'How long the microphone waits for expressions still playing.', advanced: true},
    {key: 'micSource', type: 'enum', default: 'auto', tab: 'behaviour', group: 'Microphone', label: 'Microphone', advanced: true,
        help: 'Auto: a separate recording process on the robot, the browser\'s microphone elsewhere.',
        options: [{value: 'auto', label: 'Auto'}, {value: 'arecord', label: 'Recording process'}, {value: 'webaudio', label: 'Browser microphone'}]},
    {key: 'micDevice', type: 'text', pattern: /^[A-Za-z0-9_:,.=-]{1,64}$/, default: 'default', tab: 'behaviour', group: 'Microphone', label: 'Recording device',
        help: 'An ALSA capture device: default, MediaIn, ASRIn.', advanced: true},
    {key: 'micSilentMs', type: 'number', min: 500, max: 60000, unit: 'ms', default: 3000, tab: 'behaviour', group: 'Microphone', label: 'Restart a silent microphone',
        help: 'Digital silence this long while listening restarts the microphone.', advanced: true},
    {key: 'echoTailMs', type: 'number', min: 0, max: 5000, unit: 'ms', default: 400, tab: 'behaviour', group: 'Microphone', label: 'Echo tail',
        help: 'The microphone stays closed this long after Jibo stops speaking.', advanced: true},
    {key: 'listenWhileThinking', type: 'bool', default: true, tab: 'behaviour', group: 'Microphone', label: 'Hear me while Jibo thinks',
        help: 'The microphone stays open until Jibo starts his answer, so if you go on after a pause he waits for you.', advanced: true},
    {key: 'transcriptWaitMs', type: 'number', min: 0, max: 10000, unit: 'ms', default: 1500, tab: 'behaviour', group: 'Microphone', label: 'Transcript wait',
        help: 'How long a reply may wait for the transcript of your words.', advanced: true},
    {key: 'ringRefreshMs', type: 'number', min: 0, max: 5000, unit: 'ms', default: 100, tab: 'behaviour', group: 'Microphone', label: 'Ring refresh',
        help: 'Re-send the ring colour this often; 0: never.', advanced: true},
    {key: 'lab', type: 'enum', default: '', tab: 'behaviour', group: 'Microphone', label: 'Lab mode',
        help: 'A fixed test run instead of a conversation.', advanced: true,
        options: [{value: '', label: 'Off'}, {value: 'expressions', label: 'Expressions'}, {value: 'animdb', label: 'Expressions, next to the words only'}, {value: 'timing', label: 'Timing'}]},

    {key: 'actions', type: 'bool', default: true, tab: 'skills', group: 'Jibo\'s skills', label: 'Use Jibo\'s skills',
        help: 'Timers, alarms, the clock, music, radio, photos, dances and apps. Off: conversation only.'},
    {key: 'cloudSkills', type: 'set', default: ['weather', 'news', 'calendar', 'commute', 'personal_report', 'surprise', 'picture'],
        tab: 'skills', group: 'Jibo\'s skills', label: 'Cloud features', help: 'Jibo\'s cloud answers these, then Noggin comes back.', options: cloudOptions},
    {key: 'openApps', type: 'map', max: actions.MAX_APPS, noteMax: actions.NOTE_MAX, default: {}, tab: 'skills', group: 'Jibo\'s skills', label: 'Extra apps',
        help: 'Apps Jibo may open by name, next to his own. Say what each one does, so Noggin knows when to open it.'},
    {key: 'comebackMinutes', type: 'number', min: 1, max: 60, unit: 'min', default: 5, tab: 'skills', group: 'Jibo\'s skills', label: 'Come back within',
        help: 'After an app or skill, Noggin comes back once it is done, if that is within this time.', advanced: true},
    {key: 'actionTimeoutMs', type: 'number', min: 1000, max: 60000, unit: 'ms', default: 6000, tab: 'skills', group: 'Jibo\'s skills', label: 'Handover timeout',
        help: 'How long another skill may take to open.', advanced: true},

    {key: 'memory', type: 'bool', default: true, tab: 'memory', group: 'Memory', label: 'Memory',
        help: 'Jibo keeps facts about the household and short notes of recent conversations, and uses them when he talks.'},
    {key: 'memoryLearn', type: 'bool', default: true, tab: 'memory', group: 'Memory', label: 'Learn from conversations',
        help: 'After each conversation, the fallback model writes a short note and picks out facts. This sends what was said to OpenAI once more. With conversation logs off, Jibo keeps only what was said until the note is written. Off: Jibo only remembers what you ask him to.'},

    {key: 'log', type: 'bool', default: true, tab: 'history', group: 'History', label: 'Keep conversation logs',
        help: 'What was said, expressions and timings; never audio or the key.'},

    // The budget heads-up (lib/budget.js, D74).
    {key: 'budgetWarnPercent', type: 'number', min: 0, max: 50, unit: '%', default: 10, tab: 'usage', group: 'Heads-up', label: 'Warn when this much is left',
        help: 'Once a day, after his greeting, Jibo says when only this share of the spend limit is left. 0: never. Needs the admin key and a spend limit.'},
    // Saved only after the read-only check (lib/usage.js, D61, D62).
    {key: 'adminKey', type: 'secret', prefix: 'sk-admin-', default: '', tab: 'usage', group: 'OpenAI', label: 'Admin key',
        help: 'A read-only admin key from the same OpenAI organization as Jibo\'s API key. It stays on Jibo and is never shown again.'}
];
// Keys never sent to the page; it sees keyHint() instead.
const SECRETS = ['apiKey', 'adminKey'];
const BY_KEY = {};
SCHEMA.forEach(field => { BY_KEY[field.key] = field; });
const DEFAULTS = {};
SCHEMA.forEach(field => { if (SECRETS.indexOf(field.key) < 0) DEFAULTS[field.key] = field.default; });
const FIELDS = SCHEMA.map(field => field.key);

const PERSONA = {soul: {file: 'SOUL.md', max: 8000}, identity: {file: 'IDENTITY.md', max: 8000}, facts: {file: 'FACTS.md', max: 4000}};

function options(field) { return typeof field.options === 'function' ? field.options() : field.options; }

// One value checked against its field: {value} or {error}. `null` is never passed here.
function check(field, value) {
    const fail = message => ({error: message});
    switch (field.type) {
    case 'secret':
        if (typeof value !== 'string' || !/^\S{4,400}$/.test(value.trim())) return fail('That does not look like an API key.');
        if (field.prefix && value.trim().indexOf(field.prefix) !== 0) return fail('An admin key starts with ' + field.prefix + '.');
        return {value: value.trim()};
    case 'url':
        if (typeof value !== 'string' || value.length > 200 || !/^https?:\/\/[^\s/]+(\/\S*)?$/.test(value)) return fail('An http or https address.');
        return {value: value.replace(/\/+$/, '')};
    case 'text':
        if (typeof value !== 'string') return fail('Text, please.');
        if (value === '' && !field.empty) return fail('This cannot be empty.');
        if (field.pattern && value !== '' && !field.pattern.test(value)) return fail('Letters, digits and . _ : - only.');
        if (value.length > (field.max || 200)) return fail('At most ' + (field.max || 200) + ' characters.');
        return {value: value};
    case 'number': {
        const n = typeof value === 'number' ? value : Number(value);
        if (typeof value === 'string' && value.trim() === '') return fail('A number, please.');
        if (!isFinite(n)) return fail('A number, please.');
        if (n < field.min || n > field.max) return fail('Between ' + field.min + ' and ' + field.max + (field.unit ? ' ' + field.unit : '') + '.');
        return {value: n};
    }
    case 'bool':
        if (typeof value !== 'boolean') return fail('On or off.');
        return {value: value};
    case 'enum': {
        const allowed = options(field).map(o => (typeof o === 'string' ? o : o.value));
        if (allowed.indexOf(value) < 0) return fail('One of: ' + allowed.filter(v => v).join(', ') + '.');
        return {value: value};
    }
    case 'set': {
        if (!Array.isArray(value)) return fail('A list, please.');
        const known = options(field);
        const names = value.map(name => String(name));
        const unknown = names.filter(name => !known.some(o => o.value === name))[0];
        if (unknown) return fail('Unknown: ' + unknown + '.');
        const off = known.filter(o => o.disabled && names.indexOf(o.value) >= 0)[0];
        if (off) return fail(off.value + ' is switched off: ' + off.disabled + '.');
        return {value: known.filter(o => names.indexOf(o.value) >= 0).map(o => o.value)};
    }
    case 'map': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Name and package pairs, please.');
        const names = Object.keys(value), out = {};
        if (names.length > field.max) return fail('At most ' + field.max + ' apps.');
        for (let i = 0; i < names.length; i++) {
            const name = names[i], given = value[name], entry = actions.appEntry(given);
            if (!actions.APP_NAME.test(name)) return fail('"' + name + '" is not a name: letters, digits and spaces.');
            const pkg = entry ? entry.pkg : given && typeof given === 'object' ? given.pkg : given;
            if (typeof pkg !== 'string' || !actions.APP_PACKAGE.test(pkg)) return fail('"' + pkg + '" is not a package name such as @be/stargazer.');
            if (given && typeof given === 'object' && given.about !== undefined && given.about !== null && typeof given.about !== 'string') return fail(name + ': what it does is text.');
            if (entry.about.length > field.noteMax) return fail(name + ': at most ' + field.noteMax + ' characters for what it does.');
            out[name] = entry;
        }
        return {value: out};
    }
    default:
        return fail('Unknown setting.');
    }
}

function dataDir() { return fs.existsSync(ROBOT_SKILLS) ? ROBOT_DATA : DEV_DATA; }
function file(dir) { return path.join(dir, FILE); }

function makeDir(dir) {
    try { fs.mkdirSync(dir, 448); }
    catch (error) {
        if (error.code === 'ENOENT') { makeDir(path.dirname(dir)); fs.mkdirSync(dir, 448); }
        else if (error.code !== 'EEXIST') throw error;
    }
}
// Write via a temporary file and a rename, so a power cut never leaves half a file.
function atomic(target, data) {
    makeDir(path.dirname(target));
    const temporary = target + '.new';
    try { fs.unlinkSync(temporary); } catch (_) {}
    if (typeof fs.fsyncSync !== 'function' || typeof fs.openSync !== 'function') {
        // The simulator's fs has no file descriptors: write, then rename, without the fsync.
        fs.writeFileSync(temporary, data, {mode: 384});
    } else {
        const fd = fs.openSync(temporary, 'wx', 384);
        try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
    }
    fs.renameSync(temporary, target);
}

// What settings.json holds, or {} when it is missing. A broken file throws.
function stored(dir) {
    let raw;
    try { raw = fs.readFileSync(file(dir), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('settings.json is not an object');
    return value;
}

// A stored map longer than its cap (an older version allowed more): its first `max` entries (D32).
function overCap(field, value) {
    if (field.type !== 'map' || !value || typeof value !== 'object' || Array.isArray(value)) return null;
    const names = Object.keys(value);
    if (names.length <= field.max) return null;
    const kept = {};
    names.slice(0, field.max).forEach(name => { kept[name] = value[name]; });
    return kept;
}

// Every setting, with the default where settings.json has none or an invalid one.
// `problems` lists the stored values that were ignored.
function effective(raw) {
    const config = {}, problems = {};
    SCHEMA.forEach(field => {
        const value = raw[field.key];
        const unset = value === undefined || value === null || (value === '' && !field.empty);
        if (unset) { config[field.key] = field.default; return; }
        const over = overCap(field, value);
        if (over) {
            const result = check(field, over);
            problems[field.key] = 'Only the first ' + field.max + ' of ' + Object.keys(value).length + ' apps are used. Remove some and save.';
            config[field.key] = result.error ? field.default : result.value;
            return;
        }
        const result = check(field, value);
        if (result.error) { problems[field.key] = result.error; config[field.key] = field.default; }
        else config[field.key] = result.value;
    });
    return {config: config, problems: problems};
}

// The settings a conversation uses. Throws Error('no_key') without a key.
function read(dir) {
    let raw;
    try { raw = stored(dir); }
    catch (error) { throw Error('settings.json: ' + error.message); }
    const config = effective(raw).config;
    if (!config.apiKey) throw Error('no_key');
    delete config.adminKey; // only for the Usage tab's own calls, through secrets() (D61)
    return config;
}

// Changes from the page: {key: value, or null for the default}. All or nothing: any error
// saves nothing. Returns {ok, errors}. options.dryRun: check only.
function update(dir, patch, options) {
    const errors = {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {ok: false, errors: {_: 'Expected an object of settings.'}};
    let raw;
    try { raw = stored(dir); } catch (_) { raw = {}; }
    const next = {};
    Object.keys(raw).forEach(k => { if (BY_KEY[k]) next[k] = raw[k]; });
    Object.keys(patch).forEach(key => {
        const field = BY_KEY[key], value = patch[key];
        if (!field) { errors[key] = 'Unknown setting.'; return; }
        if (value === null) { delete next[key]; return; }
        const result = check(field, value);
        if (result.error) { errors[key] = result.error; return; }
        if (JSON.stringify(result.value) === JSON.stringify(field.default)) delete next[key];
        else next[key] = result.value;
    });
    if (Object.keys(errors).length) return {ok: false, errors: errors};
    if (!(options && options.dryRun)) atomic(file(dir), JSON.stringify(next, null, 2) + '\n');
    return {ok: true, errors: {}};
}

// The key as the page may see it: whether one is saved, and its first and last characters.
function keyHint(key) {
    if (!key) return {set: false, hint: ''};
    return {set: true, hint: key.slice(0, 3) + '…' + key.slice(-4) + ' (' + key.length + ' characters)'};
}

// Settings for the page: every value except the keys, which only come back as keyHint().
function publicView(dir) {
    let raw, broken = null;
    try { raw = stored(dir); } catch (error) { raw = {}; broken = error.message; }
    const result = effective(raw);
    const values = {};
    FIELDS.forEach(key => { if (SECRETS.indexOf(key) < 0) values[key] = result.config[key]; });
    return {values: values, key: keyHint(result.config.apiKey), adminKey: keyHint(result.config.adminKey), problems: result.problems, broken: broken};
}
// The saved keys themselves, for the server's own calls: {apiKey, adminKey}, '' when unset.
function secrets(dir) {
    let raw;
    try { raw = stored(dir); } catch (_) { raw = {}; }
    const config = effective(raw).config;
    return {apiKey: config.apiKey || '', adminKey: config.adminKey || ''};
}

// The schema as JSON for the page (patterns as strings, option lists resolved).
function schemaView() {
    return SCHEMA.map(field => {
        const out = {};
        Object.keys(field).forEach(k => {
            if (k === 'pattern') out.pattern = field.pattern.source;
            else if (k === 'options') out.options = options(field).map(o => (typeof o === 'string' ? {value: o, label: o} : o));
            else out[k] = field[k];
        });
        return out;
    });
}

// ---- persona ----

function packaged(name, packagedDir) {
    try { return fs.readFileSync(path.join(packagedDir || PACKAGED_PERSONA, PERSONA[name].file), 'utf8'); } catch (_) { return ''; }
}
// {soul, identity, facts, edited: {soul, identity, facts}}: an edited copy in the data folder
// replaces the packaged text.
function persona(dir, packagedDir) {
    const out = {edited: {}};
    Object.keys(PERSONA).forEach(name => {
        let text = null;
        if (dir) { try { text = fs.readFileSync(path.join(dir, 'persona', PERSONA[name].file), 'utf8'); } catch (_) {} }
        out.edited[name] = text !== null;
        out[name] = (text !== null ? text : packaged(name, packagedDir)).slice(0, PERSONA[name].max);
    });
    return out;
}
// Persona changes from the page: {soul|identity|facts: text, or null for the packaged text}.
// options.dryRun: check only.
function updatePersona(dir, patch, options, packagedDir) {
    const errors = {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {ok: false, errors: {_: 'Expected an object of persona texts.'}};
    Object.keys(patch).forEach(name => {
        const value = patch[name];
        if (!PERSONA[name]) errors[name] = 'Unknown persona part.';
        else if (value !== null && typeof value !== 'string') errors[name] = 'Text, please.';
        else if (value !== null && value.length > PERSONA[name].max) errors[name] = 'At most ' + PERSONA[name].max + ' characters; this is ' + value.length + '.';
    });
    if (Object.keys(errors).length) return {ok: false, errors: errors};
    if (options && options.dryRun) return {ok: true, errors: {}};
    Object.keys(patch).forEach(name => {
        const target = path.join(dir, 'persona', PERSONA[name].file), value = patch[name];
        if (value === null || value === packaged(name, packagedDir)) { try { fs.unlinkSync(target); } catch (_) {} }
        else atomic(target, value);
    });
    return {ok: true, errors: {}};
}

module.exports = {SCHEMA, DEFAULTS, PERSONA, SECRETS, dataDir, file, read, update, publicView, secrets, schemaView, check,
    persona, updatePersona, packaged, atomic};
