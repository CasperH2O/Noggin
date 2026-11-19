// SPDX-License-Identifier: MIT
// Noggin: one voice conversation. The realtime model hears Jibo's microphone and
// answers in text; Jibo reacts to what he heard with a quick expression, then speaks each
// line in his own voice with an expression picked by OpenAI's Decisions API (lib/openai.js).
//
//   listening --(server: speech stopped)--> thinking --(first line)--> speaking --> listening
//
// Half-duplex: no audio is sent while Jibo thinks or speaks, and for `echoTailMs` after,
// so he never answers his own voice. A reply is only spoken once the transcript of what
// the person said is known (or `transcriptWaitMs` passed); an empty transcript means
// nothing was understood, and the reply is cancelled instead of spoken.
// Actions (lib/actions.js): the model may call a tool. about_jibo, dance, set_volume and
// check_clock run in Noggin and the model then answers with the result (a follow-up reply in the
// same turn). get_time, the timer and alarm tools, use_skill and open_app hand over to another skill,
// which closes Noggin; index.js comes back to Noggin when that skill is done, and Noggin resumes the
// conversation without a greeting. play_music and play_radio hand over for good. The cloud tools
// (the `cloudSkills` setting) give the hotword back and ask Jibo's cloud a fixed phrase; @be/nimbus
// answers, and Noggin comes back the same way.
//
// Ends on a goodbye, `silenceSeconds` without speech, swipe down, privacy, a skill
// switch, a handover, or a lost connection. Session patterns (hotword off, LED colours, thinking
// eye, stop phrases) follow BEam's Agent Mode (BSD-3-Clause, @be/be skills/agent).
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const core = require('./core'), actions = require('./actions'), ExpressionPlayer = require('./expression');

// Ring: blue while Jibo listens, orange (blue's opposite on the colour wheel) while he
// thinks and speaks. The LED takes whatever was set last, with nothing restoring it: some
// animations (speech's hot-word glances such as "Maybe", "I think", "Oh.") key the ring to
// black and leave it black. So the colour is re-sent every ringRefreshMs while a
// conversation runs, as BEam's Agent Mode does on every frame.
const LISTENING = [0, 0.45, 1], BUSY = [1, 0.55, 0], OFF = [0, 0, 0];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// An emoji stays on the eye about as long as Jibo says its line (about 75 ms per character),
// never shorter than EMOJI_MIN_MS and never longer than EMOJI_MAX_MS.
const EMOJI_MIN_MS = 3000, EMOJI_MAX_MS = 4500, EMOJI_MS_PER_CHAR = 75;
function emojiHoldMs(text) {
    const spoken = String(text || '').length * EMOJI_MS_PER_CHAR;
    return Math.min(EMOJI_MAX_MS, Math.max(EMOJI_MIN_MS, spoken));
}
const MAX_ROUNDS = 2, REPLY_WAIT_MS = 15000, KEEP_PAIRS = 10;
// How Noggin plays an expression (config expressionPlay):
// - 'esml': inside the line's ESML, and each line waits for its animation.
// - 'esml-tts': inside the line's ESML, but the line is done when its words are
//   (speak's dispatchComplete TTS); the animation finishes on its own.
// - 'animdb': next to the line through the animation database (lib/expression.js), with
//   its LED channels taken out; the line is done when its words are.
// In both new modes the reaction plays through the animation database at once.
const PLAY_MODES = ['esml', 'esml-tts', 'animdb'];
const RECENT_ANIMS = 5;   // a mood's animation is not repeated within this many expressions
const RECENT_DANCES = 3;  // no dance again within this many dances (unless asked for "again")

// Jibo's native thinking loop on the eye (as BEam's Agent Mode, AnimDB two-stage API).
class ThinkingEye {
    constructor(jibo, allowed) { this.jibo = jibo; this.allowed = allowed; }
    start() {
        if (!this.allowed() || !this.jibo.animDB || this.token) return;
        const token = this.token = {};
        Promise.resolve().then(() => {
            if (this.token !== token || !this.allowed()) return null;
            const asset = this.jibo.animDB.getAnimByName('Thinking_Eye_Loop_01');
            return asset ? asset.createFromConfig({loops: 0, cache: 'global'}) : null;
        }).then(playback => {
            if (!playback) return;
            if (this.token !== token || !this.allowed()) return playback.stop();
            this.playback = playback;
            return playback.play({disableSetFaceAnim: false, screenCenterOverride: true, ownerInformation: 'Behavior'});
        }).catch(() => {});
    }
    stop() {
        this.token = null;
        const playback = this.playback; this.playback = null;
        if (!playback) return Promise.resolve();
        return Promise.resolve().then(() => playback.stop()).catch(() => {}).then(() => {
            const jibo = this.jibo, expression = jibo.expression;
            if ((jibo.privacyController && jibo.privacyController.enabled) || !expression || !expression.centerRobot) return;
            return expression.centerRobot({requestor: 'Behavior', centerGlobally: false, dofs: expression.dofs.EYE});
        }).catch(() => {});
    }
}

class Conversation {
    // deps: {jibo, config, instructions, persona: {edited, chars, facts} (for the log), connect(), mic, classify(personSaid, jiboSays), log, now(),
    //        actions: {redirect(pkg, options), cloud(phrase), handover(state), handoverFailed(), readClock(), setVolume(args), installed(pkg), localTime(), facts()} or null,
    //        resume: {pairs, tool, args, said} when coming back after a handover,
    //        openedAt: when the skill's open() began (Date.now()), startup: facts for the startup log}
    constructor(deps) {
        this.jibo = deps.jibo; this.config = deps.config; this.instructions = deps.instructions; this.persona = deps.persona;
        this.connectFn = deps.connect; this.mic = deps.mic; this.classify = deps.classify; this.log = deps.log || {write() {}};
        this.now = deps.now || (() => Date.now()); this.random = deps.random || Math.random;
        this.active = false; this.state = 'idle'; this.gate = false; this.turn = null; this.turns = 0;
        this.audio = {blocks: 0, sent: 0, levels: []}; this.lastClassify = 0;
        this.rt = null; this.unwatch = []; this.speechChain = Promise.resolve(); this.speaking = false;
        this.policy = new core.ExpressionPolicy(this.config.expressionGapMs);
        this.acts = deps.actions || null; this.resume = deps.resume || null; this.pairs = []; this.handover = null;
        // Startup timing: ms since the skill's open() for each step, logged once as `startup`
        // when Jibo first listens (or with the failure, if he never gets there).
        this.t0 = typeof deps.openedAt === 'number' ? deps.openedAt : this.now();
        this.boot = Object.assign({}, deps.startup || {}); this.marks = {}; this.mark('talk_created');
        this.thinking = new ThinkingEye(this.jibo, () => this.config.thinkingEye !== false && this.active && !this.isPrivate() && this.state === 'thinking');
        this.player = new ExpressionPlayer(this.jibo, this.log, this.now, t => t - this.t0, () => this.active && !this.isPrivate());
        this.speechAnims = null; this.spokenAt = null; this.recentAnims = []; this.recentEmoji = []; this.lastEmojiAt = -Infinity;
        this.heard = ''; this.recentDances = []; this.danceCount = 0; this.announcedAt = -Infinity;
    }
    // An eye emoji for a word in Jibo's line: at most one per emojiGapMs, and not the same word
    // again within the last ten. (speak() holds it back while another expression still plays.)
    emojiFor(text) {
        const config = this.config, now = this.now();
        if (config.emoji === false || now - this.lastEmojiAt < config.emojiGapMs) return null;
        const found = core.emojiFor(text, {recent: this.recentEmoji});
        if (!found) return null;
        this.lastEmojiAt = now;
        this.recentEmoji.push(found.word); if (this.recentEmoji.length > 10) this.recentEmoji.shift();
        return found;
    }
    mode() { return PLAY_MODES.indexOf(this.config.expressionPlay) >= 0 ? this.config.expressionPlay : 'animdb'; }
    // The animation for an expression label and size: a random fitting one from the catalogue,
    // not one of the last few. Animations with an LED layer only where their LED channels are
    // removed (animdb). The greeting's smile is fixed; the dance has its own chooser (dance()).
    choose(label, size) {
        if (!label || label === 'none') return null;
        if (!core.MOODS[label] || label === 'dance') return core.animFor(label);
        const name = core.pickAnimation(label, size, {led: this.mode() === 'animdb', recent: this.recentAnims});
        if (name) { this.recentAnims.push(name); if (this.recentAnims.length > RECENT_ANIMS) this.recentAnims.shift(); }
        return name;
    }
    since(t) { return Math.round((t === undefined ? this.now() : t) - this.t0); }
    // Speak options: done when the words are, except in the old 'esml' mode.
    speakOptions() { return this.mode() === 'esml' ? null : {dispatchComplete: 'TTS'}; }
    isPrivate() { return !!(this.jibo.privacyController && this.jibo.privacyController.enabled); }
    mark(name, at) { if (this.marks[name] === undefined) this.marks[name] = Math.round((at === undefined ? this.now() : at) - this.t0); }
    logStartup(extra) {
        if (this.startupLogged) return;
        this.startupLogged = true;
        this.log.write(Object.assign({kind: 'startup', resumed: this.resume ? this.resume.tool || true : false, ms: this.marks}, this.boot, extra || {}));
    }
    led(color) { this.ring = color; try { if (!this.isPrivate() && this.jibo.expression) this.jibo.expression.setLEDColor(color); } catch (_) {} }
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
        this.log.write({kind: 'session', realtimeModel: config.realtimeModel, transcribeModel: config.transcribeModel, turnDetection: config.turnDetection,
            classifierModel: config.expressions ? config.classifierModel : null, actions: !!this.acts, resumed: this.resume ? this.resume.tool || true : undefined,
            expressionPlay: this.mode(), lab: config.lab || undefined, persona: this.persona || undefined});
        if (this.isPrivate()) { this.leave('privacy'); return this.done; }
        this.monitor = setInterval(() => { if (this.isPrivate()) this.leave('privacy'); }, 250);
        this.led(BUSY);
        if (config.ringRefreshMs > 0) this.ringTimer = setInterval(() => { if (this.active && this.ring) this.led(this.ring); }, Math.max(20, config.ringRefreshMs));
        const js = jibo.jetstream;
        if (js && js.events) {
            this.watch(js.events.skillSwitch, () => this.leave('skill_switch'));
            this.watch(js.events.globalTurnStarted, () => this.leave('global_turn'));
        }
        const gestures = jibo.face && jibo.face.gestures;
        if (gestures && gestures.addStageGesture && gestures.hammer) {
            try {
                const gesture = gestures.addStageGesture(gestures.hammer.Swipe, {event: 'nogginSwipeDown', direction: gestures.hammer.DIRECTION_DOWN, threshold: 50, velocity: 0.3}, () => this.leave('swipe'));
                this.unwatch.push(() => { try { gestures.removeStageGesture(gesture); } catch (_) {} });
            } catch (_) {}
        }
        // Opened from the menu, the menu view would stay replaced by nothing: show Jibo's
        // own eye for the conversation, as BEam's Nimbus and Remote do.
        const views = jibo.face && jibo.face.views;
        const eye = (views && typeof views.forceEyeView === 'function'
            ? Promise.race([new Promise(resolve => { try { views.forceEyeView(() => resolve('shown')); } catch (_) { resolve('error'); } }), delay(1500).then(() => 'timeout')])
            : Promise.resolve('none')).then(result => { this.mark('eye'); this.boot.eye = result; });
        if (config.lab === 'expressions' || config.lab === 'animdb' || config.lab === 'timing') {
            eye.then(() => config.lab === 'timing' ? this.runTiming() : this.runLab()).then(() => this.leave('lab'), error => this.fail(error));
            return this.done;
        }
        // Everything else starts at once and runs side by side; Jibo listens when all of it is done.
        // No "Hey Jibo" during the conversation: the microphone is ours. Ask now; only listening
        // has to wait for it (at most 2 s: in the simulator it never confirms).
        let hotword = Promise.resolve('none');
        if (this.hotwordOff()) {
            hotword = Promise.race([Promise.resolve(this.hotword && this.hotword.activated).then(() => 'off', () => 'error'), delay(2000).then(() => 'timeout')]);
        }
        hotword = hotword.then(result => { this.mark('hotword'); this.boot.hotword = result; });
        // The first line is fixed text: Jibo says it as soon as his eye shows, while OpenAI connects.
        // That is the greeting, or, back from the clock, the comeback line ("Anything else?").
        const first = this.resume ? config.comebackLine || '' : config.greeting || '';
        this.firstLine = first;
        const greeted = !first ? Promise.resolve() : eye.then(() => {
            if (!this.active) return;
            this.mark('first_speech_queued');
            const label = this.resume ? null : config.greetingExpression;
            const expression = (core.EXTRA[label] || core.MOODS[label]) && label !== 'dance' ? label : null;
            if (core.MOODS[expression]) this.policy.used(expression, this.now());
            return this.speak(first, expression);
        });
        // A failure waits for the greeting, so Jibo finishes his "Hi!" before he apologises.
        const afterGreeting = promise => promise.catch(error => greeted.then(() => { throw error; }));
        const connected = afterGreeting(this.connect());
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
            const timing = rt.timing || {};
            if (timing.open) this.mark('socket_open', timing.open);
            this.mark('session_created', timing.created || undefined);
            rt.listen(event => this.onEvent(event));
            const updated = this.waitFor(['session.updated'], 10000);
            rt.send(core.sessionUpdate(config, this.instructions, this.acts ? actions.tools(config) : null));
            return updated.then(() => { this.mark('session_updated'); this.log.write({kind: 'connected', ms: this.now() - started}); this.warm(); });
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
                    reject(Error('OpenAI: ' + (event.error ? event.error.code || event.error.message : 'connection closed')));
                }
            });
        });
    }
    warm() {
        this.lastClassify = this.now();
        if (this.config.expressions && this.classify && this.classify.warm) this.classify.warm();
    }
    // A microphone that never answers must not hold the conversation open with the hotword off.
    startMic() {
        this.micStarts = (this.micStarts || 0) + 1;
        const mic = this.mic, limit = Conversation.MIC_START_MS;
        let timer = null, late = false;
        const started = Promise.resolve().then(() => mic.start((pcm, level) => this.onAudio(pcm, level)));
        // Started after giving up or after the conversation closed: close it again, or the
        // capture would stay open (a pending Web Audio start cannot be stopped earlier).
        started.then(() => { if (late || !this.active) { try { mic.stop(); } catch (_) {} } }, () => {});
        const timeout = new Promise((resolve, reject) => {
            timer = setTimeout(() => { late = true; reject(Error('microphone did not start within ' + limit / 1000 + ' s')); }, limit);
        });
        const done = () => clearTimeout(timer);
        return Promise.race([started, timeout]).then(value => { done(); return value; }, error => { done(); throw error; });
    }
    onAudio(pcm, level) {
        const stats = this.audio;
        stats.blocks++;
        if (stats.blocks === 1) this.mark('first_audio');
        if (typeof level === 'number') stats.levels.push(level);
        this.watchZeros(pcm, level);
        if (!this.active || !this.gate || !this.rt) return;
        stats.sent++;
        this.rt.send({type: 'input_audio_buffer.append', audio: core.base64(pcm)});
    }
    // A real microphone always hears some noise; exact digital silence means no sound reaches
    // us. On the robot that happens while Jibo speaks and usually clears soon after, so only
    // `micSilentMs` of it while listening restarts the microphone.
    watchZeros(pcm, level) {
        if (level <= -119) {
            if (this.state !== 'listening' || this.restarting || !this.active) return;
            this.zeroMs = (this.zeroMs || 0) + (pcm && pcm.length ? pcm.length / (core.RATE / 1000) : 0);
            if (this.zeroMs >= (this.config.micSilentMs || 3000)) this.restartMic('silent');
            return;
        }
        if (this.restarting) return;
        if (this.micRestarts) { this.log.write({kind: 'microphone_ok', after_restarts: this.micRestarts}); this.micRestarts = 0; }
        // How long the silence left over from Jibo's speech lasted once he listened again.
        else if (this.zeroMs && this.state === 'listening' && this.listenStart) this.log.write({kind: 'microphone_zeros_cleared', ms: Math.round(this.zeroMs)});
        if (this.state === 'listening') this.listenStart = false;
        this.zeroMs = 0;
    }
    // The arecord process ended on its own: log why (an ALSA error shows in stderr) and start it again.
    onMicExit(report) {
        if (!this.active) return;
        this.log.write(Object.assign({kind: 'microphone_exit'}, report));
        if (!this.restarting) this.restartMic('exit');
    }
    // reason: 'silent' (digital silence), 'exit' (the process ended) or 'failed' (a restart failed).
    restartMic(reason) {
        if (!this.active) return Promise.resolve();
        this.restarting = true; this.zeroMs = 0;
        this.micRestarts = (this.micRestarts || 0) + 1;
        if (reason === 'silent') this.log.write({kind: 'microphone_silent', restart: this.micRestarts});
        if (this.micRestarts > 3) {
            this.restarting = false; this.gate = false;
            const why = reason === 'silent' ? 'microphone_silent' : 'microphone_failed';
            this.speechChain = this.speechChain.then(() => this.speak("Sorry, I can't hear anything right now. Let's try again later.", null)).then(() => this.leave(why));
            return this.speechChain;
        }
        try { this.mic.stop(); } catch (_) {}
        return delay(300).then(() => this.active ? this.startMic() : null).then(() => {
            this.restarting = false;
            if (this.active) this.log.write({kind: 'microphone_restarted', restart: this.micRestarts, label: this.mic.label || null});
        }, error => {
            this.restarting = false;
            this.log.write({kind: 'microphone_failed', error: String(error && error.message || error).slice(0, 300)});
            return this.restartMic('failed');
        });
    }
    // Every 10 s: how much audio came from the microphone, how much went to OpenAI, how loud.
    // Text only; this is what tells a dead or silent microphone apart from a deaf server.
    audioReport() {
        const stats = this.audio, levels = stats.levels.slice().sort((a, b) => a - b);
        const at = p => levels.length ? Math.round(levels[Math.min(levels.length - 1, Math.floor(p * levels.length))]) : null;
        let mem = null;
        try { const m = process.memoryUsage(); if (m.rss) mem = {rss: Math.round(m.rss / 1048576), heap: Math.round(m.heapUsed / 1048576)}; } catch (_) {}
        this.log.write({kind: 'audio', state: this.state, source: this.mic.kind || null, blocks: stats.blocks, sent: stats.sent,
            db: {min: at(0), median: at(0.5), p90: at(0.9), max: at(1)}, mem: mem, micStarts: this.micStarts || 0});
        this.audio = {blocks: 0, sent: 0, levels: []};
    }
    listen() {
        if (!this.active) return;
        const now = this.now();
        this.log.write({kind: 'listen', at: this.since(now), after_speech: this.spokenAt === null ? null : now - this.spokenAt, anim_playing: this.player.busy()});
        this.state = 'listening'; this.led(LISTENING); this.zeroMs = 0; this.listenStart = true;
        if (!this.startupLogged) { this.mark('listening'); this.logStartup(); }
        this.rt.send({type: 'input_audio_buffer.clear'});
        this.gate = true;
        this.armSilence();
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
            this.log.write({kind: 'rt', type: type, state: this.state, status: event.response && event.response.status || undefined,
                details: event.response && event.response.status_details || undefined});
        if (type === 'input_audio_buffer.speech_started') {
            if (this.state === 'listening') { clearTimeout(this.silence); this.silence = null; if (this.now() - this.lastClassify > 20000) this.warm(); }
            // Only a pause, not the end: the person goes on before Jibo says anything. The
            // server drops its reply; keep listening, without clearing what it already heard.
            else if (this.state === 'thinking' && turn && !turn.lines && !turn.skipped) this.carryOn(turn);
        } else if (type === 'input_audio_buffer.speech_stopped') {
            if (this.state === 'listening') this.startTurn();
        } else if (type === 'conversation.item.input_audio_transcription.completed') {
            if (!turn || turn.transcript !== undefined) return;
            turn.transcript = String(event.transcript || '').trim(); turn.transcriptAt = this.now(); this.heard = turn.transcript;
            this.log.write({kind: 'you', turn: turn.n, text: turn.transcript});
            if (!turn.transcript) return this.skip(turn, 'empty_transcript');
            if (core.isStop(turn.transcript)) turn.goodbye = true;
            if (this.config.expressions && this.config.reaction && this.classify) this.react(turn);
            this.pump();
        } else if (type === 'conversation.item.input_audio_transcription.failed') {
            if (turn && turn.transcript === undefined) { turn.transcript = null; turn.transcriptAt = this.now(); this.pump(); }
        } else if (type === 'response.created') {
            const id = event.response && event.response.id;
            // A reply nobody is waiting for (its turn was skipped): stop it.
            if (!turn || turn.skipped) { if (id) this.rt.send({type: 'response.cancel', response_id: id}); }
            else if (!turn.responseId) turn.responseId = id;
        } else if (core.textDelta(event) !== null) {
            if (!turn || turn.skipped || !this.ours(turn, event.response_id)) return;
            if (!this.startupLogged) this.mark('first_text');
            if (turn.firstTextAt === undefined) turn.firstTextAt = this.now();
            turn.text += core.textDelta(event);
            this.pump();
        } else if (type === 'response.done') {
            const response = event.response || {};
            if (!turn || turn.skipped || !this.ours(turn, response.id)) return;
            turn.done = true; turn.status = response.status; turn.usage = response.usage || null;
            // Function calls come as their own output items, next to (or instead of) the text.
            turn.calls = (Array.isArray(response.output) ? response.output : []).filter(item => item && item.type === 'function_call')
                .map(item => ({name: item.name, callId: item.call_id, args: item.arguments}));
            this.pump();
        } else if (type === 'error') {
            const error = event.error || {};
            if (error.code !== 'response_cancel_not_active') this.log.write({kind: 'error', code: error.code || null, message: error.message || null});
        } else if (type === 'transport.closed') {
            this.fail(Error('connection_lost'));
        }
    }
    ours(turn, responseId) { return !turn.responseId || !responseId || turn.responseId === responseId; }
    startTurn() {
        this.gate = false; this.state = 'thinking'; this.led(BUSY);
        clearTimeout(this.silence); this.silence = null;
        const turn = this.turn = {n: ++this.turns, stoppedAt: this.now(), text: '', sent: 0, lines: 0, transcript: undefined, expressions: []};
        this.heard = '';   // the dance reads this turn's words, never an earlier turn's
        // If the transcript never comes, speak anyway after a while.
        turn.waitTimer = setTimeout(() => this.pump(), this.config.transcriptWaitMs);
        this.guardReply(turn);
        this.thinking.start();
    }
    // A reply that never comes (a half-open connection, an error instead of a response) must not
    // leave Jibo thinking with the hotword off: drop the turn and listen again.
    guardReply(turn) {
        turn.guard = setTimeout(() => {
            if (this.active && this.turn === turn && !turn.lines && !turn.done) this.skip(turn, 'no_reply');
        }, this.config.replyWaitMs || REPLY_WAIT_MS);
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
    // A quick expression on hearing the person (Jibo's face reacts before he answers).
    react(turn) {
        const started = this.now();
        turn.reacting = Promise.resolve().then(() => this.classify(turn.transcript, null, 'reaction')).then(result => {
            result = result || {};
            this.noteClassifier(result);
            turn.reaction = {label: result.label === undefined ? null : result.label, confidence: result.confidence === undefined ? null : result.confidence,
                size: result.size || null, ms: this.now() - started};
            if (turn.firstSpeechAt !== undefined && turn.reaction.label && turn.reaction.label !== 'none') turn.reaction.played = 'late';
            // Nothing queued to say yet: react now, while Jibo works out his answer.
            if (this.active && !turn.skipped && this.turn === turn && !turn.lines) {
                // In the new modes the reaction plays next to whatever comes, so it never holds up a line.
                if (this.mode() === 'esml') this.speechChain = this.speechChain.then(() => this.playReaction(turn));
                else this.playReaction(turn);
            }
        }, () => { turn.reaction = {label: null}; });
    }
    playReaction(turn) {
        const reaction = turn.reaction, speech = this.jibo.embodied && this.jibo.embodied.speech;
        if (!this.active || turn.skipped || turn.reactionDone || !reaction || turn.firstSpeechAt !== undefined) return Promise.resolve();
        turn.reactionDone = true;
        if (!this.policy.allow(reaction.label, this.now(), turn.transcript)) { if (reaction.label && reaction.label !== 'none') reaction.played = 'limit'; return Promise.resolve(); }
        this.policy.used(reaction.label, this.now()); reaction.played = 'before';
        this.thinking.stop();
        const anim = reaction.play = this.choose(reaction.label, reaction.size);
        if (this.mode() !== 'esml') { this.player.play(anim, {via: 'reaction', turn: turn.n}); return Promise.resolve(); }
        if (!speech || typeof speech.speak !== 'function') return Promise.resolve();
        this.log.write({kind: 'speak', turn: turn.n, reaction: reaction.label, play: anim});
        return Promise.resolve().then(() => speech.speak(core.animEsml(anim))).catch(() => {});
    }
    noteClassifier(result) {
        if (result.switched) this.log.write({kind: 'classifier_switch', detail: result.switched});
        else if (result.error) this.log.write({kind: 'classifier_error', api: result.api || null, status: result.status || null, error: result.error});
    }
    carryOn(turn) {
        turn.skipped = true; clearTimeout(turn.waitTimer); clearTimeout(turn.guard);
        if (!turn.done && this.rt) this.rt.send({type: 'response.cancel'});
        this.log.write({kind: 'continued', turn: turn.n});
        if (this.turn === turn) this.turn = null;
        this.thinking.stop();
        this.state = 'listening'; this.led(LISTENING);
        this.gate = true;
        this.armSilence();
    }
    // Move finished text from the reply into the speech queue.
    pump() {
        const turn = this.turn;
        if (!this.active || !turn || turn.skipped) return;
        if (turn.transcript === undefined && this.now() - turn.stoppedAt < this.config.transcriptWaitMs - 5) return;
        if (!turn.lines) {
            const end = core.firstSentenceEnd(turn.text);
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
    }
    enqueue(turn, text) {
        core.chunks(text).forEach(piece => {
            if (!core.speechText(piece)) return;
            const index = turn.lines++, config = this.config;
            let ready = null, readySize = null;
            // A classifier problem only costs the expression, never the words.
            if (config.expressions && this.classify) this.lastClassify = this.now();
            const label = config.expressions && this.classify ? Promise.resolve().then(() => this.classify(turn.transcript || '', piece, 'line')).then(result => {
                if (result) this.noteClassifier(result);
                ready = result && result.label !== undefined ? result.label : null;
                readySize = result && result.size || null;
                // Too late for the first line: offer it to the next one instead.
                if (index === 0 && turn.firstLate && ready && ready !== 'none') turn.carried = {label: ready, size: readySize};
                return ready;
            }, () => null) : Promise.resolve(null);
            const wait = index === 0 ? config.expressionWaitMs : 0;
            this.speechChain = this.speechChain.then(() => {
                if (!this.active || turn.skipped) return;
                // The first line also waits (within the same budget) for the reaction.
                const both = index === 0 && turn.reacting ? Promise.all([label, turn.reacting]).then(() => ready) : label;
                return Promise.race([both, delay(wait).then(() => ready)]).then(found => {
                    if (!this.active) return;
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
                    turn.expressions.push(found === null ? (index === 0 && wait ? 'late' : null) : found + (use || found === 'none' ? '' : ' (held back)'));
                    if (index === 0) turn.firstSpeechAt = this.now();
                    // No expression on this line: an eye emoji for something Jibo names (pizza, rain, a dog).
                    const emoji = !use && found !== 'dance' ? this.emojiFor(piece) : null;
                    if (emoji) turn.expressions.push('emoji ' + emoji.word);
                    return this.speak(piece, use, emoji ? {turn: turn.n, line: index, anim: emoji.name, emoji: emoji.word, via: 'emoji'} : {turn: turn.n, line: index, size: use ? size : null});
                });
            });
        });
    }
    // Each speak is logged before it starts: if BE ever dies mid-speech, the log shows what played.
    speak(text, expression, at) {
        if (!this.active) return Promise.resolve();
        const turn = at ? at.turn : null, line = at ? at.line : null;
        const speech = this.jibo.embodied && this.jibo.embodied.speech;
        this.thinking.stop();
        this.state = 'speaking'; this.gate = false; this.led(BUSY);
        if (!speech || typeof speech.speak !== 'function') return Promise.resolve();
        this.speaking = true;
        let chain = Promise.resolve();
        // The dance has its own music: play it before the words, not under them.
        if (expression === 'dance') {
            chain = chain.then(() => this.dance(this.heard, turn));
            expression = null;
        }
        // at.anim: an animation by name (the lab) instead of an expression label.
        const anim = at && at.anim ? at.anim : this.choose(expression, at && at.size), mode = this.mode();
        return chain.then(() => {
            if (!this.active) return;
            let words = core.esml(text, null), lead = Promise.resolve();
            // animdb: start the animation first, so it holds Jibo's body before speech's own
            // gestures ask for it; the words follow once it started (at most expressionLeadMs).
            // An emoji while the previous expression still plays: it follows once that one ends,
            // if Jibo is still saying this line (the words don't wait for it).
            const later = anim && mode === 'animdb' && at && at.emoji && this.player.busy();
            const token = this.lineToken = {};
            const holdMs = at && at.emoji ? emojiHoldMs(text) : 0;
            if (later) {
                this.player.idle().then(() => { if (this.active && this.lineToken === token) this.player.play(anim, {via: 'emoji', turn: turn, line: line, holdMs: holdMs}); });
            } else if (anim && mode === 'animdb') {
                const played = this.player.play(anim, {via: at && at.via || 'line', turn: turn, line: line, holdMs: holdMs});
                lead = Promise.race([played.started, delay(this.config.expressionLeadMs || 0)]);
            } else if (anim) words = core.animEsml(anim) + words;
            return lead.then(() => {
                if (!this.active) return;
                const started = this.now(), options = this.speakOptions();
                this.log.write({kind: 'speak', turn: turn, line: line, expression: expression || null, size: at && at.size || undefined, emoji: at && at.emoji || undefined, after: later || undefined,
                    play: anim || undefined, mode: mode, at: this.since(started), text: String(text).slice(0, 300)});
                this.mark('first_speech');
                return Promise.resolve(options ? speech.speak(words, options) : speech.speak(words)).then(() => this.spoken(speech, started, turn, line, mode));
            });
        }).catch(() => {}).then(() => { this.speaking = false; if (this.marks.first_speech !== undefined) this.mark('first_speech_done'); });
    }
    // A line's words are done. In the new modes speech's animations may still play: log when they end.
    spoken(speech, started, turn, line, mode) {
        const now = this.spokenAt = this.now();
        this.lineToken = null;
        this.log.write({kind: 'spoken', turn: turn, line: line, mode: mode, ms: now - started, at: this.since(now)});
        this.speechAnims = null;
        if (mode === 'esml' || typeof speech.waitForAnimDispatch !== 'function') return;
        this.speechAnims = Promise.resolve().then(() => speech.waitForAnimDispatch()).catch(() => {}).then(() => {
            if (this.active) this.log.write({kind: 'speech_anims', turn: turn, line: line, ms: this.now() - started, at: this.since()});
        });
        return undefined;
    }
    // Before the microphone opens: with expressionTailMs, wait (at most that long) for what is
    // still playing, Noggin's own expression and the animations of speech's last line.
    settle() {
        const tail = this.config.expressionTailMs;
        if (!(tail > 0) || this.mode() === 'esml') return Promise.resolve();
        return Promise.race([Promise.all([this.player.idle(), this.speechAnims || Promise.resolve()]), delay(tail)]);
    }
    endTurn(turn) {
        if (this.turn === turn) this.turn = null;
        clearTimeout(turn.guard);
        if (!this.active) return;
        const at = t => t === undefined ? null : t - turn.stoppedAt;
        const calls = this.acts && turn.calls && turn.calls.length ? turn.calls : null;
        this.log.write({kind: 'jibo', turn: turn.n, text: turn.text, status: turn.status || null, reaction: turn.reaction || null, expressions: turn.expressions,
            ms: {transcript: at(turn.transcriptAt), first_text: at(turn.firstTextAt), first_speech: at(turn.firstSpeechAt), end: this.now() - turn.stoppedAt},
            usage: turn.usage || null, followUp: turn.followUp || undefined, calls: turn.calls && turn.calls.length ? turn.calls.map(c => c.name) : undefined});
        this.remember(turn);
        if (calls) return this.act(turn, calls);
        if (turn.goodbye) return this.finishAndLeave('goodbye');
        if (!turn.lines) this.thinking.stop();
        return Promise.all([delay(this.config.echoTailMs), this.settle()]).then(() => { if (this.active && !this.turn) this.listen(); });
    }
    // The conversation so far as person/Jibo pairs, for coming back after a handover.
    remember(turn) {
        const last = this.pairs[this.pairs.length - 1];
        if (turn.followUp && last) { if (turn.text) last.jibo = (last.jibo ? last.jibo + ' ' : '') + turn.text; }
        else if (turn.transcript || turn.text) this.pairs.push({you: turn.transcript || '', jibo: turn.text || ''});
        if (this.pairs.length > KEEP_PAIRS) this.pairs.splice(0, this.pairs.length - KEEP_PAIRS);
    }
    // Run the turn's tool calls (after its words were spoken). Results of in-Noggin tools go back to
    // the model, which answers in a follow-up reply; a handover tool ends Noggin for now.
    act(turn, calls) {
        const round = (turn.round || 0) + 1, outputs = [];
        this.state = 'acting'; this.gate = false; this.led(BUSY);
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
    }
    // A dance with its own music, chosen from the person's words (`heard`): the same one again, a
    // dance of the style they named, or a random one; none of the last three when there is another.
    // Jibo may name it first (danceAnnounce). Resolves {name, style, from, announced} once it is over.
    dance(heard, turn) {
        const speech = this.jibo.embodied && this.jibo.embodied.speech, choice = core.danceChoice(heard, this.random);
        const last = this.recentDances[0];
        let name, style, from;
        if (choice.again && last && (!choice.style || core.danceStyles(last).indexOf(choice.style) >= 0)) { name = last; from = 'again'; style = choice.style; }
        else if (choice.style) { style = choice.style; name = core.pickDance(style, {recent: this.recentDances, random: this.random}); from = 'keyword'; }
        else { name = core.pickDance(null, {recent: this.recentDances, random: this.random}); from = 'random'; }
        style = style || core.danceStyles(name)[0] || null;
        this.recentDances = [name].concat(this.recentDances.filter(n => n !== name)).slice(0, RECENT_DANCES);
        const announced = core.danceAnnounce(this.config.danceAnnounce, from, this.danceCount - this.announcedAt, this.random);
        this.danceCount++; if (announced) this.announcedAt = this.danceCount;
        const line = announced ? core.danceLine(style, this.random) : null;
        this.log.write(Object.assign({kind: 'speak', turn: turn === undefined ? null : turn, anim: name, dance: style, from: from}, line ? {text: line} : {}));
        // One speak, the words and then the dance. As two speaks (the line, then the dance) the dance
        // began 6 ms after the line's session ended and was cut to about half a second, on the robot
        // and in the sim; a dance starting seconds after a speak is fine.
        return Promise.resolve()
            .then(() => speech.speak((line ? core.speechText(line) + ' ' : '') + "<anim name='" + name + "' endNeutral='true'/>"))
            .then(() => ({name: name, style: style, from: from, announced: announced}));
    }
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
            return Promise.resolve().then(() => this.dance(turn ? turn.transcript || '' : this.heard, turn ? turn.n : null))
                .then(played => Object.assign({ok: true, done: 'Jibo danced', dance: core.danceName(played.style)},
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
    }
    // Tool results back to the model, then its follow-up reply (unless the rounds ran out).
    answer(turn, outputs, round) {
        if (!this.active || !this.rt) return;
        outputs.forEach(o => this.rt.send({type: 'conversation.item.create',
            item: {type: 'function_call_output', call_id: o.call.callId, output: JSON.stringify(o.result)}}));
        if (round > MAX_ROUNDS) { this.listen(); return; }
        this.followUp(turn, round);
    }
    // A reply without new words from the person: after tool results, or on coming back.
    followUp(previous, round) {
        const now = this.now();
        const turn = this.turn = {n: previous ? previous.n : ++this.turns, round: round, followUp: true, stoppedAt: now, text: '', sent: 0, lines: 0,
            transcript: previous ? previous.transcript : '', transcriptAt: now, expressions: [], reactionDone: true, goodbye: previous ? previous.goodbye : false};
        this.state = 'thinking'; this.gate = false; this.led(BUSY);
        this.guardReply(turn);
        this.rt.send({type: 'response.create'});
    }
    // No "Hey Jibo" while Noggin has the microphone: true if asked for (this.hotword holds the token).
    hotwordOff() {
        const js = this.jibo.jetstream;
        if (!js || !js.setHotwordMode || !js.types) return false;
        try { this.hotword = js.setHotwordMode(js.types.HotwordListenMode.Disabled); } catch (_) { this.hotword = null; }
        return !!this.hotword;
    }
    // Hand the action to another skill. Noggin is closed by that switch; if it does not happen
    // within actionTimeoutMs, the model hears that it failed and the conversation goes on.
    // A `cloud` plan asks Jibo's cloud a fixed phrase instead of opening a skill: Be then
    // switches to @be/nimbus, which speaks the answer.
    handOver(turn, handover, outputs, round) {
        const plan = handover.plan, call = handover.call, acts = this.acts, cloud = plan.kind === 'cloud';
        const state = this.handover = {tool: call.name, target: plan.target, reason: plan.comeback ? 'handover' : 'leaves'};
        this.state = 'handover'; this.gate = false; this.led(BUSY);
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
        const wait = this.config.actionTimeoutMs || 6000;
        if (cloud) {
            // With the hotword off, Jibo's speech service quietly drops a mimicked turn (and the
            // call still succeeds): give the hotword back and wait for that first, at most 1.5 s
            // (the simulator never confirms). The timeout starts once the cloud is asked.
            // Not returned: this runs inside the speech chain, and a call that never answers
            // (mimicGlobalTurn in the simulator) must not hold up what Jibo says next.
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
            this.mark('resume_timer_read');
            this.log.write({kind: 'resume', tool: resume.tool || null, pairs: this.pairs.length, said: String(resume.said || '').slice(0, 300), clock: clock});
            this.rt.send({type: 'conversation.item.create', item: {type: 'message', role: 'system', content: [{type: 'input_text', text: core.resumeNote(resume, clock, said)}]}});
            if (said) return false;
            this.followUp(null, 1);
            return true;
        });
    }
    // The `lab` setting `expressions`: a fixed run without OpenAI or the microphone. The same lines
    // play in each expressionPlay mode, so the conversation log can compare them: `speak` -> `spoken` (the
    // words), `speech_anims` (speech's animations done), `anim` (Noggin's own: start, end, result).
    // Then the ring refresh is switched off for one line of hot words ("Maybe", "I think", "Oh",
    // "Wait": glances that may turn the ring off); watch the ring. Then Noggin ends.
    runLab() {
        const config = this.config, original = config.expressionPlay;
        const words = ['one', 'two', 'three'];
        const settle = step => {
            const t = this.now();
            return Promise.race([Promise.all([this.player.idle(), this.speechAnims || Promise.resolve()]).then(() => this.now() - t), delay(8000).then(() => null)])
                .then(waited => { if (this.active) this.log.write({kind: 'lab_settled', mode: this.mode(), step: step, waited: waited}); }).then(() => delay(Conversation.LAB_PAUSE_MS));
        };
        const line = (step, text, anim) => () => {
            if (!this.active) return;
            this.log.write({kind: 'lab_step', mode: this.mode(), step: step});
            return this.speak(text, null, {anim: anim, via: 'lab'}).then(() => settle(step));
        };
        let chain = Promise.resolve();
        // `lab animdb`: only the animdb round (and the ring line).
        const modes = config.lab === 'animdb' ? ['animdb'] : PLAY_MODES;
        modes.forEach(mode => {
            const n = PLAY_MODES.indexOf(mode);
            chain = chain.then(() => { config.expressionPlay = mode; this.log.write({kind: 'lab_mode', mode: mode}); })
                .then(line('plain', 'Test ' + words[n] + '.', null))
                .then(line('hello', 'Hi!', 'greetings_01'))
                .then(line('long', 'That is wonderful news, I am so happy for you and your whole family today.', 'excited_01'))
                .then(line('eye', 'Nice to see you.', 'eye_happy_00'))
                .then(line('led', 'Yes, exactly.', 'yep_04'))
                .then(() => {
                    if (!this.active) return;
                    // Back to back: the next line starts while the first one's body animation still runs.
                    this.log.write({kind: 'lab_step', mode: this.mode(), step: 'back_to_back'});
                    return this.speak('Let me show you something.', null, {anim: 'greetings_02', via: 'lab'})
                        .then(() => this.speak('And here is another line, right after it.', null, {via: 'lab'}))
                        .then(() => this.speak('And a third one, with a move.', null, {anim: 'surprised_02', via: 'lab'}))
                        .then(() => settle('back_to_back'));
                })
                .then(() => {
                    // The same kind of animation without taking the LED out (animdb only): if only
                    // this one plays, the dofs option is the problem, not loading.
                    if (!this.active || mode !== 'animdb') return;
                    this.log.write({kind: 'lab_step', mode: mode, step: 'led_kept'});
                    this.player.play('eye_happy_01', {via: 'lab', keepLed: true});
                    return delay(300).then(() => this.speak('Once more, as it is.', null, {via: 'lab'})).then(() => settle('led_kept'));
                })
                .then(() => {
                    // A reaction: Noggin's own animation first, speech's words 300 ms later (new modes only).
                    if (!this.active || mode === 'esml') return;
                    this.log.write({kind: 'lab_step', mode: mode, step: 'reaction'});
                    this.player.play('Thinking_00', {via: 'lab'});
                    return delay(300).then(() => this.speak('Hmm, good question. Let me think about that for a second.', null, {via: 'lab'})).then(() => settle('reaction'));
                });
        });
        return chain.then(() => {
            if (!this.active) return;
            config.expressionPlay = 'esml-tts';
            clearInterval(this.ringTimer); this.led(BUSY);
            this.log.write({kind: 'lab_ring', refresh: false, note: 'ring refresh off for this line: watch the ring'});
            return line('ring', 'Ring test. Maybe. I think so. Oh. Wait, let me see.', null)();
        }).then(() => {
            config.expressionPlay = original;
            if (!this.active) return;
            if (config.ringRefreshMs > 0) this.ringTimer = setInterval(() => { if (this.active && this.ring) this.led(this.ring); }, Math.max(20, config.ringRefreshMs));
            this.log.write({kind: 'lab_ring', refresh: config.ringRefreshMs > 0});
            return this.speak('Lab done.', null);
        });
    }
    // The `lab` setting `timing`: when does an expression really start? Jibo says "Watch me.", then
    // "Now!" with excited_01, played as a conversation line plays it, four times: twice
    // quietly, twice with the microphone running as in a conversation. Watch whether he moves
    // on "Now!"; the conversation log shows when the animation reported its start each time.
    runTiming() {
        let chain = Promise.resolve();
        ['quiet', 'quiet', 'microphone', 'microphone'].forEach((load, n) => {
            chain = chain.then(() => {
                if (!this.active) return;
                const mic = load === 'microphone' && !this.micOn ? Promise.resolve().then(() => this.startMic()).then(() => { this.micOn = true; }, () => {}) : Promise.resolve();
                return mic.then(() => this.speak('Watch me.', null, {via: 'lab'}));
            }).then(() => Promise.race([this.speechAnims || Promise.resolve(), delay(5000)])).then(() => delay(Conversation.LAB_PAUSE_MS)).then(() => {
                if (!this.active) return;
                this.log.write({kind: 'lab_step', mode: 'animdb', step: 'timing ' + load + ' ' + (n % 2 + 1)});
                // Exactly as a conversation line plays it (animdb: the animation first, the words at most expressionLeadMs later).
                const mode = this.config.expressionPlay; this.config.expressionPlay = 'animdb';
                return this.speak('Now!', null, {anim: 'excited_01', via: 'lab'}).then(() => { this.config.expressionPlay = mode; })
                    .then(() => this.player.idle()).then(() => delay(Conversation.LAB_PAUSE_MS));
            });
        });
        return chain.then(() => {
            if (this.micOn) { try { this.mic.stop(); } catch (_) {} this.micOn = false; }
            if (this.active) return this.speak('Lab done.', null);
        });
    }
    fail(error) {
        if (!this.active) return;
        const message = String(error && error.message || error);
        if (!this.startupLogged) { this.mark('failed'); this.logStartup({failed: message.slice(0, 200)}); }
        this.log.write({kind: 'failed', error: message});
        // Speak only if the speech system is free; Jibo explains it as Jibo (no tech talk).
        const said = this.speaking ? Promise.resolve() : this.speak("Sorry, I can't think straight right now. Let's talk again a bit later.", null);
        this.gate = false;
        said.then(() => this.leave('error'), () => this.leave('error'));
    }
    leave(reason) { return this.close(reason); }
    // An ending Jibo chose (goodbye, silence): let the last expression end in its pose first, so
    // close never cuts a body animation half way. At most FINISH_MS.
    finishAndLeave(reason) {
        this.gate = false;
        const playing = Promise.all([this.player.idle(), this.speechAnims || Promise.resolve()]);
        return Promise.race([playing.catch(() => {}), delay(Conversation.FINISH_MS)]).then(() => this.leave(reason));
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
        clearInterval(this.monitor); clearInterval(this.ringTimer); clearTimeout(this.silence);
        if (this.audioTimer) { clearInterval(this.audioTimer); if (wasActive) this.audioReport(); }
        if (this.turn) { clearTimeout(this.turn.waitTimer); clearTimeout(this.turn.guard); }
        this.unwatch.splice(0).forEach(off => off());
        try { this.mic.stop(); } catch (_) {}
        if (this.rt) this.rt.close();
        cleanup.push(this.thinking.stop());
        cleanup.push(this.player.stopCurrent('closed'));
        const speech = jibo.embodied && jibo.embodied.speech;
        if (this.speaking && speech && speech.stop) cleanup.push(Promise.resolve().then(() => speech.stop()));
        const hotword = this.hotword; this.hotword = null;
        if (hotword) cleanup.push(Promise.resolve().then(() => hotword.release()));
        if (wasActive) { this.led(OFF); this.log.write({kind: 'session_end', reason: reason, turns: this.turns}); }
        // A platform call that never answers must not keep the skill open.
        this.closing = Promise.all(cleanup.map(p => Promise.race([p.catch(() => {}), delay(1500)]))).then(() => { if (this.finish) this.finish(reason); });
        return this.closing;
    }
}
Conversation.LAB_PAUSE_MS = 1200;   // between lab steps, so one step's movement never runs into the next
Conversation.MIC_START_MS = 8000;   // a microphone that never starts ends the conversation (D16)
Conversation.FINISH_MS = 2000;      // the longest a goodbye waits for the last expression
module.exports = Conversation;
