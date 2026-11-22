// SPDX-License-Identifier: MIT
// Jibo's Embodied Listen (his listening look: blue ring, listening eye) as Noggin touches it.
// jibo.embodied is jibo-embodied-dialog's api; its init() puts the running EmbodiedDialog on it as
// _embodied, and _embodied.listen holds the flag that listen.disableOnce() sets (D140).
'use strict';

// The Embodied Listen state machine, or null when this runtime has none.
function state(jibo) {
    try {
        const embodied = jibo && jibo.embodied && jibo.embodied._embodied, listen = embodied && embodied.listen;
        return listen && '_disableOnce' in listen ? listen : null;
    } catch (_) { return null; }
}
// Clears a disableOnce that was not used up; clearing a used one is harmless. False without a state.
function clear(jibo) {
    const listen = state(jibo);
    if (!listen) return false;
    listen._disableOnce = false;
    return true;
}
// True while Embodied Listen rests in its idle state: skipping its look then leaves nothing behind.
function resting(jibo) {
    const listen = state(jibo);
    return !!listen && !!listen._idle && listen.current === listen._idle;
}

module.exports = {state, clear, resting};
