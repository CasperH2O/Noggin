// Noggin: timing for the log and the classifier's connections (D87, D89).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const AudioClock = require(path.join(source, 'noggin/lib/audio-clock.js'));
const openai = require(path.join(source, 'noggin/lib/openai.js'));

test('audio clock: when the audio at a server position was sent; bounded; reset for a new session', () => {
    const clock = new AudioClock();
    clock.sent(1000, 100); clock.sent(1100, 100);
    assert.equal(clock.sentMs, 200);
    assert.equal(clock.sentAt(50), 1000); assert.equal(clock.sentAt(150), 1100);
    assert.equal(clock.sentAt(250), null, 'not sent yet'); assert.equal(clock.sentAt(undefined), null);
    for (let i = 0; i < 700; i++) clock.sent(2000 + i, 85);
    assert.equal(clock.sends.length, 600);
    assert.equal(clock.sentAt(50), null, 'the oldest sends are gone');
    clock.reset();
    assert.equal(clock.sentMs, 0); assert.equal(clock.sentAt(50), null);
});

function server(handler) {
    const s = http.createServer(handler);
    return new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s)));
}
const answer = res => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); };

test('connection timing: a new socket, then the same one reused; a closed kept socket is reported', async () => {
    const s = await server((req, res) => { req.resume(); req.on('end', () => answer(res)); });
    const closed = [];
    const unwatch = openai.classifier({}).watch(info => closed.push(info));
    try {
        const config = {apiBase: 'http://127.0.0.1:' + s.address().port, apiKey: 'k'};
        const first = await openai.post(config, '/x', {a: 1}, 2000);
        assert.equal(first.conn.reused, false);
        assert.equal(typeof first.conn.tcp_ms, 'number'); assert.equal(typeof first.conn.ttfb_ms, 'number');
        assert.equal(first.conn.tls_ms, undefined, 'plain HTTP has no TLS');
        await new Promise(resolve => setTimeout(resolve, 30));
        const second = await openai.post(config, '/x', {a: 2}, 2000);
        assert.equal(second.conn.reused, true); assert.equal(second.conn.socket, first.conn.socket);
        assert.ok(second.conn.idle_ms >= 20, JSON.stringify(second.conn));
        s.closeAllConnections();
        for (let i = 0; i < 50 && !closed.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(closed.length, 1);
        assert.equal(closed[0].socket, first.conn.socket); assert.equal(closed[0].uses, 2);
    } finally { unwatch(); s.close(); }
});

test('a turn\'s three classifier requests run at once, none waits for a socket (D89)', async () => {
    let open = 0, most = 0;
    const waiting = [];
    const s = await server((req, res) => {
        req.resume();
        req.on('end', () => {
            open++; most = Math.max(most, open);
            waiting.push(() => { open--; answer(res); });
            if (waiting.length === 3) waiting.splice(0).forEach(f => f());
        });
    });
    try {
        const config = {apiBase: 'http://127.0.0.1:' + s.address().port, apiKey: 'k'};
        const all = await Promise.all([1, 2, 3].map(n => openai.post(config, '/x', {n}, 1500)));
        assert.equal(most, 3, 'all three reached the server together');
        assert.ok(all.every(r => r.status === 200));
    } finally { s.closeAllConnections(); s.close(); }
});
