// SPDX-License-Identifier: MIT
// "Hey Jibo" opens Noggin (setting heyJibo, off by default, D132). Runs in background.js: when
// Jibo hears the hotword while he is idle, Noggin opens and, shortly after, the cloud turn that
// "Hey Jibo" started is cancelled, so its result cannot switch Noggin away. The conversation then ignores that turn's
// start once (lib/controller.js).
// Until Noggin is open the ring stays orange, as while the conversation is busy (D135).
// Node 6: ES2015 only.
'use strict';
const REASON = 'hey_jibo';
// The cloud turn starts once its connection is up, after hjHeard (D132).
const TURN_MS = 10000;
// Orange (busy) and off as Jibo's idle ring. Re-sent, since the end of Jibo's own listening switches
// the ring off; given up after RING_MAX_MS (D135).
const BUSY = require('./ring').BUSY, OFF = require('./ring').OFF;
const RING_MS = 400, RING_MAX_MS = 10000;
// Jibo's own "Hey Jibo" action (turning toward the voice) holds Noggin's switch until it sees the
// turn end. Opening Noggin restarts it about 150 ms later; a cancel before that restart is missed
// and the action waits out its face search (4 s). Cancelling this long after the open lands while
// the restarted action listens and long before its turn is done (D136).
const CANCEL_DELAY_MS = 600;
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
// options: {enabled() -> bool (read at every "Hey Jibo"), log, now(), clock: {setTimeout, clearTimeout}}.
// Returns {stop()}.
function watch(jibo, api, options) {
    const log = options.log, now = options.now || Date.now;
    // Wrapped: a stored timer function called as a method throws in Be's page.
    const clock = options.clock || {setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id)};
    const js = jetstream(jibo), events = js && js.events || {};
    let stopped = false, ringTimer = null, cancelTimer = null, startedEarly = false;
    const idle = () => typeof api.isIdle === 'function' && api.isIdle();
    const isPrivate = () => !!(jibo.privacyController && jibo.privacyController.enabled);
    const ring = color => {
        try { if (!isPrivate() && jibo.expression && jibo.expression.setLEDColor) jibo.expression.setLEDColor(color); } catch (_) {}
    };
    const stopRing = () => { if (ringTimer !== null) { clock.clearTimeout(ringTimer); ringTimer = null; } };
    const stopCancel = () => { if (cancelTimer !== null) { clock.clearTimeout(cancelTimer); cancelTimer = null; } };
    // Jibo repaints the ring when his own turn starts (blue) and when it is cancelled (off): paint
    // orange again at once while the hold is still waiting for Noggin, not up to RING_MS later.
    const repaint = () => { if (ringTimer !== null && !api.isOpen() && idle()) ring(BUSY); };
    // Orange from the hotword until Noggin's screen is up; the conversation owns the ring from there.
    // Be marks Noggin current before Noggin's code runs, so the hold keeps watching until RING_MAX_MS:
    // back on idle without Noggin (the open failed, or it ended early) gives idle's ring back.
    // Another skill that won the switch owns the ring and is left alone (D137).
    const holdRing = since => {
        stopRing();
        let seenOpen = false;
        const step = () => {
            ringTimer = null;
            if (stopped) return;
            if (api.isOpen()) seenOpen = true;
            else if (!idle()) return;
            else if (seenOpen) { ring(OFF); return; }
            if (now() - since >= RING_MAX_MS) {
                if (!seenOpen) { ring(OFF); log.warn('hey jibo: Noggin did not open within ' + RING_MAX_MS + ' ms'); }
                return;
            }
            if (!seenOpen) ring(BUSY);
            ringTimer = clock.setTimeout(step, RING_MS);
        };
        step();
    };
    const onHotword = () => {
        if (stopped) return;
        let on = false;
        try { on = !!options.enabled(); } catch (error) { log.warn('hey jibo: settings unreadable: ' + error.message); }
        // ringTimer: an earlier "Hey Jibo" is still opening Noggin.
        if (!on || ringTimer !== null || api.isOpen() || !idle() || isPrivate()) return;
        const at = now();
        // Orange first: on the first open after an install or a reboot, BEam loads Noggin inside
        // api.open() and nothing else runs until it returns (D139).
        ring(BUSY);
        let opened = false;
        try { opened = api.open({reason: REASON, heardAt: at}); } catch (error) { log.warn('hey jibo: open threw: ' + (error && error.message)); }
        if (!opened) { ring(OFF); log.warn('hey jibo: Noggin did not open'); return; }
        hub().claimedAt = at;
        holdRing(at);
        log.info('hey jibo: opening Noggin');
        stopCancel();
        startedEarly = false;
        cancelTimer = clock.setTimeout(() => {
            cancelTimer = null;
            if (stopped) return;
            const cancelled = cancelTurn(jibo);
            repaint();
            log.info('hey jibo: turn ' + (cancelled ? 'cancelled' : 'not cancelled') + ' after ' + (now() - at) + ' ms');
            // The turn that started during the delay was the one just cancelled: the claim is done.
            if (startedEarly) release();
        }, CANCEL_DELAY_MS);
    };
    // During the delay a starting turn is the hotword's, left to the delayed cancel. After it, a
    // turn that starts only now was not running for that cancel (Jibo ignored it): cancel again.
    // A turn result ends the claim.
    const onTurnStarted = () => {
        const at = hub().claimedAt;
        if (stopped || at === null) return;
        repaint();
        if (cancelTimer !== null) { startedEarly = true; return; }
        release();
        const age = now() - at;
        if (age >= TURN_MS) return;
        const cancelled = cancelTurn(jibo);
        log.info('hey jibo: its cloud turn ' + (cancelled ? 'cancelled' : 'could not be cancelled') + ' after ' + age + ' ms');
    };
    const onTurnResult = () => { if (!stopped) { stopCancel(); release(); } };
    const undo = [subscribe(events.hjHeard, onHotword), subscribe(events.globalTurnStarted, onTurnStarted),
        subscribe(events.globalTurnResult, onTurnResult)].filter(Boolean);
    if (!events.hjHeard) log.warn('hey jibo: no hotword event in this runtime');
    return {stop: () => {
        // Stopped while holding orange (an update): leave the ring as idle has it.
        if (ringTimer !== null && !api.isOpen() && idle()) ring(OFF);
        stopped = true; stopRing(); stopCancel(); release(); undo.forEach(fn => fn());
    }};
}

module.exports = {watch, fromResult, ownTurn, release, TURN_MS};
