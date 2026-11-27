// SPDX-License-Identifier: MIT
// The shared helpers: one JSON request with its caps (lib/http.js), deadlines, whole-file writes
// (lib/files.js), text and time (lib/text.js), and when an OpenAI call moves to the page's fetch
// (lib/openai.js).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const web = require(path.join(source, 'noggin/lib/http.js'));
const files = require(path.join(source, 'noggin/lib/files.js'));
const strings = require(path.join(source, 'noggin/lib/text.js'));
const openai = require(path.join(source, 'noggin/lib/openai.js'));
const actions = require(path.join(source, 'noggin/lib/actions.js'));
const memory = require(path.join(source, 'noggin/lib/memory.js'));

// A local server in place of OpenAI; answer(req, res) answers each request. Resolves {url, hits, stop()}.
async function serve(answer) {
    const stub = {hits: 0};
    const server = http.createServer((req, res) => { stub.hits++; answer(req, res); });
    const sockets = new Set();
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    stub.url = 'http://127.0.0.1:' + server.address().port;
    stub.stop = () => new Promise(r => { sockets.forEach(s => s.destroy()); server.close(r); });
    return stub;
}

test('requestJson: JSON in and out, not JSON is null, too large, too slow and aborted all end the request', async () => {
    const stub = await serve((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            if (req.url === '/echo') { res.writeHead(201); res.end(JSON.stringify({method: req.method, type: req.headers['content-type'], body: body})); }
            else if (req.url === '/text') { res.writeHead(200); res.end('<html>'); }
            else if (req.url === '/big') { res.writeHead(200); res.end('"' + 'x'.repeat(4096) + '"'); }
            // /slow never answers
        });
    });
    try {
        const r = await web.requestJson({url: stub.url + '/echo', method: 'POST', body: {a: 1}});
        assert.equal(r.status, 201); assert.deepEqual(r.json, {method: 'POST', type: 'application/json', body: '{"a":1}'});
        assert.ok(r.ms >= 0);
        assert.equal((await web.requestJson({url: stub.url + '/text'})).json, null);
        await assert.rejects(web.requestJson({url: stub.url + '/big', maxBytes: 1000}), /answer too large/);
        await assert.rejects(web.requestJson({url: stub.url + '/slow', timeoutMs: 50, timeoutMessage: 'no answer in time'}), /^Error: no answer in time$/);
        let abort = null;
        const pending = web.requestJson({url: stub.url + '/slow', timeoutMs: 60000, track: cancel => { abort = cancel; }});
        abort('closed');
        await assert.rejects(pending, /^Error: closed$/);
        await assert.rejects(web.requestJson({url: 'http://127.0.0.1:1/'}), e => e.code === 'ECONNREFUSED');
        assert.equal(web.MAX_BYTES, 1024 * 1024);
    } finally { await stub.stop(); }
});

test('withTimeout: the answer, or what onTimeout gives or throws; never both', async () => {
    assert.equal(await web.withTimeout(Promise.resolve(1), 50, () => 2), 1);
    assert.equal(await web.withTimeout(new Promise(() => {}), 10, () => 2), 2);
    await assert.rejects(web.withTimeout(new Promise(() => {}), 10), /^Error: timeout$/);
    await assert.rejects(web.withTimeout(new Promise(() => {}), 10, () => { throw Error('late'); }), /late/);
    await assert.rejects(web.withTimeout(Promise.reject(Error('own')), 50, () => 2), /own/);
    let called = 0;
    await web.withTimeout(new Promise(r => setTimeout(() => r(1), 5)), 30, () => { called++; });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(called, 0, 'the timer ends with the answer');
});

test('atomic: a failed write leaves the old file and no temporary file behind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-files-')), target = path.join(dir, 'a', 'b.json');
    files.atomic(target, '{"v":1}');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
    const writeSync = fs.writeSync;
    fs.writeSync = () => { throw Object.assign(Error('no space left'), {code: 'ENOSPC'}); };
    try { assert.throws(() => files.atomic(target, '{"v":2}'), /no space left/); }
    finally { fs.writeSync = writeSync; }
    assert.equal(fs.readFileSync(target, 'utf8'), '{"v":1}');
    assert.equal(fs.existsSync(target + '.new'), false);
    files.atomic(target, '{"v":3}');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"v":3}');
    assert.equal(files.readPart(target, 5, 1), '3');
});

test('fold: one accent table for memory search and spoken app names', () => {
    assert.equal(strings.fold('Łódź Čapek ā ß Æ ĳ'), 'lodz capek a ss ae ij');
    assert.equal(strings.plainLetters('Łódź'), 'Lodz');
    assert.equal(actions.spokenName('Čapek Łódź ā'), 'Capek Lodz a');
    const state = memory.empty();
    memory.addFact(state, 'Babcia lives in Łódź.', 'asked');
    assert.equal(memory.search(state, 'lodz', 3, '2026-11-19')[0], 'Babcia lives in Łódź.');
    assert.equal(memory.addFact(state, 'Babcia lives in Lodz', 'asked').duplicate, true, 'the same fact without accents');
});

test('text: answer text, two digits, local time, day and month names', () => {
    assert.equal(strings.responseText({output_text: 'a'}), 'a');
    assert.equal(strings.responseText({output: [{type: 'reasoning'}, {content: [{type: 'refusal'}, {type: 'output_text', text: 'b'}, {type: 'output_text', text: 'c'}]}]}), 'b');
    assert.equal(strings.responseText(null), null);
    assert.equal(strings.pad2(7) + strings.pad2(12), '0712');
    const t = strings.systemTime(new Date(2026, 10, 19, 19, 5).getTime());
    assert.deepEqual(t, {year: 2026, monthNum: 10, date: 19, dayOfWeek: 'Thursday', hour: 19, minute: 5, zone: null});
    assert.equal(strings.DAYS.length, 7); assert.equal(strings.MONTHS[10], 'November');
});

test('OpenAI: only Node\'s own HTTPS failing moves a call to the page\'s fetch; offline, a timeout or a stop never does', async () => {
    const fetched = [];
    global.fetch = (address) => { fetched.push(address); return Promise.resolve({status: 200, text: () => Promise.resolve('{"output_text": "{}"}')}); };
    const slow = await serve(() => {});
    const garbled = await serve((req, res) => { res.writeHead(200); res.end('not json'); });
    try {
        assert.equal(openai.switchesToPage(Object.assign(Error('connect'), {code: 'ECONNREFUSED'})), false);
        assert.equal(openai.switchesToPage(Error('timeout')), false);
        assert.equal(openai.switchesToPage(Error('answer too large')), false);
        assert.equal(openai.switchesToPage(Object.assign(Error('wrong version number'), {code: 'EPROTO'})), true);
        const post = openai.poster({apiBase: slow.url + '/v1', apiKey: 'sk-test'});
        await assert.rejects(post('/responses', {}, 80), /^Error: timeout$/);
        await assert.rejects(post('/responses', {}, 80), /^Error: timeout$/);
        assert.deepEqual(fetched, [], 'a Node timeout fails the call');
        // The classifier follows the same rule.
        const offline = openai.classifier({apiBase: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', classifierModel: 'm'});
        await assert.rejects(offline('hi', '', 'reaction'), e => e.code === 'ECONNREFUSED');
        assert.deepEqual(fetched, []);
        // An error page (a proxy's 502) is that call's answer; Node is asked again next time.
        const proxy = await serve((req, res) => { res.writeHead(502); res.end('<html>Bad gateway</html>'); });
        try {
            const viaProxy = openai.classifier({apiBase: proxy.url + '/v1', apiKey: 'sk-test', classifierModel: 'm'});
            assert.equal((await viaProxy('hi', '', 'reaction')).error, 'HTTP 502');
            await viaProxy('hi', '', 'reaction');
            assert.deepEqual(fetched, []);
            assert.equal(proxy.hits, 2, 'Node is asked again');
        } finally { await proxy.stop(); }
        // A success Node could not read: from then on the page's fetch.
        const classify = openai.classifier({apiBase: garbled.url + '/v1', apiKey: 'sk-test', classifierModel: 'm'});
        await classify('hi', '', 'reaction');
        await classify('hi', '', 'reaction');
        assert.equal(fetched.length, 2);
        assert.equal(garbled.hits, 1, 'Node is not asked again');
        // The page's fetch has the same 1 MB cap as Node's path.
        global.fetch = () => Promise.resolve({status: 200, text: () => Promise.resolve('x'.repeat(1024 * 1024 + 1))});
        await assert.rejects(openai.poster({apiBase: garbled.url + '/v1', apiKey: 'sk-test'})('/responses', {}, 1000), /answer too large/);
    } finally { delete global.fetch; await slow.stop(); await garbled.stop(); }
});

test('OpenAI poster: abort() stops every call in flight; track cancels one call alone; a cancel never falls back', async () => {
    const slow = await serve(() => {});
    const fetched = [];
    global.fetch = address => { fetched.push(address); return new Promise(() => {}); };
    try {
        const post = openai.poster({apiBase: slow.url + '/v1', apiKey: 'sk-test'});
        let cancelOne = null;
        const one = post('/responses', {}, 5000, cancel => { cancelOne = cancel; });
        const two = post('/responses', {}, 5000), three = post('/responses', {}, 5000);
        cancelOne('not needed');
        await assert.rejects(one, /^Error: not needed$/);
        post.abort();
        await assert.rejects(two, /^Error: stopped$/);
        await assert.rejects(three, /^Error: stopped$/);
        assert.deepEqual(fetched, [], 'a cancel with its own reason is not a TLS failure');
        const later = post('/responses', {}, 50);
        await assert.rejects(later, /^Error: timeout$/);
        assert.deepEqual(fetched, [], 'the poster still uses Node');
    } finally { delete global.fetch; await slow.stop(); }
});

test('OpenAI: the page\'s fetch ends after its timeout; without fetch nothing switches', async () => {
    global.fetch = () => new Promise(() => {});
    try {
        const ask = openai.asker({apiBase: 'http://127.0.0.1:1/v1', apiKey: 'sk-test'});
        await assert.rejects(ask('GET', '/models', null, 50), e => e.code === 'ECONNREFUSED', 'offline: the error itself');
    } finally { delete global.fetch; }
    assert.equal(openai.switchesToPage(Object.assign(Error('wrong version number'), {code: 'EPROTO'})), false, 'no fetch here');
});

test('connect: the key never reaches an error text', async () => {
    const key = 'sk-proj-SECRET0123456789abcd';
    class Refusing { constructor(address, protocols) { throw Error('The subprotocol \'' + protocols[1] + '\' is invalid.'); } }
    const error = await openai.connect({apiBase: 'https://api.openai.com/v1', realtimeModel: 'm', apiKey: key}, Refusing).catch(e => e);
    assert.ok(!error.message.includes(key));
    assert.match(error.message, /openai-insecure-api-key\.sk-…abcd/);
    class Closing { constructor() { setTimeout(() => this.onclose({code: 1006}), 5); } close() {} }
    const closed = await openai.connect({apiBase: 'https://api.openai.com/v1', realtimeModel: 'm', apiKey: key}, Closing).catch(e => e);
    assert.equal(closed.message, 'connection closed (1006)');
});

test('checkKey: the answer\'s status as a verdict, a silent server as no answer', async () => {
    const stub = await serve((req, res) => {
        if (req.url === '/v1/models') { res.writeHead(req.headers.authorization === 'Bearer good' ? 200 : 401); res.end('{"data":[]}'); }
    });
    try {
        assert.equal((await openai.checkKey({apiBase: stub.url + '/v1', apiKey: 'good'})).ok, true);
        const bad = await openai.checkKey({apiBase: stub.url + '/v1', apiKey: 'bad'});
        assert.deepEqual([bad.ok, bad.status, bad.error], [false, 401, 'OpenAI does not accept this key']);
        const silent = await openai.checkKey({apiBase: stub.url + '/slow', apiKey: 'good'}, 50);
        assert.deepEqual([silent.ok, silent.status, silent.error], [false, null, 'no answer from OpenAI']);
    } finally { await stub.stop(); }
});
