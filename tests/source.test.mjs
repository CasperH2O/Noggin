// What ships: no leftovers of other products, and the package and manifest agree.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
const source = path.resolve(import.meta.dirname, '..');

function files(dir) {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? files(full) : [full];
    });
}

test('no other product\'s names in what ships or in the docs', () => {
    const shipped = files(path.join(source, 'noggin')).concat(['README.md', 'DEVELOPMENT.md', 'manifest.json'].map(f => path.join(source, f)))
        .filter(f => /\.(js|json|md|html|css|rule)$/.test(f) && fs.existsSync(f));
    const bad = /zeroclaw|zero claw|jibo talk\b|talk-set|talk-setup|talk\.json|\bssh\b/i;
    for (const file of shipped) {
        const text = fs.readFileSync(file, 'utf8');
        const hit = text.split('\n').findIndex(line => bad.test(line));
        assert.equal(hit, -1, path.relative(source, file) + ':' + (hit + 1) + ': ' + (text.split('\n')[hit] || '').trim());
    }
});

test('manifest and package agree', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'noggin/package.json'), 'utf8'));
    assert.equal(manifest.name, 'Noggin');
    assert.equal(pkg.name, '@be/noggin');
    assert.equal(manifest.version, pkg.version);
});
