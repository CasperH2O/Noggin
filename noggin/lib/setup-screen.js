// SPDX-License-Identifier: MIT
// Noggin: the setup screen (D72). When Noggin has no working key or its settings are wrong,
// Jibo shows a QR code to his settings page's Brain tab, in the classic look: black background,
// a bold title, numbered cyan steps, the code on a white plate, the address and the cause in grey.
// It ends on swipe down, a tap, WAIT_MS, or once `ready()` says the settings now work.
// Node 6 / Chrome 53: ES2015 only.
'use strict';
const qrcode = require('../vendor/qrcode');
const PORT = require('./settings').PORT;

const WAIT_MS = 3 * 60000;
const POLL_MS = 2000;
const CLOSE_MS = 2000;   // a view change that never ends must not keep the screen open
const COLOR = {background: 0x000000, text: '#FFFFFF', caption: '#828191', accent: '#25F2FB'};
const FONT = {title: 'Proxima Nova Soft', body: 'Proxima Nova Light'};
// 1280x720; everything stays inside the screen's 52 px margin. The title and the two grey lines
// run the full width: the plate sits between them (y 170-522).
const LAYOUT = {
    title: {x: 112, y: 104, size: 80, width: 1056},
    steps: {x: 112, top: 192, gap: 20, badge: 56, badgeSize: 36, textX: 190, width: 580, size: 40, line: 50},
    plate: {x: 808, y: 170, size: 352, radius: 20, padding: 24},
    address: {x: 112, y: 596, size: 36, width: 1056},
    detail: {x: 112, y: 642, size: 30, width: 1000}
};

function link(address) { return address ? 'http://' + address + ':' + PORT + '/#brain' : null; }

// What the screen says for a cause (lib/trouble.js) and Jibo's address (null: no QR code).
function content(cause, address) {
    return {
        title: cause.title,
        steps: [address ? 'Scan the code with your phone\'s camera' : 'Open my settings page in a browser', cause.step, 'Press Save, and I\'m ready to talk'],
        address: address ? 'Or open ' + address + ':' + PORT + ' in a browser' : 'My settings page is on port ' + PORT + ' of my address',
        detail: cause.detail,
        link: link(address)
    };
}
// Where each step's badge and text go: two lines of text each.
function stepAt(index) {
    const s = LAYOUT.steps, y = s.top + index * (2 * s.line + s.gap);
    return {badge: {x: s.x, y: y}, text: {x: s.textX, y: y + 4}};
}
// The QR modules on the plate: whole pixels, a two-module quiet zone inside the padding.
function qrGeometry(count) {
    const inner = LAYOUT.plate.size - 2 * LAYOUT.plate.padding, cell = Math.floor(inner / (count + 4));
    return {inner: inner, cell: cell, start: Math.floor((inner - cell * count) / 2)};
}
function encode(text) {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    return code;
}

class SetupScreen {
    // options: {ready() -> true once the settings work, log, waitMs, pollMs}
    constructor(jibo, options) {
        this.jibo = jibo; this.options = options || {};
        this.view = null; this.done = null; this.finished = false; this.timers = []; this.textures = [];
    }
    // Resolves how it ended: 'saved', 'swipe', 'tap', 'timeout', 'closed' (another view or the
    // skill closing), 'error' or 'unavailable' (no view system here). Never rejects.
    show(cause, address) {
        if (this.done) return this.done;
        const jibo = this.jibo, views = jibo.face && jibo.face.views, PIXI = global.PIXI;
        if (!views || typeof views.createView !== 'function' || typeof views.changeView !== 'function' || !PIXI || typeof document === 'undefined')
            return (this.done = Promise.resolve('unavailable'));
        const text = this.text = content(cause, address);
        this.done = new Promise(resolve => { this.resolve = resolve; });
        // From the start, not from opened(): a view that never opens still ends.
        this.timers.push(setTimeout(() => this.finish('timeout'), this.options.waitMs || WAIT_MS));
        try {
            const view = this.view = views.createView('View', this.config(views, text));
            // Ours owns live callbacks: never rebuilt from a snapshot.
            view.viewStateStacked = true;
            view.addAction(views.ActionData.CALLBACK, {callback: () => this.finish('swipe')}, true, false, views.GESTURE.SWIPE_DOWN);
            views.changeView({addView: view, transitionOpen: views.TRANSITION.IN, transitionClose: views.TRANSITION.OUT},
                () => this.opened(), () => this.finish('closed'), () => this.decorate(PIXI));
        } catch (error) {
            this.log('setup screen failed: ' + error.message);
            this.finish('error');
        }
        return this.done;
    }
    opened() {
        if (this.finished) return;
        const o = this.options;
        if (o.ready) this.timers.push(setInterval(() => {
            let ok = false;
            try { ok = !!o.ready(); } catch (_) {}
            if (ok) this.finish('saved');
        }, o.pollMs || POLL_MS));
    }
    config(views, text) {
        const components = [], L = LAYOUT;
        const label = (id, value, x, y, size, width, options) => {
            options = options || {};
            const style = {fontFamily: options.bold ? FONT.title : FONT.body, fontSize: size, fill: options.fill || COLOR.text, align: 'left',
                fontWeight: options.bold ? 'bold' : 'normal'};
            if (options.lines) { style.wordWrap = true; style.wordWrapWidth = width; style.lineHeight = options.line; }
            components.push({type: 'Label', id: id, text: value || ' ', position: {x: x, y: y}, targetAnchor: {x: 0, y: options.lines ? 0 : 0.5},
                bounds: {width: width, height: options.lines ? options.lines * options.line + size * 0.6 : size * 1.6}, style: style});
        };
        label('title', text.title, L.title.x, L.title.y, L.title.size, L.title.width, {bold: true});
        text.steps.forEach((step, index) => {
            const at = stepAt(index);
            label('step' + index, step, at.text.x, at.text.y, L.steps.size, L.steps.width, {lines: 2, line: L.steps.line});
        });
        label('address', text.address, L.address.x, L.address.y, L.address.size, L.address.width, {fill: COLOR.caption});
        label('detail', text.detail, L.detail.x, L.detail.y, L.detail.size, L.detail.width, {fill: COLOR.caption});
        // A tap anywhere closes the screen.
        components.push({type: 'Button', id: 'tap', assets: [], position: {x: 0, y: 0}, hitArea: {x: 0, y: 0, width: 1280, height: 720},
            action: {type: views.ActionData.CALLBACK, data: {callback: () => this.finish('tap')}}});
        return {viewConfig: {type: 'View', id: 'noggin-setup', category: 'gui', ignoreSwipeDown: true, transitionStageOnly: true}, componentConfigs: components};
    }
    // Painted under the SDK's labels: background, step badges, the plate and the QR code.
    decorate(PIXI) {
        const view = this.view;
        if (this.finished || !view || !view.stage || this.layer) return;
        try {
            const layer = this.layer = new PIXI.Container(), L = LAYOUT;
            const background = new PIXI.Graphics();
            background.beginFill(COLOR.background); background.drawRect(0, 0, 1280, 720); background.endFill();
            layer.addChild(background);
            this.text.steps.forEach((_step, index) => {
                const at = stepAt(index).badge;
                layer.addChild(this.sprite(PIXI, this.paint(L.steps.badge, L.steps.badge, ctx => badge(ctx, index + 1)), at.x, at.y));
            });
            if (this.text.link) {
                const code = encode(this.text.link), g = qrGeometry(code.getModuleCount()), p = L.plate;
                layer.addChild(this.sprite(PIXI, this.paint(p.size, p.size, ctx => {
                    rounded(ctx, 0, 0, p.size, p.size, p.radius); ctx.fillStyle = '#FFFFFF'; ctx.fill();
                    ctx.fillStyle = '#000000';
                    const count = code.getModuleCount(), at = p.padding + g.start;
                    for (let y = 0; y < count; ++y) for (let x = 0; x < count; ++x) if (code.isDark(y, x)) ctx.fillRect(at + x * g.cell, at + y * g.cell, g.cell, g.cell);
                }), p.x, p.y));
            }
            view.stage.addChildAt(layer, 0);
        } catch (error) {
            this.log('setup screen drawing failed: ' + error.message);
        }
    }
    paint(width, height, draw) {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        draw(canvas.getContext('2d'));
        const texture = global.PIXI.Texture.fromCanvas(canvas);
        this.textures.push(texture);
        return texture;
    }
    sprite(PIXI, texture, x, y) { const item = new PIXI.Sprite(texture); item.position.set(x, y); return item; }
    log(message) { const log = this.options.log; if (log && log.warn) log.warn(message); }
    // Idempotent: stops the timers, takes the view away (removed when it is Jibo's current view,
    // else disposed as a hidden one), frees the painted textures, then resolves show() with the reason.
    finish(reason) {
        if (this.finished) return this.closing;
        this.finished = true;
        this.timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); });
        this.timers = [];
        const views = this.jibo.face && this.jibo.face.views, view = this.view;
        const removed = view && views ? this.removeView(views, view) : Promise.resolve();
        this.closing = removed.catch(error => this.log('setup screen not removed: ' + error.message)).then(() => {
            if (this.layer) { try { if (this.layer.parent) this.layer.parent.removeChild(this.layer); this.layer.destroy({children: true}); } catch (_) {} }
            this.textures.forEach(texture => { try { texture.destroy(true); } catch (_) {} });
            this.textures = []; this.layer = null; this.view = null;
            if (this.resolve) this.resolve(reason);
        });
        return this.closing;
    }
    // A view still sliding in is not current yet, and a covered one would come back when the view
    // on top goes: wait for the view change to end (at most CLOSE_MS), then remove or dispose it.
    removeView(views, view) {
        const started = Date.now();
        const busy = () => !!(views._viewProcess && (views._viewProcess.active || views._viewProcess.processQueue && views._viewProcess.processQueue.length));
        const settled = () => new Promise(resolve => {
            const look = () => (!busy() || Date.now() - started >= CLOSE_MS ? resolve() : setTimeout(look, 50));
            look();
        });
        return settled().then(() => {
            if (views.currentView === view) {
                return Promise.race([new Promise(resolve => {
                    try {
                        views.changeView({remove: true, leaveEmpty: views.viewStackLength === 1, transitionClose: views.TRANSITION.OUT}, resolve, resolve);
                    } catch (_) { resolve(); }
                }), new Promise(resolve => setTimeout(resolve, CLOSE_MS))]);
            }
            if (view.state === 'destroyed') return;
            // Disposing during a running view change would corrupt the manager's stack.
            if (busy()) throw Error('the view change did not end');
            disposeHidden(views, this.jibo.face.tween, view);
        });
    }
    close() { return this.finish('closed'); }
}

// A view that is not the current one: the manager's own removal would act on the current view,
// so unlink it from the stack and destroy its components and stage directly (as BEam's touch
// apps do for a hidden view without assets). Throws when the SDK lacks what this needs.
function disposeHidden(views, tween, view) {
    if (!views.ComponentGroup || !views.ComponentGroup.prototype.destroy || !views.STATE) throw Error('no hidden view disposal in this SDK');
    const seen = [];
    for (let cursor = views.currentView; cursor; cursor = cursor.pausedParent) {
        if (seen.indexOf(cursor) >= 0) throw Error('view parent cycle');
        seen.push(cursor);
        if (cursor.pausedParent === view) cursor.pausedParent = view.pausedParent;
    }
    view.pausedParent = null;
    view.status = views.STATE.DESTROYED;
    views.ComponentGroup.prototype.destroy.call(view);
    if (view.pauseOverlay) { view.pauseOverlay.destroy(); view.pauseOverlay = null; }
    if (view.stage) {
        if (tween && typeof tween.stop === 'function') tween.stop(view.stage);
        if (view.stage.parent) view.stage.parent.removeChild(view.stage);
        view.stage.destroy({children: true});
    }
}

function rounded(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius); ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius); ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}
function badge(ctx, number) {
    const s = LAYOUT.steps, r = s.badge / 2;
    ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.fillStyle = COLOR.accent; ctx.fill();
    ctx.fillStyle = '#000000'; ctx.font = 'bold ' + s.badgeSize + 'px "' + FONT.title + '"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(number), r, r + 1);
}

SetupScreen.content = content;
SetupScreen.link = link;
SetupScreen.stepAt = stepAt;
SetupScreen.qrGeometry = qrGeometry;
SetupScreen.encode = encode;
SetupScreen.LAYOUT = LAYOUT;
SetupScreen.WAIT_MS = WAIT_MS;
module.exports = SetupScreen;
