// SPDX-License-Identifier: MIT
// Noggin: opening the skill starts a voice conversation with Jibo (lib/controller.js). Swipe
// down, say goodbye or stay quiet to end. When the conversation hands an action to another
// skill (a timer on @be/clock, or Jibo's cloud through @be/nimbus), Noggin watches for that
// skill to finish and opens again with the conversation so far (lib/comeback.js).
// When Noggin cannot talk, Jibo says why; without a working key or with broken settings he
// shows a QR code to his settings page and starts talking once it is saved (lib/setup-screen.js).
// The settings page runs separately, in background.js.
'use strict';
const BeSkill = require('@be/be-framework').BeSkill;
const jibo = require('jibo');
const settings = require('./lib/settings'), Conversation = require('./lib/controller'), Microphone = require('./lib/mic');
const openai = require('./lib/openai'), ttsText = require('./lib/tts-text'), realtime = require('./lib/realtime-session'), ConversationLog = require('./lib/conversation-log');
const actions = require('./lib/actions'), comeback = require('./lib/comeback'), createLog = require('./lib/log');
const memory = require('./lib/memory'), recap = require('./lib/recap'), trouble = require('./lib/trouble'), budget = require('./lib/budget');
const SetupScreen = require('./lib/setup-screen'), ExpressionPlayer = require('./lib/expression'), heyJibo = require('./lib/hey-jibo');
const voice = require('./lib/voice'), lines = require('./lib/lines');
const fs = require('fs');
const OWN = require('./package.json').name, VERSION = require('./package.json').version;
const RESUME_MS = 15000;
const SAY_MS = 20000;   // the longest a trouble or setup line may take
// After any handover the other skill (or @be/nimbus for the cloud) takes over within seconds; if
// none has by then, the comeback gives up, so a later unrelated skill never brings Noggin back.
const LEAVE_MS = 30000;
// Survives the skill's close (a skill switch closes a skill, it does not destroy it).
let resume = null, watcher = null;
const cloudTurn = require('./lib/cloud-turn').create(jibo);
function stopWatching() { if (watcher) { const w = watcher; watcher = null; w.cancel(); } }

class Noggin extends BeSkill {
    // result: what opened the skill; "Hey Jibo" through background.js is recognised (D132).
    open(result) {
        const generation = this.generation = (this.generation || 0) + 1;
        const current = () => generation === this.generation;
        const log = this.tagged = this.tagged || createLog(this.log);
        // Startup timing starts here (lib/controller.js logs it as `startup`).
        const openedAt = Date.now();
        // Coming back from another skill: carry on with that conversation.
        const back = resume && openedAt - resume.at < RESUME_MS ? resume : null;
        resume = null; stopWatching();
        const startup = {};
        if (back) startup.since_comeback_ms = openedAt - back.at;
        const hey = heyJibo.fromResult(result);
        if (hey) startup.since_hey_jibo_ms = openedAt - hey.heardAt;
        // A voice launch while Noggin is open makes Be call open() again without close() (D160).
        const released = this.release();
        // Closed while the old conversation was still ending: start nothing (D166).
        released.then(() => {
            if (!current()) return 'closed';
            settings.adoptOldData(log);
            return this.talk(settings.dataDir(), back, openedAt, startup, hey);
        }).then(reason => {
            if (current()) log.info('conversation ended: ' + reason);
        }, error => {
            if (current()) log.error('conversation failed: ' + (error && error.stack || error));
        }).then(() => {
            recap.nudge();
            if (current()) this.exit({noElementsOfSurprise: true});
        });
    }
    // Opened from the menu, the menu view would stay; the emoji needs Jibo's eye.
    eye() { return ExpressionPlayer.showEye(jibo); }
    // anim: an eye emoji played with the words (D70). Stopped after SAY_MS, as a conversation line (D114).
    // key: a line of lib/lines.js, said in `language`; Dutch through the Dutch voice, and in
    // English when that voice refuses it, but never once the line's time is up (D172, D175).
    say(key, anim, language) {
        const speech = jibo.embodied && jibo.embodied.speech;
        if (!speech || !speech.speak) return Promise.resolve();
        // A stop after this open() was closed would cut the next skill's speech.
        const generation = this.generation;
        let timer = null, over = false;
        const current = () => !over && generation === this.generation;
        const tag = anim ? ttsText.animEsml(anim) : '';
        const english = () => current() ? speech.speak(tag + ttsText.speechText(lines.say(key, 'en'))) : null;
        const dutch = () => {
            const dutchVoice = this.dutchSay = voice.create();
            const done = () => { if (this.dutchSay === dutchVoice) this.dutchSay = null; };
            return dutchVoice.speak(() => speech.speak(tag + ttsText.speechText(lines.say(key, 'nl'), 'nl'), {}, {hotWords: false}), SAY_MS)
                .then(done, error => {
                    done();
                    if (!voice.refused(error)) return null;
                    this.tagged.warn('Dutch line not said: ' + String(error && error.message || error).slice(0, 60));
                    return english();
                });
        };
        const spoken = Promise.resolve().then(language === 'nl' ? dutch : english).catch(() => {});
        const late = new Promise(resolve => {
            timer = setTimeout(() => {
                over = true;
                try { if (speech.stop && generation === this.generation) speech.stop(); } catch (_) {}
                resolve();
            }, SAY_MS);
        });
        return Promise.race([spoken, late]).then(() => { over = true; clearTimeout(timer); });
    }
    // The language the skill's own lines are said in: the setting, while the Dutch voice is ready.
    language(dataDir) { return voice.create().choose(settings.load(dataDir).config.language).language; }
    // hey: {heardAt} when "Hey Jibo" opened Noggin (lib/hey-jibo.js), else null.
    talk(dataDir, back, openedAt, startup, hey) {
        const generation = this.generation;
        let config;
        try { config = settings.read(dataDir); }
        catch (error) {
            this.tagged.error(error.message);
            const t = trouble.cause(error.message === 'no_key' ? 'no_key' : 'settings');
            // Closed while Jibo spoke (a swipe, "Hey Jibo"): no screen for a skill that is gone.
            return this.eye().then(() => this.say('trouble.' + t.cause, t.emoji, this.language(dataDir))).then(() => generation === this.generation ? this.setup(t, dataDir, generation) : 'closed');
        }
        const persona = settings.persona(dataDir), log = new ConversationLog(dataDir, config.log !== false, {recap: !!(config.memory && config.memoryLearn)});
        // On the robot the microphone runs as a separate arecord process: an ALSA failure
        // inside BE's own process would take Jibo's face and body down with it.
        let session = null;
        const mic = Microphone.choose(config) === 'arecord'
            ? new Microphone.ProcessMicrophone({device: config.micDevice, onExit: report => session && session.onMicExit(report)})
            : new Microphone(jibo, {onTrack: name => log.write({kind: 'microphone_track', event: name})});
        const notes = this.memoryNotes(dataDir, config, back, log, openedAt);
        // Chosen once: the instructions and the conversation start in the same language (D172).
        const speechVoice = voice.create(), language = speechVoice.choose(config.language);
        const instructions = realtime.forConfig(config, persona, notes, language.language);
        const note = realtime.sessionNote(actions.localTime(jibo), notes);
        session = this.session = new Conversation({
            jibo: jibo, config: config, log: log, version: VERSION, voice: speechVoice, language: language,
            instructions: instructions, sessionNote: note,
            persona: {edited: Object.keys(persona.edited).filter(name => persona.edited[name]), chars: instructions.length, note_chars: note.length, facts: persona.facts.length,
                memory: notes ? notes.block.length : null},
            connect: () => openai.connect(config),
            mic: mic,
            classify: config.expressions ? openai.classifier(config) : null,
            actions: config.actions ? {
                redirect: (pkg, options) => this.redirect(pkg, options),
                cloud: phrase => cloudTurn.ask(phrase, entry => log.write(entry)),
                handover: state => this.watchHandover(state, config, log),
                handoverFailed: () => { stopWatching(); cloudTurn.release(); },
                readClock: () => actions.readClock(jibo),
                setVolume: args => actions.setVolume(jibo, args),
                installed: pkg => actions.installed(name => require.resolve(name), pkg),
                localTime: () => actions.localTime(jibo),
                facts: () => persona.facts,
                memory: config.memory ? args => memory.tool(dataDir, args, memory.dayOf(actions.localTime(jibo))) : null
            } : null,
            resume: back,
            heyJibo: hey || null,
            openedAt: openedAt,
            startup: startup,
            diagnose: () => trouble.diagnose(config, openai.asker(config), {stopped: () => this.session !== session}),
            notice: back ? null : budget.notice(memory.dayOf(actions.localTime(jibo)), config.budgetWarnPercent)
        });
        return session.open().then(reason => {
            if (this.session === session) this.session = null;
            // The conversation already said why; some causes also need the settings page.
            const t = /^trouble_/.test(reason) ? trouble.cause(reason.slice('trouble_'.length)) : null;
            return t && t.screen && generation === this.generation ? this.setup(t, dataDir, generation) : reason;
        });
    }
    // The QR code to the settings page (D72). Ends on swipe, tap or 3 minutes; once the settings
    // change and now work, Jibo says so and the conversation starts.
    // generation: the open() this belongs to; a later close() or open() makes it stale.
    setup(t, dataDir, generation) {
        const file = settings.file(dataDir), before = stamp(file);
        const screen = this.screen = new SetupScreen(jibo, {
            log: this.tagged,
            ready: () => {
                if (stamp(file) === before) return false;
                try { settings.read(dataDir); return true; } catch (_) { return false; }
            }
        });
        const address = trouble.lanAddress(trouble.interfaces());
        this.tagged.info('setup screen: ' + t.cause + (address ? '' : ' (no address)'));
        return screen.show(t, address).then(how => {
            if (this.screen === screen) this.screen = null;
            this.tagged.info('setup screen ended: ' + how);
            if (generation !== this.generation) return 'setup_' + how;
            const language = this.language(dataDir);
            if (how === 'timeout') return this.eye().then(() => this.say('later', null, language)).then(() => 'setup_timeout');
            if (how !== 'saved') return 'setup_' + how;
            return this.eye().then(() => this.say('ready', 'Emoji_Checkmark', language)).then(() => generation === this.generation ? this.talk(dataDir, null, Date.now(), {after_setup: true}) : 'setup_saved');
        });
    }
    // What Jibo remembers, for the session note (D44, D181): null when memory is off or
    // cannot be read. After a handover the comeback carries the conversation, so no tail (D52).
    memoryNotes(dataDir, config, back, log, openedAt) {
        if (!config.memory) return null;
        try {
            if (config.memoryLearn) recap.start(dataDir, openedAt);
            const state = memory.read(dataDir), today = memory.dayOf(actions.localTime(jibo));
            const tail = back ? '' : recap.tail(dataDir, state, Date.now(), log.file);
            return realtime.memorySetup(config, memory.block(state, today, tail, config.presence !== false));
        } catch (error) {
            this.tagged.warn('memory left out: ' + error.message);
            return null;
        }
    }
    // The conversation handed an action to another skill: when it is done and Jibo is idle and
    // quiet, open Noggin again (open() above picks up `resume`). Music and radio do not come back.
    watchHandover(state, config, log) {
        stopWatching();
        if (!state.comeback) return;
        const started = Date.now();
        const w = watcher = comeback.watch(jibo, global.be, said => {
            if (watcher === w) watcher = null;
            cloudTurn.used();
            log.write({kind: 'comeback', ok: true, said: said.slice(0, 300), ms: Date.now() - started});
            resume = {at: Date.now(), pairs: state.pairs, tool: state.tool, args: state.args, said: said};
            if (!comeback.relaunch(jibo, OWN)) { resume = null; log.write({kind: 'comeback', ok: false, reason: 'no_relaunch'}); }
        }, {own: OWN, timeoutMs: config.comebackMinutes * 60000, leaveMs: LEAVE_MS, onGiveUp: (reason, ms) => {
            if (watcher === w) watcher = null;
            cloudTurn.release();
            log.write({kind: 'comeback', ok: false, reason: reason, ms: ms});
            recap.nudge();
        }});
    }
    // Closes the conversation or setup screen that is still up; resolves once both are gone.
    release() {
        const session = this.session; this.session = null;
        const screen = this.screen; this.screen = null;
        return Promise.all([session && session.close('closed'), screen && screen.close()]).then(() => {}, () => {});
    }
    close(done) {
        this.generation = (this.generation || 0) + 1;
        // A Dutch setup or trouble line still being said ends with the skill (D175).
        if (this.dutchSay) { this.dutchSay.cancel(); this.dutchSay = null; }
        this.release().then(() => done && done());
    }
    // Removal: a comeback still waiting would outlive the skill (D162).
    destroy(done) { stopWatching(); resume = null; this.close(done); }
}
// settings.json's size and time: a save changes it ('' when there is none yet).
function stamp(file) {
    try { const st = fs.statSync(file); return st.size + ':' + st.mtime.getTime(); } catch (_) { return ''; }
}
module.exports = Noggin;
