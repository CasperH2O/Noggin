// SPDX-License-Identifier: MIT
// The models the settings page offers for each job. `verified` are the ones Noggin was tested
// with, one marked recommended; `looksLike` picks, from the models OpenAI lists for the saved
// key, the ones worth trying for that job (the page shows them as unverified).
// Node 6: ES2015 only.
'use strict';

const ROLES = {
    conversation: {
        verified: [
            {id: 'gpt-realtime-2.1', recommended: true},
            {id: 'gpt-realtime-2.1-mini'}
        ],
        looksLike: /^gpt-realtime(-[0-9.]+)?(-mini)?$/
    },
    transcription: {
        verified: [
            {id: 'gpt-transcribe', recommended: true},
            {id: 'gpt-live-transcribe'}
        ],
        looksLike: /^gpt-(live-)?transcribe$/
    },
    // A decision model: the Decisions API picks the expression.
    expression: {
        verified: [
            {id: 'gpt-6-luna', recommended: true, note: 'decision model'}
        ],
        looksLike: /^gpt-[0-9.]+-(luna|sol|terra|astra|mini|nano)$/
    },
    helper: {
        verified: [
            {id: 'gpt-6-luna', recommended: true}
        ],
        looksLike: /^gpt-[0-9.]+-(luna|sol|terra|astra|mini|nano)$/
    }
};

function verified(role) {
    return ROLES[role] ? ROLES[role].verified.map(m => Object.assign({}, m)) : [];
}

// A list of {id, shutdown} (shutdown: 'YYYY-MM-DD' or null) from GET /models, for the page:
// `available` is every model the key sees with its shutdown date, `others` per job the unverified
// models that look right for it. A model with an announced shutdown is never suggested.
function view(list) {
    const available = {}, others = {};
    list.forEach(m => { available[m.id] = m.shutdown || null; });
    Object.keys(ROLES).forEach(role => {
        const known = ROLES[role].verified.map(m => m.id);
        others[role] = list.filter(m => !m.shutdown && ROLES[role].looksLike.test(m.id) && known.indexOf(m.id) < 0)
            .map(m => m.id).sort();
    });
    return {available: available, others: others};
}

// The Models endpoint's answer -> [{id, shutdown}]; null when it is not a list.
function parseList(json) {
    if (!json || !Array.isArray(json.data)) return null;
    return json.data.filter(m => m && typeof m.id === 'string')
        .map(m => ({id: m.id, shutdown: typeof m.shutdown_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.shutdown_date) ? m.shutdown_date : null}));
}

module.exports = {ROLES, verified, view, parseList};
