// SPDX-License-Identifier: MIT
// Noggin: plays an expression next to Jibo's speech instead of inside it, through
// Jibo's animation database (jibo.animDB: getAnimByName -> createFromConfig -> play).
//
// - The animation's LED channels are taken out (dofs ALL minus LED), so it can never turn
//   Noggin's ring off, and the ring refresh can't get it rejected.
// - It plays under animDB's own owner name. A body part that speech already holds rejects
//   the whole animation, and the other way round, so the result (STOPPED, CANCELLED,
//   REJECTED) is logged.
// - Animations that don't end in Jibo's neutral pose are centred afterwards, without the
//   LED and without the base and eye position (as animDB's own return to idle, minus LED).
//
// Each animation is logged once, when it ends: name, load/start/end ms since Noggin opened,
// result. Text only. Node 6 / Chrome 53: ES2015 only.
'use strict';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// A platform call that never answers must not leave Noggin "busy" for good: loading may take
// LOAD_MS, playing the animation's own length plus SLACK_MS. Then it counts as done
// (load_timeout / play_timeout in the log) and is stopped if it ever starts
// (ExpressionPlayer.LOAD_MS, ExpressionPlayer.SLACK_MS).

const FPS = 30;
// The frames to ask for, or 0 when the animation has no hold frame or is long enough already.
function holdFrames(meta, holdMs) {
    if (!meta || !(holdMs > 0) || typeof meta.holdSafeKF !== 'number' || meta.holdSafeKF < 0) return 0;
    const wanted = Math.round(holdMs / 1000 * FPS);
    return typeof meta.duration === 'number' && wanted > meta.duration ? wanted : 0;
}

function bodyLayer(meta) {
    const layers = meta && meta.layers;
    return layers && typeof layers === 'object' ? !!layers.Body : null;
}

class ExpressionPlayer {
    // jibo; log {write}; now() in ms; since(t) -> ms since Noggin opened; allowed() -> may play now.
    constructor(jibo, log, now, since, allowed) {
        this.jibo = jibo; this.log = log || {write() {}}; this.now = now || (() => Date.now());
        this.since = since || (t => t); this.allowed = allowed || (() => true);
        this.current = null;
    }
    // Starts `name` and returns at once: {started: Promise<boolean>, done: Promise<result>}.
    // started is true when Jibo began playing it, false when it never will (missing, failed,
    // stopped first). Never throws.
    play(name, info) {
        info = info || {};
        const jibo = this.jibo, animDB = jibo.animDB, entry = {name: name, info: info, asked: this.now()};
        let startedResolve, doneResolve, playingResolve;
        entry.started = new Promise(resolve => { startedResolve = resolve; });
        // playing: true once handed to the body (its parts are claimed then), false if never.
        entry.playing = new Promise(resolve => { playingResolve = resolve; });
        entry.done = new Promise(resolve => { doneResolve = resolve; });
        let settled = false, watchdog = null;
        const finish = (result, extra) => {
            if (settled) return;
            settled = true; clearTimeout(watchdog);
            startedResolve(entry.startAt !== undefined);
            playingResolve(false);
            if (this.current === entry) this.current = null;
            this.write(entry, result, extra);
            doneResolve(result);
        };
        const handle = {name: name, started: entry.started, playing: entry.playing, done: entry.done, body: null};
        if (!this.allowed()) { finish('not_allowed'); return handle; }
        let asset = null;
        try { asset = animDB && typeof animDB.getAnimByName === 'function' ? animDB.getAnimByName(name) : null; } catch (_) {}
        if (!asset || typeof asset.createFromConfig !== 'function') { finish('missing'); return handle; }
        // Whether the clip moves the body (null: unknown); such clips start late (D80).
        entry.body = handle.body = bodyLayer(asset.meta);
        // One at a time: the newest replaces the one still playing (that one is not centred).
        this.stopCurrent('replaced');
        this.current = entry;
        // A named loader cache is required: without one the load never finishes on the robot
        // (BEam's Agent Mode thinking eye says so; its music dance uses the active cache, as here).
        const config = {cache: (jibo.loader && jibo.loader.activeCache) || 'global'}, dofs = jibo.expression && jibo.expression.dofs;
        // info.keepLed (the lab): the animation as it is, to tell a dofs problem from a loading one.
        try { if (!info.keepLed && dofs && dofs.ALL && dofs.LED && typeof dofs.ALL.minus === 'function') config.dofs = dofs.ALL.minus(dofs.LED); } catch (_) {}
        entry.ledStripped = !!config.dofs;
        entry.endsNeutral = !(asset.meta && asset.meta.endsNeutral === false);
        let frames = asset.meta && typeof asset.meta.duration === 'number' ? asset.meta.duration : 150;
        // info.holdMs: stretch an animation that has a hold frame (an emoji) to this long; AnimDB
        // holds it there, so the picture stays on the eye instead of the clip running faster.
        const hold = holdFrames(asset.meta, info.holdMs);
        if (hold) { config.duration = hold; frames = hold; entry.heldFrames = hold; }
        watchdog = setTimeout(() => { entry.cancel = 'load_timeout'; finish('load_timeout'); }, ExpressionPlayer.LOAD_MS);
        Promise.resolve().then(() => asset.createFromConfig(config)).then(playback => {
            entry.loadedAt = this.now();
            if (!playback) return finish('failed', {error: 'no playback'});
            entry.playback = playback;
            // Loaded after it timed out (or was replaced): never play it.
            if (settled) return Promise.resolve().then(() => playback.stop()).catch(() => {});
            clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                entry.cancel = 'play_timeout';
                Promise.resolve().then(() => playback.stop()).catch(() => {});
                finish('play_timeout');
            }, Math.round(frames / FPS * 1000) + ExpressionPlayer.SLACK_MS);
            // Stopped (or Noggin closed) while it was loading: never play it.
            if (entry.cancel) return finish(entry.cancel);
            const events = playback.instance && playback.instance.events;
            const started = events && events.started;
            if (started && typeof started.on === 'function') {
                const onStart = () => {
                    if (entry.startAt === undefined) { entry.startAt = this.now(); startedResolve(true); }
                    try { (started.off || started.removeListener || (() => {})).call(started, onStart); } catch (_) {}
                };
                started.on(onStart);
            }
            const playing = playback.play({screenCenterOverride: true});
            playingResolve(true);
            return Promise.resolve(playing).then(result => {
                // Without a `started` event, a clip that played still counts as started.
                if (entry.startAt === undefined && result !== 'REJECTED' && result !== 'CANCELLED') entry.startAt = entry.loadedAt;
                const state = String(result || 'STOPPED');
                if (entry.cancel || state === 'REJECTED' || entry.endsNeutral) return finish(entry.cancel || state);
                return this.centre().then(centred => finish(state, {centred: centred}));
            });
        }).catch(error => finish('failed', {error: String(error && error.message || error).slice(0, 200)}));
        return handle;
    }
    // Back to neutral, except the base, the eye position and the LED.
    centre() {
        const expression = this.jibo.expression, dofs = expression && expression.dofs;
        if (!dofs || typeof expression.centerRobot !== 'function' || !this.allowed()) return Promise.resolve(false);
        let set;
        try { set = dofs.ALL.minus(dofs.BASE).minus(dofs.EYE_TRANSLATE).minus(dofs.LED); } catch (_) { return Promise.resolve(false); }
        return Promise.race([Promise.resolve().then(() => expression.centerRobot({requestor: 'AnimDB', dofs: set, centerGlobally: false})).then(() => true, () => false),
            delay(2000).then(() => 'timeout')]);
    }
    stopCurrent(reason) {
        const entry = this.current;
        this.current = null;
        if (!entry) return Promise.resolve();
        entry.cancel = reason || 'stopped';
        // A clip still loading is skipped when it arrives (stopping it now would never settle).
        if (!entry.playback) return Promise.resolve();
        return Promise.race([Promise.resolve().then(() => entry.playback.stop()).catch(() => {}), delay(1500)]);
    }
    // Resolves when nothing Noggin started is playing any more.
    idle() { return this.current ? this.current.done.then(() => this.idle()) : Promise.resolve(); }
    busy() { return !!this.current; }
    write(entry, result, extra) {
        const info = entry.info, at = t => t === undefined ? null : Math.round(this.since(t));
        this.log.write(Object.assign({kind: 'anim', via: info.via || null, turn: info.turn === undefined ? null : info.turn,
            line: info.line === undefined ? null : info.line, name: entry.name, result: result,
            asked: at(entry.asked), loaded: at(entry.loadedAt), start: at(entry.startAt), end: at(this.now()),
            ledStripped: entry.ledStripped === undefined ? null : entry.ledStripped, held: entry.heldFrames || undefined,
            body: entry.body === undefined ? null : entry.body, eye: info.eye || undefined}, extra || {}));
    }
    // Whether `name` moves the body: true, false, or null when unknown (no such animation, no layers).
    moves(name) {
        const animDB = this.jibo.animDB;
        try { return bodyLayer(animDB && typeof animDB.getAnimByName === 'function' && (animDB.getAnimByName(name) || {}).meta); } catch (_) { return null; }
    }
}
// What plays on Jibo's eye, from the eye's own events: any animation that shows on the screen
// raises addAnimation when it starts and removeAnimation when it ends (no name). free(maxMs)
// resolves 'free' at once or when the eye is free again, 'timeout' after maxMs, 'unknown'
// without the events (D99). stop() removes the listeners.
function watchEye(eye) {
    let busy = false;
    const waiting = [];
    const add = () => { busy = true; };
    const remove = () => { busy = false; waiting.splice(0).forEach(done => done('free')); };
    const on = !!(eye && typeof eye.on === 'function');
    if (on) { eye.on('addAnimation', add); eye.on('removeAnimation', remove); }
    return {
        busy: () => busy,
        free(maxMs) {
            if (!on) return Promise.resolve('unknown');
            if (!busy) return Promise.resolve('free');
            return new Promise(resolve => {
                let timer = null;
                const done = how => { clearTimeout(timer); const i = waiting.indexOf(done); if (i >= 0) waiting.splice(i, 1); resolve(how); };
                timer = setTimeout(() => done('timeout'), maxMs);
                waiting.push(done);
            });
        },
        stop() {
            if (on) { try { const off = (eye.off || eye.removeListener).bind(eye); off('addAnimation', add); off('removeAnimation', remove); } catch (_) {} }
            waiting.splice(0).forEach(done => done('stopped'));
        }
    };
}
ExpressionPlayer.LOAD_MS = 3000;
ExpressionPlayer.SLACK_MS = 3000;
ExpressionPlayer.watchEye = watchEye;
module.exports = ExpressionPlayer;
