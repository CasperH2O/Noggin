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
const ConversationLog = require(path.join(source, 'noggin/lib/conversation-log.js'));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-settings-'));
const KEY = 'sk-test-0123456789abcdefghij';

test('schema: every field has a key, type, tab, group and label, and its default passes its own check', () => {
    const keys = new Set();
    for (const field of settings.SCHEMA) {
        assert.ok(field.key && field.type && field.tab && field.group && field.label, JSON.stringify(field));
        assert.ok(!keys.has(field.key), 'duplicate ' + field.key); keys.add(field.key);
        assert.ok(['brain', 'behaviour', 'skills', 'history'].includes(field.tab), field.key + ' tab');
        if (field.key === 'apiKey') continue;
        if (field.default === null) continue;
        assert.equal(settings.check(field, field.default).error, undefined, field.key + ' default');
    }
    assert.equal(settings.DEFAULTS.apiKey, undefined, 'the key has no default');
});

test('schema view: JSON-safe, patterns as strings, option lists resolved, joke shown as switched off', () => {
    const view = JSON.parse(JSON.stringify(settings.schemaView()));
    const model = view.find(f => f.key === 'realtimeModel');
    assert.equal(typeof model.pattern, 'string');
    const cloud = view.find(f => f.key === 'cloudSkills');
    assert.ok(cloud.options.find(o => o.value === 'joke').disabled);
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
    assert.deepEqual(settings.check(f('cloudSkills'), ['news', 'weather']).value, ['weather', 'news'], 'kept in the cloud order');
    assert.match(settings.check(f('cloudSkills'), ['joke']).error, /switched off/);
    assert.match(settings.check(f('cloudSkills'), ['doom']).error, /Unknown/);
    assert.deepEqual(settings.check(f('openApps'), {Stars: '@be/stargazer'}).value, {Stars: '@be/stargazer'});
    assert.match(settings.check(f('openApps'), {calls: 'telejibo'}).error, /package name/);
    assert.match(settings.check(f('openApps'), {'../x': '@be/x'}).error, /not a name/);
    assert.equal(settings.check(f('apiBase'), 'http://127.0.0.1:38111/v1/').value, 'http://127.0.0.1:38111/v1');
    assert.ok(settings.check(f('apiBase'), 'ftp://x').error);
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
    const big = settings.updatePersona(dir, {facts: 'x'.repeat(settings.FACTS_MAX + 1), soul: 'ok'});
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
