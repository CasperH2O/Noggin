// SPDX-License-Identifier: MIT
// One JSON-lines log per conversation in <data>/logs (mode 0600), shown on the settings page.
// Text only: what was said, expressions, timings and token use; never audio or the key.
// Keeps the newest KEEP logs of at most MAX_BYTES each, and at most TOTAL_BYTES together.
// Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
const KEEP = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 20 * 1024 * 1024;
const NAME = /^conversation-\d{8}-\d{6}\.jsonl$/;

function stamp(date) {
    const two = n => (n < 10 ? '0' : '') + n;
    return date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate()) + '-' + two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds());
}
function folder(dataDir) { return path.join(dataDir, 'logs'); }

class ConversationLog {
    constructor(dataDir, enabled) {
        this.dir = folder(dataDir); this.file = null; this.bytes = 0; this.enabled = enabled !== false;
        if (!this.enabled) return;
        try {
            makeDir(this.dir);
            this.file = path.join(this.dir, 'conversation-' + stamp(new Date()) + '.jsonl');
            prune(this.dir);
        } catch (error) { this.file = null; this.error = error.message; }
    }
    write(entry) {
        if (!this.file) return;
        let line = JSON.stringify(Object.assign({t: new Date().toISOString()}, entry)) + '\n';
        const full = this.bytes + Buffer.byteLength(line, 'utf8') > MAX_BYTES;
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

ConversationLog.list = list;
ConversationLog.read = read;
ConversationLog.KEEP = KEEP;
ConversationLog.MAX_BYTES = MAX_BYTES;
ConversationLog.TOTAL_BYTES = TOTAL_BYTES;
module.exports = ConversationLog;
