// SPDX-License-Identifier: MIT
// Noggin: the arecord microphone and the microphone inside a conversation (lib/mic.js, conversation-mic.js).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Conversation, Microphone, sleep, harness, untilListening, listening, fakeSpawn, pcmBytes} from './helpers/conversation.mjs';

// ---- the arecord microphone ----
test('arecord microphone: 48 kHz S16 from the process, reframed across odd chunk edges into 24 kHz blocks', async () => {
    const {spawn, calls} = fakeSpawn(), blocks = [];
    const mic = new Microphone.ProcessMicrophone({device: 'MediaIn', spawn});
    const started = mic.start((pcm, level) => blocks.push({pcm, level}));
    const call = calls[0];
    assert.equal(call.command, '/usr/bin/arecord');
    assert.deepEqual(call.args, ['-D', 'MediaIn', '-f', 'S16_LE', '-r', '48000', '-c', '1', '-t', 'raw', '-q', '-']);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    const bytes = pcmBytes(new Array(4096 * 2).fill(16384));
    // 3 uneven pieces, the first ending in the middle of a sample.
    call.child.stdout.emit('data', bytes.slice(0, 5001));
    await started;
    call.child.stdout.emit('data', bytes.slice(5001, 9000));
    call.child.stdout.emit('data', bytes.slice(9000));
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].pcm.length, 2048);
    assert.ok(blocks.every(b => b.pcm.every(v => v === 16384)), 'no sample lost or corrupted at the chunk edges');
    assert.ok(Math.abs(blocks[0].level - 20 * Math.log10(0.5)) < 0.1);
    assert.equal(mic.label, 'arecord MediaIn'); assert.equal(mic.kind, 'arecord');
    mic.stop();
    assert.equal(call.child.killed, 'SIGTERM');
    call.child.emit('exit', null, 'SIGTERM');
});

test('arecord microphone: an unexpected exit is reported with stderr; one before any audio fails the start', async () => {
    const {spawn, calls} = fakeSpawn(), exits = [];
    const mic = new Microphone.ProcessMicrophone({spawn, onExit: r => exits.push(r)});
    const started = mic.start(() => {});
    calls[0].child.stdout.emit('data', pcmBytes([1, 2]));
    await started;
    calls[0].child.stderr.emit('data', Buffer.from("arecord: pcm.c:2759: snd_pcm_area_copy: Assertion `dst < src' failed.\n"));
    calls[0].child.emit('exit', null, 'SIGABRT');
    assert.equal(exits.length, 1);
    assert.equal(exits[0].signal, 'SIGABRT'); assert.match(exits[0].stderr, /snd_pcm_area_copy/);

    const failing = mic.start(() => {});
    calls[1].child.stderr.emit('data', Buffer.from('arecord: main:828: audio open error: No such file or directory'));
    calls[1].child.emit('exit', 1, null);
    await assert.rejects(failing, /audio open error/);
    assert.equal(exits.length, 1, 'a failed start is not an exit');
    await assert.rejects(new Microphone.ProcessMicrophone({spawn, device: 'x; rm -rf /'}).start(() => {}), /not allowed/);
    const silent = new Microphone.ProcessMicrophone({spawn, startTimeoutMs: 30}).start(() => {});
    await assert.rejects(silent, /no audio within/);
    assert.equal(calls.at(-1).child.killed, 'SIGTERM', 'a start that timed out kills its process');
});

test('microphone choice: arecord on the robot, Web Audio elsewhere, or as set', () => {
    const robot = {existsSync: p => p === '/usr/bin/arecord' || p === '/opt/jibo/Jibo/Skills'}, sim = {existsSync: () => false};
    assert.equal(Microphone.choose({micSource: 'auto'}, robot), 'arecord');
    assert.equal(Microphone.choose({micSource: 'auto'}, sim), 'webaudio');
    assert.equal(Microphone.choose({micSource: 'webaudio'}, robot), 'webaudio');
    assert.equal(Microphone.choose({micSource: 'arecord'}, sim), 'arecord');
});

// ---- moved here from other sections ----
test('a microphone stream of pure digital silence is restarted after micSilentMs while listening; repeated failure ends politely', async () => {
    const h = harness({config: {silenceSeconds: 20, micSilentMs: 1000}});
    const ended = h.talk.open(); await untilListening(h);
    assert.equal(h.starts(), 1);
    for (let i = 0; i < 11; i++) h.audio(-120);
    assert.equal(h.starts(), 1, 'under a second of zeros is fine');
    h.audio(-120); await sleep(350);
    assert.equal(h.starts(), 2, 'restarted after 1 s of zeros');
    assert.ok(h.logs.some(e => e.kind === 'microphone_silent' && e.restart === 1));
    h.audio(-55);
    assert.ok(h.logs.some(e => e.kind === 'microphone_ok'));
    for (let round = 0; round < 4; round++) { for (let i = 0; i < 12; i++) h.audio(-120); await sleep(350); }
    assert.equal(await ended, 'microphone_silent');
    assert.match(h.said.at(-1), /can't hear anything/);
});

test('zeros while Jibo speaks never restart the microphone; zeros that clear by themselves are logged', async () => {
    const h = await listening({config: {silenceSeconds: 20, micSilentMs: 1000}});
    h.talk.state = 'speaking';
    for (let i = 0; i < 40; i++) h.audio(-120);
    h.talk.listen();
    for (let i = 0; i < 5; i++) h.audio(-120);
    h.audio(-50);
    await sleep(50);
    assert.equal(h.starts(), 1, 'no restart');
    const cleared = h.logs.find(e => e.kind === 'microphone_zeros_cleared');
    assert.ok(cleared && cleared.ms > 400 && cleared.ms < 450, 'only the zeros while listening count: ' + JSON.stringify(cleared));
    h.audio(-120); h.audio(-50);
    assert.equal(h.logs.filter(e => e.kind === 'microphone_zeros_cleared').length, 1, 'a short gap later in listening is not logged');
    h.talk.close();
});

test('the arecord process ending is logged and restarted; repeated exits end politely', async () => {
    const h = harness({config: {silenceSeconds: 20}});
    const ended = h.talk.open(); await untilListening(h);
    h.talk.onMicExit({code: null, signal: 'SIGABRT', stderr: "pcm.c:2759: snd_pcm_area_copy: Assertion failed."});
    await sleep(350);
    assert.equal(h.starts(), 2);
    const exit = h.logs.find(e => e.kind === 'microphone_exit');
    assert.equal(exit.signal, 'SIGABRT'); assert.match(exit.stderr, /Assertion/);
    assert.ok(h.logs.some(e => e.kind === 'microphone_restarted'));
    h.audio(-50);
    for (let round = 0; round < 4; round++) { h.talk.onMicExit({code: 1, signal: null, stderr: ''}); await sleep(350); }
    assert.equal(await ended, 'microphone_failed');
    assert.match(h.said.at(-1), /can't hear anything/);
});

test('a microphone that never starts ends the conversation politely, and is closed if it starts late', async () => {
    const before = Conversation.MIC_START_MS;
    Conversation.MIC_START_MS = 150;
    let resolveStart, stops = 0;
    const mic = {start: () => new Promise(resolve => { resolveStart = resolve; }), stop: () => { stops++; }, kind: 'webaudio'};
    try {
        const h = harness({mic});
        const reason = await Promise.race([h.talk.open(), sleep(3000).then(() => 'still open')]);
        assert.notEqual(reason, 'still open');
        assert.ok(h.said.some(s => /can't think straight/.test(s)), 'Jibo apologises');
        const failed = h.logs.find(e => e.kind === 'startup');
        assert.match(failed.failed, /microphone did not start/);
        const stopsBefore = stops;
        resolveStart();
        await sleep(10);
        assert.equal(stops, stopsBefore + 1, 'a late start is stopped again');
    } finally { Conversation.MIC_START_MS = before; }
});

test('a microphone still starting when the conversation closes is stopped once it starts', async () => {
    let resolveStart, stops = 0;
    const mic = {start: () => new Promise(resolve => { resolveStart = resolve; }), stop: () => { stops++; }, kind: 'webaudio'};
    const h = harness({mic});
    h.talk.open();
    await sleep(20);
    await h.talk.close('swipe');
    const before = stops;
    resolveStart();
    await sleep(10);
    assert.equal(stops, before + 1, 'stopped again once the late start completed');
    assert.equal(h.talk.audioTimer, null, 'no report timer for a closed conversation');
});

