// SPDX-License-Identifier: MIT
// Noggin: one voice conversation. The realtime model hears Jibo's microphone and answers in text;
// Jibo reacts with a quick expression, then speaks each line in his own voice with an expression
// picked by OpenAI (lib/openai.js). Tools are planned in lib/actions.js and run in conversation-tools.js.
//
//   listening --(speech stopped)--> thinking --(first line)--> speaking --> listening
//   thinking --(the person goes on, D89, D90)--> listening
//
// Half-duplex: no audio goes out while Jibo speaks, nor for `echoTailMs` after. Petting and whom
// Jibo sees reach the model as notes (conversation-senses.js). Ends on a goodbye, silence, swipe
// down, a 3 s hold on his head, privacy, a skill switch, a handover or a lost connection (D73); when it
// cannot go on, Jibo says why (lib/trouble.js, D70). Session patterns follow BEam's Agent Mode
// (BSD-3-Clause, @be/be skills/agent). Node 6 / Chrome 53: ES2015 only.
'use strict';
const catalog = require('./catalog'), ttsText = require('./tts-text'), realtime = require('./realtime-session');
const actions = require('./actions'), trouble = require('./trouble'), ExpressionPlayer = require('./expression');
const voice = require('./voice'), lines = require('./lines');
const delay = require('./http').delay;
const AudioClock = require('./audio-clock'), heyJibo = require('./hey-jibo');
// Conversation's methods, by topic; mixed into the class below.
const micMethods = require('./conversation-mic'), lineMethods = require('./conversation-lines'), toolMethods = require('./conversation-tools');
const senseMethods = require('./conversation-senses');

// Ring: blue while Jibo listens, orange while he thinks and speaks. Speech's hot-word glances can
// key the ring to black, so it is re-sent after each line and every ringRefreshMs (D113).
const LISTENING = require('./ring').LISTENING, BUSY = require('./ring').BUSY, OFF = require('./ring').OFF;
// The words a dropped turn carries: those it carried itself, then its own.
function carriedText(carried) { return carried ? joinWords(carried.before, carried.own) : ''; }
function joinWords(a, b) { return [a, b].filter(Boolean).join(' '); }
// A reply's words without its language label (D171).
function replyWords(turn) { return String(turn.text || '').slice(turn.start || 0); }
const REPLY_WAIT_MS = 15000, KEEP_PAIRS = 10;
const QUIET_WARM_MS = 180000;  // warm the classifier again when speech starts after this long without a request (D93)

class Conversation {
    // deps: {jibo, config, instructions, sessionNote (first item of every session, D181), persona: {edited, chars, note_chars, facts, memory} (for the log),
    //        connect(), mic, classify(personSaid, jiboSays), log, now(),
    //        actions: {redirect(pkg, options), cloud(phrase), handover(state), handoverFailed(), readClock(), setVolume(args), installed(pkg), localTime(), facts()} or null,
    //        resume: {pairs, tool, args, said} when coming back after a handover,
    //        heyJibo: {heardAt} when "Hey Jibo" opened Noggin (lib/hey-jibo.js),
    //        openedAt: when the skill's open() began (Date.now()), startup: facts for the startup log,
    //        diagnose() -> {cause, detail} after an OpenAI failure (lib/trouble.js), notice: {line (a lib/lines.js key), emoji, said()} after the greeting,
    //        version: for the session log (optional), voice: lib/voice.js create() (optional), language: its choose() result, made once by the caller (optional)}
    constructor(deps) {
        this.jibo = deps.jibo; this.config = deps.config; this.instructions = deps.instructions; this.sessionNote = deps.sessionNote || ''; this.persona = deps.persona; this.version = deps.version || null;
        this.connectFn = deps.connect; this.diagnoseFn = deps.diagnose || null; this.notice = deps.notice || null; this.mic = deps.mic; this.classify = deps.classify; this.log = deps.log || {write() {}};
        this.now = deps.now || (() => Date.now()); this.random = deps.random || Math.random;
        this.micStartMs = Conversation.MIC_START_MS; this.speakBaseMs = Conversation.SPEAK_BASE_MS;
        this.speakTimers = new Set(); this.dancing = false;
        this.active = false; this.state = 'idle'; this.gate = false; this.turn = null; this.turns = 0;
        this.audio = {blocks: 0, sent: 0, levels: []}; this.lastClassify = 0; this.clock = null;
        this.held = 0; this.carried = null; this.droppedReplies = {};
        this.rt = null; this.unwatch = []; this.speechChain = Promise.resolve(); this.speaking = false;
        this.policy = new catalog.ExpressionPolicy(this.config.expressionGapMs);
        this.acts = deps.actions || null; this.resume = deps.resume || null; this.pairs = []; this.handover = null;
        this.heyJibo = deps.heyJibo || null;
        // Startup timing: ms since the skill's open() for each step, logged once as `startup`
        // when Jibo first listens (or with the failure, if he never gets there).
        this.t0 = typeof deps.openedAt === 'number' ? deps.openedAt : this.now();
        this.boot = Object.assign({}, deps.startup || {}); this.marks = {}; this.mark('talk_created');
        this.thinking = new ExpressionPlayer.ThinkingEye(this.jibo, () => this.config.thinkingEye !== false && this.active && !this.isPrivate() && this.state === 'thinking',
            () => this.since(), cycle => this.log.write(Object.assign({kind: 'thinking_eye'}, cycle)));
        this.player = new ExpressionPlayer(this.jibo, this.log, this.now, t => t - this.t0, () => this.active && !this.isPrivate());
        this.eyeWatch = null;
        this.speechAnims = null; this.spokenAt = null; this.recentAnims = []; this.recentEmoji = []; this.lastEmojiAt = -Infinity;
        this.heard = ''; this.recentDances = []; this.danceCount = 0; this.announcedAt = -Infinity;
        // The language the conversation starts in: Dutch only with the Dutch voice ready (D172).
        // A reply's own label may pick the other voice (D171).
        this.voice = deps.voice || voice.create();
        const chosen = deps.language || this.voice.choose(this.config.language);
        this.language = chosen.language; this.dutchMissing = chosen.missing; this.englishNow = false; this.englishSwitched = false;
        this.dutchLines = 0;   // Dutch lines being said through the Dutch voice
        this.englishNoteRt = null; this.readyRt = null;
        this.lineLanguages = {nl: 0, en: 0};   // lines said per language, for the Usage tab (D171)
    }
    since(t) { return Math.round((t === undefined ? this.now() : t) - this.t0); }
    isPrivate() { return !!(this.jibo.privacyController && this.jibo.privacyController.enabled); }
    mark(name, at) { if (this.marks[name] === undefined) this.marks[name] = Math.round((at === undefined ? this.now() : at) - this.t0); }
    logStartup(extra) {
        if (this.startupLogged) return;
        this.startupLogged = true;
        this.log.write(Object.assign({kind: 'startup', resumed: this.resume ? this.resume.tool || true : false, ms: this.marks}, this.boot, extra || {}));
    }
    led(color) { this.ring = color; try { if (!this.isPrivate() && this.jibo.expression) this.jibo.expression.setLEDColor(color); } catch (_) {} }
    refreshRing() { if (this.active && this.ring) this.led(this.ring); }
    busyRing() { this.led(BUSY); }
    // Blue only once the microphone is open: a hold keeps it orange (D91).
    listeningRing() { this.led(this.held ? BUSY : LISTENING); }
    watch(event, handler) {
        if (!event || typeof event.on !== 'function') return;
        event.on(handler);
        this.unwatch.push(() => { try { event.off ? event.off(handler) : event.removeListener(handler); } catch (_) {} });
    }
    // Resolves with the reason the conversation ended.
    open() {
        if (this.done) return this.done;
        this.done = new Promise(resolve => { this.finish = resolve; });
        this.active = true; this.state = 'starting'; this.mark('talk_open');
        const jibo = this.jibo, config = this.config;
        this.log.write({kind: 'session', version: this.version || undefined, realtimeModel: config.realtimeModel, reasoning: realtime.reasoningEffort(config), transcribeModel: config.transcribeModel,
            transcribeLanguages: realtime.transcription(config).languages || null, turnDetection: config.turnDetection,
            classifierModel: config.expressions ? config.classifierModel : null, actions: !!this.acts, resumed: this.resume ? this.resume.tool || true : undefined,
            language: this.language, dutch_missing: this.dutchMissing || undefined,
            persona: this.persona || undefined,
            timing: {thinkingEye: config.thinkingEye !== false, expressionWaitMs: config.expressionWaitMs, expressionLeadMs: config.expressionLeadMs, echoTailMs: config.echoTailMs}});
        if (this.isPrivate()) { this.leave('privacy'); return this.done; }
        this.monitor = setInterval(() => { if (this.isPrivate()) this.leave('privacy'); }, 250);
        // Only measured when the full log keeps it (D78).
        if (this.log.enabled !== false && !this.log.recapOnly) {
            this.startLagProbe();
            // Classifier connection and VAD timing (D87, D89).
            this.clock = new AudioClock();
            if (this.classify && typeof this.classify.watch === 'function')
                this.unwatch.push(this.classify.watch(info => { if (this.active) this.log.write(Object.assign({kind: 'conn_closed', at: this.since()}, info)); }));
        }
        this.busyRing();
        if (config.ringRefreshMs > 0) this.ringTimer = setInterval(() => this.refreshRing(), Math.max(100, config.ringRefreshMs));
        const js = jibo.jetstream;
        if (js && js.events) {
            this.watch(js.events.skillSwitch, () => this.leave('skill_switch'));
            this.watch(js.events.globalTurnStarted, () => {
                // The turn of the "Hey Jibo" that opened Noggin, cancelled by background.js: once only (D132).
                if (heyJibo.ownTurn(this.heyJibo, Date.now())) {
                    this.heyJibo = null;
                    this.log.write({kind: 'hey_jibo_turn', at: this.since()});
                    return;
                }
                this.leave('global_turn');
            });
        }
        const eyeWatch = this.eyeWatch = ExpressionPlayer.watchEye(jibo.face && jibo.face.eye);
        this.unwatch.push(() => eyeWatch.stop());
        const gestures = jibo.face && jibo.face.gestures;
        if (gestures && gestures.addStageGesture && gestures.hammer) {
            try {
                const gesture = gestures.addStageGesture(gestures.hammer.Swipe, {event: 'nogginSwipeDown', direction: gestures.hammer.DIRECTION_DOWN, threshold: 50, velocity: 0.3}, () => this.leave('swipe'));
                this.unwatch.push(() => { try { gestures.removeStageGesture(gesture); } catch (_) {} });
            } catch (_) {}
        }
        this.watchSenses();
        // Opened from the menu, the menu view would stay: Jibo's own eye for the conversation.
        const eye = ExpressionPlayer.showEye(jibo).then(result => { this.mark('eye'); this.boot.eye = result; });
        // The rest starts side by side; Jibo listens when all of it is done. "Hey Jibo" goes off
        // (the microphone is ours); only listening waits for that, at most 2 s.
        let hotword = Promise.resolve('none');
        if (this.hotwordOff()) {
            hotword = Promise.race([Promise.resolve(this.hotword && this.hotword.activated).then(() => 'off', () => 'error'), delay(2000).then(() => 'timeout')]);
        }
        hotword = hotword.then(result => { this.mark('hotword'); this.boot.hotword = result; });
        // The first line is fixed text: Jibo says it as soon as his eye shows, while OpenAI connects.
        // That is the greeting, or, back from the clock, the comeback line ("Anything else?").
        // Dutch asked for but not possible: the unedited "Hoi!" becomes "Hi!"; anything else as written (D170).
        const written = (this.resume ? config.comebackLine : config.greeting) || '';
        const first = this.dutchMissing ? lines.firstLine(this.resume ? 'comeback' : 'greeting', written, this.language) : written;
        this.firstLine = first;
        const greeted = (!first ? eye : eye.then(() => {
            if (!this.active) return;
            this.mark('first_speech_queued');
            const label = this.resume ? null : config.greetingExpression;
            const expression = (catalog.EXTRA[label] || catalog.MOODS[label]) && label !== 'dance' ? label : null;
            if (catalog.MOODS[expression]) this.policy.used(expression, this.now());
            // The unedited Dutch default has an English twin for when the Dutch voice refuses (D175).
            const key = this.resume ? 'comeback' : 'greeting';
            return this.speak(first, expression, first === lines.LINES.nl[key] ? {english: lines.LINES.en[key]} : null);
        })).then(() => this.sayDutchMissing()).then(() => this.sayNotice());
        // A failure waits for the greeting, so Jibo finishes his "Hi!" before he apologises.
        const afterGreeting = promise => promise.catch(error => greeted.then(() => { throw error; }));
        // The classifier does not need the realtime session: its slow first answers (D93) happen
        // while Jibo greets. After the greeting is queued, so its start is not held up.
        eye.then(() => { if (this.active) this.warm('start'); });
        const connected = afterGreeting(this.connect().catch(error => { throw openaiError(error); }));
        const micReady = afterGreeting(Promise.resolve().then(() => {
            this.mark('mic_start');
            return this.startMic();
        }).then(() => {
            // Closed while the microphone was starting: no report timer for a closed conversation.
            if (!this.active) return;
            this.mark('mic_ready');
            this.log.write({kind: 'microphone', source: this.mic.kind || null, label: this.mic.label || null, rate: this.mic.rate || null});
            this.audioTimer = setInterval(() => this.audioReport(), 10000);
        }));
        Promise.all([eye, hotword, greeted, connected, micReady]).then(() => {
            if (!this.active) return;
            return this.resume ? this.resumeConversation() : false;
        }).then(replying => {
            // The model speaks next (a comeback without a fixed line): listening starts after its reply.
            if (replying === true || !this.active) return;
            // After the first line too, the mic stays closed for echoTailMs, so Jibo never hears his own voice.
            const tail = first && this.marks.first_speech_done !== undefined ? Math.max(0, config.echoTailMs - (this.now() - this.t0 - this.marks.first_speech_done)) : 0;
            return Promise.all([delay(tail), this.settle()]).then(() => this.listen());
        }).catch(error => this.fail(error));
        return this.done;
    }
    // The realtime session: connect, then session.update until session.updated.
    connect() {
        const config = this.config, started = this.now();
        return Promise.resolve().then(() => this.connectFn()).then(rt => {
            if (!this.active) { rt.close(); return; }
            this.rt = rt;
            if (this.clock) this.clock.reset();
            this.droppedReplies = {};
            const timing = rt.timing || {};
            if (timing.open) this.mark('socket_open', timing.open);
            this.mark('session_created', timing.created || undefined);
            // Only the current connection's events: a dropped one is replaced (D73).
            rt.listen(event => { if (this.rt === rt) this.onEvent(event); });
            // A model that refuses the reasoning field gets the update once more without it, for this
            // conversation and its reconnect, so a wrong guess costs a log line and not every conversation (D168).
            const update = withReasoning => {
                const updated = this.waitFor(['session.updated'], 10000);
                rt.send(realtime.sessionUpdate(withReasoning ? config : Object.assign({}, config, {realtimeReasoning: 'default'}), this.instructions, this.acts ? actions.tools(config) : null));
                return updated;
            };
            const asked = !this.reasoningRefused && !!realtime.reasoningEffort(config);
            return update(!this.reasoningRefused).catch(error => {
                if (!asked || !error.refused || isFatal(error.code)) throw error;
                this.reasoningRefused = true;
                this.log.write({kind: 'reasoning_refused', code: error.code || null});
                return update(false);
            }).then(() => {
                // Before any other item, so it stays in the cached part of every later reply.
                if (this.sessionNote) rt.send({type: 'conversation.item.create', item: {type: 'message', role: 'system', content: [{type: 'input_text', text: this.sessionNote}]}});
                this.readyRt = rt;
                this.mark('session_updated'); this.log.write({kind: 'connected', ms: this.now() - started});
                // A Dutch refusal before the connection was set up (the greeting) is told now (D175).
                if (this.englishSwitched) this.sendEnglishNote();
            });
        });
    }
    // Resolves on the first of `types`; rejects on an error event, a closed connection or the timeout.
    waitFor(types, ms) {
        return new Promise((resolve, reject) => {
            let stop = null;
            const timer = setTimeout(() => { if (stop) stop(); reject(Error('timeout waiting for ' + types.join('/'))); }, ms);
            stop = this.rt.listen(event => {
                if (types.indexOf(event.type) >= 0) { clearTimeout(timer); stop(); resolve(event); }
                else if (event.type === 'error' || event.type === 'transport.closed') {
                    clearTimeout(timer); stop();
                    const failure = Error('OpenAI: ' + (event.error ? event.error.code || event.error.message : 'connection closed'));
                    // An error event (not a closed connection): the server answered and said no.
                    if (event.type === 'error') { failure.refused = true; failure.code = event.error && event.error.code || null; }
                    reject(failure);
                }
            });
        });
    }
    // Dutch was asked for but the Dutch voice is not ready: the conversation is English, and Jibo
    // says why once, after the greeting; never on a comeback (D172).
    sayDutchMissing() {
        if (!this.dutchMissing || this.resume || !this.active) return;
        return this.speak(lines.say('dutchMissing', 'en'), null, {language: 'en'});
    }
    // Something to say once after the greeting (the budget heads-up, D74); never on a comeback.
    sayNotice() {
        const notice = this.notice;
        if (!notice || this.resume || !this.active) return;
        this.notice = null;
        const text = lines.say(notice.line, this.language);
        this.log.write({kind: 'notice', text: text});
        return this.speak(text, null, Object.assign({english: lines.say(notice.line, 'en')}, notice.emoji ? {anim: notice.emoji, emoji: 'notice', via: 'notice', hotWords: false} : {}))
            .then(() => { try { if (notice.said) notice.said(); } catch (_) {} });
    }
    // The connection dropped after the session was set up: once per conversation, a new session
    // with the conversation so far (D73). A reply that was on its way is lost: Jibo says so.
    dropped() {
        if (this.failing) return;
        if (this.reconnects || this.marks.session_updated === undefined || !this.active) return this.fail(openaiError(Error('connection_lost')));
        this.reconnects = 1;
        // A reply whose end is already queued is still spoken; any other is lost.
        const turn = this.turn, lost = !!turn && !turn.ending;
        this.reconnecting = true;
        this.gate = false; clearTimeout(this.silence); this.silence = null;
        if (lost) this.dropTurn(turn);
        this.thinking.stop();
        const old = this.rt; this.rt = null;
        if (old) old.close();
        this.log.write({kind: 'reconnect', state: this.state, turn: turn ? turn.n : null, pairs: this.pairs.length});
        this.state = 'reconnecting'; this.busyRing();
        return this.connect().then(() => {
            if (!this.active || !this.rt) return;
            this.log.write({kind: 'reconnected'});
            this.forgetSeen();
            // After what is still being said, so a complete reply is in the note.
            this.speechChain = this.speechChain.then(() => {
                this.reconnecting = false;
                if (!this.active || !this.rt) return;
                this.rt.send({type: 'conversation.item.create', item: {type: 'message', role: 'system', content: [{type: 'input_text', text: realtime.reconnectNote(this.pairs.slice(-KEEP_PAIRS))}]}});
                return lost ? this.speak(lines.say('lostThread', this.language), null, {english: lines.say('lostThread', 'en')}) : null;
            }).then(() => Promise.all([delay(this.config.echoTailMs), this.settle()])).then(() => { if (this.active && !this.turn) this.listen(); });
            return this.speechChain;
        }).catch(error => this.fail(openaiError(error)));
    }
    // A turn whose reply will never be spoken: its timers stop and its lines are not said.
    dropTurn(turn) {
        turn.skipped = true; clearTimeout(turn.waitTimer); clearTimeout(turn.guard);
        if (this.turn === turn) this.turn = null;
    }
    // why: 'start' or 'quiet' (the person starts speaking after a quiet spell).
    warm(why) {
        this.lastClassify = this.now();
        if (!(this.config.expressions && this.classify && this.classify.warm)) return;
        const at = this.since();
        Promise.resolve(this.classify.warm()).then(r => {
            if (!r || !this.active) return;
            this.log.write(Object.assign({kind: 'classifier_warm', why: why, at: at}, r));
            const switched = (r.requests || []).filter(x => x && x.switched)[0];
            if (switched) this.log.write({kind: 'classifier_switch', detail: switched.switched});
        }, () => {});
    }
    listen() {
        // No connection while reconnecting: the reconnect listens once it is back (D73).
        if (!this.active || !this.rt) return;
        const now = this.now();
        this.log.write({kind: 'listen', at: this.since(now), after_speech: this.spokenAt === null ? null : now - this.spokenAt, anim_playing: this.player.busy(),
            sent_ms: this.clock ? Math.round(this.clock.sentMs) : undefined});
        this.state = 'listening'; this.personTalking = false;
        // A touch that waited plays first: its hold keeps the microphone closed and the ring orange.
        this.playPendingPet('listen');
        this.listeningRing(); this.zeroMs = 0; this.listenStart = true;
        if (!this.startupLogged) { this.mark('listening'); this.logStartup(); }
        this.rt.send({type: 'input_audio_buffer.clear'});
        this.gate = !this.held;
        this.armSilence();
        this.sendNotes();
    }
    armSilence() {
        clearTimeout(this.silence);
        this.silence = setTimeout(() => this.finishAndLeave('silence'), this.config.silenceSeconds * 1000);
    }
    onEvent(event) {
        if (!this.active) return;
        try { this.handle(event); }
        catch (error) { this.log.write({kind: 'exception', where: event && event.type, error: String(error && error.stack || error).slice(0, 600)}); }
    }
    handle(event) {
        const turn = this.turn, type = event.type;
        // The realtime events that explain a turn (not the text/transcript deltas).
        if (/^input_audio_buffer\.(speech_started|speech_stopped|committed|cleared)$|^response\.(created|done)$|^session\.updated$/.test(type))
            this.log.write(Object.assign({kind: 'rt', type: type, state: this.state, status: event.response && event.response.status || undefined,
                details: event.response && event.response.status_details || undefined}, this.vadTiming(event)));
        if (type === 'input_audio_buffer.speech_started') {
            this.personTalking = true;
            if (this.state === 'listening') { clearTimeout(this.silence); this.silence = null; if (this.now() - this.lastClassify > QUIET_WARM_MS) this.warm('quiet'); }
            // The person goes on before Jibo says anything: drop the reply and keep listening (D90).
            // Not for a follow-up after a tool, which is Jibo's own turn.
            else if (this.state === 'thinking' && turn && !turn.skipped && !turn.followUp) this.carryOn(turn);
        } else if (type === 'input_audio_buffer.speech_stopped') {
            this.personTalking = false;
            if (this.state === 'listening') this.startTurn();
        } else if (type === 'input_audio_buffer.committed') {
            // Which conversation item holds this turn's words: its transcript is matched by it.
            if (turn && turn.itemId === undefined && event.item_id) turn.itemId = event.item_id;
        } else if (type === 'conversation.item.input_audio_transcription.completed') {
            const said = String(event.transcript || '').trim();
            // The words of a turn dropped because the person went on: kept for the next turn (D90).
            const carried = this.carriedFor(event.item_id);
            if (carried) { carried.own = said; this.log.write({kind: 'you', turn: carried.n, text: said, carried: true}); return; }
            if (this.lateWords(turn, event.item_id, said)) return;
            if (!turn || turn.transcript !== undefined || !this.mine(turn, event.item_id)) return;
            const before = carriedText(turn.before);
            turn.own = said; turn.transcript = joinWords(before, said); turn.transcriptAt = this.now(); this.heard = turn.transcript;
            this.log.write({kind: 'you', turn: turn.n, text: said, before: before ? true : undefined});
            if (!turn.transcript) return this.skip(turn, 'empty_transcript');
            // The turn's own words too: carried words in front of a goodbye would hide it.
            if (ttsText.isStop(said) || ttsText.isStop(turn.transcript)) turn.goodbye = true;
            if (this.config.expressions && this.config.reaction && this.classify) this.react(turn);
            this.pump();
        } else if (type === 'conversation.item.input_audio_transcription.failed') {
            const carried = this.carriedFor(event.item_id);
            if (carried) { if (carried.own === undefined) carried.own = ''; return; }
            if (turn && turn.transcript === undefined && this.mine(turn, event.item_id)) {
                turn.transcript = carriedText(turn.before) || null; turn.transcriptAt = this.now(); this.pump();
            }
        } else if (type === 'response.created') {
            const id = event.response && event.response.id;
            // A reply nobody is waiting for (its turn was skipped): stop it, and forget it once done.
            if (!turn || turn.skipped) { if (id) { this.rt.send({type: 'response.cancel', response_id: id}); this.droppedReplies[id] = true; } }
            else if (!turn.responseId) turn.responseId = id;
        } else if (realtime.textDelta(event) !== null) {
            if (!turn || turn.skipped || !this.ours(turn, event.response_id) || this.droppedReplies[event.response_id]) return;
            if (!this.startupLogged) this.mark('first_text');
            if (turn.firstTextAt === undefined) turn.firstTextAt = this.now();
            turn.lastTextAt = this.now();
            turn.text += realtime.textDelta(event);
            this.pump();
        } else if (type === 'response.done') {
            const response = event.response || {};
            const failure = response.status === 'failed' && response.status_details && response.status_details.error || null;
            if (failure && isFatal(failure.code)) return this.fail(Error('OpenAI: ' + failure.code));
            const output = Array.isArray(response.output) ? response.output : [];
            // A reply Jibo never said leaves the model's context (D90).
            if (response.id && this.droppedReplies[response.id]) { delete this.droppedReplies[response.id]; return this.forget(output); }
            if (!turn || turn.skipped || !this.ours(turn, response.id)) return;
            if (response.status === 'cancelled') {
                // The person went on: before Jibo spoke, drop the turn; once he spoke, say no more
                // of the reply and run none of its tools (D90).
                if (this.state === 'thinking' && !turn.followUp) { turn.output = output; return this.carryOn(turn); }
                turn.cut = true; turn.text = turn.text.slice(0, turn.sent);
                this.log.write({kind: 'cut', turn: turn.n, said: turn.sent});
            }
            turn.done = true; turn.status = response.status; turn.usage = response.usage || null; turn.output = output;
            // Function calls come as their own output items, next to (or instead of) the text.
            turn.calls = turn.cut ? [] : output.filter(item => item && item.type === 'function_call')
                .map(item => ({name: item.name, callId: item.call_id, args: item.arguments}));
            this.pump();
        } else if (type === 'error') {
            const error = event.error || {};
            if (error.code !== 'response_cancel_not_active') this.log.write({kind: 'error', code: error.code || null, message: error.message || null});
            if (isFatal(error.code)) this.fail(Error('OpenAI: ' + error.code));
        } else if (type === 'transport.closed') {
            this.dropped();
        }
    }
    // The dropped turn whose words arrive as item `itemId`: the one waiting to be carried, or the
    // one the current turn carries. null when the words are the current turn's own.
    carriedFor(itemId) {
        if (!itemId) return null;
        const turn = this.turn, carried = this.carried || (turn && turn.before) || null;
        return carried && carried.itemId === itemId && (!turn || turn.itemId !== itemId) ? carried : null;
    }
    // Remove a dropped reply's items from the conversation, so the model never builds on words
    // Jibo did not say (a half reply, or a tool call with no answer).
    forget(output) {
        if (!this.rt) return;
        output.forEach(item => { if (item && item.id) this.rt.send({type: 'conversation.item.delete', item_id: item.id}); });
    }
    // The words of the turn before a tool follow-up, transcribed only now: logged, and a goodbye in
    // them still ends the conversation; the follow-up is not held for them (D186).
    lateWords(turn, itemId, said) {
        const late = turn && turn.followUp && turn.lateItem;
        if (!late || (late !== true && itemId && late !== itemId)) return false;
        turn.lateItem = null;
        this.log.write({kind: 'you', turn: turn.n, text: said, late: true});
        if (said) { turn.transcript = said; this.heard = said; }
        if (ttsText.isStop(said)) turn.goodbye = true;
        return true;
    }
    // An event for this turn's words: its own item, or any when either id is not known.
    mine(turn, itemId) { return !itemId || !turn.itemId || turn.itemId === itemId; }
    thinkingGate() { return this.config.listenWhileThinking !== false && !this.held; }
    ours(turn, responseId) { return !turn.responseId || !responseId || turn.responseId === responseId; }
    startTurn() {
        // The microphone stays open while Jibo thinks (D89); speak() closes it.
        this.gate = this.thinkingGate(); this.state = 'thinking'; this.busyRing();
        clearTimeout(this.silence); this.silence = null;
        const turn = this.turn = {n: ++this.turns, stoppedAt: this.now(), text: '', sent: 0, lines: 0, transcript: undefined, expressions: [], lag: []};
        // The words of a turn dropped because the person went on come first (D90).
        if (this.carried) { turn.before = this.carried; this.carried = null; }
        this.heard = '';   // the dance reads this turn's words, never an earlier turn's
        // If the transcript never comes, speak anyway after a while.
        turn.waitTimer = setTimeout(() => this.pump(), this.config.transcriptWaitMs);
        this.guardReply(turn);
        this.thinking.start(turn.n);
        // A touch that waited while the person talked plays now.
        this.playPendingPet('turn');
    }
    // A reply that never comes (a half-open connection, an error instead of a response) must not
    // leave Jibo thinking with the hotword off: drop the turn and listen again. A reply that stopped
    // half way is cut after what was said, and one held back with nothing left to release it is
    // finished now (D186).
    guardReply(turn) {
        const waitMs = this.config.replyWaitMs || REPLY_WAIT_MS;
        turn.guard = setTimeout(() => {
            if (!this.active || this.turn !== turn) return;
            if (!turn.lines && !turn.done) return this.skip(turn, 'no_reply');
            if (!turn.done) {
                // Text still coming: a long reply, not a stalled one.
                if (this.now() - (turn.lastTextAt || turn.stoppedAt) < waitMs) return this.guardReply(turn);
                return this.cutStalled(turn);
            }
            if (!turn.ending) {
                this.log.write({kind: 'reply_stalled', turn: turn.n});
                this.pump();
            }
        }, waitMs);
    }
    // The reply stopped coming after Jibo began to say it: say no more of it, run none of its tools,
    // and forget the rest of it if it ever arrives (D186).
    cutStalled(turn) {
        if (this.rt) this.rt.send({type: 'response.cancel'});
        if (turn.responseId) this.droppedReplies[turn.responseId] = true;
        turn.cut = true; turn.text = turn.text.slice(0, turn.sent); turn.done = true; turn.status = 'stalled';
        this.log.write({kind: 'reply_stalled', turn: turn.n, cut: true, said: turn.sent});
        this.pump();
    }
    // Nothing understood: drop this turn's reply and listen again.
    skip(turn, reason) {
        turn.skipped = true; clearTimeout(turn.waitTimer); clearTimeout(turn.guard);
        if (!turn.done && this.rt) this.rt.send({type: 'response.cancel'});
        this.log.write({kind: 'skipped', turn: turn.n, reason: reason});
        if (this.turn === turn) this.turn = null;
        this.thinking.stop();
        this.listen();
    }
    carryOn(turn) {
        turn.skipped = true; clearTimeout(turn.waitTimer); clearTimeout(turn.guard);
        // Its reply leaves the conversation: now when it is complete, else once it is done.
        if (turn.output) this.forget(turn.output);
        else if (turn.responseId) this.droppedReplies[turn.responseId] = true;
        if (!turn.done && this.rt) this.rt.send({type: 'response.cancel'});
        this.log.write({kind: 'continued', turn: turn.n});
        // Its words go in front of the next turn's (D90), with any it carried itself; words that
        // are still on their way are filled in when they come (carriedFor).
        this.carried = {n: turn.n, itemId: turn.itemId, before: carriedText(turn.before), own: turn.own};
        if (this.turn === turn) this.turn = null;
        this.thinking.stop();
        // Blue only once the microphone is open: a hold keeps it orange (D91).
        this.state = 'listening'; this.listeningRing();
        this.gate = !this.held;
        this.armSilence();
    }
    endTurn(turn) {
        if (this.turn === turn) this.turn = null;
        clearTimeout(turn.guard);
        if (!this.active || turn.skipped) return;
        const at = t => t === undefined ? null : t - turn.stoppedAt;
        const calls = this.acts && turn.calls && turn.calls.length ? turn.calls : null;
        this.log.write({kind: 'jibo', turn: turn.n, text: replyWords(turn), language: turn.language || undefined, status: turn.status || null, reaction: turn.reaction || null, expressions: turn.expressions,
            ms: {transcript: at(turn.transcriptAt), first_text: at(turn.firstTextAt), first_speech: at(turn.firstSpeechAt), end: this.now() - turn.stoppedAt},
            usage: turn.usage || null, followUp: turn.followUp || undefined, calls: turn.calls && turn.calls.length ? turn.calls.map(c => c.name) : undefined,
            lag: turn.lag && turn.lag.length ? turn.lag : undefined});
        this.remember(turn);
        // The reply was complete but the connection dropped: its actions cannot answer the old
        // session, and the reconnect listens when it is back (D73).
        if (this.reconnecting) { if (calls) this.log.write({kind: 'calls_dropped', turn: turn.n, reason: 'reconnect'}); return; }
        if (calls) return this.act(turn, calls);
        if (turn.goodbye) return this.finishAndLeave('goodbye');
        if (!turn.lines) this.thinking.stop();
        return Promise.all([delay(this.config.echoTailMs), this.settle()]).then(() => { if (this.active && !this.turn) this.listen(); });
    }
    // The conversation so far as person/Jibo pairs, for coming back after a handover.
    remember(turn) {
        const last = this.pairs[this.pairs.length - 1];
        const words = replyWords(turn);
        if (turn.followUp && last) { if (words) last.jibo = (last.jibo ? last.jibo + ' ' : '') + words; }
        else if (turn.transcript || words) this.pairs.push({you: turn.transcript || '', jibo: words});
        if (this.pairs.length > KEEP_PAIRS) this.pairs.splice(0, this.pairs.length - KEEP_PAIRS);
    }
    // No "Hey Jibo" while Noggin has the microphone: true if asked for (this.hotword holds the token).
    hotwordOff() {
        const js = this.jibo.jetstream;
        if (!js || !js.setHotwordMode || !js.types) return false;
        try { this.hotword = js.setHotwordMode(js.types.HotwordListenMode.Disabled); } catch (_) { this.hotword = null; }
        return !!this.hotword;
    }
    // Back after a handover: tell the model what happened (and, for the clock, what is true now).
    // Jibo has already said the comeback line, so the model waits for the person; without a
    // comeback line the model says the next line (resolves true: listening follows its reply).
    resumeConversation() {
        const resume = this.resume, acts = this.acts, said = this.firstLine;
        this.pairs = (resume.pairs || []).slice(-KEEP_PAIRS);
        if (said) this.pairs.push({you: '', jibo: said});
        const check = /^(set|cancel)_(timer|alarm)$|^check_clock$/.test(resume.tool || '') && acts && acts.readClock
            ? Promise.resolve().then(() => acts.readClock()).catch(() => null) : Promise.resolve(null);
        return check.then(clock => {
            if (!this.active) return true;
            if (!this.rt) return false;
            this.mark('resume_timer_read');
            this.log.write({kind: 'resume', tool: resume.tool || null, pairs: this.pairs.length, said: String(resume.said || '').slice(0, 300), clock: clock});
            this.rt.send({type: 'conversation.item.create', item: {type: 'message', role: 'system', content: [{type: 'input_text', text: realtime.resumeNote(resume, clock, said)}]}});
            if (said) return false;
            this.followUp(null, 1);
            return true;
        });
    }
    // Jibo says what went wrong in his own words (D70, D71). Ends with reason 'trouble_<cause>'
    // (index.js shows the setup screen for some) or 'error'.
    fail(error) {
        if (!this.active || this.failing) return;
        this.failing = true; this.gate = false;
        clearTimeout(this.silence); this.silence = null;
        const message = String(error && error.message || error);
        if (!this.startupLogged) { this.mark('failed'); this.logStartup({failed: message.slice(0, 200)}); }
        this.log.write({kind: 'failed', error: message});
        const known = trouble.fromMessage(message);
        const found = known ? Promise.resolve({cause: known, detail: message.slice(0, 80)})
            : error && error.openai && this.diagnoseFn ? Promise.resolve().then(() => this.diagnoseFn()).catch(() => ({cause: 'unknown', detail: 'check failed'}))
            : Promise.resolve({cause: 'unknown', detail: null});
        // No more of the current reply, and no turn timer reopening the microphone meanwhile.
        if (this.turn) this.dropTurn(this.turn);
        this.thinking.stop();
        let cause = 'unknown';
        found.then(result => {
            if (!this.active) return;
            const t = trouble.cause(result && result.cause, this.language);
            cause = t.cause;
            this.log.write({kind: 'trouble', cause: cause, detail: result && result.detail || null});
            // A line already playing (the greeting) ends first, so the reason is never cut off; a Dutch
            // line still playing after that is ended, so the Dutch voice is free for the reason (D175).
            return this.untilQuiet(QUIET_MS).then(() => {
                if (!this.active) return null;
                if (this.dutchLines > 0) this.voice.cancel();
                const english = lines.say('trouble.' + t.cause, 'en');
                return this.speak(t.line, null, Object.assign({english: english}, t.emoji ? {anim: t.emoji, emoji: cause, via: 'trouble', hotWords: false} : {}));
            });
        }).then(() => this.leave(cause === 'unknown' ? 'error' : 'trouble_' + cause), () => this.leave('error'));
    }
    // Resolves once Jibo is not speaking, or after `ms`.
    untilQuiet(ms) {
        const until = this.now() + ms;
        return new Promise(resolve => {
            const look = () => (!this.speaking || this.now() >= until ? resolve() : setTimeout(look, 50));
            look();
        });
    }
    leave(reason) { return this.close(reason); }
    // An ending Jibo chose (goodbye, silence): let the last expression end in its pose first, so
    // close never cuts a body animation half way. At most FINISH_MS.
    finishAndLeave(reason) {
        this.gate = false;
        return this.untilStill(Conversation.FINISH_MS).then(() => this.leave(reason));
    }
    // Idempotent; the first reason wins and resolves open().
    close(reason) {
        if (this.closing) return this.closing;
        reason = reason || 'closed';
        // The switch a handover asked for: say so, rather than "closed" or "skill_switch".
        if (this.handover && /^(closed|skill_switch|global_turn)$/.test(reason)) reason = this.handover.reason;
        clearTimeout(this.handoverTimer);
        const wasActive = this.active, jibo = this.jibo, cleanup = [];
        this.active = false; this.gate = false; this.state = 'closed';
        clearInterval(this.monitor); clearInterval(this.ringTimer); clearInterval(this.lagTimer); clearTimeout(this.silence);
        this.stopSenses();
        if (this.audioTimer) { clearInterval(this.audioTimer); if (wasActive) this.audioReport(); }
        if (this.turn) { clearTimeout(this.turn.waitTimer); clearTimeout(this.turn.guard); }
        this.unwatch.splice(0).forEach(off => off());
        try { this.mic.stop(); } catch (_) {}
        if (this.rt) this.rt.close();
        this.speakTimers.forEach(timer => clearTimeout(timer)); this.speakTimers.clear();
        cleanup.push(this.thinking.stop());
        const midMove = this.player.busy() || this.dancing;
        const clipStopped = this.player.stopCurrent('closed');
        const speech = jibo.embodied && jibo.embodied.speech;
        const speechStopped = this.speaking && speech && speech.stop ? Promise.resolve().then(() => speech.stop()) : Promise.resolve();
        // A Dutch line also ends its routing to the Dutch voice at once (D169).
        if (this.dutchLines > 0) this.voice.cancel();
        cleanup.push(clipStopped, speechStopped);
        // A clip or dance stopped half way leaves Jibo in its pose: back to neutral (not the base, D116).
        if (midMove && !this.isPrivate()) cleanup.push(Promise.all([clipStopped, speechStopped]).catch(() => {}).then(() => this.player.centre({force: true})));
        const hotword = this.hotword; this.hotword = null;
        if (hotword) cleanup.push(Promise.resolve().then(() => hotword.release()));
        if (wasActive) { this.led(OFF); this.log.write({kind: 'session_end', reason: reason, turns: this.turns, lines: this.lineLanguages}); }
        // A platform call that never answers must not keep the skill open.
        this.closing = Promise.all(cleanup.map(p => Promise.race([p.catch(() => {}), delay(1500)]))).then(() => {
            if (this.log.close) this.log.close();
            if (this.finish) this.finish(reason);
        });
        return this.closing;
    }
}
// An OpenAI error that ends the conversation at once: no credit, a refused key, rate limited, wrong model.
function isFatal(code) { return !!trouble.fromCode(code); }
// Marks a failure as OpenAI's, so fail() asks what went wrong (D71).
function openaiError(error) {
    if (!(error instanceof Error)) error = Error(String(error));
    error.openai = true;
    return error;
}
const QUIET_MS = 6000;   // the longest fail() waits for a line already playing
Conversation.MIC_START_MS = 8000;   // a microphone that never starts ends the conversation (D16)
Conversation.FINISH_MS = 2000;      // the longest a goodbye waits for the last expression
Conversation.SPEAK_BASE_MS = 10000; // the longest a line may take, plus 120 ms per character (D114)
Object.assign(Conversation.prototype, micMethods, lineMethods, toolMethods, senseMethods);
module.exports = Conversation;
