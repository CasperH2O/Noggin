// The model dropdowns' lists (lib/models.js), their settings and GET /api/models (D179).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const models = require(path.join(source, 'noggin/lib/models.js'));
const settings = require(path.join(source, 'noggin/lib/settings.js'));
const server = require(path.join(source, 'noggin/lib/server.js'));
const KEY = 'sk-test-0123456789abcdefghij';

const LIST = [
    {id: 'gpt-realtime-2.1', shutdown: null}, {id: 'gpt-realtime-2.1-mini', shutdown: null}, {id: 'gpt-realtime-2', shutdown: null},
    {id: 'gpt-realtime', shutdown: '2027-01-20'}, {id: 'gpt-realtime-2025-08-28', shutdown: '2027-01-20'}, {id: 'gpt-realtime-whisper', shutdown: null},
    {id: 'gpt-transcribe', shutdown: null}, {id: 'gpt-live-transcribe', shutdown: null}, {id: 'gpt-4o-mini-transcribe', shutdown: '2027-02-26'},
    {id: 'gpt-6-luna', shutdown: null}, {id: 'gpt-6-sol', shutdown: null}, {id: 'gpt-6-sol-healthcare', shutdown: null},
    {id: 'gpt-4o-mini', shutdown: '2027-01-14'}, {id: 'gpt-5.4-nano', shutdown: '2027-04-01'}, {id: 'gpt-5.4-mini', shutdown: null}
];

test('every job has tested models and exactly one recommended', () => {
    for (const role of Object.keys(models.ROLES)) {
        const list = models.verified(role);
        assert.ok(list.length >= 1, role);
        assert.equal(list.filter(m => m.recommended).length, 1, role);
    }
});

test('the default of each model setting is the recommended model of its job', () => {
    const fields = settings.SCHEMA.filter(f => f.type === 'model');
    assert.deepEqual(fields.map(f => f.role).sort(), ['conversation', 'expression', 'helper', 'transcription']);
    for (const f of fields) assert.equal(f.default, models.verified(f.role).filter(m => m.recommended)[0].id, f.key);
});

test('the schema the page gets carries the tested models of each model setting', () => {
    const view = settings.schemaView().filter(f => f.type === 'model');
    assert.equal(view.length, 4);
    view.forEach(f => assert.ok(f.verified.length && f.role, f.key));
    assert.ok(!settings.SCHEMA.some(f => f.key === 'fallbackModel'), 'the fallback model is gone');
});

test('a saved model outside the lists is still valid; one that is not a name is refused', () => {
    const field = settings.SCHEMA.find(f => f.key === 'realtimeModel');
    assert.deepEqual(settings.check(field, 'gpt-realtime-1.5'), {value: 'gpt-realtime-1.5'});
    assert.ok(settings.check(field, 'gpt realtime!').error);
    assert.ok(settings.check(field, '').error);
});

test('a saved fallbackModel is ignored without a complaint and dropped at the next save; the default is not stored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-models-'));
    fs.writeFileSync(settings.file(dir), JSON.stringify({apiKey: KEY, fallbackModel: 'gpt-4o-mini', realtimeModel: 'gpt-realtime-1.5'}));
    const loaded = settings.load(dir);
    assert.deepEqual(loaded.problems, {});
    assert.equal(loaded.config.helperModel, 'gpt-6-luna', 'the helper model follows its own default');
    assert.equal(loaded.config.realtimeModel, 'gpt-realtime-1.5', 'a saved name outside the lists comes back unchanged');
    assert.equal(settings.publicView(dir).values.realtimeModel, 'gpt-realtime-1.5');
    assert.ok(settings.update(dir, {realtimeModel: 'gpt-realtime-2.1'}).ok);
    const raw = JSON.parse(fs.readFileSync(settings.file(dir), 'utf8'));
    assert.deepEqual(raw, {apiKey: KEY}, 'the old key is gone and the default is not stored');
});

test('view: what the key sees, and the unverified models worth trying', () => {
    const v = models.view(LIST);
    assert.equal(v.available['gpt-realtime'], '2027-01-20');
    assert.equal(v.available['gpt-6-luna'], null);
    assert.deepEqual(v.others.conversation, ['gpt-realtime-2'], 'not the tested ones, not a shutdown one, not whisper or a dated snapshot');
    assert.deepEqual(v.others.transcription, [], 'the retiring model is not suggested');
    assert.deepEqual(v.others.expression, ['gpt-5.4-mini', 'gpt-6-sol'], 'no healthcare variant, no shutdown');
    assert.deepEqual(v.others.helper, v.others.expression);
});

test('parseList reads id and shutdown_date; anything else is no list', () => {
    assert.deepEqual(models.parseList({data: [{id: 'a', shutdown_date: '2027-01-14'}, {id: 'b', shutdown_date: null}, {id: 'c'}, {id: 'd', shutdown_date: 'soon'}, {nope: 1}]}),
        [{id: 'a', shutdown: '2027-01-14'}, {id: 'b', shutdown: null}, {id: 'c', shutdown: null}, {id: 'd', shutdown: null}]);
    assert.equal(models.parseList({}), null);
    assert.equal(models.parseList(null), null);
});

async function running(over) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-models-'));
    let clock = Date.UTC(2026, 10, 25);
    const s = server.create(Object.assign({dataDir: dir, webDir: path.join(source, 'noggin/web'), version: '9.9.9', now: () => new Date(clock),
        log: {info() {}, warn() {}, error() {}}}, over));
    const address = await s.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + address.port;
    return {dir, base, call: url => fetch(base + url), later: ms => { clock += ms; }, stop: () => s.close()};
}

test('GET /api/models: no key says so; with one, the key sees and the shutdowns; kept six hours; never carries the key', async () => {
    const asked = [];
    const r = await running({listModels: config => { asked.push(config); return Promise.resolve({models: LIST}); }});
    try {
        let res = await r.call('/api/models');
        assert.deepEqual(await res.json(), {ok: false, error: 'no key saved yet'});
        assert.equal(asked.length, 0);
        settings.update(r.dir, {apiKey: KEY});
        res = await r.call('/api/models');
        const text = await res.text(), body = JSON.parse(text);
        assert.equal(body.ok, true);
        assert.equal(body.available['gpt-4o-mini'], '2027-01-14');
        assert.ok(body.others.conversation.includes('gpt-realtime-2'));
        assert.ok(!text.includes(KEY));
        assert.equal(asked.length, 1);
        assert.equal(asked[0].apiKey, KEY);
        await r.call('/api/models');
        assert.equal(asked.length, 1, 'kept');
        r.later(5 * 3600000);
        await r.call('/api/models');
        assert.equal(asked.length, 1, 'still kept after five hours');
        await r.call('/api/models?refresh=1');
        assert.equal(asked.length, 2, 'refresh asks again');
        r.later(7 * 3600000);
        await r.call('/api/models');
        assert.equal(asked.length, 3, 'asked again after six hours');
    } finally { await r.stop(); }
});

test('GET /api/models: a refresh within a minute gets the kept answer; requests during a fetch share it; close aborts it', async () => {
    let asked = 0, release, aborted = null;
    const gate = new Promise(resolve => { release = resolve; });
    const r = await running({listModels: (config, timeoutMs, track) => { asked++; track(why => { aborted = why; }); return gate.then(() => ({models: LIST})); }});
    try {
        settings.update(r.dir, {apiKey: KEY});
        const [one, two] = [r.call('/api/models'), r.call('/api/models?refresh=1')];
        await new Promise(resolve => setTimeout(resolve, 50));
        release();
        assert.equal((await (await one).json()).ok, true);
        assert.equal((await (await two).json()).ok, true);
        assert.equal(asked, 1, 'one question for both');
        await r.call('/api/models?refresh=1');
        assert.equal(asked, 1, 'a refresh a few seconds later is the kept answer');
        r.later(61000);
        await r.call('/api/models?refresh=1');
        assert.equal(asked, 2, 'a refresh a minute later asks');
    } finally { await r.stop(); }
    // A fetch still running when the server closes is cancelled.
    const slow = await running({listModels: (config, timeoutMs, track) => { track(why => { aborted = why; }); return new Promise(() => {}); }});
    settings.update(slow.dir, {apiKey: KEY});
    slow.call('/api/models').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 50));
    aborted = null;
    await slow.stop();
    assert.equal(aborted, 'stopped');
});

test('GET /api/models: a failed answer is reported and not kept; a new key asks again', async () => {
    let fail = true, asked = 0;
    const r = await running({listModels: () => { asked++; return Promise.resolve(fail ? {error: 'OpenAI does not accept this key'} : {models: LIST}); }});
    try {
        settings.update(r.dir, {apiKey: KEY});
        assert.deepEqual(await (await r.call('/api/models')).json(), {ok: false, error: 'OpenAI does not accept this key'});
        fail = false;
        assert.equal((await (await r.call('/api/models')).json()).ok, true);
        assert.equal(asked, 2, 'the failure was not kept');
        settings.update(r.dir, {apiKey: 'sk-test-another-0123456789abc'});
        await r.call('/api/models');
        assert.equal(asked, 3, 'another key, another question');
    } finally { await r.stop(); }
});

test('listModels: the models endpoint with the key; shutdown_date read; errors named without the key', async () => {
    const openai = require(path.join(source, 'noggin/lib/openai.js'));
    const http = require('http');
    let seen = null, answer = {status: 200, body: {object: 'list', data: [{id: 'gpt-6-luna', shutdown_date: null}, {id: 'gpt-4o-mini', shutdown_date: '2027-01-14'}]}};
    const fake = http.createServer((req, res) => {
        seen = {url: req.url, auth: req.headers.authorization};
        res.writeHead(answer.status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(answer.body));
    });
    await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
    const config = {apiBase: 'http://127.0.0.1:' + fake.address().port + '/v1', apiKey: KEY};
    try {
        assert.deepEqual(await openai.listModels(config), {models: [{id: 'gpt-6-luna', shutdown: null}, {id: 'gpt-4o-mini', shutdown: '2027-01-14'}]});
        assert.deepEqual(seen, {url: '/v1/models', auth: 'Bearer ' + KEY});
        answer = {status: 401, body: {error: {message: 'bad key ' + KEY}}};
        const refused = await openai.listModels(config);
        assert.deepEqual(refused, {error: 'OpenAI does not accept this key'});
        answer = {status: 200, body: {nope: true}};
        assert.deepEqual(await openai.listModels(config), {error: 'OpenAI sent no model list'});
    } finally { fake.close(); }
    const down = await openai.listModels({apiBase: 'http://127.0.0.1:1/v1', apiKey: KEY});
    assert.ok(down.error && !down.error.includes(KEY));
});
