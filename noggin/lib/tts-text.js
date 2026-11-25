// SPDX-License-Identifier: MIT
// Noggin: a reply's text as Jibo's speech: sentences and pieces, plain words for his TTS, ESML
// tags for an animation or an emoji at a word, and the stop phrases that end a conversation.
// Pure: no I/O. Node 6 / Chrome 53: ES2015 only.
'use strict';

// Where the first complete sentence of `text` ends (after its punctuation), or -1. A
// sentence end is . ! ? or an ellipsis, optionally closing quotes/brackets, then space.
function firstSentenceEnd(text) {
    const match = /[.!?…]+["'’”)\]]*\s/.exec(text);
    return match ? match.index + match[0].length - 1 : -1;
}
// Plain words for Jibo's TTS: drop markdown, symbols that read badly and any
// bracketed markers, escape what the speech engine reads as markup. A dash becomes a
// comma and quote marks go: the TTS has no symbol for a dash, and quotes upset its
// word timings, which speech's gestures and emoji follow.
// In Dutch, "3-5" is "3 tot 5".
function speechText(text, language) {
    return String(text).replace(/```[\s\S]*?```/g, ' ').replace(/\[[a-z]{2,12}\]/gi, ' ').replace(/[*`#_~|\\{}]/g, '')
        .replace(/(\d)\s*[–—]\s*(\d)/g, language === 'nl' ? '$1 tot $2' : '$1 to $2').replace(/\s*[–—]+\s*/g, ', ')
        .replace(/[“”„«»"]/g, '').replace(/[‘’]/g, "'")
        .replace(/\s+/g, ' ').replace(/,\s*(?=[,.!?;:…]|$)/g, '').replace(/^[\s,]+/, '').trim()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Text -> pieces of at most `max` characters, split after sentences, then words.
function chunks(text, max) {
    max = max || 450;
    const out = [];
    let rest = String(text).replace(/\s+/g, ' ').trim();
    while (rest.length > max) {
        const head = rest.slice(0, max);
        let cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
        if (cut < max / 3) cut = head.lastIndexOf(' ');
        if (cut < 1) cut = max - 1;
        out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
}
// One animation by name, played alongside the words that follow it.
function animEsml(name) { return /^[A-Za-z0-9_-]+$/.test(name || '') ? "<anim name='" + name + "' nonBlocking='true' endNeutral='true'/>" : ''; }
// ESML (from speechText()) with an emoji tag just before the words `said` (after `nth`
// earlier ones), so speech starts it at that word (D98); null when the words are not found or
// the name is not safe.
function emojiEsml(esmlText, said, name, nth) {
    if (!/^[A-Za-z0-9_-]+$/.test(name || '') || !said || !said.length) return null;
    // Letters include the accented ones of Dutch words ("pinguïns").
    const words = said.map(w => w.replace(/[^a-z\u00e0-\u00fc]/g, '')).filter(Boolean);
    if (!words.length) return null;
    const find = new RegExp('(^|[^A-Za-z\u00c0-\u00fc])(' + words.join('[^A-Za-z\u00c0-\u00fc]+') + ')(?![A-Za-z\u00c0-\u00fc])', 'gi');
    let match = find.exec(esmlText);
    for (let skip = nth || 0; match && skip > 0; skip--) match = find.exec(esmlText);
    if (!match) return null;
    const at = match.index + match[1].length;
    return esmlText.slice(0, at) + "<es name='" + name + "' nonBlocking='true'/>" + esmlText.slice(at);
}

// Stop phrases, as BEam's Agent Mode recognises them (BSD-3, @be/be skills/agent/runtime.js), and
// their Dutch counterparts, heard in either language (D173). Not "dag" alone: it is also hello.
const STOP = ['stop', 'stop chatting', 'stop talking', 'end conversation', 'cancel', 'goodbye', 'good bye', 'bye', 'bye bye', 'that is all', 'thats all',
    'doei', 'doei doei', 'doeg', 'dag dag', 'tot ziens', 'tot later', 'tot straks', 'stoppen', 'hou op', 'houd op', 'stop met praten',
    'einde gesprek', 'dat was het', 'dat was alles', 'dat is alles', 'laat maar'];
function isStop(text) {
    if (typeof text !== 'string') return false;
    let normalized = text.toLowerCase().replace(/[’']/g, '').replace(/[-_]/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    normalized = normalized.replace(/^(?:okay|ok|oke|alright|well|nou|goed) /, '').replace(/^(?:hey |hoi )?jibo /, '').replace(/ jibo$/, '')
        .replace(/ (?:then|now|for now|dan|nu|hoor|voor nu)$/, '');
    return STOP.indexOf(normalized) >= 0;
}

module.exports = {firstSentenceEnd, speechText, chunks, animEsml, emojiEsml, isStop};
