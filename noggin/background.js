// SPDX-License-Identifier: MIT
// Noggin's background part, started by BEam when Jibo boots and after every install or update
// (package.json jibo.background), inside Be's process with no screen: the settings page on
// http://<jibo>:8131, and the memory recap after each conversation (lib/recap.js).
// stop() runs before an update or removal: it frees the port and stops the recap.
'use strict';
const path = require('path');
const createLog = require('./lib/log');
const PORT = 8131;
const HOST = '0.0.0.0';
// An update stops the old revision and starts the new one at once; the old socket may still
// hold the port for a moment.
const RETRY_MS = 2000;
const RETRIES = 5;

let server = null, retryTimer = null, stopped = false, recapLoop = null;

// Jibo's own logger reaches /var/log/messages; BEam's api.log only reaches the console.
function logger(api) {
    try {
        const jiboLog = require('jibo').log;
        if (jiboLog && typeof jiboLog.createChild === 'function') return createLog(jiboLog.createChild('Noggin.Settings'));
    } catch (_) {}
    return createLog(api && api.log);
}

// Jibo's local time in his home timezone, as the skill sees it.
function localTime() {
    const actions = require('./lib/actions');
    let jibo = null;
    try { jibo = require('jibo'); } catch (_) {}
    return ms => actions.localTime(jibo, ms);
}

function start(api) {
    const log = logger(api);
    stopped = false;
    startRecap(log);
    let http;
    try { http = require('http'); } catch (_) { http = null; }
    if (!http || typeof http.createServer !== 'function') {
        log.warn('settings page off: no HTTP server in this runtime');
        return;
    }
    try {
        const settings = require('./lib/settings');
        server = require('./lib/server').create({
            dataDir: settings.dataDir,
            webDir: path.join(__dirname, 'web'),
            version: require('./package.json').version,
            local: localTime(),
            log: log,
            http: http
        });
    } catch (error) {
        log.error('settings page off: ' + error.message);
        server = null;
        return;
    }
    listen(log, 0);
}

function startRecap(log) {
    try {
        const settings = require('./lib/settings');
        recapLoop = require('./lib/recap').loop({
            dataDir: settings.dataDir(),
            readConfig: () => settings.read(settings.dataDir()),
            poster: config => require('./lib/openai').poster(config),
            local: localTime(),
            log: log
        });
    } catch (error) {
        log.error('memory recap off: ' + error.message);
        recapLoop = null;
    }
}

function listen(log, attempt) {
    const current = server;
    if (!current || stopped) return;
    current.listen(PORT, HOST).then(() => {
        log.info('settings page on port ' + PORT);
    }, error => {
        if (stopped || server !== current) return;
        if (error.code === 'EADDRINUSE' && attempt < RETRIES) {
            retryTimer = setTimeout(() => { retryTimer = null; listen(log, attempt + 1); }, RETRY_MS);
            return;
        }
        log.error('settings page off: ' + error.message);
    });
}

function stop() {
    stopped = true;
    if (recapLoop) { recapLoop.stop(); recapLoop = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const current = server;
    server = null;
    return current ? current.close() : Promise.resolve();
}

module.exports = {start: start, stop: stop, PORT: PORT};
