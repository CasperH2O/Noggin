// SPDX-License-Identifier: MIT
// Noggin: the conversation's microphone and timing probes, mixed into Conversation
// (lib/controller.js): starting and restarting the microphone, sending its audio, the 10 s audio
// report, the thread-lag probe and where the server placed speech in the sent audio (D78, D87).
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const audio = require('./audio'), delay = require('./timing').delay, lines = require('./lines');

// The JavaScript thread's lag (a timer firing late), sampled every LAG_MS: a blocked thread would
// also hold up an animation's first frame.
const LAG_MS = 50, LAG_SPIKE_MS = 80, LAG_SPIKES = 12;
// The simulator's `os` has no loadavg(): null there, never a throw (close() reports audio).
let loadavg = () => null;
try { const os = require('os'); if (typeof os.loadavg === 'function') loadavg = () => Math.round(os.loadavg()[0] * 100) / 100; } catch (_) {}

const methods = {
    // A microphone that never answers must not hold the conversation open with the hotword off.
    startMic() {
        this.micStarts = (this.micStarts || 0) + 1;
        const mic = this.mic, limit = this.micStartMs;
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
    },
    onAudio(pcm, level) {
        const stats = this.audio;
        stats.blocks++;
        if (stats.blocks === 1) this.mark('first_audio');
        if (typeof level === 'number') stats.levels.push(level);
        this.watchZeros(pcm, level);
        if (!this.active || !this.gate || !this.rt) return;
        stats.sent++;
        if (this.clock) this.clock.sent(this.since(), pcm && pcm.length ? pcm.length / (audio.RATE / 1000) : 0);
        this.rt.send({type: 'input_audio_buffer.append', audio: audio.base64(pcm)});
    },
    // Exact digital silence means no sound reaches us. It often follows Jibo's own speech, so only
    // `micSilentMs` of it while listening restarts the microphone.
    watchZeros(pcm, level) {
        if (level <= -119) {
            if (this.state !== 'listening' || this.restarting || !this.active) return;
            this.zeroMs = (this.zeroMs || 0) + (pcm && pcm.length ? pcm.length / (audio.RATE / 1000) : 0);
            if (this.zeroMs >= this.config.micSilentMs) this.restartMic('silent');
            return;
        }
        if (this.restarting) return;
        if (this.micRestarts) { this.log.write({kind: 'microphone_ok', after_restarts: this.micRestarts}); this.micRestarts = 0; }
        // How long the silence left over from Jibo's speech lasted once he listened again.
        else if (this.zeroMs && this.state === 'listening' && this.listenStart) this.log.write({kind: 'microphone_zeros_cleared', ms: Math.round(this.zeroMs)});
        if (this.state === 'listening') this.listenStart = false;
        this.zeroMs = 0;
    },
    // The arecord process ended on its own: log why (an ALSA error shows in stderr) and start it again.
    onMicExit(report) {
        if (!this.active) return;
        this.log.write(Object.assign({kind: 'microphone_exit'}, report));
        if (!this.restarting) this.restartMic('exit');
    },
    // reason: 'silent' (digital silence), 'exit' (the process ended) or 'failed' (a restart failed).
    restartMic(reason) {
        if (!this.active) return Promise.resolve();
        this.restarting = true; this.zeroMs = 0;
        this.micRestarts = (this.micRestarts || 0) + 1;
        if (reason === 'silent') this.log.write({kind: 'microphone_silent', restart: this.micRestarts});
        if (this.micRestarts > 3) {
            this.restarting = false; this.gate = false;
            const why = reason === 'silent' ? 'microphone_silent' : 'microphone_failed';
            this.speechChain = this.speechChain.then(() => this.speak(lines.say('micFailed', this.language), null, {english: lines.say('micFailed', 'en')})).then(() => this.leave(why));
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
    },
    // Every 10 s: how much audio came from the microphone, how much went to OpenAI, how loud.
    // Text only; this is what tells a dead or silent microphone apart from a deaf server.
    audioReport() {
        const stats = this.audio, levels = stats.levels.slice().sort((a, b) => a - b);
        const at = p => levels.length ? Math.round(levels[Math.min(levels.length - 1, Math.floor(p * levels.length))]) : null;
        let mem = null;
        try { const m = process.memoryUsage(); if (m.rss) mem = {rss: Math.round(m.rss / 1048576), heap: Math.round(m.heapUsed / 1048576)}; } catch (_) {}
        this.log.write({kind: 'audio', state: this.state, source: this.mic.kind || null, blocks: stats.blocks, sent: stats.sent,
            db: {min: at(0), median: at(0.5), p90: at(0.9), max: at(1)}, mem: mem, micStarts: this.micStarts || 0,
            lagMax: this.lag ? this.lag.max : null, load: loadavg()});
        this.audio = {blocks: 0, sent: 0, levels: []};
        if (this.lag) this.lag.max = 0;
    },
    startLagProbe() {
        this.lag = {last: this.now(), max: 0};
        this.lagTimer = setInterval(() => this.sampleLag(), LAG_MS);
    },
    // A late timer means the thread was busy: kept per 10 s report, and per turn as spikes
    // [ms after the person stopped, ms late].
    sampleLag() {
        const now = this.now(), late = Math.max(0, now - this.lag.last - LAG_MS), turn = this.turn;
        this.lag.last = now;
        if (late > this.lag.max) this.lag.max = late;
        if (turn && turn.lag && late >= LAG_SPIKE_MS && turn.lag.length < LAG_SPIKES) turn.lag.push([now - turn.stoppedAt - late, late]);
    },
    // Where the server placed a VAD event in the sent audio (`audio_ms`, its padding and silence
    // window included), all audio sent so far, and how long after that audio left the event came.
    vadTiming(event) {
        const clock = this.clock, started = event.type === 'input_audio_buffer.speech_started';
        if (!clock || !(started || event.type === 'input_audio_buffer.speech_stopped')) return null;
        const position = started ? event.audio_start_ms : event.audio_end_ms, sentAt = clock.sentAt(position);
        return {audio_ms: typeof position === 'number' ? position : null, sent_ms: Math.round(clock.sentMs),
            behind_ms: sentAt === null ? null : Math.round(this.since() - sentAt)};
    },
};
module.exports = methods;
