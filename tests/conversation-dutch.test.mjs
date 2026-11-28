// SPDX-License-Identifier: MIT
// Noggin: Dutch through the Dutch Voice skill (D169-D174).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {catalog, ttsText, realtime, settings, sleep, harness, untilListening, listening, youSay, reply, callReply, fakeActions, until, danceOutput, dutchVoice, deltas} from './helpers/conversation.mjs';

// ---- Dutch through the Dutch Voice skill (D169-D174) ----
test('Dutch: a reply labelled [nl] is said through the Dutch voice, label never said, Noggin\'s emoji at the Dutch word (D176); the log keeps the language', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: 'Hoi!', emoji: true}});
        assert.equal(h.said[0], 'Hoi!');
        assert.equal(v.calls.length, 1, 'the greeting went through the Dutch voice too');
        youSay(h, 'Hoi Jibo, ik heb een hond');
        reply(h, 'r1', '[nl] Wat leuk, een hond! Hoe heet hij?');
        await untilListening(h);
        assert.match(h.said[1], /^Wat leuk, een <es name='[A-Za-z0-9_-]+' nonBlocking='true'\/>hond!$/, 'the dog emoji, just before "hond"');
        assert.ok(catalog.EMOJI.dog.includes(/name='([^']+)'/.exec(h.said[1])[1]));
        assert.equal(h.said[2], 'Hoe heet hij?');
        assert.equal(v.calls.length, 3);
        assert.ok(v.calls.every(c => c.limitMs > 0));
        assert.ok(h.rules.slice(1).every(r => r && r.hotWords === false), 'speech\'s English keyword rules stay off');
        const spoken = h.logs.filter(e => e.kind === 'speak' && e.turn === 1);
        assert.deepEqual(spoken.map(e => e.language), ['nl', 'nl']);
        const jibo = h.logs.find(e => e.kind === 'jibo');
        assert.equal(jibo.text, 'Wat leuk, een hond! Hoe heet hij?');
        assert.equal(jibo.language, 'nl');
        h.talk.close('test'); await h.talk.done;
        assert.deepEqual(h.logs.find(e => e.kind === 'session_end').lines, {nl: 3, en: 0});
    } finally { delete global.dutchVoiceService; }
});

test('Dutch: a reply labelled [en] is said by the English voice; one without a label in the conversation\'s language; a label split over deltas still counts', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}});
        youSay(h, 'Hello Jibo');
        reply(h, 'r1', '[en] Hello there!');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Hello there!');
        assert.equal(v.calls.length, 0, 'English goes the usual way');
        youSay(h, 'Hoe gaat het?');
        reply(h, 'r2', 'Prima, dank je.');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Prima, dank je.');
        assert.equal(v.calls.length, 1);
        youSay(h, 'En jij?');
        deltas(h, 'r3', ['[', 'n', 'l]', ' Goed hoor.']);
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Goed hoor.');
        assert.equal(v.calls.length, 2);
        h.talk.close('test'); await h.talk.done;
        assert.deepEqual(h.logs.find(e => e.kind === 'session_end').lines, {nl: 2, en: 1});
    } finally { delete global.dutchVoiceService; }
});

test('Dutch: a leaked [commentary] before the label is never said or logged, and the label still picks the voice, also split over deltas (D188)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}});
        youSay(h, 'Show me a picture');
        reply(h, 'r1', '[commentary] [en] Sure, one moment.');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Sure, one moment.');
        assert.equal(v.calls.length, 0, 'English goes the usual way');
        youSay(h, 'Kun je een plaatje laten zien?');
        deltas(h, 'r2', ['[comm', 'entary]', ' [n', 'l] Leuk verzoek.']);
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Leuk verzoek.');
        assert.equal(v.calls.length, 1);
        const replies = h.logs.filter(e => e.kind === 'jibo');
        assert.deepEqual(replies.map(e => [e.text, e.language]), [['Sure, one moment.', 'en'], ['Leuk verzoek.', 'nl']]);
        assert.ok(h.logs.filter(e => e.kind === 'speak').every(e => !/commentary/.test(e.text)));
        h.talk.close('test'); await h.talk.done;
    } finally { delete global.dutchVoiceService; }
});

test('a reply that is only a leaked [commentary] before a tool call leaves nothing in the log or the pairs (D188)', async () => {
    const acts = fakeActions();
    const h = harness({actions: acts});
    const ended = h.talk.open(); await untilListening(h);
    await youSay(h, 'set a timer for ten minutes');
    callReply(h, 'r1', '[commentary]', [['set_timer', {minutes: 10}]]);
    await until(() => acts.redirects.length === 1);
    assert.equal(h.logs.find(e => e.kind === 'jibo').text, '');
    assert.deepEqual(acts.handovers[0].pairs, [{you: 'set a timer for ten minutes', jibo: ''}]);
    assert.ok(h.said.every(line => !/commentary/.test(line)));
    h.talk.close('closed');
    await ended;
});

test('Dutch asked for but the Dutch voice not ready: English from the start, the unedited greeting in English, and Jibo says why once', async () => {
    dutchVoice({ready: false});
    try {
        const h = await listening({config: {language: 'nl', greeting: 'Hoi!'}});
        assert.equal(h.talk.language, 'en');
        assert.equal(h.said[0], 'Hi!');
        assert.match(h.said[1], /My Dutch voice isn't ready/);
        assert.equal(h.logs.find(e => e.kind === 'session').dutch_missing, 'not_ready');
        h.talk.close('test');
    } finally { delete global.dutchVoiceService; }
    const h2 = await listening({config: {language: 'nl', greeting: 'Hallo allemaal'}});
    assert.equal(h2.said[0], 'Hallo allemaal', 'an edited greeting is said as written');
    assert.equal(h2.logs.find(e => e.kind === 'session').dutch_missing, 'missing');
    h2.talk.close('test');
});

test('Dutch voice refusing mid-conversation: the line is not said in English, Jibo says so once, the model is told, and English follows (D172)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}});
        v.isReady = false;
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        youSay(h, 'Vertel eens wat');
        reply(h, 'r1', '[nl] Er was eens een robot. Hij heette Jibo.');
        await untilListening(h);
        assert.deepEqual(h.said, ["Sorry, my Dutch voice isn't working right now. Let's go on in English."], 'no Dutch words in the English voice');
        assert.equal(h.talk.language, 'en');
        const note = h.sent.find(e => e.type === 'conversation.item.create' && e.item.role === 'system' && /Dutch voice is not working/.test(e.item.content[0].text));
        assert.ok(note, 'the model is told');
        assert.ok(h.logs.some(e => e.kind === 'voice_switch' && e.reason === 'dutch_voice_not_ready'));
        assert.equal(h.logs.filter(e => e.kind === 'dutch_refused').length, 2);
        youSay(h, 'Okay');
        reply(h, 'r2', 'Sure, in English then.');
        await untilListening(h);
        assert.equal(h.said.at(-1), 'Sure, in English then.');
        assert.equal(h.said.filter(t => /Dutch voice isn't working/.test(t)).length, 1, 'said once');
        h.talk.close('test');
    } finally { delete global.dutchVoiceService; }
});

test('Dutch: closing while a Dutch line is said ends it in the Dutch voice too', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}, speakMs: 400});
        youSay(h, 'Vertel eens');
        reply(h, 'r1', '[nl] Dit is een lange zin.');
        for (let i = 0; i < 100 && !h.talk.dutchLines; i++) await sleep(5);
        assert.equal(h.talk.dutchLines, 1);
        h.talk.close('test');
        assert.equal(v.cancels, 1);
        await sleep(5);
        assert.ok(h.jibo.stopped, 'and Jibo\'s speech');
    } finally { delete global.dutchVoiceService; }
});

test('Dutch: fixed lines follow the conversation language; stop phrases in Dutch end it', async () => {
    dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}, notice: {line: 'budget', emoji: null}});
        assert.match(h.said[0], /^Let op: mijn denkgeld/);
        for (const s of ['Doei!', 'oké doei Jibo', 'Tot ziens.', 'Hoi Jibo, stoppen.', 'Dat was het voor nu']) assert.ok(ttsText.isStop(s), s);
        for (const s of ['Dag!', 'Tot morgen dan maar weer iets anders']) assert.ok(!ttsText.isStop(s), s);
        h.talk.close('test');
    } finally { delete global.dutchVoiceService; }
});

test('Dutch instructions ask for a language label on every reply; English ones stay as they were', () => {
    const p = settings.persona(null);
    const nl = realtime.instructions(p.soul, p.identity, null, null, null, 'nl');
    assert.match(nl, /Start every reply with \[nl\] when it is in Dutch or \[en\] when it is in English/);
    assert.match(nl, /other than the language label described below/);
    assert.match(nl, /write numbers, times, dates and abbreviations as Dutch words/);
    assert.match(nl, /Tool results are for you only and mostly in English: after one, keep answering in the language you were speaking/, 'D177');
    const en = realtime.instructions(p.soul, p.identity);
    assert.match(en, /always answer in English/);
    assert.doesNotMatch(en, /\[nl\]/);
    assert.match(realtime.englishNote(), /start every reply with \[en\]/);
    assert.equal(ttsText.speechText('Groep 3–5'), 'Groep 3 to 5');
    assert.equal(ttsText.speechText('Groep 3–5', 'nl'), 'Groep 3 tot 5');
});

test('Dutch voice refusing before OpenAI is connected (the greeting): the English line, and the model is told once the session is set up (D175)', async () => {
    const v = dutchVoice();
    global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
    try {
        const h = await listening({config: {language: 'nl', greeting: 'Hoi!'}});
        assert.deepEqual(h.said.slice(0, 2), ['Hi!', "Sorry, my Dutch voice isn't working right now. Let's go on in English."], 'the unedited greeting falls back to its English twin');
        const notes = h.sent.filter(e => e.type === 'conversation.item.create' && /Dutch voice is not working/.test(JSON.stringify(e)));
        assert.equal(notes.length, 1, 'sent once, after session.updated');
        assert.ok(h.sent.indexOf(notes[0]) > h.sent.findIndex(e => e.type === 'session.update'));
        h.talk.close('test');
    } finally { delete global.dutchVoiceService; }
});

test('trouble during a Dutch line: the line still playing is ended and the reason is said; refused, in English (D175)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}, diagnose: () => Promise.resolve({cause: 'no_internet'})});
        // The Dutch line hangs past the 6 s wait for quiet; other lines are quick.
        h.jibo.embodied.speech.speak = esml => { h.said.push(esml); return /lange/.test(esml) ? new Promise(() => {}) : sleep(20); };
        youSay(h, 'Vertel eens');
        reply(h, 'r1', '[nl] Een lange zin.');
        for (let i = 0; i < 100 && !h.talk.dutchLines; i++) await sleep(5);
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_busy'));
        h.talk.fail(Object.assign(Error('OpenAI: down'), {openai: true}));
        await h.talk.done;
        assert.ok(v.cancels >= 1, 'the Dutch line was ended');
        assert.match(h.said.at(-1), /I can't reach the internet right now/);
    } finally { delete global.dutchVoiceService; }
});

test('a refused Dutch dance announcement: the dance without words, and the English line right after (D175)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: {}});
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        const result = await h.talk.dance('dans eens', 1);
        assert.equal(result.announced, true);
        assert.match(h.said.at(-2), /^<anim name='[^']+' endNeutral='true'\/>$/, 'the dance alone');
        assert.match(h.said.at(-1), /Dutch voice isn't working/);
        h.talk.close('test');
    } finally { delete global.dutchVoiceService; }
});

test('a dance in a Dutch conversation: the announcement in the Dutch voice, the tool result names it in Dutch (D177)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: fakeActions()});
        await youSay(h, 'doe de robot');
        callReply(h, 'd1', '', [['dance', {}, 'call_dance_1']]);
        await until(() => h.sent.filter(e => e.type === 'response.create').length >= 1);
        reply(h, 'f1', '[nl] Dat was leuk!');
        await untilListening(h);
        assert.match(h.said[0], /^Robotstand: aan! <anim name='[A-Za-z0-9_]+' endNeutral='true'\/>$/);
        assert.equal(v.calls.length, 2, 'the announcement and the follow-up both went through the Dutch voice');
        assert.equal(danceOutput(h).dance, 'de robot');
        assert.equal(catalog.danceName('waltz', 'nl'), 'een wals'); assert.equal(catalog.danceName(null, 'nl'), 'een dans');
        assert.equal(catalog.danceName('waltz'), 'a waltz');
        h.talk.close('test');
    } finally { delete global.dutchVoiceService; }
});

test('a dance after an [en] reply in a Dutch conversation: English announcement and name; after a refused Dutch one, the name in English (D177)', async () => {
    const v = dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: fakeActions()});
        await youSay(h, 'do the robot');
        callReply(h, 'd1', '[en] Sure!', [['dance', {}, 'call_dance_1']]);
        await until(() => h.sent.filter(e => e.type === 'response.create').length >= 1);
        reply(h, 'f1', '[en] That was fun!');
        await untilListening(h);
        assert.ok(h.said.some(e => /^Robot mode: on! <anim name=/.test(e)), h.said.join(' | '));
        assert.equal(danceOutput(h).dance, 'the robot');
        h.talk.close('test');
        const r = await listening({config: {language: 'nl', greeting: '', danceAnnounce: 'always'}, actions: {}});
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        const played = await r.talk.dance('doe de robot', 1);
        assert.equal(played.language, 'en', 'the conversation switched to English');
        assert.equal(catalog.danceName(played.style, played.language), 'the robot');
        r.talk.close('test');
    } finally { delete global.dutchVoiceService; }
});

test('line counts hold only lines that were said (D171)', async () => {
    dutchVoice();
    try {
        const h = await listening({config: {language: 'nl', greeting: ''}});
        global.dutchVoiceService.speak = () => Promise.reject(Error('dutch_voice_not_ready'));
        youSay(h, 'Hoi');
        reply(h, 'r1', '[nl] Hallo daar.');
        await untilListening(h);
        h.talk.close('test'); await h.talk.done;
        assert.deepEqual(h.logs.find(e => e.kind === 'session_end').lines, {nl: 0, en: 1});
    } finally { delete global.dutchVoiceService; }
});

