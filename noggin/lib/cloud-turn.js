// SPDX-License-Identifier: MIT
// Asking Jibo's cloud a fixed phrase as if the person had said it after "Hey Jibo", the way
// BEam's main menu opens the weather or a joke: disableOnce() keeps the listening look away for
// that pretend "Hey Jibo". If the pretend turn never comes, release() clears disableOnce again,
// or it would swallow the listening look of the next real "Hey Jibo" (as the main menu does).
// Node 6: ES2015 only.
'use strict';

// jibo: the SDK; dialog(): jibo-embodied-dialog, loaded only when needed.
function create(jibo, dialog) {
    let held = false;
    return {
        ask(phrase) {
            const js = jibo.jetstream, listen = jibo.embodied && jibo.embodied.listen;
            if (!js || typeof js.mimicGlobalTurn !== 'function') return Promise.reject(Error('no mimicGlobalTurn'));
            try { if (listen && typeof listen.disableOnce === 'function') { listen.disableOnce(); held = true; } } catch (_) {}
            return Promise.resolve(js.mimicGlobalTurn({clientASR: phrase}));
        },
        // The cloud's turn came and used disableOnce up.
        used() { held = false; },
        // Clearing an already used disableOnce is harmless, so every give-up path may call this.
        release() {
            if (!held) return;
            held = false;
            try {
                const embodied = dialog()._embodied;
                if (embodied && embodied.listen) embodied.listen._disableOnce = false;
            } catch (_) {}
        },
        held: () => held
    };
}

module.exports = {create};
