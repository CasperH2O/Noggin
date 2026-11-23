// SPDX-License-Identifier: MIT
// Noggin: what Jibo says and the expressions around it, mixed into Conversation
// (lib/controller.js): the reply split into lines, each line's expression (the quick reaction, a
// late label, a clip beside a later line, D99-D104), eye emoji (D98) and the speak itself.
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const catalog = require('./catalog'), ttsText = require('./tts-text'), delay = require('./http').delay;

// A notice's or trouble line's emoji stays on the eye about as long as Jibo says its line.
const EMOJI_MIN_MS = 3000, EMOJI_MAX_MS = 4500, EMOJI_MS_PER_CHAR = 75;
function emojiHoldMs(text) {
    const spoken = String(text || '').length * EMOJI_MS_PER_CHAR;
    return Math.min(EMOJI_MAX_MS, Math.max(EMOJI_MIN_MS, spoken));
}
// A late first-line expression waits at most this long for the eye (the longest blink is ~0.93 s).
const EYE_FREE_MS = 1000;
// A clip beside a line being said is asked again this often while refused, at most this many times (D102).
const BESIDE_RETRY_MS = 150, BESIDE_TRIES = 8;
// Lines are done when their words are; speech's animations finish on their own.
const SPEAK_OPTIONS = {dispatchComplete: 'TTS'};
// The longest a speak may take: the conversation's speakBaseMs plus this per character (D114).
const SPEAK_MS_PER_CHAR = 120;
const RECENT_ANIMS = 5;   // a mood's animation is not repeated within this many expressions
// A hold on the microphone (a reaction that moves the body) never lasts longer than this (D90).
const HOLD_MAX_MS = 3000;

const methods = {
    // An eye emoji for a word in Jibo's line: at most one per emojiGapMs, and not the same word
    // again within the last ten. speak() places it at the word (D98).
    emojiFor(text) {
        if (!this.emojiAllowed()) return null;
        const now = this.now();
        const found = catalog.emojiFor(text, {recent: this.recentEmoji});
        if (!found) return null;
        this.lastEmojiAt = now;
        this.recentEmoji.push(found.word); if (this.recentEmoji.length > 10) this.recentEmoji.shift();
        return found;
    },
    // Whether a line may get an eye emoji now, Noggin's or speech's own keyword emoji (D98).
    emojiAllowed() { return this.config.emoji !== false && this.now() - this.lastEmojiAt >= this.config.emojiGapMs; },
    // The animation for an expression label and size: a random fitting one from the catalogue, not
    // one of the last few. The greeting's smile is fixed; the dance has its own chooser (dance()).
    choose(label, size) {
        if (!label || label === 'none') return null;
        if (!catalog.MOODS[label] || label === 'dance') return catalog.animFor(label);
        const name = catalog.pickAnimation(label, size, {recent: this.recentAnims});
        if (name) { this.recentAnims.push(name); if (this.recentAnims.length > RECENT_ANIMS) this.recentAnims.shift(); }
        return name;
    },
    // A quick expression on hearing the person (Jibo's face reacts before he answers).
    react(turn) {
        const started = this.now();
        turn.reacting = Promise.resolve().then(() => this.classify(turn.transcript, null, 'reaction')).then(result => {
            result = result || {};
            this.noteClassifier(result);
            turn.reaction = {label: result.label === undefined ? null : result.label, confidence: result.confidence === undefined ? null : result.confidence,
                size: result.size || null, ms: this.now() - started, at: this.since(), conn: result.conn || undefined};
            if (turn.firstSpeechAt !== undefined && turn.reaction.label && turn.reaction.label !== 'none') turn.reaction.played = 'late';
            // Nothing queued to say yet: react now, while Jibo works out his answer.
            // It plays next to whatever comes, so it never holds up a line.
            if (this.active && !turn.skipped && this.turn === turn && !turn.lines) this.playReaction(turn);
        }, () => { turn.reaction = {label: null}; });
    },
    playReaction(turn) {
        const reaction = turn.reaction;
        if (!this.active || turn.skipped || turn.reactionDone || !reaction || turn.firstSpeechAt !== undefined) return;
        turn.reactionDone = true;
        // A petting clip keeps the body (D144).
        if (this.petting) { if (reaction.label && reaction.label !== 'none') reaction.played = 'pet'; return; }
        if (!this.policy.allow(reaction.label, this.now(), turn.transcript)) { if (reaction.label && reaction.label !== 'none') reaction.played = 'limit'; return; }
        this.policy.used(reaction.label, this.now()); reaction.played = 'before';
        this.thinking.stop();
        const anim = reaction.play = this.choose(reaction.label, reaction.size);
        const played = this.player.play(anim, {via: 'reaction', turn: turn.n});
        // Only a clip known to leave the body still keeps the microphone open (D89).
        if (played.body !== false) this.holdMic(played.done);
    },
    // A moving reaction while Jibo thinks, or a petting clip (also between lines, so listening
    // that starts during it stays closed): his motors are noise, so the microphone is closed until
    // `until` settles, at most HOLD_MAX_MS (or options.maxMs). The hold outlives the turn (D89,
    // D90). options.fresh: reopened while listening, the audio so far is dropped and the silence
    // timer starts again (D144).
    holdMic(until, options) {
        if (this.state !== 'thinking' && this.state !== 'listening' && this.state !== 'speaking') return;
        const closed = this.now(), maxMs = options && options.maxMs || HOLD_MAX_MS, fresh = !!(options && options.fresh);
        this.held++; this.gate = false;
        if (this.state === 'listening') this.listeningRing();
        Promise.race([Promise.resolve(until).catch(() => {}), delay(maxMs)]).then(() => {
            this.held--;
            // Failing: Jibo is about to say what went wrong, and the microphone stays closed.
            if (!this.active || this.failing || this.held) return;
            const turn = this.turn;
            const open = this.state === 'listening' || (this.state === 'thinking' && turn && !turn.skipped && !turn.followUp && this.thinkingGate());
            if (!open) return;
            this.gate = true;
            if (this.state === 'listening') {
                this.listeningRing();
                if (fresh) { if (this.rt) this.rt.send({type: 'input_audio_buffer.clear'}); this.armSilence(); }
            }
            this.log.write({kind: 'mic_reopened', state: this.state, turn: turn ? turn.n : null, ms: this.now() - closed});
        });
    },
    // The first line's expression came after its words started: it plays while the line is said,
    // an eye clip once the eye is free (at most EYE_FREE_MS). True when it takes it; a body clip
    // that never played goes to line 2 (D99, D102).
    playLate(turn, label, size) {
        if (!this.active || turn.skipped || turn.firstSpoken || turn.firstEmoji || label === 'dance') return false;
        const anim = this.choose(label, size);
        if (!anim || this.player.busy() || !this.policy.allow(label, this.now(), turn.transcript)) return false;
        const eyeOnly = this.player.moves(anim) === false, from = this.now();
        const late = turn.late = {label: label, size: size, played: false, carry: !eyeOnly, trying: false};
        const live = () => this.active && !turn.skipped && !turn.firstSpoken;
        const dropped = (result, eye) => { if (this.active) this.log.write({kind: 'late_dropped', turn: turn.n, line: 0, label: label, name: anim, eye: eye, tries: result.tries, result: result.result}); };
        (eyeOnly ? this.eyeWatch.free(EYE_FREE_MS) : Promise.resolve(null)).then(how => {
            const eye = how ? {how: how, ms: this.now() - from} : undefined;
            // The wait for the eye may have run into another clip: that one keeps the stage.
            if (live() && this.player.busy()) return dropped({tries: 0, result: 'busy'}, eye);
            return this.playBesideLine(anim, {via: 'late', turn: turn.n, line: 0, eye: eye}, live, () => {
                // Counted (expression gap, the turn's expressions) only when it plays.
                late.played = true;
                if (!this.active || turn.skipped) return;
                this.policy.used(label, this.now());
                if (turn.firstEntry !== undefined) turn.expressions[turn.firstEntry] = label + ' (late)';
            }, late).then(result => { if (!result.played) dropped(result, eye); });
        });
        return true;
    },
    // A clip beside a line being said: speech's own animations may refuse it, so it is asked again
    // every BESIDE_RETRY_MS while live() (D102). onStart() runs when it starts; `state.trying` is
    // true while a try is loading or playing. Resolves {played, tries, result}.
    playBesideLine(anim, info, live, onStart, state) {
        const gaveUp = (n, result) => ({played: false, tries: n, result: result});
        const attempt = (n, last) => {
            if (!live()) return Promise.resolve(gaveUp(n - 1, last));
            if (state) state.trying = true;
            const handle = this.player.play(anim, n > 1 ? Object.assign({}, info, {tries: n}) : info);
            // `started` is true when the clip starts; without a platform start event it settles only
            // when the clip ends, so onStart and the next decision then come late.
            return handle.started.then(started => {
                if (state) state.trying = false;
                if (started) { if (onStart) onStart(); return {played: true, tries: n}; }
                return handle.done.then(result => {
                    if (result !== 'REJECTED' || n >= BESIDE_TRIES) return gaveUp(n, result);
                    return delay(BESIDE_RETRY_MS).then(() => this.player.busy() ? gaveUp(n, result) : attempt(n + 1, result));
                });
            });
        };
        return attempt(1);
    },
    noteClassifier(result) {
        if (result.switched) this.log.write({kind: 'classifier_switch', detail: result.switched});
        else if (result.error) this.log.write({kind: 'classifier_error', api: result.api || null, status: result.status || null, error: result.error});
    },
    // Move finished text from the reply into the speech queue.
    pump() {
        const turn = this.turn;
        if (!this.active || !turn || turn.skipped) return;
        if (turn.transcript === undefined && this.now() - turn.stoppedAt < this.config.transcriptWaitMs - 5) return;
        if (!turn.lines) {
            const end = ttsText.firstSentenceEnd(turn.text);
            if (end > 0) { this.enqueue(turn, turn.text.slice(0, end)); turn.sent = end; }
            else if (turn.done) { this.enqueue(turn, turn.text); turn.sent = turn.text.length; }
        }
        if (turn.lines && turn.done && turn.sent < turn.text.length) {
            this.enqueue(turn, turn.text.slice(turn.sent)); turn.sent = turn.text.length;
        }
        if (turn.done && turn.sent >= turn.text.length && !turn.ending) {
            turn.ending = true; clearTimeout(turn.waitTimer);
            this.speechChain = this.speechChain.then(() => this.endTurn(turn));
        }
    },
    enqueue(turn, text) {
        ttsText.chunks(text).forEach(piece => {
            if (!ttsText.speechText(piece)) return;
            const index = turn.lines++, config = this.config;
            let ready = null, readySize = null, labelAt = null, labelConn = null, released = false;
            const queuedAt = this.now();
            // A classifier problem only costs the expression, never the words.
            const asked = !!(config.expressions && this.classify);
            if (asked) this.lastClassify = this.now();
            const label = asked ? Promise.resolve().then(() => this.classify(turn.transcript || '', piece, 'line')).then(result => {
                if (result) this.noteClassifier(result);
                ready = result && result.label !== undefined ? result.label : null;
                readySize = result && result.size || null;
                labelAt = this.now(); labelConn = result && result.conn || null;
                if (released && this.active) this.log.write({kind: 'label_late', turn: turn.n, line: index, label: ready, ms: labelAt - queuedAt, at: this.since(labelAt), conn: labelConn || undefined});
                // Too late for the first line: it still plays on that line while it is said (D99, D102);
                // when it cannot, it is offered to the next line.
                if (index === 0 && turn.firstLate && ready && ready !== 'none' && !this.playLate(turn, ready, readySize)) turn.carried = {label: ready, size: readySize};
                return ready;
            }, () => null) : Promise.resolve(null);
            this.speechChain = this.speechChain.then(() => {
                if (!this.active || turn.skipped) return;
                const reached = this.now();
                let by = null;
                // The first line waits (at most expressionWaitMs) for the quick reaction, never for its
                // own label; a later label plays on the line or on line 2 (D104).
                const reacting = index === 0 && turn.reacting;
                const wait = reacting ? config.expressionWaitMs : 0;
                const awaited = reacting ? turn.reacting.then(() => { by = by || 'reaction'; return ready; }) : label;
                if (!asked && !reacting) by = 'no_classifier';
                // 'timeout': the reaction wait ran out; 'no_wait': this line had nothing to wait for.
                const waited = delay(wait).then(() => { by = by || (wait > 0 ? 'timeout' : 'no_wait'); return ready; });
                return Promise.race([awaited.then(found => { by = by || 'answers'; return found; }), waited]).then(found => {
                    released = true;
                    // The person went on while this line waited (D89): it is never said.
                    if (!this.active || turn.skipped) return;
                    if (index === 0 && found === null) turn.firstLate = true;
                    let size = readySize;
                    if (index === 1 && (found === null || found === 'none') && turn.carried) { found = turn.carried.label; size = turn.carried.size; }
                    let use = null;
                    // A reaction that was not played yet goes with the first line, before its own expression.
                    const reaction = turn.reaction;
                    if (index === 0 && reaction && !turn.reactionDone) {
                        turn.reactionDone = true;
                        if (this.policy.allow(reaction.label, this.now(), turn.transcript)) { use = reaction.label; size = reaction.size; this.policy.used(use, this.now()); reaction.played = 'with first line'; }
                        else if (reaction.label && reaction.label !== 'none') reaction.played = 'limit';
                    }
                    // With actions on, dancing is the dance tool's job, never a line's expression.
                    if (!use && !(found === 'dance' && this.acts) && this.policy.allow(found, this.now(), turn.transcript)) { use = found; this.policy.used(found, this.now()); }
                    // What this line waited for, and whose expression it got (ms since open).
                    this.log.write({kind: 'line_wait', turn: turn.n, line: index, queued: this.since(queuedAt), reached: this.since(reached), released: this.since(), by: by,
                        label: labelAt === null ? null : ready, label_ms: labelAt === null ? null : labelAt - queuedAt,
                        reaction: index === 0 && reaction ? reaction.label : undefined, reaction_at: index === 0 && reaction ? reaction.at : undefined, used: use || null,
                        conn: labelConn || undefined});
                    if (index === 0) turn.firstEntry = turn.expressions.length;
                    // "late": the first line's label was not there yet and no reaction stood in for it.
                    const reacted = index === 0 && reaction && (reaction.played === 'before' || reaction.played === 'with first line');
                    turn.expressions.push(found === null ? (index === 0 && !reacted ? 'late' : null) : found + (use === found || found === 'none' ? '' : ' (held back)'));
                    if (index === 0) turn.firstSpeechAt = this.now();
                    // No expression on this line: an eye emoji for something Jibo names (pizza, rain, a dog),
                    // at that word. Without one, speech's own keyword emoji may show, unless one was just shown (D98).
                    const jiboEmoji = this.emojiAllowed();
                    const emoji = !use && found !== 'dance' ? this.emojiFor(piece) : null;
                    if (emoji) turn.expressions.push('emoji ' + emoji.word);
                    if (index === 0 && emoji) turn.firstEmoji = true;
                    return this.speak(piece, use, {turn: turn.n, line: index, size: use ? size : null, keyword: emoji || undefined, hotWords: emoji || jiboEmoji ? undefined : false, beside: index > 0})
                        .then(() => {
                            if (index !== 0) return;
                            turn.firstSpoken = true;
                            // A late body clip that never played is offered to line 2 (D102).
                            if (turn.late && turn.late.carry && !turn.late.played && !turn.late.trying && !turn.carried) turn.carried = {label: turn.late.label, size: turn.late.size};
                        });
                });
            });
        });
    },
    // Each speak is logged (and written at once) before it starts: if BE dies mid-speech, the log shows what played.
    speak(text, expression, at) {
        if (!this.active) return Promise.resolve();
        const turn = at ? at.turn : null, line = at ? at.line : null;
        const speech = this.jibo.embodied && this.jibo.embodied.speech;
        this.thinking.stop();
        this.state = 'speaking'; this.gate = false; this.busyRing();
        if (!speech || typeof speech.speak !== 'function') return Promise.resolve();
        this.speaking = true;
        // A petting clip still playing ends before the words (D144).
        let chain = this.petDone();
        // The dance has its own music: play it before the words, not under them.
        if (expression === 'dance') {
            chain = chain.then(() => this.dance(this.heard, turn));
            expression = null;
        }
        // at.anim: an emoji by name instead of an expression label.
        const anim = at && at.anim ? at.anim : this.choose(expression, at && at.size);
        return chain.then(() => {
            if (!this.active) return;
            let words = ttsText.speechText(text), lead = Promise.resolve(), leadBy = null;
            // A keyword emoji goes in the words, just before its word: speech starts it there (D98).
            const keyword = at && at.keyword, tagged = keyword ? ttsText.emojiEsml(words, keyword.said, keyword.name, keyword.nth) : null;
            if (tagged) words = tagged;
            const leadFrom = this.now(), token = this.lineToken = {};
            const holdMs = at && at.emoji ? emojiHoldMs(text) : 0;
            // A notice's or trouble line's emoji waits for the expression still playing (D98).
            const later = anim && at && at.emoji && this.player.busy();
            // A line after the first plays its clip beside its words; the words never wait (D102).
            const beside = !later && anim && at && at.beside;
            if (later) {
                this.player.idle().then(() => { if (this.active && this.lineToken === token) this.player.play(anim, {via: 'emoji', turn: turn, line: line, holdMs: holdMs}); });
            } else if (beside) {
                leadBy = 'beside';
            } else if (anim) {
                const lineLead = this.leadWith(anim, {via: at && at.via || 'line', turn: turn, line: line, holdMs: holdMs});
                lead = lineLead.ready.then(how => { leadBy = how; });
            }
            return lead.then(() => {
                if (!this.active) return;
                const started = this.now();
                // Speech's own keyword emoji off for this line (its third argument, auto rules).
                const rules = at && at.hotWords === false ? {hotWords: false} : null;
                this.log.write({kind: 'speak', turn: turn, line: line, expression: expression || null, size: at && at.size || undefined, emoji: at && at.emoji || keyword && keyword.word || undefined,
                    emoji_at: keyword ? (tagged ? keyword.said.join(' ') : 'missed') : undefined, after: later || undefined, hot_words: rules ? false : undefined,
                    play: anim || keyword && keyword.name || undefined, at: this.since(started), lead: leadBy || undefined, lead_ms: leadBy ? started - leadFrom : undefined,
                    text: String(text).slice(0, 300)});
                this.mark('first_speech');
                const args = rules ? [words, SPEAK_OPTIONS, rules] : [words, SPEAK_OPTIONS];
                const call = this.timedSpeak(speech, args, this.speakBaseMs + words.length * SPEAK_MS_PER_CHAR, {turn: turn, line: line});
                if (beside) this.playBesideLine(anim, {via: at.via || 'line', turn: turn, line: line, holdMs: holdMs}, () => this.active && this.lineToken === token).then(result => {
                    if (!result.played && this.active) this.log.write({kind: 'late_dropped', turn: turn, line: line, name: anim, tries: result.tries, result: result.result});
                });
                return call.then(() => this.spoken(speech, started, turn, line), error => {
                    // The line is over, so a clip beside it stops asking.
                    if (this.lineToken === token) this.lineToken = null;
                    throw error;
                });
            });
        }).catch(() => {}).then(() => {
            this.speaking = false; if (this.marks.first_speech !== undefined) this.mark('first_speech_done');
            // A touch during the line: its petting clip plays now, before the next line or listening (D144).
            this.playPendingPet('line_end');
            return this.petDone();
        });
    },
    // The first line's clip goes before its words, so it holds Jibo's body before speech's own
    // gestures ask for it: the words follow once a body clip was handed over (D80) or a clip of
    // unknown kind started, at most expressionLeadMs. Eye clips never hold the words (D99).
    // Resolves {ready: Promise of how the lead ended}.
    leadWith(anim, info) {
        const played = this.player.play(anim, info);
        if (played.body === false) return {ready: Promise.resolve('none')};
        const handedOver = played.body === true
            ? played.playing.then(ok => ok ? 'body' : 'failed')
            : played.started.then(ok => ok ? 'started' : 'failed');
        return {ready: Promise.race([handedOver, delay(this.config.expressionLeadMs || 0).then(() => 'timeout')])};
    },
    // A speak that never answers must not leave Jibo speaking with "Hey Jibo" off (D114).
    timedSpeak(speech, args, limitMs, where) {
        // Kept on the conversation, so close() clears it: a late stop would cut the next skill's speech.
        let timer = null;
        const done = () => { clearTimeout(timer); this.speakTimers.delete(timer); };
        const call = Promise.resolve().then(() => speech.speak.apply(speech, args));
        const late = new Promise((resolve, reject) => {
            timer = setTimeout(() => {
                this.speakTimers.delete(timer);
                this.log.write(Object.assign({kind: 'speak_timeout', ms: limitMs}, where));
                try { if (speech.stop) speech.stop(); } catch (_) {}
                reject(Error('speak_timeout'));
            }, limitMs);
            this.speakTimers.add(timer);
        });
        return Promise.race([call, late]).then(value => { done(); return value; }, error => { done(); throw error; });
    },
    // A line's words are done; speech's own animations may still play: log when they end.
    spoken(speech, started, turn, line) {
        const now = this.spokenAt = this.now();
        this.lineToken = null;
        this.log.write({kind: 'spoken', turn: turn, line: line, ms: now - started, at: this.since(now)});
        this.refreshRing();
        this.speechAnims = null;
        if (typeof speech.waitForAnimDispatch !== 'function') return;
        this.speechAnims = Promise.resolve().then(() => speech.waitForAnimDispatch()).catch(() => {}).then(() => {
            this.refreshRing();
            if (this.active) this.log.write({kind: 'speech_anims', turn: turn, line: line, ms: this.now() - started, at: this.since()});
        });
    },
    // Resolves once Noggin's own expression and speech's last animations are done, or after `ms`.
    untilStill(ms) {
        const playing = Promise.all([this.player.idle(), this.speechAnims || Promise.resolve()]).catch(() => {});
        return Promise.race([playing, delay(ms)]);
    },
    // Before the microphone opens: with expressionTailMs, wait (at most that long) for what still plays.
    settle() {
        const tail = this.config.expressionTailMs;
        return tail > 0 ? this.untilStill(tail) : Promise.resolve();
    },
};
module.exports = methods;
