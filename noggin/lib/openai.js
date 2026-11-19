// SPDX-License-Identifier: MIT
// Noggin: the OpenAI connections. The realtime session uses the page's own
// WebSocket with the key in the subprotocol (proven on the robot: Chrome 53's TLS
// reaches api.openai.com). The expression classifier uses Node https with a
// keep-alive agent (Node's own CAs work on the robot) to OpenAI's Decisions API, falling back to the page's
// fetch; the settings page's "Describe with AI" uses the same Node https (post). Node 6 / Chrome 53: ES2015 only.
'use strict';
const https = require('https'), http = require('http'), url = require('url');
const core = require('./core');

function realtimeUrl(config) {
    return config.apiBase.replace(/^http/, 'ws') + '/realtime?model=' + encodeURIComponent(config.realtimeModel);
}
// Resolves {send, listen, close, buffered} once session.created arrives.
function connect(config, WebSocketClass) {
    const Socket = WebSocketClass || (typeof WebSocket === 'function' ? WebSocket : null);
    return new Promise((resolve, reject) => {
        if (!Socket) return reject(Error('no WebSocket'));
        let settled = false, listeners = [], socket;
        const api = {
            listen(fn) { listeners.push(fn); return () => { listeners = listeners.filter(l => l !== fn); }; },
            send(event) { if (socket.readyState === 1) socket.send(JSON.stringify(event)); },
            buffered() { return socket.bufferedAmount || 0; },
            close() { try { socket.close(); } catch (_) {} },
            session: null,
            // Startup timing (Date.now()): asked, socket open, session.created.
            timing: {start: Date.now(), open: null, created: null}
        };
        const timer = setTimeout(() => fail(Error('no session from OpenAI within 15 s')), 15000);
        function fail(error) {
            if (settled) return;
            settled = true; clearTimeout(timer); api.close(); reject(error);
        }
        try { socket = new Socket(realtimeUrl(config), ['realtime', 'openai-insecure-api-key.' + config.apiKey]); }
        catch (error) { return fail(error); }
        socket.onmessage = message => {
            if (typeof message.data !== 'string') return;
            let event;
            try { event = JSON.parse(message.data); } catch (_) { return; }
            if (!settled) {
                if (event.type === 'session.created') { settled = true; clearTimeout(timer); api.timing.created = Date.now(); api.session = event.session || {}; resolve(api); }
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
const agents = {};
// track(abort), when given, receives a function that cancels the request.
function nodeJson(config, route, body, timeoutMs, track, method) {
    try { return nodeRequest(config, route, body, timeoutMs, track, method); }
    catch (error) { return Promise.reject(error); }
}
// method: POST (default, with the JSON body) or GET (no body).
function nodeRequest(config, route, body, timeoutMs, track, method) {
    method = method || 'POST';
    const target = url.parse(config.apiBase + route), started = Date.now(), data = method === 'GET' ? null : JSON.stringify(body);
    const module_ = target.protocol === 'https:' ? https : http;
    const agent = agents[target.protocol] || (agents[target.protocol] = new module_.Agent({keepAlive: true, maxSockets: 2}));
    const headers = {Authorization: 'Bearer ' + config.apiKey, Accept: 'application/json'};
    if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const options = {method: method, protocol: target.protocol, hostname: target.hostname, port: target.port, path: target.path, agent: agent, headers: headers};
    return new Promise((resolve, reject) => {
        const request = module_.request(options, response => {
            const parts = [];
            response.on('data', c => parts.push(c));
            response.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (_) {}
                resolve({status: response.statusCode, json: json, ms: Date.now() - started});
            });
        });
        request.on('error', reject);
        request.setTimeout(timeoutMs || 10000, () => { request.abort(); reject(Error('timeout')); });
        if (track) track(reason => { request.abort(); reject(Error(reason || 'stopped')); });
        if (data === null) request.end(); else request.end(data);
    });
}
// Does this key work? GET /models, for the settings page: {ok, status, ms, error}.
function checkKey(config, timeoutMs) {
    const target = url.parse(config.apiBase + '/models'), started = Date.now();
    const module_ = target.protocol === 'https:' ? https : http;
    return new Promise(resolve => {
        let settled = false;
        const finish = result => { if (!settled) { settled = true; resolve(Object.assign({ms: Date.now() - started}, result)); } };
        let request;
        try {
            request = module_.request({method: 'GET', protocol: target.protocol, hostname: target.hostname, port: target.port, path: target.path,
                headers: {Authorization: 'Bearer ' + config.apiKey, Accept: 'application/json'}}, response => {
                response.resume();
                response.on('end', () => {
                    const status = response.statusCode;
                    finish(status === 200 ? {ok: true, status: status}
                        : {ok: false, status: status, error: status === 401 ? 'OpenAI does not accept this key' : status === 429 ? 'no credit or too many requests' : 'OpenAI answered ' + status});
                });
            });
        } catch (error) { return finish({ok: false, status: null, error: String(error.message || error)}); }
        request.on('error', error => finish({ok: false, status: null, error: String(error.message || error)}));
        request.setTimeout(timeoutMs || 8000, () => { request.abort(); finish({ok: false, status: null, error: 'no answer from OpenAI'}); });
        request.end();
    });
}
function pageJson(config, route, body, method) {
    const started = Date.now(), get = method === 'GET';
    if (typeof fetch !== 'function') return Promise.reject(Error('no fetch'));
    const headers = {Authorization: 'Bearer ' + config.apiKey, Accept: 'application/json'};
    if (!get) headers['Content-Type'] = 'application/json';
    return fetch(config.apiBase + route, get ? {method: 'GET', headers: headers} : {method: 'POST', body: JSON.stringify(body), headers: headers})
        .then(response => response.json().catch(() => null).then(json => ({status: response.status, json: json, ms: Date.now() - started})));
}
// post(route, body, timeoutMs) -> {status, json, ms}: Node https, and the page's fetch from the
// first time Node's TLS fails (the simulator). Being offline is not a reason to switch: those errors
// just fail this call. Either way the call ends within timeoutMs, and abort() ends it at once.
const OFFLINE = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'];
function poster(config) {
    let usePage = false, cancel = null;
    function timed(promise, timeoutMs) {
        return new Promise((resolve, reject) => {
            const end = error => { clearTimeout(timer); cancel = null; reject(error); };
            const timer = setTimeout(() => end(Error('timeout')), timeoutMs || 20000);
            cancel = reason => end(Error(reason || 'stopped'));
            promise.then(value => { clearTimeout(timer); cancel = null; resolve(value); }, end);
        });
    }
    function viaNode(route, body, timeoutMs) {
        let abortNode = null;
        const request = nodeJson(config, route, body, timeoutMs, abort => { abortNode = abort; }).then(r => {
            if (r.json === null) throw Error('unreadable response');
            return r;
        });
        return timed(request, timeoutMs).catch(error => {
            if (abortNode) abortNode('stopped');
            throw error;
        });
    }
    const post = (route, body, timeoutMs) => {
        if (usePage) return timed(pageJson(config, route, body), timeoutMs);
        return viaNode(route, body, timeoutMs).catch(error => {
            const offline = error && (OFFLINE.indexOf(error.code) >= 0 || /^(timeout|stopped)$/.test(error.message));
            if (offline) throw error;
            usePage = true;
            return timed(pageJson(config, route, body), timeoutMs);
        });
    };
    post.abort = () => { if (cancel) cancel('stopped'); };
    return post;
}
// ask(method, route, body, timeoutMs, track) -> {status, json}, for the trouble check (lib/trouble.js):
// Node https, or the page's fetch when Node's TLS fails (the simulator). An offline error is
// the answer itself, never a reason to switch.
function asker(config) {
    return (method, route, body, timeoutMs, track) => nodeJson(config, route, body, timeoutMs, track, method).catch(error => {
        if (OFFLINE.indexOf(error && error.code) >= 0 || /^(timeout|stopped|done)$/.test(error && error.message) || typeof fetch !== 'function') throw error;
        let timer = null;
        const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error('timeout')), timeoutMs || 10000); });
        return Promise.race([pageJson(config, route, body, method), late]).then(r => { clearTimeout(timer); return r; }, e => { clearTimeout(timer); throw e; });
    });
}
// classify(personSaid, jiboSays, kind) -> {label, confidence, size, ms, api}. kind 'reaction'
// (no jiboSays yet) or 'line'. The Decisions API is the default; if the account cannot use
// it (an HTTP error), the rest of the session uses the Responses API with the fallback model.
// The size question (small/big) is asked unless config.expressionSize is false; if the
// Decisions API refuses two questions, the rest of the session asks only the expression.
function classifier(config, post) {
    let usePage = false, api = config.classifierApi === 'responses' ? 'responses' : 'decisions', withSize = config.expressionSize !== false;
    post = post || ((route, body) => usePage ? pageJson(config, route, body) : nodeJson(config, route, body).then(r => {
        if (r.json === null) throw Error('unreadable response');
        return r;
    }).catch(() => {
        usePage = true; // Node's HTTPS failed once: stay on the page's fetch.
        return pageJson(config, route, body);
    }));
    function failure(r) { return r.json && r.json.error && (r.json.error.code || r.json.error.message) || 'HTTP ' + r.status; }
    function viaResponses(personSaid, jiboSays, kind) {
        const model = api === 'responses' && config.classifierApi === 'responses' ? config.classifierModel : config.fallbackModel;
        return post('/responses', core.classifierRequest(model, personSaid, jiboSays, config.classifierReasoning, kind))
            .then(r => r.status === 200 ? {label: core.classifierLabel(r.json), size: withSize ? core.classifierSize(r.json) : null, confidence: null, ms: r.ms, api: 'responses'}
                : {label: null, ms: r.ms, status: r.status, api: 'responses', error: failure(r)});
    }
    const classify = (personSaid, jiboSays, kind) => {
        if (api === 'responses') return viaResponses(personSaid, jiboSays, kind);
        const sized = withSize;
        return post('/decisions', core.decisionsRequest(config.classifierModel, personSaid, jiboSays, kind, sized)).then(r => {
            if (r.status === 200) return Object.assign(core.decisionLabel(r.json, config.minConfidence), {ms: r.ms, api: 'decisions'});
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
            return {label: null, ms: r.ms, status: r.status, api: 'decisions', error: error};
        });
    };
    // Open the HTTPS connection ahead of time: a cold TLS handshake on the robot costs over a
    // second, which made reactions miss Jibo's first word. A one-word decision costs nothing.
    classify.warm = () => api !== 'decisions' ? Promise.resolve() : post('/decisions', {model: config.classifierModel, input: 'hi',
        questions: [{type: 'choice', name: 'warm', instructions: 'Reply hello.', choices: [{value: 'hello', description: 'hello'}, {value: 'other', description: 'other'}]}]})
        .then(() => {}, () => {});
    return classify;
}

module.exports = {connect, classifier, checkKey, post: nodeJson, poster, asker};
