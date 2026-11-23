// SPDX-License-Identifier: MIT
// Noggin: which petting animation Jibo plays for a touch on his head, picked as his idle skill
// picks it: the emotion system's query for the touched side (which also nudges his mood), else
// the same query made here, then a random match from his animation database (D144).
// Node 6 / Chrome 53: ES2015 only.
'use strict';

// The idle skill's queries per side, and clips to fall back on when the database finds none.
const QUERIES = {
    left: {category: 'touch', includeMeta: ['rub-left']},
    right: {category: 'touch', includeMeta: ['rub-right']},
    tickle: {category: 'laughing', includeMeta: []}
};
const FALLBACK = {left: ['rub_head_l_01', 'rub_head_l_02'], right: ['rub_head_r_01', 'rub_head_r_02'], tickle: ['laughter_01', 'laughter_02']};

// pads: the touch service's pad_state, pads 0-2 on Jibo's left, 3-5 on his right; the back pad
// (5) alone is a tickle. 'left', 'right', 'tickle' or null when no pad is touched.
function side(pads) {
    if (!pads || typeof pads.length !== 'number') return null;
    const on = i => !!pads[i];
    if (on(5) && !on(0) && !on(1) && !on(2) && !on(3) && !on(4) && !on(6)) return 'tickle';
    if (on(3) || on(4) || on(5)) return 'right';
    if (on(0) || on(1) || on(2)) return 'left';
    return null;
}
function query(jibo, pads, where) {
    let asked = null;
    const emotion = jibo.emotion;
    try { if (emotion && typeof emotion.reactToHeadTouch === 'function') asked = emotion.reactToHeadTouch(pads); } catch (_) { asked = null; }
    const own = QUERIES[where];
    return {category: asked && asked.category || own.category,
        includeMeta: (asked && Array.isArray(asked.includeMeta) ? asked.includeMeta : own.includeMeta).slice()};
}
// {side, name, query} for a touch, or null when no pad is touched. random() in [0, 1).
function clipFor(jibo, pads, random) {
    const where = side(pads);
    if (!where) return null;
    const q = query(jibo, pads, where);
    let names = [];
    try {
        // A copy: the database's query fills in its defaults on the object it is given.
        const animDB = jibo.animDB, found = animDB && typeof animDB.query === 'function' ? animDB.query({category: q.category, includeMeta: q.includeMeta.slice()}) : null;
        names = (found && Array.isArray(found.matching) ? found.matching : []).map(anim => anim && anim.name).filter(name => typeof name === 'string' && name);
    } catch (_) { names = []; }
    if (!names.length) names = FALLBACK[where];
    const r = (random || Math.random)();
    const name = names[Math.min(names.length - 1, Math.max(0, Math.floor(r * names.length)))];
    return {side: where, name: name, query: q.category + (q.includeMeta.length ? '/' + q.includeMeta.join(',') : '')};
}

module.exports = {side, clipFor, FALLBACK};
