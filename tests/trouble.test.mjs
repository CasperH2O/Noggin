// Noggin: what went wrong and how Jibo says it (lib/trouble.js), the request it uses
// (lib/openai.js asker), the budget heads-up (lib/budget.js) and the setup screen
// (lib/setup-screen.js) against a fake view manager.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const trouble = require(path.join(source, 'noggin/lib/trouble.js'));
const openai = require(path.join(source, 'noggin/lib/openai.js'));
const budget = require(path.join(source, 'noggin/lib/budget.js'));
const SetupScreen = require(path.join(source, 'noggin/lib/setup-screen.js'));
const settings = require(path.join(source, 'noggin/lib/settings.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WIFI = {lo: [{family: 'IPv4', address: '127.0.0.1', internal: true}], wlan0: [{family: 'IPv4', address: '192.168.1.20', internal: false}]};
const config = {realtimeModel: 'gpt-realtime-2.1', fallbackModel: 'gpt-4o-mini'};

test('every cause has a line in Jibo\'s words, a known emoji, and the screen ones a title, detail and step', () => {
    // Every animation Noggin's catalogue names (moods and eye emoji), as Jibo's animation database has them.
    const catalogue = JSON.stringify(require(path.join(source, 'noggin/lib/catalog.json')));
    const known = name => catalogue.indexOf('"' + name + '"') >= 0;
    for (const name of Object.keys(trouble.CAUSES)) {
        const t = trouble.cause(name);
        assert.equal(t.cause, name);
        assert.ok(t.line.length > 10 && t.line.length < 120, name);
        assert.doesNotMatch(t.line, /API|HTTP|error|quota|401|429/i, name + ' has no tech words');
        if (t.emoji) assert.ok(known(t.emoji), t.emoji + ' is in the catalogue');
        if (t.screen) assert.ok(t.title && t.detail && t.step, name);
    }
    assert.equal(trouble.cause('nonsense').cause, 'unknown');
    assert.deepEqual(['no_key', 'key_refused', 'settings'].filter(n => trouble.CAUSES[n].screen), ['no_key', 'key_refused', 'settings']);
    assert.ok(!trouble.CAUSES.no_credit.screen, 'no credit: say it and close');
    assert.ok(known(trouble.BUDGET_EMOJI) && known('Emoji_Checkmark'));
});

test('codes, messages, statuses and network errors map to causes', () => {
    assert.equal(trouble.fromCode('insufficient_quota'), 'no_credit');
    assert.equal(trouble.fromCode('invalid_api_key'), 'key_refused');
    assert.equal(trouble.fromCode('rate_limit_exceeded'), 'rate_limited');
    assert.equal(trouble.fromCode('model_not_found'), 'settings');
    assert.equal(trouble.fromCode('response_cancel_not_active'), null);
    assert.equal(trouble.fromMessage('OpenAI: insufficient_quota'), 'no_credit');
    assert.equal(trouble.fromMessage('connection closed (1006)'), null);
    assert.equal(trouble.fromStatus({status: 401}), 'key_refused');
    assert.equal(trouble.fromStatus({status: 404}), 'settings');
    assert.equal(trouble.fromStatus({status: 429, json: {error: {code: 'insufficient_quota'}}}), 'no_credit');
    assert.equal(trouble.fromStatus({status: 429, json: {error: {type: 'insufficient_quota'}}}), 'no_credit');
    assert.equal(trouble.fromStatus({status: 429, json: {error: {code: 'rate_limit_exceeded'}}}), 'rate_limited');
    assert.equal(trouble.fromStatus({status: 503}), 'openai_down');
    assert.equal(trouble.fromError(Object.assign(Error('x'), {code: 'ENOTFOUND'})), 'no_internet');
    assert.equal(trouble.fromError(Object.assign(Error('x'), {code: 'ECONNRESET'})), 'openai_down');
    assert.equal(trouble.fromError(Error('timeout')), 'openai_down');
});

test('Jibo\'s address: Wi-Fi first, never internal or IPv6', () => {
    assert.equal(trouble.lanAddress(WIFI), '192.168.1.20');
    assert.equal(trouble.lanAddress({docker0: [{family: 'IPv4', address: '172.17.0.1', internal: false}], eth0: [{family: 4, address: '10.0.0.5', internal: false}]}), '10.0.0.5');
    assert.equal(trouble.lanAddress({wlan0: [{family: 'IPv6', address: 'fe80::1', internal: false}], lo: WIFI.lo}), null);
    assert.equal(trouble.lanAddress(null), null);
});

function asking(answers) {
    const calls = [];
    const ask = (method, route, body, timeoutMs, track) => {
        calls.push({method, route, body});
        const answer = answers[method + ' ' + route.split('?')[0]];
        track(() => { calls.aborted = (calls.aborted || 0) + 1; });
        return typeof answer === 'function' ? answer() : answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    };
    return {ask, calls};
}

test('diagnose: free model check first, the tiny paid request only when that passes (D71)', async () => {
    const models = 'GET /models/gpt-realtime-2.1';
    let a = asking({[models]: {status: 401, json: {error: {code: 'invalid_api_key'}}}});
    assert.deepEqual(await trouble.diagnose(config, a.ask, {interfaces: WIFI}), {cause: 'key_refused', detail: 'models 401'});
    assert.equal(a.calls.length, 1);
    a = asking({[models]: {status: 404}});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: WIFI})).cause, 'settings');
    a = asking({[models]: {status: 200}, 'POST /responses': {status: 429, json: {error: {code: 'insufficient_quota'}}}});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: WIFI})).cause, 'no_credit');
    assert.deepEqual(a.calls[1].body, {model: 'gpt-4o-mini', input: 'Say ok.', max_output_tokens: 16, store: false});
    a = asking({[models]: {status: 200}, 'POST /responses': {status: 200}});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: WIFI})).cause, 'unknown');
    a = asking({[models]: {status: 200}, 'POST /responses': {status: 400, json: {error: {code: 'unsupported_parameter'}}}});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: WIFI})).cause, 'unknown', 'the probe\'s own 400 blames nothing');
    a = asking({[models]: Object.assign(Error('getaddrinfo ENOTFOUND'), {code: 'ENOTFOUND'})});
    assert.deepEqual(await trouble.diagnose(config, a.ask, {interfaces: WIFI}), {cause: 'no_internet', detail: 'ENOTFOUND'});
    a = asking({[models]: {status: 200}, 'POST /responses': Object.assign(Error('reset'), {code: 'ECONNRESET'})});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: WIFI})).cause, 'openai_down');
    a = asking({[models]: {status: 200}});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: WIFI, stopped: () => true})).detail, 'stopped');
    assert.equal(a.calls.length, 1, 'closed meanwhile: no paid request');
});

test('diagnose: no address is no internet without a request; no answer within the limit is OpenAI down, and the requests are aborted', async () => {
    let a = asking({});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: {lo: WIFI.lo}})).cause, 'no_internet');
    assert.equal(a.calls.length, 0);
    a = asking({'GET /models/gpt-realtime-2.1': () => new Promise(() => {})});
    const t0 = Date.now();
    assert.deepEqual(await trouble.diagnose(config, a.ask, {interfaces: WIFI, timeoutMs: 80}), {cause: 'openai_down', detail: 'no answer in time'});
    assert.ok(Date.now() - t0 < 500);
    assert.equal(a.calls.aborted, 1);
    a = asking({'GET /models/gpt-realtime-2.1': () => { throw Error('sync'); }});
    assert.equal((await trouble.diagnose(config, a.ask, {interfaces: WIFI})).cause, 'openai_down', 'a throwing ask never rejects');
});

test('asker: GET without a body and POST with JSON, over plain HTTP to a stand-in', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            seen.push({method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'] || null, body});
            res.writeHead(req.method === 'GET' ? 404 : 429, {'Content-Type': 'application/json'});
            res.end(JSON.stringify({error: {code: req.method === 'GET' ? 'model_not_found' : 'insufficient_quota'}}));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        const ask = openai.asker({apiBase: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'sk-test'});
        const got = await ask('GET', '/models/x', null, 2000, () => {});
        assert.equal(got.status, 404); assert.equal(got.json.error.code, 'model_not_found');
        const posted = await ask('POST', '/responses', {a: 1}, 2000, () => {});
        assert.equal(posted.status, 429);
        assert.deepEqual(seen.map(s => [s.method, s.url, s.auth, s.type, s.body]),
            [['GET', '/v1/models/x', 'Bearer sk-test', null, ''], ['POST', '/v1/responses', 'Bearer sk-test', 'application/json', '{"a":1}']]);
    } finally { server.close(); }
    // Nothing listening: the network error itself, no fallback.
    const dead = openai.asker({apiBase: 'http://127.0.0.1:1/v1', apiKey: 'sk-test'});
    await assert.rejects(dead('GET', '/models/x', null, 2000, () => {}), e => e.code === 'ECONNREFUSED');
});

test('budget: low only with a limit and at most the share left; the watch waits, asks at most every 12 h, and stops', async () => {
    const view = (left, limit) => ({ok: true, budget: {left, limit}});
    assert.ok(budget.isLow(view(2, 30), 10));
    assert.ok(budget.isLow(view(3, 30), 10));
    assert.ok(!budget.isLow(view(3.5, 30), 10));
    assert.ok(!budget.isLow(view(0, null), 10), 'no limit: no heads-up');
    assert.ok(!budget.isLow(view(1, 30), 0), '0 is off');
    assert.ok(!budget.isLow({ok: false, state: 'error'}, 10));

    delete global[budget.HUB];
    let t = 0, reports = 0, cfg = {budgetWarnPercent: 10, adminKey: true};
    const w = budget.watch({readConfig: () => cfg, report: () => { reports++; return Promise.resolve(view(2, 30)); }, now: () => t, tickMs: 1e9});
    w.tick(); assert.equal(reports, 0, 'not in the first minutes');
    t = budget.FIRST_MS; w.tick(); await sleep(1);
    assert.equal(reports, 1);
    assert.equal(global[budget.HUB].state.low, true);
    t += budget.EVERY_MS - 1; w.tick(); assert.equal(reports, 1);
    t += 1; w.tick(); await sleep(1); assert.equal(reports, 2);
    cfg = {budgetWarnPercent: 10, adminKey: false};
    t += budget.EVERY_MS; w.tick(); await sleep(1);
    assert.equal(reports, 2); assert.equal(global[budget.HUB].state, null, 'no admin key: no heads-up');
    w.stop();

    // The notice: once per day, only when low.
    global[budget.HUB] = {state: {low: true}, warnedDay: null};
    const n = budget.notice('2026-11-19', 10);
    assert.match(n.text, /nearly used up/); assert.equal(n.emoji, 'Emoji_Money');
    n.said();
    assert.equal(budget.notice('2026-11-19', 10), null);
    assert.ok(budget.notice('2026-11-20', 10));
    assert.equal(budget.notice('2026-11-20', 0), null);
    global[budget.HUB].state.low = false;
    assert.equal(budget.notice('2026-11-21', 10), null);
    delete global[budget.HUB];
    assert.equal(budget.notice('2026-11-21', 10), null);
    assert.equal(settings.DEFAULTS.budgetWarnPercent, 10);
});

test('setup screen content and layout: link to the Brain tab, steps per cause, inside the safe area, QR fits the plate', () => {
    const c = SetupScreen.content(trouble.cause('key_refused'), '192.168.1.20');
    assert.equal(c.link, 'http://192.168.1.20:8131/#brain');
    assert.equal(c.title, 'My key doesn\'t work');
    assert.match(c.steps[0], /Scan/); assert.match(c.steps[1], /working OpenAI API key/);
    assert.match(c.address, /192\.168\.1\.20:8131/);
    const none = SetupScreen.content(trouble.cause('no_key'), null);
    assert.equal(none.link, null); assert.doesNotMatch(none.steps[0], /Scan/);
    const L = SetupScreen.LAYOUT;
    const last = SetupScreen.stepAt(2);
    assert.ok(last.text.y + 2 * L.steps.line <= L.address.y - L.address.size / 2, 'steps end above the address');
    assert.ok(L.detail.y + L.detail.size / 2 <= 720 - 52, 'inside the bottom margin');
    assert.ok(L.plate.x + L.plate.size <= 1280 - 52 - 54 && L.plate.y >= 52);
    const code = SetupScreen.encode(c.link), g = SetupScreen.qrGeometry(code.getModuleCount());
    assert.equal(code.getModuleCount(), 29, 'version 3 for this address');
    assert.ok(g.cell >= 8, 'modules big enough to scan from a phone');
    assert.ok(g.start >= 2 * g.cell, 'two-module quiet zone');
    assert.ok(g.start + code.getModuleCount() * g.cell <= g.inner);
});

// A fake of the SDK's view manager and PIXI, enough for the screen's life cycle.
function fakeFace(over = {}) {
    const calls = [];
    const views = {
        currentView: null, viewStackLength: 1, ActionData: {CALLBACK: 'cb'}, GESTURE: {SWIPE_DOWN: 'down'}, TRANSITION: {IN: 'in', OUT: 'out'},
        createView(type, config) {
            const view = {config, actions: [], stage: new FakeContainer(), addAction(type, data, a, b, gesture) { this.actions.push({data, gesture}); }};
            calls.push('create');
            return view;
        },
        changeView(options, done, closed, loaded) {
            if (options.addView) {
                calls.push('add');
                if (over.neverOpens) return;
                views.currentView = options.addView;
                setTimeout(() => { loaded && loaded(); done(); }, 1);
            } else if (options.remove) {
                calls.push('remove:' + options.leaveEmpty);
                if (over.neverCloses) return;
                views.currentView = null;
                setTimeout(done, 1);
            }
        }
    };
    return {jibo: {face: {views}}, views, calls};
}
class FakeContainer {
    constructor() { this.children = []; this.destroyed = false; this.position = {set() {}}; }
    addChild(c) { this.children.push(c); c.parent = this; return c; }
    addChildAt(c) { return this.addChild(c); }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; }
    destroy() { this.destroyed = true; }
}
function withPixi(run) {
    const textures = [];
    const canvas = () => ({width: 0, height: 0, getContext: () => new Proxy({}, {get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => { o[k] = v; return true; }})});
    global.PIXI = {
        Container: FakeContainer,
        Graphics: class extends FakeContainer { beginFill() {} drawRect() {} endFill() {} },
        Sprite: class extends FakeContainer { constructor(t) { super(); this.texture = t; } },
        Texture: {fromCanvas: () => { const t = {destroyed: false, destroy() { this.destroyed = true; }}; textures.push(t); return t; }}
    };
    global.document = {createElement: canvas};
    return Promise.resolve().then(() => run(textures)).finally(() => { delete global.PIXI; delete global.document; });
}

test('setup screen: shows, ends on a saved key, a tap, a swipe or the timeout, and leaves no view, timer or texture', () => withPixi(async textures => {
    let ready = false;
    const f = fakeFace();
    const screen = new SetupScreen(f.jibo, {ready: () => ready, pollMs: 5, waitMs: 5000});
    const shown = screen.show(trouble.cause('no_key'), '192.168.1.20');
    await sleep(10);
    assert.equal(f.views.currentView.config.viewConfig.id, 'noggin-setup');
    assert.ok(f.views.currentView.config.componentConfigs.some(c => c.id === 'tap' && c.hitArea.width === 1280));
    assert.equal(f.views.currentView.actions[0].gesture, 'down');
    assert.equal(textures.length, 4, 'three badges and the QR plate');
    ready = true;
    assert.equal(await shown, 'saved');
    assert.deepEqual(f.calls, ['create', 'add', 'remove:true']);
    assert.equal(f.views.currentView, null);
    assert.ok(textures.every(t => t.destroyed));
    assert.equal(screen.timers.length, 0);
    assert.equal(await screen.show(), 'saved', 'shown once');

    const tap = fakeFace(), s2 = new SetupScreen(tap.jibo, {});
    const p2 = s2.show(trouble.cause('settings'), null);
    await sleep(10);
    tap.views.currentView.config.componentConfigs.find(c => c.id === 'tap').action.data.callback();
    assert.equal(await p2, 'tap');

    const swipe = fakeFace(), s3 = new SetupScreen(swipe.jibo, {});
    const p3 = s3.show(trouble.cause('settings'), null);
    await sleep(10);
    swipe.views.currentView.actions[0].data.callback();
    assert.equal(await p3, 'swipe');

    const t0 = Date.now(), slow = fakeFace({neverOpens: true}), s4 = new SetupScreen(slow.jibo, {waitMs: 30});
    assert.equal(await s4.show(trouble.cause('no_key'), null), 'timeout', 'a view that never opens still ends');
    assert.ok(Date.now() - t0 < 500);

    const stuck = fakeFace({neverCloses: true}), s5 = new SetupScreen(stuck.jibo, {});
    const p5 = s5.show(trouble.cause('no_key'), null);
    await sleep(10);
    s5.close();
    assert.equal(await p5, 'closed', 'a removal that never answers ends within CLOSE_MS');
}));

// A manager whose view change runs for a while before the view becomes current, like the SDK's.
function slowFace() {
    const destroyed = [];
    const views = {
        currentView: null, viewStackLength: 1, ActionData: {CALLBACK: 'cb'}, GESTURE: {SWIPE_DOWN: 'down'}, TRANSITION: {IN: 'in', OUT: 'out'},
        STATE: {DESTROYED: 'destroyed'}, _viewProcess: {active: false, processQueue: []},
        ComponentGroup: {prototype: {destroy() { destroyed.push(this); }}},
        createView(type, config) { return {config, actions: [], stage: new FakeContainer(), addAction() {}}; },
        changeView(options, done) {
            if (options.addView) {
                views._viewProcess.active = true;
                setTimeout(() => { views.currentView = options.addView; views._viewProcess.active = false; done(); }, 40);
            } else if (options.remove) { views.removed = (views.removed || 0) + 1; views.currentView = views.currentView.pausedParent || null; setTimeout(done, 1); }
        }
    };
    return {jibo: {face: {views, tween: {stop() {}}}}, views, destroyed};
}

test('review: closed while sliding in, the screen waits for the view change and removes its view (D76)', () => withPixi(async () => {
    const f = slowFace(), screen = new SetupScreen(f.jibo, {});
    const shown = screen.show(trouble.cause('no_key'), '192.168.1.20');
    screen.close();
    assert.equal(await shown, 'closed');
    assert.equal(f.views.removed, 1);
    assert.equal(f.views.currentView, null);
}));

test('review: a covered screen is disposed as a hidden view and unlinked from the stack (D76)', () => withPixi(async () => {
    const f = slowFace(), screen = new SetupScreen(f.jibo, {});
    const shown = screen.show(trouble.cause('no_key'), null);
    await sleep(60);
    const ours = f.views.currentView, below = {name: 'below'};
    ours.pausedParent = below;
    const above = {name: 'above', pausedParent: ours};
    f.views.currentView = above;
    screen.close();
    assert.equal(await shown, 'closed');
    assert.equal(f.views.removed, undefined, 'the manager\'s removal would take the view on top');
    assert.deepEqual(f.destroyed, [ours]);
    assert.equal(above.pausedParent, below);
    assert.equal(ours.status, 'destroyed');
    assert.ok(ours.stage.destroyed);
}));

test('setup screen: without a view system it reports so at once', async () => {
    assert.equal(await new SetupScreen({face: {}}, {}).show(trouble.cause('no_key'), null), 'unavailable');
});
