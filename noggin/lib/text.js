// SPDX-License-Identifier: MIT
// Small text and time helpers shared by the skill, the settings page's server and the recap.
// Pure: no I/O. Node 6 / Chrome 53: ES2015 only.
'use strict';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Accented Latin letters as plain ones, for runtimes whose normalize() cannot decompose
// (Node 6.9.2's small ICU). Lower case only; plainLetters() keeps a capital a capital.
const PLAIN = {ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th', ĳ: 'ij'};
const LETTERS = {a: 'àáâãäåā', c: 'çćč', e: 'èéêëēėęě', i: 'ìíîïīį', n: 'ñńň', o: 'òóôõöøō', u: 'ùúûüūů', y: 'ýÿ',
    s: 'śš', z: 'źżž', l: 'ł', d: 'ð', g: 'ğ', r: 'ř'};
Object.keys(LETTERS).forEach(plain => LETTERS[plain].split('').forEach(letter => { PLAIN[letter] = plain; }));

function capitalized(text) { return text.charAt(0).toUpperCase() + text.slice(1); }
// Accents dropped, case kept: "Łódź" -> "Lodz". Unknown letters stay as they are.
function plainLetters(text) {
    return String(text || '').replace(/[^\x00-\x7f]/g, letter => {
        const lower = letter.toLowerCase(), plain = PLAIN[lower];
        if (plain === undefined) return letter;
        return lower === letter ? plain : capitalized(plain);
    });
}
// For comparing words: lower case, accents dropped.
function fold(text) { return plainLetters(String(text || '').toLowerCase()); }

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// The Responses API's answer text: output_text, or the first output_text part of its output.
function responseText(body) {
    if (body && typeof body.output_text === 'string') return body.output_text;
    let text = null;
    if (body && Array.isArray(body.output)) {
        body.output.forEach(item => (item && item.content || []).forEach(part => {
            if (part && part.type === 'output_text' && text === null) text = part.text;
        }));
    }
    return text;
}

// Local time by this system's clock, in actions.localTime()'s shape.
function systemTime(ms) {
    const d = new Date(ms === undefined ? Date.now() : ms);
    return {year: d.getFullYear(), monthNum: d.getMonth(), date: d.getDate(), dayOfWeek: DAYS[d.getDay()], hour: d.getHours(), minute: d.getMinutes(), zone: null};
}

module.exports = {DAYS, MONTHS, plainLetters, fold, pad2, responseText, systemTime};
