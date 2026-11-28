// SPDX-License-Identifier: MIT
// Noggin: expressions next to speech (lib/expression.js, conversation-lines.js), the classifier warm, moods, sizes and the catalogue.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {source, catalog, ttsText, labels, openai, DEFAULTS, sleep, ANIMDB, harness, clips, untilListening, listening, youSay, reply, until, DOFS, fakeAnimDB, require} from './helpers/conversation.mjs';

// ---- expressions next to speech ----
test('a line is done when its words are (dispatchComplete TTS); when speech\'s own animations end is logged', async () => {
    let finish;
    const h = await listening({config: {greetingExpression: 'hello'}, speech: {waitForAnimDispatch: () => new Promise(r => { finish = r; })}});
    assert.deepEqual(h.options[0], {dispatchComplete: 'TTS'});
    const speak = h.logs.find(e => e.kind === 'speak'), spoken = h.logs.find(e => e.kind === 'spoken');
    assert.equal(speak.play, 'greetings_01'); assert.equal(typeof speak.at, 'number');
    assert.ok(spoken.ms >= 15);
    assert.ok(h.logs.some(e => e.kind === 'listen' && typeof e.after_speech === 'number'));
    assert.ok(!h.logs.some(e => e.kind === 'speech_anims'), 'listening did not wait for the animation');
    finish(); await sleep(5);
    assert.ok(h.logs.find(e => e.kind === 'speech_anims').ms >= 15);
    h.talk.close();
});

test('animdb: the animation starts first, next to the words, with its LED channels removed; Jibo is centred only after one that ends off-neutral', async () => {
    const db = fakeAnimDB();
    const h = await listening({config: {greetingExpression: 'hello'}, animDB: db.animDB, expression: db.expression});
    assert.equal(h.said[0], 'Hi!', 'no <anim> in the words');
    assert.equal(db.played[0].name, 'greetings_01');
    assert.ok(!db.played[0].config.dofs.names.includes('LED') && db.played[0].config.dofs.names.includes('BODY'));
    assert.ok(!db.played[0].opts.forceReturnToIdle, 'no return to idle that would take the LED');
    assert.equal(db.played[0].config.cache, 'global', 'a named loader cache (without one the load never finishes on the robot)');
    assert.ok(h.logs.findIndex(e => e.kind === 'speak') > -1);
    await until(() => h.logs.some(e => e.kind === 'anim'));
    const anim = h.logs.find(e => e.kind === 'anim');
    assert.equal(anim.result, 'STOPPED'); assert.equal(anim.ledStripped, true); assert.ok(anim.start >= anim.asked && anim.end >= anim.start);
    assert.equal(db.centred.length, 0, 'greetings_01 ends neutral');
    const off = h.talk.player.play('Confused_01', {via: 'test'});
    assert.equal(await off.done, 'STOPPED');
    assert.ok(!db.centred[0].dofs.names.includes('LED') && !db.centred[0].dofs.names.includes('BASE'));
    h.talk.close();
});

test('animdb: a rejected or missing animation is logged and the words still come', async () => {
    const db = fakeAnimDB({greetings_01: 'REJECTED'});
    const h = await listening({config: {greetingExpression: 'hello', expressionLeadMs: 40}, animDB: db.animDB, expression: db.expression});
    assert.equal(h.said[0], 'Hi!');
    await until(() => h.logs.some(e => e.kind === 'anim'));
    assert.equal(h.logs.find(e => e.kind === 'anim').result, 'REJECTED');
    assert.equal(await h.talk.player.play('missing_01').done, 'missing');
    h.talk.close();
});

test('a new expression replaces the one still playing; closing Noggin stops it', async () => {
    const db = fakeAnimDB({}, 5000);
    const h = await listening({config: {greeting: ''}, animDB: db.animDB, expression: db.expression});
    const first = h.talk.player.play('excited_01'); await first.started;
    const second = h.talk.player.play('sad_01'); await second.started;
    assert.equal(await first.done, 'replaced');
    assert.ok(h.talk.player.busy());
    await h.talk.close();
    assert.equal(await second.done, 'closed');
    assert.equal(db.centred.length, 1, 'stopped half way: back to neutral (D116)');
    assert.ok(!db.centred[0].dofs.names.includes('BASE') && !db.centred[0].dofs.names.includes('LED'));
    const idle = await listening({config: {greeting: ''}, animDB: db.animDB, expression: fakeAnimDB().expression});
    const centredBefore = db.centred.length;
    await idle.talk.close();
    assert.equal(db.centred.length, centredBefore, 'nothing playing: no centring');
});

test('the reaction plays through the animation database at once and never holds up the first line', async () => {
    const db = fakeAnimDB({}, 300);
    const h = harness({speakMs: 30, animDB: db.animDB, expression: db.expression,
        classify: (person, line, kind) => kind === 'reaction' ? Promise.resolve({label: 'surprised', confidence: 0.9}) : Promise.resolve({label: 'none'})});
    h.talk.open(); await untilListening(h);
    youSay(h, 'I won the lottery!');
    await sleep(15);
    assert.equal(db.played[0].name, 'surprised_02');
    assert.equal(h.said.length, 1, 'nothing spoken for the reaction');
    reply(h, 'r1', 'No way! That is wonderful.');
    await until(() => h.said.length === 3);
    assert.ok(h.talk.player.busy(), 'the lines came while the reaction still played');
    assert.deepEqual(h.said.slice(1), ['No way!', 'That is wonderful.']);
    await untilListening(h);
    assert.equal(h.logs.find(e => e.kind === 'jibo').reaction.played, 'before');
    h.talk.close();
});

test('expressionTailMs: listening waits (at most that long) for an expression still playing', async () => {
    const db = fakeAnimDB({}, 250);
    const h = await listening({config: {greetingExpression: 'hello', expressionTailMs: 1000}, animDB: db.animDB, expression: db.expression});
    const anim = h.logs.find(e => e.kind === 'anim'), listen = h.logs.find(e => e.kind === 'listen');
    assert.ok(anim && h.logs.indexOf(anim) < h.logs.indexOf(listen), 'the animation ended before listening');
    assert.equal(listen.anim_playing, false);
    h.talk.close();
});

test('an animation database that never answers: load and play time out, are logged, and Noggin is not left busy', async () => {
    const Player = require(path.join(source, 'noggin/lib/expression.js'));
    const saved = [Player.LOAD_MS, Player.SLACK_MS]; Player.LOAD_MS = 40; Player.SLACK_MS = 40;
    try {
        const logs = [], stops = [];
        const jibo = {expression: {dofs: DOFS}, animDB: {getAnimByName: name => ({meta: {duration: 3, endsNeutral: true},
            createFromConfig: () => name === 'never_loads' ? new Promise(() => {}) : Promise.resolve({instance: {events: {}}, play: () => new Promise(() => {}), stop: () => { stops.push(name); return Promise.resolve(); }})})}};
        const player = new Player(jibo, {write: e => logs.push(e)});
        const load = player.play('never_loads');
        assert.equal(await load.done, 'load_timeout'); assert.equal(await load.started, false);
        const hang = player.play('never_ends');
        assert.equal(await hang.done, 'play_timeout');
        assert.deepEqual(stops, ['never_ends']);
        assert.ok(!player.busy());
        assert.deepEqual(logs.map(e => e.result), ['load_timeout', 'play_timeout']);
    } finally { [Player.LOAD_MS, Player.SLACK_MS] = saved; }
});

test('a clip stopped while it loads is never played, and its playback is stopped once it arrives', async () => {
    const Player = require(path.join(source, 'noggin/lib/expression.js'));
    let arrive = null;
    const calls = [];
    const playback = {instance: {events: {}}, play: () => { calls.push('play'); return Promise.resolve('STOPPED'); }, stop: () => { calls.push('stop'); return Promise.resolve(); }};
    const jibo = {expression: {dofs: DOFS}, animDB: {getAnimByName: () => ({meta: {duration: 3, endsNeutral: true},
        createFromConfig: () => new Promise(resolve => { arrive = () => resolve(playback); })})}};
    const player = new Player(jibo, {write() {}});
    const clip = player.play('slow_to_load');
    await sleep(5);
    await player.stopCurrent('closed');
    arrive();
    assert.equal(await clip.done, 'closed');
    assert.equal(await clip.started, false);
    await sleep(5);
    assert.deepEqual(calls, ['stop']);
});

// ---- moods, sizes and the catalogue ----
test('catalogue: every mood has animations, each a real, silent animation that starts neutral and fits its size', {skip: !fs.existsSync(ANIMDB) && 'no animdb.json here'}, () => {
    const anims = JSON.parse(fs.readFileSync(ANIMDB, 'utf8')), json = require(path.join(source, 'noggin/lib/catalog.json'));
    const moods = Object.keys(catalog.MOODS).filter(n => n !== 'dance');
    assert.deepEqual(Object.keys(json.moods).sort(), moods.sort(), 'one catalogue entry per mood, and only those');
    let count = 0;
    for (const mood of moods) {
        const {small, big} = json.moods[mood];
        assert.ok(small.length + big.length > 0, mood + ' has animations');
        for (const [size, list] of [['small', small], ['big', big]]) for (const a of list) {
            const m = anims[a.n]; count++;
            assert.ok(m, mood + ': ' + a.n + ' exists');
            assert.ok(!m.hasAudio && m.startsNeutral && m.duration <= json.maxFrames, mood + ': ' + a.n + ' silent, neutral start, short');
            assert.equal(a.f, m.duration); assert.equal(a.led, !!m.layers.LED); assert.equal(a.body, !!m.layers.Body); assert.equal(a.neutral, m.endsNeutral !== false);
            assert.equal(size === 'small', !a.body || a.f <= json.smallFrames, mood + ': ' + a.n + ' size');
        }
    }
    assert.ok(count >= 150, count + ' animations');
    // Generated, not hand-edited: the generator gives the same file.
    const gen = execFileSync(process.execPath, ['-e', `import('${path.join(source, 'tools/expression-catalog.mjs')}').then(m => { const db = JSON.parse(require('fs').readFileSync('${ANIMDB}', 'utf8')); process.stdout.write(JSON.stringify({moods: m.build(db).moods, emoji: m.emojiIndex(db)})); })`]);
    const fresh = JSON.parse(gen);
    assert.deepEqual(fresh.moods, json.moods, 'catalog.json is up to date: node tools/expression-catalog.mjs');
    assert.deepEqual(fresh.emoji, json.emoji, 'catalog.json emoji are up to date');
    // Emoji: pictures on the eye, silent, no body, no LED, short.
    const emojiNames = new Set(Object.values(json.emoji).flat());
    assert.ok(Object.keys(json.emoji).length > 400 && emojiNames.size > 300);
    for (const name of emojiNames) {
        const m = anims[name];
        assert.ok(m && m.categories.includes('emoji') && !m.hasAudio && !m.layers.Body && !m.layers.LED && m.duration <= json.maxFrames, name);
    }
    assert.ok(!json.emoji.dog.some(n => /hot/i.test(n)), 'a dog is not a hot dog');
});

test('pickAnimation: the asked size, no recent repeats, LED animations too, the other size or the default as fallback', () => {
    const c = catalog.CATALOG;
    const names = list => list.map(a => a.n);
    for (let i = 0; i < 20; i++) {
        assert.ok(names(c.happy.small).includes(catalog.pickAnimation('happy', 'small')));
        assert.ok(names(c.happy.big).includes(catalog.pickAnimation('happy', 'big')));
    }
    assert.equal(catalog.pickAnimation('yes', 'small', {random: () => 0.99}), 'yep_04', 'an LED animation plays too');
    const recent = names(c.thinking.big).slice(1);
    assert.equal(catalog.pickAnimation('thinking', 'big', {recent}), c.thinking.big[0].n, 'the one not played recently');
    assert.ok(names(c.laugh.big).includes(catalog.pickAnimation('laugh', 'small')), 'no small laugh: a big one');
    assert.ok([...names(c.happy.small), ...names(c.happy.big)].includes(catalog.pickAnimation('happy', null)), 'no size: either');
    assert.equal(catalog.pickAnimation('dance', 'big'), 'dance_funk_02');
    assert.equal(catalog.pickAnimation('nonsense', 'big'), null);
});

test('Decisions with the size question: small/big parsed; refused once, it is dropped for the session; Responses gives a size too', async () => {
    const sized = labels.decisionsRequest('gpt-6-luna', 'I won!', 'Wow!', 'line', true);
    assert.deepEqual(sized.questions.map(q => q.name), ['expression', 'size']);
    assert.deepEqual(sized.questions[1].choices.map(c => c.value), ['small', 'big']);
    const two = (choice, size) => ({answers: [{type: 'choice', name: 'expression', choice, confidence: 0.9}, {type: 'choice', name: 'size', choice: size, confidence: 0.7}]});
    assert.deepEqual(labels.decisionLabel(two('happy', 'big'), 0.35), {label: 'happy', confidence: 0.9, size: 'big'});
    assert.equal(labels.decisionLabel(two('none', 'big'), 0.35).size, null);
    assert.equal(labels.decisionLabel(two('happy', 'huge'), 0.35).size, null);
    const bodies = [];
    const classify = openai.classifier(Object.assign({}, DEFAULTS, {apiKey: 'sk'}), (route, body) => {
        bodies.push(body);
        return Promise.resolve(body.questions.length === 2 ? {status: 400, ms: 30, json: {error: {code: 'invalid_request'}}}
            : {status: 200, ms: 90, json: {answers: [{type: 'choice', name: 'expression', choice: 'sad', confidence: 0.8}]}});
    });
    const first = await classify('my cat died', 'I am so sorry.', 'line');
    assert.equal(first.label, 'sad'); assert.equal(first.size, null); assert.match(first.switched, /size question refused/);
    await classify('x', 'y', 'reaction');
    assert.deepEqual(bodies.map(b => b.questions.length), [2, 1, 1], 'asked once with size, then without for good');
    const responses = labels.classifierRequest('m', 'a', 'b');
    assert.deepEqual(responses.text.format.schema.required, ['expression', 'size']);
    assert.equal(labels.classifierAnswer({output_text: '{"expression":"happy","size":"small"}'}).size, 'small');
    assert.equal(labels.classifierAnswer({output_text: 'nope'}).size, null);
});

test('defaults: the catalogue, a size; a line plays a random animation of its mood and size, never the last few again', async () => {
    assert.equal(DEFAULTS.expressionSize, true); assert.equal(DEFAULTS.emoji, true);
    assert.equal(DEFAULTS.expressionPick, undefined, 'no fixed animations any more');
    const db = fakeAnimDB({}, 10);
    const h = harness({realChoose: true, animDB: db.animDB, expression: db.expression, config: {expressionGapMs: 0},
        classify: (person, line, kind) => Promise.resolve(kind === 'reaction' ? {label: 'none'} : {label: 'thinking', size: 'big', confidence: 0.9})});
    h.talk.policy.repeatMs = 0;
    h.talk.open(); await untilListening(h);
    youSay(h, 'Tell me something deep');
    reply(h, 'r1', 'Hmm. Let me see. Well. Maybe so. Who knows. Think about it.');
    await untilListening(h);
    const played = db.played.map(p => p.name), big = catalog.CATALOG.thinking.big.map(a => a.n);
    assert.equal(played.length, 2, 'the first sentence, then the rest');
    assert.ok(played.every(n => big.includes(n)) && played[0] !== played[1], 'two different big thinking animations: ' + played);
    const speak = h.logs.find(e => e.kind === 'speak' && e.turn === 1);
    assert.equal(speak.size, 'big'); assert.ok(big.includes(speak.play));
    const next = [0, 1, 2, 3, 4].map(() => h.talk.choose('thinking', 'big'));
    const all = played.concat(next);
    all.forEach((name, i) => assert.ok(all.slice(Math.max(0, i - 5), i).indexOf(name) < 0, name + ' repeats one of the five before it'));
    assert.ok(h.talk.recentAnims.length === 5);
    assert.equal(h.talk.choose('dance'), catalog.DANCE); assert.equal(h.talk.choose('smile'), 'eye_happy_00'); assert.equal(h.talk.choose('none'), null);
    h.talk.close();
});

test('size notes: a mood with one size of animation says which, so the model\'s size answer fits', () => {
    const line = labels.decisionsRequest('gpt-6-luna', 'a', 'b', 'line', true).questions[0].choices;
    const of = v => line.find(c => c.value === v).description;
    assert.match(of('giggle'), /\(always a whole-body move\)$/);
    assert.match(of('celebrate'), /\(always small: on his eye or a small nod\)$/);
    assert.doesNotMatch(of('happy'), /always/);
    for (const mood of Object.keys(catalog.CATALOG)) {
        const {small, big} = catalog.CATALOG[mood], d = catalog.moodDescription(mood);
        assert.equal(/always a whole-body/.test(d), !small.length, mood); assert.equal(/always small/.test(d), !big.length, mood);
    }
    assert.match(labels.classifierRequest('m', 'a', 'b').input[0].content, /giggle: .*always a whole-body move/);
});

test('emojiFor: the first word or two-word term with a picture, plurals, not a recent word', () => {
    const first = () => 0;
    assert.deepEqual(catalog.emojiFor('I love pizza and ice cream!', {random: first}), {word: 'pizza', name: catalog.EMOJI.pizza[0], said: ['pizza'], nth: 0});
    assert.deepEqual(catalog.emojiFor('Ice creams for everyone.').said, ['ice', 'creams'], 'said: the words as in the line');
    assert.equal(catalog.emojiFor('Ice cream is the best.').word, 'ice cream', 'two-word terms first');
    assert.equal(catalog.emojiFor('My dogs are cute.').word, 'dog');
    assert.equal(catalog.emojiFor('Do you like books?').word, 'book');
    assert.equal(catalog.emojiFor('I love pizza and ice cream!', {recent: ['pizza']}).word, 'ice cream');
    assert.equal(catalog.emojiFor('Grass is green because of chlorophyll.'), null);
    assert.equal(catalog.emojiFor('Yes, that is good news, hello!'), null, 'common words have no picture');
    assert.equal(catalog.emojiFor(''), null);
});

test('emojiFor in Dutch: Dutch words show the same pictures, with plurals, diminutives and accents (D176)', () => {
    const nl = (line, more) => catalog.emojiFor(line, Object.assign({language: 'nl', random: () => 0}, more || {}));
    assert.deepEqual(nl('Wat leuk, een hond!'), {word: 'dog', name: catalog.EMOJI.dog[0], said: ['hond'], nth: 0});
    const cases = {'Ik hou van katten.': 'cat', 'Drie bomen in de tuin.': 'tree', 'De huizen zijn groot.': 'house', 'Een lekker ijsje.': 'ice cream',
        'Wat een zonnetje!': 'sun', 'Kijk, een eitje.': 'egg', "Auto's rijden snel.": 'car', 'Rode appels!': 'red apple', 'Pinguïns zijn grappig.': 'penguin',
        'Mijn circuits zoemen.': 'circuit', 'Zullen we een kopje koffie drinken?': 'coffee'};
    for (const line of Object.keys(cases)) assert.equal((nl(line) || {}).word, cases[line], line);
    assert.deepEqual(nl('Pinguïns zijn grappig.').said, ['pinguïns'], 'said: the word as in the line, accents kept');
    assert.equal(ttsText.emojiEsml('Pinguïns zijn grappig.', ['pinguïns'], 'Emoji_Penguin', 0), "<es name='Emoji_Penguin' nonBlocking='true'/>Pinguïns zijn grappig.");
    for (const line of ['Dat is een eis.', 'Even kijken, hoor.', 'Ik zit op de bank.', 'Er komt een golf aan.', 'Tot slot nog dit.', 'Ik ben er.',
        'Zal ik verder in het Engels praten?', 'Die regels gelden ook.', 'Hij heeft twee zonen.', 'Pak het kastje.', 'Een natje en een droogje.',
        'Het was een groot succes.', 'De burgers stemden.', 'Het ijs is glad.', 'Op dun ijs.', 'Een glas jus d\'orange.'])
        assert.equal(nl(line), null, line);
    assert.equal(nl('Mijn appel iphone is stuk.'), null, 'a nearby word cancels');
    assert.equal(nl('Veel succes vandaag!').word, 'good luck');
    assert.equal(nl('Ik hou van honden.', {recent: ['dog']}), null, 'recent pictures count across languages');
    assert.equal(catalog.emojiFor('Ik hou van honden.'), null, 'an English line does not read Dutch words');
    const english = require(path.join(source, 'noggin/lib/catalog.json')).emoji, terms = require(path.join(source, 'noggin/lib/emoji-nl.js'));
    for (const word of Object.keys(terms.TERMS)) {
        assert.ok(english[terms.TERMS[word]], word + ' points at a known picture term');
        assert.match(word, /^[a-z]+( [a-z]+)?$/, word + ': lower case, no accents, at most two words');
    }
    for (const word of Object.keys(terms.CANCEL)) assert.ok(terms.TERMS[word], word + ' has cancel words and a picture');
    for (const word of terms.NOT) assert.match(word, /^[a-z]+$/, word);
});

test('emojiFor: words with another meaning or picture have none; a nearby word can cancel one (D98)', () => {
    for (const line of ['Here is a paper for you.', 'That machine is loud.', 'Let us break the ice.', 'As a rule of thumb, rest.', 'Cheers to that!'])
        assert.equal(catalog.emojiFor(line), null, line);
    assert.equal(catalog.emojiFor('That was a piece of cake.'), null, 'piece of cake');
    assert.equal(catalog.emojiFor('I will take a rain check.'), null);
    assert.equal(catalog.emojiFor('My new apple iphone is great.'), null);
    assert.equal(catalog.emojiFor('My new apple iphone, then a cake.').word, 'cake', 'the search goes on after a cancelled word');
    assert.equal(catalog.emojiFor('An apple a day.').word, 'apple');
    assert.equal(catalog.emojiFor('We baked a cake.').word, 'cake');
    assert.equal(catalog.emojiFor('Ice cream, please.').word, 'ice cream', 'the two-word term still has one');
});

test('emojiEsml: the emoji tag goes just before its word in the ESML; null when the word is not there (D98)', () => {
    const tag = n => "<es name='" + n + "' nonBlocking='true'/>";
    assert.equal(ttsText.emojiEsml('How about a pizza tonight?', ['pizza'], 'Emoji_Pizza'), 'How about a ' + tag('Emoji_Pizza') + 'pizza tonight?');
    assert.equal(ttsText.emojiEsml('My Dogs are cute.', ['dogs'], 'Emoji_Dog'), 'My ' + tag('Emoji_Dog') + 'Dogs are cute.');
    assert.equal(ttsText.emojiEsml("The dog's bone.", ['dog'], 'Emoji_Dog'), 'The ' + tag('Emoji_Dog') + "dog's bone.");
    assert.equal(ttsText.emojiEsml('Ice  cream &amp; cake.', ['ice', 'cream'], 'Emoji_IceCream'), tag('Emoji_IceCream') + 'Ice  cream &amp; cake.');
    assert.equal(ttsText.emojiEsml('A hotdog stand.', ['dog'], 'Emoji_Dog'), null, 'whole words only');
    assert.equal(ttsText.emojiEsml('A cat.', ['cat'], "x' onload='y"), null, 'only plain animation names');
    for (const [text, word] of [['A pie chart is fine, but I love pie.', 'love '], ['Rain check? No, the rain is coming.', 'the '], ['My apple iphone broke, so I ate an apple.', 'an ']]) {
        const f = catalog.emojiFor(text);
        assert.equal(f.nth, 1, text);
        assert.ok(ttsText.emojiEsml(ttsText.speechText(text), f.said, f.name, f.nth).includes(word + tag(f.name)), 'not on the cancelled one: ' + text);
    }
    const line = 'Fei Fei found a tiny door hidden in the trunk of an old tree.';
    const found = catalog.emojiFor(line), esml = ttsText.emojiEsml(ttsText.speechText(line), found.said, found.name);
    assert.ok(esml.endsWith('an old ' + tag(found.name) + 'tree.'), esml);
});

test('emoji: a line without an expression shows a picture for what Jibo names; at most one per emojiGapMs; the expression on the same line wins', async () => {
    const db = fakeAnimDB({}, 30);
    const h = harness({animDB: db.animDB, expression: db.expression, config: {emoji: true, emojiGapMs: 400},
        classify: (person, line) => Promise.resolve({label: /lovely/.test(line) ? 'happy' : 'none', size: 'small'})});
    h.talk.open(); await untilListening(h);
    youSay(h, 'What should I eat?');
    reply(h, 'r1', 'How about a pizza? Or a taco with cheese.');
    await untilListening(h);
    const emoji = h.logs.filter(e => e.kind === 'speak' && e.emoji);
    assert.equal(emoji.length, 1, 'one emoji within emojiGapMs'); assert.equal(emoji[0].emoji, 'pizza'); assert.equal(emoji[0].emoji_at, 'pizza');
    assert.ok(catalog.EMOJI.pizza.includes(emoji[0].play));
    assert.equal(h.said[1], "How about a <es name='" + emoji[0].play + "' nonBlocking='true'/>pizza?", 'at its word, in the words (D98)');
    assert.equal(db.played.length, 0, 'not played next to the line');
    assert.deepEqual(h.rules.slice(1, 3), [undefined, {hotWords: false}], "speech's own keyword emoji off within emojiGapMs");
    assert.deepEqual(h.logs.find(e => e.kind === 'jibo').expressions, ['none', 'emoji pizza', 'none']);
    await sleep(450);
    youSay(h, 'I got a dog');
    reply(h, 'r2', 'A dog, how lovely!');
    await untilListening(h);
    const second = h.logs.filter(e => e.kind === 'speak' && e.turn === 2);
    assert.equal(second[0].expression, 'happy'); assert.equal(second[0].emoji, undefined, 'the expression wins over the emoji');
    h.talk.close();
});

test('emoji after an expression: line 1 has an expression, line 2 names a cat: the cat is in line 2 at its word, nothing waits (D98)', async () => {
    const db = fakeAnimDB({}, 400);
    const h = harness({speakMs: 30, animDB: db.animDB, expression: db.expression, config: {emoji: true},
        classify: (person, line) => Promise.resolve(/Nice/.test(line) ? {label: 'thumbsup', size: 'small'} : {label: 'none'})});
    h.talk.choose = label => label === 'thumbsup' ? 'Emoji_ThumbsUp' : null;
    h.talk.open(); await untilListening(h);
    youSay(h, 'They have a cat');
    reply(h, 'r1', 'Nice! A cat makes a lively audience.');
    await untilListening(h);
    assert.deepEqual(db.played.map(p => p.name), ['Emoji_ThumbsUp']);
    const cat = h.logs.find(e => e.kind === 'speak' && e.emoji === 'cat');
    assert.ok(catalog.EMOJI.cat.includes(cat.play)); assert.equal(cat.after, undefined); assert.equal(cat.lead, undefined);
    assert.equal(h.said.at(-1), "A <es name='" + cat.play + "' nonBlocking='true'/>cat makes a lively audience.");
    h.talk.close();
});

test("emoji: a word the ESML cannot find is logged as missed and the line is said without it; speech's own keyword emoji stay on (D98)", async () => {
    const h = await listening({config: {emoji: true}, classify: () => Promise.resolve({label: 'none'})});
    await h.talk.speak('A pizza.', null, {turn: 1, line: 0, keyword: {word: 'pizza', name: 'Emoji_Pizza', said: ['pasta']}});
    const speak = h.logs.find(e => e.kind === 'speak' && e.emoji === 'pizza');
    assert.equal(speak.emoji_at, 'missed'); assert.equal(h.said.at(-1), 'A pizza.'); assert.equal(h.rules.at(-1), undefined);
    h.talk.close();
});

test("emoji off: speech's own keyword emoji are off too (D98)", async () => {
    const h = await listening({config: {emoji: false}, classify: () => Promise.resolve({label: 'none'})});
    youSay(h, 'What should I eat?');
    reply(h, 'r1', 'How about a pizza?');
    await untilListening(h);
    assert.equal(h.said.at(-1), 'How about a pizza?');
    assert.deepEqual(h.rules.at(-1), {hotWords: false}); assert.equal(h.logs.find(e => e.kind === 'speak' && e.turn === 1).hot_words, false);
    h.talk.close();
});

// ---- moved here from other sections ----
test('moods: each has a description; the smile and the dance are real animations', {skip: !fs.existsSync(ANIMDB) && 'no animdb.json here'}, () => {
    const anims = JSON.parse(fs.readFileSync(ANIMDB, 'utf8'));
    assert.equal(Object.keys(catalog.MOODS).length, 31);
    for (const [mood, when] of Object.entries(catalog.MOODS)) assert.ok(when.length > 5, mood + ' has a description');
    assert.ok(anims[catalog.EXTRA.smile] && !anims[catalog.EXTRA.smile].layers.Body && !anims[catalog.EXTRA.smile].hasAudio, 'eye-only, silent smile');
    assert.ok(anims[catalog.DANCE] && anims[catalog.DANCE].layers.Body, 'the dance');
    assert.equal(catalog.animFor('dance'), catalog.DANCE); assert.equal(catalog.animFor('smile'), 'eye_happy_00'); assert.equal(catalog.animFor('happy'), null);
});

test('the classifier is warmed at the start and after a quiet spell', async () => {
    let warmed = 0;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => { warmed++; return Promise.resolve(); };
    const h = await listening({classify});
    assert.equal(warmed, 1);
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.equal(warmed, 1, 'not again right away');
    h.talk.lastClassify -= 30000;
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.equal(warmed, 1, 'half a minute of quiet is not enough: OpenAI stays quick for minutes (D93)');
    h.talk.lastClassify -= 200000;
    h.emit({type: 'input_audio_buffer.speech_started'});
    assert.equal(warmed, 2);
    h.talk.close();
});

test('the classifier warm starts while the realtime session is still connecting, once (D93)', async () => {
    let warmed = 0, release;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => { warmed++; return Promise.resolve(); };
    const h = harness({classify, connect: (n, rt) => new Promise(resolve => { release = () => resolve(rt); })});
    h.talk.open();
    await sleep(60);
    assert.equal(warmed, 1, 'asked before the session exists');
    assert.notEqual(h.talk.state, 'listening');
    assert.deepEqual(h.said, ['Hi!'], 'the greeting does not wait for it');
    release(); await untilListening(h);
    assert.equal(warmed, 1, 'not again when the session is ready');
    h.talk.close();
});

test('the warm asks the reaction and two line questions at once with the real choices; a refused API is reported, not replaced (D93, D179)', async () => {
    const config = Object.assign({}, DEFAULTS, {apiKey: 'sk'});
    const sent = [];
    const answer = {answers: [{type: 'choice', name: 'expression', choice: 'none', confidence: 0.9}, {type: 'choice', name: 'size', choice: 'small', confidence: 0.7}]};
    const classify = openai.classifier(config, (route, body) => { sent.push({route, body}); return Promise.resolve({status: 200, ms: 40, json: answer, conn: {socket: sent.length}}); });
    const warming = classify.warm();
    assert.equal(sent.length, 3, 'all three go out before any answer');
    const result = await warming;
    assert.deepEqual(result.requests.map(r => r.kind), ['reaction', 'line', 'line']);
    assert.ok(sent.every(s => s.route === '/decisions'));
    const choicesOf = body => body.questions[0].choices.map(c => c.value);
    assert.deepEqual(choicesOf(sent[0].body), labels.choices('reaction').map(c => c.value));
    assert.deepEqual(choicesOf(sent[1].body), labels.choices('line').map(c => c.value));
    assert.notEqual(sent[1].body.input, sent[2].body.input, 'two different lines');
    assert.equal(sent[0].body.questions.length, 2, 'with the size question, as a real turn');
    assert.deepEqual(result.requests.map(r => r.conn.socket), [1, 2, 3]);
    // The account cannot use Decisions: the warm shows the error and nothing else is asked.
    const routes = [];
    const refused = openai.classifier(config, (route, body) => {
        routes.push(route);
        return Promise.resolve({status: 403, ms: 30, json: {error: {code: 'not_enabled'}}});
    });
    const warmed = await refused.warm();
    assert.ok(warmed.requests.every(r => r.label === null && r.error === 'not_enabled' && !r.switched), JSON.stringify(warmed));
    routes.length = 0;
    await refused('x', 'y', 'line');
    assert.deepEqual(routes, ['/decisions']);
    // No warm when Responses is chosen.
    const plain = openai.classifier(Object.assign({}, config, {classifierApi: 'responses'}), () => { throw Error('nothing should be sent'); });
    assert.equal(await plain.warm(), null);
    // A failing request is reported, not thrown.
    const broken = openai.classifier(config, () => Promise.reject(Error('boom')));
    assert.ok((await broken.warm()).requests.every(r => r.error === 'boom'));
});

test('a switch during the warm is logged once, however many requests switched (D93)', async () => {
    const classify = () => Promise.resolve({label: 'none'});
    const switched = 'size question refused (HTTP 400), now without it';
    classify.warm = () => Promise.resolve({ms: 900, requests: [{kind: 'reaction', ms: 400, switched}, {kind: 'line', ms: 300, switched}, {kind: 'line', ms: 310, switched}]});
    const h = await listening({classify}); await sleep(5);
    assert.equal(h.logs.filter(e => e.kind === 'classifier_warm').length, 1);
    const entries = h.logs.filter(e => e.kind === 'classifier_switch');
    assert.equal(entries.length, 1);
    assert.match(entries[0].detail, /now without it/);
    h.talk.close();
});

test('a warm that ends after the conversation closed writes nothing and throws nothing (D93)', async () => {
    let finish;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => new Promise(resolve => { finish = resolve; });
    const h = await listening({classify});
    assert.equal(typeof finish, 'function', 'the warm was asked');
    h.talk.close();
    finish({ms: 900, requests: [{kind: 'reaction', ms: 400, switched: 'decisions failed (x), now y'}]});
    await sleep(10);
    assert.equal(h.logs.filter(e => e.kind === 'classifier_warm' || e.kind === 'classifier_switch' || e.kind === 'exception').length, 0);
});

test('a conversation that closes before the eye view shows never starts the warm (D93)', async () => {
    let warmed = 0, showEye;
    const classify = () => Promise.resolve({label: 'none'});
    classify.warm = () => { warmed++; return Promise.resolve(); };
    const h = harness({classify});
    h.jibo.face.views.forceEyeView = cb => { showEye = cb; };
    h.talk.open();
    await sleep(20);
    h.talk.close();
    showEye();
    await sleep(20);
    assert.equal(warmed, 0);
});

test('the greeting smiles with the eye only (no body movement), outside the classifier\'s choices', async () => {
    const h = await listening({config: {greetingExpression: DEFAULTS.greetingExpression}});
    assert.equal(h.said[0], 'Hi!'); assert.deepEqual(clips(h), ['eye_happy_00@null']);
    assert.equal(DEFAULTS.greeting, 'Hi!');
    assert.ok(!labels.choices('line').some(c => c.value === 'smile'));
    h.talk.close();
});

test('an emoji with a hold frame stays on the eye for holdMs; other animations and short holds are left alone', async () => {
    const Player = require(path.join(source, 'noggin/lib/expression.js'));
    const configs = {};
    const metas = {Emoji_Brain: {duration: 57, holdSafeKF: 32, endsNeutral: true}, happy_01: {duration: 40, holdSafeKF: -1, endsNeutral: true}};
    const jibo = {animDB: {getAnimByName: name => ({meta: metas[name], createFromConfig: config => {
        configs[name] = config;
        return Promise.resolve({instance: {events: {}}, play: () => Promise.resolve('STOPPED'), stop: () => Promise.resolve()});
    }})}};
    const logs = [];
    const player = new Player(jibo, {write: e => logs.push(e)});
    await player.play('Emoji_Brain', {via: 'emoji', holdMs: 3000}).done;
    assert.equal(configs.Emoji_Brain.duration, 90, '3 s at 30 frames a second');
    assert.equal(logs.at(-1).held, 90);
    await player.play('happy_01', {holdMs: 3000}).done;
    assert.equal(configs.happy_01.duration, undefined, 'no hold frame: played as it is');
    await player.play('Emoji_Brain', {holdMs: 1000}).done;
    assert.equal(configs.Emoji_Brain.duration, undefined, 'already longer than asked');
});

test('a notice or trouble emoji asks for a hold of about the line\'s length, between 3 and 4.5 s', async () => {
    const anim = fakeAnimDB();
    anim.animDB.getAnimByName = (base => name => Object.assign(base(name) || {}, {meta: {duration: 57, holdSafeKF: 32, endsNeutral: true}}))(anim.animDB.getAnimByName);
    const h = await listening({config: {}, animDB: anim.animDB, expression: anim.expression});
    await h.talk.speak('Ooo, a brain test.', null, {turn: 1, line: 0, anim: 'Emoji_Brain', emoji: 'brain', via: 'emoji'});
    await sleep(30);
    const asked = anim.played.find(p => p.name === 'Emoji_Brain');
    assert.equal(asked.config.duration, 90, 'a short line: the 3 s minimum');
    h.talk.close();
});

