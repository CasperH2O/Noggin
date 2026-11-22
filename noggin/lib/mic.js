// SPDX-License-Identifier: MIT
// Noggin: Jibo's live microphone as PCM16 24 kHz blocks for the realtime API.
// Nothing is recorded or stored; blocks go to `onBlock(pcm16, levelDb)` only.
//
// ProcessMicrophone (the robot): `arecord` in a child process, so an ALSA failure ends that
// child, not Be's own process with Jibo's screen in it.
// Microphone (the simulator): BEam's jibo.media.getUserMedia through Web Audio.
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const audio = require('./audio');

const DEVICE = /^[A-Za-z0-9_:,.=-]{1,64}$/;
const BLOCK = 4096, RATE = 48000;

class ProcessMicrophone {
    // options: {device, command, spawn, onExit({code, signal, stderr}), startTimeoutMs}
    constructor(options) {
        this.options = options || {};
        this.device = this.options.device || 'default';
        this.label = 'arecord ' + this.device; this.rate = RATE; this.kind = 'arecord';
        this.child = null;
    }
    start(onBlock) {
        const options = this.options;
        if (!DEVICE.test(this.device)) return Promise.reject(Error('microphone device name not allowed: ' + this.device));
        if (this.child) this.stop();
        const spawn = options.spawn || require('child_process').spawn;
        const args = ['-D', this.device, '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw', '-q', '-'];
        let child;
        try { child = spawn(options.command || '/usr/bin/arecord', args, {stdio: ['ignore', 'pipe', 'pipe']}); }
        catch (error) { return Promise.reject(error); }
        this.child = child;
        const state = {}, samples = new Float32Array(BLOCK);
        let filled = 0, odd = null, stderr = '', started = false, settle = null;
        const ready = new Promise((resolve, reject) => {
            settle = (error) => {
                if (started) return;
                started = true; clearTimeout(timer);
                if (!error) return resolve();
                // No audio: never leave a half-started arecord behind.
                if (this.child === child) this.stop();
                reject(error);
            };
            const timer = setTimeout(() => settle(Error('microphone gave no audio within ' + ((options.startTimeoutMs || 3000) / 1000) + ' s')), options.startTimeoutMs || 3000);
        });
        child.stdout.on('data', chunk => {
            if (this.child !== child) return;
            settle(null);
            const push = value => {
                samples[filled++] = value;
                if (filled === BLOCK) { this.emit(onBlock, samples, state); filled = 0; }
            };
            let i = 0;
            // A sample split across two chunks: finish it with the first byte of this one.
            if (odd !== null && chunk.length) { push((((chunk[0] << 8) | odd) << 16 >> 16) / 32768); odd = null; i = 1; }
            for (; i + 1 < chunk.length; i += 2) push(chunk.readInt16LE(i) / 32768);
            if (i < chunk.length) odd = chunk[i];
        });
        child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-300); });
        const ended = (code, signal, error) => {
            if (this.child !== child) return;
            this.child = null;
            const report = {code: code === undefined ? null : code, signal: signal || null, stderr: stderr.trim() || (error ? String(error.message || error) : '')};
            if (!started) return settle(Error('microphone process ended: ' + (report.stderr || 'code ' + report.code + (report.signal ? ', ' + report.signal : ''))));
            if (options.onExit) options.onExit(report);
        };
        child.once('error', error => ended(null, null, error));
        child.once('exit', (code, signal) => ended(code, signal));
        return ready;
    }
    emit(onBlock, samples, state) {
        onBlock(audio.toPcm24(samples, RATE, state), audio.levelDb(samples));
    }
    stop() {
        const child = this.child;
        this.child = null;
        if (child) try { child.kill('SIGTERM'); } catch (_) {}
    }
}

class Microphone {
    constructor(jibo, options) {
        this.jibo = jibo; this.options = options || {};
        this.stream = this.context = this.source = this.processor = null;
        this.rate = null; this.kind = 'webaudio';
    }
    // Resolves once the track is live. `onBlock(pcm16, levelDb)` runs for every block.
    start(onBlock) {
        const jibo = this.jibo, options = this.options;
        const getUserMedia = options.getUserMedia || (jibo.media && typeof jibo.media.getUserMedia === 'function' ? c => jibo.media.getUserMedia(c) : null);
        const Context = options.AudioContext || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
        if (!getUserMedia || !Context) return Promise.reject(Error('microphone_unavailable'));
        return Promise.resolve(getUserMedia({audio: true})).then(stream => {
            this.stream = stream;
            const context = this.context = new Context(), state = {};
            this.rate = context.sampleRate;
            this.source = context.createMediaStreamSource(stream);
            // A processor only runs while connected to the output; it writes silence there.
            this.processor = context.createScriptProcessor(4096, 1, 1);
            this.processor.onaudioprocess = event => {
                const samples = event.inputBuffer.getChannelData(0);
                onBlock(audio.toPcm24(samples, context.sampleRate, state), audio.levelDb(samples));
            };
            this.source.connect(this.processor); this.processor.connect(context.destination);
            const track = stream.getAudioTracks && stream.getAudioTracks()[0];
            this.label = track ? track.label : null;
            if (track && this.options.onTrack) ['mute', 'unmute', 'ended'].forEach(name => { track['on' + name] = () => this.options.onTrack(name); });
        });
    }
    stop() {
        const processor = this.processor, source = this.source, stream = this.stream, context = this.context;
        this.processor = this.source = this.stream = this.context = null;
        if (processor) { processor.onaudioprocess = null; try { processor.disconnect(); } catch (_) {} }
        if (source) try { source.disconnect(); } catch (_) {}
        if (stream) stream.getTracks().forEach(track => { try { track.stop(); } catch (_) {} });
        if (context && typeof context.close === 'function') try { Promise.resolve(context.close()).catch(() => {}); } catch (_) {}
    }
}
// Which microphone: 'arecord' on the robot (when 'auto'), Web Audio elsewhere (simulator).
function choose(config, fs) {
    const source = config.micSource || 'auto';
    if (source === 'arecord' || source === 'webaudio') return source;
    fs = fs || require('fs');
    return fs.existsSync('/usr/bin/arecord') && fs.existsSync('/opt/jibo/Jibo/Skills') ? 'arecord' : 'webaudio';
}
Microphone.ProcessMicrophone = ProcessMicrophone;
Microphone.choose = choose;
module.exports = Microphone;
