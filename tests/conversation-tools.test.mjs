// SPDX-License-Identifier: MIT
// Noggin: tools in a conversation (conversation-tools.js): local tools, handovers, dances and Jibo's cloud.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {source, catalog, realtime, actions, DEFAULTS, sleep, ANIMDB, harness, untilListening, listening, youSay, reply, callReply, fakeActions, until, DANCE_NAMES, dancesIn, playedDances, danceOutput, danceTurn, cloudJetstream, require} from './helpers/conversation.mjs';

// ---- actions ----
test('actions: tools go in session.update, open_app with the built-in apps and the openApps setting\'s extras; no tools without actions', async () => {
    const h = await listening({actions: fakeActions(), config: {cloudSkills: [], openApps: {stargazer: '@be/stargazer', bad: 'rm -rf'}}});
    const session = h.sent.find(e => e.type === 'session.update').session;
    assert.equal(session.tool_choice, 'auto');
    assert.deepEqual(session.tools.map(t => t.name), ['get_time', 'about_jibo', 'dance', 'set_volume', 'check_clock', 'set_timer', 'cancel_timer',
        'set_alarm', 'cancel_alarm', 'use_skill', 'play_game', 'play_music', 'play_radio', 'open_app', 'go_to_sleep', 'look_away', 'remember', 'forget', 'recall']);
    assert.deepEqual(session.tools.find(t => t.name === 'open_app').parameters.properties.name.enum, ['clock', 'settings', 'menu', 'gallery', 'yoga', 'meet someone new', 'stargazer']);
    h.talk.close();
    const plain = await listening();
    assert.equal(plain.sent.find(e => e.type === 'session.update').session.tools, undefined);
    plain.talk.close();
});

test('about_jibo runs in Noggin: FACTS.md goes back as the result, then the follow-up is spoken', async () => {
    const h = await listening({actions: fakeActions()});
    await youSay(h, 'what is your favorite movie');
    callReply(h, 'r1', '', [['about_jibo', {}, 'f1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const output = h.sent.find(e => e.type === 'conversation.item.create' && e.item.type === 'function_call_output');
    assert.deepEqual(JSON.parse(output.item.output), {ok: true, facts: '- Movies: Wall-E.'});
    reply(h, 'r2', 'Wall-E! A robot with a big heart.');
    await untilListening(h);
    assert.deepEqual(h.said.slice(-2), ['Wall-E!', 'A robot with a big heart.']);
    h.talk.close();
    const empty = await listening({actions: fakeActions({facts: () => ''})});
    await youSay(empty, 'what is your favorite movie');
    callReply(empty, 'r1', '', [['about_jibo', {}, 'f1']]);
    await until(() => empty.sent.some(e => e.type === 'response.create'));
    assert.equal(JSON.parse(empty.sent.find(e => e.item && e.item.type === 'function_call_output').item.output).ok, false);
    empty.talk.close();
});

test('remember runs in Noggin: the memory runner gets the parsed fact, its result goes back; a thrown error is a plain failure', async () => {
    const calls = [];
    const h = await listening({actions: fakeActions({memory: args => { calls.push(args); return {ok: true, saved: 'Sam likes jazz.'}; }})});
    await youSay(h, 'remember that I am Sam and I like jazz');
    callReply(h, 'r1', '', [['remember', {text: 'Sam likes jazz', expires: 'soon'}, 'm1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.deepEqual(calls, [{op: 'remember', text: 'Sam likes jazz'}]);
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.type === 'function_call_output').item.output), {ok: true, saved: 'Sam likes jazz.'});
    h.talk.close();
    const broken = await listening({actions: fakeActions({memory: () => { throw Error('EROFS'); }})});
    await youSay(broken, 'what did we talk about last week');
    callReply(broken, 'r1', '', [['recall', {query: 'last week'}, 'm1']]);
    await until(() => broken.sent.some(e => e.type === 'response.create'));
    const out = JSON.parse(broken.sent.find(e => e.item && e.item.type === 'function_call_output').item.output);
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.error, /EROFS/);
    broken.talk.close();
});

test('instructions with memory: the notes go in the session note, the "no saved memory" line goes, tools named only when offered', () => {
    const now = new Date(2026, 10, 19, 19, 30), block = 'What you remember ... Facts:\n- Sam likes jazz.';
    const off = realtime.instructions('S', 'I', {memory: false});
    assert.match(off, /no tools, files or saved memory/);
    const on = realtime.instructions('S', 'I', {memory: true}, {learn: true, block});
    assert.ok(!on.includes(block), 'the instructions never carry the memory (D181)');
    const note = realtime.sessionNote(now, {learn: true, block});
    assert.ok(note.endsWith('\n\n' + block));
    assert.match(on, /the notes in the session note at the start of the conversation/);
    assert.ok(!realtime.sessionNote(now, null).includes('\n'), 'memory off: the time alone');
    assert.doesNotMatch(on, /saved memory/);
    assert.match(on, /never claim to remember something that is not in them/);
    assert.match(on, /After each conversation you keep a short note/);
    assert.match(on, /use remember or forget; for an earlier conversation your notes do not cover, use recall/);
    const noTools = realtime.instructions('S', 'I', null, {learn: false, block});
    assert.match(noTools, /You cannot keep anything new yourself/);
    assert.doesNotMatch(noTools, /use recall/);
    // The instructions are the same text in every conversation, whatever the time or memory (D181).
    assert.equal(realtime.instructions('S', 'I', null, {learn: true, block}), realtime.instructions('S', 'I', null, {learn: true, block: 'other'}));
});

test('get_time hands over to Jibo\'s clock: no words first, the clock face for the time, the calendar for the date; Noggin comes back', async () => {
    for (const [show, intent] of [['time', 'askForTime'], ['date', 'askForDate']]) {
        const acts = fakeActions();
        const h = harness({actions: acts});
        const ended = h.talk.open(); await untilListening(h);
        const before = h.said.length;
        await youSay(h, show === 'time' ? 'what time is it' : 'what day is it today');
        callReply(h, 'r1', '', [['get_time', {show}, 'c1']]);
        await until(() => acts.redirects.length === 1);
        assert.deepEqual(acts.redirects[0], ['@be/clock', {nlu: {intent, entities: {domain: 'clock'}}, match: {skipSurprises: true}}]);
        assert.equal(h.said.length, before, 'Jibo says nothing first: the clock says it');
        assert.equal(acts.handovers[0].comeback, true); assert.deepEqual(acts.handovers[0].args, {show});
        h.talk.close('closed');   // Be closes Noggin for the clock
        assert.equal(await ended, 'handover');
    }
});

test('get_time when the clock does not open: the result carries the time, so the model can still say it', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts, config: {actionTimeoutMs: 80}});
    await youSay(h, 'what time is it');
    callReply(h, 'r1', '', [['get_time', {show: 'time'}, 'c1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const output = h.sent.find(e => e.type === 'conversation.item.create' && e.item.call_id === 'c1');
    assert.deepEqual(JSON.parse(output.item.output), {ok: false, error: 'the clock did not open', time: '3:07 PM', date: 'Friday, November 13, 2026', note: 'say it yourself'});
    reply(h, 'r2', "It's seven past three.");
    await untilListening(h);
    assert.equal(h.said.at(-1), "It's seven past three.");
    h.talk.close();
});

test('back after the clock showed the time: the note says your clock took over, with no timer facts', async () => {
    const h = harness({actions: fakeActions(), resume: {pairs: [{you: 'what time is it', jibo: ''}], tool: 'get_time', args: {show: 'time'}, said: "It's 3:07."}});
    h.talk.open();
    await untilListening(h);
    const note = h.sent.find(e => e.type === 'conversation.item.create').item.content[0].text;
    assert.match(note, /you used get_time \(the time\) and your clock took over\. Your clock said: "It's 3:07\."/);
    assert.doesNotMatch(note, /timer|alarm/);
    h.talk.close();
});
test('dance runs in Noggin with a dance with music; the reply after it never dances again', async () => {
    const h = await listening({actions: fakeActions(), classify: () => Promise.resolve({label: 'dance'})});
    await danceTurn(h, 'can you dance for me', 1);
    assert.equal(playedDances(h).length, 1);
    assert.equal(h.said.at(-1), 'That was fun!', 'no dance expression on the line');
    const log = h.logs.find(e => e.kind === 'speak' && e.from);
    assert.equal(log.from, 'random'); assert.ok(catalog.danceStyles(log.anim).includes(log.dance));
    assert.equal(danceOutput(h).done, 'Jibo danced'); assert.match(danceOutput(h).dance, /^(a|the) /);
    h.talk.close();
});

test('dance: the style the person names, "again" replays it, otherwise no repeat of the last three', async () => {
    const h = await listening({actions: fakeActions()});
    await danceTurn(h, 'Jibo, do the robot!', 1);
    const robot = playedDances(h)[0];
    assert.ok(dancesIn('robot').includes(robot));
    assert.equal(danceOutput(h).dance, 'the robot');
    await danceTurn(h, 'do that again', 2);
    assert.equal(playedDances(h)[1], robot, 'again: the same dance');
    assert.equal(h.logs.filter(e => e.kind === 'speak' && e.from).at(-1).from, 'again');
    await danceTurn(h, 'another one please', 3);
    await danceTurn(h, 'and another dance', 4);
    const played = playedDances(h);
    assert.equal(new Set(played.slice(1)).size, 3, 'none of the last three again: ' + played.join(', '));
    await danceTurn(h, 'a slow dance', 5);
    assert.ok(dancesIn('slow').includes(playedDances(h)[4]));
    assert.ok(!h.said.some(e => /Robot mode|robot dance!/.test(e)), 'random 0.5: nothing announced');
    h.talk.close();
});

test('dance: no transcript in time means a random dance, never the previous turn\'s words', async () => {
    const h = await listening({actions: fakeActions(), random: () => 0});
    await danceTurn(h, 'do the robot', 1);
    h.emit({type: 'input_audio_buffer.speech_stopped'});   // no transcript this time
    callReply(h, 'd2', '', [['dance', {}, 'call_dance_2']]);
    await until(() => h.sent.filter(e => e.type === 'response.create').length >= 2);
    assert.equal(h.logs.filter(e => e.kind === 'speak' && e.from).at(-1).from, 'random');
    h.talk.close();
});

test('a tool turn without a transcript: a quick follow-up is still spoken and Jibo listens again', async () => {
    const h = await listening({actions: fakeActions()});
    try {
        h.emit({type: 'input_audio_buffer.speech_stopped'});   // no transcript ever comes
        callReply(h, 'd1', '', [['dance', {}, 'call_dance_1']]);
        await until(() => h.sent.some(e => e.type === 'response.create'));
        reply(h, 'f1', 'That was fun!');   // well within transcriptWaitMs of the follow-up's start
        await untilListening(h);
        assert.equal(h.said.at(-1), 'That was fun!');
        // An empty follow-up (only the tool result, no words) also ends in listening.
        h.emit({type: 'input_audio_buffer.speech_stopped'});
        callReply(h, 'd2', '', [['dance', {}, 'call_dance_2']]);
        await until(() => h.sent.filter(e => e.type === 'response.create').length >= 2);
        h.emit({type: 'response.created', response: {id: 'f2'}});
        h.emit({type: 'response.done', response: {id: 'f2', status: 'completed'}});
        await untilListening(h);
    } finally { h.talk.close(); }
});

test('a tool turn without a transcript: words transcribed during the follow-up are logged and never drop it', async () => {
    const h = await listening({actions: fakeActions()});
    try {
        h.emit({type: 'input_audio_buffer.speech_stopped'});
        h.emit({type: 'input_audio_buffer.committed', item_id: 'item_d1'});
        callReply(h, 'd1', '', [['dance', {}, 'call_dance_1']]);
        await until(() => h.sent.some(e => e.type === 'response.create'));
        h.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_other', transcript: 'not these'});
        h.emit({type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_d1', transcript: ' '});
        reply(h, 'f1', 'That was fun!');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'That was fun!');
        assert.deepEqual(h.logs.filter(e => e.kind === 'you' && e.late).map(e => e.text), ['']);
        assert.ok(!h.logs.some(e => e.kind === 'skipped'), 'an empty late transcript never drops the follow-up');
    } finally { h.talk.close(); }
});

test('a tool turn without a transcript: a goodbye transcribed during the follow-up ends the conversation', async () => {
    const h = harness({actions: fakeActions()});
    const ended = h.talk.open(); await untilListening(h);
    try {
        h.emit({type: 'input_audio_buffer.speech_stopped'});
        callReply(h, 'd1', '', [['dance', {}, 'call_dance_1']]);
        await until(() => h.sent.some(e => e.type === 'response.create'));
        h.emit({type: 'conversation.item.input_audio_transcription.completed', transcript: 'Goodbye Jibo.'});
        reply(h, 'f1', 'Bye!');
        assert.equal(await ended, 'goodbye');
        assert.equal(h.said.at(-1), 'Bye!');
    } finally { h.talk.close(); }
});

test('reply guard: a complete reply that was held back with nothing to release it is spoken anyway', async () => {
    const h = await listening({config: {replyWaitMs: 300}});
    try {
        h.emit({type: 'input_audio_buffer.speech_stopped'});
        clearTimeout(h.talk.turn.waitTimer);   // the timer that would release it is gone
        reply(h, 'r1', 'Still here.');
        await sleep(200); assert.equal(h.said.length, 1, 'held back for the transcript');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Still here.');
        assert.ok(h.logs.some(e => e.kind === 'reply_stalled'));
    } finally { h.talk.close(); }
});

test('reply guard: a reply that stops coming after Jibo began to say it is cut there, and its late rest is ignored', async () => {
    const h = await listening({config: {replyWaitMs: 300}});
    try {
        youSay(h, 'tell me a story');
        reply(h, 'r1', 'Once upon a time. There was a', false);   // no response.done: the connection went quiet
        await until(() => h.said.includes('Once upon a time.'));
        await untilListening(h);
        const cut = h.logs.find(e => e.kind === 'reply_stalled');
        assert.ok(cut && cut.cut, 'logged as cut');
        assert.ok(h.sent.some(e => e.type === 'response.cancel'));
        assert.ok(!h.said.some(e => /There was/.test(e)), 'the unfinished sentence is not said');
        h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: ' dragon.'});
        h.emit({type: 'response.done', response: {id: 'r1', status: 'completed', output: [{id: 'it1'}]}});
        await sleep(100);
        assert.equal(h.talk.state, 'listening');
        assert.ok(h.sent.some(e => e.type === 'conversation.item.delete' && e.item_id === 'it1'), 'the late reply is forgotten');
    } finally { h.talk.close(); }
});

test('reply guard: a long reply whose text keeps coming is not cut', async () => {
    const h = await listening({config: {replyWaitMs: 300}});
    try {
        youSay(h, 'tell me a story');
        h.emit({type: 'response.created', response: {id: 'r1'}});
        // The first sentence at once, the rest slowly: 840 ms in all, over twice the guard's wait.
        for (const w of ['Once upon a time. ', 'The ', 'dragon ', 'slept ', 'all ', 'day ', 'long. ', 'The end.']) {
            h.emit({type: 'response.output_text.delta', response_id: 'r1', delta: w}); await sleep(120);
        }
        h.emit({type: 'response.done', response: {id: 'r1', status: 'completed'}});
        await untilListening(h);
        assert.ok(!h.logs.some(e => e.kind === 'reply_stalled'));
        assert.deepEqual(h.said.slice(1), ['Once upon a time.', 'The dragon slept all day long. The end.']);
    } finally { h.talk.close(); }
});

test('danceAnnounce: always names the dance first and tells the model; off never', async () => {
    const h = await listening({actions: fakeActions(), config: {danceAnnounce: 'always'}});
    await danceTurn(h, 'do the robot', 1);
    // ONE speak: the words, then the dance. Two speaks (the line, then the dance 6 ms later) cut the
    // dance to about half a second on the robot and in the sim.
    const spoken = h.said.filter(e => /Robot mode/.test(e) || DANCE_NAMES.has((/name='([^']+)'/.exec(e) || [])[1]));
    assert.equal(spoken.length, 1, h.said.join(' | '));
    assert.match(spoken[0], /^Robot mode: on! <anim name='[A-Za-z0-9_]+' endNeutral='true'\/>$/, 'random 0.5: the second robot line, then the dance');
    assert.match(danceOutput(h).announced, /do not name it again/);
    h.talk.close();
    const off = await listening({actions: fakeActions(), config: {danceAnnounce: 'off'}, random: () => 0});
    await danceTurn(off, 'dance for me', 1);
    assert.equal(off.said.filter(e => !/^</.test(e)).join('|'), 'Hi!|That was fun!');
    assert.equal(danceOutput(off).announced, undefined);
    off.talk.close();
});

test('dance without actions: the line\'s dance expression follows the person\'s words too', async () => {
    const h = await listening({config: {actions: false}, classify: () => Promise.resolve({label: 'dance'})});
    await youSay(h, 'can you do a twerk dance');  // without actions a dance needs the word "dance" (ExpressionPolicy)
    reply(h, 'r1', 'Watch this!');
    await untilListening(h);
    assert.ok(dancesIn('twerk').includes(playedDances(h)[0]), h.said.join(' | '));
    h.talk.close();
});

test('danceChoice, pickDance and danceAnnounce', () => {
    assert.deepEqual(catalog.danceChoice('Can you do the robot?'), {style: 'robot'});
    assert.deepEqual(catalog.danceChoice('Jibo, can you twerk'), {style: 'twerk'});
    assert.deepEqual(catalog.danceChoice('do a slow dance'), {style: 'slow'});
    assert.deepEqual(catalog.danceChoice('show me your belly dance'), {style: 'belly'});
    assert.deepEqual(catalog.danceChoice('Again!'), {again: true});
    assert.deepEqual(catalog.danceChoice('one more time'), {again: true});
    assert.deepEqual(catalog.danceChoice('do the robot again'), {again: true, style: 'robot'});
    assert.deepEqual(catalog.danceChoice('another one'), {});
    assert.deepEqual(catalog.danceChoice('dance for me'), {});
    assert.deepEqual(catalog.danceChoice('dance around the house'), {}, '"house" alone is no style');
    assert.deepEqual(catalog.danceChoice('a robotic funk dance', () => 0), {style: 'funk'}, 'two styles: one at random');
    assert.deepEqual(catalog.danceChoice('a robotic funk dance', () => 0.99), {style: 'robot'});
    assert.deepEqual(catalog.danceChoice(null), {});
    assert.equal(catalog.pickDance('waltz', {recent: ['Waltz_01_01']}), 'Waltz_01_01', 'the only one: even if recent');
    const robots = dancesIn('robot');
    assert.equal(catalog.pickDance('robot', {recent: robots.slice(1)}), robots[0]);
    assert.ok(DANCE_NAMES.has(catalog.pickDance(null)) && DANCE_NAMES.has(catalog.pickDance('nonsense')));
    assert.equal(catalog.danceName('robot'), 'the robot'); assert.equal(catalog.danceName(null), 'a dance');
    assert.ok(Object.keys(catalog.DANCES).every(style => catalog.danceLine(style, () => 0) && !/[<>&]/.test(catalog.danceLine(style, () => 0.99))));
    assert.equal(catalog.danceAnnounce('always', 'keyword', 0), true);
    assert.equal(catalog.danceAnnounce('off', 'random', 9, () => 0), false);
    assert.equal(catalog.danceAnnounce('sometimes', 'random', Infinity, () => 0.1), true);
    assert.equal(catalog.danceAnnounce('sometimes', 'random', Infinity, () => 0.5), false, 'about one in three');
    assert.equal(catalog.danceAnnounce('sometimes', 'keyword', Infinity, () => 0), false, 'not when the person named the style');
    assert.equal(catalog.danceAnnounce('sometimes', 'random', 2, () => 0), false, 'not twice within three dances');
});

test('dance catalogue: 28 dances with music in 12 styles, each a real dance with its own music', {skip: !fs.existsSync(ANIMDB) && 'no animdb.json here'}, () => {
    const anims = JSON.parse(fs.readFileSync(ANIMDB, 'utf8'));
    const withMusic = Object.values(anims).filter(a => a.categories.includes('dance') && a.hasAudio).map(a => a.name);
    assert.deepEqual([...DANCE_NAMES].sort(), withMusic.sort());
    assert.equal(Object.keys(catalog.DANCES).length, 12);
});

test('set_timer: Jibo says "Okay!", then hands over to the clock with its NLU; Noggin ends as a handover', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts});
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'set a timer for ten minutes');
    callReply(h, 'r1', 'Okay!', [['set_timer', {minutes: 10}]]);
    await until(() => acts.redirects.length === 1);
    assert.equal(h.said.at(-1), 'Okay!');
    assert.deepEqual(acts.redirects[0], ['@be/clock', {nlu: {intent: 'start', entities: {domain: 'timer', hours: '0', minutes: '10', seconds: 'null', time: 'null', ampm: 'null'}}, match: {skipSurprises: true}}]);
    assert.equal(acts.handovers[0].tool, 'set_timer');
    assert.equal(acts.handovers[0].comeback, true);
    assert.deepEqual(acts.handovers[0].args, {seconds: 600, duration: '10 minutes'});
    assert.deepEqual(acts.handovers[0].pairs, [{you: 'set a timer for ten minutes', jibo: 'Okay!'}]);
    assert.equal(h.talk.state, 'handover');
    h.talk.close('closed');   // Be closes Noggin for the clock
    assert.equal(await ended, 'handover');
    assert.ok(h.logs.some(e => e.kind === 'session_end' && e.reason === 'handover'));
});

test('a handover that does not happen in time: the model hears it failed and the conversation goes on', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts, config: {actionTimeoutMs: 80}});
    await youSay(h, 'cancel my timer');
    callReply(h, 'r1', '', [['cancel_timer', {}, 'c9']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.equal(acts.failed, 1);
    const output = h.sent.find(e => e.type === 'conversation.item.create' && e.item.call_id === 'c9');
    assert.deepEqual(JSON.parse(output.item.output), {ok: false, error: 'the clock did not open'});
    reply(h, 'r2', "Hmm, my clock didn't open.");
    await untilListening(h);
    h.talk.close();
});

test('bad timer arguments and unknown tools come back as errors, without a handover', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'set a timer for three seconds');
    callReply(h, 'r1', '', [['set_timer', {seconds: 3}, 'a'], ['format_disk', {}, 'b']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const outputs = h.sent.filter(e => e.type === 'conversation.item.create').map(e => JSON.parse(e.item.output));
    assert.deepEqual(outputs, [{ok: false, error: 'a timer must be longer than 5 seconds'}, {ok: false, error: 'unknown tool format_disk'}]);
    assert.equal(acts.redirects.length, 0);
    h.talk.close();
});

test('check_clock reads the clock in Noggin; if it cannot, the clock answers instead', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'how long is left on my timer');
    callReply(h, 'r1', '', [['check_clock']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const out = JSON.parse(h.sent.find(e => e.type === 'conversation.item.create').item.output);
    assert.equal(out.timer.remaining, '5 minutes'); assert.deepEqual(out.alarm, {set: false});
    h.talk.close();
    const blind = fakeActions({readClock: () => Promise.resolve(null)});
    const g = await listening({actions: blind});
    await youSay(g, 'how long is left on my timer');
    callReply(g, 'r1', '', [['check_clock']]);
    await until(() => blind.redirects.length === 1);
    assert.deepEqual(blind.redirects[0][1].nlu, {intent: 'query', entities: {domain: 'timer'}});
    g.talk.close();
});

test('open_app: only listed apps; Noggin comes back afterwards, like use_skill', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts, config: {openApps: {recipes: {pkg: '@be/recipe', about: 'Recipes to cook along with'}}}});
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'open recipes');
    callReply(h, 'r1', '', [['open_app', {name: 'Recipes'}]]);
    await until(() => acts.redirects.length === 1);
    assert.deepEqual(acts.redirects[0], ['@be/recipe', {nlu: {intent: 'menu', entities: {domain: '@be/recipe'}}, match: {skipSurprises: true}}]);
    assert.equal(acts.handovers[0].comeback, true);
    assert.deepEqual(acts.handovers[0].args, {name: 'recipes'});
    h.jibo.jetstream.events.skillSwitch.fire();
    assert.equal(await ended, 'handover');
    // Back: the model hears it opened the app, by name.
    assert.match(realtime.resumeNote({tool: 'open_app', args: {name: 'recipes'}, pairs: []}, null, 'Anything else?'), /Then you used open_app \(recipes\) and that app took over/);
});

test('cancel_timer / cancel_alarm: nothing set in the clock\'s record means no handover; the model says so', async () => {
    const acts = fakeActions({readClock: () => Promise.resolve({timer: {set: false}, alarm: {set: false}})});
    const h = await listening({actions: acts});
    await youSay(h, 'cancel my alarm');
    callReply(h, 'r1', '', [['cancel_alarm', {}, 'x1']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 'x1').item.output), {ok: true, cancelled: false, note: 'no alarm is set'});
    assert.equal(acts.redirects.length, 0);
    h.talk.close();
    // An alarm is set: the clock cancels it and Noggin comes back.
    const set = fakeActions({readClock: () => Promise.resolve({timer: {set: false}, alarm: {set: true, time: '7:30 AM', day: 'Saturday'}})});
    const g = await listening({actions: set});
    await youSay(g, 'cancel my alarm');
    callReply(g, 'r1', '', [['cancel_alarm']]);
    await until(() => set.redirects.length === 1);
    assert.deepEqual(set.redirects[0], ['@be/clock', {nlu: {intent: 'stop', entities: {domain: 'alarm'}}, match: {skipSurprises: true}}]);
    assert.equal(set.handovers[0].tool, 'cancel_alarm'); assert.equal(set.handovers[0].comeback, true);
    g.talk.close();
});

test('set_alarm hands over to the clock with a 12-hour time and upper-case AM/PM, and comes back', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'wake me at half past seven tonight');
    callReply(h, 'r1', '', [['set_alarm', {hour: 19, minute: 30}]]);
    await until(() => acts.redirects.length === 1);
    assert.deepEqual(acts.redirects[0][1].nlu, {intent: 'set', entities: {domain: 'alarm', time: '7:30', ampm: 'PM', hours: 'null', minutes: 'null', seconds: 'null'}});
    assert.deepEqual(acts.handovers[0].args, {time: '7:30 PM'});
    assert.equal(acts.handovers[0].comeback, true);
    h.talk.close();
});

test('set_volume runs in Noggin; the result goes back to the model', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'turn your volume to three');
    callReply(h, 'r1', '', [['set_volume', {level: 3}, 'v']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.deepEqual(acts.volume, {level: 3});
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 'v').item.output), {ok: true, volume: 3, of: 10});
    h.talk.close();
});

test('use_skill and play_game hand over and come back; play_music and play_radio leave', async () => {
    const acts = fakeActions();
    const h = await listening({actions: acts});
    await youSay(h, 'play word of the day');
    callReply(h, 'r1', '', [['play_game', {name: 'word of the day'}]]);
    await until(() => acts.redirects.length === 1);
    assert.deepEqual(acts.redirects[0], ['@be/word-of-the-day', {nlu: {intent: 'play', entities: {domain: 'word-of-the-day'}}, match: {skipSurprises: true}}]);
    assert.equal(acts.handovers[0].comeback, true);
    h.talk.close();
    const skills = fakeActions();
    const k = await listening({actions: skills});
    await youSay(k, 'take a photo of us');
    callReply(k, 'r1', '', [['use_skill', {name: 'take a photo'}]]);
    await until(() => skills.redirects.length === 1);
    assert.equal(skills.redirects[0][0], '@be/create');
    assert.equal(skills.handovers[0].comeback, true);
    k.talk.close();
    const music = fakeActions();
    const g = harness({actions: music});
    const ended = g.talk.open(); await untilListening(g);
    await youSay(g, 'play bohemian rhapsody by queen');
    callReply(g, 'r1', 'Enjoy!', [['play_music', {song: 'Bohemian Rhapsody', artist: 'Queen'}]]);
    await until(() => music.redirects.length === 1);
    assert.deepEqual(music.redirects[0], ['@be/music', {nlu: {intent: 'playSong', entities: {domain: 'music', query: 'Bohemian Rhapsody', artist: 'Queen'}}, match: {skipSurprises: true}}]);
    assert.equal(music.handovers[0].comeback, false);
    g.jibo.jetstream.events.skillSwitch.fire();
    assert.equal(await ended, 'leaves', 'music ends the conversation');
});

test('go_to_sleep and look_away leave for @be/idle with the intent Jibo\'s own commands carry', async () => {
    for (const [name, intent] of [['go_to_sleep', 'sleep'], ['look_away', 'turnAway']]) {
        const acts = fakeActions();
        const h = harness({actions: acts});
        const ended = h.talk.open(); await untilListening(h);
        await youSay(h, 'please ' + name.replace(/_/g, ' '));
        callReply(h, 'r1', 'Goodnight!', [[name, {}]]);
        await until(() => acts.redirects.length === 1);
        assert.deepEqual(acts.redirects[0], ['@be/idle', {nlu: {intent: intent, entities: {domain: 'idle'}}, match: {skipSurprises: true}}]);
        assert.equal(acts.handovers[0].comeback, false);
        h.jibo.jetstream.events.skillSwitch.fire();
        assert.equal(await ended, 'leaves', name + ' ends the conversation');
    }
});

test('open_app: an extra app that is not installed fails at once, without waiting for the timeout', async () => {
    const acts = fakeActions({installed: pkg => pkg !== '@be/stargazer'});
    const h = await listening({actions: acts, config: {openApps: {stargazer: '@be/stargazer'}, actionTimeoutMs: 60000}});
    await youSay(h, 'open stargazer');
    const asked = Date.now();
    callReply(h, 'r1', '', [['open_app', {name: 'stargazer'}, 's']]);
    await until(() => h.sent.some(e => e.type === 'response.create'));
    assert.ok(Date.now() - asked < 1000);
    assert.deepEqual(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 's').item.output), {ok: false, error: 'that app is not installed on Jibo'});
    assert.equal(acts.redirects.length, 0); assert.equal(acts.failed, 1);
    h.talk.close();
    // Built-in apps are part of Jibo: no check.
    const builtin = fakeActions({installed: () => false});
    const g = await listening({actions: builtin});
    await youSay(g, 'open the gallery');
    callReply(g, 'r1', 'Bye!', [['open_app', {name: 'gallery'}]]);
    await until(() => builtin.redirects.length === 1);
    assert.equal(builtin.redirects[0][0], '@be/gallery');
    g.talk.close();
});

test('back after another skill: the note names that skill, with no clock facts', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts, resume: {pairs: [{you: 'take a picture', jibo: ''}], tool: 'use_skill', args: {name: 'take a photo'}, said: 'Get ready. Three. two. one.'}});
    h.talk.open();
    await untilListening(h);
    const note = h.sent.find(e => e.type === 'conversation.item.create').item.content[0].text;
    assert.match(note, /you used use_skill \(take a photo\) and that skill took over\. That skill said: "Get ready/);
    assert.doesNotMatch(note, /timer|alarm/);
    h.talk.close();
});

test('back after another skill: a listen that skill left open is cancelled once; a fresh or "Hey Jibo" open cancels nothing (D194)', async () => {
    const back = harness({actions: fakeActions(), resume: {pairs: [], tool: 'use_skill', args: {name: 'take a photo'}, said: 'Should I save it?'}});
    let cancels = 0;
    // A refused cancel (BE's answer is a promise) is caught: no unhandled rejection.
    back.jibo.jetstream.cancelAnyTurn = () => { cancels++; return Promise.reject(Error('not connected')); };
    back.talk.open();
    await untilListening(back);
    assert.equal(cancels, 1);
    assert.equal(back.logs.find(e => e.kind === 'startup').turn_cancel, 'sent');
    back.talk.close();
    const fresh = harness({actions: fakeActions()});
    fresh.jibo.jetstream.cancelAnyTurn = () => { cancels++; };
    fresh.talk.open();
    await untilListening(fresh);
    assert.equal(cancels, 1);
    assert.equal(fresh.logs.find(e => e.kind === 'startup').turn_cancel, undefined);
    fresh.talk.close();
    // A Jibo without cancelAnyTurn: logged, and the conversation goes on.
    const old = harness({actions: fakeActions(), resume: {pairs: [], tool: 'use_skill', args: {name: 'take a photo'}, said: ''}});
    old.talk.open();
    await untilListening(old);
    assert.equal(old.logs.find(e => e.kind === 'startup').turn_cancel, 'unavailable');
    old.talk.close();
    // "Hey Jibo" opened Noggin within a comeback's window: its own timed cancel only (D136).
    const hey = harness({actions: fakeActions(), heyJibo: {heardAt: Date.now()}, resume: {pairs: [], tool: 'use_skill', args: {name: 'take a photo'}, said: ''}});
    hey.jibo.jetstream.cancelAnyTurn = () => { cancels++; };
    hey.talk.open();
    await untilListening(hey);
    assert.equal(cancels, 1);
    assert.equal(hey.logs.find(e => e.kind === 'startup').turn_cancel, undefined);
    hey.talk.close();
});

test('tool rounds are limited: a third round in a row is refused and Jibo listens', async () => {
    const h = await listening({actions: fakeActions()});
    await youSay(h, 'what is your favorite movie');
    callReply(h, 'r1', '', [['about_jibo', {}, 'a']]);
    await until(() => h.sent.filter(e => e.type === 'response.create').length === 1);
    callReply(h, 'r2', '', [['about_jibo', {}, 'b']]);
    await until(() => h.sent.filter(e => e.type === 'response.create').length === 2);
    callReply(h, 'r3', '', [['about_jibo', {}, 'c']]);
    await untilListening(h);
    const last = h.sent.filter(e => e.type === 'conversation.item.create').at(-1);
    assert.deepEqual(JSON.parse(last.item.output), {ok: false, error: 'too many actions in a row'});
    assert.equal(h.sent.filter(e => e.type === 'response.create').length, 2);
    h.talk.close();
});

test('without actions, function calls are ignored as in 0.5', async () => {
    const h = await listening();
    await youSay(h, 'what time is it');
    callReply(h, 'r1', 'No idea!', [['get_time']]);
    await untilListening(h);
    assert.ok(!h.sent.some(e => e.type === 'response.create' || e.type === 'conversation.item.create'));
    h.talk.close();
});

test('resume after the clock without a comeback line: no greeting; the conversation and the timer facts go to the model, which speaks next', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts, config: {comebackLine: ''}, resume: {pairs: [{you: 'set a timer for five minutes', jibo: 'Okay!'}], tool: 'set_timer', args: {seconds: 300, duration: '5 minutes'}, said: 'You got it. 5 minutes.'}});
    h.talk.open();
    await until(() => h.sent.some(e => e.type === 'response.create'));
    const note = h.sent.find(e => e.type === 'conversation.item.create').item;
    assert.equal(note.role, 'system');
    assert.match(note.content[0].text, /Person: set a timer for five minutes\nJibo: Okay!/);
    assert.match(note.content[0].text, /set_timer for 5 minutes/);
    assert.match(note.content[0].text, /Your clock said: "You got it. 5 minutes."/);
    assert.match(note.content[0].text, /A timer is now running with 5 minutes left/);
    reply(h, 'r1', 'Anything else?');
    await untilListening(h);
    assert.deepEqual(h.said, ['Anything else?'], 'no greeting');
    assert.ok(h.logs.some(e => e.kind === 'session' && e.resumed === 'set_timer'));
    assert.ok(h.logs.some(e => e.kind === 'resume' && e.clock.timer.set === true));
    h.talk.close();
});

test('a follow-up reply that never comes does not leave Jibo stuck', async () => {
    const h = await listening({actions: fakeActions(), config: {replyWaitMs: 80}});
    await youSay(h, 'what is your favorite movie');
    callReply(h, 'r1', '', [['about_jibo']]);
    await sleep(40); assert.equal(h.talk.state, 'thinking');
    await untilListening(h);
    assert.ok(h.logs.some(e => e.kind === 'skipped' && e.reason === 'no_reply'));
    h.talk.close();
});

test('persona with actions: the tool rules replace "no tools", and the time is the home timezone\'s', () => {
    const text = realtime.instructions('', '', {});
    assert.match(text, /use your timer and alarm, .*open your apps, go to sleep, and look away\./);
    assert.match(realtime.sessionNote({year: 2026, monthNum: 10, date: 13, dayOfWeek: 'Friday', hour: 9, minute: 5}), /Friday, November 13, 2026, 9:05 AM local time/);
    assert.doesNotMatch(text, /in this voice mode you have no tools/);
});

// ---- Jibo's cloud features ----
test('cloud tools: only those in cloudSkills go in session.update, and the instructions name only those', async () => {
    const h = await listening({actions: fakeActions(), config: {cloudSkills: ['surprise', 'joke']}});
    const names = h.sent.find(e => e.type === 'session.update').session.tools.map(t => t.name);
    assert.ok(names.includes('surprise')); assert.ok(!names.includes('weather') && !names.includes('news'));
    assert.ok(names.includes('joke'), 'joke is optional: listed, it is offered');
    h.talk.close();
    const text = realtime.voiceSetup({cloudSkills: ['surprise']});
    assert.match(text, /ask your cloud for a surprise/); assert.doesNotMatch(text, /weather|news|joke/);
    assert.doesNotMatch(realtime.voiceSetup({}), /cloud/);
});

test('local tools: the get_time and about_jibo sentences follow the tools that are on, and no tools reads as no tools', () => {
    const setup = config => realtime.voiceSetup(config);
    assert.match(setup({localSkills: ['get_time']}), /always use get_time\. Apart/);
    assert.doesNotMatch(setup({localSkills: ['get_time']}), /about_jibo/);
    assert.match(setup({localSkills: ['about_jibo']}), /done unless a tool result says so\. For a question about yourself/);
    assert.doesNotMatch(setup({localSkills: ['about_jibo']}), /get_time/);
    assert.match(setup({}), /always use get_time; for a question about yourself .* use about_jibo\. /);
    const none = setup({localSkills: [], cloudSkills: []});
    assert.match(none, /you have no tools, files or saved memory/);
    assert.equal(none.split('You cannot see the room yet').length, 2, 'said once');
    assert.doesNotMatch(none, /Only when your person asks/);
    const memoryOnly = realtime.voiceSetup({localSkills: [], cloudSkills: [], memory: true}, {learn: true});
    assert.match(memoryOnly, /your tools let you keep, forget and look up memories/, 'the memory tools are still named');
    assert.match(memoryOnly, /use remember or forget/);
    assert.doesNotMatch(memoryOnly, /get_time|about_jibo|cloud/);
    assert.equal(memoryOnly.split('You cannot see the room yet').length, 2, 'said once');
    assert.doesNotMatch(actions.tools({localSkills: [], cloudSkills: ['picture']})[0].description, /use_skill/, 'picture does not point at a tool that may be off');
});

test('a cloud tool: no words first; the hotword is given back, then the cloud gets the fixed phrase; the turn Be starts ends Noggin as a handover', async () => {
    const asked = [];
    const acts = fakeActions();
    const h = harness({actions: acts, config: {cloudSkills: ['weather']}});
    const order = cloudJetstream(h);
    acts.cloud = phrase => { order.push('ask'); asked.push(phrase); return Promise.resolve(); };
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'what is the weather like in Paris tomorrow?');
    callReply(h, 'r1', '', [['weather', {city: 'Paris'}]]);
    await until(() => asked.length === 1);
    assert.deepEqual(asked, ['tell me about the weather'], 'the menu\'s phrase, never the model\'s words');
    assert.deepEqual(order, ['off', 'release', 'ask'], 'the hotword is back before the cloud is asked');
    assert.equal(acts.redirects.length, 0);
    assert.equal(acts.handovers[0].tool, 'weather'); assert.equal(acts.handovers[0].target, '@be/nimbus'); assert.equal(acts.handovers[0].comeback, true);
    assert.ok(h.logs.some(e => e.kind === 'handover' && e.tool === 'weather' && e.phrase === 'tell me about the weather'));
    assert.equal(h.talk.state, 'handover');
    h.jibo.jetstream.events.globalTurnStarted.fire();   // the robot's speech service starts the cloud's turn
    assert.equal(await ended, 'handover');
    assert.equal(order.filter(x => x === 'release').length, 1, 'released once, not again on close');
});

test('opened by "Hey Jibo", a quick cloud tool: its turn ends Noggin as a handover, and the shared claim is released (D132)', async () => {
    const acts = fakeActions(), asked = [];
    const h = harness({actions: acts, config: {cloudSkills: ['weather']}, heyJibo: {heardAt: Date.now()}});
    cloudJetstream(h);
    acts.cloud = phrase => { asked.push(phrase); return Promise.resolve(); };
    global.nogginHeyJibo = {claimedAt: Date.now()};
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'what is the weather?');
    callReply(h, 'r1', '', [['weather', {}]]);
    await until(() => asked.length === 1);
    assert.equal(global.nogginHeyJibo.claimedAt, null, 'background.js will not cancel this turn');
    h.jibo.jetstream.events.globalTurnStarted.fire();
    assert.equal(await ended, 'handover');
    assert.ok(!h.logs.some(e => e.kind === 'hey_jibo_turn'));
    delete global.nogginHeyJibo;
});

test('a cloud tool whose hotword release never answers (the simulator) is still asked, after at most 1.5 s', async () => {
    const asked = [];
    const acts = fakeActions();
    const h = harness({actions: acts, config: {cloudSkills: ['news']}});
    cloudJetstream(h, () => new Promise(() => {}));
    acts.cloud = phrase => { asked.push(phrase); return Promise.resolve(); };
    h.talk.open(); await untilListening(h);
    await youSay(h, 'any news?');
    const at = Date.now();
    callReply(h, 'r1', '', [['news', {}]]);
    await until(() => asked.length === 1, 2500);
    assert.ok(Date.now() - at >= 1400, 'waited for the release');
    assert.deepEqual(asked, ['tell me about the news']);
    h.talk.close();
});

test('a cloud tool that fails or is never answered: the model hears it, the hotword goes off again, and the conversation goes on', async () => {
    for (const [cloud, error] of [[() => Promise.reject(Error('jetstream down')), /^Jibo's cloud could not be asked: jetstream down$/],
        [() => Promise.resolve(), /^Jibo's cloud did not answer$/],
        // mimicGlobalTurn that never answers (the simulator): the reply after it must not wait for it.
        [() => new Promise(() => {}), /^Jibo's cloud did not answer$/]]) {
        const acts = fakeActions();
        const h = harness({actions: acts, config: {cloudSkills: ['surprise'], actionTimeoutMs: 80}});
        const order = cloudJetstream(h);
        acts.cloud = cloud;
        h.talk.open(); await untilListening(h);
        await youSay(h, 'surprise me');
        callReply(h, 'r1', '', [['surprise', {}, 'j1']]);
        await until(() => h.sent.some(e => e.type === 'conversation.item.create' && e.item.call_id === 'j1'));
        const output = JSON.parse(h.sent.find(e => e.type === 'conversation.item.create' && e.item.call_id === 'j1').item.output);
        assert.equal(output.ok, false); assert.match(output.error, error);
        assert.equal(acts.failed, 1, 'index.js stops watching and clears disableOnce');
        assert.deepEqual(order, ['off', 'release', 'off'], 'Noggin has the hotword off again');
        await until(() => h.sent.some(e => e.type === 'response.create'));
        reply(h, 'r2', 'Hmm, my surprise got stuck.');
        await untilListening(h);
        h.talk.close();
    }
});

test('a cloud tool that is not switched on is refused without asking the cloud', async () => {
    const acts = fakeActions();
    let asked = 0; acts.cloud = () => { asked++; return Promise.resolve(); };
    const h = await listening({actions: acts, config: {cloudSkills: []}});
    await youSay(h, 'what is the weather?');
    callReply(h, 'r1', '', [['weather', {}, 'w1']]);
    await until(() => h.sent.some(e => e.type === 'conversation.item.create' && e.item.call_id === 'w1'));
    assert.match(JSON.parse(h.sent.find(e => e.item && e.item.call_id === 'w1').item.output).error, /not switched on/);
    assert.equal(asked, 0); assert.equal(acts.handovers.length, 0);
    h.talk.close();
});

test('back after the cloud: the note says your cloud took over and what it said', async () => {
    const h = harness({actions: fakeActions(), resume: {pairs: [{you: 'what is the weather?', jibo: ''}], tool: 'weather', args: {}, said: 'Today will be sunny.'}});
    h.talk.open();
    await untilListening(h);
    const note = h.sent.find(e => e.type === 'conversation.item.create').item.content[0].text;
    assert.match(note, /you used weather and your cloud took over\. Your cloud said: "Today will be sunny\."/);
    assert.match(note, /do not repeat what your cloud already said/);
    h.talk.close();
});

test('cloud tools are all on by default, except joke, and the default stays in step with actions.CLOUD', () => {
    const actions = require(path.join(source, 'noggin/lib/actions.js'));
    const live = Object.keys(actions.CLOUD).filter(name => name !== 'joke');
    assert.deepEqual(DEFAULTS.cloudSkills, live);
    assert.ok(DEFAULTS.cloudSkills.length >= 6 && DEFAULTS.cloudSkills.indexOf('joke') < 0);
    assert.deepEqual(actions.cloudSkills(DEFAULTS), live, 'every default name is really offered');
});

test('back after a picture: the note names what was shown, and that the cloud did it', () => {
    const note = realtime.resumeNote({pairs: [{you: 'show me a horse', jibo: ''}], tool: 'picture', args: {subject: 'a horse'}, said: 'Here\'s a picture of a horse.'}, null, 'Anything else?');
    assert.match(note, /you used picture \(of a horse\) and your cloud took over\. Your cloud said: "Here's a picture of a horse\."/);
});

// ---- moved here from other sections ----
test('timer tools: the instructions and tool descriptions say to call them without words first', () => {
    const text = realtime.voiceSetup({});
    assert.match(text, /For get_time, set_timer, cancel_timer, set_alarm, cancel_alarm, use_skill, play_game and open_app, call the tool without saying anything first/);
    assert.doesNotMatch(text, /"Okay!"/);
    const tools = require(path.join(source, 'noggin/lib/actions.js')).tools({});
    for (const name of ['get_time', 'set_timer', 'cancel_timer', 'set_alarm', 'cancel_alarm', 'use_skill', 'play_game', 'open_app']) assert.match(tools.find(t => t.name === name).description, /without saying anything first/);
});
