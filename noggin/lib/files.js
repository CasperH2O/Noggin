// SPDX-License-Identifier: MIT
// Files in Noggin's data folder: folders and files only Jibo's own user can read (0700, 0600),
// whole-file writes that a power cut never leaves half done, and reading part of a file.
// Node 6: ES2015 only.
'use strict';
const fs = require('fs'), path = require('path');

function makeDir(dir) {
    try { fs.mkdirSync(dir, 448); }
    catch (error) {
        if (error.code === 'ENOENT') { makeDir(path.dirname(dir)); fs.mkdirSync(dir, 448); }
        else if (error.code !== 'EEXIST') throw error;
    }
}
function removeQuietly(file) { try { fs.unlinkSync(file); } catch (_) {} }

function writeTemporary(temporary, data) {
    if (typeof fs.fsyncSync !== 'function' || typeof fs.openSync !== 'function') {
        // The simulator's fs has no file descriptors: write, then rename, without the fsync.
        fs.writeFileSync(temporary, data, {mode: 384});
        return;
    }
    const fd = fs.openSync(temporary, 'wx', 384);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
}
// Write via a temporary file and a rename, so a power cut never leaves half a file. A failed
// write takes its temporary file with it.
function atomic(target, data) {
    makeDir(path.dirname(target));
    const temporary = target + '.new';
    removeQuietly(temporary);
    try {
        writeTemporary(temporary, data);
        fs.renameSync(temporary, target);
    } catch (error) {
        removeQuietly(temporary);
        throw error;
    }
}

// Up to `length` bytes of a file from `position`, as text. A cut may split the first and last
// characters; callers that parse lines skip a broken line.
function readPart(file, position, length) {
    if (typeof fs.openSync !== 'function') return fs.readFileSync(file, 'utf8').slice(position, position + length);
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.alloc ? Buffer.alloc(length) : new Buffer(length);
        return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, length, position));
    } finally { fs.closeSync(fd); }
}

module.exports = {makeDir, atomic, readPart};
