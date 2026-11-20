// SPDX-License-Identifier: MIT
// Noggin: when each part of the audio sent to OpenAI left, so the log can tell how long after the
// audio at a VAD event's position (audio_start_ms / audio_end_ms) the event came (D87, D89).
// Text only: times in ms. Node 6 / Chrome 53: ES2015 only.
'use strict';

const SENDS = 600; // about 50 s of microphone blocks

class AudioClock {
    constructor() { this.reset(); }
    // A new realtime session counts its audio from zero.
    reset() { this.sentMs = 0; this.sends = []; }
    // A block of `ms` audio was sent at `at`.
    sent(at, ms) {
        this.sends.push([this.sentMs, this.sentMs + ms, at]);
        this.sentMs += ms;
        if (this.sends.length > SENDS) this.sends.shift();
    }
    // When the audio at `audioMs` (the server's position) was sent, or null if not known.
    sentAt(audioMs) {
        if (typeof audioMs !== 'number') return null;
        for (let i = 0; i < this.sends.length; i++) {
            const send = this.sends[i];
            if (audioMs >= send[0] && audioMs <= send[1]) return send[2];
        }
        return null;
    }
}

module.exports = AudioClock;
