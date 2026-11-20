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
const openai = require('./lib/openai'), core = require('./lib/core'), ConversationLog = require('./lib/conversation-log');
const actions = require('./lib/actions'), comeback = require('./lib/comeback'), createLog = require('./lib/log');
const memory = require('./lib/memory'), recap = require('./lib/recap'), trouble = require('./lib/trouble'), budget = require('./lib/budget');
const SetupScreen = require('./lib/setup-screen');
const fs = require('fs');
const OWN = require('./package.json').name, VERSION = require('./package.json').version;
const RESUME_MS = 15000;
// After any handover the other skill (or @be/nimbus for the cloud) takes over within seconds; if
// none has by then, the comeback gives up, so a later unrelated skill never brings Noggin back.
const LEAVE_MS = 30000;
// Survives the skill's close (a skill switch closes a skill, it does not destroy it).
let resume = null, watcher = null;
const cloudTurn = require('./lib/cloud-turn').create(jibo, () => require('jibo-embodied-dialog'));
function stopWatching() { if (watcher) { const w = watcher; watcher = null; w.cancel(); } }

class Noggin extends BeSkill {
    open() {
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
        Promise.resolve().then(() => this.talk(settings.dataDir(), back, openedAt, startup)).then(reason => {
            if (current()) log.info('conversation ended: ' + reason);
        }, error => {
            if (current()) log.error('conversation failed: ' + (error && error.stack || error));
        }).then(() => {
            recap.nudge();
            if (current()) this.exit({noElementsOfSurprise: true});
        });
    }
    // Opened from the menu, the menu view would stay; the emoji needs Jibo's eye (at most 1.5 s).
    eye() {
        const views = jibo.face && jibo.face.views;
        if (!views || typeof views.forceEyeView !== 'function') return Promise.resolve();
        return Promise.race([new Promise(resolve => { try { views.forceEyeView(() => resolve()); } catch (_) { resolve(); } }),
            new Promise(resolve => setTimeout(resolve, 1500))]);
    }
    // anim: an eye emoji played with the words (D70).
    say(text, anim) {
        const speech = jibo.embodied && jibo.embodied.speech;
        return speech && speech.speak ? Promise.resolve(speech.speak((anim ? core.animEsml(anim) : '') + core.speechText(text))).catch(() => {}) : Promise.resolve();
    }
    talk(dataDir, back, openedAt, startup) {
        const generation = this.generation;
        let config;
        try { config = settings.read(dataDir); }
        catch (error) {
            this.tagged.error(error.message);
            const t = trouble.cause(error.message === 'no_key' ? 'no_key' : 'settings');
            // Closed while Jibo spoke (a swipe, "Hey Jibo"): no screen for a skill that is gone.
            return this.eye().then(() => this.say(t.line, t.emoji)).then(() => generation === this.generation ? this.setup(t, dataDir, generation) : 'closed');
        }
        const persona = settings.persona(dataDir), log = new ConversationLog(dataDir, config.log !== false, {recap: !!(config.memory && config.memoryLearn)});
        // On the robot the microphone runs as a separate arecord process: an ALSA failure
        // inside BE's own process would take Jibo's face and body down with it.
        let session = null;
        const mic = Microphone.choose(config) === 'arecord'
            ? new Microphone.ProcessMicrophone({device: config.micDevice, onExit: report => session && session.onMicExit(report)})
            : new Microphone(jibo, {onTrack: name => log.write({kind: 'microphone_track', event: name})});
        const abilities = config.actions ? {apps: Object.keys(actions.apps(config)), config: config} : null;
        const notes = this.memoryNotes(dataDir, config, back, log, openedAt);
        const instructions = core.instructions(persona.soul, persona.identity, actions.localTime(jibo), abilities, notes);
        session = this.session = new Conversation({
            jibo: jibo, config: config, log: log, version: VERSION,
            instructions: instructions,
            persona: {edited: Object.keys(persona.edited).filter(name => persona.edited[name]), chars: instructions.length, facts: persona.facts.length,
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
            if (how === 'timeout') return this.eye().then(() => this.say(trouble.LINES.later)).then(() => 'setup_timeout');
            if (how !== 'saved') return 'setup_' + how;
            return this.eye().then(() => this.say(trouble.LINES.ready, 'Emoji_Checkmark')).then(() => generation === this.generation ? this.talk(dataDir, null, Date.now(), {after_setup: true}) : 'setup_saved');
        });
    }
    // What Jibo remembers, for the end of the instructions (D44): null when memory is off or
    // cannot be read. After a handover the comeback carries the conversation, so no tail (D52).
    memoryNotes(dataDir, config, back, log, openedAt) {
        if (!config.memory) return null;
        try {
            if (config.memoryLearn) recap.start(dataDir, openedAt);
            const state = memory.read(dataDir), today = memory.dayOf(actions.localTime(jibo));
            const tail = back ? '' : recap.tail(dataDir, state, Date.now(), log.file);
            return {learn: config.memoryLearn !== false, block: memory.block(state, today, tail)};
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
    close(done) {
        this.generation = (this.generation || 0) + 1;
        const session = this.session; this.session = null;
        const screen = this.screen; this.screen = null;
        Promise.all([session && session.close('closed'), screen && screen.close()]).then(() => done && done(), () => done && done());
    }
    destroy(done) { this.close(done); }
}
// settings.json's size and time: a save changes it ('' when there is none yet).
function stamp(file) {
    try { const st = fs.statSync(file); return st.size + ':' + st.mtime.getTime(); } catch (_) { return ''; }
}
module.exports = Noggin;
