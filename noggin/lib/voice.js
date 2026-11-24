// SPDX-License-Identifier: MIT
// Noggin: Dutch lines through the Dutch Voice skill (D169). Dutch Voice is a separate store skill
// that runs a Dutch voice next to Jibo's English one and publishes global.dutchVoiceService; it is
// looked up at every call and never required. A Dutch line is Noggin's usual speech call, wrapped
// in the service's speak(), which sends Jibo's speech to the Dutch voice for that one call, so
// eyes and body follow the Dutch words. No jibo here. Node 6 / Chrome 53: ES2015 only.
'use strict';

const SERVICE = 'dutchVoiceService';
const API_VERSION = 1;
// A Dutch Voice that holds a call without speaking or answering: Noggin gives up this much after
// the call's own limit, so its speech chain never waits forever.
const OWN_LIMIT_EXTRA_MS = 3000;
// Why the Dutch voice did not say a line, as opposed to the line being stopped or running late.
const REFUSED = /^dutch_voice_(missing|api_version|no_dutch|not_ready|busy|no_speech_client|timings_|speak_)|^http_/;
function refused(error) { return REFUSED.test(String(error && error.message || error || '')); }

// options: {service() -> the published service or nothing} (for tests).
function create(options) {
    options = options || {};
    const lookup = options.service || (() => global[SERVICE]);

    // {api} when Dutch Voice is there and fits, else {reason}.
    function find() {
        let api = null;
        try { api = lookup(); } catch (_) {}
        if (!api || typeof api !== 'object') return {reason: 'missing'};
        if (api.apiVersion !== API_VERSION || typeof api.speak !== 'function' || typeof api.ready !== 'function') return {reason: 'api_version'};
        if (!Array.isArray(api.languages) || api.languages.indexOf('nl') < 0) return {reason: 'no_dutch'};
        return {api: api};
    }
    function readyNow(api) {
        try { return api.ready() === true; } catch (_) { return false; }
    }
    // For the settings page: {found, ready, version, state, reason}.
    function status() {
        const found = find();
        if (!found.api) return {found: false, ready: false, version: null, state: null, reason: found.reason};
        let state = null;
        try { state = found.api.status(); } catch (_) {}
        return {found: true, ready: readyNow(found.api), version: typeof found.api.version === 'string' ? found.api.version.slice(0, 20) : null,
            state: state && typeof state.state === 'string' ? state.state.slice(0, 20) : null,
            reason: state && typeof state.reason === 'string' ? state.reason.slice(0, 40) : null};
    }
    // The language a conversation starts in: Dutch only when asked for and the voice is ready now.
    // {language, missing: why Dutch is not possible, or null}.
    function choose(wanted) {
        if (wanted !== 'nl') return {language: 'en', missing: null};
        const found = find();
        if (!found.api) return {language: 'en', missing: found.reason};
        return readyNow(found.api) ? {language: 'nl', missing: null} : {language: 'en', missing: 'not_ready'};
    }
    // Runs speakFn (Jibo's own speech call) with the speech sent to the Dutch voice. Rejects
    // without calling it when the voice is missing or not ready ('dutch_voice_missing',
    // 'dutch_voice_not_ready', ...); the caller decides what to say instead.
    function speak(speakFn, limitMs) {
        const found = find();
        if (!found.api) return Promise.reject(Error('dutch_voice_' + found.reason));
        const api = found.api;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true; clearTimeout(timer);
                if (error) reject(error); else resolve(value);
            };
            const timer = setTimeout(() => {
                try { api.cancel(); } catch (_) {}
                finish(Error('dutch_voice_no_answer'));
            }, limitMs + OWN_LIMIT_EXTRA_MS);
            Promise.resolve().then(() => api.speak(speakFn, {limitMs: limitMs})).then(value => finish(null, value), error => finish(error || Error('dutch_voice_failed')));
        });
    }
    // Ends a Dutch line at once (Noggin closes).
    function cancel() {
        const found = find();
        if (found.api && typeof found.api.cancel === 'function') { try { found.api.cancel(); } catch (_) {} }
    }
    return {status: status, choose: choose, speak: speak, cancel: cancel};
}

// A reply's language label at the start of its text (D171): "[nl]" or "[en]". Returns
// {language, length} once known (length: characters to skip), {language: null, length: 0} when
// the reply has no label, or null while the start is still too short to tell.
const LABEL = /^\s*\[(nl|en)\]\s*/i;
const LABELS = ['[nl]', '[en]'];
function readLabel(text) {
    const match = LABEL.exec(text);
    if (match) return {language: match[1].toLowerCase(), length: match[0].length};
    const start = String(text).replace(/^\s+/, '').toLowerCase();
    if (!start) return null;
    // "[", "[n", "[nl" may still become a label.
    const mayBecomeLabel = start.length < 4 && LABELS.some(label => label.indexOf(start) === 0);
    return mayBecomeLabel ? null : {language: null, length: 0};
}

module.exports = {create, readLabel, refused, SERVICE, API_VERSION};
