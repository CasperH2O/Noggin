// SPDX-License-Identifier: MIT
// Noggin: what Jibo feels and sees during a conversation, mixed into Conversation
// (lib/controller.js). A touch on his head plays his own petting animation (D144): at once
// while he listens or thinks, after the current line while he speaks; the microphone is closed
// while it plays, since it moves and makes sounds. Whom he recognises by face comes from
// lib/presence.js (D145). Both reach the model as bracketed system notes, without a reply.
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const touch = require('./touch'), realtime = require('./realtime-session'), Presence = require('./presence');
const delay = require('./timing').delay;

// After a petting clip, touches only count for the note this long (Jibo's idle skill: 1 s).
const PET_GAP_MS = 1000;
// A touch that could not play yet is dropped after this long.
const PET_STALE_MS = 10000;
// The microphone stays closed, and a line or the dance waits, at most this long for a petting
// clip (the longest is ~5.4 s).
const PET_HOLD_MAX_MS = 8000, PET_WAIT_MS = 8000;
// Holding the head this long still ends Noggin; petting strokes are shorter (Jibo's own: 1 s, D144).
const HOLD_TO_QUIT_MS = 3000;
// Whom Jibo sees is read this often, and told at most once per PRESENCE_NOTE_MS.
const LOOK_MS = 1000, PRESENCE_NOTE_MS = 10000;

const methods = {
    // From open(): touches, the hold to quit, and whom Jibo sees (when the setting allows it).
    watchSenses() {
        const jibo = this.jibo, events = jibo.system && jibo.system.events;
        // touchOn, never the global touchStop: only the last listener hears that one, and the
        // action system's hold to quit is that listener (D144).
        // Guarded: the action system's hold to quit runs after this listener on the same event.
        this.watch(events && events.touchOn, pads => {
            try { this.pet(pads); } catch (error) { this.log.write({kind: 'exception', where: 'touch', error: String(error && error.stack || error).slice(0, 300)}); }
        });
        const action = jibo.action;
        if (action && typeof action.setHoldHeadToQuitDuration === 'function' && typeof action.resetHoldToQuitTime === 'function') {
            try { action.setHoldHeadToQuitDuration(HOLD_TO_QUIT_MS); this.holdToQuitSet = true; } catch (_) {}
        }
        if (this.config.presence !== false) {
            this.presence = new Presence(jibo, this.now);
            this.lookAround();
            this.lookTimer = setInterval(() => this.lookAround(), LOOK_MS);
        }
    },
    // From close(): Jibo's own hold to quit again, no more looking.
    stopSenses() {
        clearInterval(this.lookTimer); this.lookTimer = null;
        this.pendingPet = null;
        if (!this.holdToQuitSet) return;
        this.holdToQuitSet = false;
        try { this.jibo.action.resetHoldToQuitTime(); } catch (_) {}
    },
    // A touch on Jibo's head: pads is the touch service's pad_state.
    pet(pads) {
        if (!this.active || this.isPrivate()) return;
        const side = touch.side(pads);
        if (!side) return;
        const touches = this.touches = this.touches || {pets: 0, tickles: 0};
        if (side === 'tickle') touches.tickles++; else touches.pets++;
        // The person is there: the silence timer starts again.
        if (this.state === 'listening' && this.silence) this.armSilence();
        // During a petting clip and just after it touches are only counted; the next clip's end (or
        // the next skipped touch) tells the model about all of them.
        if (this.pendingPet || this.petting || this.now() - (this.petEndedAt || -Infinity) < PET_GAP_MS) return;
        if (this.dancing || !/^(starting|listening|thinking|speaking|acting)$/.test(this.state)) {
            this.log.write({kind: 'touch', side: side, state: this.state, result: this.dancing ? 'dancing' : 'skipped'});
            return this.noteTouches();
        }
        this.pendingPet = {pads: pads, side: side, at: this.now(), state: this.state};
        this.playPendingPet('touch');
    },
    // The touches counted so far go to the model with the next note sent (they keep counting until then).
    noteTouches() {
        if (!this.touches) return;
        this.touchesDue = true;
        this.sendNotes();
    },
    // The touch's clip, when Jibo's body is free for it: not during a line or the dance, and not
    // while the person is talking. Called on the touch, at each line's end, when listening starts
    // and when the person's turn ends. Resolves when the clip is done (at once when it waits).
    playPendingPet(where) {
        const pet = this.pendingPet;
        if (!pet || !this.active) return Promise.resolve();
        if (this.now() - pet.at > PET_STALE_MS) {
            this.pendingPet = null;
            this.log.write({kind: 'touch', side: pet.side, state: pet.state, result: 'stale'});
            this.noteTouches();
            return Promise.resolve();
        }
        const free = !this.speaking && !this.dancing && (this.state === 'thinking' || this.state === 'speaking' || (this.state === 'listening' && !this.personTalking));
        if (!free) return Promise.resolve();
        this.pendingPet = null;
        const clip = touch.clipFor(this.jibo, pet.pads, this.random);
        if (this.state === 'thinking') this.thinking.stop();
        // Counts as an expression: the next mood waits the usual gap after it.
        this.policy.used('pet', this.now());
        const startedAt = this.now(), state = this.state;
        const played = this.petting = this.player.play(clip.name, {via: 'pet', keep: true});
        // Its motors and sounds are noise to the microphone, with the echo tail after them.
        this.holdMic(played.done.then(() => delay(this.config.echoTailMs || 0)), {maxMs: this.petHoldMaxMs || PET_HOLD_MAX_MS, fresh: true});
        return played.done.then(result => {
            if (this.petting === played) this.petting = null;
            this.petEndedAt = this.now();
            this.log.write({kind: 'touch', side: pet.side, state: pet.state, at: where, played_in: state, clip: clip.name, query: clip.query,
                result: result, waited: startedAt - pet.at, ms: this.now() - startedAt});
            if (this.active) this.noteTouches();
            return result;
        });
    },
    // A new realtime session (a reconnect) has not heard who Jibo sees: tell it again.
    forgetSeen() { this.seenKey = undefined; this.seenNoteAt = null; },
    // Resolves when the petting clip playing (if any) has ended, at most PET_WAIT_MS. (Tests
    // shorten this and the hold with petWaitMs and petHoldMaxMs.)
    petDone() {
        return this.petting ? Promise.race([this.petting.done, delay(this.petWaitMs || PET_WAIT_MS)]).then(() => {}) : Promise.resolve();
    },
    // Read whom Jibo sees; when that changed, tell the model (at most once per PRESENCE_NOTE_MS).
    lookAround() {
        if (!this.active || !this.presence || this.isPrivate()) return;
        this.presence.look();
        const here = this.presence.here(), key = JSON.stringify(here), now = this.now();
        if (key === this.seenKey) return;
        // Nobody there at the start: nothing to say.
        if (this.seenKey === undefined && !here.names.length && !here.unknown) { this.seenKey = key; return; }
        if (now - (this.seenNoteAt || -Infinity) < PRESENCE_NOTE_MS) return;
        this.seenKey = key; this.seenNoteAt = now;
        this.log.write({kind: 'presence', names: here.names, unknown: here.unknown});
        this.note('presence', realtime.presenceNote(here));
    },
    // A system note for the model, by kind (a newer one of the same kind replaces it). Notes are sent
    // while Jibo listens with no turn going on, otherwise when he listens again.
    note(kind, text) {
        if (!text) return;
        this.notes = this.notes || {};
        this.notes[kind] = text;
        this.sendNotes();
    },
    sendNotes() {
        if (!this.active || !this.rt || this.state !== 'listening' || this.turn || this.reconnecting) return;
        const notes = this.notes || {};
        if (this.touchesDue && this.touches) notes.touch = realtime.touchNote(this.touches);
        this.notes = null; this.touchesDue = false;
        if (notes.touch) this.touches = null;
        Object.keys(notes).forEach(kind => {
            this.rt.send(realtime.systemItem(notes[kind]));
            this.log.write({kind: 'note', about: kind, text: notes[kind]});
        });
    }
};
module.exports = methods;
