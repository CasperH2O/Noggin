'use strict';
// Jibo looks up, then centres again: a stock pose on the BODY channels only (the screen is left
// alone), with the attention mode OFF meanwhile so he does not turn straight back to a face.
//
// The rule that keeps him from getting stuck: whatever happens (an error, a pose that never ends,
// a close halfway), close() stops the pose, centres the body and releases the attention mode.
// Same order as BEam's own music dancer: stop the playback, clean up the body, release attention.
// The attention push is kept as a promise, so a release that comes while the push is still under
// way waits for it instead of missing it.

var POSE = 'Body_Look_Center_Up_01';
var PLAY_MS = 6000;      // the longest a pose may take before we stop waiting for it
var CENTRE_MS = 4000;    // the longest centring may take

// Resolves with the promise, or after ms when it never settles: no wait in here is unbounded.
function bounded(promise, ms) {
    return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(Error('timeout')); }, ms);
        if (timer && typeof timer.unref === 'function') timer.unref();   // never keeps a Node process alive
        Promise.resolve(promise).then(function (value) { clearTimeout(timer); resolve(value); },
            function (error) { clearTimeout(timer); reject(error); });
    });
}

function Motion(jibo, log) {
    this.jibo = jibo;
    this.log = log || {warn: function () {}};
    this.attention = null;   // a promise of the pushed attention handle, while held
    this.playing = null;     // the pose that is playing
    this.busy = null;        // the move under way, so that centre() runs after it
    this.moved = false;      // the body may be off centre
    this.closed = false;
}
Motion.prototype.available = function () {
    var j = this.jibo, ex = j && j.expression;
    return !!(ex && ex.dofs && ex.dofs.BODY && j.animDB && typeof j.animDB.getAnimByName === 'function');
};
// direction: 'up' or 'centre'. Without the APIs, or once closed, there is simply no movement.
Motion.prototype.move = function (direction) {
    if (this.closed || !this.available()) return Promise.resolve();
    return direction === 'up' ? this.up() : this.centre();
};
Motion.prototype.up = function () {
    var self = this, j = this.jibo, BODY = j.expression.dofs.BODY;
    this.hold();
    this.moved = true;
    this.busy = Promise.resolve(this.attention).then(function () {
        if (self.closed) return null;
        var pose = j.animDB.getAnimByName(POSE);
        if (!pose || typeof pose.play !== 'function') throw Error('pose missing: ' + POSE);
        var playing = self.playing = pose.play({cache: j.loader && j.loader.activeCache, dofs: BODY});
        return bounded(playing && playing.result, PLAY_MS);
    }).catch(function (error) {
        self.log.warn('look up:', error && error.message || error);
    }).then(function () { self.playing = null; });
    return this.busy;
};
Motion.prototype.centre = function () {
    var self = this;
    return Promise.resolve(this.busy).then(function () {
        if (self.closed) return null;
        return bounded(self.cleanup(), CENTRE_MS);
    }).catch(function (error) {
        self.log.warn('centre:', error && error.message || error);
    }).then(function () { self.moved = false; self.release(); });
};
// Pushes attention OFF once per hold.
Motion.prototype.hold = function () {
    var ex = this.jibo.expression;
    if (this.attention || typeof ex.pushAttentionMode !== 'function' || !ex.AttentionMode) return;
    this.attention = Promise.resolve().then(function () {
        return ex.pushAttentionMode(ex.AttentionMode.OFF);
    }).catch(function () { return null; });
};
Motion.prototype.release = function () {
    var held = this.attention;
    this.attention = null;
    if (!held) return;
    held.then(function (handle) {
        if (handle && typeof handle.release === 'function') handle.release();
    }).catch(function () {});
};
// Brings the body back to centre: expression.cleanup where the SDK has it, else centerRobot.
Motion.prototype.cleanup = function () {
    var ex = this.jibo.expression, BODY = ex.dofs.BODY;
    if (typeof ex.cleanup === 'function') return ex.cleanup({dofs: BODY});
    if (typeof ex.centerRobot === 'function') return ex.centerRobot({dofs: BODY});
    return null;
};
Motion.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    var playing = this.playing;
    this.playing = null;
    var stop = playing && (playing.playback && playing.playback.stop ? playing.playback : playing);
    try { if (stop && typeof stop.stop === 'function') stop.stop(); } catch (_) {}
    if (this.moved && this.available()) {
        try { Promise.resolve(this.cleanup()).catch(function () {}); } catch (_) {}
    }
    this.moved = false;
    this.release();
};

module.exports = {Motion: Motion, POSE: POSE, PLAY_MS: PLAY_MS, CENTRE_MS: CENTRE_MS};
