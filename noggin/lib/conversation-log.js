// SPDX-License-Identifier: MIT
// One JSON-lines log per conversation in <data>/logs (mode 0600), shown on the settings page.
// Text only: what was said, expressions, timings and token use; never audio or the key.
// Keeps the newest KEEP logs of at most MAX_BYTES each. Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
const KEEP = 200;
const MAX_BYTES = 2 * 1024 * 1024;
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
            const old = fs.readdirSync(this.dir).filter(n => NAME.test(n)).sort();
            old.slice(0, Math.max(0, old.length - KEEP + 1)).forEach(n => { try { fs.unlinkSync(path.join(this.dir, n)); } catch (_) {} });
        } catch (error) { this.file = null; this.error = error.message; }
    }
    write(entry) {
        if (!this.file) return;
        let line = JSON.stringify(Object.assign({t: new Date().toISOString()}, entry)) + '\n';
        const full = this.bytes + line.length > MAX_BYTES;
        if (full) line = JSON.stringify({t: new Date().toISOString(), kind: 'log_full', bytes: this.bytes}) + '\n';
        try { fs.appendFileSync(this.file, line, {mode: 384}); this.bytes += line.length; }
        catch (_) { this.file = null; }
        if (full) this.file = null;
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

ConversationLog.stamp = stamp;
ConversationLog.list = list;
ConversationLog.read = read;
ConversationLog.KEEP = KEEP;
ConversationLog.MAX_BYTES = MAX_BYTES;
module.exports = ConversationLog;
