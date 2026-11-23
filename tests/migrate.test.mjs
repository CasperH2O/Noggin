// An earlier version's data folder is copied once into the skill's own Knowledge folder (lib/migrate.js).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const migrate = require(path.join(source, 'noggin/lib/migrate.js'));
const settings = require(path.join(source, 'noggin/lib/settings.js'));

function folders() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-migrate-'));
    return {from: path.join(root, 'old'), to: path.join(root, 'noggin')};
}
function put(dir, name, text) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
    fs.writeFileSync(path.join(dir, name), text);
}
const quiet = () => { const lines = []; return {lines, info: m => lines.push('info ' + m), warn: m => lines.push('warn ' + m)}; };

test('settings, memory, persona and logs move; the old folder stays; the key file is private', () => {
    const {from, to} = folders();
    put(from, 'settings.json', '{"apiKey":"sk-test"}'); put(from, 'memory.json', '{"facts":[]}');
    put(from, 'persona/SOUL.md', 'soul'); put(from, 'persona/other.txt', 'not persona');
    put(from, 'logs/conversation-20260101-120000.jsonl', '{}\n'); put(from, 'logs/notes.txt', 'x');
    const log = quiet();
    assert.equal(migrate.run({from, to, log}), 4);
    assert.equal(fs.readFileSync(path.join(to, 'settings.json'), 'utf8'), '{"apiKey":"sk-test"}');
    assert.equal(fs.readFileSync(path.join(to, 'persona/SOUL.md'), 'utf8'), 'soul');
    assert.ok(fs.existsSync(path.join(to, 'logs/conversation-20260101-120000.jsonl')));
    assert.ok(!fs.existsSync(path.join(to, 'persona/other.txt')) && !fs.existsSync(path.join(to, 'logs/notes.txt')));
    assert.ok(fs.existsSync(path.join(from, 'settings.json')), 'the old folder is left alone');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(to, 'settings.json')).mode & 0o077, 0);
    assert.match(log.lines.join('\n'), /copied 4 files/);
    assert.equal(settings.load(to).secrets.apiKey, 'sk-test');
});

test('once: a marker, saved settings or an old folder that is not there stop it', () => {
    const {from, to} = folders();
    assert.equal(migrate.run({from, to}), null, 'no old folder');
    assert.ok(!fs.existsSync(to), 'and nothing made');
    put(from, 'memory.json', 'one');
    assert.equal(migrate.run({from, to}), 1);
    put(from, 'memory.json', 'two');
    assert.equal(migrate.run({from, to}), null, 'the marker');
    assert.equal(fs.readFileSync(path.join(to, 'memory.json'), 'utf8'), 'one');
    const other = folders();
    put(other.from, 'memory.json', 'old'); put(other.to, 'settings.json', '{}');
    assert.equal(migrate.run(other), null, 'settings already saved here: a fresh start is kept');
    assert.ok(!fs.existsSync(path.join(other.to, 'memory.json')));
    assert.equal(migrate.run({from: to, to}), null, 'never onto itself');
});

test('only the newest 30 conversation logs and 10 recap transcripts, files up to 4 MB; an unreadable old folder (no read-kb) leaves a warning and no throw', () => {
    const {from, to} = folders();
    const stamp = n => '20260101-' + String(n).padStart(6, '0');
    for (let n = 0; n < 45; n++) put(from, 'logs/conversation-' + stamp(n) + '.jsonl', '{}');
    for (let n = 0; n < 15; n++) put(from, 'logs/recap-' + stamp(n) + '.jsonl', '{}');
    put(from, 'memory.json', 'x'.repeat(4 * 1024 * 1024 + 1));
    migrate.run({from, to});
    const kept = fs.readdirSync(path.join(to, 'logs'));
    assert.equal(kept.filter(n => n.startsWith('conversation-')).length, 30);
    assert.equal(kept.filter(n => n.startsWith('recap-')).length, 10);
    assert.ok(kept.includes('conversation-' + stamp(44) + '.jsonl') && !kept.includes('conversation-' + stamp(14) + '.jsonl'), 'the newest, by the time in the name');
    assert.ok(kept.includes('recap-' + stamp(14) + '.jsonl') && !kept.includes('recap-' + stamp(4) + '.jsonl'));
    assert.ok(!fs.existsSync(path.join(to, 'memory.json')), 'too big');
    const blocked = folders();
    put(blocked.from, 'settings.json', '{}');
    const log = quiet();
    const readFile = fs.readFileSync;
    const refuse = () => { throw Object.assign(Error('@be/noggin needs the read-kb permission to do this'), {}); };
    fs.readFileSync = refuse;
    try { assert.equal(migrate.run({from: blocked.from, to: blocked.to, log}), null); }
    finally { fs.readFileSync = readFile; }
    assert.match(log.lines.join('\n'), /warn data folder: old settings not copied: .*read-kb/);
    assert.ok(!fs.existsSync(path.join(blocked.to, 'migrated.json')), 'no marker: a later start tries again');
    assert.equal(migrate.run({from: blocked.from, to: blocked.to}), 1, 'with the permission it copies');
});

test('the settings are copied last: when the memory fails, there are no settings and no marker, and a retry fills only what is missing', () => {
    const {from, to} = folders();
    put(from, 'settings.json', '{"apiKey":"sk-test"}'); put(from, 'memory.json', 'old memory');
    put(from, 'persona/SOUL.md', 'old soul'); put(from, 'persona/IDENTITY.md', 'old identity');
    const log = quiet();
    const readFile = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
        if (String(file).endsWith('memory.json')) throw Object.assign(Error('@be/noggin needs the read-kb permission to do this'), {});
        return readFile.call(this, file, ...rest);
    };
    try { assert.equal(migrate.run({from, to, log}), null); }
    finally { fs.readFileSync = readFile; }
    assert.ok(!fs.existsSync(path.join(to, 'settings.json')), 'settings last');
    assert.ok(!fs.existsSync(path.join(to, 'migrated.json')), 'no marker');
    assert.ok(fs.existsSync(path.join(to, 'persona/SOUL.md')), 'what came before the failure is there');
    // The person edits the persona in the new folder; the retry must not undo that.
    fs.writeFileSync(path.join(to, 'persona/SOUL.md'), 'newer soul');
    fs.unlinkSync(path.join(to, 'persona/IDENTITY.md'));
    assert.equal(migrate.run({from, to, log}), 3, 'IDENTITY.md, memory and settings');
    assert.equal(fs.readFileSync(path.join(to, 'persona/SOUL.md'), 'utf8'), 'newer soul', 'an existing file is not overwritten');
    assert.equal(fs.readFileSync(path.join(to, 'persona/IDENTITY.md'), 'utf8'), 'old identity');
    assert.equal(fs.readFileSync(path.join(to, 'memory.json'), 'utf8'), 'old memory');
    assert.ok(fs.existsSync(path.join(to, 'settings.json')) && fs.existsSync(path.join(to, 'migrated.json')));
});

test('only on the robot, and only from the old BEacon folder', () => {
    const dir = settings.dataDir();
    assert.notEqual(dir, '/opt/jibo/Knowledge/noggin', 'a development checkout keeps its own folder');
    assert.equal(settings.adoptOldData(), null);
    const {from, to} = folders();
    put(from, 'settings.json', '{"apiKey":"sk-robot"}');
    assert.equal(settings.adoptOldData(quiet(), {robot: false, from, to}), null, 'off the robot nothing is copied');
    assert.ok(!fs.existsSync(to));
    assert.equal(settings.adoptOldData(quiet(), {robot: true, from, to}), 1, 'on the robot the old folder is adopted');
    assert.equal(settings.load(to).secrets.apiKey, 'sk-robot');
});
