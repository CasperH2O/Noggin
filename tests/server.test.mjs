// The settings page's server (lib/server.js) and its start and stop by BEam (background.js),
// against a real HTTP server on a free port and a temporary data folder.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const server = require(path.join(source, 'noggin/lib/server.js'));
const settings = require(path.join(source, 'noggin/lib/settings.js'));
const ConversationLog = require(path.join(source, 'noggin/lib/conversation-log.js'));
const KEY = 'sk-test-0123456789abcdefghij';

async function running(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-server-'));
    const logs = [];
    const s = server.create(Object.assign({dataDir: dir, webDir: path.join(source, 'noggin/web'), version: '9.9.9',
        log: {info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push('ERROR ' + m)}}, over));
    const address = await s.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + address.port;
    const call = (method, url, body, headers = {}) => fetch(base + url, {method,
        headers: Object.assign(body !== undefined ? {'Content-Type': 'application/json', Origin: base} : {}, headers),
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
    return {s, dir, base, call, logs, stop: () => s.close()};
}

test('the page and its files are served; anything else is not', async () => {
    const r = await running();
    try {
        const page = await r.call('GET', '/');
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /text\/html/);
        assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
        assert.match(await page.text(), /<script src="app.js">/);
        for (const file of ['/style.css', '/app.js', '/logo.png', '/favicon.png']) assert.equal((await r.call('GET', file)).status, 200, file);
        for (const bad of ['/../lib/settings.js', '/lib/server.js', '/web/app.js', '/%2e%2e/package.json']) assert.equal((await r.call('GET', bad)).status, 404, bad);
    } finally { await r.stop(); }
});

test('GET /api/settings: schema, values, persona with its packaged text, budget; never the key', async () => {
    const r = await running();
    try {
        settings.update(r.dir, {apiKey: KEY, silenceSeconds: 30});
        const res = await r.call('GET', '/api/settings');
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const text = await res.text(), state = JSON.parse(text);
        assert.ok(!text.includes(KEY), 'the key never leaves the robot');
        assert.equal(state.version, '9.9.9');
        assert.equal(state.values.silenceSeconds, 30);
        assert.equal(state.key.set, true);
        assert.ok(state.schema.find(f => f.key === 'realtimeModel'));
        assert.match(state.persona.soul, /Family safe/);
        assert.equal(state.persona.packaged.soul, state.persona.soul);
        assert.deepEqual(state.persona.edited, {soul: false, identity: false, facts: false});
        assert.ok(state.budget.chars > 1000 && state.budget.recommended === server.BUDGET);
    } finally { await r.stop(); }
});

test('POST /api/settings saves values and persona together, or nothing on any error', async () => {
    const r = await running();
    try {
        let res = await r.call('POST', '/api/settings', {values: {apiKey: KEY, greeting: 'Hello!'}, persona: {soul: 'You are a pirate robot.'}});
        assert.equal(res.status, 200);
        const state = await res.json();
        assert.equal(state.ok, true); assert.equal(state.values.greeting, 'Hello!'); assert.equal(state.persona.edited.soul, true);
        assert.equal(settings.read(r.dir).apiKey, KEY);
        res = await r.call('POST', '/api/settings', {values: {greeting: 'Bye!', silenceSeconds: 1}, persona: {identity: 'x'.repeat(9000)}});
        assert.equal(res.status, 400);
        const errors = (await res.json()).errors;
        assert.ok(errors.values.silenceSeconds && errors.persona.identity);
        assert.equal(settings.read(r.dir).greeting, 'Hello!', 'nothing saved');
        assert.equal(settings.persona(r.dir).edited.identity, false);
        res = await r.call('POST', '/api/settings', {values: {greeting: null}, persona: {soul: null}});
        const reset = await res.json();
        assert.equal(reset.values.greeting, 'Hi!'); assert.equal(reset.persona.edited.soul, false);
        assert.ok(r.logs.some(l => /settings saved: greeting/.test(l) && !l.includes(KEY)));
    } finally { await r.stop(); }
});

test('guards: another site, non-JSON, wrong method, oversized and broken bodies are refused', async () => {
    const r = await running();
    try {
        assert.equal((await r.call('POST', '/api/settings', {values: {greeting: 'x'}}, {Origin: 'http://evil.example'})).status, 403);
        assert.equal((await r.call('POST', '/api/settings', {values: {greeting: 'x'}}, {Origin: '', Referer: 'http://evil.example/page'})).status, 403);
        assert.equal((await r.call('POST', '/api/settings', 'greeting=x', {'Content-Type': 'application/x-www-form-urlencoded'})).status, 415);
        assert.equal((await r.call('POST', '/api/settings', 'text', {'Content-Type': 'text/plain'})).status, 415);
        assert.equal((await r.call('PUT', '/api/settings', {})).status, 405);
        assert.equal((await r.call('POST', '/api/settings', '{nope')).status, 400);
        assert.equal((await r.call('POST', '/api/settings', '[1]')).status, 400);
        assert.equal((await r.call('POST', '/api/settings', JSON.stringify({persona: {soul: 'x'.repeat(server.BODY_MAX)}}))).status, 413);
        assert.equal((await r.call('POST', '/api/nothing', {})).status, 404);
        assert.equal(fs.existsSync(settings.file(r.dir)), false, 'nothing written');
    } finally { await r.stop(); }
});

test('a new API address needs the key again in the same save; OpenAI\'s own address does not', async () => {
    const r = await running();
    try {
        settings.update(r.dir, {apiKey: KEY});
        let res = await r.call('POST', '/api/settings', {values: {apiBase: 'http://192.168.1.50:9000/v1'}});
        assert.equal(res.status, 400);
        assert.match((await res.json()).errors.values.apiBase, /key again/);
        assert.equal(settings.read(r.dir).apiBase, 'https://api.openai.com/v1', 'nothing saved');
        res = await r.call('POST', '/api/settings', {values: {apiBase: 'http://192.168.1.50:9000/v1', apiKey: 'sk-proxy-0123456789abcdef'}});
        assert.equal(res.status, 200);
        res = await r.call('POST', '/api/settings', {values: {greeting: 'Hey!'}});
        assert.equal(res.status, 200, 'other saves need no key');
        res = await r.call('POST', '/api/settings', {values: {apiBase: null}});
        assert.equal(res.status, 200, 'back to the default address');
        res = await r.call('POST', '/api/settings', {values: {apiBase: 'https://api.openai.com/v1'}});
        assert.equal(res.status, 200);
    } finally { await r.stop(); }
});

test('Host: Jibo\'s address, localhost, a one-word or .local name; a public domain name (DNS rebinding) is refused', async () => {
    const r = await running();
    const port = Number(r.base.split(':').pop());
    const get = host => new Promise((resolve, reject) => {
        http.get({host: '127.0.0.1', port, path: '/api/settings', headers: {Host: host}}, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    try {
        for (const ok of ['192.168.1.20:8131', 'localhost:8131', 'jibo:8131', 'jibo.local', '[::1]:8131']) assert.equal(await get(ok), 200, ok);
        for (const bad of ['evil.example', 'rebind.attacker.com:8131']) assert.equal(await get(bad), 403, bad);
    } finally { await r.stop(); }
});

test('POST /api/test-key: a typed key, else the saved one; the answer never carries the key', async () => {
    const asked = [];
    const r = await running({checkKey: config => { asked.push(config); return Promise.resolve({ok: config.apiKey === KEY, ms: 5, status: config.apiKey === KEY ? 200 : 401}); }});
    try {
        let res = await r.call('POST', '/api/test-key', {});
        assert.deepEqual(await res.json(), {ok: false, error: 'no key saved yet'});
        settings.update(r.dir, {apiKey: KEY});
        res = await r.call('POST', '/api/test-key', {});
        assert.equal(res.status, 200, 'an OpenAI status is not the HTTP status');
        assert.equal((await res.json()).ok, true);
        res = await r.call('POST', '/api/test-key', {key: 'sk-wrong-key'});
        assert.equal((await res.json()).ok, false);
        assert.equal(asked[1].apiBase, 'https://api.openai.com/v1');
    } finally { await r.stop(); }
});

test('conversation logs: list newest first, read one by name, nothing else', async () => {
    const r = await running();
    try {
        new ConversationLog(r.dir, true).write({kind: 'you', text: 'hello'});
        const list = await (await r.call('GET', '/api/logs')).json();
        assert.equal(list.logs.length, 1);
        const one = await r.call('GET', '/api/logs/' + list.logs[0].name);
        assert.equal(one.status, 200);
        assert.match(await one.text(), /"text":"hello"/);
        assert.equal((await r.call('GET', '/api/logs/..%2Fsettings.json')).status, 404);
        assert.equal((await r.call('GET', '/api/logs/%E0%A4%A')).status, 404);
    } finally { await r.stop(); }
});

test('a handler that throws answers 500 and the server keeps running', async () => {
    let broken = true;
    const r = await running({dataDir: () => { if (broken) throw Error('disk gone'); return os.tmpdir(); }});
    try {
        const res = await r.call('GET', '/api/settings');
        assert.equal(res.status, 500);
        assert.ok(r.logs.some(l => /ERROR settings page: Error: disk gone/.test(l)));
        broken = false;
        assert.equal((await r.call('GET', '/')).status, 200);
    } finally { await r.stop(); }
});

test('close() drops open connections and frees the port at once', async () => {
    const r = await running();
    const port = Number(r.base.split(':').pop());
    const idle = net.connect(port, '127.0.0.1');
    await new Promise(resolve => idle.once('connect', resolve));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(r.s.connections(), 1);
    await r.stop();
    assert.equal(r.s.connections(), 0);
    const again = server.create({dataDir: r.dir, webDir: path.join(source, 'noggin/web')});
    await again.listen(port, '127.0.0.1');
    await again.close();
    idle.destroy();
});

// ---- background.js, as BEam runs it ----
function freshBackground() {
    const file = path.join(source, 'noggin/background.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}
const fakeApi = logs => ({skillId: '@be/noggin', log: {info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push('ERROR ' + m)}});

test('background: starts the page on 8131, stops it again, and a second start reuses the port', async () => {
    const blocker = net.createServer();
    const free = await new Promise(resolve => blocker.listen(8131, '0.0.0.0', () => resolve(true)).once('error', () => resolve(false)));
    if (free) await new Promise(resolve => blocker.close(resolve));
    if (!free) return;   // something else holds 8131 on this machine
    const logs = [];
    const background = freshBackground();
    background.start(fakeApi(logs));
    for (let i = 0; i < 50 && !logs.some(l => /on port 8131/.test(l)); i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(logs.some(l => /\[noggin\] settings page on port 8131/.test(l)), logs.join('\n'));
    const page = await fetch('http://127.0.0.1:8131/');
    assert.equal(page.status, 200);
    await background.stop();
    const next = freshBackground();
    next.start(fakeApi(logs));
    for (let i = 0; i < 50 && logs.filter(l => /on port 8131/.test(l)).length < 2; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(logs.filter(l => /on port 8131/.test(l)).length, 2, 'the next revision gets the port');
    await next.stop();
});

test('background: a busy port is retried, and stop() cancels the retry', async () => {
    const blocker = net.createServer();
    const held = await new Promise(resolve => blocker.listen(8131, '0.0.0.0', () => resolve(true)).once('error', () => resolve(false)));
    if (!held) return;
    const logs = [];
    const background = freshBackground();
    try {
        background.start(fakeApi(logs));
        await new Promise(r => setTimeout(r, 100));
        assert.ok(!logs.some(l => /on port|ERROR/.test(l)), 'waiting to retry, no error yet: ' + logs.join('\n'));
    } finally {
        await background.stop();
        await new Promise(resolve => blocker.close(resolve));
    }
    await new Promise(r => setTimeout(r, 2200));
    assert.ok(!logs.some(l => /on port 8131/.test(l)), 'no start after stop()');
});

test('background: without an HTTP server (the simulator) it logs and does nothing', () => {
    const logs = [];
    const http = require('http');
    const original = http.createServer;
    http.createServer = undefined;
    try {
        const background = freshBackground();
        assert.doesNotThrow(() => background.start(fakeApi(logs)));
        assert.doesNotThrow(() => background.stop());
    } finally { http.createServer = original; }
    assert.ok(logs.some(l => /settings page off: no HTTP server/.test(l)));
});
