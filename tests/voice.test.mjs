// Noggin's seam to the Dutch Voice skill (D169) and the reply language label (D171).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const voice = require(path.resolve(import.meta.dirname, '../noggin/lib/voice.js'));

function service(over = {}) {
    const calls = [];
    const api = Object.assign({apiVersion: 1, version: '0.1.0', languages: ['nl'], ready: () => true,
        status: () => ({state: 'ready', reason: null}),
        speak(fn, options) { calls.push(options); return Promise.resolve().then(fn); }, cancel() { calls.push('cancel'); }}, over);
    return {api, calls};
}

test('status and choose: missing, a service that does not fit, not ready, ready', () => {
    assert.deepEqual(voice.create({service: () => null}).status(), {found: false, ready: false, version: null, state: null, reason: 'missing'});
    assert.equal(voice.create({service: () => ({apiVersion: 2})}).status().reason, 'api_version');
    assert.equal(voice.create({service: () => service({languages: ['de']}).api}).status().reason, 'no_dutch');
    const starting = service({ready: () => false, status: () => ({state: 'starting', reason: null})}).api;
    assert.deepEqual(voice.create({service: () => starting}).status(), {found: true, ready: false, version: '0.1.0', state: 'starting', reason: null});
    assert.deepEqual(voice.create({service: () => starting}).choose('nl'), {language: 'en', missing: 'not_ready'});
    assert.deepEqual(voice.create({service: () => null}).choose('nl'), {language: 'en', missing: 'missing'});
    assert.deepEqual(voice.create({service: () => service().api}).choose('nl'), {language: 'nl', missing: null});
    assert.deepEqual(voice.create({service: () => null}).choose('en'), {language: 'en', missing: null});
    const throwing = service({ready: () => { throw Error('x'); }, status: () => { throw Error('y'); }}).api;
    assert.equal(voice.create({service: () => throwing}).status().ready, false, 'a throwing service is not ready');
    assert.equal(voice.create({service: () => { throw Error('lookup'); }}).status().reason, 'missing');
});

test('speak runs the caller\'s own speech call through the service with the limit; cancel reaches it', async () => {
    const s = service();
    const v = voice.create({service: () => s.api});
    assert.equal(await v.speak(() => 'said', 7000), 'said');
    assert.deepEqual(s.calls, [{limitMs: 7000}]);
    v.cancel();
    assert.equal(s.calls[1], 'cancel');
    let called = false;
    await assert.rejects(voice.create({service: () => null}).speak(() => { called = true; }, 1000), /dutch_voice_missing/);
    assert.equal(called, false);
    voice.create({service: () => service({cancel() { throw Error('x'); }}).api}).cancel();
});

test('the service is looked up at every call (it is replaced when Dutch Voice is updated)', () => {
    let current = null;
    const v = voice.create({service: () => current});
    assert.equal(v.status().found, false);
    current = service().api;
    assert.equal(v.status().found, true);
});

test('readLabel: a label at the start, none, or not yet known', () => {
    assert.deepEqual(voice.readLabel('[nl] Hoi'), {language: 'nl', length: 5});
    assert.deepEqual(voice.readLabel('  [EN]Hi'), {language: 'en', length: 6});
    assert.deepEqual(voice.readLabel('[nl]'), {language: 'nl', length: 4});
    assert.deepEqual(voice.readLabel('Hoi daar'), {language: null, length: 0});
    assert.deepEqual(voice.readLabel('[x] Hoi'), {language: null, length: 0});
    assert.deepEqual(voice.readLabel('[nla]'), {language: null, length: 0});
    for (const start of ['', '  ', '[', '[n', '[nl', '[E']) assert.equal(voice.readLabel(start), null, JSON.stringify(start));
});

test('a Dutch Voice that never answers is given up after the call\'s limit plus 3 s, with a cancel, as no refusal', async () => {
    let cancels = 0;
    const api = service({speak: () => new Promise(() => {}), cancel() { cancels++; }}).api;
    const started = Date.now();
    await assert.rejects(voice.create({service: () => api}).speak(() => {}, 50), /dutch_voice_no_answer/);
    assert.ok(Date.now() - started >= 3000);
    assert.equal(cancels, 1);
    assert.equal(voice.refused(Error('dutch_voice_no_answer')), false);
    assert.equal(voice.refused(Error('dutch_voice_not_ready')), true);
    assert.equal(voice.refused(Error('http_no_answer')), true);
    assert.equal(voice.refused(Error('dutch_voice_timeout')), false);
});
