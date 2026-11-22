// SPDX-License-Identifier: MIT
// Noggin: what the realtime model is told. The session settings (audio format, transcription and
// its language hint, tools), the instructions (persona, this voice setup, memory), and the notes
// after a handover or a dropped connection. Pure: no I/O. Node 6 / Chrome 53: ES2015 only.
'use strict';
const actions = require('./actions'), RATE = require('./audio').RATE;

// The transcript is for the log and stop phrases; the hint stops "Jibo" becoming "Thibaut".
const TRANSCRIBE_HINT = 'A person talking to Jibo, a small social robot.';
// The languages the settings page offers as hints, by their ISO 639-1 code.
const LANGUAGES = [{value: 'en', label: 'English'}, {value: 'nl', label: 'Dutch'}];
// Only these models take a `languages` list; others get no hint rather than a refused session (D109).
const LANGUAGE_MODELS = /^gpt-(live-)?transcribe(-|$)/;
function transcription(config) {
    const out = {model: config.transcribeModel, prompt: TRANSCRIBE_HINT};
    const known = LANGUAGES.map(l => l.value);
    const wanted = Array.isArray(config.transcribeLanguages) ? config.transcribeLanguages.filter(code => known.indexOf(code) >= 0) : [];
    if (wanted.length && LANGUAGE_MODELS.test(String(config.transcribeModel || ''))) out.languages = wanted;
    return out;
}
// session.update for text-out voice turns (GA realtime schema).
// `tools`: the function tools Noggin offers (lib/actions.js), or none.
function sessionUpdate(config, instructions, tools) {
    const session = {
        type: 'realtime',
        output_modalities: ['text'],
        instructions: instructions,
        audio: {input: {
            format: {type: 'audio/pcm', rate: RATE},
            transcription: transcription(config),
            turn_detection: {type: config.turnDetection}
        }}
    };
    if (tools && tools.length) { session.tools = tools; session.tool_choice = 'auto'; }
    return {type: 'session.update', session: session};
}
function textDelta(event) {
    return event && (event.type === 'response.output_text.delta' || event.type === 'response.text.delta') ? String(event.delta || '') : null;
}

// The persona as the person wrote it (SOUL, then IDENTITY); voiceSetup() adds what is true in
// this voice conversation after it.
function personaText(soul, identity) {
    const parts = [soul, identity].map(text => String(text || '').trim()).filter(Boolean);
    return parts.join('\n\n') || 'You are Jibo, the little social robot: curious, warm, playful and a bit silly.';
}
// now: a Date or actions.localTime() (Jibo's home timezone). abilities: null (no tools) or
// {apps: [names], config} when Noggin offers its tools (lib/actions.js); config's cloudSkills
// says which cloud tools are named. memory: null (off) or {learn, block}: block (lib/memory.js)
// goes after everything else and stays the same all session, so the prompt cache keeps it (D44).
// The memory sentences of the setup: what Jibo's notes are, how they grow, and which tools he has.
function memoryNotes(memory, tools) {
    let text = 'Your memory is the notes after this setup; never claim to remember something that is not in them. ';
    if (memory.learn) text += 'After each conversation you keep a short note of it and the facts worth keeping, so what people tell you stays with you. ';
    if (tools) text += 'When someone asks you to remember or forget something, use remember or forget; for an earlier conversation your notes do not cover, use recall. ';
    else if (!memory.learn) text += 'You cannot keep anything new yourself. ';
    return text;
}
function voiceSetup(now, abilities, memory) {
    const at = actions.describeTime(now);
    const memoryTools = !!(memory && abilities && abilities.config && abilities.config.memory === true);
    const notes = memory ? memoryNotes(memory, memoryTools) : '';
    const none = memory ? 'tools or files: never claim to look something up or do something you cannot. '
        : 'tools, files or saved memory: never claim to look something up, remember something for later, or do something you cannot. ';
    // Which tools, and who speaks for each, come from the tool table (lib/actions.js).
    const tools = abilities
        ? actions.rules(abilities.config) +
          'Never say something is done unless a tool result says so. For the time or date, always use get_time; ' +
          'for a question about yourself that the facts above do not answer, use about_jibo. ' + notes +
          'Apart from these you have no ' + none
        : notes + 'You cannot see the room yet, and in this voice mode you have no ' + none;
    return 'Your current setup:\n' +
        'You are in a spoken conversation on your physical Jibo body. You hear your person through your microphone, ' +
        'and every word you write is spoken aloud in your own voice, so write only words meant to be heard: ' +
        'no markdown, lists, emoji, bracketed markers or stage directions. Your face and body react on their own while you speak. ' +
        'Keep replies short, as your personality says. ' +
        'You understand English and Dutch; always answer in English. ' +
        (abilities ? 'You cannot see the room yet. ' : '') + tools +
        'When the session started it was ' + at.date + ', ' + at.time + ' local time on the robot (the clock may be off if Jibo was offline). ' +
        'Your person ends the conversation by saying goodbye.';
}
function instructions(soul, identity, now, abilities, memory) {
    return personaText(soul, identity) + '\n\n' + voiceSetup(now, abilities, memory) + (memory && memory.block ? '\n\n' + memory.block : '');
}

// The conversation so far as "Person:" / "Jibo:" lines, the last 6,000 characters.
function pairsText(pairs) {
    return (pairs || []).map(p => (p.you ? 'Person: ' + p.you + '\n' : '') + (p.jibo ? 'Jibo: ' + p.jibo : '')).join('\n').slice(-6000);
}
// Back in Noggin after another skill did something: one system message with the conversation so
// far, what happened and, for the clock, what is true now, so the model carries on from there.
// resume: {pairs: [{you, jibo}], tool, args, said}; clock: actions.readClock() result or null.
// said: what Jibo already said on coming back (e.g. "Anything else?"), or '' to let the model speak.
function resumeNote(resume, clock, said) {
    const lines = pairsText(resume.pairs);
    const args = resume.args || {}, tool = String(resume.tool || 'a tool');
    const timer = /_timer$|^check_clock$/.test(tool), alarm = /_alarm$|^check_clock$/.test(tool);
    const did = tool === 'get_time' ? 'get_time (the ' + (args.show === 'date' ? 'date' : 'time') + ')'
        : tool === 'set_timer' ? 'set_timer for ' + (args.duration || 'the time asked')
        : tool === 'set_alarm' ? 'set_alarm for ' + (args.time || 'the time asked')
        : (tool === 'use_skill' || tool === 'open_app') && args.name ? tool + ' (' + args.name + ')'
        : tool === 'picture' && args.subject ? 'picture (of ' + args.subject + ')' : tool;
    const who = timer || alarm || tool === 'get_time' ? 'your clock' : actions.CLOUD[tool] ? 'your cloud' : tool === 'open_app' ? 'that app' : 'that skill', Who = who.charAt(0).toUpperCase() + who.slice(1);
    let now = '';
    if (timer && clock && clock.timer) now += clock.timer.set ? 'A timer is now running with ' + clock.timer.remaining + ' left. ' : 'No timer is running now. ';
    if (alarm && clock && clock.alarm) now += clock.alarm.set ? 'Your alarm is now set for ' + clock.alarm.time + ', ' + clock.alarm.day + '. ' : 'No alarm is set now. ';
    return 'This is the conversation so far, in which you are Jibo:\n' + (lines || '(nothing yet)') + '\n\n' +
        'Then you used ' + did + ' and ' + who + ' took over. ' +
        (resume.said ? Who + ' said: "' + String(resume.said).slice(0, 600) + '". ' : '') + now +
        (said
            ? 'Now you are back in the conversation and have just said: "' + said + '". Wait for your person\'s answer; ' +
              'do not repeat what ' + who + ' already said, and do not claim anything the facts above do not show.'
            : 'Now you are back in the conversation. Continue in one short sentence, for example by asking whether there is anything else; ' +
              'do not repeat what ' + who + ' already said, and do not claim anything the facts above do not show.');
}

// After a dropped connection (D73): the new session hears the conversation so far, once.
function reconnectNote(pairs) {
    const lines = pairsText(pairs);
    return 'The connection dropped for a moment and is back. This is the conversation so far, in which you are Jibo:\n' + (lines || '(nothing yet)') +
        '\n\nCarry on from there: do not greet again and do not mention the connection unless asked.';
}

module.exports = {LANGUAGES, transcription, sessionUpdate, textDelta, personaText, voiceSetup, instructions, resumeNote, reconnectNote};
