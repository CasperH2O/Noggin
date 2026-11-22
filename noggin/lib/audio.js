// SPDX-License-Identifier: MIT
// Noggin: microphone samples to what the realtime API takes, PCM16 mono at 24 kHz as base64,
// and a block's level. Pure: no I/O. Node 6 / Chrome 53: ES2015 only.
'use strict';

const RATE = 24000;

// Float samples at `rate` -> mono Int16 at 24 kHz. Down-sampling averages the input
// samples each output sample covers (a box filter); up-sampling interpolates. `state`
// carries the position and partial sums across blocks, so block edges are seamless.
function toPcm24(samples, rate, state) {
    const step = rate / RATE, out = [];
    if (step < 1) {
        let pos = state.pos || 0, last = state.last || 0;
        for (; pos < samples.length; pos += step) {
            const i = Math.floor(pos), f = pos - i, a = i > 0 ? samples[i - 1] : last, b = samples[i];
            out.push(a + (b - a) * f);
        }
        state.pos = pos - samples.length;
        if (samples.length) state.last = samples[samples.length - 1];
    } else {
        let edge = state.edge === undefined ? step : state.edge, sum = state.sum || 0, count = state.count || 0;
        for (let n = 0; n < samples.length; n++) {
            sum += samples[n]; count++;
            if (n + 1 >= edge) { out.push(sum / count); sum = 0; count = 0; edge += step; }
        }
        state.edge = edge - samples.length; state.sum = sum; state.count = count;
    }
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) pcm[k] = Math.round(Math.max(-1, Math.min(1, out[k])) * 32767);
    return pcm;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Little-endian bytes of an Int16Array as base64, in plain JS (works the same in the
// simulator, whose Buffer is a shim, and in Chrome 53).
function base64(int16) {
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let out = '', i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) { const a = bytes[i] << 16; out += ALPHABET[a >> 18] + ALPHABET[(a >> 12) & 63] + '=='; }
    else if (rest === 2) { const b = (bytes[i] << 16) | (bytes[i + 1] << 8); out += ALPHABET[b >> 18] + ALPHABET[(b >> 12) & 63] + ALPHABET[(b >> 6) & 63] + '='; }
    return out;
}
function levelDb(samples) {
    let sq = 0;
    for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
    return 10 * Math.log(sq / (samples.length || 1) + 1e-12) / Math.LN10;
}

module.exports = {RATE, toPcm24, base64, levelDb};
