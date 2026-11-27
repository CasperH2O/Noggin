// SPDX-License-Identifier: MIT
// One JSON request over Node's http or https. Every request ends: on its answer, on an error,
// after timeoutMs, or when the caller aborts it.
// Node 6 / Chrome 53: ES2015 only.
'use strict';

const TIMEOUT_MS = 10000;
const MAX_BYTES = 1024 * 1024;

// options: {url or target ({protocol, hostname, port, path}), method (GET), headers, body (sent
// as JSON), timeoutMs, timeoutMessage ('timeout'), maxBytes (1 MB), agent, transport (http or
// https module; by the protocol otherwise), track(abort), watch(request, startedMs)}.
// Resolves {status, json, ms}: json is null when the answer is not JSON. Rejects with the
// request's own error (with its code), Error(timeoutMessage), Error('answer too large') or,
// through track's abort(reason), Error(reason || 'stopped').
function requestJson(options) {
    return new Promise((resolve, reject) => {
        const target = options.target || require('url').parse(options.url);
        const transport = options.transport || require(target.protocol === 'https:' ? 'https' : 'http');
        const maxBytes = options.maxBytes || MAX_BYTES, started = Date.now();
        const headers = Object.assign({Accept: 'application/json'}, options.headers);
        const data = options.body === undefined || options.body === null ? null : JSON.stringify(options.body);
        if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        let request = null, timer = null, done = false;
        const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (error) reject(error); else resolve(value);
        };
        const abort = reason => {
            try { if (request) request.abort(); } catch (_) {}
            finish(Error(reason || 'stopped'));
        };
        const answered = response => {
            const parts = [];
            let size = 0;
            response.on('data', chunk => {
                if (done) return;
                size += chunk.length;
                if (size > maxBytes) abort('answer too large');
                else parts.push(chunk);
            });
            response.on('end', () => {
                let json = null;
                try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch (_) {}
                finish(null, {status: response.statusCode, json: json, ms: Date.now() - started});
            });
            response.on('error', error => finish(error));
        };
        try {
            request = transport.request({method: options.method || 'GET', protocol: target.protocol, hostname: target.hostname, port: target.port,
                path: target.path, agent: options.agent, headers: headers}, answered);
        } catch (error) { return finish(error); }
        if (options.watch) options.watch(request, started);
        request.on('error', error => finish(error));
        timer = setTimeout(() => abort(options.timeoutMessage || 'timeout'), options.timeoutMs || TIMEOUT_MS);
        if (options.track) options.track(abort);
        if (data === null) request.end(); else request.end(data);
    });
}

module.exports = {requestJson, TIMEOUT_MS, MAX_BYTES};
