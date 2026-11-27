// SPDX-License-Identifier: MIT
// Noggin's settings page, the Memory tab: the facts and notes Jibo keeps (GET /api/memory).
// Changes here are saved at once, not with Save.
// Plain browser JavaScript, ES2015, no libraries; loaded after app.js.
(function () {
    'use strict';
    const page = window.NogginPage;
    const el = page.el, request = page.request, toast = page.toast, settingsPanel = page.settingsPanel;

    // A fact with Edit and Delete. act(url, body) saves at once and shows Jibo's answer.
    function factRow(fact, act) {
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
                el('button', {class: 'btn btn-flat', type: 'button', text: 'Save', onclick: () => act('/api/memory/fact', {id: fact.id,
                    text: input.value, expires: fact.expires || ''})}),
                el('button', {class: 'btn btn-flat', type: 'button', text: 'Cancel', onclick: view})
            ]));
            input.focus();
        }
        view();
        return row;
    }
    // What Jibo remembers (m from /api/memory) in the tab's blocks {facts, notes, fullness}.
    function showMemory(m, blocks, act) {
        const facts = blocks.facts, notes = blocks.notes;
        blocks.fullness.textContent = m.facts.length + (m.facts.length === 1 ? ' fact, ' : ' facts, ') + Math.round(100 * m.used / m.max) + '% of the space for facts.';
        const input = el('input', {type: 'text', maxlength: 160, placeholder: 'Sam\'s birthday is March 3', 'aria-label': 'New fact'});
        const add = () => { if (input.value.trim()) act('/api/memory/fact', {text: input.value}); };
        input.addEventListener('keydown', event => { if (event.key === 'Enter') add(); });
        const rows = m.facts.length ? m.facts.map(fact => factRow(fact, act)) : [el('div', {class: 'empty', text: 'No facts yet.'})];
        facts.replaceChildren.apply(facts, rows.concat([
            el('div', {class: 'log-row memory-add'}, [el('div', {class: 'memory-text memory-edit'}, [input]),
                el('div', {class: 'log-actions'}, [el('button', {class: 'btn btn-flat', type: 'button', text: 'Add', onclick: add})])])
        ]));
        notes.replaceChildren.apply(notes, m.summaries.length ? m.summaries.map(note => el('div', {class: 'log-row'}, [
            el('div', {class: 'memory-text'}, [el('div', {class: 'log-title', text: note.when}), el('div', {text: note.text})]),
            el('div', {class: 'log-actions'}, [el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Delete',
                onclick: () => act('/api/memory/delete', {kind: 'summary', id: note.id})})])
        ])) : [el('div', {class: 'empty', text: 'No notes yet. After a conversation ends, Jibo writes one within a minute.'})]);
    }
    // Import: the file is read here and sent to Jibo as it is; Jibo checks every entry like a new one
    // (D156). mode: 'add' or 'replace'; show(m) shows Jibo's answer.
    function importFile(file, mode, show) {
        if (file.size > 512 * 1024) { toast('That file is too big for a memory export.', true); return; }
        const reader = new FileReader();
        reader.onerror = () => toast('That file could not be read.', true);
        reader.onload = () => {
            let data;
            try { data = JSON.parse(String(reader.result)); } catch (_) { toast('That file is not a memory export.', true); return; }
            if (!data || typeof data !== 'object' || Array.isArray(data)) { toast('That file is not a memory export.', true); return; }
            if (Array.isArray(data.summaries)) data.summaries = data.summaries.map(n => n && typeof n === 'object' ? {text: n.text, day: n.day, part: n.part, at: n.at} : n);
            const nf = Array.isArray(data.facts) ? data.facts.length : 0, nn = Array.isArray(data.summaries) ? data.summaries.length : 0;
            const count = nf + (nf === 1 ? ' fact and ' : ' facts and ') + nn + (nn === 1 ? ' note' : ' notes');
            const ask = mode === 'replace'
                ? 'Jibo forgets every fact and note he has now and takes the ' + count + ' in "' + file.name + '" instead. This cannot be undone.'
                : 'Add the ' + count + ' in "' + file.name + '" to what Jibo remembers? Nothing he knows now is removed.';
            if (!window.confirm(ask)) return;
            request('POST', '/api/memory/import', mode === 'replace' ? {data: data, mode: mode, confirm: true} : {data: data, mode: mode}).then(result => {
                if (result.status !== 200) { toast(result.json && result.json.error || 'Not imported.', true); return; }
                show(result.json);
                toast(result.json.message || 'Imported.', false, 12000);
            }).catch(() => toast('Jibo did not answer.', true));
        };
        reader.readAsText(file);
    }
    function memoryPanel() {
        const loading = () => el('div', {class: 'setting-block'}, [el('div', {class: 'empty', text: 'Loading…'})]);
        const blocks = {facts: loading(), notes: loading(), fullness: el('div', {class: 'field-help'})};
        const failed = () => { blocks.facts.replaceChildren(el('div', {class: 'empty', text: 'Jibo did not answer.'})); blocks.notes.replaceChildren(); };
        const show = m => showMemory(m, blocks, act);
        function act(url, body) {
            return request('POST', url, body).then(result => {
                if (result.status !== 200) { toast(result.json && result.json.error || 'Not saved.', true); return false; }
                show(result.json);
                return true;
            }).catch(() => { toast('Jibo did not answer.', true); return false; });
        }
        request('GET', '/api/memory').then(result => { if (result.status === 200) show(result.json); else failed(); }).catch(failed);
        const forget = el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Forget everything', onclick: () => {
            if (window.confirm('Jibo forgets every fact and every note. This cannot be undone.')) act('/api/memory/clear', {confirm: true});
        }});
        let importMode = 'add';
        const picker = el('input', {type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Memory file'});
        function pick(mode) { importMode = mode; picker.click(); }
        picker.addEventListener('change', () => {
            const file = picker.files && picker.files[0];
            picker.value = '';
            if (file) importFile(file, importMode, show);
        });
        return settingsPanel('memory').concat([
            el('h2', {class: 'section-header', text: 'Facts'}), blocks.fullness, blocks.facts,
            el('h2', {class: 'section-header', text: 'Recent conversations'}),
            el('div', {class: 'field-help', text: 'Notes Jibo keeps for two weeks. He has the newest few at hand; he looks up the rest when someone asks.'}), blocks.notes,
            el('div', {class: 'memory-tools'}, [el('div', {class: 'memory-files'}, [
                el('a', {class: 'btn btn-flat', href: '/api/memory/export', download: 'noggin-memory.json', text: 'Export'}),
                el('button', {class: 'btn btn-flat', type: 'button', text: 'Import', onclick: () => pick('add')}),
                el('button', {class: 'btn btn-flat-danger', type: 'button', text: 'Import and replace', onclick: () => pick('replace')}),
                picker]), forget])
        ]);
    }

    page.panels.memory = memoryPanel;
})();
