// SPDX-License-Identifier: MIT
// How often and how long Jibo talks, for the Usage tab (D148), read from the conversation logs
// that are already kept (lib/conversation-log.js): when each began, how long it lasted, its turns
// and how it ended. Only the start and the end of each log are read, never the middle. Without
// logs there is nothing to count. Node 6: ES2015 only.
'use strict';
const path = require('path');
const files = require('./files'), strings = require('./text'), ConversationLog = require('./conversation-log');
const DAYS = 7, RECENT = 8, PART = 8192;

// cut: 'end' for the start of a file (its last line may be cut), 'start' for a tail, or none.
function lines(text, cut) {
    const out = [];
    text.split('\n').forEach((line, i, all) => {
        if ((cut === 'end' && i === all.length - 1) || (cut === 'start' && i === 0)) return;
        try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e); } catch (_) {}
    });
    return out;
}
const time = e => e && typeof e.t === 'string' ? Date.parse(e.t) : NaN;

// One log -> {start, end, turns, reason, resumed}, or null when it holds nothing usable.
function stretch(dir, item) {
    let first, last;
    const part = (position, length) => files.readPart(path.join(dir, item.name), position, length);
    try {
        if (item.bytes <= 2 * PART) first = last = lines(part(0, item.bytes), null);
        else { first = lines(part(0, PART), 'end'); last = lines(part(item.bytes - PART, PART), 'start'); }
    } catch (_) { return null; }
    const startup = first.filter(e => e.kind === 'startup')[0];
    let start = time(first[0]);
    if (!isFinite(start)) start = item.started;
    if (!isFinite(start)) return null;
    // Where it ended: its own end line, else the last line it wrote (Be may have died).
    const endLine = last.filter(e => e.kind === 'session_end').pop();
    let end = time(endLine || last[last.length - 1]);
    if (!isFinite(end) || end < start) end = start;
    return {start: start, end: end, turns: endLine ? Number(endLine.turns) || 0 : 0, reason: endLine && endLine.reason ? String(endLine.reason) : '', resumed: !!(startup && startup.resumed)};
}

// A finished log never changes, so a row is read again only when its log's size does (D148).
// Entries of logs that are gone are dropped, so the cache holds at most the logs kept.
let cache = {};

// Every conversation log kept, oldest first.
function scan(dataDir) {
    const dir = path.join(dataDir, 'logs'), rows = [], kept = {};
    ConversationLog.list(dataDir).forEach(item => {
        const key = path.join(dir, item.name), known = cache[key];
        const r = known && known.bytes === item.bytes ? known.row : stretch(dir, item);
        if (r) { rows.push(r); kept[key] = {bytes: item.bytes, row: r}; }
    });
    cache = kept;
    return rows.sort((a, b) => a.start - b.start);
}

// What the page shows, in Jibo's local time (`local`: ms -> {year, monthNum, date}); pure.
//   total: conversations in the logs kept, since: when the oldest began,
//   week: the last 7 local days {count, ms, averageMs, longestMs} (a stretch counts for the day it began),
//   days: [{day, count, ms}] oldest first, recent: the newest stretches first with their day and time.
function report(rows, now, local) {
    const pad = strings.pad2, key = t => t.year + '-' + pad(t.monthNum + 1) + '-' + pad(t.date);
    const days = [], index = {};
    for (let i = DAYS - 1; i >= 0; i--) {
        const day = key(local(now - i * 86400000));
        if (index[day] !== undefined) continue;
        index[day] = days.length;
        days.push({day: day, count: 0, ms: 0});
    }
    const week = {count: 0, ms: 0, averageMs: null, longestMs: 0};
    rows.forEach(r => {
        const i = index[key(local(r.start))];
        if (i === undefined) return;
        const ms = r.end - r.start;
        if (!r.resumed) { days[i].count++; week.count++; }
        days[i].ms += ms; week.ms += ms;
        week.longestMs = Math.max(week.longestMs, ms);
    });
    if (week.count) week.averageMs = Math.round(week.ms / week.count);
    return {
        total: rows.filter(r => !r.resumed).length, since: rows.length ? rows[0].start : null,
        week: week, days: days,
        // day and time in Jibo's zone, like the charts, whatever zone the browser is in.
        recent: rows.slice(-RECENT).reverse().map(r => {
            const t = local(r.start);
            return {start: r.start, day: key(t), time: pad(t.hour || 0) + ':' + pad(t.minute || 0), ms: r.end - r.start, turns: r.turns, reason: r.reason, resumed: r.resumed};
        })
    };
}

module.exports = {scan, report};
