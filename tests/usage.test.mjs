// The Usage tab's data (lib/usage.js): the read-only check, finding Jibo's key, reading the bills,
// the cache, and counting conversations from the logs. A fake admin API stands in for OpenAI.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const usage = require(path.join(source, 'noggin/lib/usage.js'));
const ConversationLog = require(path.join(source, 'noggin/lib/conversation-log.js'));

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 19, 15, 0, 0); // Thursday 19 November, 15:00 UTC
const sec = ms => ms / 1000;
const dayStart = n => Date.UTC(2026, 10, 19) - n * DAY; // n days before today, 00:00 UTC
const CONFIG = {realtimeModel: 'gpt-realtime-2.1', transcribeModel: 'gpt-4o-mini-transcribe', classifierModel: 'gpt-6-luna', helperModel: 'gpt-4o-mini'};
const API_KEY = 'sk-proj-abcdefghijklmnopqrstuvwxyz8OQA';
const READ = 'sk-admin-read-0123456789abcdefghij', WRITE = 'sk-admin-write-0123456789abcdefghij';
const SCOPE = 'You have insufficient permissions for this operation. Missing scopes: api.management.write.';

const cost = (item, tokens, value, key = 'key_jibo') => ({line_item: item, quantity: tokens, quantity_unit: 'tokens', api_key_id: key, project_id: 'proj_a', amount: {currency: 'usd', value: String(value)}});

// A fake admin API: answers by path, records every call.
function fakeOpenAI(over = {}) {
    const calls = [];
    const request = (method, pathname, key) => {
        calls.push({method, path: pathname, key});
        const p = pathname.split('?')[0].replace('/v1/organization', '');
        const r = (status, json) => Promise.resolve({status, json});
        if (over[p]) return over[p](method, pathname, key);
        if (method !== 'GET') return key === WRITE ? r(404, {error: {message: 'not found'}}) : r(403, {error: SCOPE});
        if (p === '/projects') return r(200, {data: [{id: 'proj_a', name: 'Default project'}], has_more: false});
        if (p === '/projects/proj_a/api_keys') return r(200, {data: [
            {id: 'key_jibo', name: 'Jibo Social Robot', redacted_value: 'sk-proj-*****8OQA', owner: {user: {name: 'Owner Name', email: 'owner@example.com'}}},
            {id: 'key_other', name: 'Laptop', redacted_value: 'sk-proj-*****Zz99'}], has_more: false});
        if (p === '/projects/proj_a/spend_limit') return r(404, {error: {message: 'No project spend limit is configured.'}});
        if (p === '/spend_limit') return r(200, {threshold_amount: 3000, enforcement: {status: 'inactive'}, interval: 'month'});
        if (p === '/spend_alerts') return r(200, {data: [{threshold_amount: 2400}, {threshold_amount: 3000}], has_more: false});
        if (p === '/costs') return r(200, {data: [
            {start_time: sec(dayStart(1)), results: [cost('gpt-realtime-2.1 text, input', 1000000, 4), Object.assign(cost('gpt-5-nano, input', 10, 0.5, 'key_other'), {project_id: 'proj_b'})]}
        ], has_more: false});
        if (p === '/usage/completions') return r(200, {data: [{start_time: sec(NOW - 2 * 3600000), results: [{num_model_requests: 12}]}], has_more: false});
        return r(404, {error: {message: 'unknown path ' + p}});
    };
    request.calls = calls;
    return request;
}
const input = (extra = {}) => Object.assign({adminKey: READ, apiKey: API_KEY, config: CONFIG}, extra);

test('line items: model (dated snapshots folded), modality and kind', () => {
    assert.deepEqual(usage.lineItem('gpt-realtime-2.1 audio, cached input'), {model: 'gpt-realtime-2.1', modality: 'audio', kind: 'cached input'});
    assert.deepEqual(usage.lineItem('gpt-4o-mini-2024-07-18, input'), {model: 'gpt-4o-mini', modality: null, kind: 'input'});
    assert.deepEqual(usage.lineItem('gpt-4o-mini-transcribe-2025-12-15 text, output'), {model: 'gpt-4o-mini-transcribe', modality: 'text', kind: 'output'});
    assert.deepEqual(usage.lineItem('gpt-6-luna, cache writes - 12hr'), {model: 'gpt-6-luna', modality: null, kind: 'cache writes - 12hr'});
    assert.deepEqual(usage.lineItem('web search'), {model: 'web search', modality: null, kind: ''});
});

test('features follow the model settings, then the model name', () => {
    assert.equal(usage.featureOf('gpt-realtime-2.1', CONFIG), 'conversation');
    assert.equal(usage.featureOf('gpt-realtime-2.1-mini', CONFIG), 'conversation');
    assert.equal(usage.featureOf('gpt-4o-mini-transcribe', CONFIG), 'transcription');
    assert.equal(usage.featureOf('gpt-6-luna', CONFIG), 'expressions');
    assert.equal(usage.featureOf('gpt-4o-mini', CONFIG), 'helper');
    assert.equal(usage.featureOf('gpt-5-nano', CONFIG), 'other');
    // One model for both jobs: the bill cannot tell them apart.
    assert.equal(usage.featureOf('gpt-6-luna', Object.assign({}, CONFIG, {helperModel: 'gpt-6-luna'})), 'shared');
});

test('read-only only on the one known refusal; anything past the permission check is a write key (D62)', () => {
    assert.equal(usage.classify({status: 403, json: {error: SCOPE}}).state, 'read-only');
    assert.equal(usage.classify({status: 403, json: {error: {message: SCOPE}}}).state, 'read-only');
    for (const status of [200, 204, 400, 404, 409, 422]) assert.equal(usage.classify({status, json: {}}).state, 'write', String(status));
    assert.equal(usage.classify({status: 401, json: {}}).state, 'rejected');
    assert.equal(usage.classify({status: 403, json: {error: 'Forbidden'}}).state, 'unknown');
    for (const status of [429, 500, 503]) assert.equal(usage.classify({status, json: null}).state, 'unknown', String(status));
});

test('the check: only sk-admin- keys are tried, with a DELETE of an invite that cannot exist', async () => {
    const api = fakeOpenAI(), u = usage.create({request: api, now: () => NOW});
    assert.equal((await u.check('sk-proj-0123456789abcdefghijk')).state, 'rejected');
    assert.equal(api.calls.length, 0, 'a key that is not an admin key never goes out');
    assert.equal((await u.check(READ)).state, 'read-only');
    assert.equal((await u.check(WRITE)).state, 'write');
    assert.deepEqual(api.calls.map(c => c.method + ' ' + c.path), ['DELETE ' + usage.PROBE_PATH, 'DELETE ' + usage.PROBE_PATH]);
    assert.match(usage.PROBE_PATH, /^\/v1\/organization\/invites\/invite-/);
    const offline = usage.create({request: () => Promise.reject(Error('getaddrinfo ENOTFOUND'))});
    assert.equal((await offline.check(READ)).state, 'unknown');
    assert.equal(usage.HOST, 'api.openai.com');
});

test('Jibo\'s key: matched by its visible start and end (D63)', () => {
    assert.equal(usage.matches(API_KEY, 'sk-proj-*****8OQA'), true);
    assert.equal(usage.matches(API_KEY, 'sk-proj-*****8OQB'), false);
    assert.equal(usage.matches(API_KEY, 'sk-svcacct-*****8OQA'), false);
    assert.equal(usage.matches(API_KEY, 'sk-proj-8OQA'), false, 'no redaction, no match');
    assert.equal(usage.matches('', 'sk-proj-*****8OQA'), false);
});

test('the report: Jibo\'s key only, budget from the organization, no names or emails, every call to the admin API', async () => {
    const api = fakeOpenAI(), u = usage.create({request: api, now: () => NOW});
    let asked = null;
    const view = await u.report(input({conversations: since => { asked = since; return {count: 4, since: null}; }}));
    assert.equal(asked, dayStart(6), 'conversations over the same UTC days as the costs (D66)');
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.deepEqual(view.key, {name: 'Jibo Social Robot', hint: '…8OQA'});
    assert.equal(view.days.length, 7);
    assert.equal(view.days[5].day, '2026-11-18');
    assert.equal(view.days[5].cost, 4);
    assert.equal(view.week.other, 0.5);
    // The forecast: this month so far plus the average of the 7 full days before today, for the 11 days left.
    assert.deepEqual(view.budget, {jibo: 4, account: 4.5, spent: 4.5, forecast: round2(4.5 + 4.5 / 7 * 11), limit: 30, enforced: false, source: 'organization', left: 25.5, alerts: [24, 30]});
    assert.deepEqual(view.perConversation, {count: 4, cost: 4, each: 1, partial: false});
    assert.equal(view.models[0].model, 'gpt-realtime-2.1');
    assert.equal(view.models[0].feature, 'conversation');
    const text = JSON.stringify(view);
    assert.ok(!/owner|example\.com|Owner Name/.test(text), 'no names or emails');
    assert.ok(!text.includes(READ) && !text.includes(API_KEY), 'no keys');
    assert.equal(api.calls[0].method, 'DELETE', 'the read-only check comes first');
    assert.ok(api.calls.every(c => c.path.indexOf('/v1/organization/') === 0 && c.key === READ));
    assert.ok(api.calls.slice(1).every(c => c.method === 'GET'));
    const hourly = api.calls.find(c => c.path.indexOf('/usage/completions') >= 0).path;
    assert.match(hourly, /bucket_width=1h&limit=168&api_key_ids=key_jibo/);
    const costs = api.calls.find(c => c.path.indexOf('/costs') >= 0).path;
    assert.match(costs, /group_by=line_item&group_by=api_key_id&group_by=project_id/);
    assert.match(costs, new RegExp('start_time=' + sec(Date.UTC(2026, 10, 1)) + '&'), 'from the 1st: earlier than 7 full days back');
});
const round2 = n => Math.round(n * 100) / 100;

test('cache: 15 minutes; Refresh at most once a minute; a new key fetches again (D64)', async () => {
    let now = NOW;
    const api = fakeOpenAI(), u = usage.create({request: api, now: () => now});
    await u.report(input());
    const first = api.calls.length;
    let view = await u.report(input());
    assert.equal(api.calls.length, first);
    assert.equal(view.cached, true);
    now += 30000;
    view = await u.report(input(), true);
    assert.equal(api.calls.length, first, 'refresh within a minute is served from memory');
    assert.equal(view.tooSoon, true);
    now += 31000;
    await u.report(input(), true);
    assert.equal(api.calls.length, 2 * first, 'refresh after a minute asks OpenAI');
    now += 14 * 60000;
    await u.report(input());
    assert.equal(api.calls.length, 2 * first, 'within 15 minutes of the last fetch');
    now += 2 * 60000;
    await u.report(input());
    assert.equal(api.calls.length, 3 * first, 'after 15 minutes');
    await u.report(input({apiKey: 'sk-proj-another-key-0000008OQA'}));
    assert.equal(api.calls.length, 4 * first, 'another key is another fingerprint');
    u.forget();
    await u.report(input({apiKey: 'sk-proj-another-key-0000008OQA'}));
    assert.equal(api.calls.length, 5 * first);
});

test('requests during a fetch share it', async () => {
    const api = fakeOpenAI(), u = usage.create({request: api, now: () => NOW});
    const both = await Promise.all([u.report(input()), u.report(input())]);
    assert.equal(api.calls.filter(c => c.method === 'DELETE').length, 1);
    assert.equal(both[0].ok && both[1].ok, true);
});

test('a write key that cannot be deleted: an error, and the next look asks again', async () => {
    const api = fakeOpenAI(), u = usage.create({request: api, now: () => NOW, log: {error() {}, warn() {}}});
    const view = await u.report(input({adminKey: WRITE, onWriteKey: () => { throw Error('disk full'); }}));
    assert.equal(view.state, 'error');
    assert.match(view.error, /could not delete it \(disk full\)/);
    await u.report(input({adminKey: WRITE, onWriteKey: () => {}}));
    assert.equal(api.calls.length, 2, 'the failed fetch is not left running');
});

test('the save check ends within its own time limit; a fetch\'s timeout leaves other requests alone', async () => {
    const hang = (method, pathname, key, timeout, track) => new Promise((resolve, reject) => track(reason => reject(Error(reason))));
    const u = usage.create({request: hang, now: () => NOW});
    // A monotonic clock: the wall clock can jump while the test machine is busy.
    const started = performance.now(), verdict = await u.check(READ);
    assert.equal(verdict.state, 'unknown');
    assert.ok(performance.now() - started < 11000);
});

test('a write key: no data and onWriteKey with that key; never cached', async () => {
    const api = fakeOpenAI(), u = usage.create({request: api, now: () => NOW});
    const removed = [];
    const view = await u.report(input({adminKey: WRITE, onWriteKey: key => { removed.push(key); }}));
    assert.equal(view.ok, false);
    assert.equal(view.state, 'write');
    assert.deepEqual(removed, [WRITE]);
    assert.equal(api.calls.length, 1, 'nothing read after the check');
});

test('no key match, several matches, no conversation key', async () => {
    const none = usage.create({request: fakeOpenAI(), now: () => NOW});
    let view = await none.report(input({apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyzNONE'}));
    assert.equal(view.state, 'no-match');
    assert.match(view.error, /same organization/);
    const twice = usage.create({request: fakeOpenAI({'/projects/proj_a/api_keys': () => Promise.resolve({status: 200,
        json: {data: [{id: 'a', redacted_value: 'sk-proj-**8OQA'}, {id: 'b', redacted_value: 'sk-proj-***8OQA'}]}})}), now: () => NOW});
    view = await twice.report(input());
    assert.equal(view.state, 'no-match');
    assert.match(view.error, /Several keys/);
    view = await usage.create({request: fakeOpenAI(), now: () => NOW}).report(input({apiKey: ''}));
    assert.equal(view.state, 'no-api-key');
    view = await usage.create({request: fakeOpenAI(), now: () => NOW}).report(input({adminKey: ''}));
    assert.equal(view.state, 'no-key');
});

test('a project limit wins over the organization\'s; no limit at all is fine', async () => {
    const project = usage.create({request: fakeOpenAI({
        '/projects/proj_a/spend_limit': () => Promise.resolve({status: 200, json: {threshold_amount: 1000, enforcement: {status: 'active'}}}),
        '/projects/proj_a/spend_alerts': () => Promise.resolve({status: 200, json: {data: [{threshold_amount: 500}]}})}), now: () => NOW});
    let view = await project.report(input());
    assert.deepEqual([view.budget.limit, view.budget.enforced, view.budget.source, view.budget.alerts], [10, true, 'project', [5]]);
    assert.deepEqual([view.budget.spent, view.budget.account, view.budget.left], [4, 4.5, 6], 'a project limit counts only that project\'s spend');
    const none = usage.create({request: fakeOpenAI({'/spend_limit': () => Promise.resolve({status: 404, json: {}}),
        '/spend_alerts': () => Promise.resolve({status: 200, json: {data: []}})}), now: () => NOW});
    view = await none.report(input());
    assert.equal(view.ok, true);
    assert.equal(view.budget.limit, null);
    assert.equal(view.budget.left, null);
});

test('an OpenAI error or no answer in time: a short error, nothing cached, the calls aborted', async () => {
    const failing = usage.create({request: fakeOpenAI({'/costs': () => Promise.resolve({status: 500, json: {error: {message: 'boom'}}})}), now: () => NOW, log: {warn() {}}});
    const view = await failing.report(input());
    assert.equal(view.state, 'error');
    assert.match(view.error, /500/);
    let aborted = 0;
    const slow = (method, pathname, key, timeout, track) => method === 'DELETE' ? Promise.resolve({status: 403, json: {error: SCOPE}})
        : new Promise((resolve, reject) => track(reason => { aborted++; reject(Error(reason)); }));
    const stuck = usage.create({request: slow, now: () => NOW, log: {warn() {}}});
    const started = Date.now(), pending = stuck.report(input());
    await new Promise(resolve => setTimeout(resolve, 20));
    stuck.close();
    const r = await pending;
    assert.equal(r.ok, false);
    assert.ok(aborted >= 1, 'close() aborts what is running');
    assert.ok(Date.now() - started < 1000, 'at once, not at the timeout');
    assert.equal((await stuck.check(READ)).state, 'unknown', 'a closed reader asks nothing');
});

test('bills: per day, caching savings and the other conversation model at the account\'s prices (D67)', () => {
    const costs = [
        {start_time: sec(dayStart(20)), results: [cost('gpt-realtime-2.1-mini text, input', 1000000, 0.6), cost('gpt-realtime-2.1-mini text, cached input', 1000000, 0.06)]},
        {start_time: sec(dayStart(2)), results: [
            cost('gpt-realtime-2.1 text, input', 1000000, 4), cost('gpt-realtime-2.1 text, cached input', 2000000, 0.8),
            cost('gpt-realtime-2.1 audio, output', 0, 0), cost('gpt-6-luna, input', 500000, 0.05)]}
    ];
    const view = usage.build({now: NOW, config: CONFIG, key: {id: 'key_jibo', name: 'J', hint: '…8OQA'}, costs, hours: [], local: ms => {
        const d = new Date(ms); return {year: d.getUTCFullYear(), monthNum: d.getUTCMonth(), date: d.getUTCDate(), hour: d.getUTCHours()};
    }});
    assert.equal(view.days[4].cost, 4.85);
    assert.equal(view.days[4].tokens, 3500000);
    // 2M cached tokens at $4/M instead of $0.40/M.
    assert.equal(view.caching.saved, 7.2);
    assert.equal(view.caching.share, 0.571, 'of all input, the expression model\'s too');
    // The mini's prices are known from 20 days ago: 1M at 0.6 + 2M at 0.06.
    assert.deepEqual(view.whatIf, {model: 'gpt-realtime-2.1', other: 'gpt-realtime-2.1-mini', actual: 4.8, would: 0.72});
    assert.equal(view.budget.account, 4.85, 'the 30th of October is last month');
    assert.equal(view.features.find(f => f.feature === 'expressions').cost, 0.05);
    const unknown = usage.build({now: NOW, config: CONFIG, key: {id: 'key_jibo'}, costs: costs.slice(1), hours: [], local: () => ({})});
    assert.equal(unknown.whatIf.would, null, 'the mini was never used, so its price is unknown');
});

test('bills: per-minute transcription counts audio seconds, not tokens, next to a token model of the same feature (D110)', () => {
    // The shape OpenAI's costs API gives a per-minute model: the bare model name, quantity in seconds.
    const seconds = (item, quantity, value, key = 'key_jibo') => ({line_item: item, quantity, quantity_unit: 'duration_seconds', api_key_id: key, project_id: 'proj_a', amount: {currency: 'usd', value: String(value)}});
    const costs = [{start_time: sec(dayStart(1)), results: [
        seconds('gpt-transcribe', 387, 0.029025), seconds('gpt-live-transcribe', 238, 0.0674333331), seconds('gpt-transcribe', 600, 0.045, 'key_other'),
        cost('gpt-4o-mini-transcribe-2025-12-15 audio, input', 2809, 0.008427), cost('gpt-4o-mini-transcribe-2025-12-15 text, output', 912, 0.00456)]}];
    const view = usage.build({now: NOW, config: Object.assign({}, CONFIG, {transcribeModel: 'gpt-transcribe'}), key: {id: 'key_jibo'}, costs, hours: [], local: () => ({})});
    const model = name => view.models.find(m => m.model === name);
    assert.deepEqual([model('gpt-transcribe').seconds, model('gpt-transcribe').tokens, model('gpt-transcribe').cost], [387, 0, 0.029], 'Jibo\'s key only');
    assert.equal(model('gpt-transcribe').feature, 'transcription');
    assert.equal(model('gpt-live-transcribe').seconds, 238);
    assert.deepEqual([model('gpt-4o-mini-transcribe').seconds, model('gpt-4o-mini-transcribe').tokens], [0, 3721]);
    const f = view.features.find(x => x.feature === 'transcription');
    assert.deepEqual([f.seconds, f.tokens, f.cost], [625, 3721, 0.1094]);
    assert.equal(view.days[5].tokens, 3721, 'seconds never count as tokens per day');
    assert.equal(view.caching.cachedTokens, 0);
});

test('the hour grid: requests by Jibo\'s local day and hour', () => {
    const local = ms => { const d = new Date(ms + 3600000); return {year: d.getUTCFullYear(), monthNum: d.getUTCMonth(), date: d.getUTCDate(), hour: d.getUTCHours()}; };
    const grid = usage.hourGrid([
        {start_time: sec(Date.UTC(2026, 10, 19, 9)), results: [{num_model_requests: 3}, {num_model_requests: 2}]},
        {start_time: sec(Date.UTC(2026, 10, 18, 23)), results: [{num_model_requests: 7}]},
        {start_time: sec(Date.UTC(2026, 10, 1, 9)), results: [{num_model_requests: 99}]}
    ], NOW, local);
    assert.equal(grid.rows.length, 7);
    assert.equal(grid.rows[6].day, '2026-11-19');
    assert.equal(grid.rows[6].counts[10], 5);
    assert.equal(grid.rows[6].counts[0], 7, '23:00 UTC is midnight in Jibo\'s time');
    assert.equal(grid.max, 7, 'older than the week: left out');
});

test('conversations from the logs: a resumed log continues one; the window starts at the oldest kept log only when logs were pruned (D66)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-usage-'));
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs);
    const write = (stamp, resumed) => fs.writeFileSync(path.join(logs, 'conversation-' + stamp + '.jsonl'),
        JSON.stringify({kind: 'session'}) + '\n' + JSON.stringify({kind: 'startup', resumed}) + '\n' + JSON.stringify({kind: 'you', text: 'hi'}) + '\n');
    write('20261118-100000', false);
    write('20261118-100500', 'get_time');
    write('20261119-090000', false);
    write('20261101-090000', false);
    const since = new Date(2026, 10, 12).getTime();
    assert.deepEqual(ConversationLog.started(dir, since), {count: 2, since: null});
    assert.deepEqual(ConversationLog.started(path.join(dir, 'nothing'), since), {count: 0, since: null});
});
