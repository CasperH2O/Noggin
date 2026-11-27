// SPDX-License-Identifier: MIT
// Noggin: listening to events, and state shared between the skill and background.js.
// Node 6 / Chrome 53: ES2015 only.
'use strict';

// Listens to one of Jibo's SDK events (event.on(handler)) or, with a name, to a Node-style
// emitter (emitter.on(name, handler)). Returns the unsubscribe, which never throws, or null when
// there is nothing to listen to. On Jibo's events off() and removeListener() are the same.
function subscribe(event, handler, name) {
    if (!event || typeof event.on !== 'function') return null;
    const args = name === undefined ? [handler] : [name, handler];
    event.on.apply(event, args);
    return () => {
        try { (event.off || event.removeListener).apply(event, args); } catch (_) {}
    };
}

// The value kept on Be's shared `global` under `name`, made by make() the first time (or when
// what is there does not fit). The skill and background.js run in Be's one process but each load
// their own copy of a module, so only `global` is shared between them. Null without a `global`.
function shared(name, make, fits) {
    if (typeof global !== 'object' || !global) return null;
    const current = global[name];
    if (current && (!fits || fits(current))) return current;
    return (global[name] = make());
}

module.exports = {subscribe, shared};
