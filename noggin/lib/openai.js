// SPDX-License-Identifier: MIT
// Noggin: the OpenAI connections. The realtime session uses the page's own WebSocket with the
// key in the subprotocol. The expression classifier, the recap and "Describe with AI" use Node
// https with keep-alive agents, falling back to the page's fetch where Node's TLS fails (the
// simulator). Node 6 / Chrome 53: ES2015 only.
'use strict';
const https = require('https'), http = require('http'), url = require('url');
const labels = require('./labels'), web = require('./http');

const ANSWER_MAX = 1024 * 1024;
const CLASSIFY_TIMEOUT_MS = 10000;

function realtimeUrl(config) {
    return config.apiBase.replace(/^http/, 'ws') + '/realtime?model=' + encodeURIComponent(config.realtimeModel);
}
// An error text never carries the key: the conversation log keeps error texts.
function withoutKey(error, key) {
    const text = String(error && error.message || error);
    if (!key || text.indexOf(key) < 0) return error;
    const safe = Error(text.split(key).join(key.slice(0, 3) + '…' + key.slice(-4)));
    if (error && error.code) safe.code = error.code;
    return safe;
}
// Resolves {send, listen, close, timing} once session.created arrives.
function connect(config, WebSocketClass) {
    const Socket = WebSocketClass || (typeof WebSocket === 'function' ? WebSocket : null);
    return new Promise((resolve, reject) => {
        if (!Socket) return reject(Error('no WebSocket'));
        let settled = false, listeners = [], socket;
        const api = {
            listen(fn) { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn); }; },
            send(event) { if (socket.readyState === 1) socket.send(JSON.stringify(event)); },
            close() { try { socket.close(); } catch (_) {} },
            // Startup timing (Date.now()): asked, socket open, session.created.
            timing: {start: Date.now(), open: null, created: null}
        };
        const timer = setTimeout(() => fail(Error('no session from OpenAI within 15 s')), 15000);
        function fail(error) {
            if (settled) return;
            settled = true; clearTimeout(timer); api.close(); reject(withoutKey(error, config.apiKey));
        }
        try { socket = new Socket(realtimeUrl(config), ['realtime', 'openai-insecure-api-key.' + config.apiKey]); }
        catch (error) { return fail(error); }
        socket.onmessage = message => {
            if (typeof message.data !== 'string') return;
            let event;
            try { event = JSON.parse(message.data); } catch (_) { return; }
            if (!settled) {
                if (event.type === 'session.created') { settled = true; clearTimeout(timer); api.timing.created = Date.now(); resolve(api); }
                else if (event.type === 'error') fail(Error('OpenAI: ' + (event.error && (event.error.code || event.error.message) || 'error')));
                return;
            }
            listeners.slice().forEach(fn => fn(event));
        };
        socket.onerror = () => {};
        socket.onopen = () => { api.timing.open = Date.now(); };
        socket.onclose = close => {
            if (!settled) return fail(Error('connection closed (' + close.code + ')'));
            listeners.slice().forEach(fn => fn({type: 'transport.closed', code: close.code, reason: String(close.reason || '')}));
        };
    });
}

// ---- HTTPS for the classifier ----
// Three sockets: a turn asks the reaction and two line labels at once, and a third request
// would wait for a free socket (D89).
const agents = {};
// Connection timing for the log (D87). For each request, `conn`: the socket's id, reused or new
// (and how long a reused one sat idle), and ms from the request to its socket, the address, the
// TCP connection, TLS and the answer's first byte. A kept socket that closes goes to closeWatcher.
let socketIds = 0, closeWatcher = null;
function watchConnection(request, started, conn) {
    request.on('socket', socket => {
        const now = Date.now(), since = () => Date.now() - started;
        let s = socket.nogginConn;
        conn.socket_ms = now - started;
        if (s) { conn.reused = true; conn.idle_ms = s.freeAt === null ? null : now - s.freeAt; }
        else {
            s = socket.nogginConn = {id: ++socketIds, uses: 0, opened: now, freeAt: null};
            conn.reused = false;
            socket.once('lookup', () => { conn.dns_ms = since(); });
            socket.once('connect', () => { conn.tcp_ms = since(); });
            socket.once('secureConnect', () => { conn.tls_ms = since(); });
            socket.once('close', () => {
                const at = Date.now();
                if (closeWatcher) closeWatcher({socket: s.id, uses: s.uses, age_ms: at - s.opened, idle_ms: s.freeAt === null ? null : at - s.freeAt});
            });
        }
        s.uses++; s.freeAt = null; conn.socket = s.id;
        request.once('response', response => {
            conn.ttfb_ms = since();
            response.once('end', () => { s.freeAt = Date.now(); });
        });
    });
}
// watch(fn): fn({socket, uses, age_ms, idle_ms}) when a kept socket closes; returns the unwatch.
function watchConnections(fn) {
    closeWatcher = fn;
    return () => { if (closeWatcher === fn) closeWatcher = null; };
}
function agentFor(protocol) {
    const transport = protocol === 'https:' ? https : http;
    return agents[protocol] || (agents[protocol] = new transport.Agent({keepAlive: true, maxSockets: 3}));
}
// -> {status, json, ms, conn}. method: POST (default, with the JSON body) or GET (no body).
// track(abort), when given, receives a function that cancels the request.
function nodeJson(config, route, body, timeoutMs, track, method) {
    method = method || 'POST';
    const conn = {};
    let target;
    try { target = url.parse(config.apiBase + route); } catch (error) { return Promise.reject(error); }
    return web.requestJson({target: target, method: method, body: method === 'GET' ? null : body, agent: agentFor(target.protocol),
        headers: {Authorization: 'Bearer ' + config.apiKey}, timeoutMs: timeoutMs, maxBytes: ANSWER_MAX, track: track,
        watch: (request, started) => watchConnection(request, started, conn)})
        .then(r => Object.assign(r, {conn: conn}));
}
function keyProblem(status) {
    if (status === 401) return 'OpenAI does not accept this key';
    if (status === 429) return 'no credit or too many requests';
    return 'OpenAI answered ' + status;
}
// Does this key work? GET /models, for the settings page: {ok, status, ms, error}.
function checkKey(config, timeoutMs) {
    const started = Date.now(), finish = result => Object.assign({ms: Date.now() - started}, result);
    return Promise.resolve().then(() => web.requestJson({url: config.apiBase + '/models', headers: {Authorization: 'Bearer ' + config.apiKey},
        timeoutMs: timeoutMs || 8000, timeoutMessage: 'no answer from OpenAI', maxBytes: 4 * ANSWER_MAX}))
        .then(r => finish(r.status === 200 ? {ok: true, status: r.status} : {ok: false, status: r.status, error: keyProblem(r.status)}),
            error => finish({ok: false, status: null, error: String(error && error.message || error)}));
}
// The page's fetch, ended after timeoutMs (Chrome 53 has no AbortController).
function pageJson(config, route, body, method, timeoutMs) {
    const started = Date.now(), get = method === 'GET';
    if (typeof fetch !== 'function') return Promise.reject(Error('no fetch'));
    const headers = {Authorization: 'Bearer ' + config.apiKey, Accept: 'application/json'};
    if (!get) headers['Content-Type'] = 'application/json';
    const asked = fetch(config.apiBase + route, get ? {method: 'GET', headers: headers} : {method: 'POST', body: JSON.stringify(body), headers: headers})
        .then(response => response.text().then(text => {
            // The same cap as Node's path; characters, which are never more than the bytes.
            if (text.length > web.MAX_BYTES) throw Error('answer too large');
            let json = null;
            try { json = JSON.parse(text); } catch (_) {}
            return {status: response.status, json: json, ms: Date.now() - started};
        }));
    return web.withTimeout(asked, timeoutMs || web.TIMEOUT_MS);
}
// Only Node's own HTTPS failing (the simulator's TLS) moves a caller to the page's fetch. Being
// offline, a timeout, a stop or an oversized answer fails just that call.
const OFFLINE = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'];
function switchesToPage(error) {
    if (typeof fetch !== 'function' || !error) return false;
    return OFFLINE.indexOf(error.code) < 0 && !/^(timeout|stopped|done|answer too large)$/.test(error.message);
}
// post(route, body, timeoutMs) -> {status, json, ms}: Node https, and the page's fetch from the
// first time Node's TLS fails. Either way the call ends within timeoutMs, and abort() ends it at once.
function poster(config) {
    let usePage = false, cancel = null;
    function timed(promise, timeoutMs) {
        const stopped = new Promise((resolve, reject) => { cancel = reason => reject(Error(reason || 'stopped')); });
        const done = () => { cancel = null; };
        return web.withTimeout(Promise.race([promise, stopped]), timeoutMs || 20000)
            .then(value => { done(); return value; }, error => { done(); throw error; });
    }
    function viaNode(route, body, timeoutMs) {
        let abortNode = null;
        const request = nodeJson(config, route, body, timeoutMs, abort => { abortNode = abort; }).then(r => {
            // A success Node could not read is its HTTPS failing; an error page (a 502) is just that call's answer.
            if (r.json === null && r.status >= 200 && r.status < 300) throw Error('unreadable response');
            return r;
        });
        return timed(request, timeoutMs).catch(error => {
            if (abortNode) abortNode('stopped');
            throw error;
        });
    }
    const viaPage = (route, body, timeoutMs) => timed(pageJson(config, route, body, 'POST', timeoutMs), timeoutMs);
    const post = (route, body, timeoutMs) => {
        if (usePage) return viaPage(route, body, timeoutMs);
        return viaNode(route, body, timeoutMs).catch(error => {
            if (!switchesToPage(error)) throw error;
            usePage = true;
            return viaPage(route, body, timeoutMs);
        });
    };
    post.abort = () => { if (cancel) cancel('stopped'); };
    return post;
}
// ask(method, route, body, timeoutMs, track) -> {status, json}, for the trouble check (lib/trouble.js):
// Node https, or the page's fetch when Node's TLS fails. An offline error is the answer itself.
function asker(config) {
    return (method, route, body, timeoutMs, track) => nodeJson(config, route, body, timeoutMs, track, method).catch(error => {
        if (!switchesToPage(error)) throw error;
        return pageJson(config, route, body, method, timeoutMs);
    });
}
// A result with the request's connection timing, when Node's agent made it (D87).
function withConn(response, result) {
    if (response && response.conn) result.conn = response.conn;
    return result;
}
// What the warm asks: made-up words shaped like a first turn.
const WARM = [
    {kind: 'reaction', person: 'Hello Jibo, how are you today?', jibo: ''},
    {kind: 'line', person: 'Hello Jibo, how are you today?', jibo: 'I am doing great, thank you for asking!'},
    {kind: 'line', person: 'Hello Jibo, how are you today?', jibo: 'It is lovely to hear from you.'}
];
// classify(personSaid, jiboSays, kind) -> {label, confidence, size, ms, api}. kind 'reaction'
// (no jiboSays yet) or 'line'. The Decisions API is the default; if the account cannot use
// it (an HTTP error), the rest of the session uses the Responses API with the fallback model.
// The size question (small/big) is asked unless config.expressionSize is false; if the
// Decisions API refuses two questions, the rest of the session asks only the expression.
function classifier(config, post) {
    let api = config.classifierApi === 'responses' ? 'responses' : 'decisions', withSize = config.expressionSize !== false;
    if (!post) {
        const send = poster(config);
        post = (route, body) => send(route, body, CLASSIFY_TIMEOUT_MS);
    }
    function failure(r) { return r.json && r.json.error && (r.json.error.code || r.json.error.message) || 'HTTP ' + r.status; }
    function responsesResult(r, sized) {
        const answer = labels.classifierAnswer(r.json);
        return {label: answer.label, size: sized ? answer.size : null, confidence: null, ms: r.ms, api: 'responses'};
    }
    function viaResponses(personSaid, jiboSays, kind) {
        const model = api === 'responses' && config.classifierApi === 'responses' ? config.classifierModel : config.fallbackModel;
        return post('/responses', labels.classifierRequest(model, personSaid, jiboSays, config.classifierReasoning, kind))
            .then(r => withConn(r, r.status === 200 ? responsesResult(r, withSize)
                : {label: null, ms: r.ms, status: r.status, api: 'responses', error: failure(r)}));
    }
    const classify = (personSaid, jiboSays, kind) => {
        if (api === 'responses') return viaResponses(personSaid, jiboSays, kind);
        const sized = withSize;
        return post('/decisions', labels.decisionsRequest(config.classifierModel, personSaid, jiboSays, kind, sized)).then(r => {
            if (r.status === 200) return withConn(r, Object.assign(labels.decisionLabel(r.json, config.minConfidence), {ms: r.ms, api: 'decisions'}));
            const error = failure(r);
            // A request error with the size question: try once more without it, and keep it off.
            if (sized && r.status === 400) {
                withSize = false;
                return classify(personSaid, jiboSays, kind).then(result => Object.assign(result, {switched: result.switched || 'size question refused (' + error + '), now without it'}));
            }
            if (r.status >= 400 && r.status < 500 && r.status !== 429 && config.fallbackModel) {
                api = 'responses';
                return viaResponses(personSaid, jiboSays, kind).then(result => Object.assign(result, {switched: 'decisions failed (' + error + '), now ' + config.fallbackModel}));
            }
            return withConn(r, {label: null, ms: r.ms, status: r.status, api: 'decisions', error: error});
        });
    };
    // Before the first real question: the reaction and two line labels, as a first sentence asks
    // them, while Jibo greets (D93). Resolves {ms, requests} for the log, or null when nothing was sent.
    classify.warm = () => {
        if (api !== 'decisions') return Promise.resolve(null);
        const started = Date.now();
        return Promise.all(WARM.map(w => classify(w.person, w.jibo, w.kind).then(
            r => ({kind: w.kind, ms: r.ms, label: r.label, status: r.status, error: r.error, switched: r.switched, conn: r.conn}),
            error => ({kind: w.kind, error: String(error && error.message || error).slice(0, 200)})
        ))).then(requests => ({ms: Date.now() - started, requests: requests}));
    };
    classify.watch = watchConnections;
    return classify;
}

module.exports = {connect, classifier, checkKey, post: nodeJson, poster, asker, switchesToPage};
