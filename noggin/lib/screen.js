'use strict';
// Noggin's face UI: one SDK View with a title, a line of text and one button, in the platform's
// look (layout.js). The button makes Jibo look up (motion.js); swipe down closes the app.
//
// Keep the open/close handling when the screen grows: close always clears this.view, even when
// the SDK cannot remove it, and open waits for a close that is still running. A view left set
// makes the next opening a dead one.
var layout = require('./layout'), createLog = require('./log'), Motion = require('./motion').Motion;

var CLOSE_MS = 3000;     // our own limit for removing the view, shorter than Be's 5 s force-close
var LOOK_MS = 2500;      // how long Jibo looks up before he centres again

function STOCK(name) { return 'core://resources/actionIcons/' + name + '.png'; }

// deps: {onClose} from the host wrapper (Phoenix releases its focus leases there);
// {Motion, closeMs, timers} for tests.
module.exports = function createScreen(jibo, BeSkill, deps) {
    deps = deps || {};
    var onClose = deps.onClose || function () {};
    var MotionClass = deps.Motion || Motion, closeMs = deps.closeMs || CLOSE_MS;
    // Wrapped: the browser's own timer functions throw "Illegal invocation" when called as methods.
    var timers = deps.timers || {
        setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
        clearTimeout: function (id) { clearTimeout(id); }
    };

    return class NogginSkill extends BeSkill {
        constructor() {
            super(...arguments);
            this.diagnostics = createLog(this.log);
            this.view = null;        // the SDK view of this opening
            this.closing = null;     // the close in flight (a promise)
            this.leaving = false;    // exit() has been asked for
            this.motion = null;
            this.lookTimer = null;
        }
        open() {
            var self = this, views = jibo.face.views;
            if (this.closing) {
                this.diagnostics.warn('open while the last close is still running: waiting for it');
                this.closing.then(function () { self.open(); }, function () { self.open(); });
                return;
            }
            if (this.view) {
                this.diagnostics.warn('dropping a view left from the last opening');
                this.halt();
                this.view = null;
            }
            this.leaving = false;
            if (!views || !views.createView || !views.changeView) { this.leave(); return; }
            this.motion = new MotionClass(jibo, this.diagnostics);
            var view = this.view = views.createView('View', this.config(views));
            view.viewStateStacked = true;
            view.addAction(views.ActionData.CALLBACK, {callback: function () { self.leave(); }}, true, false, views.GESTURE.SWIPE_DOWN);
            views.changeView({addView: view, transitionOpen: views.TRANSITION.IN, transitionClose: views.TRANSITION.OUT},
                function () { self.diagnostics.info('opened'); },
                function () {
                    self.diagnostics.warn('the view failed to open');
                    if (self.view === view) self.leave();
                });
        }
        config(views) {
            var self = this, L = layout;
            function label(id, value, spec, fontFamily, fill) {
                return {type: 'Label', id: id, text: value, position: {x: spec.x, y: spec.y}, targetAnchor: {x: 0.5, y: 0.5},
                    bounds: {width: spec.width, height: spec.size * 1.6},
                    style: {fontFamily: fontFamily, fontSize: spec.size, fill: fill, align: 'center'}};
            }
            var b = L.button;
            var viewConfig = {type: 'View', id: 'noggin', category: 'gui', ignoreSwipeDown: true, transitionStageOnly: true};
            return {viewConfig: viewConfig, componentConfigs: [
                label('title', L.text.title, L.title, L.font.title, L.color.text),
                label('body', L.text.body, L.body, L.font.body, L.color.muted),
                {type: 'ActionButton', id: 'look', iconSrc: STOCK('play'), colors: L.pairs.action,
                    position: {x: b.x - b.size / 2, y: b.y - b.size / 2},
                    action: {type: views.ActionData.CALLBACK, data: {callback: function () { self.lookUp(); }}}}
            ]};
        }
        lookUp() {
            if (!this.view || this.closing || this.leaving || !this.motion) return;
            var self = this;
            this.diagnostics.info('look up');
            timers.clearTimeout(this.lookTimer);
            this.motion.move('up');
            this.lookTimer = timers.setTimeout(function () {
                self.lookTimer = null;
                if (self.motion) self.motion.move('centre');
            }, LOOK_MS);
        }
        leave() {
            if (this.leaving) return;
            this.leaving = true;
            this.exit({noElementsOfSurprise: true});
        }
        // Stops everything this opening started. Safe to call more than once.
        halt() {
            timers.clearTimeout(this.lookTimer);
            this.lookTimer = null;
            if (this.motion) { this.motion.close(); this.motion = null; }
        }
        close(done) {
            done = done || function () {};
            if (this.closing) { this.closing.then(function () { done(); }, done); return; }
            var self = this;
            this.halt();
            try { onClose(); } catch (error) { this.diagnostics.warn('onClose:', error && error.message || error); }
            this.closing = Promise.resolve().then(function () {
                var views = jibo.face.views, view = self.view;
                if (!view) return null;
                if (views.currentView !== view) {
                    if (view.state !== 'destroyed') self.disposeHidden(views, view);
                    return null;
                }
                return new Promise(function (resolve, reject) {
                    var timer = timers.setTimeout(function () { reject(Error('noggin_view_close_timeout')); }, closeMs);
                    views.changeView({remove: true, leaveEmpty: views.viewStackLength === 1, transitionClose: views.TRANSITION.OUT},
                        function () { timers.clearTimeout(timer); resolve(); },
                        function () { timers.clearTimeout(timer); reject(Error('noggin_view_close_failed')); });
                });
            }).then(function () { self.view = null; }, function (error) {
                self.diagnostics.warn('close:', error && error.message || error);
                self.view = null;
                throw error;
            });
            this.closing.then(function () {
                self.closing = null; self.leaving = false; done();
            }, function (error) {
                self.closing = null; self.leaving = false; done(error);
            });
        }
        // Another view covers ours (for example "Hey Jibo"): tear down only our own hidden view.
        // This uses the SDK's private view internals; it throws when they are not as expected.
        disposeHidden(views, view) {
            var process = views._viewProcess, tween = jibo.face.tween;
            if (!process || process.active || process.processQueue && process.processQueue.length ||
                !views.ComponentGroup || !views.STATE || !tween || typeof tween.stop !== 'function' || !view.viewStateStacked)
                throw Error('noggin_hidden_view_cleanup_unavailable');
            var visited = [], parents = [], cursor = views.currentView;
            while (cursor) {
                if (visited.indexOf(cursor) >= 0) throw Error('noggin_view_parent_cycle');
                visited.push(cursor);
                if (cursor.pausedParent === view) parents.push(cursor);
                cursor = cursor.pausedParent;
            }
            parents.forEach(function (parent) { parent.pausedParent = view.pausedParent; });
            view.pausedParent = null;
            view.status = views.STATE.DESTROYED;
            views.ComponentGroup.prototype.destroy.call(view);
            if (view.stage) {
                tween.stop(view.stage);
                if (view.stage.parent) view.stage.parent.removeChild(view.stage);
                view.stage.destroy({children: true});
            }
            if (view.pauseOverlay) view.pauseOverlay.destroy();
            view.pauseOverlay = null; view._stage = null; view._viewManager = null; view._viewState = null;
        }
        destroy(done) { this.close(error => super.destroy(baseError => done(error || baseError))); }
    };
};
