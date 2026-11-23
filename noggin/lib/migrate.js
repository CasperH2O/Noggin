// SPDX-License-Identifier: MIT
// What an earlier Noggin kept in BEacon's skill data folder is copied once into the skill's own
// Knowledge folder, the only place BEam 3.2.0 lets it write without Knowledge permissions (D151).
// The old folder is left as it is: removing it would need the edit-kb permission.
// Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');
const files = require('./files');

const MARKER = 'migrated.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// Few files: every copy is an fsync, and this runs in the middle of the start (D151). Conversation logs
// and recap transcripts are told apart as lib/conversation-log.js does.
const CONVERSATIONS_KEPT = 30, CONVERSATION_NAME = /^conversation-(\d{8}-\d{6})\.jsonl$/;
const RECAPS_KEPT = 10, RECAP_NAME = /^recap-(\d{8}-\d{6})\.jsonl$/;
const PERSONA_NAME = /^(?:SOUL|IDENTITY|FACTS)\.md$/;

function exists(file) { try { fs.statSync(file); return true; } catch (_) { return false; } }
// A missing file or folder is nothing to copy; any other failure (a refused read) ends the copy.
function ignoreMissing(error) { if (!error || error.code !== 'ENOENT') throw error; }
function names(dir) { try { return fs.readdirSync(dir); } catch (error) { ignoreMissing(error); return []; } }

// One file, whole, through the same atomic write the data folder always uses. False when it is
// missing, too big, or already there (a retry fills only what is missing, never overwrites).
function copy(from, to) {
    if (exists(to)) return false;
    let data;
    try {
        if (fs.statSync(from).size > MAX_FILE_BYTES) return false;
        data = fs.readFileSync(from);
    } catch (error) { ignoreMissing(error); return false; }
    files.atomic(to, data);
    return true;
}
// The newest `keep` names that match `pattern`, by the time in the name.
function newest(list, pattern, keep) {
    return list.filter(n => pattern.test(n)).sort((a, b) => pattern.exec(b)[1].localeCompare(pattern.exec(a)[1])).slice(0, keep);
}

// options: {from, to, log}. Returns the number of files copied, or null when nothing was to do.
// Never throws: a refused read (no read-kb permission) or a full disk leaves Noggin with fresh settings,
// and no marker, so a later start tries again and fills only what is still missing.
function run(options) {
    const from = options.from, to = options.to, log = options.log || {info() {}, warn() {}};
    if (!from || !to || from === to || exists(path.join(to, MARKER)) || exists(path.join(to, 'settings.json'))) return null;
    try {
        if (!exists(from)) return null;
        let copied = 0;
        const count = ok => { if (ok) copied++; };
        const logs = names(path.join(from, 'logs'));
        newest(logs, CONVERSATION_NAME, CONVERSATIONS_KEPT).concat(newest(logs, RECAP_NAME, RECAPS_KEPT))
            .forEach(n => count(copy(path.join(from, 'logs', n), path.join(to, 'logs', n))));
        names(path.join(from, 'persona')).filter(n => PERSONA_NAME.test(n)).forEach(n => count(copy(path.join(from, 'persona', n), path.join(to, 'persona', n))));
        // The settings last: they are what says the copy is complete.
        count(copy(path.join(from, 'memory.json'), path.join(to, 'memory.json')));
        count(copy(path.join(from, 'settings.json'), path.join(to, 'settings.json')));
        files.atomic(path.join(to, MARKER), JSON.stringify({files: copied}));
        log.info('data folder: copied ' + copied + ' files from the old folder');
        return copied;
    } catch (error) {
        log.warn('data folder: old settings not copied: ' + (error && error.message));
        return null;
    }
}

module.exports = {run};
