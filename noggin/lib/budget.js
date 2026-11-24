// SPDX-License-Identifier: MIT
// Noggin: the budget heads-up (D74). background.js asks the Usage tab's fetch (lib/usage.js,
// same cache) a while after start and then at most every EVERY_MS; the answer stays in memory on
// the shared global object (like the recap nudge, D59), where the skill reads it when a
// conversation opens. Node 6: ES2015 only.
'use strict';
const trouble = require('./trouble');

const FIRST_MS = 2 * 60000;
const EVERY_MS = 12 * 3600000;
const TICK_MS = 60000;
const HUB = 'nogginBudget';

function hub() { return global[HUB] || (global[HUB] = {state: null, warnedDay: null}); }

// Low when what is left of the spend limit is at most `percent` of it. view: usage report.
function isLow(view, percent) {
    if (!view || !view.ok || !view.budget || !(percent > 0)) return false;
    const b = view.budget;
    return b.limit > 0 && typeof b.left === 'number' && b.left <= b.limit * percent / 100;
}

// options: {readConfig() -> {budgetWarnPercent, adminKey: bool}, report() -> usage view, now, log, tickMs}.
function watch(options) {
    const now = options.now || (() => Date.now()), log = options.log || {info() {}, warn() {}};
    const started = now();
    let last = 0, running = false, stopped = false;
    function tick() {
        if (stopped || running) return;
        const t = now();
        if (t - started < FIRST_MS || last && t - last < EVERY_MS) return;
        let config = null;
        try { config = options.readConfig(); } catch (_) {}
        if (!config || !(config.budgetWarnPercent > 0) || !config.adminKey) { hub().state = null; return; }
        running = true; last = t;
        Promise.resolve().then(() => options.report()).then(view => {
            running = false;
            if (stopped) return;
            const low = isLow(view, config.budgetWarnPercent);
            hub().state = view && view.ok ? {low: low, left: view.budget.left, limit: view.budget.limit, at: t} : null;
            log.info('budget: ' + (view && view.ok ? (view.budget.limit ? view.budget.left + ' of ' + view.budget.limit + ' left' : 'no spend limit') + (low ? ', low' : '') : 'no answer (' + (view && view.state) + ')'));
        }, error => {
            running = false;
            log.warn('budget: ' + String(error && error.message || error).slice(0, 120));
        });
    }
    const timer = setInterval(tick, options.tickMs || TICK_MS);
    return {tick: tick, stop() { stopped = true; clearInterval(timer); }};
}

// For the skill: the heads-up to say after the greeting, or null; at most once per local day.
// `line` names it in lib/lines.js, so the conversation says it in its own language.
function notice(today, percent) {
    const h = global[HUB];
    if (!h || !h.state || !h.state.low || !(percent > 0) || h.warnedDay === today) return null;
    return {line: 'budget', emoji: trouble.BUDGET_EMOJI, said() { h.warnedDay = today; }};
}

module.exports = {watch, notice, isLow, hub, FIRST_MS, EVERY_MS, HUB};
