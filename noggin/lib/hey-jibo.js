// SPDX-License-Identifier: MIT
// "Hey Jibo" opens Noggin (setting heyJibo, off by default, D132). Runs in background.js: when
// Jibo hears the hotword while he is idle, Noggin opens and the cloud turn that "Hey Jibo" started
// is cancelled, so its result cannot switch Noggin away. The conversation then ignores that turn's
// start once (lib/controller.js).
// Node 6: ES2015 only.
'use strict';
const REASON = 'hey_jibo';
// The cloud turn starts once its connection is up, after hjHeard (D132).
const TURN_MS = 10000;
// The open claim on the hotword's turn, shared by background.js and the skill in Be's one process
// (each loads its own copy of this module): {claimedAt} or claimedAt null.
const HUB = 'nogginHeyJibo';

function hub() {
    const shared = global[HUB];
    if (shared && typeof shared === 'object') return shared;
    return (global[HUB] = {claimedAt: null});
}
// Noggin's own turns (a cloud handover) are never the hotword's: a handover releases first (D132).
function release() { hub().claimedAt = null; }

function jetstream(jibo) { return jibo && jibo.jetstream || null; }
// Ends the global turn in progress; ignored by Jibo when none is running.
function cancelTurn(jibo) {
    const js = jetstream(jibo);
    if (!js || typeof js.cancelAnyTurn !== 'function') return false;
    try { js.cancelAnyTurn(); return true; } catch (_) { return false; }
}
// What opened Noggin, when it was "Hey Jibo": {heardAt} or null. BEam hands the background
// script's data over as result.nlu.entities.
function fromResult(result) {
    const nlu = result && result.nlu, data = nlu && nlu.intent === 'background' ? nlu.entities : null;
    return data && data.reason === REASON && typeof data.heardAt === 'number' ? {heardAt: data.heardAt} : null;
}
// True when a global turn starting at `now` is the one the "Hey Jibo" that opened Noggin started.
function ownTurn(hey, now) {
    if (!hey) return false;
    const age = now - hey.heardAt;
    return age >= 0 && age < TURN_MS;
}

function subscribe(event, handler) {
    if (!event || typeof event.on !== 'function') return null;
    event.on(handler);
    return () => { try { if (event.off) event.off(handler); else event.removeListener(handler); } catch (_) {} };
}

// jibo: Jibo's SDK; api: BEam's background api ({open, isOpen, isIdle}).
// options: {enabled() -> bool (read at every "Hey Jibo"), log, now()}. Returns {stop()}.
function watch(jibo, api, options) {
    const log = options.log, now = options.now || Date.now;
    const js = jetstream(jibo), events = js && js.events || {};
    let stopped = false;
    const idle = () => typeof api.isIdle === 'function' && api.isIdle();
    const isPrivate = () => !!(jibo.privacyController && jibo.privacyController.enabled);
    const onHotword = () => {
        if (stopped) return;
        let on = false;
        try { on = !!options.enabled(); } catch (error) { log.warn('hey jibo: settings unreadable: ' + error.message); }
        if (!on || api.isOpen() || !idle() || isPrivate()) return;
        const at = now();
        if (!api.open({reason: REASON, heardAt: at})) { log.warn('hey jibo: Noggin did not open'); return; }
        hub().claimedAt = at;
        const cancelled = cancelTurn(jibo);
        log.info('hey jibo: opening Noggin, turn ' + (cancelled ? 'cancelled' : 'not cancelled'));
    };
    // The cancel above may come before the turn counts as started (Jibo then ignores it): cancel
    // again when it starts. A turn result means the hotword's turn is over.
    const onTurnStarted = () => {
        const at = hub().claimedAt;
        if (stopped || at === null) return;
        release();
        const age = now() - at;
        if (age >= TURN_MS) return;
        const cancelled = cancelTurn(jibo);
        log.info('hey jibo: its cloud turn ' + (cancelled ? 'cancelled' : 'could not be cancelled') + ' after ' + age + ' ms');
    };
    const onTurnResult = () => { if (!stopped) release(); };
    const undo = [subscribe(events.hjHeard, onHotword), subscribe(events.globalTurnStarted, onTurnStarted),
        subscribe(events.globalTurnResult, onTurnResult)].filter(Boolean);
    if (!events.hjHeard) log.warn('hey jibo: no hotword event in this runtime');
    return {stop: () => { stopped = true; release(); undo.forEach(fn => fn()); }};
}

module.exports = {watch, fromResult, ownTurn, release, TURN_MS};
