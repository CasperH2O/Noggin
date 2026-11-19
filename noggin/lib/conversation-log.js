// SPDX-License-Identifier: MIT
// One JSON-lines log per conversation in <data>/logs (mode 0600), shown on the settings page.
// Text only: what was said, expressions, timings and token use; never audio or the key.
// Keeps the newest KEEP logs of at most MAX_BYTES each, and at most TOTAL_BYTES together.
// With logs off but memory learning on, it keeps only what the recap needs (who said what, and
// how the conversation ended) in a hidden recap-*.jsonl, which the recap deletes once done (D55).
// Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
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

function stamp(date) {
    const two = n => (n < 10 ? '0' : '') + n;
    return date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate()) + '-' + two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
}
function folder(dataDir) { return path.join(dataDir, 'logs'); }

class ConversationLog {
    // options.recap: keep a recap transcript when the log itself is off.
    constructor(dataDir, enabled, options) {
        this.dir = folder(dataDir); this.file = null; this.bytes = 0; this.enabled = enabled !== false;
        this.recapOnly = !this.enabled && !!(options && options.recap);
        if (!this.enabled && !this.recapOnly) return;
        try {
            makeDir(this.dir);
            this.file = path.join(this.dir, (this.recapOnly ? 'recap-' : 'conversation-') + stamp(new Date()) + '.jsonl');
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
        const full = this.bytes + Buffer.byteLength(line, 'utf8') > (this.recapOnly ? RECAP_MAX_BYTES : MAX_BYTES);
        if (full) line = JSON.stringify({t: new Date().toISOString(), kind: 'log_full', bytes: this.bytes}) + '\n';
        try { fs.appendFileSync(this.file, line, {mode: 384}); this.bytes += Buffer.byteLength(line, 'utf8'); }
        catch (_) { this.file = null; }
        if (full) this.file = null;
    }
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

function makeDir(dir) {
    try { fs.mkdirSync(dir, 448); }
    catch (error) {
        if (error.code === 'ENOENT') { makeDir(path.dirname(dir)); fs.mkdirSync(dir, 448); }
        else if (error.code !== 'EEXIST') throw error;
    }
}

// The logs, newest first: [{name, bytes}].
function list(dataDir) {
    let names = [];
    try { names = fs.readdirSync(folder(dataDir)).filter(n => NAME.test(n)).sort().reverse(); } catch (_) {}
    return names.map(name => {
        let bytes = 0;
        try { bytes = fs.statSync(path.join(folder(dataDir), name)).size; } catch (_) {}
        return {name: name, bytes: bytes};
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

ConversationLog.list = list;
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
