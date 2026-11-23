// SPDX-License-Identifier: MIT
// Noggin's background part, started by BEam when Jibo boots and after every install or update
// (package.json jibo.background), inside Be's process with no screen: the settings page on
// http://<jibo>:8131, the memory recap after each conversation (lib/recap.js), and the budget
// check for Jibo's heads-up (lib/budget.js, D74), and "Hey Jibo" opening Noggin when that setting
// is on (lib/hey-jibo.js, D132).
// stop() runs before an update or removal: it frees the port and stops the recap, the check and the
// hotword watch.
'use strict';
const path = require('path');
const createLog = require('./lib/log');
const HOST = '0.0.0.0';
// An update stops the old revision and starts the new one at once; the old socket may still
// hold the port for a moment.
const RETRY_MS = 2000;
const RETRIES = 5;

let server = null, retryTimer = null, stopped = false, recapLoop = null, budgetWatch = null, heyJiboWatch = null;

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
    adoptOldData(log);
    startRecap(log);
    startHeyJibo(log, api);
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
    startBudget(log, server);
    listen(log, 0);
}

// Before anything reads the data folder: an earlier version's data moves to the skill's own folder (D151).
function adoptOldData(log) {
    try { require('./lib/settings').adoptOldData(log); } catch (error) { log.warn('data folder: ' + error.message); }
}

function startBudget(log, owner) {
    try {
        const settings = require('./lib/settings');
        budgetWatch = require('./lib/budget').watch({
            readConfig: () => {
                const loaded = settings.load(settings.dataDir());
                return {budgetWarnPercent: loaded.config.budgetWarnPercent, adminKey: !!loaded.secrets.adminKey};
            },
            report: () => owner.usage(),
            log: log
        });
    } catch (error) {
        log.error('budget check off: ' + error.message);
        budgetWatch = null;
    }
}

// Always watching; the setting is read at every "Hey Jibo", so switching it needs no restart.
function startHeyJibo(log, api) {
    if (heyJiboWatch) { heyJiboWatch.stop(); heyJiboWatch = null; }
    let jibo;
    try { jibo = require('jibo'); } catch (_) { log.warn('hey jibo off: no Jibo SDK in this runtime'); return; }
    try {
        const settings = require('./lib/settings');
        heyJiboWatch = require('./lib/hey-jibo').watch(jibo, api, {
            // Without a key every hotword would open the setup screen and lock Jibo's own commands out.
            enabled: () => {
                const loaded = settings.load(settings.dataDir());
                return loaded.config.heyJibo === true && !!loaded.secrets.apiKey;
            },
            log: log
        });
    } catch (error) {
        log.error('hey jibo off: ' + error.message);
        heyJiboWatch = null;
    }
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
    const current = server, port = require('./lib/settings').PORT;
    if (!current || stopped) return;
    current.listen(port, HOST).then(() => {
        log.info('settings page on port ' + port);
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
    if (budgetWatch) { budgetWatch.stop(); budgetWatch = null; }
    if (heyJiboWatch) { heyJiboWatch.stop(); heyJiboWatch = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    const current = server;
    server = null;
    return current ? current.close() : Promise.resolve();
}

module.exports = {start: start, stop: stop};
