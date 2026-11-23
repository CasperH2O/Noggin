// SPDX-License-Identifier: MIT
// Noggin: who Jibo sees, for notes to the model (D145). Face identification only: identifying a
// voice needs "Hey Jibo", which Noggin turns off. look() reads the faces Jibo's perception service
// sees now; the face events flap frame by frame, so a face counts once it was seen for SEEN_MS
// and is gone after GONE_MS unseen (UNKNOWN_GONE_MS for a face nobody is known by).
// Node 6 / Chrome 53: ES2015 only.
'use strict';

const SEEN_MS = 2000, GONE_MS = 20000, UNKNOWN_GONE_MS = 5000;
// A name lookup that never answers holds the face back at most this long; it then counts as unknown.
const ASK_MS = 3000;
// Ids the perception service gives a face it has not matched to a family member.
const NOT_A_PERSON = ['UNKNOWN', 'NOT_TRAINED', 'NOT_ENROLLED', 'ANYBODY', 'IDENTIFIED'];

// A family member's spoken name: the nickname, else the first name; null when there is none.
function nameOf(node) {
    if (!node) return null;
    const name = [node.nickName, node.firstName].filter(n => typeof n === 'string' && n.trim())[0];
    return name ? name.trim().slice(0, 40) : null;
}

class Presence {
    // jibo; now() in ms.
    constructor(jibo, now) {
        this.jibo = jibo; this.now = now || (() => Date.now());
        this.faces = new Map();   // entity (or id) -> {id, first, last}
        this.names = new Map();   // family member id -> name, null when it has none
        this.asking = new Map();  // ids whose name is still being looked up -> when asked
    }
    look() {
        const identity = this.jibo.lps && this.jibo.lps.identity;
        let visible = [];
        try { visible = identity && typeof identity.getVisiblePersons === 'function' ? identity.getVisiblePersons() || [] : []; } catch (_) { visible = []; }
        const now = this.now();
        (Array.isArray(visible) ? visible : []).forEach(person => {
            if (!person) return;
            const known = typeof person.id === 'string' && !!person.id && NOT_A_PERSON.indexOf(person.id) < 0;
            // By entity, so a face that is recognised after a while stays one face.
            const key = person.entityId !== undefined && person.entityId !== null ? 'entity:' + person.entityId : known ? 'id:' + person.id : null;
            if (!key) return;
            const face = this.faces.get(key) || {id: null, first: now};
            face.last = now;
            if (known) { face.id = person.id; this.lookUp(person.id); }
            this.faces.set(key, face);
        });
        this.faces.forEach((face, key) => {
            if (now - face.last > (face.id ? GONE_MS : UNKNOWN_GONE_MS)) this.faces.delete(key);
        });
    }
    // The name from Jibo's family list, once per id; a failed lookup leaves the person unknown.
    lookUp(id) {
        if (this.names.has(id)) return;
        this.names.set(id, null);
        const loop = this.jibo.kb && this.jibo.kb.loop;
        if (!loop || typeof loop.getUserNodeById !== 'function') return;
        this.asking.set(id, this.now());
        Promise.resolve().then(() => loop.getUserNodeById(id)).then(node => { this.names.set(id, nameOf(node)); }, () => {})
            .then(() => this.asking.delete(id));
    }
    // Who is here now: {names: [sorted, unique], unknown: faces without a name}.
    here() {
        const names = new Set(), now = this.now();
        let unknown = 0;
        this.faces.forEach(face => {
            // Not yet: seen too briefly, or the name is still on its way.
            if (face.last - face.first < SEEN_MS || (face.id && now - (this.asking.has(face.id) ? this.asking.get(face.id) : -Infinity) < ASK_MS)) return;
            const name = face.id ? this.names.get(face.id) : null;
            if (name) names.add(name); else unknown++;
        });
        return {names: Array.from(names).sort(), unknown: unknown};
    }
}
Presence.nameOf = nameOf;
module.exports = Presence;
