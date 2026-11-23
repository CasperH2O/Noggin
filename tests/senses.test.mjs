// SPDX-License-Identifier: MIT
// What Jibo feels and sees: which petting clip a touch plays (lib/touch.js), and who counts as
// seen (lib/presence.js), with a fake clock.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(import.meta.dirname, '..');
const touch = require(path.join(source, 'noggin/lib/touch.js'));
const Presence = require(path.join(source, 'noggin/lib/presence.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pads = on => [0, 1, 2, 3, 4, 5].map(i => on.indexOf(i) >= 0);

test('touch side: pads 0-2 left, 3-5 right (right wins), the back pad alone a tickle, nothing touched null', () => {
    assert.equal(touch.side(pads([0])), 'left'); assert.equal(touch.side(pads([1, 2])), 'left');
    assert.equal(touch.side(pads([3])), 'right'); assert.equal(touch.side(pads([2, 4])), 'right');
    assert.equal(touch.side(pads([5])), 'tickle'); assert.equal(touch.side(pads([4, 5])), 'right');
    assert.equal(touch.side(pads([])), null); assert.equal(touch.side(null), null); assert.equal(touch.side({}), null);
});

test('touch clip: the emotion system\'s query, a fresh copy for the database, a random match', () => {
    const asked = [], given = {category: 'Touch', includeMeta: ['rub-right']};
    const jibo = {emotion: {reactToHeadTouch: p => { asked.push(p); return given; }},
        animDB: {query: q => { q.includeMeta.push('changed'); return {matching: [{name: 'rub_head_r_01'}, {name: 'rub_head_r_02'}, null]}; }}};
    const clip = touch.clipFor(jibo, pads([3]), () => 0.99);
    assert.deepEqual(clip, {side: 'right', name: 'rub_head_r_02', query: 'Touch/rub-right'});
    assert.equal(asked.length, 1);
    assert.deepEqual(given.includeMeta, ['rub-right'], 'the emotion system\'s answer is left as it was');
    assert.equal(touch.clipFor(jibo, pads([3]), () => 0).name, 'rub_head_r_01');
    assert.equal(touch.clipFor(jibo, pads([]), () => 0), null);
});

test('touch clip: without the emotion system the same queries as Jibo\'s idle skill; nothing found or a throwing database falls back to known clips', () => {
    const seen = [];
    const jibo = {animDB: {query: q => { seen.push(JSON.stringify(q)); return {matching: []}; }}};
    assert.equal(touch.clipFor(jibo, pads([0]), () => 0).name, 'rub_head_l_01');
    assert.equal(touch.clipFor(jibo, pads([5]), () => 0.9).name, 'laughter_02');
    assert.deepEqual(seen, ['{"category":"touch","includeMeta":["rub-left"]}', '{"category":"laughing","includeMeta":[]}']);
    const broken = {emotion: {reactToHeadTouch: () => { throw Error('x'); }}, animDB: {query: () => { throw Error('y'); }}};
    assert.equal(touch.clipFor(broken, pads([4]), () => 0).name, 'rub_head_r_01');
    assert.equal(touch.clipFor({}, pads([1]), () => 0).query, 'touch/rub-left');
});

// BEam's animation database, when this checkout sits in the jibo-resurrection workspace (or JIBO_ANIMDB).
const ANIMDB = process.env.JIBO_ANIMDB || path.resolve(source, '../../../original-assets/BEam/@be/be/node_modules/jibo-anim-db-animations/animdb.json');

test('touch clip: the fallback clips exist in Jibo\'s animation database and end where they started', {skip: !fs.existsSync(ANIMDB) && 'no animdb.json here'}, () => {
    const db = JSON.parse(fs.readFileSync(ANIMDB, 'utf8')), byName = {};
    Object.keys(db).forEach(name => { byName[name.toLowerCase()] = db[name]; });
    Object.keys(touch.FALLBACK).forEach(side => touch.FALLBACK[side].forEach(name => {
        const anim = byName[name.toLowerCase()];
        assert.ok(anim, name + ' is in the database');
        assert.notEqual((anim.meta || anim).endsNeutral, false, name + ' ends neutral');
    }));
});

function clock() { let t = 1000; return {now: () => t, add: ms => { t += ms; }}; }

test('presence: a face counts after 2 s, its name from the family list (nickname first); unknown faces are counted', async () => {
    const c = clock();
    let visible = [{id: 'u1', entityId: 1}, {id: 'UNKNOWN', entityId: 2}];
    const jibo = {lps: {identity: {getVisiblePersons: () => visible}},
        kb: {loop: {getUserNodeById: id => Promise.resolve({u1: {firstName: 'Emma', nickName: 'Em'}}[id] || null)}}};
    const p = new Presence(jibo, c.now);
    p.look();
    assert.deepEqual(p.here(), {names: [], unknown: 0}, 'not yet');
    await sleep(1);
    c.add(2000); p.look();
    assert.deepEqual(p.here(), {names: ['Em'], unknown: 1});
    visible = [];
    c.add(4000); p.look();
    assert.deepEqual(p.here(), {names: ['Em'], unknown: 1}, 'a flap is not leaving');
    c.add(2000); p.look();
    assert.deepEqual(p.here(), {names: ['Em'], unknown: 0}, 'an unknown face is gone after 5 s');
    c.add(15000); p.look();
    assert.deepEqual(p.here(), {names: [], unknown: 0}, 'a known face after 20 s');
});

test('presence: a face recognised after a while stays one face; a name still on its way holds it back at most 3 s', async () => {
    const c = clock();
    let visible = [{id: 'NOT_TRAINED', entityId: 9}], answer = null;
    const jibo = {lps: {identity: {getVisiblePersons: () => visible}},
        kb: {loop: {getUserNodeById: () => new Promise(r => { answer = r; })}}};
    const p = new Presence(jibo, c.now);
    p.look(); c.add(2500); p.look();
    assert.deepEqual(p.here(), {names: [], unknown: 1});
    visible = [{id: 'u2', entityId: 9}];
    p.look(); await sleep(1);
    assert.deepEqual(p.here(), {names: [], unknown: 0}, 'the name is on its way');
    c.add(3100);
    assert.deepEqual(p.here(), {names: [], unknown: 1}, 'a lookup that never answers: unknown');
    answer({firstName: ' Sam '}); await sleep(1);
    assert.deepEqual(p.here(), {names: ['Sam'], unknown: 0});
});

test('presence: without the perception service, a throwing one, or a failed lookup, nothing breaks', async () => {
    const c = clock();
    assert.deepEqual((() => { const p = new Presence({}, c.now); p.look(); return p.here(); })(), {names: [], unknown: 0});
    const p = new Presence({lps: {identity: {getVisiblePersons: () => { throw Error('down'); }}}}, c.now);
    p.look(); assert.deepEqual(p.here(), {names: [], unknown: 0});
    const q = new Presence({lps: {identity: {getVisiblePersons: () => [{id: 'u3', entityId: 1}, null, {id: '', entityId: null}]}},
        kb: {loop: {getUserNodeById: () => Promise.reject(Error('no kb'))}}}, c.now);
    q.look(); await sleep(1); c.add(2000); q.look();
    assert.deepEqual(q.here(), {names: [], unknown: 1});
    assert.equal(Presence.nameOf({firstName: '', nickName: '  '}), null);
    assert.equal(Presence.nameOf({firstName: 'A'.repeat(60)}).length, 40);
});
