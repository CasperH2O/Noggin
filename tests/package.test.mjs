// BEam 3.2.0 skill permissions: what manifest.json declares is what the code needs, no more, and
// what runs while Noggin's screen is closed never needs the microphone (BEam grants it only while
// the skill's own screen is open).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'noggin/package.json'), 'utf8'));
const KNOWN = ['microphone', 'camera', 'background', 'local-network', 'jibo-apis', 'read-jibo-files', 'edit-jibo-files', 'read-kb', 'edit-kb', 'run-programs'];

function files(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? files(full) : [full];
    });
}
// The skill's own JavaScript (the settings page's web/ runs in the owner's browser, vendor/ is a library).
const code = files(path.join(source, 'noggin')).filter(f => /\.js$/.test(f) && !/[\\/](web|vendor)[\\/]/.test(f));
const text = file => fs.readFileSync(file, 'utf8').split('\n').map(line => line.replace(/^\s*\/\/.*$/, '')).join('\n');
const named = name => code.find(f => path.basename(f) === name);
const version = value => value.split('.').map(Number);

test('supported is 3.2.0 or newer, permissions are known and unique, versions agree', () => {
    const [major, minor] = version(manifest.supported);
    assert.ok(major > 3 || (major === 3 && minor >= 2), 'older skills are turned off by BEam 3.2.0');
    assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.length > 0);
    assert.deepEqual(manifest.permissions.filter(p => !KNOWN.includes(p)), []);
    assert.equal(new Set(manifest.permissions).size, manifest.permissions.length);
    assert.equal(manifest.version, pkg.version);
});

test('the store text and the README name the version BEam needs', () => {
    for (const file of ['store/README.md', 'README.md']) {
        const content = fs.readFileSync(path.join(source, file), 'utf8');
        assert.match(content, new RegExp('BEam\\s+' + manifest.supported.replace(/\./g, '\\.') + ' or newer'), file);
    }
});

// What each permission is for: a pattern in the code that needs it. A permission is declared when,
// and only when, its pattern is found.
const NEEDS = {
    background: {why: 'a background script', found: () => !!(pkg.jibo && pkg.jibo.background)},
    microphone: {why: 'the hotword is taken while Noggin has the microphone; the page\'s audio capture', pattern: /\bsetHotwordMode\b|\bgetUserMedia\s*\(\s*\{\s*audio|navigator\.mediaDevices|\bstartLocalTurn\b|\bsubscribeGlobal\b|\bgetEnrolledSpeakers\b/},
    camera: {why: 'photos and camera streams', pattern: /\btakePhoto\b|\bgetCameraStream\b|\bsetViewfinder\b|\bgetPhoto\b|\bgetPreviewUrl\b|\bgetUrlById\b|\bjibo\.media\b|video\s*:\s*true/},
    'local-network': {why: 'a connection to a private address', pattern: /(?:https?|wss?):\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|\.createConnection\(|net\.connect/},
    'jibo-apis': {why: 'BEacon on this robot', pattern: /host:\s*'127\.0\.0\.1'/},
    'read-kb': {why: 'the clock\'s record and the family list through jibo.kb', pattern: /\bkb\.createModel\b|\bkb\.loop\b/},
    'edit-kb': {why: 'writing the knowledge base', pattern: /\bcreateSlice\b|\bremoveSlice\b|\bremoveAll\b|\bkb\.save\b/},
    'run-programs': {why: 'the arecord child process', pattern: /child_process/},
    // The code reaches no file outside its own folder (the files test below), and no jibo.fs-style call.
    'read-jibo-files': {why: 'files outside the knowledge base', pattern: /\bjibo\.(?:fs|files)\b|\breadJiboFile\b/},
    'edit-jibo-files': {why: 'files outside the knowledge base', pattern: /\bjibo\.(?:fs|files)\b|\bwriteJiboFile\b/}
};

test('the declared permissions are exactly what the code needs', () => {
    const all = code.map(text).join('\n');
    for (const name of KNOWN) {
        const need = NEEDS[name];
        assert.ok(need, name + ' needs an entry in NEEDS');
        const needed = need.found ? need.found() : need.pattern ? need.pattern.test(all) : false;
        assert.equal(manifest.permissions.includes(name), needed, name + (needed ? ' is needed for ' : ' is declared but nothing needs it: ') + need.why);
    }
});

test('files: only the skill\'s own Knowledge folder is written; other absolute paths are probes or tools', () => {
    const allowed = {
        '/opt/jibo/Knowledge/noggin': 'the data folder (own section)',
        '/opt/jibo/Knowledge/beacon/custom-skills/noggin': 'the old data folder, read once with read-kb',
        '/tmp/beam-beacon/custom-skills/noggin': 'a development checkout, no robot',
        '/opt/jibo/Jibo/Skills': 'only tested for existence: is this a robot',
        '/usr/bin/arecord': 'run-programs'
    };
    const found = new Set();
    for (const file of code) {
        for (const match of text(file).matchAll(/['"`](\/(?:opt|var|etc|usr|tmp|home|proc|sys|root|mnt|media|dev)\/[^'"`\s]*)['"`]/g)) found.add(match[1].replace(/\/$/, ''));
    }
    assert.deepEqual([...found].sort(), Object.keys(allowed).sort());
    assert.ok(manifest.permissions.includes('read-kb'), 'the old folder is read with read-kb');
});

test('what runs while Noggin\'s screen is closed makes no microphone or camera call', () => {
    // BEam hands the microphone and camera to a skill only while its own screen is open: the background
    // script, the "Hey Jibo" watch, the comeback watch and the cloud turn run outside that.
    const guarded = /\b(setHotwordMode|startLocalTurn|subscribeGlobal|startEnrollmentTurn|startNameLearningTurn|initNameLearning|createSpeakerModel|getEnrolledSpeakers|takePhoto|getCameraStream|getUserMedia|getPhoto|getPreviewUrl|setViewfinder)\b/;
    for (const name of ['background.js', 'hey-jibo.js', 'comeback.js', 'cloud-turn.js', 'embodied-listen.js', 'budget.js', 'recap.js', 'server.js', 'usage.js', 'migrate.js']) {
        assert.ok(named(name), name);
        assert.doesNotMatch(text(named(name)), guarded, name);
    }
    // The transcript events BEam withholds while closed are not read at all; globalTurnResult is only
    // watched to end a claim, and its loss while closed is harmless (a claim also ends by itself).
    const events = code.filter(f => /\b(localTurnResult|speakerID|speakerEnrollment|skillLaunch)\b/.test(text(f)));
    assert.deepEqual(events.map(f => path.basename(f)), []);
});

test('the data folder is the skill\'s own Knowledge folder on the robot, the only place BEam 3.2.0 lets it write without a permission', () => {
    const settings = require(path.join(source, 'noggin/lib/settings.js'));
    assert.equal(pkg.name, '@be/noggin');
    const read = fs.readFileSync(path.join(source, 'noggin/lib/settings.js'), 'utf8');
    assert.ok(read.includes("ROBOT_DATA = '/opt/jibo/Knowledge/" + pkg.name.slice('@be/'.length) + "'"), 'the robot data folder is named after the package');
    assert.equal(typeof settings.adoptOldData, 'function');
});

test('whole-file writes pass BEam\'s path checks: no fs call guarded for paths gets a file number', () => {
    // BEam 3.2.0 reads the first argument of writeFile and the like as a path; a file number from
    // openSync is not one, so it would be refused as a file outside the skill's own folder.
    const filesLib = require(path.join(source, 'noggin/lib/files.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noggin-files-'));
    const guarded = ['writeFileSync', 'appendFileSync', 'readFileSync', 'truncateSync', 'utimesSync', 'chmodSync'];
    const originals = guarded.map(name => fs[name]);
    const numbers = [];
    guarded.forEach((name, i) => { fs[name] = function (first, ...rest) { if (typeof first === 'number') numbers.push(name); return originals[i].call(this, first, ...rest); }; });
    try {
        filesLib.atomic(path.join(dir, 'a', 'one.json'), '{"text": "éè"}');
        filesLib.atomic(path.join(dir, 'a', 'two.bin'), Buffer.alloc(300000, 7));
        filesLib.readPart(path.join(dir, 'a', 'one.json'), 0, 100);
    } finally { guarded.forEach((name, i) => { fs[name] = originals[i]; }); }
    assert.deepEqual(numbers, []);
    assert.equal(fs.readFileSync(path.join(dir, 'a', 'one.json'), 'utf8'), '{"text": "éè"}');
    assert.equal(fs.statSync(path.join(dir, 'a', 'two.bin')).size, 300000);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'a')).sort(), ['one.json', 'two.bin']);
});
