// Settings (lib/settings.js), the persona overrides and the conversation logs.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const settings = require(path.join(source, 'noggin/lib/settings.js'));
const actions = require(path.join(source, 'noggin/lib/actions.js'));
const ConversationLog = require(path.join(source, 'noggin/lib/conversation-log.js'));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-settings-'));
const KEY = 'sk-test-0123456789abcdefghij';
// Every default except the keys, as a conversation without settings.json gets them.
const DEFAULTS = {};
settings.SCHEMA.forEach(field => { if (!settings.SECRETS.includes(field.key)) DEFAULTS[field.key] = field.default; });

test('transcription: gpt-transcribe is the default, and the usage tab counts it as transcription', () => {
    assert.equal(DEFAULTS.transcribeModel, 'gpt-transcribe');
    const usage = require(path.join(source, 'noggin/lib/usage.js'));
    assert.equal(usage.featureOf('gpt-transcribe', DEFAULTS), 'transcription');
});

test('transcription languages: English and Dutch by default, known codes only, in a fixed order', () => {
    assert.deepEqual(DEFAULTS.transcribeLanguages, ['en', 'nl']);
    const field = settings.SCHEMA.find(f => f.key === 'transcribeLanguages');
    assert.deepEqual(settings.check(field, ['nl', 'en']).value, ['en', 'nl']);
    assert.deepEqual(settings.check(field, []).value, [], 'none: the model guesses');
    assert.match(settings.check(field, ['nl', 'xx']).error, /Unknown: xx/);
});

test('schema: every field has a key, type, tab, group and label, and its default passes its own check', () => {
    const keys = new Set();
    for (const field of settings.SCHEMA) {
        assert.ok(field.key && field.type && field.tab && field.group && field.label, JSON.stringify(field));
        assert.ok(!keys.has(field.key), 'duplicate ' + field.key); keys.add(field.key);
        assert.ok(['brain', 'behaviour', 'skills', 'memory', 'history', 'usage'].includes(field.tab), field.key + ' tab');
        if (settings.SECRETS.includes(field.key)) continue;
        if (field.default === null) continue;
        assert.equal(settings.check(field, field.default).error, undefined, field.key + ' default');
    }
    assert.equal(DEFAULTS.apiKey, undefined, 'the key has no default');
    assert.equal(DEFAULTS.adminKey, undefined, 'the admin key has no default');
});

test('the admin key: sk-admin- only, never in the page view, only as a hint; secrets() has both keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-settings-'));
    assert.match(settings.update(dir, {adminKey: 'sk-proj-0123456789abcdefghij'}).errors.adminKey, /sk-admin-/);
    assert.equal(settings.update(dir, {apiKey: 'sk-proj-0123456789abcdefghij', adminKey: 'sk-admin-0123456789abcdefghij'}).ok, true);
    const view = settings.publicView(dir), text = JSON.stringify(view);
    assert.ok(!text.includes('sk-admin-0123456789abcdefghij') && !text.includes('sk-proj-0123456789abcdefghij'));
    assert.equal(view.values.adminKey, undefined);
    assert.equal(view.adminKey.set, true);
    assert.match(view.adminKey.hint, /^sk-…ghij/);
    assert.deepEqual(settings.secrets(dir), {apiKey: 'sk-proj-0123456789abcdefghij', adminKey: 'sk-admin-0123456789abcdefghij'});
    assert.equal(settings.read(dir).adminKey, undefined, 'a conversation\'s settings never carry the admin key');
    assert.equal(settings.update(dir, {adminKey: null}).ok, true);
    assert.equal(settings.secrets(dir).adminKey, '');
    assert.equal(settings.publicView(dir).adminKey.set, false);
});

test('schema view: JSON-safe, patterns as strings, option lists resolved, joke and the local tools are choices', () => {
    const view = JSON.parse(JSON.stringify(settings.schemaView()));
    const model = view.find(f => f.key === 'realtimeModel');
    assert.equal(typeof model.pattern, 'string');
    const cloud = view.find(f => f.key === 'cloudSkills');
    assert.deepEqual(cloud.options.find(o => o.value === 'joke'), {value: 'joke'}, 'joke is a plain choice, not greyed out');
    const local = view.find(f => f.key === 'localSkills');
    assert.deepEqual(local.options.map(o => o.value), Object.keys(actions.LOCAL));
    assert.ok(local.options.every(o => o.label), 'each local tool has a name for the page');
    assert.deepEqual(local.default, Object.keys(actions.LOCAL));
    const greet = view.find(f => f.key === 'greetingExpression');
    assert.ok(greet.options.some(o => o.value === 'smile') && greet.options.some(o => o.value === 'none'));
    assert.ok(!greet.options.some(o => o.value === 'dance'));
});

test('read: no file or no key is no_key; defaults fill the rest; invalid stored values fall back', () => {
    const dir = temp();
    assert.throws(() => settings.read(dir), /no_key/);
    fs.writeFileSync(settings.file(dir), JSON.stringify({apiKey: KEY, silenceSeconds: 30, realtimeModel: 'bad model!', greeting: ''}));
    const c = settings.read(dir);
    assert.equal(c.apiKey, KEY); assert.equal(c.silenceSeconds, 30);
    assert.equal(c.realtimeModel, 'gpt-realtime-2.1', 'an invalid stored model falls back to the default');
    assert.equal(c.greeting, '', 'an empty greeting means none');
    assert.deepEqual(settings.publicView(dir).problems, {realtimeModel: 'Letters, digits and . _ : - only.'});
    fs.writeFileSync(settings.file(dir), '{broken');
    assert.throws(() => settings.read(dir), /settings\.json/);
    assert.ok(settings.publicView(dir).broken);
});

test('update: all or nothing; stores only what differs from the default; null resets; mode 0600', () => {
    const dir = path.join(temp(), 'nested', 'noggin');
    assert.deepEqual(settings.update(dir, {apiKey: KEY, silenceSeconds: 90, greeting: 'Hello there!'}), {ok: true, errors: {}});
    assert.equal(fs.statSync(settings.file(dir)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const bad = settings.update(dir, {silenceSeconds: 2, realtimeModel: 'gpt-x', nope: 1});
    assert.equal(bad.ok, false);
    assert.deepEqual(Object.keys(bad.errors).sort(), ['nope', 'silenceSeconds']);
    assert.equal(settings.read(dir).realtimeModel, 'gpt-realtime-2.1', 'nothing saved on any error');
    settings.update(dir, {silenceSeconds: 60, greeting: null});
    const raw = JSON.parse(fs.readFileSync(settings.file(dir), 'utf8'));
    assert.deepEqual(raw, {apiKey: KEY}, 'defaults are not stored');
    assert.equal(fs.existsSync(settings.file(dir) + '.new'), false);
    // The reasoning effort: low is the default and is not stored; 'default' (send nothing) is.
    settings.update(dir, {realtimeReasoning: 'low'});
    assert.equal('realtimeReasoning' in JSON.parse(fs.readFileSync(settings.file(dir), 'utf8')), false);
    settings.update(dir, {realtimeReasoning: 'default'});
    assert.equal(settings.read(dir).realtimeReasoning, 'default');
    settings.update(dir, {realtimeReasoning: null});
    assert.equal(settings.read(dir).realtimeReasoning, 'low');
});

test('update: a stale temporary file from a power cut does not block saving', () => {
    const dir = temp();
    fs.writeFileSync(settings.file(dir) + '.new', 'half');
    assert.equal(settings.update(dir, {apiKey: KEY}).ok, true);
});

test('field checks: numbers, enums, sets, apps, urls, keys', () => {
    const f = key => settings.SCHEMA.find(x => x.key === key);
    assert.equal(settings.check(f('silenceSeconds'), '45').value, 45);
    assert.ok(settings.check(f('silenceSeconds'), 'x').error);
    assert.ok(settings.check(f('silenceSeconds'), '').error);
    assert.ok(settings.check(f('expressions'), 'true').error, 'booleans are real booleans');
    assert.ok(settings.check(f('danceAnnounce'), 'loud').error);
    assert.equal(settings.check(f('classifierReasoning'), 'none').value, 'none');
    assert.equal(settings.check(f('realtimeReasoning'), 'default').value, 'default', 'a real value: send nothing');
    assert.equal(settings.check(f('realtimeReasoning'), 'xhigh').value, 'xhigh');
    assert.ok(settings.check(f('realtimeReasoning'), 'loud').error);
    assert.equal(f('realtimeReasoning').default, 'low');
    assert.deepEqual(settings.check(f('cloudSkills'), ['news', 'weather']).value, ['weather', 'news'], 'kept in the cloud order');
    assert.deepEqual(settings.check(f('cloudSkills'), ['surprise', 'joke']).value, ['joke', 'surprise'], 'joke is a choice like the others');
    assert.deepEqual(settings.check(f('localSkills'), ['dance', 'get_time']).value, ['get_time', 'dance'], 'kept in the table order');
    assert.deepEqual(settings.check(f('localSkills'), []).value, [], 'none is allowed');
    assert.match(settings.check(f('localSkills'), ['fly']).error, /Unknown/);
    assert.match(settings.check(f('cloudSkills'), ['doom']).error, /Unknown/);
    // A package alone (older settings) or {pkg, about}; always {pkg, about} after the check.
    assert.deepEqual(settings.check(f('openApps'), {Stars: '@be/stargazer'}).value, {Stars: {pkg: '@be/stargazer', about: ''}});
    assert.deepEqual(settings.check(f('openApps'), {Stars: {pkg: '@be/stargazer', about: '  Space\npictures  '}}).value, {Stars: {pkg: '@be/stargazer', about: 'Space pictures'}});
    assert.match(settings.check(f('openApps'), {Stars: {pkg: '@be/stargazer', about: 'x'.repeat(121)}}).error, /at most 120 characters/);
    assert.match(settings.check(f('openApps'), {Stars: {pkg: '@be/stargazer', about: 7}}).error, /what it does is text/);
    assert.match(settings.check(f('openApps'), {Stars: {about: 'no package'}}).error, /package name/);
    assert.match(settings.check(f('openApps'), {Stars: ['@be/stargazer']}).error, /package name/);
    assert.match(settings.check(f('openApps'), {calls: 'telejibo'}).error, /package name/);
    assert.match(settings.check(f('openApps'), {'../x': '@be/x'}).error, /not a name/);
    const nine = {};
    for (let i = 1; i <= 9; i++) nine['App ' + String.fromCharCode(96 + i)] = '@be/app-' + i;
    assert.match(settings.check(f('openApps'), nine).error, /At most 8 apps/);
    delete nine['App i'];
    assert.equal(Object.keys(settings.check(f('openApps'), nine).value).length, 8);
    assert.equal(settings.schemaView().find(x => x.key === 'openApps').max, 8, 'the page knows the cap');
    assert.equal(settings.check(f('apiBase'), 'http://127.0.0.1:38111/v1/').value, 'http://127.0.0.1:38111/v1');
    assert.ok(settings.check(f('apiBase'), 'ftp://x').error);
    assert.match(settings.schemaView().find(x => x.key === 'apiBase').help, /public or localhost/);
    assert.ok(settings.check(f('apiKey'), 'has space').error);
    assert.ok(settings.check(f('greeting'), 'x'.repeat(201)).error);
});

test('public view: never the key, only whether one is set and a hint', () => {
    const dir = temp();
    assert.deepEqual(settings.publicView(dir).key, {set: false, hint: ''});
    settings.update(dir, {apiKey: KEY});
    const view = settings.publicView(dir);
    assert.equal(view.key.set, true);
    assert.equal(view.key.hint, 'sk-…ghij (' + KEY.length + ' characters)');
    assert.ok(!JSON.stringify(view).includes(KEY));
    assert.equal(view.values.apiKey, undefined);
});

test('persona: packaged by default; an edit overrides it; null or the packaged text removes the edit; limits', () => {
    const dir = temp();
    const packaged = settings.persona(dir);
    assert.deepEqual(packaged.edited, {soul: false, identity: false, facts: false});
    assert.match(packaged.soul, /Family safe/);
    assert.deepEqual(settings.updatePersona(dir, {soul: 'You are a pirate robot.'}), {ok: true, errors: {}});
    const edited = settings.persona(dir);
    assert.equal(edited.soul, 'You are a pirate robot.'); assert.equal(edited.edited.soul, true);
    assert.equal(fs.statSync(path.join(dir, 'persona/SOUL.md')).mode & 0o777, 0o600);
    settings.updatePersona(dir, {soul: packaged.soul});
    assert.equal(settings.persona(dir).edited.soul, false, 'the packaged text again is no edit');
    settings.updatePersona(dir, {identity: 'x'}); settings.updatePersona(dir, {identity: null});
    assert.equal(settings.persona(dir).edited.identity, false);
    const big = settings.updatePersona(dir, {facts: 'x'.repeat(settings.PERSONA.facts.max + 1), soul: 'ok'});
    assert.equal(big.ok, false); assert.ok(big.errors.facts);
    assert.equal(settings.persona(dir).edited.soul, false, 'all or nothing');
    assert.equal(settings.updatePersona(dir, {mood: 'x'}).ok, false);
    assert.equal(settings.updatePersona(dir, {soul: 5}).ok, false);
});

test('conversation logs: named per conversation, newest first, only log names can be read, size cap', () => {
    const dir = temp();
    const log = new ConversationLog(dir, true);
    log.write({kind: 'you', text: 'hi'});
    const list = ConversationLog.list(dir);
    assert.equal(list.length, 1); assert.match(list[0].name, /^conversation-\d{8}-\d{6}\.jsonl$/);
    assert.match(ConversationLog.read(dir, list[0].name), /"text":"hi"/);
    assert.equal(ConversationLog.read(dir, '../settings.json'), null);
    assert.equal(ConversationLog.read(dir, 'conversation-20260101-000000.jsonl'), null);
    log.bytes = ConversationLog.MAX_BYTES - 10;
    log.write({kind: 'you', text: 'this line does not fit'});
    log.write({kind: 'you', text: 'nor this one'});
    const lines = ConversationLog.read(dir, list[0].name).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.at(-1).kind, 'log_full'); assert.equal(lines.length, 2);
    assert.equal(new ConversationLog(dir, false).file, null, 'logging off writes nothing');
});

test('conversation logs: multi-byte text counts in bytes, and the oldest go when count or total size is reached', () => {
    const dir = temp();
    const log = new ConversationLog(dir, true);
    log.bytes = ConversationLog.MAX_BYTES - 100;
    log.write({kind: 'you', text: '😀'.repeat(30)});   // 30 characters x2, 120 bytes in UTF-8
    const name = ConversationLog.list(dir)[0].name;
    assert.equal(JSON.parse(ConversationLog.read(dir, name).trim().split('\n').at(-1)).kind, 'log_full');
    const logs = path.join(dir, 'logs');
    const big = Math.ceil(ConversationLog.TOTAL_BYTES / 12);
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(logs, 'conversation-20250101-0000' + String(i).padStart(2, '0') + '.jsonl'), Buffer.alloc(big));
    new ConversationLog(dir, true);
    const sizes = ConversationLog.list(dir).map(l => l.bytes).reduce((a, b) => a + b, 0);
    assert.ok(sizes + ConversationLog.MAX_BYTES <= ConversationLog.TOTAL_BYTES, 'room for one full log within the total');
    assert.ok(!fs.existsSync(path.join(logs, 'conversation-20250101-000000.jsonl')), 'the oldest went first');
    for (let i = 0; i < ConversationLog.KEEP + 5; i++) fs.writeFileSync(path.join(logs, 'conversation-20240101-' + String(i).padStart(6, '0') + '.jsonl'), 'x');
    new ConversationLog(dir, true);
    assert.ok(ConversationLog.list(dir).length <= ConversationLog.KEEP);
});

test('openApps over the cap: a save is refused; a stored longer list keeps its first 8, with a problem', () => {
    const dir = temp();
    const twelve = {};
    for (let i = 1; i <= 12; i++) twelve['App ' + String.fromCharCode(96 + i)] = '@be/app-' + i;
    assert.match(settings.update(dir, {apiKey: KEY, openApps: twelve}).errors.openApps, /At most 8/);
    fs.writeFileSync(settings.file(dir), JSON.stringify({apiKey: KEY, openApps: twelve}));
    const view = settings.publicView(dir);
    assert.deepEqual(Object.keys(view.values.openApps), ['App a', 'App b', 'App c', 'App d', 'App e', 'App f', 'App g', 'App h']);
    assert.match(view.problems.openApps, /first 8 of 12/);
    assert.equal(Object.keys(settings.read(dir).openApps).length, 8);
    // Another save leaves the list alone; trimming it clears the problem.
    assert.equal(settings.update(dir, {silenceSeconds: 30}).ok, true);
    assert.match(settings.publicView(dir).problems.openApps, /first 8/);
    assert.equal(settings.update(dir, {openApps: {Stars: '@be/stargazer'}}).ok, true);
    assert.equal(settings.publicView(dir).problems.openApps, undefined);
});

test('every config.<key> the code reads is a setting in the schema', () => {
    const code = ['noggin/index.js'].concat(fs.readdirSync(path.join(source, 'noggin/lib')).filter(n => n.endsWith('.js')).map(n => 'noggin/lib/' + n));
    const keys = new Set(settings.SCHEMA.map(f => f.key));
    // Animation configs, and a test-only override with a built-in default (D20); not settings.
    const other = new Set(['dofs', 'duration', 'replyWaitMs']);
    for (const file of code) {
        for (const [, name] of fs.readFileSync(path.join(source, file), 'utf8').matchAll(/\bconfig\.([a-zA-Z]+)/g)) {
            if (!other.has(name)) assert.ok(keys.has(name), file + ' reads config.' + name + ', which is not a setting');
        }
    }
});

test('come back within: 5 minutes by default, 1 to 60, on the Skills tab under Advanced', () => {
    const field = settings.SCHEMA.find(f => f.key === 'comebackMinutes');
    assert.deepEqual([field.default, field.min, field.max, field.unit, field.tab, !!field.advanced], [5, 1, 60, 'min', 'skills', true]);
    const dir = temp();
    assert.equal(settings.update(dir, {apiKey: KEY, comebackMinutes: 0}).ok, false);
    assert.equal(settings.update(dir, {apiKey: KEY, comebackMinutes: 10}).ok, true);
    assert.equal(settings.read(dir).comebackMinutes, 10);
});

test('keys: spaces and quotes around a pasted key are dropped; anything but letters, digits, _ and - is refused', () => {
    const field = settings.SCHEMA.find(f => f.key === 'apiKey'), admin = settings.SCHEMA.find(f => f.key === 'adminKey');
    assert.equal(settings.check(field, '  "' + KEY + '"\n').value, KEY);
    assert.equal(settings.check(field, '“' + KEY + '”').value, KEY);
    assert.equal(settings.check(field, "'" + KEY + "'").value, KEY);
    assert.match(settings.check(field, KEY + ',sk-other-0123456789').error, /does not look like an API key/);
    assert.match(settings.check(field, 'sk-test 0123456789').error, /does not look like an API key/);
    assert.match(settings.check(field, KEY + 'é').error, /does not look like an API key/);
    assert.equal(settings.check(admin, '"sk-admin-0123456789abcdefghij"').value, 'sk-admin-0123456789abcdefghij');
    const dir = temp();
    assert.equal(settings.update(dir, {apiKey: ' "' + KEY + '" '}).ok, true);
    assert.equal(settings.secrets(dir).apiKey, KEY);
});

test('load: settings.json read once, the values without the keys, the keys apart; removed settings are ignored', () => {
    const dir = temp();
    fs.writeFileSync(settings.file(dir), JSON.stringify({apiKey: KEY, budgetWarnPercent: 20, lab: 'timing', expressionPlay: 'esml', silenceSeconds: 'x'}));
    const loaded = settings.load(dir);
    assert.equal(loaded.config.budgetWarnPercent, 20);
    assert.equal(loaded.config.apiKey, undefined);
    assert.deepEqual(loaded.secrets, {apiKey: KEY, adminKey: ''});
    assert.equal(loaded.config.lab, undefined); assert.equal(loaded.config.expressionPlay, undefined);
    assert.deepEqual(Object.keys(loaded.problems), ['silenceSeconds']);
    assert.equal(loaded.broken, null);
    assert.equal(settings.read(dir).lab, undefined);
    // A save keeps only known settings, and a removed one cannot be set.
    assert.equal(settings.update(dir, {greeting: 'Hello'}).ok, true);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(settings.file(dir), 'utf8'))).sort(), ['apiKey', 'budgetWarnPercent', 'greeting', 'silenceSeconds']);
    assert.equal(settings.update(dir, {lab: 'timing'}).errors.lab, 'Unknown setting.');
    fs.writeFileSync(settings.file(dir), '{broken');
    assert.match(settings.load(dir).broken, /JSON/);
    assert.equal(settings.load(dir).secrets.apiKey, '');
});

test('ring refresh: every 500 ms by default, 0 leaves only the colour after each line', () => {
    const field = settings.SCHEMA.find(f => f.key === 'ringRefreshMs');
    assert.equal(field.default, 500);
    assert.match(field.help, /besides after each line; 0: only after each line/);
    assert.equal(settings.PORT, 8131);
});

test('on the robot an API address on the home network is refused when saved (BEam 3.2.0 without local-network, D154)', () => {
    const robot = '/opt/jibo/Knowledge/noggin';
    const refused = ['http://192.168.1.20:8080/v1', 'http://10.0.0.5/v1', 'http://172.16.0.9/v1', 'http://proxy.local/v1', 'http://nas.lan:9000', 'http://proxy/v1', 'http://100.64.1.2/v1', 'http://169.254.1.1/v1', 'http://[fd12::1]/v1'];
    for (const address of refused) {
        const result = settings.update(robot, {apiBase: address}, {dryRun: true});
        assert.equal(result.ok, false, address);
        assert.match(result.errors.apiBase, /public address or localhost/, address);
    }
    for (const address of ['https://api.openai.com/v1', 'https://proxy.example.com/v1', 'http://localhost:38111/v1', 'http://127.0.0.1:38111/v1', 'http://172.32.0.1/v1'])
        assert.equal(settings.update(robot, {apiBase: address}, {dryRun: true}).ok, true, address);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-settings-'));
    assert.equal(settings.update(elsewhere, {apiBase: 'http://192.168.1.20:8080/v1'}).ok, true, 'a development checkout has no such guard');
});

test('language: English by default; the greeting and comeback line follow it while unchanged (D170)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-lang-'));
    let view = settings.load(dir).config;
    assert.equal(view.language, 'en');
    assert.equal(view.greeting, 'Hi!'); assert.equal(view.comebackLine, 'Anything else?');
    assert.deepEqual(settings.update(dir, {language: 'nl'}), {ok: true, errors: {}});
    view = settings.load(dir).config;
    assert.equal(view.greeting, 'Hoi!'); assert.equal(view.comebackLine, 'Nog iets?');
    // Saving the Dutch default stores nothing, so switching back gives the English one again.
    settings.update(dir, {greeting: 'Hoi!'});
    assert.equal(JSON.parse(fs.readFileSync(settings.file(dir), 'utf8')).greeting, undefined);
    settings.update(dir, {language: 'en'});
    assert.equal(settings.load(dir).config.greeting, 'Hi!');
    // An edited greeting is kept in both languages.
    settings.update(dir, {greeting: 'Hallo allemaal'});
    settings.update(dir, {language: 'nl'});
    assert.equal(settings.load(dir).config.greeting, 'Hallo allemaal');
    assert.equal(settings.update(dir, {language: 'fr'}).ok, false, 'only English or Dutch');
});
