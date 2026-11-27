// SPDX-License-Identifier: MIT
// Noggin's settings page, the Usage tab: what Jibo's OpenAI use costs (GET /api/usage), fetched
// when the tab opens and on Refresh (the robot caches it, D64), and how often he talks (GET /api/stats).
// Plain browser JavaScript, ES2015, no libraries; loaded after app.js.
(function () {
    'use strict';
    const page = window.NogginPage;
    const el = page.el, request = page.request, render = page.render, settingsPanel = page.settingsPanel, updateSaveBar = page.updateSaveBar;

    let usage = null;          // the last answer of GET /api/usage, shown while a new one loads
    let usageWanted = true;    // ask on the next Usage panel: the tab was opened or a key was saved (D64)
    function money(value, currency) {
        const code = String(currency || 'usd').toUpperCase();
        if (value > 0 && value < 0.01) return '<' + money(0.01, currency);
        try { return value.toLocaleString(undefined, {style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2}); }
        catch (_) { return value.toFixed(2) + ' ' + code; }
    }
    function tokens(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
        if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
        return String(Math.round(n));
    }
    // What a model or feature used: tokens, audio minutes for per-minute models, or both.
    function amountUsed(x) {
        const s = Math.round(x.seconds || 0);
        if (!s) return tokens(x.tokens) + ' tokens';
        const audio = audioTime(s) + ' of audio';
        return x.tokens ? tokens(x.tokens) + ' tokens · ' + audio : audio;
    }
    function audioTime(seconds) {
        if (seconds < 60) return seconds + ' s';
        if (seconds < 600) return (seconds / 60).toFixed(1) + ' min';
        return Math.round(seconds / 60) + ' min';
    }
    function dayName(day, today) {
        if (day === today) return 'Today';
        const d = new Date(day + 'T12:00:00Z');
        return d.toLocaleDateString(undefined, {weekday: 'short', timeZone: 'UTC'});
    }
    function ago(ms) {
        const minutes = Math.round((Date.now() - ms) / 60000);
        return minutes < 1 ? 'just now' : minutes === 1 ? '1 minute ago' : minutes + ' minutes ago';
    }
    // A monotone cubic through the points: slightly curved, never past a point or below zero (D68).
    function curve(points) {
        const n = points.length;
        if (n < 2) return n ? 'M' + points[0].x + ',' + points[0].y : '';
        const dx = [], slope = [], tangent = [];
        for (let i = 0; i < n - 1; i++) { dx[i] = points[i + 1].x - points[i].x; slope[i] = (points[i + 1].y - points[i].y) / dx[i]; }
        tangent[0] = slope[0]; tangent[n - 1] = slope[n - 2];
        for (let i = 1; i < n - 1; i++) {
            tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0
                : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / slope[i - 1] + (dx[i] + 2 * dx[i - 1]) / slope[i]);
        }
        let d = 'M' + points[0].x.toFixed(1) + ',' + points[0].y.toFixed(1);
        for (let i = 0; i < n - 1; i++) {
            const h = dx[i] / 3;
            d += ' C' + (points[i].x + h).toFixed(1) + ',' + (points[i].y + tangent[i] * h).toFixed(1) + ' ' + (points[i + 1].x - h).toFixed(1) + ',' +
                (points[i + 1].y - tangent[i + 1] * h).toFixed(1) + ' ' + points[i + 1].x.toFixed(1) + ',' + points[i + 1].y.toFixed(1);
        }
        return d;
    }
    function niceMax(value) {
        if (!(value > 0)) return 1;
        const step = Math.pow(10, Math.floor(Math.log10(value))), r = value / step;
        return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * step;
    }
    // One series per chart, a day per point; hover or tap a day for its value.
    function dayChart(title, days, today, valueOf, format) {
        const box = el('div', {class: 'chart'});
        const tip = el('div', {class: 'chart-tip', hidden: true});
        const svgNS = 'http://www.w3.org/2000/svg';
        const node = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); Object.keys(attrs).forEach(k => n.setAttribute(k, attrs[k])); return n; };
        function draw() {
            const width = Math.max(280, box.clientWidth || 600), height = 180, left = 52, right = 14, top = 14, bottom = 26;
            const values = days.map(valueOf), max = niceMax(Math.max.apply(null, values));
            const x = i => left + (days.length === 1 ? 0 : i * (width - left - right) / (days.length - 1));
            const y = v => top + (1 - v / max) * (height - top - bottom);
            const svg = node('svg', {viewBox: '0 0 ' + width + ' ' + height, height: height, role: 'img', 'aria-label': title});
            [0, 0.5, 1].forEach(f => {
                svg.appendChild(node('line', {class: 'grid', x1: left, x2: width - right, y1: y(max * f), y2: y(max * f)}));
                const label = node('text', {x: left - 8, y: y(max * f) + 4, 'text-anchor': 'end'});
                label.textContent = format(max * f, true);
                svg.appendChild(label);
            });
            const points = values.map((v, i) => ({x: x(i), y: y(v)}));
            const line = curve(points);
            svg.appendChild(node('path', {class: 'area', d: line + ' L' + x(days.length - 1) + ',' + y(0) + ' L' + x(0) + ',' + y(0) + ' Z'}));
            svg.appendChild(node('path', {class: 'line', d: line}));
            const cross = node('line', {class: 'cross', y1: top, y2: y(0), visibility: 'hidden'});
            svg.appendChild(cross);
            const dots = points.map(p => { const c = node('circle', {class: 'dot', cx: p.x, cy: p.y, r: 4}); svg.appendChild(c); return c; });
            // Narrow: every other day, counted back from today, so the labels never touch.
            days.forEach((d, i) => {
                if (width < 480 && (days.length - 1 - i) % 2) return;
                const label = node('text', {x: x(i), y: height - 6, 'text-anchor': i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'});
                label.textContent = dayName(d.day, today);
                svg.appendChild(label);
            });
            const step = days.length > 1 ? (width - left - right) / (days.length - 1) : width;
            const show = i => {
                dots.forEach((dot, j) => dot.classList.toggle('is-on', j === i));
                cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
                tip.textContent = dayName(days[i].day, today) + ' · ' + format(values[i]);
                tip.style.left = (x(i) / width * 100) + '%'; tip.style.top = (points[i].y + 4) + 'px';
                tip.hidden = false;
            };
            const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); dots.forEach(dot => dot.classList.remove('is-on')); };
            days.forEach((d, i) => {
                const hit = node('rect', {x: x(i) - step / 2, y: 0, width: step, height: height, fill: 'transparent'});
                hit.addEventListener('mouseenter', () => show(i));
                hit.addEventListener('click', () => show(i));
                svg.appendChild(hit);
            });
            svg.addEventListener('mouseleave', hide);
            box.replaceChildren(el('div', {class: 'chart-title', text: title}), svg, tip);
        }
        box.draw = draw;
        return box;
    }
    function drawCharts() { document.querySelectorAll('.chart').forEach(chart => { if (chart.draw) chart.draw(); }); }
    let resizeTimer = null;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 150); });

    function hourGrid(hours) {
        const grid = el('div', {class: 'hours', role: 'img', 'aria-label': 'OpenAI requests per hour, last 7 days'});
        grid.appendChild(el('span'));
        for (let h = 0; h < 24; h++) grid.appendChild(el('span', {class: 'hour-label', text: h % 6 === 0 ? String(h) : ''}));
        hours.rows.forEach(row => {
            const label = new Date(row.day + 'T12:00:00Z').toLocaleDateString(undefined, {weekday: 'short', timeZone: 'UTC'});
            grid.appendChild(el('span', {class: 'day-label', text: label}));
            row.counts.forEach((count, h) => {
                const cell = el('span', {class: 'cell' + (count ? ' is-used' : ''), title: label + ' ' + h + ':00 · ' + count + ' request' + (count === 1 ? '' : 's')});
                if (count) cell.style.opacity = (0.25 + 0.75 * count / Math.max(1, hours.max)).toFixed(2);
                grid.appendChild(cell);
            });
        });
        return grid;
    }

    // The admin key: its saved hint, a field for a new one, how to make one, and Remove.
    function adminKeyRow() {
        const state = page.state();
        const field = state.schema.filter(f => f.key === 'adminKey')[0];
        const error = (page.errors().values || {}).adminKey, saved = state.adminKey && state.adminKey.set;
        const removing = Object.prototype.hasOwnProperty.call(page.pending(), 'adminKey');
        const input = el('input', {type: 'password', value: page.newAdminKey(), placeholder: saved ? 'Paste a new admin key to replace it' : 'sk-admin-…',
            autocomplete: 'off', 'aria-label': 'New admin key', oninput: () => { page.setNewAdminKey(input.value.trim()); updateSaveBar(); }});
        const remove = saved ? el('button', {class: 'btn btn-flat-danger', type: 'button', text: removing ? 'Keep' : 'Remove', onclick: () => {
            if (removing) delete page.pending().adminKey; else page.pending().adminKey = null;
            render();
        }}) : null;
        return el('div', {class: 'field' + (error ? ' is-invalid' : ''), 'data-key': 'adminKey'}, [
            el('div', {class: 'field-text'}, [
                el('div', {class: 'field-label', text: field.label}),
                el('div', {class: 'field-help', text: field.help}),
                saved ? el('div', {class: 'field-help'}, [removing ? 'Removed when you save: ' : 'Saved: ', el('span', {class: 'key-state', text: state.adminKey.hint})]) : null,
                saved ? null : el('ol', {class: 'steps'}, [
                    el('li', {text: 'On platform.openai.com, open Settings, then Admin keys.'}),
                    el('li', {text: 'Create a key with the permission Read only.'}),
                    el('li', {text: 'Paste it here and save. Jibo checks that it cannot change anything; any other key is refused.'})]),
                error ? el('div', {class: 'field-error', text: error}) : null
            ]),
            el('div', {class: 'field-control'}, [input, remove])
        ]);
    }

    const USAGE_PROBLEMS = {
        removed: 'The saved admin key could change your OpenAI account, so Jibo deleted it and the dashboard is off. Make a key with Read only permission and save that one. Delete the old key on OpenAI if you made it for Jibo.'
    };
    // Who the month's spend was by: the project's, Jibo's share of the account's, or all Jibo's.
    function monthNote(b, c) {
        if (b.source === 'project') return 'this project; Jibo ' + money(b.jibo, c);
        return b.spent > b.jibo + 0.005 ? 'Jibo ' + money(b.jibo, c) : 'all by Jibo';
    }
    function usageBody(u) {
        if (u.state === 'no-key') return [el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Save a read-only admin key above to see what Jibo costs.'})])];
        if (!u.ok) return [el('div', {class: 'banner', text: USAGE_PROBLEMS[u.state] || u.error || 'No usage data.'})];
        const c = u.currency, b = u.budget, out = [];
        const tile = (label, value, sub) => el('div', {class: 'tile'}, [el('div', {class: 'tile-label', text: label}), el('div',
            {class: 'tile-value', text: value}), sub ? el('div', {class: 'tile-sub', text: sub}) : null]);
        const pc = u.perConversation;
        out.push(el('div', {class: 'tiles'}, [
            tile('This month', money(b.spent, c), monthNote(b, c)),
            tile('Left', b.limit === null ? 'No limit' : money(b.left, c), b.limit === null ? 'none set on OpenAI' : 'of ' + money(b.limit, c) + ' a month'),
            tile('Month forecast', '≈ ' + money(b.forecast, c), 'at the pace of the last 7 full days'),
            tile('Per conversation', pc && pc.each !== null ? money(pc.each, c) : '–',
                pc ? pc.count + ' conversation' + (pc.count === 1 ? '' : 's') + (pc.partial ? ' since the oldest log' : ' in 7 days') : 'needs conversation logs')
        ]));

        // Budget: the whole account counts towards OpenAI's limit (D65).
        if (b.limit !== null) {
            const scale = Math.max(b.limit, b.forecast, b.spent) || 1, pct = v => Math.min(100, v / scale * 100) + '%';
            const meter = el('div', {class: 'budget-meter'}, [el('div', {class: 'is-other', style: {width: pct(b.spent)}}), el('div',
                {class: 'is-jibo', style: {width: pct(b.jibo)}}),
                el('div', {class: 'is-forecast', style: {left: pct(b.forecast)}})]);
            const short = v => money(v, c).replace(/\.00$/, '');
            b.alerts.filter(a => a !== b.limit).concat([b.limit]).forEach(a => meter.appendChild(el('div', {class: 'budget-mark' + (a / scale > 0.85 ? ' is-end' : ''),
                style: {left: pct(a)}, text: short(a) + (a === b.limit ? ' limit' : '')})));
            out.push(el('h2', {class: 'section-header', text: 'Budget this month'}), el('div', {class: 'setting-block'}, [meter,
                el('div', {class: 'budget-legend'}, [el('span', {}, [el('span', {class: 'swatch'}), 'Jibo ' + money(b.jibo, c)]),
                    b.spent > b.jibo + 0.005 ? el('span', {}, [el('span', {class: 'swatch is-other'}), 'Other keys ' + money(b.spent - b.jibo, c)]) : null,
                    el('span', {}, [el('span', {class: 'swatch is-forecast'}), 'Forecast ' + money(b.forecast, c)])]),
                el('div', {class: 'field-help help-bottom',
                    text: (b.source === 'project' ? 'The limit of the project Jibo\'s key belongs to, for everything in that project. ' : 'The organization\'s limit, for everything on the account. ') +
                    (b.enforced ? 'Hard limit: OpenAI stops answering at ' + money(b.limit, c) + ', and Jibo cannot talk until the next month.'
                        : 'Not enforced: OpenAI only emails at the alerts' + (b.alerts.length ? ' (' + b.alerts.map(a => money(a, c)).join(', ') + ')' : '') + '.')})]));
        }

        out.push(el('h2', {class: 'section-header', text: 'Last 7 days'}), el('div', {class: 'setting-block'}, [
            dayChart('Spent per day', u.days, u.today, d => d.cost, (v, axis) => axis ? money(v, c).replace(/\.00$/, '') : money(v, c)),
            dayChart('Tokens per day', u.days, u.today, d => d.tokens, v => tokens(v)),
            el('div', {class: 'field-help help-bottom',
                text: 'Days as OpenAI counts them (UTC). Today fills in during the day.' + (u.week.other > 0.005 ? ' Other keys on this account spent ' + money(u.week.other, c) + ' in these days.' : '')})]));

        const total = u.features.reduce((sum, f) => sum + f.cost, 0) || 1;
        const featureRow = f => el('div', {class: 'usage-row'}, [
            el('div', {class: 'usage-name', text: f.label}), el('div', {class: 'usage-money', text: money(f.cost, c)}),
            el('div', {class: 'usage-use', text: f.use}), el('div', {class: 'usage-tokens', text: amountUsed(f)}),
            el('div', {class: 'share'}, [el('div', {style: {width: (f.cost / total * 100).toFixed(1) + '%'}})])]);
        const featureRows = u.features.length ? u.features.map(featureRow) : [el('div', {class: 'empty', text: 'Nothing spent in the last 7 days.'})];
        out.push(el('h2', {class: 'section-header', text: 'What it was spent on'}), el('div', {class: 'setting-block rows'}, featureRows));

        out.push(el('h2', {class: 'section-header', text: 'Models'}), el('div', {class: 'setting-block rows'}, u.models.length ? u.models.map(m => el('div', {class: 'usage-row'}, [
            el('div', {class: 'usage-name'}, [m.model, el('span', {class: 'chip', text: m.label})]), el('div', {class: 'usage-money', text: money(m.cost, c)}),
            el('div', {class: 'usage-use', text: m.use}),
            el('div', {class: 'usage-tokens', text: amountUsed(m),
                title: m.tokens ? tokens(m.input) + ' in · ' + tokens(m.cached) + ' from cache · ' + tokens(m.output) + ' out' : null})])) : [el('div', {class: 'empty', text: 'No models used in the last 7 days.'})]));

        const notes = [];
        if (u.caching.cachedTokens) notes.push(el('div', {class: 'note-row'}, [el('div', {class: 'usage-name', text: 'Caching saved about ' + money(u.caching.saved, c)}),
            el('div', {class: 'usage-use',
                text: Math.round(u.caching.share * 100) + '% of the input came from OpenAI\'s cache at a lower price: the start of each conversation (the persona, the memory, the tools) stays the same from turn to turn. Editing the persona often makes this share drop.'})]));
        if (u.whatIf) notes.push(el('div', {class: 'note-row'}, [el('div', {class: 'usage-name',
            text: u.whatIf.would === null ? 'The other conversation model' : 'With ' + u.whatIf.other + ': about ' + money(u.whatIf.would, c)}),
            el('div', {class: 'usage-use',
                text: u.whatIf.would === null ? u.whatIf.other + ' has no price yet on this account for everything Jibo used (it is worked out from the bills of the last few weeks).'
                : 'The same conversations cost ' + money(u.whatIf.actual, c) + ' with ' + u.whatIf.model + ' in the last 7 days. Prices are this account\'s own, from its bills. Change it on the Brain tab.'})]));
        if (notes.length) out.push(el('h2', {class: 'section-header', text: 'Savings and choices'}), el('div', {class: 'setting-block'}, notes));

        out.push(el('h2', {class: 'section-header', text: 'When Jibo is used'}), el('div', {class: 'setting-block'}, [hourGrid(u.hours),
            el('div', {class: 'field-help help-bottom', text: 'Requests to OpenAI per hour, in Jibo\'s time. Darker is more.'})]));
        return out;
    }

    // ---- conversation statistics: counted from the conversation logs Jibo keeps (D148) ----
    let talks = null, talksPending = false, talksBox = null;
    function span(ms) {
        const s = Math.round(ms / 1000);
        if (s < 60) return s + ' s';
        const m = Math.floor(s / 60);
        if (m < 60) return m + ' min' + (s % 60 && m < 10 ? ' ' + (s % 60) + ' s' : '');
        return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
    }
    // Day and time as Jibo's clock has them (the server sends both), not the browser's.
    function talkWhen(r, days) {
        const today = days[days.length - 1].day, yesterday = days.length > 1 ? days[days.length - 2].day : null;
        const name = r.day === today ? 'Today' : r.day === yesterday ? 'Yesterday'
            : new Date(r.day + 'T12:00:00Z').toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'});
        return name + ' ' + r.time;
    }
    // Which voice Jibo used: shown once he said something in Dutch.
    function languageTile(lines) {
        const total = lines.nl + lines.en;
        return el('div', {class: 'tile'}, [el('div', {class: 'tile-label', text: 'In Dutch'}), el('div', {class: 'tile-value', text: Math.round(100 * lines.nl / total) + '%'}),
            el('div', {class: 'tile-sub', text: lines.nl + ' of ' + total + ' lines'})]);
    }
    function languageText(lines) {
        if (!lines || !lines.nl) return '';
        return ' · ' + lines.nl + ' Dutch' + (lines.en ? ', ' + lines.en + ' English' : '') + (lines.nl + lines.en === 1 ? ' line' : ' lines');
    }
    function talksBody(t) {
        if (!t || !t.ok) return [el('div', {class: 'empty', text: 'Jibo did not answer.'})];
        if (!t.total) {
            const values = page.state().values;
            return [el('div', {class: 'empty', text: values && values.log === false
                ? 'Conversation logs are off, so there is nothing to count. Turn on "Keep conversation logs" under History to see statistics.'
                : 'No conversation logs yet.'})];
        }
        const w = t.week;
        const tile = (label, value, sub) => el('div', {class: 'tile'}, [el('div', {class: 'tile-label', text: label}),
            el('div', {class: 'tile-value', text: value}), sub ? el('div', {class: 'tile-sub', text: sub}) : null]);
        const today = t.days[t.days.length - 1].day;
        const sinceDay = new Date(t.since).toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
        // Whole numbers on the count axis; the short text only for the tip.
        const count = (v, axis) => axis ? (Number.isInteger(v) ? String(v) : '') : v + (v === 1 ? ' conversation' : ' conversations');
        const minutes = (v, axis) => axis ? String(Math.round(v)) : v + ' min';
        return [
            el('div', {class: 'tiles'}, [
                tile('Conversations', String(w.count), 'in the last 7 days'),
                tile('Talked', span(w.ms), 'in total'),
                tile('Average', w.averageMs === null ? '–' : span(w.averageMs), 'per conversation'),
                tile('Longest', span(w.longestMs), 'one stretch')].concat(w.lines && w.lines.nl ? [languageTile(w.lines)] : [])),
            el('div', {class: 'setting-block'}, [
                dayChart('Conversations per day', t.days, today, d => d.count, count),
                dayChart('Minutes talked per day', t.days, today, d => Math.round(d.ms / 6000) / 10, minutes),
                el('div', {class: 'field-help help-bottom',
                    text: 'Read from the conversation logs Jibo keeps: ' + t.total + ' since ' + sinceDay + ' (the oldest logs are removed in time), in his own time. A comeback after a timer or another skill adds to the time but is not counted again.'})]),
            el('h2', {class: 'section-header', text: 'Latest conversations'}),
            el('div', {class: 'setting-block rows'}, t.recent.map(r => el('div', {class: 'usage-row'}, [
                el('div', {class: 'usage-name', text: talkWhen(r, t.days)}), el('div', {class: 'usage-money', text: span(r.ms)}),
                el('div', {class: 'usage-use',
                    text: (r.resumed ? 'Came back after another skill' : r.turns + (r.turns === 1 ? ' turn' : ' turns')) + languageText(r.lines) + (r.reason ? ' · ended: ' + r.reason.replace(/_/g, ' ') : '')})])))
        ];
    }
    // One request at a time; the answer goes to whichever box is on the page by then.
    function loadTalks() {
        if (talksPending) return;
        talksPending = true;
        request('GET', '/api/stats').then(result => { talks = result.json || {ok: false}; }).catch(() => { talks = {ok: false}; })
            .then(() => {
                talksPending = false;
                if (talksBox && talksBox.isConnected) { talksBox.replaceChildren.apply(talksBox, talksBody(talks)); drawCharts(); }
            });
    }

    function usagePanel() {
        const body = el('div', {}, usage ? usageBody(usage) : [el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Asking OpenAI…'})])]);
        const status = el('span');
        const refresh = el('button', {class: 'btn btn-flat', type: 'button', text: 'Refresh'});
        const bar = el('div', {class: 'usage-status'}, [status, refresh]);
        function showStatus(busy) {
            refresh.disabled = !!busy;
            bar.hidden = !(page.state().adminKey && page.state().adminKey.set);
            status.textContent = busy ? 'Asking OpenAI…' : usage && usage.ok ? 'Counting ' + (usage.key.name ? '"' + usage.key.name + '" ' : '') + usage.key.hint +
                ' · updated ' + ago(usage.fetchedAt) + (usage.tooSoon ? ' (Refresh again in a minute)' : '') : '';
        }
        function load(fresh) {
            if (!(page.state().adminKey && page.state().adminKey.set)) { usage = {state: 'no-key'}; body.replaceChildren.apply(body, usageBody(usage)); showStatus(false); return; }
            showStatus(true);
            request('GET', '/api/usage' + (fresh ? '?refresh=1' : '')).then(result => {
                usage = result.json || {ok: false, error: 'Jibo sent no answer.'};
            }).catch(() => { usage = {ok: false, state: 'error', error: 'Jibo did not answer.'}; })
              .then(() => {
                  if (!body.isConnected) return;
                  // The key row shows the deleted key's hint until redrawn.
                  if (usage.state === 'removed' && page.state().adminKey.set) { page.state().adminKey = {set: false, hint: ''}; render(); return; }
                  body.replaceChildren.apply(body, usageBody(usage)); showStatus(false); drawCharts();
              });
        }
        refresh.addEventListener('click', () => { load(true); loadTalks(); });
        talksBox = el('div', {}, talks ? talksBody(talks) : [el('div', {class: 'empty', text: 'Counting…'})]);
        showStatus(false);
        if (usageWanted || !usage) { usageWanted = false; load(false); loadTalks(); }
        else if (!talks) loadTalks();
        return [el('h2', {class: 'section-header', text: 'Conversations'}), talksBox,
            el('h2', {class: 'section-header', text: 'OpenAI'}), el('div', {class: 'setting-block'}, [adminKeyRow()])].concat(settingsPanel('usage'), [bar, body]);
    }

    page.panels.usage = usagePanel;
    page.usage = {
        keysChanged() { usage = null; usageWanted = true; },
        opened() { usageWanted = true; },
        drawCharts: drawCharts
    };
})();
