// SPDX-License-Identifier: MIT
// Noggin: the skills and apps Noggin can open. Jibo's own skills by package, the built-in apps,
// skills and games the tools open (lib/actions.js), the extra apps of the `openApps` setting, and
// the settings page's suggestions from BEacon's list of custom skills. Pure: no I/O.
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const strings = require('./text');

const OWN = require('../package.json').name;
const CLOCK = '@be/clock', NIMBUS = '@be/nimbus', IDLE = '@be/idle';
const PACKAGE = /^(@[a-z0-9-]+\/)?[a-z0-9._-]+$/;
// The `openApps` setting: a spoken name and a scoped package per extra app, at most MAX_APPS (D32).
const APP_NAME = /^[A-Za-z][A-Za-z0-9 ]{0,31}$/;
const APP_PACKAGE = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;
const MAX_APPS = 8;
// What an extra app does, for the model (D39): one short line each.
const NOTE_MAX = 120;
const MAX_FOUND = 50;

// Redirect options: the NLU result a skill's launch would get from the cloud. The domain is the
// bare skill name, as the main menu sends it (@be/clock refuses '@be/clock'). skipSurprises:
// when the skill is done Jibo goes straight back to idle.
function launch(intent, domain, entities) {
    return {nlu: {intent: intent, entities: Object.assign(domain ? {domain: domain} : {}, entities || {})}, match: {skipSurprises: true}};
}

// Jibo's built-in apps for open_app; Noggin comes back when the app is done (D38).
const APPS = {
    clock: {pkg: CLOCK, options: launch('menu', 'clock')},
    settings: {pkg: '@be/settings', options: launch('menu', 'settings')},
    menu: {pkg: '@be/main-menu', options: launch('menu', 'main-menu')},
    gallery: {pkg: '@be/gallery', options: launch('menu', 'gallery')},
    // @be/exercise reads intent and entities from the top level of its options, not from nlu.
    yoga: {pkg: '@be/exercise', options: Object.assign(launch('exerciseDoYoga', 'exercise'), {intent: 'exerciseDoYoga', entities: {}})},
    // @be/introductions reads nlu.entities without a check: it must be there.
    'meet someone new': {pkg: '@be/introductions', options: launch('enrollment', 'introductions')}
};
// Jibo's skills for use_skill: each speaks, ends by itself within a minute or two, and Noggin
// comes back afterwards.
const SKILLS = {
    'take a photo': {pkg: '@be/create', options: launch('createOnePhoto', 'create')},
    'photo booth': {pkg: '@be/create', options: launch('createSomePhotos', 'create')},
    'sing daisy bell': {pkg: '@be/daisy-bell', options: launch('sing', 'daisy-bell')},
    'who am i': {pkg: '@be/who-am-i', options: launch('launchWhoAmI', 'who-am-i')}
};
// Jibo's games for play_game: a tool of their own, so the Games switch can turn them off (D185).
// Circuit Saver ignores its options and ends by itself when the game is over.
const GAMES = {
    'word of the day': {pkg: '@be/word-of-the-day', options: launch('play', 'word-of-the-day')},
    'circuit saver': {pkg: '@be/circuit-saver', options: launch('launchGame', 'circuit-saver')}
};

const key = strings.nameKey;
// One `openApps` entry as {pkg, about}, from a package name alone or {pkg, about}.
function appEntry(value) {
    if (typeof value === 'string') return {pkg: value, about: ''};
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.pkg !== 'string') return null;
    return {pkg: value.pkg, about: cleanNote(value.about)};
}
// A line too long for NOTE_MAX, cut at a word (or anywhere, without spaces) with "…" added.
function cutNote(text) {
    const cut = text.slice(0, NOTE_MAX - 1), word = cut.replace(/ [^ ]*$/, '');
    return (word.length < cut.length && word ? word : cut) + '…';
}
// "What it does" as one plain line: no control characters, single spaces.
function cleanNote(text) {
    return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}
// The usable extra apps, the first MAX_APPS (D32): [{name, pkg, about}], name in lower case.
function extraList(config) {
    const list = config && config.openApps, out = [], seen = {};
    if (!list || typeof list !== 'object' || Array.isArray(list)) return out;
    Object.keys(list).forEach(name => {
        const entry = appEntry(list[name]), k = key(name);
        if (!k || !entry || !PACKAGE.test(entry.pkg) || entry.pkg === OWN) return;
        if (seen[k]) { seen[k].pkg = entry.pkg; seen[k].about = entry.about.slice(0, NOTE_MAX); return; }
        if (out.length >= MAX_APPS) return;
        seen[k] = {name: k, pkg: entry.pkg, about: entry.about.slice(0, NOTE_MAX)};
        out.push(seen[k]);
    });
    return out;
}
// Extra apps from the `openApps` setting: name -> package.
function extras(config) {
    const out = {};
    extraList(config).forEach(app => { out[app.name] = app.pkg; });
    return out;
}
// Every app open_app may open: name -> package (the built-in ones, then the `openApps` setting's extras).
function all(config) {
    const out = {}, more = extras(config);
    Object.keys(APPS).forEach(name => { out[name] = APPS[name].pkg; });
    Object.keys(more).forEach(name => { out[name] = more[name]; });
    return out;
}
// What the extra apps do, for open_app's description (D39).
function notes(config) {
    const told = extraList(config).filter(app => app.about);
    return told.length ? ' What these apps do: ' + told.map(app => app.name + ': ' + app.about.replace(/[.!?\u2026]+$/, '')).join('; ') + '.' : '';
}
// A table entry's launch options, as a copy the caller may change.
function optionsOf(entry) { return JSON.parse(JSON.stringify(entry.options)); }
// The launch options for an app: a built-in app's own, or the generic launch (BEam's Agent Mode).
function openOptions(pkg) {
    const builtin = Object.keys(APPS).filter(name => APPS[name].pkg === pkg)[0];
    return builtin ? optionsOf(APPS[builtin]) : {nlu: {intent: 'menu', entities: {domain: pkg}}, match: {skipSurprises: true}};
}

// A label cut to the `openApps` name rule (D34): accents dropped, anything else a space, starting
// with a letter, at most 32 characters cut at a word. '' when nothing is left.
function spokenName(label) {
    let s = String(label || '');
    try { s = s.normalize('NFD'); } catch (_) {}
    s = strings.plainLetters(s).replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').replace(/^[^A-Za-z]+/, '').trim();
    if (s.length > 32) {
        const cut = s.slice(0, 33).replace(/ [^ ]*$/, '');
        s = (cut.length <= 32 ? cut : s.slice(0, 32)).trim();
    }
    return APP_NAME.test(s) ? s : '';
}
// A README's first plain paragraph, without its markdown: lines up to the first heading, list,
// code block or blank line after some prose.
function firstParagraph(readme) {
    const lines = String(readme || '').slice(0, 20000).split(/\r?\n/), paragraph = [];
    let code = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^(```|~~~)/.test(line)) { code = !code; if (paragraph.length) break; continue; }
        if (code) continue;
        // A heading underlined with === or --- is not prose either.
        const underlined = i + 1 < lines.length && /^[=-]+$/.test(lines[i + 1].trim());
        const prose = line && !underlined && !/^(#|!\[|\[!\[|<|\||>|[-*+] |\d+\. |[=-]+$)/.test(line);
        if (prose) paragraph.push(line);
        else if (paragraph.length) break;
    }
    const text = paragraph.join(' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`|\*/g, '');
    return cleanNote(text);
}
// A text in sentences, each ending at . ! or ? followed by a space or the end.
function sentencesOf(text) {
    const sentences = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ends = '.!?'.indexOf(text[i]) >= 0 && (i + 1 === text.length || text[i + 1] === ' ');
        if (ends) { sentences.push(text.slice(start, i + 1).trim()); start = i + 1; }
    }
    if (text.slice(start).trim()) sentences.push(text.slice(start).trim());
    return sentences;
}
// The start of a README as "what it does" (D39): the first plain paragraph, in whole sentences up
// to NOTE_MAX characters (a longer first sentence is cut at a word).
function readmeNote(readme, label) {
    const text = firstParagraph(readme);
    if (!text || text.toLowerCase() === String(label || '').toLowerCase()) return '';
    let note = '', full = false;
    sentencesOf(text).forEach(sentence => {
        const next = note ? note + ' ' + sentence : sentence;
        if (!full && next.length <= NOTE_MAX) note = next;
        else full = true;
    });
    return note || cutNote(text);
}
// The custom skills BEacon lists (GET /api/skills/custom) that could become extra apps, as
// [{name, pkg, label, about}] sorted by name. Left out (D37): Noggin, what Noggin already offers, what
// `openApps` already has, odd package names and skills BEacon marks incompatible.
function suggestions(inventory, config) {
    const list = inventory && Array.isArray(inventory.skills) ? inventory.skills : [];
    const openApps = config && config.openApps && typeof config.openApps === 'object' ? config.openApps : {};
    const chosen = Object.keys(openApps).map(name => appEntry(openApps[name])).filter(Boolean).map(entry => entry.pkg);
    const pkgs = table => Object.keys(table).map(name => table[name].pkg);
    const skip = [OWN].concat(pkgs(APPS), pkgs(SKILLS), pkgs(GAMES), chosen);
    const out = [];
    list.forEach(skill => {
        const pkg = skill && skill.packageName;
        if (typeof pkg !== 'string' || !APP_PACKAGE.test(pkg) || skip.indexOf(pkg) >= 0) return;
        if (skill.compatibility && skill.compatibility.status === 'incompatible') return;
        skip.push(pkg);
        const label = skill.manifest && typeof skill.manifest.name === 'string' ? skill.manifest.name.slice(0, 120) : '';
        out.push({name: spokenName(label) || spokenName(pkg.replace(/^@[^/]+\//, '')), pkg: pkg, label: label, about: readmeNote(skill.readme, label)});
    });
    const byName = (a, b) => {
        const x = a.name.toLowerCase(), y = b.name.toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
    };
    return out.sort(byName).slice(0, MAX_FOUND);
}

module.exports = {CLOCK, NIMBUS, IDLE, APPS, SKILLS, GAMES, APP_NAME, APP_PACKAGE, MAX_APPS, NOTE_MAX,
    launch, appEntry, cleanNote, cutNote, extras, all, notes, optionsOf, openOptions, spokenName, readmeNote, suggestions};
