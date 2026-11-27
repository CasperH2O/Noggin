// SPDX-License-Identifier: MIT
// Noggin: waiting. A pause, and a deadline for any promise. Pure: no I/O.
// Node 6 / Chrome 53: ES2015 only.
'use strict';

// The promise, or what onTimeout() returns (or throws) once ms have passed first; without
// onTimeout, Error('timeout'). The timer never outlives the answer.
function withTimeout(promise, ms, onTimeout) {
    let timer = null;
    const late = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            if (!onTimeout) return reject(Error('timeout'));
            try { resolve(onTimeout()); } catch (error) { reject(error); }
        }, ms);
    });
    return Promise.race([Promise.resolve(promise), late]).then(value => {
        clearTimeout(timer);
        return value;
    }, error => {
        clearTimeout(timer);
        throw error;
    });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

module.exports = {withTimeout, delay};
