// SPDX-License-Identifier: MIT
// The settings page's HTTP server: the page itself (web/) and a small JSON API over Noggin's
// settings, persona and conversation logs. It runs inside Be's process (background.js), so every
// handler is short, never blocks for long and never throws into Be.
// Open on the local network like BEacon (D6), with BEacon's guards: a request that changes
// something must come from this page (Origin/Referer), be JSON and stay small; the key is write-only.
// Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
const settings = require('./settings'), core = require('./core'), actions = require('./actions');
const openai = require('./openai'), ConversationLog = require('./conversation-log');

const BODY_MAX = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_CONNECTIONS = 16;
// The persona size the page recommends: the instructions sent at every conversation start.
const BUDGET = 5400;
const STATIC = {
    '/': {file: 'index.html', type: 'text/html; charset=utf-8'},
    '/index.html': {file: 'index.html', type: 'text/html; charset=utf-8'},
    '/style.css': {file: 'style.css', type: 'text/css; charset=utf-8'},
    '/app.js': {file: 'app.js', type: 'application/javascript; charset=utf-8'},
    '/logo.png': {file: 'logo.png', type: 'image/png'},
    '/favicon.png': {file: 'logo.png', type: 'image/png'}
};
const SECURITY = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'"
};

function send(res, status, type, body, extra) {
    const headers = Object.assign({'Content-Type': type, 'Cache-Control': 'no-store'}, SECURITY, extra || {});
    res.writeHead(status, headers);
    res.end(body);
}
function json(res, status, value) { send(res, status, 'application/json; charset=utf-8', JSON.stringify(value)); }

// A request that changes something must name this server as its origin, as BEacon requires.
function sameOrigin(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const named = [req.headers.origin, req.headers.referer].filter(Boolean);
    return named.every(value => {
        const match = /^https?:\/\/([^/]+)/i.exec(String(value));
        return !!match && match[1].toLowerCase() === host;
    });
}

// Jibo is reached by his address, "localhost", a one-word name or a .local name. A public
// domain name means a web page pointed its own name at Jibo (DNS rebinding): refused.
function localHost(req) {
    const name = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.indexOf(':') >= 0) return true;
    return name === 'localhost' || /^[a-z0-9-]+$/.test(name) || /^[a-z0-9.-]+\.local$/.test(name);
}

// The JSON body, or an error with an HTTP status.
function readBody(req) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let size = 0, failed = false;
        const fail = (status, message) => { if (!failed) { failed = true; reject({status: status, message: message}); } };
        req.on('data', chunk => {
            if (failed) return;
            size += chunk.length;
            if (size > BODY_MAX) { fail(413, 'too large'); req.resume(); return; }
            parts.push(chunk);
        });
        req.on('end', () => {
            if (failed) return;
            try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); }
            catch (_) { fail(400, 'not JSON'); }
        });
        req.on('error', () => fail(400, 'request failed'));
    });
}

function create(options) {
    const webDir = options.webDir, version = options.version || '';
    const dataDir = typeof options.dataDir === 'function' ? options.dataDir : () => options.dataDir;
    const log = options.log || {info() {}, warn() {}, error() {}};
    const checkKey = options.checkKey || openai.checkKey;
    const now = options.now || (() => new Date());
    const http = options.http || require('http');
    let server = null;
    const sockets = new Set();

    // Everything the page shows; never the key itself.
    function state() {
        const dir = dataDir(), view = settings.publicView(dir), persona = settings.persona(dir);
        const config = Object.assign({}, view.values);
        const abilities = config.actions ? {apps: Object.keys(actions.apps(config)), config: config} : null;
        const chars = core.instructions(persona.soul, persona.identity, now(), abilities).length;
        const limits = {}, packaged = {};
        Object.keys(settings.PERSONA).forEach(name => { limits[name] = settings.PERSONA[name].max; packaged[name] = settings.packaged(name); });
        return {version: version, schema: settings.schemaView(), values: view.values, key: view.key, problems: view.problems, broken: view.broken,
            persona: {soul: persona.soul, identity: persona.identity, facts: persona.facts, edited: persona.edited, max: limits, packaged: packaged},
            budget: {chars: chars, recommended: BUDGET}};
    }

    // POST /api/settings {values, persona}: both are checked before either is saved.
    function save(body) {
        const dir = dataDir(), values = body.values || {}, persona = body.persona || {};
        const a = settings.update(dir, values, {dryRun: true}), b = settings.updatePersona(dir, persona, {dryRun: true});
        const moved = movedWithoutKey(dir, values);
        if (moved) a.errors.apiBase = moved;
        if (!a.ok || !b.ok || moved) return {httpStatus: 400, body: {ok: false, errors: {values: a.errors, persona: b.errors}}};
        settings.update(dir, values);
        settings.updatePersona(dir, persona);
        log.info('settings saved: ' + Object.keys(values).concat(Object.keys(persona)).filter(k => k !== 'apiKey').join(', ') + (values.apiKey ? ' (and the key)' : ''));
        return {httpStatus: 200, body: Object.assign({ok: true}, state())};
    }

    // The saved key goes wherever apiBase points, so a new address needs the key typed again in
    // the same save; back to OpenAI's own address is always fine.
    function movedWithoutKey(dir, values) {
        if (!Object.prototype.hasOwnProperty.call(values, 'apiBase') || values.apiBase === null || values.apiKey) return null;
        const field = settings.SCHEMA.filter(f => f.key === 'apiBase')[0];
        const next = settings.check(field, values.apiBase).value;
        if (!next || next === settings.publicView(dir).values.apiBase || next === field.default) return null;
        return 'Paste the API key again with a new address, so the key only goes where you chose.';
    }

    // POST /api/test-key {key?}: the given key, or the saved one.
    function testKey(body) {
        const dir = dataDir();
        const config = settings.publicView(dir).values;
        let key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key) { try { key = settings.read(dir).apiKey; } catch (_) { key = ''; } }
        if (!key) return Promise.resolve({ok: false, error: 'no key saved yet'});
        return checkKey({apiBase: config.apiBase, apiKey: key});
    }

    function serveStatic(res, entry) {
        fs.readFile(path.join(webDir, entry.file), (error, data) => {
            if (error) return send(res, 404, 'text/plain; charset=utf-8', 'not found');
            send(res, 200, entry.type, data, {'Cache-Control': 'no-cache'});
        });
    }

    function serveLog(res, name) {
        const text = ConversationLog.read(dataDir(), name);
        if (text === null) return json(res, 404, {ok: false, error: 'no such log'});
        send(res, 200, 'application/x-ndjson; charset=utf-8', text);
    }

    function route(req, res) {
        const pathname = String(req.url || '/').split('?')[0];
        const method = req.method;
        if (!localHost(req)) return json(res, 403, {ok: false, error: 'open this page by Jibo\'s address'});
        if (method === 'GET' && STATIC[pathname]) return serveStatic(res, STATIC[pathname]);
        if (method === 'GET' && pathname === '/api/settings') return json(res, 200, state());
        if (method === 'GET' && pathname === '/api/logs') return json(res, 200, {logs: ConversationLog.list(dataDir()), keep: ConversationLog.KEEP});
        if (method === 'GET' && pathname.indexOf('/api/logs/') === 0) return serveLog(res, pathname.slice('/api/logs/'.length));
        const writes = {'/api/settings': save, '/api/test-key': testKey};
        if (!writes[pathname]) return json(res, 404, {ok: false, error: 'not found'});
        if (method !== 'POST') return json(res, 405, {ok: false, error: 'POST only'});
        if (!sameOrigin(req)) return json(res, 403, {ok: false, error: 'only from this settings page'});
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, {ok: false, error: 'JSON only'});
        return readBody(req).then(body => {
            if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, {ok: false, error: 'expected an object'});
            return Promise.resolve(writes[pathname](body)).then(result => {
                if (result && result.httpStatus) return json(res, result.httpStatus, result.body);
                return json(res, 200, result);
            });
        }, error => json(res, error.status || 400, {ok: false, error: error.message || 'bad request'}));
    }

    function handle(req, res) {
        const failed = error => {
            log.error('settings page: ' + (error && error.stack || error));
            try { if (!res.headersSent) json(res, 500, {ok: false, error: 'something went wrong on Jibo'}); else res.end(); } catch (_) {}
        };
        try { Promise.resolve(route(req, res)).catch(failed); } catch (error) { failed(error); }
    }

    // Resolves once listening; rejects with the listen error (EADDRINUSE).
    function listen(port, host) {
        return new Promise((resolve, reject) => {
            const s = http.createServer(handle);
            s.setTimeout(REQUEST_TIMEOUT_MS);
            s.maxConnections = MAX_CONNECTIONS;
            s.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
            const failedToListen = error => { s.removeListener('listening', listening); reject(error); };
            const listening = () => {
                s.removeListener('error', failedToListen);
                s.on('error', error => log.error('settings server: ' + error.message));
                server = s;
                resolve(s.address());
            };
            s.once('error', failedToListen);
            s.once('listening', listening);
            s.listen(port, host);
        });
    }

    // Stops listening and drops open connections, so the port is free for the next revision.
    function close() {
        const s = server;
        server = null;
        sockets.forEach(socket => { try { socket.destroy(); } catch (_) {} });
        sockets.clear();
        if (!s) return Promise.resolve();
        return new Promise(resolve => { try { s.close(() => resolve()); } catch (_) { resolve(); } });
    }

    return {listen: listen, close: close, handle: handle, state: state, connections: () => sockets.size};
}

module.exports = {create, BODY_MAX, BUDGET};
