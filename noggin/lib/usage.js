// SPDX-License-Identifier: MIT
// The settings page's Usage tab: what Jibo's OpenAI use costs, read with a read-only admin key.
// Only GETs to OpenAI's organization endpoints (costs, usage, spend limits, project keys), plus one
// write attempt that cannot change anything, to prove the key is read-only (D62). The admin key
// only ever goes to api.openai.com (D61). Answers are kept in memory for a while, never on disk
// (D64). Names and emails in OpenAI's answers never reach the page. Node 6: ES2015 only.
'use strict';
const https = require('https'), crypto = require('crypto');

const HOST = 'api.openai.com';
const BASE = '/v1/organization';
const ADMIN_PREFIX = 'sk-admin-';
const REQUEST_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 12000;   // inside the settings server's 15 s request timeout
const CHECK_TIMEOUT_MS = 10000;
const ANSWER_MAX = 2 * 1024 * 1024;
const CACHE_MS = 15 * 60000;      // D64
const REFRESH_MS = 60000;
const MAX_PROJECTS = 20;          // D63
const DAYS = 7;
const DAY_MS = 86400000, HOUR_MS = 3600000;
// An invite id that cannot exist: a write key gets 404 and nothing changes (D62).
const PROBE_PATH = BASE + '/invites/invite-noggin-read-only-check';
const READ_ONLY = /api\.management\.write/;

// What each of Noggin's models is for, by the setting that names it.
const FEATURES = {
    conversation: {label: 'Conversation', use: 'Hears Jibo\'s microphone and writes what he says.'},
    transcription: {label: 'Transcription', use: 'Writes down what people say, for the log, the memory and Jibo\'s skills.'},
    expressions: {label: 'Expressions', use: 'Picks Jibo\'s face and body expression for each line.'},
    helper: {label: 'Notes and helpers', use: 'Memory notes after each conversation, Describe with AI, and expressions when the Decisions API is not available.'},
    other: {label: 'Other', use: 'Not one of Noggin\'s models now: an earlier setting, or another program using the same key.'}
};

function isAdminKey(key) { return typeof key === 'string' && key.indexOf(ADMIN_PREFIX) === 0 && /^\S{20,400}$/.test(key); }

// One HTTPS request to OpenAI with the admin key: {status, json}. Never follows redirects.
let agent = null;
function request(method, pathname, key, timeoutMs, track) {
    agent = agent || new https.Agent({keepAlive: true, maxSockets: 4});
    return new Promise((resolve, reject) => {
        let done = false;
        const finish = (error, value) => { if (done) return; done = true; if (error) reject(error); else resolve(value); };
        let req;
        try {
            req = https.request({method: method, host: HOST, path: pathname, agent: agent,
                headers: {Authorization: 'Bearer ' + key, Accept: 'application/json'}}, res => {
                const parts = [];
                let size = 0;
                res.on('data', chunk => {
                    size += chunk.length;
                    if (size > ANSWER_MAX) { try { req.abort(); } catch (_) {} finish(Error('answer too large')); }
                    else parts.push(chunk);
                });
                res.on('end', () => {
                    let json = null;
                    try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (_) {}
                    finish(null, {status: res.statusCode, json: json});
                });
                res.on('error', error => finish(error));
            });
        } catch (error) { return finish(error); }
        req.on('error', error => finish(error));
        req.setTimeout(timeoutMs || REQUEST_TIMEOUT_MS, () => { try { req.abort(); } catch (_) {} finish(Error('no answer in time')); });
        if (track) track(reason => { try { req.abort(); } catch (_) {} finish(Error(reason || 'stopped')); });
        req.end();
    });
}

// The OpenAI error text, cut short.
function errorText(r) {
    const e = r && r.json && r.json.error;
    return String(e && (e.message || e) || 'HTTP ' + (r && r.status)).slice(0, 200);
}

// The read-only check (D62): {state: 'read-only'|'write'|'rejected'|'unknown', error}.
function classify(r) {
    if (r.status === 403 && READ_ONLY.test(errorText(r))) return {state: 'read-only'};
    if (r.status === 401) return {state: 'rejected', error: 'OpenAI does not accept this admin key.'};
    if ((r.status >= 200 && r.status < 300) || [400, 404, 409, 422].indexOf(r.status) >= 0) {
        return {state: 'write', error: 'This admin key can change your OpenAI account. Noggin only keeps a key with Read only permission.'};
    }
    if (r.status === 403) return {state: 'unknown', error: 'OpenAI refused the check: ' + errorText(r)};
    return {state: 'unknown', error: 'OpenAI answered ' + r.status + ' to the check.'};
}

// ---- reading the bills ----

// "gpt-realtime-2.1 audio, cached input" -> {model: 'gpt-realtime-2.1', modality: 'audio', kind: 'cached input'}
function lineItem(text) {
    text = String(text || '');
    const comma = text.lastIndexOf(', ');
    let left = comma >= 0 ? text.slice(0, comma) : text;
    const kind = comma >= 0 ? text.slice(comma + 2) : '';
    let modality = null;
    const m = /^(.*) (text|audio|image)$/.exec(left);
    if (m) { left = m[1]; modality = m[2]; }
    return {model: modelName(left), modality: modality, kind: kind};
}
// A dated snapshot counts as its model: the date suffix is dropped.
function modelName(name) { return String(name || '').trim().replace(/-\d{4}-\d{2}-\d{2}$/, ''); }
function tokenKind(kind) {
    if (kind === 'input') return 'input';
    if (kind === 'cached input') return 'cached';
    if (kind === 'output') return 'output';
    if (kind.indexOf('cache write') === 0) return 'cacheWrite';
    return 'other';
}

// Which feature a model serves, by the settings that name it now.
function featureOf(model, config) {
    if (model === modelName(config.realtimeModel)) return 'conversation';
    if (model === modelName(config.transcribeModel)) return 'transcription';
    if (model === modelName(config.classifierModel)) return 'expressions';
    if (model === modelName(config.fallbackModel)) return 'helper';
    if (/realtime/.test(model)) return 'conversation';
    if (/transcribe/.test(model)) return 'transcription';
    return 'other';
}

function amount(result) {
    const v = result && result.amount && parseFloat(result.amount.value);
    return isFinite(v) ? v : 0;
}
function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function round(n, places) { const f = Math.pow(10, places); return Math.round(n * f) / f; }

// The realtime model to compare with (D67): the mini one, or the full one for a mini.
function otherModel(model) { return /-mini$/.test(model) ? model.replace(/-mini$/, '') : model + '-mini'; }

// Everything the page shows, from the answers. Pure, for the tests.
//   costs: the costs buckets (group_by line_item, api_key_id, project_id); hours: completions usage
//   buckets (1 h, Jibo's key); limit: {amount, enforced, source} or null; alerts: [amount];
//   conversations: {count, since} or null; key: {id, name, hint, project}; config: the model settings.
function build(input) {
    const now = input.now, config = input.config, jiboKey = input.key.id;
    const today = utcDay(now), monthStart = today.slice(0, 8) + '01';
    const days = [];
    for (let i = DAYS - 1; i >= 0; i--) days.push(utcDay(now - i * DAY_MS));
    const firstDay = days[0];
    // What the limit counts: the project's spend for a project limit, else the whole account's (D65).
    const counts = r => !(input.limit && input.limit.source === 'project') || r.project_id === input.key.project;
    const perDay = {}, models = {}, prices = {}, month = {jibo: 0, account: 0, counted: 0}, week = {jibo: 0, other: 0};
    const countedByDay = {};
    days.forEach(day => { perDay[day] = {day: day, cost: 0, tokens: 0}; });

    (input.costs || []).forEach(bucket => {
        const day = utcDay(bucket.start_time * 1000);
        (bucket.results || []).forEach(r => {
            const cost = amount(r), item = lineItem(r.line_item), mine = r.api_key_id === jiboKey;
            const tokens = r.quantity_unit === 'tokens' && isFinite(r.quantity) ? Number(r.quantity) : 0;
            if (counts(r)) countedByDay[day] = (countedByDay[day] || 0) + cost;
            if (day >= monthStart) { month.account += cost; if (counts(r)) month.counted += cost; if (mine) month.jibo += cost; }
            // Prices from every day fetched, any key: the account's real prices (D67).
            if (tokens > 0 && cost > 0) {
                const p = item.model + '|' + (item.modality || '') + '|' + item.kind;
                const seen = prices[p] || (prices[p] = {cost: 0, tokens: 0});
                seen.cost += cost; seen.tokens += tokens;
            }
            if (day < firstDay) return;
            if (!mine) { week.other += cost; return; }
            week.jibo += cost;
            if (perDay[day]) { perDay[day].cost += cost; perDay[day].tokens += tokens; }
            const m = models[item.model] || (models[item.model] = {model: item.model, cost: 0, tokens: 0, input: 0, cached: 0, output: 0, items: {}});
            m.cost += cost; m.tokens += tokens;
            const k = tokenKind(item.kind);
            if (k === 'input' || k === 'cacheWrite') m.input += tokens; else if (k === 'cached') m.cached += tokens; else if (k === 'output') m.output += tokens;
            const key = (item.modality || '') + '|' + item.kind;
            m.items[key] = (m.items[key] || 0) + tokens;
        });
    });

    const price = (model, modality, kind) => {
        const seen = prices[model + '|' + (modality || '') + '|' + kind];
        return seen && seen.tokens > 0 ? seen.cost / seen.tokens : null;
    };

    // Caching (D67): cached tokens at the input price minus what they cost.
    let saved = 0, cachedTokens = 0, inputTokens = 0;
    Object.keys(models).forEach(name => {
        const m = models[name];
        cachedTokens += m.cached; inputTokens += m.input + m.cached;
        Object.keys(m.items).forEach(key => {
            const parts = key.split('|'), modality = parts[0] || null, kind = parts[1];
            if (kind !== 'cached input') return;
            const full = price(name, modality, 'input'), cheap = price(name, modality, 'cached input');
            if (full !== null) saved += m.items[key] * (full - (cheap || 0));
        });
    });

    // What if (D67): the conversation model's tokens at the other realtime model's prices.
    const ownModel = modelName(config.realtimeModel), altModel = otherModel(ownModel);
    let whatIf = null;
    if (models[ownModel] && models[ownModel].tokens > 0) {
        let would = 0, unknown = false;
        Object.keys(models[ownModel].items).forEach(key => {
            const tokens = models[ownModel].items[key];
            if (!tokens) return;
            const parts = key.split('|'), p = price(altModel, parts[0] || null, parts[1]);
            if (p === null) unknown = true; else would += tokens * p;
        });
        whatIf = {model: ownModel, other: altModel, actual: round(models[ownModel].cost, 4), would: unknown ? null : round(would, 4)};
    }

    const modelList = Object.keys(models).map(name => {
        const m = models[name], feature = featureOf(name, config);
        return {model: name, feature: feature, label: FEATURES[feature].label, use: FEATURES[feature].use, cost: round(m.cost, 4),
            tokens: m.tokens, input: m.input, cached: m.cached, output: m.output};
    }).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
    const features = {};
    modelList.forEach(m => {
        const f = features[m.feature] || (features[m.feature] = {feature: m.feature, label: m.label, use: m.use, cost: 0, tokens: 0, models: []});
        f.cost += m.cost; f.tokens += m.tokens; f.models.push(m.model);
    });
    const featureList = Object.keys(features).map(k => Object.assign(features[k], {cost: round(features[k].cost, 4)})).sort((a, b) => b.cost - a.cost);

    // Budget and forecast (D65): what the limit counts this month, plus the average of the 7 full
    // days before today for each day after today (today counts with what is billed so far).
    const dayOfMonth = Number(today.slice(8, 10));
    const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    let average = 0;
    for (let i = 1; i <= DAYS; i++) average += (countedByDay[utcDay(now - i * DAY_MS)] || 0) / DAYS;
    const limit = input.limit;
    const budget = {
        jibo: round(month.jibo, 4), account: round(month.account, 4), spent: round(month.counted, 4),
        forecast: round(month.counted + average * (daysInMonth - dayOfMonth), 2),
        limit: limit ? limit.amount : null, enforced: limit ? limit.enforced : null, source: limit ? limit.source : null,
        left: limit ? round(Math.max(0, limit.amount - month.counted), 4) : null,
        alerts: (input.alerts || []).slice().sort((a, b) => a - b)
    };

    // Cost per conversation (D66).
    let perConversation = null;
    if (input.conversations) {
        const since = input.conversations.since ? utcDay(input.conversations.since) : firstDay;
        const spent = days.filter(day => day >= since).reduce((sum, day) => sum + perDay[day].cost, 0);
        const count = input.conversations.count;
        perConversation = {count: count, cost: round(spent, 4), each: count ? round(spent / count, 4) : null, partial: since > firstDay};
    }

    return {
        ok: true, state: 'ok', currency: input.currency || 'usd', today: today,
        key: {name: input.key.name, hint: input.key.hint},
        days: days.map(day => ({day: day, cost: round(perDay[day].cost, 4), tokens: perDay[day].tokens})),
        week: {jibo: round(week.jibo, 4), other: round(week.other, 4)},
        models: modelList, features: featureList, budget: budget,
        caching: {saved: round(saved, 4), cachedTokens: cachedTokens, share: inputTokens ? round(cachedTokens / inputTokens, 3) : null},
        whatIf: whatIf, perConversation: perConversation, hours: hourGrid(input.hours || [], now, input.local)
    };
}

// Requests per hour of Jibo's local day, for the last 7 days: rows newest last.
function hourGrid(buckets, now, local) {
    const dayKey = t => t.year + '-' + (t.monthNum + 1) + '-' + t.date;
    const rows = [], index = {};
    for (let i = DAYS - 1; i >= 0; i--) {
        const t = local(now - i * DAY_MS), key = dayKey(t);
        if (index[key] !== undefined) continue;
        index[key] = rows.length;
        rows.push({day: t.year + '-' + pad(t.monthNum + 1) + '-' + pad(t.date), counts: new Array(24).fill(0)});
    }
    let max = 0;
    buckets.forEach(bucket => {
        const count = (bucket.results || []).reduce((sum, r) => sum + (Number(r.num_model_requests) || 0), 0);
        if (!count) return;
        const t = local(bucket.start_time * 1000), row = index[dayKey(t)];
        if (row === undefined || typeof t.hour !== 'number') return;
        rows[row].counts[t.hour] += count;
        max = Math.max(max, rows[row].counts[t.hour]);
    });
    return {rows: rows, max: max};
}
function pad(n) { return (n < 10 ? '0' : '') + n; }

// The conversation key matched against the project keys' redacted values (D63).
function redactedParts(value) {
    const s = String(value || ''), first = s.indexOf('*'), last = s.lastIndexOf('*');
    return first < 0 ? null : {start: s.slice(0, first), end: s.slice(last + 1)};
}
function matches(apiKey, redacted) {
    const parts = redactedParts(redacted);
    if (!parts || parts.end.length < 4 || !apiKey) return false;
    return apiKey.indexOf(parts.start) === 0 && apiKey.slice(-parts.end.length) === parts.end;
}

// ---- the fetcher with its cache ----

// options: request (for tests), now, local (Jibo's local time {year, monthNum, date, hour}),
// conversations(dataDir, sinceMs) -> {count, since} or null, log.
function create(options) {
    options = options || {};
    const send = options.request || request;
    const now = options.now || (() => Date.now());
    const local = options.local || (ms => { const d = new Date(ms); return {year: d.getFullYear(), monthNum: d.getMonth(), date: d.getDate(), hour: d.getHours()}; });
    const log = options.log || {info() {}, warn() {}, error() {}};
    const aborts = new Set();
    let cache = null, running = null, closed = false;

    // own: the set of aborts of one fetch or check, so its timeout stops only its own requests.
    function call(method, pathname, key, own) {
        if (closed) return Promise.reject(Error('stopped'));
        let abort = null;
        const untrack = () => { aborts.delete(abort); if (own) own.delete(abort); };
        return send(method, pathname, key, REQUEST_TIMEOUT_MS, cancel => { abort = cancel; aborts.add(cancel); if (own) own.add(cancel); })
            .then(r => { untrack(); return r; }, error => { untrack(); throw error; });
    }
    function get(pathname, key, own) {
        return call('GET', pathname, key, own).then(r => {
            if (r.status !== 200 || !r.json) { const e = Error('OpenAI answered ' + r.status + ' for ' + pathname.split('?')[0].replace(BASE, '') + ': ' + errorText(r)); e.status = r.status; throw e; }
            return r.json;
        });
    }
    // Every page of a paged answer, at most `pages`.
    function pages(pathname, key, most, own) {
        const out = [];
        const next = (page, left) => get(pathname + (page ? '&page=' + encodeURIComponent(page) : ''), key, own).then(json => {
            Array.prototype.push.apply(out, json.data || []);
            return json.has_more && json.next_page && left > 1 ? next(json.next_page, left - 1) : out;
        });
        return next(null, most || 3);
    }

    function probe(adminKey, own) {
        if (!isAdminKey(adminKey)) return Promise.resolve({state: 'rejected', error: 'An admin key starts with ' + ADMIN_PREFIX + '. Make one on OpenAI under Admin keys, with Read only permission.'});
        return call('DELETE', PROBE_PATH, adminKey, own).then(classify, error => ({state: 'unknown', error: 'Could not reach OpenAI (' + String(error && error.message || error).slice(0, 80) + ').'}));
    }
    // The read-only check alone, for saving a new key; it ends within CHECK_TIMEOUT_MS.
    function check(adminKey) {
        const own = new Set();
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                own.forEach(abort => abort('no answer in time'));
                resolve({state: 'unknown', error: 'OpenAI did not answer the check in time.'});
            }, CHECK_TIMEOUT_MS);
            probe(adminKey, own).then(verdict => { clearTimeout(timer); resolve(verdict); });
        });
    }

    // Jibo's key among the project keys: {id, name, hint, project} or an Error with a reason.
    function findKey(adminKey, apiKey, own) {
        return pages(BASE + '/projects?limit=100', adminKey, 1, own).then(projects => {
            projects = projects.slice(0, MAX_PROJECTS);
            return Promise.all(projects.map(p => pages(BASE + '/projects/' + encodeURIComponent(p.id) + '/api_keys?limit=100', adminKey, 2, own)
                .then(keys => keys.filter(k => matches(apiKey, k.redacted_value)).map(k => ({id: k.id, name: String(k.name || '').slice(0, 80), hint: '…' + apiKey.slice(-4), project: p.id})))));
        }).then(lists => {
            const found = [].concat.apply([], lists);
            if (found.length === 1) return found[0];
            const error = Error(found.length ? 'Several keys on this account end like Jibo\'s key, so Noggin cannot tell which one is his.'
                : 'Jibo\'s API key is not on the account this admin key belongs to. Use an admin key from the same organization.');
            error.noMatch = true;
            throw error;
        });
    }

    function limits(adminKey, project, own) {
        const org = () => Promise.all([get(BASE + '/spend_limit', adminKey, own).catch(e => { if (e.status === 404) return null; throw e; }),
            pages(BASE + '/spend_alerts?limit=100', adminKey, 1, own)]).then(r => ({limit: r[0], alerts: r[1], source: 'organization'}));
        return get(BASE + '/projects/' + encodeURIComponent(project) + '/spend_limit', adminKey, own).then(limit =>
            pages(BASE + '/projects/' + encodeURIComponent(project) + '/spend_alerts?limit=100', adminKey, 1, own).then(alerts => ({limit: limit, alerts: alerts, source: 'project'})),
        e => { if (e.status === 404) return org(); throw e; }).then(r => ({
            limit: r.limit && isFinite(r.limit.threshold_amount) ? {amount: r.limit.threshold_amount / 100,
                enforced: !!(r.limit.enforcement && r.limit.enforcement.status === 'active'), source: r.source} : null,
            alerts: (r.alerts || []).map(a => a.threshold_amount / 100).filter(isFinite)
        }));
    }

    function fetchAll(input, own) {
        const t = now();
        return probe(input.adminKey, own).then(verdict => {
            if (verdict.state !== 'read-only') return {ok: false, state: verdict.state, error: verdict.error};
            if (!input.apiKey) return {ok: false, state: 'no-api-key', error: 'Save Jibo\'s OpenAI API key on the Brain tab first: Noggin counts what that key spends.'};
            return findKey(input.adminKey, input.apiKey, own).then(key => {
                const monthStart = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
                // The 7 days shown start at weekStart; the forecast also needs the day before.
                const weekStart = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()) - (DAYS - 1) * DAY_MS;
                const start = Math.floor(Math.min(monthStart, weekStart - DAY_MS) / 1000);
                const hourStart = Math.floor((Math.floor(t / HOUR_MS) * HOUR_MS - (DAYS * 24 - 1) * HOUR_MS) / 1000);
                return Promise.all([
                    pages(BASE + '/costs?start_time=' + start + '&bucket_width=1d&limit=40&group_by=line_item&group_by=api_key_id&group_by=project_id', input.adminKey, 3, own),
                    pages(BASE + '/usage/completions?start_time=' + hourStart + '&bucket_width=1h&limit=168&api_key_ids=' + encodeURIComponent(key.id), input.adminKey, 2, own),
                    limits(input.adminKey, key.project, own)
                ]).then(r => {
                    const currency = (r[0].map(b => (b.results || [])[0]).filter(Boolean)[0] || {amount: {}}).amount.currency;
                    // Conversations over the same UTC days as the costs (D66).
                    return build({now: t, config: input.config, key: key, costs: r[0], hours: r[1], limit: r[2].limit, alerts: r[2].alerts,
                        conversations: input.conversations ? input.conversations(weekStart) : null, local: local, currency: currency});
                });
            }, error => { if (!error.noMatch) throw error; return {ok: false, state: 'no-match', error: error.message}; });
        });
    }

    function fingerprint(input) { return crypto.createHash('sha256').update(input.adminKey + '\n' + (input.apiKey || '')).digest('hex'); }

    function failed(error) {
        const text = String(error && error.message || error).slice(0, 160);
        log.warn('usage: ' + text);
        return {ok: false, state: 'error', error: 'OpenAI did not answer (' + text + ').'};
    }

    // The dashboard: {ok, state, ...}. input: {adminKey, apiKey, config, conversations}. refresh:
    // skip the cache, at most once a minute (D64). A key found to have write access calls
    // input.onWriteKey(adminKey) so the robot forgets it (D62). Always resolves.
    function report(input, refresh) {
        if (!input.adminKey) return Promise.resolve({ok: false, state: 'no-key'});
        const fp = fingerprint(input), t = now();
        if (cache && cache.fp === fp) {
            const age = t - cache.at;
            if (age < (refresh ? REFRESH_MS : CACHE_MS)) return Promise.resolve(Object.assign({}, cache.view, {fetchedAt: cache.at, cached: true, tooSoon: !!refresh}));
        }
        if (running && running.fp === fp) return running.promise;
        const own = new Set(), current = {fp: fp};
        const promise = new Promise(resolve => {
            const timer = setTimeout(() => {
                own.forEach(abort => abort('no answer in time'));
                resolve(failed(Error('no answer in time')));
            }, FETCH_TIMEOUT_MS);
            fetchAll(input, own).then(view => { clearTimeout(timer); resolve(view); }, error => { clearTimeout(timer); resolve(failed(error)); });
        }).then(view => {
            if (view.state === 'write' && input.onWriteKey) {
                try { input.onWriteKey(input.adminKey); }
                catch (error) {
                    log.error('usage: could not delete the admin key with write access: ' + error.message);
                    view = {ok: false, state: 'error', error: 'This admin key can change your OpenAI account, and Jibo could not delete it (' + error.message + '). Remove it on this tab.'};
                }
            }
            if (view.ok && !closed) cache = {fp: fp, at: t, view: view};
            if (running === current) running = null;
            return Object.assign({}, view, {fetchedAt: t, cached: false});
        });
        current.promise = promise;
        running = current;
        return promise;
    }

    return {
        check: check, report: report,
        forget() { cache = null; },
        close() { closed = true; cache = null; aborts.forEach(abort => abort('stopped')); aborts.clear(); }
    };
}

module.exports = {create, build, lineItem, featureOf, classify, matches, hourGrid, PROBE_PATH, HOST};
