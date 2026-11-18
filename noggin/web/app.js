// SPDX-License-Identifier: MIT
// Noggin's settings page: builds every tab from the schema the robot sends (GET /api/settings),
// keeps unsaved changes until Save (POST /api/settings), and shows the conversation logs.
// Plain browser JavaScript, ES2015, no libraries.
(function () {
    'use strict';

    const TABS = [
        {id: 'brain', label: 'Brain', icon: '<path d="M11.2 4.6C9.6 3.6 7.4 4 6.6 5.6 4.8 5.6 3.6 7.4 4.2 9 2.9 10.2 3 12.4 4.4 13.4 3.8 15.4 5 17.6 7 17.8 7.6 19.6 9.6 20.4 11.2 19.4Z"/><path d="M12.8 4.6C14.4 3.6 16.6 4 17.4 5.6 19.2 5.6 20.4 7.4 19.8 9 21.1 10.2 21 12.4 19.6 13.4 20.2 15.4 19 17.6 17 17.8 16.4 19.6 14.4 20.4 12.8 19.4Z"/><path d="M8 9.5c1 .6 2 0 2.6.8M6.5 13.5c1.4-.6 2.4.6 3.6 0M16 9.5c-1 .6-2 0-2.6.8M17.5 13.5c-1.4-.6-2.4.6-3.6 0"/>'},
        {id: 'persona', label: 'Persona', icon: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c.6-3.8 3.8-5.8 7.5-5.8s6.9 2 7.5 5.8"/>'},
        {id: 'behaviour', label: 'Behaviour', icon: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'},
        {id: 'skills', label: 'Skills', icon: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'},
        {id: 'history', label: 'History', icon: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16h-8l-4.5 3.5V16H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 5Z"/><path d="M8 9.5h8M8 12.5h5"/>'}
    ];
    const PERSONA_PARTS = [
        {name: 'soul', title: 'Soul', help: 'Who Jibo is and how he speaks, including the family-safe rules.'},
        {name: 'identity', title: 'Identity', help: 'Facts about Jibo that go with every conversation.'},
        {name: 'facts', title: 'More facts', help: 'Looked up only when someone asks about Jibo.'}
    ];
    const INTRO = {
        brain: 'Noggin talks to OpenAI with your own API key. The key stays on Jibo; this page never shows it again.',
        persona: 'Who Jibo is in a conversation. Noggin adds what is true about this setup (his voice, his skills, the time) after these texts.',
        behaviour: 'How Jibo greets you, moves and listens.',
        skills: 'What Jibo may do for you during a conversation.',
        history: 'What was said in recent conversations. Never audio, never the key.'
    };

    let state = null;          // the last answer of GET /api/settings
    let pending = {};          // setting key -> new value (null: back to the default)
    let personaPending = {};   // soul|identity|facts -> new text
    let newKey = '';
    let errors = {values: {}, persona: {}};
    let active = 'brain';
    try { active = localStorage.getItem('noggin-tab') || 'brain'; } catch (_) {}
    if (!TABS.some(t => t.id === active)) active = 'brain';

    const $ = id => document.getElementById(id);
    function el(tag, attrs, children) {
        const node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(name => {
            const value = attrs[name];
            if (value === null || value === undefined || value === false) return;
            if (name === 'text') node.textContent = value;
            else if (name === 'html') node.innerHTML = value;
            else if (name.indexOf('on') === 0) node.addEventListener(name.slice(2), value);
            else node.setAttribute(name, value === true ? '' : value);
        });
        (children || []).forEach(child => { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
        return node;
    }
    function icon(paths) {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
    }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // ---- appearance: follows the system, like BEacon's default ----
    const dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function appearance() { document.documentElement.setAttribute('data-appearance', dark && dark.matches ? 'dark' : 'bright'); }
    appearance();
    if (dark && dark.addEventListener) dark.addEventListener('change', appearance);

    // ---- talking to Jibo ----
    function request(method, url, body) {
        const options = {method: method, headers: {Accept: 'application/json'}, cache: 'no-store'};
        if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
        return fetch(url, options).then(response => response.json().catch(() => ({})).then(json => ({status: response.status, json: json})));
    }
    function live(ok, text) {
        $('live-dot').className = 'live-dot' + (ok ? '' : ' is-down');
        $('live-text').textContent = text;
    }
    let toastTimer = null;
    function toast(text, isError) {
        const node = $('toast');
        node.textContent = text;
        node.className = 'toast' + (isError ? ' is-error' : '');
        node.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 3500);
    }

    function load() {
        return request('GET', '/api/settings').then(result => {
            if (result.status !== 200) throw Error('status ' + result.status);
            state = result.json;
            live(true, 'Connected · ' + state.version);
            errors = {values: Object.assign({}, state.problems || {}), persona: {}};
            render();
        }).catch(() => {
            live(false, 'Jibo is not reachable');
            $('main').replaceChildren(el('div', {class: 'banner', text: 'Jibo did not answer. Check that he is on and on this network, then reload.'}));
        });
    }

    // ---- unsaved changes ----
    function changes() { return Object.keys(pending).length + Object.keys(personaPending).length + (newKey ? 1 : 0); }
    function current(key) { return Object.prototype.hasOwnProperty.call(pending, key) ? pending[key] : state.values[key]; }
    function setValue(field, value) {
        const saved = state.values[field.key];
        if (value === null ? same(saved, field.default) : same(value, saved)) delete pending[field.key];
        else pending[field.key] = value;
        updateSaveBar();
    }
    function updateSaveBar() {
        const count = changes();
        $('save-bar').hidden = count === 0;
        $('save-text').replaceChildren(count + ' unsaved change' + (count === 1 ? '' : 's'), el('span', {class: 'save-later', text: ' · applies to the next conversation'}));
        document.querySelectorAll('[data-key]').forEach(node => {
            const key = node.getAttribute('data-key');
            node.classList.toggle('is-changed', Object.prototype.hasOwnProperty.call(pending, key) || (key === 'apiKey' && !!newKey));
        });
    }
    window.addEventListener('beforeunload', event => {
        if (state && changes()) { event.preventDefault(); event.returnValue = ''; }
    });

    function save() {
        const body = {values: Object.assign({}, pending), persona: Object.assign({}, personaPending)};
        if (newKey) body.values.apiKey = newKey;
        $('save').disabled = true;
        return request('POST', '/api/settings', body).then(result => {
            if (result.status === 200) {
                state = result.json; pending = {}; personaPending = {}; newKey = '';
                errors = {values: Object.assign({}, state.problems || {}), persona: {}};
                render();
                toast('Saved. Changes apply to the next conversation.');
                return;
            }
            errors = (result.json && result.json.errors) || {values: {}, persona: {}};
            const count = Object.keys(errors.values || {}).length + Object.keys(errors.persona || {}).length;
            render();
            toast(count ? 'Not saved: ' + count + ' setting' + (count === 1 ? ' needs' : 's need') + ' a fix.' : 'Not saved: ' + ((result.json && result.json.error) || 'Jibo refused it.'), true);
        }).catch(() => {
            live(false, 'Jibo is not reachable');
            toast('Not saved: Jibo did not answer.', true);
        }).then(() => { $('save').disabled = false; });
    }
    function discard() {
        pending = {}; personaPending = {}; newKey = '';
        errors = {values: Object.assign({}, state.problems || {}), persona: {}};
        render();
    }

    // ---- controls per field type ----
    function control(field) {
        const value = current(field.key);
        switch (field.type) {
        case 'bool': {
            const input = el('input', {type: 'checkbox', checked: !!value, 'aria-label': field.label, onchange: () => setValue(field, input.checked)});
            return el('label', {class: 'switch'}, [input, el('span')]);
        }
        case 'enum': {
            const select = el('select', {'aria-label': field.label, onchange: () => {
                const option = field.options[select.selectedIndex];
                setValue(field, option.value);
            }}, field.options.map(o => el('option', {text: o.label || o.value, selected: same(o.value, value)})));
            return select;
        }
        case 'number': {
            const input = el('input', {type: 'number', inputmode: 'decimal', min: field.min, max: field.max, step: field.step || 'any', value: value, 'aria-label': field.label,
                oninput: () => setValue(field, input.value === '' ? '' : Number(input.value))});
            return el('div', {class: 'inline-control'}, [input, field.unit ? el('span', {class: 'unit', text: field.unit}) : null]);
        }
        case 'set': {
            return el('div', {class: 'choices'}, field.options.map(o => {
                const on = (value || []).indexOf(o.value) >= 0;
                const box = el('input', {type: 'checkbox', checked: on && !o.disabled, disabled: !!o.disabled, onchange: () => {
                    const list = field.options.filter(x => !x.disabled && ((x.value === o.value) ? box.checked : (current(field.key) || []).indexOf(x.value) >= 0)).map(x => x.value);
                    setValue(field, list);
                    label.classList.toggle('is-selected', box.checked);
                }});
                const label = el('label', {class: 'choice' + (on && !o.disabled ? ' is-selected' : '') + (o.disabled ? ' is-disabled' : ''), title: o.disabled || null},
                    [box, o.label || o.value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())]);
                return label;
            }));
        }
        case 'map':
            return mapControl(field);
        default: {
            const listId = field.suggestions ? 'list-' + field.key : null;
            const input = el('input', {type: field.type === 'url' ? 'url' : 'text', value: value === null ? '' : value, list: listId, maxlength: field.max || 200,
                autocomplete: 'off', spellcheck: 'false', 'aria-label': field.label, oninput: () => setValue(field, input.value)});
            const list = listId ? el('datalist', {id: listId}, field.suggestions.map(s => el('option', {value: s}))) : null;
            return el('div', {class: 'grow'}, [input, list]);
        }
        }
    }
    // Extra apps: name -> package rows.
    function mapControl(field) {
        const rows = el('div', {class: 'map-rows'});
        let entries = Object.keys(current(field.key) || {}).map(name => [name, current(field.key)[name]]);
        function commit() {
            const out = {};
            entries.forEach(entry => { if (entry[0] || entry[1]) out[entry[0]] = entry[1]; });
            setValue(field, out);
        }
        function draw() {
            rows.replaceChildren();
            entries.forEach((entry, i) => {
                const name = el('input', {type: 'text', value: entry[0], placeholder: 'Name', 'aria-label': 'App name', oninput: () => { entry[0] = name.value; commit(); }});
                const pkg = el('input', {type: 'text', value: entry[1], placeholder: '@be/package', 'aria-label': 'Package', oninput: () => { entry[1] = pkg.value; commit(); }});
                rows.appendChild(el('div', {class: 'map-row'}, [name, pkg,
                    el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Remove', onclick: () => { entries.splice(i, 1); commit(); draw(); }})]));
            });
            rows.appendChild(el('div', {}, [el('button', {class: 'btn btn-flat', type: 'button', text: 'Add app', onclick: () => { entries.push(['', '']); draw(); }})]));
        }
        draw();
        return rows;
    }

    function fieldRow(field) {
        const error = (errors.values || {})[field.key];
        const wide = field.type === 'map' || field.type === 'set';
        return el('div', {class: 'field' + (error ? ' is-invalid' : ''), 'data-key': field.key}, [
            el('div', {class: 'field-text'}, [
                el('div', {class: 'field-label', text: field.label}),
                field.help ? el('div', {class: 'field-help', text: field.help}) : null,
                error ? el('div', {class: 'field-error', text: error}) : null
            ]),
            el('div', {class: 'field-control' + (wide && field.type === 'map' ? ' is-wide' : '')}, [control(field)])
        ]);
    }
    // The API key: its saved hint, a field for a new one and a check against OpenAI.
    function keyRow(field) {
        const error = (errors.values || {}).apiKey;
        const result = el('span');
        const input = el('input', {type: 'password', value: newKey, placeholder: state.key.set ? 'Paste a new key to replace it' : 'Paste your OpenAI API key',
            autocomplete: 'off', 'aria-label': 'New API key', oninput: () => { newKey = input.value.trim(); updateSaveBar(); }});
        const test = el('button', {class: 'btn', type: 'button', text: 'Test key', onclick: () => {
            test.disabled = true;
            result.replaceChildren(el('span', {class: 'chip', text: 'Asking OpenAI…'}));
            request('POST', '/api/test-key', {key: newKey}).then(r => {
                const ok = r.json && r.json.ok;
                const text = ok ? 'Works · ' + (r.json.ms / 1000).toFixed(1) + ' s' : (r.json && r.json.error) || 'Did not work';
                result.replaceChildren(el('span', {class: 'chip ' + (ok ? 'is-ok' : 'is-bad'), text: text}));
            }).catch(() => result.replaceChildren(el('span', {class: 'chip is-bad', text: 'Jibo did not answer'})))
              .then(() => { test.disabled = false; });
        }});
        return el('div', {class: 'field' + (error ? ' is-invalid' : ''), 'data-key': 'apiKey'}, [
            el('div', {class: 'field-text'}, [
                el('div', {class: 'field-label', text: field.label}),
                el('div', {class: 'field-help'}, state.key.set ? ['Saved: ', el('span', {class: 'key-state', text: state.key.hint})] : ['No key saved yet. Noggin cannot talk without one.']),
                error ? el('div', {class: 'field-error', text: error}) : null,
                result
            ]),
            el('div', {class: 'field-control'}, [input, test])
        ]);
    }

    // ---- tabs ----
    function groupsOf(fields) {
        const groups = [];
        fields.forEach(field => {
            let group = groups.filter(g => g.name === field.group)[0];
            if (!group) { group = {name: field.group, fields: []}; groups.push(group); }
            group.fields.push(field);
        });
        return groups;
    }
    function settingsPanel(tab) {
        const fields = state.schema.filter(f => f.tab === tab);
        const out = [];
        groupsOf(fields.filter(f => !f.advanced)).forEach(group => {
            out.push(el('h2', {class: 'section-header', text: group.name}));
            out.push(el('div', {class: 'setting-block'}, group.fields.map(f => f.key === 'apiKey' ? keyRow(f) : fieldRow(f))));
        });
        const advanced = groupsOf(fields.filter(f => f.advanced));
        if (advanced.length) {
            const anyError = advanced.some(g => g.fields.some(f => (errors.values || {})[f.key]));
            out.push(el('details', {class: 'advanced', open: anyError}, [el('summary', {text: 'Advanced'})].concat(advanced.map(group =>
                el('div', {}, [el('h3', {class: 'section-header', text: group.name}), el('div', {class: 'setting-block'}, group.fields.map(fieldRow))])))));
        }
        return out;
    }

    function personaText(name) { return Object.prototype.hasOwnProperty.call(personaPending, name) ? personaPending[name] : state.persona[name]; }
    function personaPanel() {
        const meterBar = el('div');
        const meter = el('div', {class: 'meter'}, [meterBar]);
        const budgetText = el('span');
        function budget() {
            // The robot measured the saved texts; the difference is what the edits add or remove.
            const delta = ['soul', 'identity'].reduce((sum, name) => sum + personaText(name).length - state.persona[name].length, 0);
            const chars = state.budget.chars + delta, limit = state.budget.recommended;
            budgetText.textContent = chars.toLocaleString() + ' / ' + limit.toLocaleString();
            meterBar.style.width = Math.min(100, chars / limit * 100) + '%';
            meter.classList.toggle('is-over', chars > limit);
        }
        const out = [
            el('h2', {class: 'section-header', text: 'Persona'}),
            el('p', {class: 'hint', text: INTRO.persona}),
            el('div', {class: 'setting-block'}, [
                el('div', {class: 'budget budget-top'}, [el('span', {text: 'Instructions sent at the start'}), budgetText]),
                meter,
                el('div', {class: 'field-help help-bottom', text: 'Longer instructions make each conversation start slower and cost more.'})
            ])
        ];
        PERSONA_PARTS.forEach(part => {
            const max = state.persona.max[part.name];
            const error = (errors.persona || {})[part.name];
            const count = el('span');
            const edited = el('span', {class: 'chip', text: 'Edited'});
            const reset = el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Reset to default'});
            const area = el('textarea', {spellcheck: 'false', 'aria-label': part.title, maxlength: max});
            area.value = personaText(part.name);
            function refresh() {
                const text = area.value, packaged = state.persona.packaged[part.name];
                count.textContent = text.length.toLocaleString() + ' / ' + max.toLocaleString() + ' characters';
                edited.style.visibility = text !== packaged ? 'visible' : 'hidden';
                reset.disabled = text === packaged;
                budget();
            }
            area.addEventListener('input', () => {
                if (area.value === state.persona[part.name]) delete personaPending[part.name];
                else personaPending[part.name] = area.value;
                refresh(); updateSaveBar();
            });
            reset.addEventListener('click', () => { area.value = state.persona.packaged[part.name]; area.dispatchEvent(new Event('input')); });
            out.push(el('div', {class: 'setting-block' + (error ? ' is-invalid' : '')}, [
                el('div', {class: 'persona-head'}, [el('h3', {text: part.title}), edited]),
                el('div', {class: 'field-help persona-help', text: part.help}),
                area,
                error ? el('div', {class: 'field-error', text: error}) : null,
                el('div', {class: 'persona-foot'}, [count, reset])
            ]));
            refresh();
        });
        budget();
        return out;
    }

    // ---- history ----
    function when(name) {
        const m = /^conversation-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
        if (!m) return name;
        const date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
        return date.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'}) + ' ' + date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
    }
    function timeline(text) {
        const lines = [];
        text.split('\n').forEach(line => {
            if (!line.trim()) return;
            let e;
            try { e = JSON.parse(line); } catch (_) { return; }
            const at = e.t ? new Date(e.t).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit', second: '2-digit'}) : '';
            const row = (who, cls, words) => lines.push(el('div', {class: 'log-line'}, [el('span', {class: 'log-time', text: at}), el('span', {class: 'log-who ' + cls, text: who}), el('span', {class: cls === '' ? 'log-note' : '', text: words})]));
            if (e.kind === 'you' && e.text) row('You', '', e.text);
            else if (e.kind === 'jibo' && e.text) row('Jibo', 'is-jibo', e.text);
            else if (e.kind === 'tool_call') row('', '', '→ ' + e.name.replace(/_/g, ' '));
            else if (e.kind === 'comeback') row('', '', e.ok ? '← back' + (e.said ? ': "' + e.said + '"' : '') : '← did not come back (' + e.reason + ')');
            else if (e.kind === 'session_end') row('', '', 'Ended: ' + String(e.reason).replace(/_/g, ' '));
            else if (e.kind === 'error' || e.kind === 'failed') row('', '', 'Problem: ' + (e.error || e.message || ''));
        });
        return lines.length ? lines : [el('div', {class: 'empty', text: 'Nothing was said.'})];
    }
    function historyPanel() {
        const list = el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Loading…'})]);
        request('GET', '/api/logs').then(result => {
            const logs = (result.json && result.json.logs) || [];
            if (!logs.length) { list.replaceChildren(el('div', {class: 'empty', text: 'No conversations yet.'})); return; }
            list.replaceChildren();
            logs.forEach(item => {
                const view = el('div', {class: 'log-view', hidden: true});
                const button = el('button', {class: 'btn btn-flat', type: 'button', text: 'View', onclick: () => {
                    if (!view.hidden) { view.hidden = true; button.textContent = 'View'; return; }
                    button.textContent = 'Hide'; view.hidden = false;
                    view.replaceChildren(el('div', {class: 'empty', text: 'Loading…'}));
                    fetch('/api/logs/' + encodeURIComponent(item.name), {cache: 'no-store'}).then(r => r.text()).then(text => view.replaceChildren.apply(view, timeline(text)))
                        .catch(() => view.replaceChildren(el('div', {class: 'empty', text: 'Jibo did not answer.'})));
                }});
                list.appendChild(el('div', {}, [
                    el('div', {class: 'log-row'}, [
                        el('div', {}, [el('div', {class: 'log-title', text: when(item.name)}), el('div', {class: 'log-sub', text: Math.max(1, Math.round(item.bytes / 1024)) + ' KB'})]),
                        el('div', {class: 'log-actions'}, [button, el('a', {class: 'btn btn-flat', href: '/api/logs/' + encodeURIComponent(item.name), download: item.name, text: 'Download'})])
                    ]),
                    view
                ]));
            });
        }).catch(() => list.replaceChildren(el('div', {class: 'empty', text: 'Jibo did not answer.'})));
        return settingsPanel('history').concat([el('h2', {class: 'section-header', text: 'Recent conversations'}), list]);
    }

    // ---- page ----
    function render() {
        const main = $('main');
        const scroll = window.scrollY;
        const panel = active === 'persona' ? personaPanel() : active === 'history' ? historyPanel() : settingsPanel(active);
        const intro = active === 'persona' ? [] : [el('p', {class: 'hint', text: INTRO[active]})];
        const notices = state.broken ? [el('div', {class: 'banner', text: 'Jibo\'s settings file could not be read (' + state.broken + '). Saving writes a new one.'})] : [];
        main.replaceChildren(el('section', {class: 'panel is-active'}, notices.concat(intro, panel)));
        $('nav').replaceChildren.apply($('nav'), TABS.map(tab => el('button', {class: 'tab' + (tab.id === active ? ' is-active' : ''), type: 'button',
            'aria-current': tab.id === active ? 'page' : null, onclick: () => {
                active = tab.id;
                try { localStorage.setItem('noggin-tab', active); } catch (_) {}
                render(); window.scrollTo(0, 0);
            }, html: icon(tab.icon) + '<span>' + tab.label + '</span>'})));
        updateSaveBar();
        window.scrollTo(0, scroll);
    }

    $('save').addEventListener('click', save);
    $('discard').addEventListener('click', discard);
    load();
})();
