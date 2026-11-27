// SPDX-License-Identifier: MIT
// One JSON-lines log per conversation in <data>/logs (mode 0600), shown on the settings page.
// Text only: what was said, expressions, timings and token use; never audio or the key.
// Keeps the newest KEEP logs of at most MAX_BYTES each, and at most TOTAL_BYTES together.
// With logs off but memory learning on, it keeps only what the recap needs (who said what, and
// how the conversation ended) in a hidden recap-*.jsonl, which the recap deletes once done (D55).
// Lines go to disk together every FLUSH_MS; a line that ends or hands over the conversation goes
// at once, before Be may close the skill. Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
const files = require('./files'), strings = require('./text');
const KEEP = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 20 * 1024 * 1024;
const NAME = /^conversation-\d{8}-\d{6}\.jsonl$/;
const RECAP_NAME = /^recap-\d{8}-\d{6}\.jsonl$/;
const RECAP_KEEP = 50;
const RECAP_MAX_BYTES = 256 * 1024; // text only, so far less than a full log
const RECAP_TOTAL_BYTES = 4 * 1024 * 1024;
const RECAP_MS = 2 * 86400000;      // a recap transcript never kept longer than this
// What a recap transcript keeps of each entry, by kind.
const RECAP_FIELDS = {startup: ['resumed'], you: ['text'], jibo: ['text'], handover: ['comeback'], comeback: ['ok', 'reason'], session_end: ['reason']};
const FLUSH_MS = 300;
// Entries written at once: the recap needs them to tell how a conversation ended (D54), and a
// `speak` shows what played if Be dies mid-speech.
const AT_ONCE = {handover: true, comeback: true, session_end: true, speak: true};
const STAMP = /^(?:conversation|recap)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.jsonl$/;

function stamp(date) {
    const two = strings.pad2;
    return date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate()) + '-' + two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
}
function folder(dataDir) { return path.join(dataDir, 'logs'); }
// A name already taken (a conversation opened again within the same second) moves to the next
// free second, so two conversations never share a file or its size count.
const NAME_TRIES = 60;
function freeName(dir, prefix, ms) {
    for (let i = 0; i < NAME_TRIES; i++) {
        const name = prefix + stamp(new Date(ms + i * 1000)) + '.jsonl';
        if (!fs.existsSync(path.join(dir, name))) return name;
    }
    throw Error('no free log name');
}

class ConversationLog {
    // options.recap: keep a recap transcript when the log itself is off.
    constructor(dataDir, enabled, options) {
        this.dir = folder(dataDir); this.file = null; this.bytes = 0; this.enabled = enabled !== false;
        this.queue = []; this.timer = null; this.written = false;
        this.recapOnly = !this.enabled && !!(options && options.recap);
        if (!this.enabled && !this.recapOnly) return;
        try {
            files.makeDir(this.dir);
            this.file = path.join(this.dir, freeName(this.dir, this.recapOnly ? 'recap-' : 'conversation-', Date.now()));
            prune(this.dir);
            pruneRecap(this.dir, Date.now());
        } catch (error) { this.file = null; this.error = error.message; }
    }
    write(entry) {
        if (!this.file) return;
        if (this.recapOnly) {
            const fields = RECAP_FIELDS[entry && entry.kind];
            if (!fields) return;
            const kept = {kind: entry.kind};
            fields.forEach(f => { if (entry[f] !== undefined) kept[f] = entry[f]; });
            entry = kept;
        }
        let line = JSON.stringify(Object.assign({t: new Date().toISOString()}, entry)) + '\n';
        // Counted here, before the write, so the cap holds for what is still queued.
        const full = this.bytes + Buffer.byteLength(line, 'utf8') > (this.recapOnly ? RECAP_MAX_BYTES : MAX_BYTES);
        if (full) line = JSON.stringify({t: new Date().toISOString(), kind: 'log_full', bytes: this.bytes}) + '\n';
        this.queue.push(line);
        this.bytes += Buffer.byteLength(line, 'utf8');
        // The first line creates the file at once, so the log shows on the settings page.
        if (full || !this.written || AT_ONCE[entry && entry.kind]) this.flush();
        else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, FLUSH_MS);
        if (full) this.file = null;
    }
    // Everything queued, in one append.
    flush() {
        clearTimeout(this.timer);
        this.timer = null;
        const text = this.queue.join('');
        this.queue = [];
        if (!this.file || !text) return;
        try { fs.appendFileSync(this.file, text, {mode: 384}); this.written = true; }
        catch (_) { this.file = null; }
    }
    // The last lines, written before the conversation lets go of the log.
    close() { this.flush(); }
}

// Make room for one more log: the oldest go until there are fewer than KEEP and a full new
// log still fits in TOTAL_BYTES.
function prune(dir) {
    const old = fs.readdirSync(dir).filter(n => NAME.test(n)).sort();
    const sizes = old.map(n => { try { return fs.statSync(path.join(dir, n)).size; } catch (_) { return 0; } });
    let total = sizes.reduce((sum, size) => sum + size, 0), count = old.length;
    for (let i = 0; i < old.length && (count >= KEEP || total + MAX_BYTES > TOTAL_BYTES); i++) {
        try { fs.unlinkSync(path.join(dir, old[i])); } catch (_) {}
        total -= sizes[i]; count--;
    }
}

// Recap transcripts the recap never got to (learning switched off, a key that stopped working):
// any older than RECAP_MS go, then the oldest until there are fewer than RECAP_KEEP and a full
// new one still fits in RECAP_TOTAL_BYTES.
function pruneRecap(dir, now) {
    const kept = [];
    fs.readdirSync(dir).filter(n => RECAP_NAME.test(n)).sort().forEach(n => {
        let stat = null;
        try { stat = fs.statSync(path.join(dir, n)); } catch (_) { return; }
        if (now - stat.mtime.getTime() > RECAP_MS) remove(dir, n);
        else kept.push({name: n, bytes: stat.size});
    });
    let total = kept.reduce((sum, k) => sum + k.bytes, 0);
    for (let i = 0; i < kept.length && (kept.length - i >= RECAP_KEEP || total + RECAP_MAX_BYTES > RECAP_TOTAL_BYTES); i++) {
        remove(dir, kept[i].name);
        total -= kept[i].bytes;
    }
}
function remove(dir, name) { try { fs.unlinkSync(path.join(dir, name)); } catch (_) {} }

// The logs, newest first: [{name, bytes, started}].
function list(dataDir) {
    let names = [];
    try { names = fs.readdirSync(folder(dataDir)).filter(n => NAME.test(n)).sort().reverse(); } catch (_) {}
    return names.map(name => {
        let bytes = 0;
        try { bytes = fs.statSync(path.join(folder(dataDir), name)).size; } catch (_) {}
        return {name: name, bytes: bytes, started: startedAt(name)};
    });
}
// One log's text, or null for a name that is not a log.
function read(dataDir, name) {
    if (typeof name !== 'string' || !NAME.test(name)) return null;
    try { return fs.readFileSync(path.join(folder(dataDir), name), 'utf8'); } catch (_) { return null; }
}

// Every transcript the recap can read, conversation logs and recap transcripts, newest first.
function transcripts(dataDir) {
    let names = [];
    try { names = fs.readdirSync(folder(dataDir)).filter(n => NAME.test(n) || RECAP_NAME.test(n)); } catch (_) {}
    const at = n => n.replace(/^[a-z]+-/, '');
    return names.sort((a, b) => at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0);
}
// Delete recap transcripts (only those: a conversation log is never deleted here).
function dropRecap(dataDir, names) {
    names.filter(n => RECAP_NAME.test(n)).forEach(n => remove(folder(dataDir), n));
}

// When a log or recap transcript started (its name, in this process's local time): ms, or NaN.
function startedAt(name) {
    const m = STAMP.exec(String(name));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
}
// The start of a log: enough for its startup entry.
const HEAD_BYTES = 8192;
function head(dir, name) { return files.readPart(path.join(dir, name), 0, HEAD_BYTES); }
// Conversations started since sinceMs, for the Usage tab (D66): a log whose startup says `resumed`
// continues the one before it, so it is not counted. {count, since}: since is the oldest log's
// start when the logs kept do not reach back to sinceMs, else null.
function started(dataDir, sinceMs) {
    const dir = folder(dataDir), logs = list(dataDir);
    let count = 0;
    logs.forEach(item => {
        if (!(startedAt(item.name) >= sinceMs)) return;
        let resumed = false;
        try {
            head(dir, item.name).split('\n').some(line => {
                let e;
                try { e = JSON.parse(line); } catch (_) { return false; }
                if (e && e.kind === 'startup') { resumed = !!e.resumed; return true; }
                return false;
            });
        } catch (_) { return; }
        if (!resumed) count++;
    });
    // Pruned (prune()): the oldest kept log is where counting really starts.
    const oldest = logs.length ? startedAt(logs[logs.length - 1].name) : NaN;
    const bytes = logs.reduce((sum, item) => sum + item.bytes, 0);
    const pruned = logs.length >= KEEP - 1 || bytes > TOTAL_BYTES - MAX_BYTES;
    return {count: count, since: pruned && oldest > sinceMs ? oldest : null};
}

ConversationLog.list = list;
ConversationLog.started = started;
ConversationLog.startedAt = startedAt;
ConversationLog.FLUSH_MS = FLUSH_MS;
ConversationLog.transcripts = transcripts;
ConversationLog.dropRecap = dropRecap;
ConversationLog.pruneRecap = (dataDir, now) => { try { pruneRecap(folder(dataDir), now); } catch (_) {} };
ConversationLog.RECAP_KEEP = RECAP_KEEP;
ConversationLog.RECAP_MAX_BYTES = RECAP_MAX_BYTES;
ConversationLog.RECAP_TOTAL_BYTES = RECAP_TOTAL_BYTES;
ConversationLog.RECAP_MS = RECAP_MS;
ConversationLog.read = read;
ConversationLog.KEEP = KEEP;
ConversationLog.MAX_BYTES = MAX_BYTES;
ConversationLog.TOTAL_BYTES = TOTAL_BYTES;
module.exports = ConversationLog;
