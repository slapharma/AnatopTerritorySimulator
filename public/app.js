/* Launch Working Group — front end. Plain JS, no build step. */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = { config: null, sessions: [], session: null, running: false, stopRequested: false, activeTab: 'sources' };

  // ---------------- API ----------------
  const api = {
    async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
    async send(method, url, body) {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json();
    },
  };

  // ---------------- helpers ----------------
  const AGENT_LABEL = { regulatory: 'Regulatory Agent', clinical: 'Clinical Agent', commercial: 'Commercial Agent', moderator: 'Moderator Assistant', user: 'Moderator (you)' };
  const MODE_LABEL = { opening: 'Round 1', round2: 'Round 2', round3: 'Round 3', crosstalk: 'Cross-talk', reply: 'Reply', custom: 'Custom round', decision: 'Decision output', dive_deeper: 'Dive Deeper' };
  function fmtTime(utc) {
    if (!utc) return '';
    const d = new Date(utc.replace(' ', 'T') + 'Z');
    return isNaN(d) ? utc : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function money(usd) {
    const gbp = usd * (state.config ? state.config.usd_to_gbp : 0.78);
    return `$${usd.toFixed(usd < 1 ? 3 : 2)} · £${gbp.toFixed(gbp < 1 ? 3 : 2)}`;
  }
  function toast(text, ms = 3000) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = text; document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // Markdown -> HTML, then decorate badges, citations, question blocks and disagreement blocks.
  function renderMarkdown(text) {
    let html = window.marked ? marked.parse(text || '', { breaks: true, gfm: true }) : `<p>${escapeHtml(text)}</p>`;
    html = html.replace(/\[(VERIFIED|ESTIMATE|UNKNOWN)\b\s*(?:&#8212;|—|–|:|-)?\s*([^\]]*)\]/g, (m, tag, detail) => {
      const d = detail.trim();
      return `<span class="badge badge-${tag.toLowerCase()}" title="${escapeHtml(d.replace(/<[^>]+>/g, ''))}">${tag}${d ? ` <span class="d">${d}</span>` : ''}</span>`;
    });
    const max = state.session ? state.session.sources.length : 0;
    html = html.replace(/\[(\d{1,3})\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= max ? `<a class="cite" href="#src-${n}" data-src="${n}" title="Source ${n}">[${n}]</a>` : m));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const root = tpl.content;
    // "Questions for X:" blocks
    for (const el of Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6'))) {
      if (/^\s*questions?\s+for\b/i.test(el.textContent)) {
        const box = document.createElement('div'); box.className = 'questions';
        el.parentNode.insertBefore(box, el); box.appendChild(el);
        let sib = box.nextSibling;
        while (sib && !(sib.nodeType === 1 && /^H[1-6]$/.test(sib.tagName)) && !(sib.nodeType === 1 && /^\s*questions?\s+for\b/i.test(sib.textContent))) {
          const next = sib.nextSibling; box.appendChild(sib); sib = next;
          if (box.children.length > 4) break;
        }
      }
    }
    // ⚠ DISAGREEMENT blocks
    for (const el of Array.from(root.querySelectorAll('p, h1, h2, h3, h4, li, blockquote'))) {
      if (/^\s*⚠/.test(el.textContent) && !el.closest('.disagreement')) {
        const box = document.createElement('div'); box.className = 'disagreement';
        el.parentNode.insertBefore(box, el); box.appendChild(el);
        let sib = box.nextSibling;
        while (sib && sib.nodeType === 1 && /^(P|UL|OL)$/.test(sib.tagName) && /position|evidence|status/i.test(sib.textContent) && box.children.length < 6) {
          const next = sib.nextSibling; box.appendChild(sib); sib = next;
        }
      }
    }
    return root;
  }

  // ---------------- sidebar ----------------
  async function loadSessions() {
    state.sessions = await api.get('/api/sessions');
    const list = $('#session-list');
    list.innerHTML = '';
    if (!state.sessions.length) list.innerHTML = '<div class="empty">No sessions yet.</div>';
    for (const s of state.sessions) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'session-item' + (state.session && state.session.id === s.id ? ' active' : '');
      b.innerHTML = `<div class="t">${escapeHtml(s.title)}</div><div class="m"><span>${escapeHtml(s.country || '')}</span><span>${fmtTime(s.updated_at)}</span><span>${s.message_count} msgs</span>${s.has_decision ? '<span title="Decision output written">✓ decision</span>' : ''}</div>`;
      b.addEventListener('click', () => openSession(s.id));
      list.appendChild(b);
    }
  }

  // ---------------- setup view ----------------
  function buildForm() {
    const wrap = $('#setup-fields');
    wrap.innerHTML = '';
    for (const f of state.config.input_fields) {
      const div = document.createElement('div');
      div.className = 'field' + (f.multiline ? ' wide' : '');
      const id = `f-${f.key}`;
      const control = f.options
        ? `<select id="${id}" name="${f.key}"><option value="">— Select —</option>${f.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>`
        : f.multiline ? `<textarea id="${id}" name="${f.key}"></textarea>` : `<input id="${id}" name="${f.key}" type="text">`;
      div.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label>${control}${f.hint ? `<span class="hint">${escapeHtml(f.hint)}</span>` : ''}`;
      wrap.appendChild(div);
    }
  }
  function fillForm(values, { clear } = { clear: false }) {
    for (const f of state.config.input_fields) {
      const el = $(`[name="${f.key}"]`, $('#setup-form'));
      if (!el) continue;
      if (values[f.key] !== undefined) el.value = values[f.key];
      else if (clear) el.value = '';
    }
  }
  function readForm() {
    const inputs = {};
    for (const f of state.config.input_fields) inputs[f.key] = ($(`[name="${f.key}"]`, $('#setup-form')).value || '').trim();
    return inputs;
  }
  function showSetup() {
    state.session = null;
    $('#view-session').hidden = true;
    $('#view-setup').hidden = false;
    $$('.session-item').forEach((el) => el.classList.remove('active'));
  }

  // ---------------- session view ----------------
  async function openSession(id) {
    state.session = await api.get(`/api/sessions/${id}`);
    $('#view-setup').hidden = true;
    $('#view-session').hidden = false;
    renderSession();
    $$('.session-item').forEach((el) => el.classList.remove('active'));
    await loadSessions();
  }

  function renderSession() {
    const s = state.session;
    $('#session-title').textContent = s.title;
    $('#session-sub').textContent = `${s.inputs.product || 'Product: INPUT MISSING'} · ${s.inputs.country || 'Country: INPUT MISSING'} · created ${fmtTime(s.created_at)}`;
    $('#link-docx').href = `/api/sessions/${s.id}/export.docx`;
    $('#link-pdf').href = `/api/sessions/${s.id}/export.pdf`;
    // inputs summary
    const missing = state.config.input_fields.filter((f) => !(s.inputs[f.key] || '').trim());
    $('#inputs-summary').innerHTML = `<details><summary>Inputs · ${state.config.input_fields.length - missing.length} filled, ${missing.length} INPUT MISSING</summary><dl>${state.config.input_fields.map((f) => `<dt>${escapeHtml(f.label)}</dt><dd class="${(s.inputs[f.key] || '').trim() ? '' : 'missing'}">${escapeHtml((s.inputs[f.key] || '').trim() || 'INPUT MISSING')}</dd>`).join('')}</dl></details>`;
    // transcript
    renderTranscript();
    renderSources(); renderDisagreements(); renderCost();
    setRunning(state.running);
    const t = $('#transcript');
    t.scrollTop = t.scrollHeight;
  }

  // Speaker filter (chips above the transcript) + round/mode dividers, so a long
  // session stays navigable: jump to one agent's thread, or see where a round starts.
  function renderTranscript() {
    const s = state.session;
    const t = $('#transcript');
    t.innerHTML = '';
    if (!s.messages.length) { t.innerHTML = '<div class="empty">No messages yet. Run Round 1 to start.</div>'; return; }
    let lastMode = null;
    for (const m of s.messages) {
      if (m.mode && m.mode !== lastMode && m.role !== 'user') {
        const div = document.createElement('div'); div.className = 'round-divider'; div.dataset.mode = m.mode;
        div.innerHTML = `<span>${escapeHtml(MODE_LABEL[m.mode] || m.mode)}</span>`;
        t.appendChild(div);
        lastMode = m.mode;
      }
      t.appendChild(messageElement(m));
    }
    applyFilter();
  }

  function applyFilter() {
    const active = state.filterSpeaker || 'all';
    $$('#filter-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.speaker === active));
    $$('#transcript .msg').forEach((el) => {
      el.hidden = active === 'favourites' ? !el.classList.contains('favourited')
        : active !== 'all' && el.dataset.speaker !== active;
    });
    $$('#transcript .round-divider').forEach((el) => {
      // Hide a divider only if every message in its group is filtered out.
      let sib = el.nextElementSibling; let anyVisible = false;
      while (sib && !sib.classList.contains('round-divider')) { if (sib.classList.contains('msg') && !sib.hidden) anyVisible = true; sib = sib.nextElementSibling; }
      el.hidden = !anyVisible;
    });
  }

  function messageElement(m) {
    const speaker = m.role === 'user' ? 'user' : m.speaker;
    const el = document.createElement('article');
    el.className = `msg msg-${speaker}${m.favourite ? ' favourited' : ''}`;
    el.id = `msg-${m.id}`;
    el.dataset.speaker = speaker;
    const to = m.role === 'user' && m.addressed_to && m.addressed_to !== 'all' ? ` → ${AGENT_LABEL[m.addressed_to]}` : '';
    el.innerHTML = `<div class="msg-head"><span class="msg-who">${escapeHtml(AGENT_LABEL[speaker] || speaker)}${escapeHtml(to)}</span>${m.mode && m.role !== 'user' ? `<span class="msg-mode">${MODE_LABEL[m.mode] || m.mode}</span>` : ''}<span class="msg-meta">#${m.seq} · ${fmtTime(m.created_at)}</span><span class="spacer"></span><span class="msg-meta">${m.cost_usd ? money(m.cost_usd) : ''}</span><button type="button" class="fav-btn${m.favourite ? ' on' : ''}" title="${m.favourite ? 'Remove from favourites' : 'Favourite this response'}" aria-pressed="${m.favourite ? 'true' : 'false'}">${m.favourite ? '★' : '☆'}</button></div>`;
    const favBtn = $('.fav-btn', el);
    favBtn.addEventListener('click', async () => {
      const next = !favBtn.classList.contains('on');
      favBtn.disabled = true;
      try {
        const updated = await api.send('PATCH', `/api/sessions/${state.session.id}/messages/${m.id}/favourite`, { favourite: next });
        m.favourite = updated.favourite;
        favBtn.classList.toggle('on', m.favourite);
        favBtn.textContent = m.favourite ? '★' : '☆';
        favBtn.title = m.favourite ? 'Remove from favourites' : 'Favourite this response';
        favBtn.setAttribute('aria-pressed', m.favourite ? 'true' : 'false');
        el.classList.toggle('favourited', m.favourite);
        if (state.filterSpeaker === 'favourites') applyFilter();
      } catch (e) { toast(`Could not update favourite: ${e.message}`); } finally { favBtn.disabled = false; }
    });
    const body = document.createElement('div'); body.className = 'msg-body';
    if (m.error) {
      const err = document.createElement('div'); err.className = 'msg-error';
      err.innerHTML = `<span>Turn failed: <code>${escapeHtml(m.error)}</code></span>`;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-sm'; retry.textContent = 'Retry';
      retry.addEventListener('click', async () => {
        if (state.running) return;
        await api.send('DELETE', `/api/sessions/${state.session.id}/messages/${m.id}`);
        state.session.messages = state.session.messages.filter((x) => x.id !== m.id);
        el.remove();
        await runSequence([{ speaker: m.speaker, mode: m.mode }]);
      });
      err.appendChild(retry);
      el.appendChild(err);
    } else {
      body.appendChild(renderMarkdown(m.text));
      el.appendChild(body);
      if ((m.text || '').length > 2500 && m.mode !== 'decision') {
        body.classList.add('collapsed');
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-sm msg-expand'; btn.textContent = 'Show full message';
        btn.addEventListener('click', () => { const c = body.classList.toggle('collapsed'); btn.textContent = c ? 'Show full message' : 'Collapse'; });
        el.appendChild(btn);
      }
      // Custom rounds aren't offered: the free-form instruction that produced this
      // response isn't stored on the message, so it can't be reproduced faithfully.
      if (m.role !== 'user' && m.mode !== 'custom') {
        const regen = document.createElement('button'); regen.type = 'button'; regen.className = 'btn btn-sm msg-regen'; regen.textContent = '↻ Regenerate';
        regen.title = 'Delete this response and have the agent answer again';
        regen.addEventListener('click', async () => {
          if (state.running) return;
          if (!confirm('Delete this response and regenerate it? This cannot be undone.')) return;
          await api.send('DELETE', `/api/sessions/${state.session.id}/messages/${m.id}`);
          state.session.messages = state.session.messages.filter((x) => x.id !== m.id);
          el.remove();
          await runSequence([{ speaker: m.speaker, mode: m.mode }]);
        });
        el.appendChild(regen);
      }
      // Responses are compact by default (see COMPACT_SUFFIX server-side); this asks
      // the same agent to expand THIS specific response as a new follow-up message.
      if (m.role !== 'user' && m.mode !== 'decision') {
        const dive = document.createElement('button'); dive.type = 'button'; dive.className = 'btn btn-sm msg-dive'; dive.textContent = '⇊ Dive Deeper';
        dive.title = 'Ask the agent to expand this specific response with full detail';
        dive.addEventListener('click', async () => {
          if (state.running) return;
          await runSequence([{ speaker: m.speaker, mode: 'dive_deeper', instruction: `Expand your response #${m.seq} above.` }]);
        });
        el.appendChild(dive);
      }
    }
    return el;
  }

  function renderSources() {
    const s = state.session;
    $('#count-sources').textContent = s.sources.length;
    const box = $('#tab-sources');
    if (!s.sources.length) { box.innerHTML = '<div class="empty">No sources yet. Every URL the agents search or cite appears here, numbered.</div>'; return; }
    box.innerHTML = s.sources.map((src) => {
      const by = [...new Set(src.cited_by.map((c) => AGENT_LABEL[c.speaker] || c.speaker))].join(', ');
      const backlink = src.first_message_id ? ` · <a href="#msg-${src.first_message_id}" class="src-back" data-msg="${src.first_message_id}">↑ view in message</a>` : '';
      return `<div class="src" id="src-${src.n}"><span class="n">[${src.n}]</span>${escapeHtml(src.title || src.url)}<span class="kind ${src.kind}">${src.kind === 'cited' ? 'cited' : 'searched'}</span><br><a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(src.url)}</a><div class="meta">First ${fmtTime(src.first_cited_at)} · ${escapeHtml(by)}${backlink}</div></div>`;
    }).join('');
  }

  function renderDisagreements() {
    const s = state.session;
    const open = s.disagreements.filter((d) => d.status !== 'resolved').length;
    $('#count-dis').textContent = s.disagreements.length ? `${open}/${s.disagreements.length}` : '0';
    const box = $('#tab-disagreements');
    if (!s.disagreements.length) { box.innerHTML = '<div class="empty">No disagreements logged. Agents mark genuine disputes with ⚠ DISAGREEMENT; they appear here with a status you can toggle.</div>'; return; }
    box.innerHTML = '';
    for (const d of s.disagreements) {
      const el = document.createElement('div'); el.className = 'dis';
      el.innerHTML = `<div class="topic">#${d.n} ${escapeHtml(d.topic)}<button type="button" class="status ${d.status}" title="Click to toggle">${d.status.toUpperCase()}</button></div><div class="body">${escapeHtml(d.body)}</div>`;
      $('.status', el).addEventListener('click', async () => {
        const next = d.status === 'resolved' ? 'unresolved' : 'resolved';
        state.session.disagreements = await api.send('PATCH', `/api/sessions/${s.id}/disagreements/${d.n}`, { status: next });
        renderDisagreements();
      });
      box.appendChild(el);
    }
  }

  function renderCost() {
    const s = state.session;
    const sum = (k) => s.messages.reduce((a, m) => a + (m[k] || 0), 0);
    const total = sum('cost_usd');
    $('#cost-meter').textContent = money(total);
    const p = state.config.prices;
    $('#tab-cost').innerHTML = `<table class="cost-table">
      <tr><td>Model</td><td>${escapeHtml(state.config.model)}</td></tr>
      <tr><td>Input tokens</td><td>${sum('input_tokens').toLocaleString()}</td></tr>
      <tr><td>Cache reads</td><td>${sum('cache_read_tokens').toLocaleString()}</td></tr>
      <tr><td>Cache writes</td><td>${sum('cache_write_tokens').toLocaleString()}</td></tr>
      <tr><td>Output tokens</td><td>${sum('output_tokens').toLocaleString()}</td></tr>
      <tr><td>Web searches</td><td>${sum('searches').toLocaleString()}</td></tr>
      <tr><td>Agent turns</td><td>${s.messages.filter((m) => m.role !== 'user').length}</td></tr>
      <tr class="total"><td>Estimated cost</td><td>${money(total)}</td></tr>
    </table>
    <p class="muted" style="margin-top:10px">Prices from <code>src/config.js</code>: $${p.input_per_mtok}/M in, $${p.output_per_mtok}/M out, $${p.web_search_per_1000}/1k searches. Estimate only; check the Anthropic console for billing.</p>`;
  }

  function setRunning(on) {
    state.running = on;
    $$('#toolbar button, #btn-send, #btn-delete').forEach((b) => { if (b.id !== 'btn-stop') b.disabled = on; });
    $('#btn-stop').hidden = !on;
    if (!on) state.stopRequested = false;
  }

  // ---------------- running turns ----------------
  // Streams one agent turn. Resolves when the turn is done or has failed.
  function runTurn({ speaker, mode, instruction }) {
    return new Promise(async (resolve) => {
      const t = $('#transcript');
      $('.empty', t)?.remove();
      const el = document.createElement('article');
      el.className = `msg msg-${speaker}`;
      el.innerHTML = `<div class="msg-head"><span class="msg-who">${escapeHtml(AGENT_LABEL[speaker])}</span><span class="msg-mode">${MODE_LABEL[mode] || mode}</span><span class="msg-meta">now</span></div><div class="msg-status"><span class="spinner"></span><span class="txt">Thinking…</span></div><div class="msg-searches"></div><div class="msg-body"></div>`;
      t.appendChild(el);
      const body = $('.msg-body', el); const statusEl = $('.msg-status .txt', el); const searchesEl = $('.msg-searches', el);
      let raw = '';
      let lastRender = 0;
      const atBottom = () => t.scrollHeight - t.scrollTop - t.clientHeight < 120;
      const paint = (force) => {
        const now = Date.now();
        if (!force && now - lastRender < 250) return;
        lastRender = now;
        const stick = atBottom();
        body.replaceChildren(renderMarkdown(raw));
        if (stick) t.scrollTop = t.scrollHeight;
      };
      let messageId = null;
      const finish = async (ok, errText) => {
        if (ok) {
          // Replace the live element with the stored message so numbering, cost and citations are exact.
          const stored = state.session.messages[state.session.messages.length - 1];
          el.replaceWith(messageElement(stored));
        } else {
          $('.msg-status', el)?.remove();
          const err = document.createElement('div'); err.className = 'msg-error';
          err.innerHTML = `<span>Turn failed: <code>${escapeHtml(errText)}</code></span>`;
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-sm'; retry.textContent = 'Retry';
          retry.addEventListener('click', async () => {
            if (state.running) return;
            if (messageId) { await api.send('DELETE', `/api/sessions/${state.session.id}/messages/${messageId}`); state.session.messages = state.session.messages.filter((x) => x.id !== messageId); }
            el.remove();
            await runSequence([{ speaker, mode, instruction }]);
          });
          err.appendChild(retry);
          el.appendChild(err);
        }
        resolve(ok);
      };
      try {
        const r = await fetch(`/api/sessions/${state.session.id}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speaker, mode, instruction }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); return finish(false, j.error || r.statusText); }
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        let done = false;
        let failed = null;
        while (!done) {
          const { value, done: d } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const ev = /^event: (.*)$/m.exec(chunk); const da = /^data: (.*)$/m.exec(chunk);
            if (!ev || !da) continue;
            const name = ev[1]; const data = JSON.parse(da[1]);
            if (name === 'start') { messageId = data.message_id; $('.msg-meta', el).textContent = `#${data.seq} · ${fmtTime(data.created_at)}`; }
            else if (name === 'status') statusEl.textContent = data.text;
            else if (name === 'search') { const s = document.createElement('span'); s.textContent = `🔎 ${data.query}`; searchesEl.appendChild(s); }
            else if (name === 'text') { raw += data.delta; paint(false); }
            else if (name === 'done') {
              state.session.messages.push(data.message); state.session.sources = data.sources; state.session.disagreements = data.disagreements;
              if (data.message.mode === 'decision') state.session.decision_text = data.message.text;
              renderSources(); renderDisagreements(); renderCost();
              if (data.new_disagreements.length) toast(`${data.new_disagreements.length} disagreement(s) logged`);
              done = true;
            } else if (name === 'error') { failed = data.message; done = true; }
          }
        }
        if (failed) return finish(false, failed);
        if (!done) return finish(false, 'Connection closed before the turn finished');
        paint(true);
        return finish(true);
      } catch (e) {
        return finish(false, e.message || String(e));
      }
    });
  }

  async function runSequence(turns) {
    if (state.running) { toast('A turn is already running'); return; }
    setRunning(true);
    try {
      for (const turn of turns) {
        if (state.stopRequested) { toast('Stopped'); break; }
        const ok = await runTurn(turn);
        if (!ok) break; // leave the retry button in place; don't cascade failures
      }
    } finally {
      setRunning(false);
      loadSessions();
    }
  }

  const ALL = ['regulatory', 'clinical', 'commercial'];

  // ---------------- events ----------------
  async function init() {
    state.config = await api.get('/api/config');
    buildForm();
    $('#sidebar-foot').innerHTML = `Model <code>${escapeHtml(state.config.model)}</code>${state.config.has_api_key ? '' : '<br><strong style="color:#B91C1C">No API key: add it to .env and restart</strong>'}`;
    await loadSessions();
    if (state.sessions.length) await openSession(state.sessions[0].id);

    $('#btn-new').addEventListener('click', showSetup);
    $('#btn-load-korea').addEventListener('click', () => { fillForm(state.config.base_values, { clear: true }); toast('Base values loaded. Remaining fields stay INPUT MISSING unless you fill them.'); });
    $('#btn-copy-last').addEventListener('click', async () => { const last = await api.get('/api/sessions/last-inputs'); if (!Object.keys(last).length) return toast('No previous session'); fillForm(last, { clear: true }); });

    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.config.has_api_key) return toast('No API key set. Add ANTHROPIC_API_KEY to .env and restart the server.', 5000);
      const inputs = readForm();
      const created = await api.send('POST', '/api/sessions', { inputs });
      await openSession(created.id);
      await runSequence(ALL.map((a) => ({ speaker: a, mode: 'opening' })));
    });

    $$('#toolbar [data-round]').forEach((b) => b.addEventListener('click', () => runSequence(ALL.map((a) => ({ speaker: a, mode: b.dataset.round })))));
    $('#btn-decision').addEventListener('click', () => {
      if (!state.session.messages.some((m) => m.role === 'agent' && !m.error)) return toast('Run at least one round first');
      runSequence([{ speaker: 'moderator', mode: 'decision' }]);
    });
    $('#btn-stop').addEventListener('click', () => { state.stopRequested = true; $('#btn-stop').textContent = 'Stopping after this turn…'; });

    $$('#filter-chips .chip').forEach((c) => c.addEventListener('click', () => { state.filterSpeaker = c.dataset.speaker; applyFilter(); }));

    $('#btn-custom').addEventListener('click', () => { $('#dlg-custom').showModal(); $('#custom-instruction').focus(); });
    $('#dlg-custom form').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'run') {
        const instruction = $('#custom-instruction').value.trim();
        const picks = $$('#dlg-custom input[type=checkbox]:checked').map((c) => c.value);
        if (!instruction) { e.preventDefault(); return toast('Write an instruction first'); }
        if (!picks.length) { e.preventDefault(); return toast('Pick at least one agent'); }
        setTimeout(() => runSequence(picks.map((a) => ({ speaker: a, mode: 'custom', instruction }))), 0);
      }
    });

    $('#composer').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = $('#composer-text').value.trim();
      if (!text || state.running) return;
      const to = $('#composer-to').value;
      const { message, respondents } = await api.send('POST', `/api/sessions/${state.session.id}/messages`, { text, to });
      state.session.messages.push(message);
      $('.empty', $('#transcript'))?.remove();
      $('#transcript').appendChild(messageElement(message));
      $('#composer-text').value = '';
      await runSequence(respondents.map((a) => ({ speaker: a, mode: 'reply' })));
    });
    $('#composer-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#composer').requestSubmit(); } });

    $('#session-title').addEventListener('click', async () => {
      const name = prompt('Session title', state.session.title);
      if (name && name.trim() && name !== state.session.title) { state.session = await api.send('PATCH', `/api/sessions/${state.session.id}`, { title: name.trim() }); renderSession(); loadSessions(); }
    });
    $('#btn-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${state.session.title}"? This cannot be undone.`)) return;
      await api.send('DELETE', `/api/sessions/${state.session.id}`);
      showSetup(); await loadSessions();
    });
    $('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); $('#export-menu').hidden = !$('#export-menu').hidden; });
    document.addEventListener('click', () => { $('#export-menu').hidden = true; });

    $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      ['sources', 'disagreements', 'cost'].forEach((k) => { $(`#tab-${k}`).hidden = k !== tab.dataset.tab; });
      state.activeTab = tab.dataset.tab;
    }));
    // Citation clicks open the Sources tab and highlight the entry.
    $('#transcript').addEventListener('click', (e) => {
      const a = e.target.closest('a.cite');
      if (!a) return;
      $$('.tab').find((t) => t.dataset.tab === 'sources').click();
      const target = $(`#src-${a.dataset.src}`);
      if (target) { target.scrollIntoView({ block: 'center' }); target.style.background = 'var(--primary-soft)'; setTimeout(() => (target.style.background = ''), 1500); }
      e.preventDefault();
    });
  }

  init().catch((e) => { console.error(e); toast(`Failed to start: ${e.message}`, 8000); });
})();
