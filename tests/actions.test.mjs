// SPDX-License-Identifier: MIT
// Noggin's actions (lib/actions.js) and the comeback after a handover (lib/comeback.js).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const actions = require(path.join(source, 'noggin/lib/actions.js'));
const comeback = require(path.join(source, 'noggin/lib/comeback.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('set_timer: durations become the NLU @be/clock gets from the cloud; out-of-range ones are refused', () => {
    const p = actions.plan('set_timer', '{"minutes":90}', {});
    assert.equal(p.kind, 'handover'); assert.equal(p.target, '@be/clock'); assert.equal(p.comeback, true);
    assert.deepEqual(p.options.nlu.entities, {domain: 'timer', hours: '1', minutes: '30', seconds: 'null', time: 'null', ampm: 'null'});
    assert.deepEqual(p.args, {seconds: 5400, duration: '1 hour and 30 minutes'});
    assert.deepEqual(actions.plan('set_timer', '{"seconds":45}', {}).options.nlu.entities.seconds, '45');
    assert.equal(actions.plan('set_timer', '{"seconds":5}', {}).error, 'a timer must be longer than 5 seconds');
    assert.equal(actions.plan('set_timer', '{"hours":24,"minutes":1}', {}).error, 'a timer can be at most 24 hours');
    assert.equal(actions.plan('set_timer', '{}', {}).error, 'no duration given: ask the person how long');
    assert.equal(actions.plan('set_timer', '{"minutes":2.5}', {}).error, 'hours, minutes and seconds must be whole numbers');
    assert.equal(actions.plan('set_timer', '{oops', {}).error, 'the arguments were not valid JSON');
    assert.equal(actions.plan('set_timer', '{"hours":24}', {}).kind, 'handover');
});

test('cancel, query, local tools, unknown tools', () => {
    // A cancel first reads the clock's record in Noggin (controller.runLocal); the clock only if there is something to cancel.
    assert.deepEqual(actions.plan('cancel_timer', '', {}), {kind: 'local', run: 'cancel', args: {domain: 'timer'}});
    assert.deepEqual(actions.plan('cancel_alarm', '', {}), {kind: 'local', run: 'cancel', args: {domain: 'alarm'}});
    assert.deepEqual(actions.clockCancel('timer').options, {nlu: {intent: 'stop', entities: {domain: 'timer'}}, match: {skipSurprises: true}});
    assert.deepEqual(actions.clockCancel('alarm').options.nlu, {intent: 'stop', entities: {domain: 'alarm'}});
    assert.equal(actions.clockCancel('alarm').comeback, true);
    assert.deepEqual(actions.clockQuery().options.nlu, {intent: 'query', entities: {domain: 'timer'}});
    // get_time: Jibo's clock shows and says it (askForTime / askForDate, as the cloud launches the clock), and Noggin comes back.
    assert.deepEqual(actions.plan('get_time', '{"show":"time"}', {}), {kind: 'handover', target: '@be/clock',
        options: {nlu: {intent: 'askForTime', entities: {domain: 'clock'}}, match: {skipSurprises: true}}, comeback: true, args: {show: 'time'}});
    assert.deepEqual(actions.plan('get_time', '{"show":"date"}', {}).options.nlu, {intent: 'askForDate', entities: {domain: 'clock'}});
    assert.deepEqual(actions.plan('get_time', '{}', {}).args, {show: 'time'}, 'no show: the time');
    assert.deepEqual(actions.plan('dance', '{}', {}), {kind: 'local', run: 'dance'});
    assert.deepEqual(actions.plan('check_clock', '{}', {}), {kind: 'local', run: 'clock'});
    assert.equal(actions.plan('check_timer', '{}', {}).kind, 'error', 'check_timer is now check_clock');
    assert.equal(actions.plan('reboot', '{}', {}).kind, 'error');
});

test('open_app: Jibo\'s built-in apps plus the openApps setting\'s extras; the clock opens on its menu; never Noggin itself', () => {
    const builtin = {clock: '@be/clock', settings: '@be/settings', menu: '@be/main-menu', gallery: '@be/gallery', yoga: '@be/exercise', 'meet someone new': '@be/introductions'};
    assert.deepEqual(actions.apps({openApps: null}), builtin);
    assert.deepEqual(actions.apps({}), builtin, 'the default openApps is {}');
    const config = {openApps: {Clock: '@be/clock', 'My Stars': '@be/stargazer', talk: '@be/noggin', evil: '../../x', list: ['a']}};
    assert.deepEqual(actions.apps(config), Object.assign({}, builtin, {'my stars': '@be/stargazer'}));
    assert.deepEqual(actions.plan('open_app', '{"name":"clock"}', config).options, {nlu: {intent: 'menu', entities: {domain: 'clock'}}, match: {skipSurprises: true}});
    const stars = actions.plan('open_app', '{"name":"my  stars"}', config);
    assert.equal(stars.target, '@be/stargazer'); assert.equal(stars.check, true, 'an extra app is checked before it opens');
    assert.deepEqual(stars.options, {nlu: {intent: 'menu', entities: {domain: '@be/stargazer'}}, match: {skipSurprises: true}});
    assert.equal(actions.plan('open_app', '{"name":"gallery"}', config).check, undefined, 'built-in apps are not checked');
    assert.match(actions.plan('open_app', '{"name":"telejibo"}', config).error, /not on Jibo's list \(clock, settings, .*my stars\)/);
    // An extra entry for a built-in package gets that app's own launch.
    assert.deepEqual(actions.plan('open_app', '{"name":"exercise"}', {openApps: {exercise: '@be/exercise'}}).options, actions.APPS.yoga.options);
    for (const name of ['recipes', 'doom', 'hue']) assert.equal(actions.plan('open_app', JSON.stringify({name}), {}).kind, 'error', name + ' is not built in');
});

test('built-in apps and skills: each launch carries what that skill\'s own code reads', () => {
    const nlu = (tool, name) => actions.plan(tool, JSON.stringify({name}), {});
    // @be/exercise reads intent/entities at the top level; @be/introductions needs nlu.entities.
    assert.deepEqual(nlu('open_app', 'yoga').options, {nlu: {intent: 'exerciseDoYoga', entities: {domain: 'exercise'}}, match: {skipSurprises: true}, intent: 'exerciseDoYoga', entities: {}});
    assert.deepEqual(nlu('open_app', 'meet someone new').options.nlu, {intent: 'enrollment', entities: {domain: 'introductions'}});
    assert.deepEqual(nlu('open_app', 'settings').options.nlu, {intent: 'menu', entities: {domain: 'settings'}});
    assert.equal(nlu('open_app', 'menu').target, '@be/main-menu');
    const skills = {'take a photo': ['@be/create', 'createOnePhoto'], 'photo booth': ['@be/create', 'createSomePhotos'],
        'word of the day': ['@be/word-of-the-day', 'play'], 'sing daisy bell': ['@be/daisy-bell', 'sing'], 'who am i': ['@be/who-am-i', 'launchWhoAmI']};
    for (const [name, [pkg, intent]] of Object.entries(skills)) {
        const p = nlu('use_skill', name.toUpperCase());
        assert.equal(p.kind, 'handover'); assert.equal(p.target, pkg); assert.equal(p.options.nlu.intent, intent);
        assert.equal(p.comeback, true, name + ' comes back'); assert.equal(p.options.match.skipSurprises, true);
        assert.equal(p.check, undefined, name + ' is part of Jibo: not checked');
    }
    // Stargazer, a store skill: the generic launch, checked before it opens.
    const star = nlu('use_skill', 'Stargazer');
    assert.deepEqual([star.target, star.comeback, star.check], ['@be/stargazer', true, true]);
    assert.deepEqual(star.options, {nlu: {intent: 'menu', entities: {domain: '@be/stargazer'}}, match: {skipSurprises: true}});
    assert.deepEqual(Object.keys(actions.SKILLS), Object.keys(skills).concat(['stargazer']));
    assert.match(nlu('use_skill', 'doom').error, /not one of Jibo's skills/);
    // The launch options are copies: changing one never changes the table.
    nlu('use_skill', 'photo booth').options.nlu.intent = 'x';
    assert.equal(actions.SKILLS['photo booth'].options.nlu.intent, 'createSomePhotos');
});

test('set_alarm: the 24-hour time becomes the clock\'s 12-hour "H:MM" and upper-case AM/PM', () => {
    const at = (hour, minute) => actions.plan('set_alarm', JSON.stringify(minute === undefined ? {hour} : {hour, minute}), {});
    assert.deepEqual(at(7, 30).options, {nlu: {intent: 'set', entities: {domain: 'alarm', time: '7:30', ampm: 'AM', hours: 'null', minutes: 'null', seconds: 'null'}}, match: {skipSurprises: true}});
    assert.equal(at(7, 30).target, '@be/clock'); assert.equal(at(7, 30).comeback, true);
    const e = p => [p.options.nlu.entities.time, p.options.nlu.entities.ampm, p.args.time];
    assert.deepEqual(e(at(19, 5)), ['7:05', 'PM', '7:05 PM']);
    assert.deepEqual(e(at(0)), ['12:00', 'AM', '12:00 AM']);
    assert.deepEqual(e(at(12)), ['12:00', 'PM', '12:00 PM']);
    assert.deepEqual(e(at(23, 59)), ['11:59', 'PM', '11:59 PM']);
    assert.equal(actions.plan('set_alarm', '{}', {}).error, 'no time given: ask the person what time');
    for (const bad of [{hour: 24}, {hour: 7, minute: 60}, {hour: 7.5}, {hour: -1}]) assert.equal(actions.plan('set_alarm', JSON.stringify(bad), {}).kind, 'error', JSON.stringify(bad));
});

test('play_music and play_radio: what @be/music and @be/radio read', () => {
    const m = actions.plan('play_music', {song: '  Bohemian Rhapsody ', artist: 'Queen'}, {});
    assert.deepEqual(m.options, {nlu: {intent: 'playSong', entities: {domain: 'music', query: 'Bohemian Rhapsody', artist: 'Queen'}}, match: {skipSurprises: true}});
    assert.equal(m.target, '@be/music'); assert.equal(m.comeback, false);
    assert.deepEqual(actions.plan('play_music', {song: 'Yesterday'}, {}).options.nlu.entities, {domain: 'music', query: 'Yesterday'});
    assert.equal(actions.plan('play_music', {song: ' '}, {}).error, 'no song given: ask the person which song');
    assert.equal(actions.plan('play_music', {song: 'x'.repeat(500)}, {}).options.nlu.entities.query.length, 160);
    const r = actions.plan('play_radio', {genre: 'Classic Rock'}, {});
    assert.deepEqual(r.options, {nlu: {intent: 'play', entities: {domain: 'radio', station: 'ClassicRock'}}, match: {skipSurprises: true}});
    assert.equal(r.target, '@be/radio'); assert.equal(r.comeback, false);
    assert.deepEqual(actions.plan('play_radio', {}, {}).options.nlu, {intent: 'play', entities: {domain: 'radio'}});
    assert.equal(actions.plan('play_radio', {genre: 'reggae'}, {}).options.nlu.entities.station, 'ReggaeAndIsland');
    assert.match(actions.plan('play_radio', {genre: 'metal'}, {}).error, /no such genre/);
    assert.equal(Object.keys(actions.RADIO).length, 20);
});

test('set_volume: a level 1-10 or a step, through jibo.volume', () => {
    assert.deepEqual(actions.plan('set_volume', {level: 4}, {}), {kind: 'local', run: 'volume', args: {level: 4}});
    assert.deepEqual(actions.plan('set_volume', {change: 'down'}, {}), {kind: 'local', run: 'volume', args: {change: 'down'}});
    assert.equal(actions.plan('set_volume', {level: 11}, {}).kind, 'error');
    assert.equal(actions.plan('set_volume', {}, {}).kind, 'error');
    const calls = [];
    const volume = {currentVolume: 6, changeVolume(intent, value) { calls.push([intent, value]); this.currentVolume = value ? Number(value) : this.currentVolume + 2; }};
    assert.deepEqual(actions.setVolume({volume}, {level: 3}), {ok: true, volume: 3, of: 10});
    assert.deepEqual(actions.setVolume({volume}, {change: 'up'}), {ok: true, volume: 5, of: 10});
    assert.deepEqual(calls, [['volumeToValue', '3'], ['volumeUp', undefined]]);
    assert.equal(actions.setVolume({}, {level: 3}).ok, false);
    assert.equal(actions.setVolume({volume: {changeVolume() { throw Error('x'); }}}, {level: 3}).ok, false);
});

test('installed: @be packages through require.resolve; other names are not checked', () => {
    const resolve = name => { if (name !== '@be/clock') throw Error('Cannot find module'); return '/x'; };
    assert.equal(actions.installed(resolve, '@be/clock'), true);
    assert.equal(actions.installed(resolve, '@be/stargazer'), false);
    assert.equal(actions.installed(resolve, 'other-skill'), true);
});

test('readClock: the timer and the alarm from the clock\'s record; null when it cannot be read', async () => {
    const kb = data => ({createModel: () => ({loadRoot: () => Promise.resolve({data})})});
    const now = () => Date.UTC(2026, 10, 14, 12, 0);
    const jibo = data => ({kb: kb(data)});
    const later = new Date(2026, 10, 15, 7, 30).getTime();
    const both = await actions.readClock(jibo({timer: {endTime: now() + 60000, length: 120000}, alarm: {dateTimeInstance: {utc: later}, jobID: 'a'}}), now);
    assert.equal(both.timer.remaining, '1 minute');
    assert.deepEqual(both.alarm, {set: true, time: '7:30 AM', day: 'Sunday, November 15, 2026'});
    assert.deepEqual(await actions.readClock(jibo({alarm: {dateTimeInstance: {utc: now() - 1}}}), now), {timer: {set: false}, alarm: {set: false}});
    assert.deepEqual(await actions.readClock(jibo({}), now), {timer: {set: false}, alarm: {set: false}});
    assert.equal(await actions.readClock({}, now), null);
});

test('time: Jibo\'s home timezone through jibo.utils.DateTime, else the system clock', () => {
    const calls = [];
    class DateTime { constructor(ms, zone) { calls.push([ms, zone.id]); } getLocalTime() { return {year: 2026, monthNum: 10, date: 13, dayOfWeek: 'Friday', hour: 0, minute: 4}; } }
    const jibo = {utils: {DateTime, Location: {jiboHome: {timezone: {id: 'Europe/Amsterdam'}}}}};
    const t = actions.localTime(jibo, 123);
    assert.deepEqual(calls, [[123, 'Europe/Amsterdam']]);
    assert.deepEqual(actions.describeTime(t), {time: '12:04 AM', date: 'Friday, November 13, 2026', timezone: 'Europe/Amsterdam'});
    assert.equal(actions.describeTime(Object.assign({}, t, {dayOfWeek: 'friday'})).date, 'Friday, November 13, 2026', 'the runtime\'s lower-case weekday');
    const fallback = actions.localTime({utils: {DateTime, Location: {jiboHome: {}}}}, new Date(2026, 10, 12, 19, 30).getTime());
    assert.deepEqual(actions.describeTime(fallback), {time: '7:30 PM', date: 'Thursday, November 12, 2026', timezone: null});
    const broken = actions.localTime({utils: {DateTime: class { constructor() { throw Error('no tz'); } }, Location: {jiboHome: {timezone: {}}}}}, 0);
    assert.equal(typeof broken.hour, 'number');
});

test('readTimer: the clock\'s KB record, read-only; null when it cannot be read in time', async () => {
    const kb = timer => ({onInit: () => Promise.resolve(), createModel: name => { assert.equal(name, '/jibo/clock/alarm_timer'); return {loadRoot: () => Promise.resolve({data: timer ? {timer} : {}})}; }});
    const now = () => 1000000;
    assert.deepEqual(await actions.readTimer({kb: kb({endTime: 1000000 + 125000, length: 600000, jobID: 'j'})}, now),
        {set: true, remaining_s: 125, remaining: '2 minutes and 5 seconds', length_s: 600});
    assert.deepEqual(await actions.readTimer({kb: kb({endTime: 999000})}, now), {set: false});
    assert.deepEqual(await actions.readTimer({kb: kb(null)}, now), {set: false});
    assert.equal(await actions.readTimer({}, now), null);
    assert.equal(await actions.readTimer({kb: {createModel: () => ({loadRoot: () => new Promise(() => {})})}}, now, 30), null);
    assert.equal(await actions.readTimer({kb: {createModel: () => { throw Error('x'); }}}, now), null);
    assert.equal(actions.duration(3600), '1 hour'); assert.equal(actions.duration(3661), '1 hour, 1 minute and 1 second');
});

function fakeWorld() {
    const hj = [];
    const jibo = {tts: {speak(text) { return 'spoken'; }, isTalking: false},
        embodied: {speech: {speak(text) { return jibo.tts.speak(text); }}},
        jetstream: {events: {hjHeard: {on: f => hj.push(f), off: f => hj.splice(hj.indexOf(f), 1)}}},
        privacyController: {enabled: false}};
    const be = {currentSkill: {assetPack: '@be/noggin'}};
    let t = 0, tick = null;
    const clock = {setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { tick = null; }, now: () => t};
    const step = (ms = 250) => { t += ms; if (tick) tick(); };
    return {jibo, be, clock, step, hj, running: () => !!tick};
}

test('comeback: after the clock, once Jibo is idle and quiet, calls back with what he said and restores speech', async () => {
    const w = fakeWorld(), originalTts = w.jibo.tts.speak, originalSpeech = w.jibo.embodied.speech.speak;
    let said = null;
    comeback.watch(w.jibo, w.be, s => { said = s; }, {own: '@be/noggin', clock: w.clock});
    w.step();
    w.be.currentSkill = {assetPack: '@be/clock'}; w.step();
    w.jibo.embodied.speech.speak("<speak><anim name='x'/>You got it . 10 minutes .</speak>");
    w.jibo.tts.speak({esml: 'Bye now'});
    w.be.currentSkill = {assetPack: '@be/idle'}; w.jibo.tts.isTalking = true; w.step(); w.step(2000);
    assert.equal(said, null, 'waits while he talks');
    w.jibo.tts.isTalking = false; w.step(); w.step(1000); assert.equal(said, null, 'quiet for 1.5 s first');
    w.step(600);
    assert.equal(said, 'You got it. 10 minutes. Bye now');
    assert.equal(w.jibo.tts.speak, originalTts); assert.equal(w.jibo.embodied.speech.speak, originalSpeech);
    assert.equal(w.running(), false); assert.equal(w.hj.length, 0);
});

test('comeback keeps a line once when both speech paths pass it, even with different case or punctuation', () => {
    const w = fakeWorld();
    let said = null;
    comeback.watch(w.jibo, w.be, s => { said = s; }, {own: '@be/noggin', clock: w.clock});
    w.be.currentSkill = {assetPack: '@be/clock'}; w.step();
    w.jibo.embodied.speech.speak = function (text) { return w.jibo.tts.speak(String(text).toLowerCase().replace('.', '')); }.bind(null);
    w.jibo.tts.speak('You got it. 10 minutes');
    w.jibo.tts.speak('you got it 10 minutes');
    w.jibo.tts.speak('Okay. I canceled it.'); w.jibo.tts.speak('okay. I canceled it.');
    w.jibo.tts.speak('You got it. tomorrow at 7:30 AM'); w.jibo.tts.speak('You got it. tomorrow at 7: 30AM');
    w.be.currentSkill = {assetPack: '@be/idle'}; w.step(); w.step(2000);
    assert.equal(said, 'You got it. 10 minutes Okay. I canceled it. You got it. tomorrow at 7:30 AM');
});

test('comeback gives up on "Hey Jibo" back on idle, on the timeout, with privacy on, and on cancel', () => {
    const run = (setup) => {
        const w = fakeWorld(), out = {};
        const handle = comeback.watch(w.jibo, w.be, s => { out.said = s; }, {own: '@be/noggin', clock: w.clock, timeoutMs: 10000, onGiveUp: r => { out.reason = r; }});
        setup(w, handle);
        return out;
    };
    assert.deepEqual(run(w => { w.be.currentSkill = {assetPack: '@be/clock'}; w.step(); w.hj.forEach(f => f()); w.be.currentSkill = {assetPack: '@be/idle'}; w.step(); w.hj.forEach(f => f()); }), {reason: 'hotword'});
    assert.deepEqual(run(w => { w.step(11000); }), {reason: 'timeout'});
    assert.deepEqual(run(w => { w.be.currentSkill = {assetPack: '@be/clock'}; w.step(); w.be.currentSkill = {assetPack: '@be/idle'}; w.jibo.privacyController.enabled = true; w.step(); w.step(2000); }), {reason: 'privacy'});
    assert.deepEqual(run((w, h) => { h.cancel(); w.step(); }), {reason: 'cancelled'});
    // Never left Noggin (the handover failed): idle alone is not "done".
    assert.deepEqual(run(w => { w.be.currentSkill = {assetPack: '@be/idle'}; w.step(); w.step(2000); }), {});
    // Without leaveMs (the clock path) there is no limit on when Jibo leaves.
    assert.deepEqual(run(w => { w.be.currentSkill = {assetPack: '@be/idle'}; w.step(9000); }), {});
});

test('relaunch: Agent Mode\'s skill relaunch, with the public event as a fallback', () => {
    const got = [];
    assert.equal(comeback.relaunch({globalEvents: {onSkillRelaunch: d => got.push(['private', d])}}, '@be/noggin'), true);
    assert.equal(got[0][1].result.match.skillID, '@be/noggin'); assert.equal(got[0][1].result.match.skipSurprises, true);
    assert.equal(comeback.relaunch({globalEvents: {skillRelaunch: {emit: d => got.push(['public', d])}}}, '@be/noggin'), true);
    assert.equal(got[1][1].match.skillID, '@be/noggin');
    assert.equal(comeback.relaunch({}, '@be/noggin'), false);
});

test('about_jibo: answered in Noggin from the facts', () => {
    assert.deepEqual(actions.plan('about_jibo', '{}', {}), {kind: 'local', run: 'facts'});
    assert.equal(actions.voiceOf('about_jibo'), 'talk');
    assert.match(actions.rules([]), /look up facts about yourself/);
});

test('who speaks: every tool declares it, and its description, the instructions and the comeback follow from it', () => {
    const voices = Object.keys(actions.VOICES);
    assert.deepEqual(voices.sort(), ['leaves', 'skill', 'talk']);
    const config = {cloudSkills: Object.keys(actions.CLOUD)};
    const sent = actions.tools(config);
    const live = actions.TOOLS.filter(t => !(t.cloud && actions.CLOUD[t.name].disabled));
    assert.equal(sent.length, live.length, 'every tool is offered (with every cloud feature on), except disabled ones');
    assert.ok(!sent.some(t => t.name === 'joke'), 'joke is disabled');
    for (const tool of live) {
        assert.ok(voices.includes(tool.voice), tool.name + ' says who speaks');
        assert.ok(tool.ability || tool.cloud && actions.CLOUD[tool.name].topic, tool.name + ' says what ability it gives');
        const api = sent.find(t => t.name === tool.name);
        assert.deepEqual(Object.keys(api), ['type', 'name', 'description', 'parameters'], tool.name + ': only API fields go to OpenAI');
        assert.ok(api.description.endsWith(actions.VOICES[tool.voice].tool), tool.name + ': description ends with its voice rule');
        // The cloud tools go by one name in the instructions ("your cloud tools").
        const named = tool.cloud ? 'your cloud tools' : tool.name;
        assert.match(actions.rules(config), new RegExp('For [a-z_, ]*\\b' + named + '\\b[a-z_, ]*, ' + actions.VOICES[tool.voice].you.slice(0, 30).replace(/[()]/g, '\\$&')),
            tool.name + ' is named under its voice in the instructions');
    }
    // Handover tools come back only when the skill they hand to speaks for them.
    const handovers = {set_timer: '{"minutes":1}', set_alarm: '{"hour":7}', use_skill: '{"name":"photo booth"}',
        play_music: '{"song":"Yesterday"}', play_radio: '{}', open_app: '{"name":"clock"}'};
    handovers.get_time = '{"show":"date"}';
    for (const name of Object.keys(actions.CLOUD)) if (!actions.CLOUD[name].disabled) handovers[name] = actions.CLOUD[name].subject ? '{"subject":"a horse"}' : '{}';
    for (const [name, args] of Object.entries(handovers)) {
        const p = actions.plan(name, args, config);
        assert.equal(p.kind, actions.CLOUD[name] ? 'cloud' : 'handover');
        assert.equal(p.comeback, actions.voiceOf(name) === 'skill', name + ' comeback follows its voice');
    }
    assert.equal(actions.clockQuery().comeback, true, 'check_clock\'s clock fallback speaks, so it comes back');
    assert.equal(actions.clockCancel('timer').comeback, actions.voiceOf('cancel_timer') === 'skill');
    assert.equal(actions.clockCancel('alarm').comeback, actions.voiceOf('cancel_alarm') === 'skill');
});

// ---- Jibo's cloud features (0.10.0) ----
// The phrases BEam 13.0.11's main menu sends (@be/be skills/main-menu/index.js:345-394).
const MENU_PHRASES = {joke: 'tell me a joke', surprise: 'surprise me', personal_report: 'personal report', weather: 'tell me about the weather',
    news: 'tell me about the news', calendar: 'tell me about my calendar', commute: 'what does my commute look like'};
const BASE_TOOLS = ['get_time', 'about_jibo', 'dance', 'set_volume', 'check_clock', 'set_timer', 'cancel_timer', 'set_alarm', 'cancel_alarm',
    'use_skill', 'play_music', 'play_radio', 'open_app'];

test('cloud tools: none by default; only the ones cloudSkills names are offered, unknown names left out', () => {
    for (const config of [{}, {cloudSkills: []}, {cloudSkills: null}, {cloudSkills: ['story', 'hue']}, []]) {
        assert.deepEqual(actions.tools(config).map(t => t.name), BASE_TOOLS, JSON.stringify(config));
        assert.doesNotMatch(actions.rules(config), /cloud/);
    }
    assert.deepEqual(actions.cloudSkills({cloudSkills: ['News', 'weather', 'story']}), ['weather', 'news'], 'in a fixed order, case-insensitive');
    assert.deepEqual(actions.cloudSkills({cloudSkills: 'news, surprise'}), ['news', 'surprise'], 'a hand-written string works too');
    assert.deepEqual(actions.cloudSkills({cloudSkills: ['joke', 'surprise']}), ['surprise'], 'joke is disabled, even when listed');
    const two = actions.tools({cloudSkills: ['weather', 'news']}).map(t => t.name);
    assert.deepEqual(two, BASE_TOOLS.slice(0, 10).concat(['weather', 'news'], BASE_TOOLS.slice(10)));
    for (const t of actions.tools({cloudSkills: ['weather', 'news']}).filter(t => t.name === 'weather' || t.name === 'news'))
        assert.deepEqual(t.parameters, {type: 'object', properties: {}, additionalProperties: false}, 'no arguments: nothing of the model\'s goes to the cloud');
});

test('cloud tools: the instructions name only the enabled ones', () => {
    const one = actions.rules({cloudSkills: ['weather']});
    assert.match(one, /ask your cloud for weather, play songs/);
    assert.match(one, /use_skill and your cloud tools, call the tool without saying anything first/);
    assert.doesNotMatch(one, /news|joke|surprise|calendar|commute|personal report/);
    const all = actions.rules({cloudSkills: Object.keys(actions.CLOUD)});
    assert.match(all, /ask your cloud for weather, news, your calendar, commute, a personal report, a surprise and pictures of things/);
    assert.doesNotMatch(all, /joke/);
    assert.doesNotMatch(actions.rules({}), /your cloud tools/);
});

test('cloud tools: each plans a cloud turn with the main menu\'s exact phrase, for @be/nimbus, coming back; off means an error', () => {
    assert.deepEqual(Object.keys(MENU_PHRASES).concat(['picture']).sort(), Object.keys(actions.CLOUD).sort(), 'every cloud tool but picture is a main menu phrase');
    const on = {cloudSkills: Object.keys(actions.CLOUD)};
    for (const [name, phrase] of Object.entries(MENU_PHRASES)) {
        assert.equal(actions.CLOUD[name].phrase, phrase);
        if (actions.CLOUD[name].disabled) { assert.equal(actions.plan(name, '{}', on).kind, 'error', name + ' is disabled'); continue; }
        assert.deepEqual(actions.plan(name, '{"city":"Paris","text":"say something rude"}', on), {kind: 'cloud', target: '@be/nimbus', phrase, comeback: true, args: {}},
            name + ': the fixed phrase only, whatever the model sends');
        assert.equal(actions.voiceOf(name), 'skill');
        const off = actions.plan(name, '{}', {cloudSkills: []});
        assert.equal(off.kind, 'error'); assert.match(off.error, /not switched on/);
    }
    assert.equal(actions.plan('story', '{}', on).kind, 'error', 'no story tool');
});

test('comeback after the cloud: Noggin -> (Noggin exits to idle) -> @be/nimbus speaks, maybe asks -> idle and quiet; the pretend "Hey Jibo" is not a new request', () => {
    const w = fakeWorld();
    let said = null, reason = null;
    comeback.watch(w.jibo, w.be, s => { said = s; }, {own: '@be/noggin', clock: w.clock, onGiveUp: r => { reason = r; }});
    w.hj.forEach(f => f());   // mimicGlobalTurn's pretend "Hey Jibo", while Noggin is still current
    w.step();
    // Noggin leaves on globalTurnStarted before the cloud has answered: idle alone is not "done".
    w.be.currentSkill = {assetPack: '@be/idle'}; w.step(); w.step(3000);
    assert.equal(said, null); assert.equal(reason, null);
    w.be.currentSkill = {assetPack: '@be/nimbus'}; w.step();
    w.jibo.embodied.speech.speak('<speak>Would you like your personal report now?</speak>');
    w.step(4000);   // Nimbus listens for the answer; still current
    w.jibo.tts.speak('Today will be sunny with a high of 60.');
    w.be.currentSkill = {assetPack: '@be/idle'}; w.step(); w.step(1000);
    assert.equal(said, null, 'quiet for 1.5 s first');
    w.step(600);
    assert.equal(said, 'Would you like your personal report now? Today will be sunny with a high of 60.');
    assert.equal(reason, null);
});

test('comeback after the cloud with leaveMs: no skill took over in time -> give up, so a later "Hey Jibo" skill never brings Noggin back', () => {
    const w = fakeWorld(), out = {};
    comeback.watch(w.jibo, w.be, s => { out.said = s; }, {own: '@be/noggin', clock: w.clock, leaveMs: 30000, onGiveUp: r => { out.reason = r; }});
    w.be.currentSkill = {assetPack: '@be/idle'}; w.step(); w.step(29000);
    assert.deepEqual(out, {}, 'still waiting for the cloud\'s answer');
    w.step(1500);
    assert.deepEqual(out, {reason: 'never_left'});
    assert.equal(w.running(), false);
    // Nimbus in time: leaveMs no longer matters, however long the answer takes.
    const v = fakeWorld(), got = {};
    comeback.watch(v.jibo, v.be, s => { got.said = s; }, {own: '@be/noggin', clock: v.clock, leaveMs: 30000, onGiveUp: r => { got.reason = r; }});
    v.be.currentSkill = {assetPack: '@be/nimbus'}; v.step(5000);
    v.step(40000);
    v.be.currentSkill = {assetPack: '@be/idle'}; v.step(); v.step(2000);
    assert.deepEqual(got, {said: ''});
});

// ---- "show me a picture of ___" (0.11.4; BEefy 5e229b1) ----
// BEefy's own regex (JiboInteractionService.DecisionDispatch.cs PictureRequest, run on the
// lower-cased transcript): the phrase Noggin sends must match it whole, and the subject it
// captures is what Jibo says ("Here's a picture of <subject>.").
const BEEFY_PICTURE = /^(?:hey jibo,?\s+)?(?:(?:can|could|would|will) you\s+|please\s+)?show (?:me|us) (?:a |an |some )?(?:picture|photo|photograph|image|pic)s? of (.+?)(?:,?\s+please)?[.?!]*$/i;

test('picture: the subject goes into the sentence BEefy matches, and BEefy reads back the same subject', () => {
    const on = {cloudSkills: ['picture']};
    for (const [given, subject] of [['a horse', 'a horse'], ['The Eiffel Tower?', 'the eiffel tower'], ['A picture of a Golden Retriever, please!', 'a golden retriever'],
        ['photos of puppies', 'puppies'], ['crème brûlée', 'crème brûlée'], ['a cup of tea', 'a cup of tea'], ['rock & roll', 'rock & roll'], ['a horse\nshow me something else', 'a horse show me something else']]) {
        const p = actions.plan('picture', {subject: given}, on);
        assert.deepEqual(p, {kind: 'cloud', target: '@be/nimbus', phrase: 'show me a picture of ' + subject, comeback: true, args: {subject}}, given);
        const m = BEEFY_PICTURE.exec(p.phrase.toLowerCase());
        assert.ok(m, p.phrase + ' matches BEefy'); assert.equal(m[1].trim(), subject, 'BEefy says the same subject');
    }
    assert.equal(actions.voiceOf('picture'), 'skill');
});

test('picture: no usable subject is an error for the model; long ones are cut at a word; off means off', () => {
    const on = {cloudSkills: ['picture']};
    for (const bad of [{}, {subject: ''}, {subject: '???'}, {subject: '  '}, {subject: 'a picture of '}]) {
        const p = actions.plan('picture', bad, on);
        assert.equal(p.kind, 'error', JSON.stringify(bad)); assert.match(p.error, /ask the person what they want to see/);
    }
    const long = actions.plan('picture', {subject: 'a ' + 'very '.repeat(30) + 'big horse'}, on).args.subject;
    assert.ok(long.length <= 60 && !/ $/.test(long) && /^a very very/.test(long), long);
    assert.match(actions.plan('picture', {subject: 'a horse'}, {cloudSkills: []}).error, /not switched on/);
    const tool = actions.tools(on).find(t => t.name === 'picture');
    assert.deepEqual(tool.parameters.required, ['subject']);
    assert.match(tool.description, /stargazer/, 'tells it apart from the astronomy picture');
});
