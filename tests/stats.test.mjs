// The conversation statistics for the Usage tab (lib/stats.js): the file and the report.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const stats = require(path.join(source, 'noggin/lib/stats.js'));

const MIN = 60000, DAY = 86400000;
const NOW = new Date(2026, 10, 23, 15, 0, 0).getTime(); // Monday 23 November, 15:00 local
const at = (daysAgo, hour, minute = 0) => new Date(2026, 10, 23 - daysAgo, hour, minute, 0).getTime();
const local = ms => { const d = new Date(ms); return {year: d.getFullYear(), monthNum: d.getMonth(), date: d.getDate(), hour: d.getHours(), minute: d.getMinutes()}; };
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-stats-'));

// A conversation log as Noggin writes it: lines with a timestamp, the file named by its start.
const two = n => String(n).padStart(2, '0');
function writeLog(d, start, durationMs, {resumed = false, turns = 3, reason = 'goodbye', end = true, middle = 0} = {}) {
    const s = new Date(start), name = 'conversation-' + s.getFullYear() + two(s.getMonth() + 1) + two(s.getDate()) + '-' + two(s.getHours()) + two(s.getMinutes()) + two(s.getSeconds()) + '.jsonl';
    const line = (t, e) => JSON.stringify(Object.assign({t: new Date(t).toISOString()}, e)) + '\n';
    let text = line(start, {kind: 'session', version: '0.0.0'}) + line(start + 800, {kind: 'startup', resumed});
    for (let i = 0; i < middle; i++) text += line(start + 1000 + i, {kind: 'you', text: 'x'.repeat(200)});
    text += end ? line(start + durationMs, {kind: 'session_end', reason, turns}) : line(start + durationMs, {kind: 'jibo', text: 'hello'});
    fs.mkdirSync(path.join(d, 'logs'), {recursive: true});
    fs.writeFileSync(path.join(d, 'logs', name), text);
    return name;
}

test('scan: start, length, turns, reason and resumed come from each log; oldest first', () => {
    const d = dir();
    writeLog(d, at(1, 20), 10 * MIN, {turns: 8, reason: 'silence'});
    writeLog(d, at(0, 9), 4 * MIN);
    writeLog(d, at(0, 9) + 6 * MIN, 2 * MIN, {resumed: true, reason: 'handover'});
    const rows = stats.scan(d);
    assert.deepEqual(rows.map(r => r.start), [at(1, 20), at(0, 9), at(0, 9) + 6 * MIN]);
    assert.deepEqual(rows[0], {start: at(1, 20), end: at(1, 20) + 10 * MIN, turns: 8, reason: 'silence', resumed: false, lines: {nl: 0, en: 0}});
    assert.equal(rows[2].resumed, true);
});

test('scan: a big log is read only at its ends; the end line is found at the tail', () => {
    const d = dir();
    writeLog(d, at(0, 8), 25 * MIN, {middle: 5000, turns: 40});
    const rows = stats.scan(d);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].end - rows[0].start, 25 * MIN);
    assert.equal(rows[0].turns, 40);
});

test('review: logs just over one part and exactly two parts long keep their end line', () => {
    const d = dir();
    // About 15.5 KB, and the size where the head and the tail parts just touch.
    writeLog(d, at(2, 8), 10 * MIN, {middle: 60, turns: 7});
    const one = fs.statSync(path.join(d, 'logs', fs.readdirSync(path.join(d, 'logs'))[0])).size;
    assert.ok(one > 8192 && one <= 16384, 'size ' + one);
    writeLog(d, at(1, 8), 12 * MIN, {middle: 60, turns: 9});
    const rows = stats.scan(d);
    assert.deepEqual(rows.map(r => [r.end - r.start, r.turns, r.reason]), [[10 * MIN, 7, 'goodbye'], [12 * MIN, 9, 'goodbye']]);
    for (const size of [8192, 8193, 16384, 16385]) {
        const e = dir(), name = writeLog(e, at(0, 7), 4 * MIN, {turns: 2});
        const file = path.join(e, 'logs', name);
        const text = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const pad = JSON.stringify({t: new Date(at(0, 7) + 1000).toISOString(), kind: 'you', text: ''});
        const fill = size - fs.statSync(file).size - 1;   // one filler line brings the file to `size`
        text.splice(2, 0, JSON.stringify({t: new Date(at(0, 7) + 1000).toISOString(), kind: 'you', text: 'x'.repeat(Math.max(0, fill - pad.length))}));
        fs.writeFileSync(file, text.join('\n') + '\n');
        const r = stats.scan(e)[0];
        assert.equal(r.end - r.start, 4 * MIN, 'size ' + fs.statSync(file).size);
        assert.equal(r.turns, 2);
    }
});

test('review: a log is read again only when its size changes; gone logs leave the cache', () => {
    const d = dir();
    const name = writeLog(d, at(0, 8), 2 * MIN);
    assert.equal(stats.scan(d)[0].end - stats.scan(d)[0].start, 2 * MIN);
    const file = path.join(d, 'logs', name);
    fs.appendFileSync(file, JSON.stringify({t: new Date(at(0, 8) + 9 * MIN).toISOString(), kind: 'session_end', reason: 'later', turns: 1}) + '\n');
    const r = stats.scan(d)[0];
    assert.equal(r.end - r.start, 9 * MIN, 'it grew: read again');
    fs.unlinkSync(file);
    assert.deepEqual(stats.scan(d), []);
});

test('scan: a log that never got its end line ends at its last line', () => {
    const d = dir();
    writeLog(d, at(0, 8), 3 * MIN, {end: false});
    const r = stats.scan(d)[0];
    assert.equal(r.end - r.start, 3 * MIN);
    assert.equal(r.reason, '');
});

test('scan: no logs, a damaged log and recap transcripts give nothing wrong', () => {
    const d = dir();
    assert.deepEqual(stats.scan(d), []);
    fs.mkdirSync(path.join(d, 'logs'));
    fs.writeFileSync(path.join(d, 'logs', 'conversation-20261123-090000.jsonl'), 'garbage\n');
    fs.writeFileSync(path.join(d, 'logs', 'recap-20261123-100000.jsonl'), '{"t":"2026-11-23T10:00:00Z","kind":"startup"}\n');
    const rows = stats.scan(d);
    assert.equal(rows.length, 1, 'only conversation logs; the damaged one falls back to its file name');
    assert.equal(rows[0].start, new Date(2026, 10, 23, 9, 0, 0).getTime());
    assert.equal(rows[0].end, rows[0].start);
});

test('report: counts, time, average, longest and days in Jibo\'s local time', () => {
    const rows = [
        {start: at(0, 9), end: at(0, 9) + 4 * MIN, turns: 5, reason: 'goodbye', resumed: false},
        {start: at(0, 9) + 6 * MIN, end: at(0, 9) + 8 * MIN, turns: 1, reason: 'handover', resumed: true},
        {start: at(1, 20), end: at(1, 20) + 10 * MIN, turns: 8, reason: 'silence', resumed: false},
        {start: at(3, 23, 50), end: at(3, 23, 50) + 6 * MIN, turns: 2, reason: 'goodbye', resumed: false}, // crosses midnight: day it began
        {start: at(9, 12), end: at(9, 12) + 60 * MIN, turns: 40, reason: 'goodbye', resumed: false}      // older than 7 days
    ];
    const r = stats.report(rows.slice().sort((a, b) => a.start - b.start), NOW, local);
    assert.equal(r.total, 4, 'a comeback is not a new conversation');
    assert.equal(r.since, at(9, 12), 'the oldest row, wherever it stands in the list');
    assert.deepEqual(r.week, {count: 3, ms: 22 * MIN, averageMs: Math.round(22 * MIN / 3), longestMs: 10 * MIN, lines: {nl: 0, en: 0}});
    assert.equal(r.days.length, 7);
    assert.deepEqual(r.days.map(d => d.count), [0, 0, 0, 1, 0, 1, 1]);
    assert.equal(r.days[6].ms, 6 * MIN, 'today: both stretches add time');
    assert.equal(r.days[6].day, '2026-11-23');
    assert.equal(r.recent[0].start, at(0, 9) + 6 * MIN, 'newest first');
    assert.equal(r.recent[0].resumed, true);
    assert.equal(r.recent[0].day, '2026-11-23');
    assert.equal(r.recent[0].time, '09:06', 'Jibo\'s hour and minute, from the same local() as the days');
    assert.equal(r.recent[1].day, '2026-11-23');
    assert.equal(r.recent[2].day, '2026-11-22');
    assert.equal(r.recent.length, 5);
});

test('report: nothing yet', () => {
    const r = stats.report([], NOW, local);
    assert.equal(r.total, 0);
    assert.equal(r.since, null);
    assert.deepEqual(r.week, {count: 0, ms: 0, averageMs: null, longestMs: 0, lines: {nl: 0, en: 0}});
    assert.deepEqual(r.recent, []);
});

test('report: only the newest few are listed', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push({start: NOW - (20 - i) * 1000, end: NOW - (20 - i) * 1000 + 100, turns: 1, reason: '', resumed: false});
    const r = stats.report(rows, NOW, local);
    assert.equal(r.recent.length, 8);
    assert.equal(r.recent[0].start, rows[19].start);
});

test('lines per language come from the end line, are summed for the week and listed per conversation (D171)', () => {
    const d = dir();
    const name = writeLog(d, at(0, 9), 4 * MIN, {turns: 3, reason: 'goodbye'});
    const file = path.join(d, 'logs', name);
    const text = fs.readFileSync(file, 'utf8').replace('"kind":"session_end"', '"kind":"session_end","lines":{"nl":5,"en":2}');
    fs.writeFileSync(file, text);
    const rows = stats.scan(d);
    assert.deepEqual(rows[0].lines, {nl: 5, en: 2});
    const bad = stats.report([Object.assign({}, rows[0], {lines: {nl: 5, en: 2}}), {start: at(0, 10), end: at(0, 10) + MIN, turns: 1, reason: '', resumed: false}], NOW, local);
    assert.deepEqual(bad.week.lines, {nl: 5, en: 2}, 'a row without counts adds nothing');
    assert.deepEqual(bad.recent[1].lines, {nl: 5, en: 2});
    assert.deepEqual(bad.recent[0].lines, {nl: 0, en: 0});
});

test('line counts that are not small whole numbers are read as zero', () => {
    const d = dir();
    const name = writeLog(d, at(0, 9), 4 * MIN, {turns: 3, reason: 'goodbye'});
    const file = path.join(d, 'logs', name);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"kind":"session_end"', '"kind":"session_end","lines":{"nl":-1,"en":1e999}'));
    assert.deepEqual(stats.scan(d)[0].lines, {nl: 0, en: 0});
});
