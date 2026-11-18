// SPDX-License-Identifier: MIT
// After Noggin hands an action to another skill (@be/clock), come back to Noggin once that
// skill is done: Jibo is back on @be/idle and quiet. Meanwhile, record what Jibo says,
// so the conversation can carry on from it.
//
// Adapted from BEam's Agent Mode, @be/be skills/agent/comeback.js (BSD-3-Clause,
// Copyright (c) 2026, Zane V): the polling watcher, the speech recording and the relaunch.
// Added here: no relaunch while privacy is on, an own-skill name, and a reason on giving up.
// Keep the 1.5 s of quiet: with 0.8 s, Noggin came back while Jibo's speech was still waiting
// for an earlier listen to finish, and its first line was 3.5 s late.
// Node 6 / Chrome 53: ES2015 only.
'use strict';

const TIMEOUT_MS = 180000, QUIET_MS = 1500, POLL_MS = 250, IDLE = '@be/idle';

// ESML ("<speak><anim .../> it's 3:15 . </speak>") -> plain words.
function plain(esml) {
    const text = esml && typeof esml === 'object' ? esml.esml || esml.text || '' : esml;
    return String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').trim();
}

// Calls back(said) once Jibo has left `own` for another skill, is back on @be/idle and has
// been quiet for QUIET_MS. Gives up (onGiveUp(reason)) on "Hey Jibo" once he is back on
// idle (a new request), after `timeoutMs`, if privacy is on, or on cancel(). With `leaveMs`,
// also when no other skill took over within that time ('never_left'): after a cloud request
// Noggin has already ended, and an answer that never came must not let a later skill bring
// Noggin back.
function watch(jibo, be, back, options) {
    options = options || {};
    const own = options.own, clock = options.clock || {setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: id => clearInterval(id), now: () => Date.now()};
    const timeoutMs = options.timeoutMs || TIMEOUT_MS, quietMs = options.quietMs || QUIET_MS, giveUp = options.onGiveUp || (() => {}), leaveMs = options.leaveMs || 0;
    const said = [], start = clock.now(), restore = [];
    let left = false, quietSince = null, done = false, lastKey = null;
    // Record both speech paths; skip a line the other path just recorded.
    function record(target, key) {
        if (!target || typeof target[key] !== 'function') return;
        const original = target[key];
        const wrapped = function (text) {
            // The same line often passes both paths (embodied speech hands it to tts), with
            // different case, punctuation or spacing ("7:30 AM" / "7: 30AM"): keep it once.
            const line = plain(text), key = line.toLowerCase().replace(/[^a-z0-9]+/g, '');
            if (line && key !== lastKey) said.push(line);
            if (line) lastKey = key;
            return original.apply(this, arguments);
        };
        target[key] = wrapped;
        restore.push(() => { if (target[key] === wrapped) target[key] = original; });
    }
    record(jibo.tts, 'speak');
    record(jibo.embodied && jibo.embodied.speech, 'speak');
    // The action's own listening fires hjHeard while it runs; only a "Hey Jibo" after Jibo is back on idle is a new request.
    const hotword = jibo.jetstream && jibo.jetstream.events && jibo.jetstream.events.hjHeard;
    const onHotword = () => { if (quietSince !== null) finish(false, 'hotword'); };
    if (hotword && hotword.on) hotword.on(onHotword);
    const talking = () => !!(jibo.tts && jibo.tts.isTalking);
    const timer = clock.setInterval(() => {
        const current = be && be.currentSkill, skill = current && current.assetPack;
        if (skill && skill !== IDLE && skill !== own) left = true;
        if (clock.now() - start > timeoutMs) return finish(false, 'timeout');
        if (!left && leaveMs && clock.now() - start > leaveMs) return finish(false, 'never_left');
        if (!left || skill !== IDLE || talking()) { quietSince = null; return; }
        if (quietSince === null) quietSince = clock.now();
        else if (clock.now() - quietSince >= quietMs) {
            if (jibo.privacyController && jibo.privacyController.enabled) finish(false, 'privacy');
            else finish(true);
        }
    }, options.pollMs || POLL_MS);
    function finish(ok, reason) {
        if (done) return; done = true;
        clock.clearInterval(timer);
        restore.forEach(undo => undo());
        if (hotword) { if (hotword.off) hotword.off(onHotword); else if (hotword.removeListener) hotword.removeListener(onHotword); }
        if (ok) back(said.join(' ').slice(0, 2000));
        else giveUp(reason || 'cancelled', clock.now() - start);
    }
    return {cancel: () => finish(false, 'cancelled')};
}

// Open `skillID` again the way BEam's Agent Mode comes back: a skill relaunch, which Be turns
// into a redirect to that skill. skipSurprises: no "element of surprise" after it.
function relaunch(jibo, skillID) {
    const result = {asr: {text: '', confidence: 1}, nlu: {intent: 'talk_resume', entities: {}}, match: {skillID: skillID, onRobot: true, skipSurprises: true}};
    const events = jibo.globalEvents;
    if (events && typeof events.onSkillRelaunch === 'function') { events.onSkillRelaunch({result: result}); return true; }
    if (events && events.skillRelaunch && typeof events.skillRelaunch.emit === 'function') { events.skillRelaunch.emit(result); return true; }
    return false;
}

module.exports = {watch, relaunch, plain};
