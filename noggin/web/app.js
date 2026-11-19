// SPDX-License-Identifier: MIT
// Noggin's settings page: builds every tab from the schema the robot sends (GET /api/settings),
// keeps unsaved changes until Save (POST /api/settings), shows the conversation logs and what
// Jibo's OpenAI use costs (GET /api/usage).
// Plain browser JavaScript, ES2015, no libraries.
(function () {
    'use strict';

    const TABS = [
        {id: 'brain', label: 'Brain', icon: '<path d="M11.2 4.6C9.6 3.6 7.4 4 6.6 5.6 4.8 5.6 3.6 7.4 4.2 9 2.9 10.2 3 12.4 4.4 13.4 3.8 15.4 5 17.6 7 17.8 7.6 19.6 9.6 20.4 11.2 19.4Z"/><path d="M12.8 4.6C14.4 3.6 16.6 4 17.4 5.6 19.2 5.6 20.4 7.4 19.8 9 21.1 10.2 21 12.4 19.6 13.4 20.2 15.4 19 17.6 17 17.8 16.4 19.6 14.4 20.4 12.8 19.4Z"/><path d="M8 9.5c1 .6 2 0 2.6.8M6.5 13.5c1.4-.6 2.4.6 3.6 0M16 9.5c-1 .6-2 0-2.6.8M17.5 13.5c-1.4-.6-2.4.6-3.6 0"/>'},
        {id: 'persona', label: 'Persona', icon: '<circle cx="12" cy="8.5" r="4"/><path d="M4.5 20c.6-3.8 3.8-5.8 7.5-5.8s6.9 2 7.5 5.8"/>'},
        {id: 'behaviour', label: 'Behaviour', icon: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'},
        {id: 'skills', label: 'Skills', icon: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>'},
        {id: 'memory', label: 'Memory', icon: '<path d="M6.5 4h10A1.5 1.5 0 0 1 18 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-10Z"/><path d="M6.5 4v16M10 8.5h5M10 12h5M10 15.5h3"/>'},
        {id: 'usage', label: 'Usage', icon: '<path d="M4 20h16"/><path d="M5.5 15.5 9.5 11l3.5 3 5.5-7"/><circle cx="18.5" cy="7" r="1.2"/>'},
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
        memory: 'What Jibo remembers about your household, and short notes of the last two weeks of conversations. Several people talk to Jibo and he cannot tell who is who, so everything here is shared by everyone in the house.',
        usage: 'What Jibo\'s OpenAI use costs, read with a read-only admin key. Jibo asks OpenAI when you open this tab or press Refresh, and keeps the answer for 15 minutes.',
        history: 'What was said in recent conversations. Never audio, never the key.'
    };

    let state = null;          // the last answer of GET /api/settings
    let pending = {};          // setting key -> new value (null: back to the default)
    let personaPending = {};   // soul|identity|facts -> new text
    let newKey = '';
    let newAdminKey = '';
    let errors = {values: {}, persona: {}};
    let active = 'brain';
    try { active = localStorage.getItem('noggin-tab') || 'brain'; } catch (_) {}
    // A tab named in the address wins (the QR code on Jibo's screen opens #brain, D75).
    const wanted = String(location.hash || '').slice(1);
    if (TABS.some(tab => tab.id === wanted)) active = wanted;
    if (!TABS.some(t => t.id === active)) active = 'brain';

    const $ = id => document.getElementById(id);
    function el(tag, attrs, children) {
        const node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(name => {
            const value = attrs[name];
            if (value === null || value === undefined || value === false) return;
            if (name === 'text') node.textContent = value;
            else if (name === 'html') node.innerHTML = value;
            else if (name === 'style') Object.keys(value).forEach(k => { node.style[k] = value[k]; }); // CSSOM: the CSP refuses style attributes
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
    function changes() { return Object.keys(pending).length + Object.keys(personaPending).length + (newKey ? 1 : 0) + (newAdminKey ? 1 : 0); }
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
            node.classList.toggle('is-changed', Object.prototype.hasOwnProperty.call(pending, key) || (key === 'apiKey' && !!newKey) || (key === 'adminKey' && !!newAdminKey));
        });
    }
    window.addEventListener('beforeunload', event => {
        if (state && changes()) { event.preventDefault(); event.returnValue = ''; }
    });

    function save() {
        const body = {values: Object.assign({}, pending), persona: Object.assign({}, personaPending)};
        if (newKey) body.values.apiKey = newKey;
        if (newAdminKey) body.values.adminKey = newAdminKey;
        const keysChanged = !!(newKey || newAdminKey || Object.prototype.hasOwnProperty.call(pending, 'adminKey'));
        $('save').disabled = true;
        return request('POST', '/api/settings', body).then(result => {
            if (result.status === 200) {
                state = result.json; pending = {}; personaPending = {}; newKey = ''; newAdminKey = '';
                errors = {values: Object.assign({}, state.problems || {}), persona: {}};
                if (keysChanged) { usage = null; usageWanted = true; }
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
        pending = {}; personaPending = {}; newKey = ''; newAdminKey = '';
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
    // Extra apps: name -> package rows, at most field.max (D32), and the installed custom skills
    // a scan found, each added with one click (D31, D36).
    const APP_NAME = /^[A-Za-z][A-Za-z0-9 ]{0,31}$/;
    let found = null;          // the last scan: {busy}, {items, builtIn} or {error}; kept until reload
    let redrawApps = null;     // the Extra apps editor on screen, redrawn when a scan ends
    function scan() {
        found = {busy: true, items: found && found.items, builtIn: found && found.builtIn};
        if (redrawApps) redrawApps();
        request('GET', '/api/skills/found').then(result => {
            const ok = result.status === 200 && result.json && result.json.ok;
            found = ok ? {items: result.json.found, builtIn: result.json.builtIn || []}
                : {error: (result.json && result.json.error) || 'BEacon did not answer.'};
        }).catch(() => { found = {error: 'Jibo did not answer.'}; })
          .then(() => { if (redrawApps) redrawApps(); });
    }
    function mapControl(field) {
        const rows = el('div', {class: 'map-rows'});
        const max = field.max || 8, noteMax = field.noteMax || 120;
        const value = current(field.key) || {};
        // [name, package, what it does]; an older value is a package alone.
        let entries = Object.keys(value).map(name => typeof value[name] === 'string' ? [name, value[name], ''] : [name, value[name].pkg, value[name].about || '']);
        const full = () => entries.length >= max;
        function commit() {
            const out = {};
            entries.forEach(entry => { if (entry[0] || entry[1] || entry[2]) out[entry[0]] = {pkg: entry[1], about: entry[2]}; });
            setValue(field, out);
        }
        // "What it does": typed, from the README, or written by AI from the README on request (D39, D41).
        // onText(text, source) keeps it; source: 'readme', 'ai' or '' (typed).
        function aboutBlock(text, source, label, pkgOf, onText) {
            const sources = {readme: 'From the skill\'s README.', ai: 'Written by AI from the README. Check it before you save.'};
            const note = el('div', {class: 'field-help about-source', text: sources[source] || ''});
            // A few lines, so a whole 120-character line shows; Enter would only add a space.
            const input = el('textarea', {class: 'about', rows: 3, maxlength: noteMax, spellcheck: 'true', 'aria-label': label,
                placeholder: 'What it does, for example: plays YouTube videos on Jibo\'s screen', oninput: () => { note.textContent = ''; onText(input.value, ''); },
                onkeydown: event => { if (event.key === 'Enter') event.preventDefault(); }});
            input.value = text;
            const button = state.key.set ? el('button', {class: 'btn btn-flat', type: 'button', text: 'Describe with AI', title: 'Sends this skill\'s README to OpenAI with your key', onclick: () => {
                button.disabled = true; button.textContent = 'Describing…';
                request('POST', '/api/apps/describe', {pkg: pkgOf()}).then(r => {
                    if (r.status === 200 && r.json && r.json.ok) {
                        input.value = r.json.about; onText(r.json.about, 'ai');
                        note.className = 'field-help about-source'; note.textContent = sources.ai;
                    } else {
                        note.className = 'field-error about-source'; note.textContent = 'Not described: ' + ((r.json && r.json.error) || 'Jibo refused it') + '.';
                    }
                }).catch(() => { note.className = 'field-error about-source'; note.textContent = 'Not described: Jibo did not answer.'; })
                  .then(() => { button.disabled = false; button.textContent = 'Describe with AI'; });
            }}) : null;
            return el('div', {class: 'about-block'}, [input, el('div', {class: 'about-row'}, [note, button])]);
        }
        function foundRows() {
            const out = [el('div', {class: 'found-head'}, [
                el('div', {}, [el('div', {class: 'found-title', text: 'Found on this Jibo'}),
                    el('div', {class: 'field-help', text: 'Custom skills installed through BEacon. Add the ones Jibo may open.'})]),
                el('button', {class: 'btn', type: 'button', disabled: !!(found && found.busy), text: found && found.busy ? 'Scanning…' : found ? 'Scan again' : 'Scan', onclick: scan})])];
            if (!found || found.busy && !found.items) return out;
            if (found.error) return out.concat([el('div', {class: 'field-error', text: found.error})]);
            const chosen = entries.map(entry => entry[1]);
            const items = found.items.filter(item => chosen.indexOf(item.pkg) < 0);
            if (!items.length) return out.concat([el('div', {class: 'field-help found-none', text: found.items.length ? 'Every skill found is in the list.' : 'No other custom skills are installed.'})]);
            items.forEach(item => {
                const note = el('div', {class: 'field-error', hidden: true});
                const name = el('input', {type: 'text', value: item.name, placeholder: 'Name', maxlength: 32, 'aria-label': 'Name for ' + item.pkg, oninput: () => { item.name = name.value; }});
                const add = el('button', {class: 'btn btn-flat', type: 'button', text: 'Add', disabled: full(), onclick: () => {
                    const spoken = name.value.trim().replace(/\s+/g, ' ');
                    const taken = entries.map(entry => entry[0].toLowerCase()).concat(found.builtIn || []);
                    const problem = !APP_NAME.test(spoken) ? 'A name: letters, digits and spaces, starting with a letter.'
                        : taken.indexOf(spoken.toLowerCase()) >= 0 ? '"' + spoken + '" is already used. Choose another name.' : '';
                    if (problem) { note.textContent = problem; note.hidden = false; return; }
                    // The README's line comes along, to edit or describe with AI in the list (D39, D41).
                    entries.push([spoken, item.pkg, item.about || '', item.about ? 'readme' : '']); commit(); draw();
                }});
                out.push(el('div', {class: 'found-item'}, [
                    el('div', {class: 'map-row'}, [name, el('span', {class: 'found-pkg', text: item.pkg, title: item.label || null}), add]), note]));
            });
            return out;
        }
        function draw() {
            rows.replaceChildren();
            entries.forEach((entry, i) => {
                const name = el('input', {type: 'text', value: entry[0], placeholder: 'Name', 'aria-label': 'App name', oninput: () => { entry[0] = name.value; commit(); }});
                const pkg = el('input', {type: 'text', value: entry[1], placeholder: '@be/package', 'aria-label': 'Package', oninput: () => { entry[1] = pkg.value; commit(); }});
                const about = aboutBlock(entry[2], entry[3], 'What ' + (entry[0] || 'this app') + ' does', () => entry[1], (text, source) => { entry[2] = text; entry[3] = source; commit(); });
                rows.appendChild(el('div', {class: 'app-entry'}, [el('div', {class: 'map-row'}, [name, pkg,
                    el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Remove', onclick: () => { entries.splice(i, 1); commit(); draw(); }})]), about]));
            });
            rows.appendChild(el('div', {}, [el('button', {class: 'btn btn-flat', type: 'button', text: 'Add app', disabled: full(), onclick: () => { entries.push(['', '', '']); draw(); }})]));
            if (full()) rows.appendChild(el('div', {class: 'field-help cap-note', text: 'Jibo can open at most ' + max + ' extra apps. Remove one to add another.'}));
            if (entries.length && state.key.set) rows.appendChild(el('div', {class: 'field-help', text: 'Describe with AI sends the app\'s README to OpenAI with your key.'}));
            rows.appendChild(el('div', {class: 'found'}, foundRows()));
        }
        redrawApps = () => { if (rows.isConnected) draw(); };
        draw();
        return rows;
    }

    function fieldRow(field) {
        const error = (errors.values || {})[field.key];
        const wide = field.type === 'map' || field.type === 'set';
        return el('div', {class: 'field' + (field.type === 'map' ? ' is-tall' : '') + (error ? ' is-invalid' : ''), 'data-key': field.key}, [
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
        // The admin key has its own row (adminKeyRow).
        const fields = state.schema.filter(f => f.tab === tab && f.key !== 'adminKey');
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

    // ---- memory: changes here are saved at once, not with Save ----
    function memoryPanel() {
        const facts = el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Loading…'})]);
        const notes = el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Loading…'})]);
        const fullness = el('div', {class: 'field-help'});
        const failed = () => { facts.replaceChildren(el('div', {class: 'empty', text: 'Jibo did not answer.'})); notes.replaceChildren(); };
        function act(url, body) {
            return request('POST', url, body).then(result => {
                if (result.status !== 200) { toast(result.json && result.json.error || 'Not saved.', true); return false; }
                show(result.json);
                return true;
            }).catch(() => { toast('Jibo did not answer.', true); return false; });
        }
        function factRow(fact) {
            const sub = (fact.source === 'asked' ? 'Kept on request' : 'Learned from a conversation') + (fact.expires ? ' · until ' + fact.expires : '');
            const row = el('div', {class: 'log-row'});
            const view = () => { row.classList.remove('is-editing'); row.replaceChildren(
                el('div', {class: 'memory-text'}, [el('div', {text: fact.text}), el('div', {class: 'log-sub', text: sub})]),
                el('div', {class: 'log-actions'}, [
                    el('button', {class: 'btn btn-flat', type: 'button', text: 'Edit', onclick: edit}),
                    el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Delete', onclick: () => act('/api/memory/delete', {kind: 'fact', id: fact.id})})
                ])); };
            function edit() {
                row.classList.add('is-editing');
                const input = el('input', {type: 'text', value: fact.text, maxlength: 160, 'aria-label': 'Fact'});
                row.replaceChildren(el('div', {class: 'memory-text memory-edit'}, [input]), el('div', {class: 'log-actions'}, [
                    el('button', {class: 'btn btn-flat', type: 'button', text: 'Save', onclick: () => act('/api/memory/fact', {id: fact.id, text: input.value, expires: fact.expires || ''})}),
                    el('button', {class: 'btn btn-flat', type: 'button', text: 'Cancel', onclick: view})
                ]));
                input.focus();
            }
            view();
            return row;
        }
        function show(m) {
            fullness.textContent = m.facts.length + (m.facts.length === 1 ? ' fact, ' : ' facts, ') + Math.round(100 * m.used / m.max) + '% of the space for facts.';
            const input = el('input', {type: 'text', maxlength: 160, placeholder: 'Sam\'s birthday is March 3', 'aria-label': 'New fact'});
            const add = () => { if (input.value.trim()) act('/api/memory/fact', {text: input.value}); };
            input.addEventListener('keydown', event => { if (event.key === 'Enter') add(); });
            facts.replaceChildren.apply(facts, (m.facts.length ? m.facts.map(factRow) : [el('div', {class: 'empty', text: 'No facts yet.'})]).concat([
                el('div', {class: 'log-row memory-add'}, [el('div', {class: 'memory-text memory-edit'}, [input]),
                    el('div', {class: 'log-actions'}, [el('button', {class: 'btn btn-flat', type: 'button', text: 'Add', onclick: add})])])
            ]));
            notes.replaceChildren.apply(notes, m.summaries.length ? m.summaries.map(note => el('div', {class: 'log-row'}, [
                el('div', {class: 'memory-text'}, [el('div', {class: 'log-title', text: note.when}), el('div', {text: note.text})]),
                el('div', {class: 'log-actions'}, [el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Delete',
                    onclick: () => act('/api/memory/delete', {kind: 'summary', id: note.id})})])
            ])) : [el('div', {class: 'empty', text: 'No notes yet. After a conversation ends, Jibo writes one within a minute.'})]);
        }
        request('GET', '/api/memory').then(result => { if (result.status === 200) show(result.json); else failed(); }).catch(failed);
        const forget = el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Forget everything', onclick: () => {
            if (window.confirm('Jibo forgets every fact and every note. This cannot be undone.')) act('/api/memory/clear', {confirm: true});
        }});
        return settingsPanel('memory').concat([
            el('h2', {class: 'section-header', text: 'Facts'}), fullness, facts,
            el('h2', {class: 'section-header', text: 'Recent conversations'}),
            el('div', {class: 'field-help', text: 'Notes Jibo keeps for two weeks. He has the newest few at hand; he looks up the rest when someone asks.'}), notes,
            el('div', {class: 'memory-tools'}, [el('a', {class: 'btn btn-flat', href: '/api/memory/export', download: 'noggin-memory.json', text: 'Export'}), forget])
        ]);
    }

    // ---- usage: fetched when the tab opens and on Refresh; the robot caches it (D64) ----
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
        const field = state.schema.filter(f => f.key === 'adminKey')[0];
        const error = (errors.values || {}).adminKey, saved = state.adminKey && state.adminKey.set;
        const removing = Object.prototype.hasOwnProperty.call(pending, 'adminKey');
        const input = el('input', {type: 'password', value: newAdminKey, placeholder: saved ? 'Paste a new admin key to replace it' : 'sk-admin-…',
            autocomplete: 'off', 'aria-label': 'New admin key', oninput: () => { newAdminKey = input.value.trim(); updateSaveBar(); }});
        const remove = saved ? el('button', {class: 'btn btn-flat-danger', type: 'button', text: removing ? 'Keep' : 'Remove', onclick: () => {
            if (removing) delete pending.adminKey; else pending.adminKey = null;
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
    function usageBody(u) {
        if (u.state === 'no-key') return [el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Save a read-only admin key above to see what Jibo costs.'})])];
        if (!u.ok) return [el('div', {class: 'banner', text: USAGE_PROBLEMS[u.state] || u.error || 'No usage data.'})];
        const c = u.currency, b = u.budget, out = [];
        const tile = (label, value, sub) => el('div', {class: 'tile'}, [el('div', {class: 'tile-label', text: label}), el('div', {class: 'tile-value', text: value}), sub ? el('div', {class: 'tile-sub', text: sub}) : null]);
        const pc = u.perConversation;
        out.push(el('div', {class: 'tiles'}, [
            tile('This month', money(b.spent, c), b.source === 'project' ? 'this project; Jibo ' + money(b.jibo, c) : b.spent > b.jibo + 0.005 ? 'Jibo ' + money(b.jibo, c) : 'all by Jibo'),
            tile('Left', b.limit === null ? 'No limit' : money(b.left, c), b.limit === null ? 'none set on OpenAI' : 'of ' + money(b.limit, c) + ' a month'),
            tile('Month forecast', '≈ ' + money(b.forecast, c), 'at the pace of the last 7 full days'),
            tile('Per conversation', pc && pc.each !== null ? money(pc.each, c) : '–', pc ? pc.count + ' conversation' + (pc.count === 1 ? '' : 's') + (pc.partial ? ' since the oldest log' : ' in 7 days') : 'needs conversation logs')
        ]));

        // Budget: the whole account counts towards OpenAI's limit (D65).
        if (b.limit !== null) {
            const scale = Math.max(b.limit, b.forecast, b.spent) || 1, pct = v => Math.min(100, v / scale * 100) + '%';
            const meter = el('div', {class: 'budget-meter'}, [el('div', {class: 'is-other', style: {width: pct(b.spent)}}), el('div', {class: 'is-jibo', style: {width: pct(b.jibo)}}),
                el('div', {class: 'is-forecast', style: {left: pct(b.forecast)}})]);
            const short = v => money(v, c).replace(/\.00$/, '');
            b.alerts.filter(a => a !== b.limit).concat([b.limit]).forEach(a => meter.appendChild(el('div', {class: 'budget-mark' + (a / scale > 0.85 ? ' is-end' : ''),
                style: {left: pct(a)}, text: short(a) + (a === b.limit ? ' limit' : '')})));
            out.push(el('h2', {class: 'section-header', text: 'Budget this month'}), el('div', {class: 'setting-block'}, [meter,
                el('div', {class: 'budget-legend'}, [el('span', {}, [el('span', {class: 'swatch'}), 'Jibo ' + money(b.jibo, c)]),
                    b.spent > b.jibo + 0.005 ? el('span', {}, [el('span', {class: 'swatch is-other'}), 'Other keys ' + money(b.spent - b.jibo, c)]) : null,
                    el('span', {}, [el('span', {class: 'swatch is-forecast'}), 'Forecast ' + money(b.forecast, c)])]),
                el('div', {class: 'field-help help-bottom', text: (b.source === 'project' ? 'The limit of the project Jibo\'s key belongs to, for everything in that project. ' : 'The organization\'s limit, for everything on the account. ') +
                    (b.enforced ? 'Hard limit: OpenAI stops answering at ' + money(b.limit, c) + ', and Jibo cannot talk until the next month.' : 'Not enforced: OpenAI only emails at the alerts' + (b.alerts.length ? ' (' + b.alerts.map(a => money(a, c)).join(', ') + ')' : '') + '.')})]));
        }

        out.push(el('h2', {class: 'section-header', text: 'Last 7 days'}), el('div', {class: 'setting-block'}, [
            dayChart('Spent per day', u.days, u.today, d => d.cost, (v, axis) => axis ? money(v, c).replace(/\.00$/, '') : money(v, c)),
            dayChart('Tokens per day', u.days, u.today, d => d.tokens, v => tokens(v)),
            el('div', {class: 'field-help help-bottom', text: 'Days as OpenAI counts them (UTC). Today fills in during the day.' + (u.week.other > 0.005 ? ' Other keys on this account spent ' + money(u.week.other, c) + ' in these days.' : '')})]));

        const total = u.features.reduce((sum, f) => sum + f.cost, 0) || 1;
        out.push(el('h2', {class: 'section-header', text: 'What it was spent on'}), el('div', {class: 'setting-block rows'}, u.features.length ? u.features.map(f => el('div', {class: 'usage-row'}, [
            el('div', {class: 'usage-name', text: f.label}), el('div', {class: 'usage-money', text: money(f.cost, c)}),
            el('div', {class: 'usage-use', text: f.use}), el('div', {class: 'usage-tokens', text: tokens(f.tokens) + ' tokens'}),
            el('div', {class: 'share'}, [el('div', {style: {width: (f.cost / total * 100).toFixed(1) + '%'}})])])) : [el('div', {class: 'empty', text: 'Nothing spent in the last 7 days.'})]));

        out.push(el('h2', {class: 'section-header', text: 'Models'}), el('div', {class: 'setting-block rows'}, u.models.length ? u.models.map(m => el('div', {class: 'usage-row'}, [
            el('div', {class: 'usage-name'}, [m.model, el('span', {class: 'chip', text: m.label})]), el('div', {class: 'usage-money', text: money(m.cost, c)}),
            el('div', {class: 'usage-use', text: m.use}),
            el('div', {class: 'usage-tokens', text: tokens(m.tokens) + ' tokens', title: tokens(m.input) + ' in · ' + tokens(m.cached) + ' from cache · ' + tokens(m.output) + ' out'})])) : [el('div', {class: 'empty', text: 'No models used in the last 7 days.'})]));

        const notes = [];
        if (u.caching.cachedTokens) notes.push(el('div', {class: 'note-row'}, [el('div', {class: 'usage-name', text: 'Caching saved about ' + money(u.caching.saved, c)}),
            el('div', {class: 'usage-use', text: Math.round(u.caching.share * 100) + '% of the input came from OpenAI\'s cache at a lower price: the start of each conversation (the persona, the memory, the tools) stays the same from turn to turn. Editing the persona often makes this share drop.'})]));
        if (u.whatIf) notes.push(el('div', {class: 'note-row'}, [el('div', {class: 'usage-name', text: u.whatIf.would === null ? 'The other conversation model' : 'With ' + u.whatIf.other + ': about ' + money(u.whatIf.would, c)}),
            el('div', {class: 'usage-use', text: u.whatIf.would === null ? u.whatIf.other + ' has no price yet on this account for everything Jibo used (it is worked out from the bills of the last few weeks).'
                : 'The same conversations cost ' + money(u.whatIf.actual, c) + ' with ' + u.whatIf.model + ' in the last 7 days. Prices are this account\'s own, from its bills. Change it on the Brain tab.'})]));
        if (notes.length) out.push(el('h2', {class: 'section-header', text: 'Savings and choices'}), el('div', {class: 'setting-block'}, notes));

        out.push(el('h2', {class: 'section-header', text: 'When Jibo is used'}), el('div', {class: 'setting-block'}, [hourGrid(u.hours),
            el('div', {class: 'field-help help-bottom', text: 'Requests to OpenAI per hour, in Jibo\'s time. Darker is more.'})]));
        return out;
    }
    function usagePanel() {
        const body = el('div', {}, usage ? usageBody(usage) : [el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Asking OpenAI…'})])]);
        const status = el('span');
        const refresh = el('button', {class: 'btn btn-flat', type: 'button', text: 'Refresh'});
        const bar = el('div', {class: 'usage-status'}, [status, refresh]);
        function showStatus(busy) {
            refresh.disabled = !!busy;
            bar.hidden = !(state.adminKey && state.adminKey.set);
            status.textContent = busy ? 'Asking OpenAI…' : usage && usage.ok ? 'Counting ' + (usage.key.name ? '"' + usage.key.name + '" ' : '') + usage.key.hint +
                ' · updated ' + ago(usage.fetchedAt) + (usage.tooSoon ? ' (Refresh again in a minute)' : '') : '';
        }
        function load(fresh) {
            if (!(state.adminKey && state.adminKey.set)) { usage = {state: 'no-key'}; body.replaceChildren.apply(body, usageBody(usage)); showStatus(false); return; }
            showStatus(true);
            request('GET', '/api/usage' + (fresh ? '?refresh=1' : '')).then(result => {
                usage = result.json || {ok: false, error: 'Jibo sent no answer.'};
            }).catch(() => { usage = {ok: false, state: 'error', error: 'Jibo did not answer.'}; })
              .then(() => {
                  if (!body.isConnected) return;
                  // The key row shows the deleted key's hint until redrawn.
                  if (usage.state === 'removed' && state.adminKey.set) { state.adminKey = {set: false, hint: ''}; render(); return; }
                  body.replaceChildren.apply(body, usageBody(usage)); showStatus(false); drawCharts();
              });
        }
        refresh.addEventListener('click', () => load(true));
        showStatus(false);
        if (usageWanted || !usage) { usageWanted = false; load(false); }
        return [el('h2', {class: 'section-header', text: 'OpenAI'}), el('div', {class: 'setting-block'}, [adminKeyRow()])].concat(settingsPanel('usage'), [bar, body]);
    }

    // ---- page ----
    function render() {
        const main = $('main');
        const scroll = window.scrollY;
        const panel = active === 'persona' ? personaPanel() : active === 'history' ? historyPanel() : active === 'memory' ? memoryPanel() : active === 'usage' ? usagePanel() : settingsPanel(active);
        const intro = active === 'persona' ? [] : [el('p', {class: 'hint', text: INTRO[active]})];
        const notices = state.broken ? [el('div', {class: 'banner', text: 'Jibo\'s settings file could not be read (' + state.broken + '). Saving writes a new one.'})] : [];
        main.replaceChildren(el('section', {class: 'panel is-active'}, notices.concat(intro, panel)));
        $('nav').replaceChildren.apply($('nav'), TABS.map(tab => el('button', {class: 'tab' + (tab.id === active ? ' is-active' : ''), type: 'button',
            'aria-current': tab.id === active ? 'page' : null, onclick: () => {
                active = tab.id;
                if (active === 'usage') usageWanted = true;
                try { localStorage.setItem('noggin-tab', active); } catch (_) {}
                render(); window.scrollTo(0, 0);
            }, html: icon(tab.icon) + '<span>' + tab.label + '</span>'})));
        updateSaveBar();
        drawCharts();
        window.scrollTo(0, scroll);
    }

    $('save').addEventListener('click', save);
    $('discard').addEventListener('click', discard);
    load();
})();
