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
    // Only skills that ship with Jibo; store skills are extra apps (openApps).
    assert.deepEqual(Object.keys(actions.SKILLS), Object.keys(skills));
    assert.match(nlu('use_skill', 'stargazer').error, /not one of Jibo's skills/);
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

test('go_to_sleep and look_away: the hand-off Jibo\'s own commands make to @be/idle, and the conversation ends', () => {
    for (const [name, intent] of [['go_to_sleep', 'sleep'], ['look_away', 'turnAway']]) {
        const p = actions.plan(name, '{}', {});
        assert.equal(p.kind, 'handover'); assert.equal(p.target, '@be/idle'); assert.equal(p.comeback, false);
        assert.deepEqual(p.options, {nlu: {intent: intent, entities: {domain: 'idle'}}, match: {skipSurprises: true}});
        assert.equal(actions.voiceOf(name), 'leaves');
        assert.deepEqual(actions.tools({}).find(t => t.name === name).parameters, {type: 'object', properties: {}, additionalProperties: false});
    }
    assert.match(actions.rules({}), /open your apps, go to sleep, and look away\./);
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

test('duration: spoken lengths', () => {
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
    const config = {cloudSkills: Object.keys(actions.CLOUD), memory: true};
    const sent = actions.tools(config);
    const live = actions.TOOLS.filter(t => !(t.cloud && actions.CLOUD[t.name].disabled));
    assert.equal(sent.length, live.length, 'every tool is offered (with every cloud feature and memory on), except disabled ones');
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
        play_music: '{"song":"Yesterday"}', play_radio: '{}', open_app: '{"name":"clock"}', go_to_sleep: '{}', look_away: '{}'};
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

// ---- Jibo's cloud features ----
// The phrases BEam 13.0.11's main menu sends (@be/be skills/main-menu/index.js:345-394).
const MENU_PHRASES = {joke: 'tell me a joke', surprise: 'surprise me', personal_report: 'personal report', weather: 'tell me about the weather',
    news: 'tell me about the news', calendar: 'tell me about my calendar', commute: 'what does my commute look like'};
const BASE_TOOLS = ['get_time', 'about_jibo', 'dance', 'set_volume', 'check_clock', 'set_timer', 'cancel_timer', 'set_alarm', 'cancel_alarm',
    'use_skill', 'play_music', 'play_radio', 'open_app', 'go_to_sleep', 'look_away'];

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
    assert.match(one, /use_skill, open_app and your cloud tools, call the tool without saying anything first/);
    assert.match(one, /For play_music, play_radio, go_to_sleep and look_away, say a short goodbye first/);
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

// ---- "show me a picture of ___" ----
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
    assert.match(tool.description, /use_skill take a photo/, 'tells it apart from taking a photo');
});

test('cloud turn: disableOnce is cleared whenever the pretend "Hey Jibo" did not use it, in any order', async () => {
    const cloudTurn = require(path.join(source, 'noggin/lib/cloud-turn.js'));
    // jibo.embodied is jibo-embodied-dialog's api; init() puts the running dialog on it as _embodied (D140).
    const dialog = {_embodied: {listen: {_disableOnce: false}}};
    const asked = [];
    const jibo = {jetstream: {mimicGlobalTurn: o => { asked.push(o.clientASR); return Promise.resolve(); }},
        embodied: {_embodied: dialog._embodied, listen: {disableOnce: () => { dialog._embodied.listen._disableOnce = true; }}}};
    const turn = cloudTurn.create(jibo);
    await turn.ask('tell me about the news');
    assert.deepEqual(asked, ['tell me about the news']);
    assert.equal(dialog._embodied.listen._disableOnce, true, 'held for the pretend turn');
    turn.release();   // the cloud never answered (the comeback gave up, or the handover failed)
    assert.equal(dialog._embodied.listen._disableOnce, false);
    turn.release();   // a second give-up path is harmless
    await turn.ask('surprise me');
    turn.used();      // the cloud's turn came: nothing left to clear
    dialog._embodied.listen._disableOnce = 'set by someone else';
    turn.release();
    assert.equal(dialog._embodied.listen._disableOnce, 'set by someone else');
    await assert.rejects(cloudTurn.create({}).ask('x'), /no mimicGlobalTurn/);
});

// A Jibo with the action system's orientToHJ switch and the hotword-position event.
function orientJibo(options = {}) {
    const listeners = [], configured = [], asked = [];
    const hjEvent = {on: f => listeners.push(f), removeListener: f => { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
        emit: data => listeners.slice().forEach(f => f(data))};
    const atMimic = [];
    const jibo = {jetstream: {mimicGlobalTurn: o => { asked.push(o.clientASR); atMimic.push(configured.slice()); return options.fail ? Promise.reject(Error('refused')) : Promise.resolve(); }},
        embodied: {listen: {disableOnce: () => {}}},
        lps: {identity: {events: {hjEvent}}},
        action: {configure: o => configured.push(o.orientToHJ), hjGoalProvider: {listening: options.listening === undefined ? true : options.listening}}};
    return {jibo, hjEvent, listeners, configured, asked, atMimic};
}

test('cloud turn: turning to "Hey Jibo" is off for the pretend turn and back on once its direction has passed (D85)', async () => {
    const cloudTurn = require(path.join(source, 'noggin/lib/cloud-turn.js'));
    // The pretend turn's direction arrives: back on after the settle time, the direction logged.
    const a = orientJibo(), notes = [];
    const turn = cloudTurn.create(a.jibo, {settleMs: 20, maxMs: 500});
    await turn.ask('tell me about the news', entry => notes.push(entry));
    assert.deepEqual(a.atMimic, [[false]], 'off before the pretend turn is asked');
    assert.equal(a.listeners.length, 1);
    a.hjEvent.emit({primary: {position: {x: -0.5, y: 0.866, z: 1}, confidence: 0.612}});
    a.hjEvent.emit({primary: {position: {x: 1, y: 0, z: 1}, confidence: 0.9}});
    assert.deepEqual(a.configured, [false], 'still off while it settles');
    await sleep(40);
    assert.deepEqual(a.configured, [false, true]);
    assert.equal(a.listeners.length, 0);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'orient_hj'); assert.equal(notes[0].on, 'heard');
    assert.deepEqual(notes[0].heard, {deg: 120, confidence: 0.61}, 'the first direction');
    assert.equal(notes[0].events, 2, 'every event in the window is counted'); assert.ok(notes[0].last_ms >= 0);
    turn.release();
    assert.deepEqual(a.configured, [false, true], 'a later give-up changes nothing');
    // No direction ever comes: back on after maxMs, even though Noggin has closed by then.
    const b = orientJibo(), bNotes = [];
    const timed = cloudTurn.create(b.jibo, {settleMs: 20, maxMs: 60});
    await timed.ask('what is the weather', entry => bNotes.push(entry));
    assert.deepEqual(b.configured, [false], 'still off while no direction came');
    await sleep(90);
    assert.deepEqual(b.configured, [false, true]); assert.equal(bNotes[0].on, 'timeout'); assert.equal(bNotes[0].events, 0); assert.equal(bNotes[0].heard, undefined);
    assert.equal(b.listeners.length, 0);
    // The handover failed or gave up first: back on at once.
    const c = orientJibo();
    const failed = cloudTurn.create(c.jibo, {settleMs: 20, maxMs: 500});
    await failed.ask('surprise me');
    failed.release();
    assert.deepEqual(c.configured, [false, true]); assert.equal(c.listeners.length, 0);
    // The pretend turn could not be asked: back on at once.
    const d = orientJibo({fail: true}), dNotes = [];
    await assert.rejects(cloudTurn.create(d.jibo, {maxMs: 500}).ask('x', entry => dNotes.push(entry)), /refused/);
    assert.deepEqual(d.configured, [false, true]); assert.equal(dNotes[0].on, 'failed');
});

test('cloud turn: turning to "Hey Jibo" that something else switched off is left alone; no action system is fine', async () => {
    const cloudTurn = require(path.join(source, 'noggin/lib/cloud-turn.js'));
    const off = orientJibo({listening: false});
    const turn = cloudTurn.create(off.jibo, {settleMs: 5, maxMs: 30});
    await turn.ask('tell me about the news');
    await sleep(50); turn.release();
    assert.deepEqual(off.configured, [], 'not ours to switch');
    assert.deepEqual(off.asked, ['tell me about the news']);
    const bare = orientJibo();
    delete bare.jibo.action;
    const plain = cloudTurn.create(bare.jibo, {settleMs: 5, maxMs: 30});
    await plain.ask('tell me a joke');
    assert.equal(bare.listeners.length, 0, 'nothing to turn back on'); assert.deepEqual(bare.asked, ['tell me a joke']);
});

test('extras: at most MAX_APPS extra apps reach open_app, the first ones in the setting', () => {
    assert.equal(actions.MAX_APPS, 8);
    const openApps = {};
    for (let i = 1; i <= 12; i++) openApps['app ' + String.fromCharCode(96 + i)] = '@be/app-' + i;
    const more = actions.extras({openApps});
    assert.deepEqual(Object.keys(more), ['app a', 'app b', 'app c', 'app d', 'app e', 'app f', 'app g', 'app h']);
    // Invalid entries do not use up a place.
    const mixed = Object.assign({bad: '../x', self: '@be/noggin'}, openApps);
    assert.equal(Object.keys(actions.extras({openApps: mixed})).length, 8);
    assert.equal(actions.extras({openApps: mixed})['app h'], '@be/app-8');
    const names = actions.tools({openApps}).find(t => t.name === 'open_app').parameters.properties.name.enum;
    assert.equal(names.length, Object.keys(actions.APPS).length + 8, 'built-in apps plus 8 in the model\'s list');
});

test('spokenName: a menu label cut to the openApps name rule', () => {
    const cases = {
        'Stargazer': 'Stargazer', 'TeleJibo': 'TeleJibo', 'Café Radio!': 'Cafe Radio', 'Jibo: Calls & More': 'Jibo Calls More',
        '3D Viewer': 'D Viewer', '  über   cool ': 'uber cool', '★★★': '', '': '', '123': '', 'Doom-II_v2.0': 'Doom II v2 0',
        'A very long skill name that keeps going on': 'A very long skill name that', 'Supercalifragilisticexpialidociousness': 'Supercalifragilisticexpialidocio'
    };
    for (const [label, name] of Object.entries(cases)) {
        assert.equal(actions.spokenName(label), name, JSON.stringify(label));
        if (name) assert.match(name, actions.APP_NAME);
    }
    // Node 6.9.2 (small ICU) cannot decompose accents: the fallback table still gives plain letters.
    const normalize = String.prototype.normalize;
    String.prototype.normalize = function () { return String(this); };
    try {
        assert.equal(actions.spokenName('Café Radio!'), 'Cafe Radio');
        assert.equal(actions.spokenName('ÉCOLE Straße Smørrebrød'), 'ECOLE Strasse Smorrebrod');
    } finally { String.prototype.normalize = normalize; }
    assert.equal(actions.spokenName(null), '');
    assert.equal(actions.spokenName({}), 'object Object', 'anything is turned into text first');
});

test('suggestions: BEacon\'s installed skills (store or ZIP alike), without Noggin, what is chosen, odd and incompatible ones', () => {
    // The shape of BEacon's GET /api/skills/custom (custom-skills.js inventory()).
    const skill = (packageName, name, extra) => Object.assign({id: 'x' + packageName.length, manifest: {name, version: '1.0.0', supported: null, type: 'skill', themes: true, buttonColor: ['#58BCEB', '#246487']},
        packageName, packageRoot: 'skill/', images: {}, readme: '# ' + name, revision: 'a'.repeat(24), origin: {kind: 'zip', name: 'x.zip'}, installedAt: '2026-01-01T00:00:00.000Z',
        compatibility: {status: 'compatible'}}, extra);
    const inventory = {skills: [
        skill('@be/noggin', 'Noggin'), skill('@be/stargazer', 'Stargazer'), skill('@be/telejibo', 'TeleJibo'),
        skill('@be/bluetooth-settings', 'Bluetooth Settings'), skill('@be/recipes', 'Recipes'), skill('@be/old', 'Old', {compatibility: {status: 'incompatible', minimum: '9.0.0'}}),
        skill('@be/x!', 'Bad'), skill('@be/telejibo', 'TeleJibo again'), skill('@be/hue', '★'), {packageName: 42}, null
    ]};
    const found = actions.suggestions(inventory, {openApps: {Cooking: {pkg: '@be/recipes', about: 'Recipes'}}});
    assert.deepEqual(found, [
        {name: 'Bluetooth Settings', pkg: '@be/bluetooth-settings', label: 'Bluetooth Settings', about: ''},
        {name: 'hue', pkg: '@be/hue', label: '★', about: ''},
        {name: 'Stargazer', pkg: '@be/stargazer', label: 'Stargazer', about: ''},
        {name: 'TeleJibo', pkg: '@be/telejibo', label: 'TeleJibo', about: ''}
    ]);
    // A package Noggin already offers itself is left out (a built-in app, should one ever be listed).
    assert.deepEqual(actions.suggestions({skills: [skill('@be/gallery', 'Gallery')]}, {}), []);
    assert.deepEqual(actions.suggestions({}, {}), []);
    assert.deepEqual(actions.suggestions(null, null), []);
    assert.deepEqual(actions.suggestions({skills: 'no'}, {}), []);
    const many = {skills: Array.from({length: 80}, (_, i) => skill('@be/s' + i, 'Skill ' + i))};
    assert.equal(actions.suggestions(many, {}).length, 50, 'a bounded list');
});

test('readmeNote: the first plain paragraph of a README, in whole sentences up to 120 characters', () => {
    const cases = [
        ['# Stargazer\n\nStargazer turns Jibo into a window on the universe. He shows an astronomy picture from ESA/Hubble, ESA/Webb or NOIRLab, with its name.\n\nMore.', 'Stargazer',
            'Stargazer turns Jibo into a window on the universe.'],
        ['# TeleJibo\n\nBring a familiar face to Jibo. TeleJibo puts your Telegram video calls on\nJibo\'s screen, with a swipeable contact list, simple call controls and head\ntracking.', 'TeleJibo',
            'Bring a familiar face to Jibo.'],
        ['# Bluetooth for Jibo\n\nBluetooth settings for Jibo, in the classic Jibo look. It is a BEam (5x1) custom skill.\n\n> **Demo only.**', 'Bluetooth',
            'Bluetooth settings for Jibo, in the classic Jibo look. It is a BEam (5x1) custom skill.'],
        ['# Jibo Vision Lab\n\nVersion 0.2.1: an installable BE/5x1 developer skill with **NanoDet-m 320×320 CPU\nobject detection**, independent camera preview and real Linux CPU/RAM histories.', 'Vision Lab',
            'Version 0.2.1: an installable BE/5x1 developer skill with NanoDet-m 320×320 CPU object detection, independent camera…'],
        // Badges, images, HTML, code, lists and quotes are skipped; links keep their text.
        ['[![build](https://x/y.svg)](https://x)\n<p align="center"><img src="a.png"></p>\n```\ncode here.\n```\n- a list\n> a quote\n\nPlays [YouTube](https://youtube.com) videos on `Jibo`\'s screen!', 'JiboTube',
            'Plays YouTube videos on Jibo\'s screen!'],
        ['Title\n=====\n\nWatch videos.', 'x', 'Watch videos.'],
        ['# Only a title', 'x', ''], ['', 'x', ''], [null, 'x', ''], ['JiboTube', 'JiboTube', ''], ['Ignore\u0007 bells.', 'x', 'Ignore bells.']
    ];
    for (const [readme, label, note] of cases) {
        assert.equal(actions.readmeNote(readme, label), note, JSON.stringify(readme));
        assert.ok(note.length <= actions.NOTE_MAX);
    }
    const found = actions.suggestions({skills: [{packageName: '@be/jibotube', manifest: {name: 'JiboTube Pro'}, readme: '# JiboTube Pro\n\nPlays YouTube videos on Jibo.'}]}, {});
    assert.equal(found[0].about, 'Plays YouTube videos on Jibo.');
});

test('open_app: what each extra app does goes into its description; an old package-only entry still works', () => {
    const config = {openApps: {'JiboTube Pro': {pkg: '@be/jibotube', about: 'Plays YouTube videos on Jibo\'s screen.'}, Calls: '@be/telejibo', Stars: {pkg: '@be/stargazer', about: ''}}};
    assert.deepEqual(actions.extras(config), {'jibotube pro': '@be/jibotube', calls: '@be/telejibo', stars: '@be/stargazer'});
    const tool = actions.tools(config).find(t => t.name === 'open_app');
    assert.match(tool.description, /What these apps do: jibotube pro: Plays YouTube videos on Jibo's screen\. Call it without saying anything first/);
    assert.doesNotMatch(tool.description, /calls:|stars:/, 'only apps with a text');
    assert.doesNotMatch(actions.tools({}).find(t => t.name === 'open_app').description, /What these apps do/);
    assert.equal(actions.plan('open_app', '{"name":"jibotube pro"}', config).target, '@be/jibotube');
    assert.equal(actions.plan('open_app', '{"name":"jibotube pro"}', config).comeback, true, 'every app comes back');
    assert.equal(actions.plan('open_app', '{"name":"gallery"}', config).comeback, true, 'built-in apps too');
    // At most 8 apps, each text at most NOTE_MAX characters, whatever the stored file holds.
    const many = {};
    for (let i = 1; i <= 10; i++) many['app ' + String.fromCharCode(96 + i)] = {pkg: '@be/app-' + i, about: 'x'.repeat(300)};
    const long = actions.tools({openApps: many}).find(t => t.name === 'open_app').description;
    assert.equal((long.match(/app [a-j]: /g) || []).length, 8);
    assert.ok(long.length < 8 * (actions.NOTE_MAX + 12) + 300, long.length);
});

test('lines without spaces are cut to NOTE_MAX too, so Noggin never writes a line Save refuses', () => {
    const describe = require(path.join(source, 'noggin/lib/describe.js'));
    const settings = require(path.join(source, 'noggin/lib/settings.js'));
    const field = settings.SCHEMA.find(f => f.key === 'openApps');
    for (const text of ['Plays' + 'x'.repeat(200) + '.', 'Plays ' + 'word '.repeat(60), 'y'.repeat(119) + ' z'.repeat(5)]) {
        const fromReadme = actions.readmeNote('# T\n\n' + text, 'T');
        const fromAi = describe.result({output_text: JSON.stringify({line: text})}).about;
        for (const line of [fromReadme, fromAi]) {
            assert.ok(line.length <= actions.NOTE_MAX && line.endsWith('…'), line.length + ': ' + line);
            assert.equal(settings.check(field, {T: {pkg: '@be/t', about: line}}).error, undefined);
        }
    }
    assert.equal(actions.cutNote('a'.repeat(300)), 'a'.repeat(119) + '…');
    assert.equal(actions.cutNote('one two ' + 'b'.repeat(200)), 'one two…');
});

test('comeback: what the other skill says is recorded up to 2000 characters, however long it talks', () => {
    const w = fakeWorld();
    let said = null;
    comeback.watch(w.jibo, w.be, s => { said = s; }, {own: '@be/noggin', clock: w.clock, timeoutMs: 3600000});
    w.be.currentSkill = {assetPack: '@be/story'}; w.step();
    for (let i = 0; i < 5000; i++) w.jibo.tts.speak('line number ' + i + ' of a very long story.');
    w.be.currentSkill = {assetPack: '@be/idle'}; w.step(); w.step(2000);
    assert.ok(said.length <= 2000 && said.startsWith('line number 0 of'), said.length);
});
