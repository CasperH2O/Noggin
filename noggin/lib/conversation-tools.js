// SPDX-License-Identifier: MIT
// Noggin: running the model's tool calls, mixed into Conversation (lib/controller.js). What each
// tool does is planned in lib/actions.js; here it runs: in Noggin (dance, volume, clock, memory,
// facts), as a handover to another skill, or as a question to Jibo's cloud.
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const voice = require('./voice');
const catalog = require('./catalog'), ttsText = require('./tts-text'), actions = require('./actions');
const delay = require('./timing').delay;
const heyJibo = require('./hey-jibo');

const MAX_ROUNDS = 2;        // tool rounds in a row before the model must answer without one
const RECENT_DANCES = 3;     // no dance again within this many dances (unless asked for "again")
const DANCE_SPEAK_MS = 40000;  // the longest a dance with its music may take (D114)

const methods = {
    // Run the turn's tool calls (after its words were spoken). Results of in-Noggin tools go back to
    // the model, which answers in a follow-up reply; a handover tool ends Noggin for now.
    act(turn, calls) {
        const round = (turn.round || 0) + 1, outputs = [];
        this.state = 'acting'; this.gate = false; this.busyRing();
        let handover = null, chain = Promise.resolve();
        calls.forEach(call => {
            chain = chain.then(() => {
                if (!this.active) return;
                const started = this.now(), args = String(call.args || '').slice(0, 200);
                this.log.write({kind: 'tool_call', turn: turn.n, name: call.name, args: args});
                const done = result => {
                    this.log.write({kind: 'tool_result', turn: turn.n, name: call.name, ok: result.ok !== false, error: result.error || undefined, ms: this.now() - started});
                    outputs.push({call: call, result: result});
                };
                if (round > MAX_ROUNDS) return done({ok: false, error: 'too many actions in a row'});
                if (handover) return done({ok: false, error: 'one action at a time: try this again afterwards'});
                const what = actions.plan(call.name, call.args, this.config);
                if (what.kind === 'handover' || what.kind === 'cloud') { handover = {call: call, plan: what}; return; }
                if (what.kind === 'error') return done({ok: false, error: what.error});
                return this.runLocal(what.run, what.args, turn).then(result => {
                    if (result && result.handover) handover = {call: call, plan: result.handover};
                    else done(result);
                });
            });
        });
        return chain.then(() => {
            if (!this.active) return;
            if (handover) return this.handOver(turn, handover, outputs, round);
            this.answer(turn, outputs, round);
        }).catch(error => this.fail(error));
    },
    // A dance with its own music, chosen from the person's words (`heard`): the same one again, a
    // dance of the style they named, or a random one; none of the last three when there is another.
    // Jibo may name it first (danceAnnounce), in `language` (the reply's) when given. Resolves
    // {name, style, from, announced, language} once it is over.
    dance(heard, turn, language) {
        const speech = this.jibo.embodied && this.jibo.embodied.speech, choice = catalog.danceChoice(heard, this.random);
        const last = this.recentDances[0];
        let name, style, from;
        if (choice.again && last && (!choice.style || catalog.danceStyles(last).indexOf(choice.style) >= 0)) { name = last; from = 'again'; style = choice.style; }
        else if (choice.style) { style = choice.style; name = catalog.pickDance(style, {recent: this.recentDances, random: this.random}); from = 'keyword'; }
        else { name = catalog.pickDance(null, {recent: this.recentDances, random: this.random}); from = 'random'; }
        style = style || catalog.danceStyles(name)[0] || null;
        this.recentDances = [name].concat(this.recentDances.filter(n => n !== name)).slice(0, RECENT_DANCES);
        const announced = catalog.danceAnnounce(this.config.danceAnnounce, from, this.danceCount - this.announcedAt, this.random);
        this.danceCount++; if (announced) this.announcedAt = this.danceCount;
        // The announcement follows the reply's language (English once the conversation switched);
        // in Dutch only while the Dutch voice can say it, otherwise the dance goes without words (D174, D175, D177).
        language = this.englishSwitched ? 'en' : language || this.turn && this.turn.language || this.language;
        const dutch = language === 'nl';
        const canSay = !dutch || this.voice.choose('nl').language === 'nl';
        const line = announced && canSay ? catalog.danceLine(style, this.random, language) : null;
        this.log.write(Object.assign({kind: 'speak', turn: turn === undefined ? null : turn, anim: name, dance: style, from: from},
            line ? {text: line, language: language} : {}));
        // One speak for the words and the dance: a dance right after another speak is cut short (D115).
        const tag = "<anim name='" + name + "' endNeutral='true'/>";
        const words = (line ? ttsText.speechText(line, language) + ' ' : '') + tag;
        const where = {turn: turn === undefined ? null : turn, dance: name};
        this.dancing = true;
        // Refused in Dutch: the dance without words, and Jibo says right away why (D175).
        const call = !(line && dutch) ? this.timedSpeak(speech, [words], DANCE_SPEAK_MS, where)
            : this.speakDutch(speech, [words, {}, {hotWords: false}], DANCE_SPEAK_MS, where).catch(error => {
                if (!voice.refused(error) || !this.active) throw error;
                return this.timedSpeak(speech, [tag], DANCE_SPEAK_MS, where).then(() => this.sayEnglishNow());
            });
        return call.then(() => {
            this.dancing = false;
            // A refused Dutch announcement switched the conversation: the model hears English now.
            return {name: name, style: style, from: from, announced: announced, language: this.englishSwitched ? 'en' : language};
        }, error => {
            this.dancing = false;
            // Stopped half way: back to neutral (D116).
            if (this.active && !this.isPrivate()) this.player.centre({force: true});
            throw error;
        });
    },
    // dance, about_jibo, set_volume, check_clock, remember/forget/recall, and the first step of
    // cancel_timer/cancel_alarm.
    runLocal(run, args, turn) {
        const acts = this.acts;
        if (run === 'memory') {
            return Promise.resolve().then(() => acts.memory ? acts.memory(args || {}) : {ok: false, error: 'memory is switched off for Jibo'})
                .catch(() => ({ok: false, error: 'your memory could not be read or written just now'}));
        }
        if (run === 'facts') {
            const facts = acts.facts ? String(acts.facts() || '') : '';
            return Promise.resolve(facts ? {ok: true, facts: facts} : {ok: false, error: 'no facts available: say you are not sure about that one'});
        }
        if (run === 'dance') {
            const speech = this.jibo.embodied && this.jibo.embodied.speech;
            if (!speech || typeof speech.speak !== 'function') return Promise.resolve({ok: false, error: 'Jibo cannot move right now'});
            this.speaking = true; this.state = 'acting';
            // A petting clip still playing keeps the body until it ends (D144).
            return this.petDone().then(() => this.dance(turn ? turn.transcript || '' : this.heard, turn ? turn.n : null, turn && turn.language))
                .then(played => Object.assign({ok: true, done: 'Jibo danced', dance: catalog.danceName(played.style, played.language)},
                    played.announced ? {announced: 'Jibo named the dance before it: do not name it again'} : {}),
                () => ({ok: false, error: 'the dance did not play'}))
                .then(result => { this.speaking = false; return result; });
        }
        if (run === 'volume') return Promise.resolve(acts.setVolume ? acts.setVolume(args || {}) : {ok: false, error: 'Jibo cannot change his volume right now'});
        if (run === 'clock' || run === 'cancel') {
            // Read the clock's record. check_clock answers from it, and if it can't be read the
            // clock itself answers; a cancel goes to the clock only if there is something to cancel.
            return Promise.resolve().then(() => acts.readClock ? acts.readClock() : null).catch(() => null).then(clock => {
                if (run === 'clock') return clock ? {ok: true, timer: clock.timer, alarm: clock.alarm} : {handover: actions.clockQuery()};
                const domain = args && args.domain === 'alarm' ? 'alarm' : 'timer';
                if (clock && clock[domain] && clock[domain].set === false) return {ok: true, cancelled: false, note: domain === 'alarm' ? 'no alarm is set' : 'no timer is running'};
                return {handover: actions.clockCancel(domain)};
            });
        }
        return Promise.resolve({ok: false, error: 'unknown action'});
    },
    // Tool results back to the model, then its follow-up reply (unless the rounds ran out).
    answer(turn, outputs, round) {
        if (!this.active || !this.rt) return;
        outputs.forEach(o => this.rt.send({type: 'conversation.item.create',
            item: {type: 'function_call_output', call_id: o.call.callId, output: JSON.stringify(o.result)}}));
        if (round > MAX_ROUNDS) { this.listen(); return; }
        this.followUp(turn, round);
    },
    // A reply without new words from the person: after tool results, or on coming back.
    followUp(previous, round) {
        const now = this.now();
        // Never undefined: a follow-up has no words of its own to wait for, so pump() must not hold it (D186).
        const turn = this.turn = {n: previous ? previous.n : ++this.turns, round: round, followUp: true, stoppedAt: now, text: '', sent: 0, lines: 0,
            transcript: previous && previous.transcript || '', transcriptAt: now, expressions: [], lag: [], reactionDone: true, goodbye: previous ? previous.goodbye : false,
            // The person's words for the turn before, if still to come: their item, or true when not known.
            lateItem: previous && previous.transcript === undefined ? previous.itemId || true : null};
        this.state = 'thinking'; this.gate = false; this.busyRing();
        this.guardReply(turn);
        this.rt.send({type: 'response.create'});
    },
    // Hand the action to another skill. Noggin is closed by that switch; if it does not happen
    // within actionTimeoutMs, the model hears that it failed and the conversation goes on.
    // A `cloud` plan asks Jibo's cloud a fixed phrase instead of opening a skill: Be then
    // switches to @be/nimbus, which speaks the answer.
    handOver(turn, handover, outputs, round) {
        const plan = handover.plan, call = handover.call, acts = this.acts, cloud = plan.kind === 'cloud';
        // From here on a global turn is this handover's, never the opening "Hey Jibo"'s (D132).
        this.heyJibo = null; heyJibo.release();
        const state = this.handover = {tool: call.name, target: plan.target, reason: plan.comeback ? 'handover' : 'leaves'};
        this.state = 'handover'; this.gate = false; this.busyRing();
        this.log.write({kind: 'handover', turn: turn.n, tool: call.name, target: plan.target, comeback: plan.comeback, phrase: cloud ? plan.phrase : undefined});
        const failed = error => {
            if (!this.active || this.handover !== state) return;
            this.handover = null; clearTimeout(this.handoverTimer);
            try { if (acts.handoverFailed) acts.handoverFailed(); } catch (_) {}
            // The cloud path gave the hotword back: the conversation goes on, so take it again.
            if (cloud && !this.hotword) this.hotwordOff();
            this.log.write({kind: 'tool_result', turn: turn.n, name: call.name, ok: false, error: error});
            const result = {ok: false, error: error};
            // The clock did not show the time: the model can still say it.
            if (call.name === 'get_time') {
                const at = actions.describeTime(acts.localTime ? acts.localTime() : new Date(this.now()));
                Object.assign(result, {time: at.time, date: at.date, note: 'say it yourself'});
            }
            this.answer(turn, outputs.concat([{call: call, result: result}]), round);
        };
        try { if (acts.handover) acts.handover({tool: call.name, target: plan.target, args: plan.args, comeback: plan.comeback, pairs: this.pairs.slice()}); }
        catch (_) {}
        const wait = this.config.actionTimeoutMs;
        if (cloud) {
            // Speech drops a mimicked turn while the hotword is off: give it back first, at most 1.5 s.
            // Not returned, so a cloud call that never answers cannot hold up the speech chain.
            const hotword = this.hotword; this.hotword = null;
            const released = hotword ? Promise.race([Promise.resolve().then(() => hotword.release()).catch(() => {}), delay(1500)]) : Promise.resolve();
            released.then(() => {
                if (!this.active || this.handover !== state) return;
                if (!acts.cloud) return failed('Jibo\'s cloud is not available');
                this.handoverTimer = setTimeout(() => failed('Jibo\'s cloud did not answer'), wait);
                Promise.resolve().then(() => acts.cloud(plan.phrase))
                    .catch(error => failed('Jibo\'s cloud could not be asked: ' + String(error && error.message || error).slice(0, 100)));
            });
            return;
        }
        // An app from the `openApps` setting that is not installed: say so at once (Be would only log it).
        if (plan.check && acts.installed && !acts.installed(plan.target)) return failed('that app is not installed on Jibo');
        this.handoverTimer = setTimeout(() => failed(plan.target === actions.CLOCK ? 'the clock did not open' : 'it did not open'), wait);
        try { acts.redirect(plan.target, plan.options); }
        catch (error) { failed('could not open ' + plan.target + ': ' + String(error && error.message || error).slice(0, 100)); }
    },
};
module.exports = methods;
