// SPDX-License-Identifier: MIT
// Asking Jibo's cloud a fixed phrase as if the person had said it after "Hey Jibo", the way
// BEam's main menu opens the weather or a joke: disableOnce() keeps the listening look away for
// that pretend "Hey Jibo". If the pretend turn never comes, release() clears disableOnce again,
// or it would swallow the listening look of the next real "Hey Jibo" (as the main menu does).
//
// Jibo turns his body to where a "Hey Jibo" came from, the pretend one too, and for that one the
// direction is whatever was loudest just before it: often not the person. So turning to "Hey Jibo"
// is off from just before the pretend turn until its direction has come and gone (D85), and always
// back on within ORIENT_MAX_MS. The timers belong to this module, which outlives Noggin's close.
// Node 6: ES2015 only.
'use strict';
const embodiedListen = require('./embodied-listen'), subscribe = require('./events').subscribe;

const SETTLE_MS = 300;       // after the pretend turn's direction arrived
const ORIENT_MAX_MS = 3000;  // back on even if it never arrives

// jibo: the SDK (its Embodied Listen holds the disableOnce flag, lib/embodied-listen.js).
// options: {settleMs, maxMs} (tests).
function create(jibo, options) {
    options = options || {};
    const settleMs = options.settleMs === undefined ? SETTLE_MS : options.settleMs;
    const maxMs = options.maxMs === undefined ? ORIENT_MAX_MS : options.maxMs;
    let held = false, orient = null;
    function hjEvents() {
        const identity = jibo.lps && jibo.lps.identity;
        return identity && identity.events && identity.events.hjEvent || null;
    }
    // Turning to "Hey Jibo" off, unless something else already turned it off (then it is theirs).
    function orientOff(note) {
        const action = jibo.action;
        if (orient || !action || typeof action.configure !== 'function') return;
        if (action.hjGoalProvider && action.hjGoalProvider.listening === false) return;
        try { action.configure({orientToHJ: false}); } catch (_) { return; }
        // heard: the first direction; count and lastMs show whether more events came in the window.
        const state = orient = {note: note, at: Date.now(), off: null, timer: null, heard: null, count: 0, lastMs: null};
        state.timer = setTimeout(() => orientOn('timeout'), maxMs);
        state.off = subscribe(hjEvents(), data => {
            if (orient !== state) return;
            state.count++; state.lastMs = Date.now() - state.at;
            if (state.count > 1) return;
            state.heard = direction(data);
            clearTimeout(state.timer);
            state.timer = setTimeout(() => orientOn('heard'), settleMs);
        });
    }
    function orientOn(why) {
        const state = orient;
        if (!state) return;
        orient = null;
        clearTimeout(state.timer);
        if (state.off) state.off();
        try { jibo.action.configure({orientToHJ: true}); } catch (_) {}
        if (typeof state.note === 'function') {
            const entry = {kind: 'orient_hj', on: why, ms: Date.now() - state.at, events: state.count};
            if (state.count) Object.assign(entry, {heard: state.heard, last_ms: state.lastMs});
            try { state.note(entry); } catch (_) {}
        }
    }
    return {
        // note(entry): optional, gets one `orient_hj` entry once turning to "Hey Jibo" is back on.
        ask(phrase, note) {
            const js = jibo.jetstream, listen = jibo.embodied && jibo.embodied.listen;
            if (!js || typeof js.mimicGlobalTurn !== 'function') return Promise.reject(Error('no mimicGlobalTurn'));
            orientOff(note);
            try { if (listen && typeof listen.disableOnce === 'function') { listen.disableOnce(); held = true; } } catch (_) {}
            return Promise.resolve().then(() => js.mimicGlobalTurn({clientASR: phrase}))
                .catch(error => { orientOn('failed'); throw error; });
        },
        // The cloud's turn came and used disableOnce up.
        used() { held = false; },
        // Clearing an already used disableOnce is harmless, so every give-up path may call this.
        release() {
            orientOn('released');
            if (!held) return;
            held = false;
            embodiedListen.clear(jibo);
        }
    };
}

// Where the pretend "Hey Jibo" was placed: degrees in Jibo's world frame (atan2(y, x)) and confidence.
function direction(data) {
    const primary = data && data.primary, position = primary && primary.position;
    if (!position || typeof position.x !== 'number' || typeof position.y !== 'number') return {};
    return {deg: Math.round(Math.atan2(position.y, position.x) * 180 / Math.PI),
        confidence: typeof primary.confidence === 'number' ? Math.round(primary.confidence * 100) / 100 : null};
}

module.exports = {create};
