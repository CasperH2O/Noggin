// SPDX-License-Identifier: MIT
// The settings page's HTTP server: the page itself (web/) and a small JSON API over Noggin's
// settings, persona and conversation logs, plus the custom skills BEacon has installed (read-only,
// fetched here so the page never talks to BEacon, D33) and what Jibo's OpenAI use costs
// (lib/usage.js). It runs inside Be's process (background.js), so every handler is short, never
// blocks for long and never throws into Be.
// Open on the local network like BEacon (D6), with BEacon's guards: a request that changes
// something must come from this page (Origin/Referer), be JSON and stay small; the key is write-only.
// Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
const settings = require('./settings'), realtime = require('./realtime-session'), actions = require('./actions');
const openai = require('./openai'), ConversationLog = require('./conversation-log'), describe = require('./describe');
const memory = require('./memory'), usage = require('./usage'), stats = require('./stats'), strings = require('./text'), voice = require('./voice');
const {requestJson, withTimeout} = require('./http');

const BODY_MAX = 128 * 1024;
const IMPORT_BODY_MAX = 512 * 1024;   // a memory export is far smaller; the room is for files edited by hand (D156)
const REQUEST_TIMEOUT_MS = 15000;
const MAX_CONNECTIONS = 16;
// The persona size the page recommends: the instructions sent at every conversation start.
const BUDGET = 5800;
// BEacon runs in the same Be process; its list of custom skills carries each README (D33).
const BEACON_PORT = 8123;
const BEACON_TIMEOUT_MS = 4000;
const BEACON_MAX = 4 * 1024 * 1024;
// "Describe with AI" (D41): BEacon's list plus this stays inside REQUEST_TIMEOUT_MS.
const DESCRIBE_TIMEOUT_MS = 10000;
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
function readBody(req, max) {
    return new Promise((resolve, reject) => {
        const parts = [];
        let size = 0, failed = false;
        const fail = (status, message) => { if (!failed) { failed = true; reject({status: status, message: message}); } };
        req.on('data', chunk => {
            if (failed) return;
            size += chunk.length;
            if (size > max) { fail(413, 'too large'); req.resume(); return; }
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
    const post = options.post || openai.post, describeTimeoutMs = options.describeTimeoutMs || DESCRIBE_TIMEOUT_MS;
    let describing = false;
    const now = options.now || (() => new Date());
    // Jibo's local time ({year, monthNum, date, ...}), as the skill sees it (background.js passes
    // actions.localTime with Jibo's home timezone).
    const local = options.local || strings.systemTime;
    const http = options.http || require('http');
    const beacon = Object.assign({host: '127.0.0.1', port: Number(process.env.BEACON_PORT) || BEACON_PORT, timeoutMs: BEACON_TIMEOUT_MS}, options.beacon);
    let server = null, inventory = null;
    const sockets = new Set(), fetches = new Set();
    // Whether the Dutch Voice skill can speak Dutch (D169): asked fresh for every page load.
    const voiceStatus = options.voiceStatus || (() => voice.create().status());
    const costs = options.usage || usage.create({request: options.usageRequest, now: () => now().getTime(), local: local, log: log});
    // Set when a saved admin key turned out to have write access and was deleted (D62).
    let removedAdminKey = false;

    // Everything the page shows; never the key itself.
    function state() {
        const dir = dataDir(), view = settings.publicView(dir), persona = settings.persona(dir);
        const config = Object.assign({}, view.values);
        const abilities = config.actions ? {apps: Object.keys(actions.apps(config)), config: config} : null;
        const chars = realtime.instructions(persona.soul, persona.identity, now(), abilities, null, {presence: config.presence !== false}).length;
        const limits = {}, packaged = {};
        Object.keys(settings.PERSONA).forEach(name => { limits[name] = settings.PERSONA[name].max; packaged[name] = settings.packaged(name); });
        return {version: version, schema: settings.schemaView(), values: view.values, key: view.key, adminKey: view.adminKey, problems: view.problems, broken: view.broken,
            persona: {soul: persona.soul, identity: persona.identity, facts: persona.facts, edited: persona.edited, max: limits, packaged: packaged},
            budget: {chars: chars, recommended: BUDGET}, dutchVoice: voiceStatus()};
    }

    // POST /api/settings {values, persona}: both are checked before either is saved. A new admin
    // key is saved only once OpenAI shows it is read-only (D62).
    function save(body) {
        const values = body.values || {}, adminKey = values.adminKey;
        if (typeof adminKey !== 'string' || !adminKey.trim()) return saveNow(body);
        const checked = saveNow(body, {dryRun: true});
        if (checked) return checked;
        return costs.check(cleanSecret('adminKey', adminKey)).then(verdict => {
            if (verdict.state === 'read-only') return saveNow(body);
            log.warn('settings: admin key not saved (' + verdict.state + ')');
            return {httpStatus: 400, body: {ok: false, errors: {values: {adminKey: verdict.error + ' It was not saved.'}, persona: {}}}};
        });
    }
    // options.dryRun: only the refusal, or null when everything is fine.
    function saveNow(body, options) {
        const dir = dataDir(), values = body.values || {}, persona = body.persona || {};
        const a = settings.update(dir, values, {dryRun: true}), b = settings.updatePersona(dir, persona, {dryRun: true});
        const moved = movedWithoutKey(dir, values);
        if (moved) a.errors.apiBase = moved;
        if (!a.ok || !b.ok || moved) return {httpStatus: 400, body: {ok: false, errors: {values: a.errors, persona: b.errors}}};
        if (options && options.dryRun) return null;
        settings.update(dir, values);
        settings.updatePersona(dir, persona);
        if (Object.prototype.hasOwnProperty.call(values, 'apiKey') || Object.prototype.hasOwnProperty.call(values, 'adminKey')) costs.forget();
        if (values.adminKey) removedAdminKey = false;
        const secret = settings.SECRETS.filter(k => values[k]);
        log.info('settings saved: ' + Object.keys(values).concat(Object.keys(persona)).filter(k => settings.SECRETS.indexOf(k) < 0).join(', ') + (secret.length ? ' (and ' + secret.join(', ') + ')' : ''));
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

    // A key as it would be saved (quotes and spaces dropped), or the trimmed text when it is not one.
    function cleanSecret(name, value) {
        const field = settings.SCHEMA.filter(f => f.key === name)[0];
        return settings.check(field, value).value || String(value).trim();
    }
    // POST /api/test-key {key?}: the given key, or the saved one.
    function testKey(body) {
        const loaded = settings.load(dataDir());
        let key = typeof body.key === 'string' && body.key.trim() ? cleanSecret('apiKey', body.key) : '';
        if (!key) key = loaded.secrets.apiKey;
        const config = loaded.config;
        if (!key) return Promise.resolve({ok: false, error: 'no key saved yet'});
        return checkKey({apiBase: config.apiBase, apiKey: key});
    }

    // GET from BEacon: the parsed JSON, or an Error with a short reason. close() aborts it.
    function fromBeacon(pathname) {
        let abort = null;
        const untrack = () => { if (abort) fetches.delete(abort); };
        return requestJson({target: {protocol: 'http:', hostname: beacon.host, port: beacon.port, path: pathname}, transport: http,
            timeoutMs: beacon.timeoutMs, timeoutMessage: 'no answer in ' + beacon.timeoutMs / 1000 + ' s', maxBytes: BEACON_MAX,
            track: cancel => { abort = cancel; fetches.add(cancel); }})
            .then(r => {
                untrack();
                if (r.status !== 200) throw Error('status ' + r.status);
                if (r.json === null) throw Error('not JSON');
                return r.json;
            }, error => {
                untrack();
                throw error.code === 'ECONNREFUSED' ? Error('not running') : error;
            });
    }

    // BEacon's list of installed custom skills; requests during a fetch share it.
    function installedSkills() {
        if (!inventory) {
            inventory = fromBeacon('/api/skills/custom');
            const clear = () => { inventory = null; };
            inventory.then(clear, clear);
        }
        return inventory;
    }

    // GET /api/skills/found: installed custom skills that could become extra apps (D31, D33).
    function found() {
        return installedSkills().then(list => {
            const config = settings.publicView(dataDir()).values;
            return {httpStatus: 200, body: {ok: true, found: actions.suggestions(list, config), builtIn: Object.keys(actions.APPS)}};
        }, error => {
            log.warn('skill scan: BEacon ' + error.message);
            return {httpStatus: 502, body: {ok: false, error: 'BEacon did not answer (' + error.message + ').'}};
        });
    }

    // POST /api/apps/describe {pkg}: one line on what an installed skill does, written by the
    // fallback model from its README (D41). Only a package name comes in; the README is BEacon's,
    // so this never sends other text to OpenAI. One at a time.
    function describeApp(body) {
        const pkg = typeof body.pkg === 'string' ? body.pkg : '';
        if (!actions.APP_PACKAGE.test(pkg)) return {httpStatus: 400, body: {ok: false, error: 'not a package name'}};
        let config;
        try { config = settings.read(dataDir()); } catch (_) { return {httpStatus: 400, body: {ok: false, error: 'save an API key first'}}; }
        if (describing) return {httpStatus: 429, body: {ok: false, error: 'Jibo is already describing an app'}};
        describing = true;
        const fail = (status, error) => ({httpStatus: status, body: {ok: false, error: error}});
        return installedSkills().then(list => {
            const skill = (list && Array.isArray(list.skills) ? list.skills : []).filter(item => item && item.packageName === pkg)[0];
            if (!skill) return fail(404, 'not installed through BEacon');
            if (!String(skill.readme || '').trim()) return fail(422, 'it has no README to describe');
            const name = skill.manifest && typeof skill.manifest.name === 'string' ? skill.manifest.name : pkg;
            let abort = null;
            const untrack = () => { if (abort) fetches.delete(abort); };
            const asked = Promise.resolve().then(() => post(config, '/responses', describe.request(config.fallbackModel, name, skill.readme), describeTimeoutMs,
                cancel => { abort = cancel; fetches.add(cancel); }));
            const late = () => {
                const reason = 'no answer in ' + describeTimeoutMs / 1000 + ' s';
                if (abort) abort(reason);
                throw Error(reason);
            };
            return withTimeout(asked, describeTimeoutMs, late).then(r => { untrack(); return r; }, error => { untrack(); throw error; }).then(r => {
                if (r.status !== 200) return fail(502, r.status === 401 ? 'OpenAI does not accept the key' : 'OpenAI answered ' + r.status);
                const line = describe.result(r.json);
                if (line.refused) log.warn('describe ' + pkg + ': refused "' + line.refused.slice(0, 120) + '"');
                return line.error ? fail(422, line.error) : {httpStatus: 200, body: {ok: true, about: line.about, model: config.fallbackModel}};
            }, error => fail(502, 'OpenAI did not answer (' + String(error && error.message || error).slice(0, 80) + ')'));
        }, error => fail(502, 'BEacon did not answer (' + error.message + ')'))
            .then(result => { describing = false; return result; }, error => { describing = false; throw error; });
    }

    // ---- usage (the Usage tab, D60-D68) ----
    // GET /api/usage[?refresh=1]: from the robot's memory when fresh, else from OpenAI (D64).
    function usageView(refresh) {
        const dir = dataDir(), loaded = settings.load(dir), keys = loaded.secrets, config = loaded.config;
        if (!keys.adminKey) return Promise.resolve({ok: false, state: removedAdminKey ? 'removed' : 'no-key'});
        return costs.report({adminKey: keys.adminKey, apiKey: keys.apiKey, config: config,
            conversations: config.log ? since => ConversationLog.started(dir, since) : null,
            onWriteKey: checked => {
                // Only the key that was checked: a new one may have been saved meanwhile.
                if (settings.secrets(dir).adminKey !== checked) return;
                const done = settings.update(dir, {adminKey: null});
                if (!done.ok) throw Error('settings: ' + JSON.stringify(done.errors));
                removedAdminKey = true;
                log.warn('usage: the saved admin key has write access; deleted from Jibo');
            }}, refresh).then(view => view.state === 'write' ? {ok: false, state: 'removed'} : view);
    }

    // ---- memory (the Memory tab, D49) ----
    function today() { return memory.dayOf(local(now().getTime())); }
    // GET /api/memory: the facts and summaries, newest summaries first, and how full the facts are.
    function memoryView() {
        const state = memory.read(dataDir()), day = today();
        return {ok: true,
            facts: state.facts.map(f => ({id: f.id, text: f.text, source: f.source, expires: f.expires || null})),
            summaries: state.summaries.slice().reverse().map(s => ({id: s.id, text: s.text, when: memory.label(s, day)})),
            used: state.facts.reduce((sum, f) => sum + f.text.length + 3, 0), max: memory.FACT_CHARS};
    }
    const MEMORY_ERRORS = {full: 'Jibo\'s memory is full: delete a fact first.', 'too long': 'At most ' + memory.FACT_MAX + ' characters.',
        empty: 'Write the fact first.', 'not a plain memory': 'That reads like an instruction, a link or code, not a fact.',
        expired: 'That day has passed.', unknown: 'That fact is gone already.'};
    // POST /api/memory/fact {id?, text, expires?}: add a fact, or change one. A fact written or
    // changed here counts as asked: the automatic recap never removes it.
    function saveFact(body) {
        const text = typeof body.text === 'string' ? body.text : '', expires = typeof body.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.expires) ? body.expires : null;
        const r = memory.update(dataDir(), state => {
            const done = typeof body.id === 'string' && body.id
                ? memory.editFact(state, body.id, text, {source: 'asked'})
                : memory.addFact(state, text, 'asked', {expires: expires, today: today()});
            if (done.ok && body.id) { if (expires) done.fact.expires = expires; else delete done.fact.expires; }
            return done.ok ? done : {unchanged: true, ok: false, reason: done.reason};
        });
        if (!r.ok) return {httpStatus: 400, body: {ok: false, error: MEMORY_ERRORS[r.reason] || 'Not saved.'}};
        log.info('memory: fact ' + (body.id ? 'changed' : r.duplicate ? 'already kept' : 'added') + ' on the settings page');
        return memoryView();
    }
    // POST /api/memory/delete {kind: 'fact'|'summary', id}
    function deleteMemory(body) {
        const id = typeof body.id === 'string' ? body.id : '';
        const r = memory.update(dataDir(), state => {
            const done = body.kind === 'summary' ? memory.removeSummary(state, id) : memory.removeFact(state, id);
            return done.ok ? done : {unchanged: true, ok: false};
        });
        if (!r.ok) return {httpStatus: 404, body: {ok: false, error: MEMORY_ERRORS.unknown}};
        return memoryView();
    }
    // POST /api/memory/clear {confirm: true}: every fact and note goes, and every conversation so
    // far counts as recapped (its recap transcript deleted), so nothing from before comes back.
    function clearMemory(body) {
        if (body.confirm !== true) return {httpStatus: 400, body: {ok: false, error: 'not confirmed'}};
        const dir = dataDir(), all = ConversationLog.transcripts(dir);
        memory.update(dir, state => {
            state.facts = []; state.summaries = [];
            state.recap.done = all.slice(0, memory.MAX_DONE);
            state.recap.tries = {};
        });
        ConversationLog.dropRecap(dir, all);
        log.info('memory: everything forgotten on the settings page');
        return memoryView();
    }
    const SKIP_WORDS = {'too long': 'too long', 'not a plain memory': 'read like instructions, links or code', full: 'did not fit in the memory',
        expired: 'for a day that has passed', empty: 'empty', old: 'older than two weeks', future: 'dated in the future', 'no day': 'without a day', 'bad date': 'with a date that does not exist'};
    function importMessage(r) {
        const n = (count, one, many) => count + ' ' + (count === 1 ? one : many);
        const parts = [], added = [];
        if (r.added.facts) added.push(n(r.added.facts, 'fact', 'facts'));
        if (r.added.notes) added.push(n(r.added.notes, 'note', 'notes'));
        parts.push(added.length ? 'Added ' + added.join(' and ') + '.' : 'Nothing new to add.');
        const known = r.known.facts + r.known.notes;
        if (known) parts.push(known + ' already known.');
        const skipped = Object.keys(r.skipped).map(reason => r.skipped[reason] + ' ' + (SKIP_WORDS[reason] || reason));
        if (skipped.length) parts.push('Left out: ' + skipped.join(', ') + '.');
        return parts.join(' ');
    }
    // POST /api/memory/import {data, mode: 'add'|'replace', confirm?}: the facts and notes of an
    // export (D156). Adding keeps everything already there and refuses what does not fit; replacing
    // needs confirm: true and is refused when nothing in the file could be used.
    function importMemory(body) {
        const replace = body.mode === 'replace';
        if (body.mode !== undefined && body.mode !== 'add' && !replace) return {httpStatus: 400, body: {ok: false, error: 'mode is add or replace'}};
        if (replace && body.confirm !== true) return {httpStatus: 400, body: {ok: false, error: 'not confirmed'}};
        let failed = null;
        const transcripts = replace ? ConversationLog.transcripts(dataDir()) : [];
        const r = memory.update(dataDir(), state => {
            const done = memory.importData(state, body.data, {today: today(), replace: replace});
            if (!done.ok) { failed = done.error; return {unchanged: true, done: done}; }
            // Replacing with a file that gives nothing back would only wipe the memory.
            if (done.empty) { if (replace) failed = 'Nothing in that file could be used, so nothing was replaced. ' + importMessage(done); return {unchanged: true, done: done}; }
            // A replace is the file and nothing else: the conversations so far are not recapped on top of it, as after "Forget everything".
            if (replace) { state.recap.done = transcripts.slice(0, memory.MAX_DONE); state.recap.tries = {}; }
            return {done: done};
        });
        if (failed) return {httpStatus: 400, body: {ok: false, error: failed}};
        if (replace) ConversationLog.dropRecap(dataDir(), transcripts);
        log.info('memory: import on the settings page (' + (replace ? 'replace' : 'add') + '): ' + r.done.added.facts + ' facts, ' + r.done.added.notes + ' notes added');
        return Object.assign(memoryView(), {message: importMessage(r.done)});
    }
    function exportMemory(res) {
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(memory.exportData(memory.read(dataDir())), null, 2),
            {'Content-Disposition': 'attachment; filename="noggin-memory-' + today() + '.json"'});
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
        const pathname = String(req.url || '/').split('?')[0], query = String(req.url || '').split('?')[1] || '';
        const method = req.method;
        if (!localHost(req)) return json(res, 403, {ok: false, error: 'open this page by Jibo\'s address'});
        if (method === 'GET' && STATIC[pathname]) return serveStatic(res, STATIC[pathname]);
        if (method === 'GET' && pathname === '/api/settings') return json(res, 200, state());
        if (method === 'GET' && pathname === '/api/logs') return json(res, 200, {logs: ConversationLog.list(dataDir()), keep: ConversationLog.KEEP});
        if (method === 'GET' && pathname.indexOf('/api/logs/') === 0) return serveLog(res, pathname.slice('/api/logs/'.length));
        if (method === 'GET' && pathname === '/api/skills/found') return found().then(result => json(res, result.httpStatus, result.body));
        if (method === 'GET' && pathname === '/api/memory') return json(res, 200, memoryView());
        if (method === 'GET' && pathname === '/api/stats') return json(res, 200, Object.assign({ok: true}, stats.report(stats.scan(dataDir()), now().getTime(), local)));
        if (method === 'GET' && pathname === '/api/usage') return usageView(/(^|&)refresh=1(&|$)/.test(query)).then(view => json(res, 200, view));
        if (method === 'GET' && pathname === '/api/memory/export') return exportMemory(res);
        const writes = {'/api/settings': save, '/api/test-key': testKey, '/api/apps/describe': describeApp,
            '/api/memory/fact': saveFact, '/api/memory/delete': deleteMemory, '/api/memory/clear': clearMemory,
            '/api/memory/import': importMemory};
        if (!writes[pathname]) return json(res, 404, {ok: false, error: 'not found'});
        if (method !== 'POST') return json(res, 405, {ok: false, error: 'POST only'});
        if (!sameOrigin(req)) return json(res, 403, {ok: false, error: 'only from this settings page'});
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return json(res, 415, {ok: false, error: 'JSON only'});
        return readBody(req, pathname === '/api/memory/import' ? IMPORT_BODY_MAX : BODY_MAX).then(body => {
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
        fetches.forEach(abort => abort('stopped'));
        costs.close();
        if (!s) return Promise.resolve();
        return new Promise(resolve => { try { s.close(() => resolve()); } catch (_) { resolve(); } });
    }

    // usage(): the Usage tab's view (cached, D64), also for the budget heads-up (D74).
    return {listen: listen, close: close, handle: handle, state: state, usage: () => usageView(false), connections: () => sockets.size};
}

module.exports = {create, BODY_MAX, IMPORT_BODY_MAX, BUDGET};
