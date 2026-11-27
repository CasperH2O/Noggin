// SPDX-License-Identifier: MIT
// Noggin: when a conversation cannot start or goes on no longer, what went wrong and how Jibo
// says it (D70). OpenAI's refusal of the realtime WebSocket only shows as "closed (1006)" in the
// page, so the cause is asked again over plain HTTPS (D71). Node 6: ES2015 only.
'use strict';
const withTimeout = require('./timing').withTimeout, lines = require('./lines');

// Jibo's line for each cause is in lib/lines.js (cause() adds it in the conversation's language).
// screen: show the setup screen with the QR code to the settings page (lib/setup-screen.js).
const CAUSES = {
    no_key: {emoji: 'Emoji_Brain', screen: true,
        title: 'Give me a brain', detail: 'No OpenAI API key is saved yet.', step: 'Paste your OpenAI API key on the Brain tab'},
    key_refused: {emoji: 'Emoji_Lock', screen: true,
        title: 'My key doesn\'t work', detail: 'OpenAI refused the saved API key.', step: 'Paste a working OpenAI API key on the Brain tab'},
    settings: {emoji: 'Emoji_Tools', screen: true,
        title: 'Check my settings', detail: 'A setting is wrong.', step: 'Check the models and address on the Brain tab'},
    no_credit: {emoji: 'Emoji_Money'},
    no_internet: {emoji: 'Emoji_StormCloud'},
    openai_down: {emoji: 'Emoji_Clouds'},
    rate_limited: {emoji: 'Emoji_Clock'},
    permission: {emoji: 'Emoji_Lock'},
    // An API address on the home network needs a permission Noggin does not ask for (D154).
    permission_network: {emoji: 'Emoji_Lock'},
    unknown: {emoji: null}
};
const BUDGET_EMOJI = 'Emoji_Money';
const CHECK_MS = 6000;           // the whole check (D71)
const REQUEST_MS = 5000;
// No DNS or no route: the internet, not OpenAI.
const NO_NETWORK = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN'];

// The cause with Jibo's line in `language` (English by default). The setup screen's texts stay English.
function cause(name, language) {
    if (!Object.prototype.hasOwnProperty.call(CAUSES, name)) name = 'unknown';
    return Object.assign({cause: name}, CAUSES[name], {line: lines.say('trouble.' + name, language)});
}

// An OpenAI error code (realtime event, response.done, HTTP body) -> cause name, or null.
function fromCode(code) {
    code = String(code || '');
    if (/^(insufficient_quota|billing_hard_limit_reached|billing_not_active)$/.test(code)) return 'no_credit';
    if (/^(invalid_api_key|incorrect_api_key|account_deactivated)$/.test(code)) return 'key_refused';
    if (code === 'rate_limit_exceeded') return 'rate_limited';
    if (/^(model_not_found|invalid_model)$/.test(code)) return 'settings';
    return null;
}
// "OpenAI: insufficient_quota" (lib/openai.js, lib/controller.js) or a refused permission -> cause name, or null.
function fromMessage(message) {
    const found = /^OpenAI: ([a-z_]+)$/.exec(String(message || ''));
    if (found) return fromCode(found[1]);
    // BEam's refusal of a call the manifest did not declare (D152).
    const refused = /\bneeds the ([a-z-]+) permission\b/.exec(String(message || ''));
    if (!refused) return null;
    return refused[1] === 'local-network' ? 'permission_network' : 'permission';
}
function fromStatus(r) {
    const known = fromCode(r.json && r.json.error && r.json.error.code) || fromCode(r.json && r.json.error && r.json.error.type);
    if (known) return known;
    if (r.status === 401 || r.status === 403) return 'key_refused';
    if (r.status === 400 || r.status === 404) return 'settings';
    if (r.status === 429) return 'rate_limited';
    if (r.status >= 500) return 'openai_down';
    return null;
}
function fromError(error) { return error && NO_NETWORK.indexOf(error.code) >= 0 ? 'no_internet' : 'openai_down'; }

// Jibo's LAN address: the first non-internal IPv4, Wi-Fi first. interfaces: os.networkInterfaces().
function lanAddress(interfaces) {
    const names = Object.keys(interfaces || {}).sort((a, b) => rank(a) - rank(b));
    for (let i = 0; i < names.length; i++) {
        const found = (interfaces[names[i]] || []).filter(a => a && (a.family === 'IPv4' || a.family === 4) && !a.internal && a.address)[0];
        if (found) return found.address;
    }
    return null;
}
// Wi-Fi first, then wired, then anything else.
function rank(name) {
    if (/^wlan/.test(name)) return 0;
    return /^(eth|en)/.test(name) ? 1 : 2;
}
function interfaces() { try { return require('os').networkInterfaces(); } catch (_) { return null; } }

// What went wrong, after a failed or lost connection: resolves {cause, detail}, never rejects.
// ask(method, route, body, timeoutMs, track) -> {status, json} (lib/openai.js ask). options.interfaces
// (for tests) replaces os.networkInterfaces(); options.stopped() ends early when the skill closed.
function diagnose(config, ask, options) {
    options = options || {};
    const aborts = [];
    const track = abort => aborts.push(abort);
    const nets = options.interfaces !== undefined ? options.interfaces : interfaces();
    // No address at all: Wi-Fi is down, no request needed.
    if (nets && !lanAddress(nets)) return Promise.resolve({cause: 'no_internet', detail: 'no network address'});
    const failed = error => ({cause: fromError(error), detail: String(error && (error.code || error.message) || error).slice(0, 80)});
    const checks = Promise.resolve().then(() => ask('GET', '/models/' + encodeURIComponent(config.realtimeModel), null, REQUEST_MS, track)).then(r => {
        if (r.status !== 200) return {cause: fromStatus(r) || 'unknown', detail: 'models ' + r.status};
        if (options.stopped && options.stopped()) return {cause: 'unknown', detail: 'stopped'};
        // Free checks pass: one tiny request shows credit and rate limits (D71).
        return ask('POST', '/responses', {model: config.helperModel, input: 'Say ok.', max_output_tokens: 16, store: false}, REQUEST_MS, track)
            // A plain 400 may be this probe's own fault: no blame on the settings then.
            .then(p => ({cause: p.status === 200 || p.status === 400 && !fromCode(p.json && p.json.error && p.json.error.code) ? 'unknown' : fromStatus(p) || 'unknown',
                detail: 'responses ' + p.status}));
    }).catch(failed);
    const late = () => ({cause: 'openai_down', detail: 'no answer in time'});
    return withTimeout(checks, options.timeoutMs || CHECK_MS, late).then(result => {
        aborts.forEach(abort => { try { abort('done'); } catch (_) {} });
        return result;
    });
}

module.exports = {CAUSES, BUDGET_EMOJI, cause, fromCode, fromMessage, fromStatus, fromError, lanAddress, interfaces, diagnose};
