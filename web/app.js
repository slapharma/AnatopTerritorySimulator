/* Launch Working Group — front end. Plain JS, no build step. */
(() => {
  'use strict';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = { config: null, sessions: [], session: null, running: false, stopRequested: false, activeTab: 'sources', sessionActiveMs: 0, warRoomOpen: false, evalsFilter: '', navPanel: null, intelCut: 'agent' };

  // ---------------- API ----------------
  // A 401 from our own API means the session has ended, and no error message
  // can fix that, so go to the sign-in page and come back here afterwards.
  // The returned promise never settles: the page is navigating away, and
  // letting the caller carry on would only flash a "Not signed in" error.
  // signingInAgain lets this redirect past the leave-page prompt
  // (warnIfMeetingRunning): with the session gone nothing more can run, and a
  // "Stay" here would leave a page stuck on a promise that never settles.
  let signingInAgain = false;
  function signInAgainIf401(r) {
    if (r.status !== 401) return null;
    signingInAgain = true;
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    return new Promise(() => {});
  }
  const api = {
    async get(url) { const r = await fetch(url); await signInAgainIf401(r); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText); return r.json(); },
    async send(method, url, body) {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      await signInAgainIf401(r);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      return r.json();
    },
  };

  // ---------------- helpers ----------------
  // Filled from /api/config once it loads (see boot()). `user` and `autopilot`
  // are UI-only pseudo-speakers with no manifest entry; everything else — label,
  // order and colour — comes from prompts/agents/index.json, so adding an agent
  // needs no edit here. The literals below are only the pre-config fallback.
  const AGENT_LABEL = { moderator: 'Moderator Assistant', user: 'Moderator (you)', autopilot: 'Autopilot', model: 'Model change' };
  const AGENT_COLOUR = {};
  // Enabled agent keys in manifest order. Populated by applyAgentRoster().
  const ALL = [];
  // The agent chips are built from the roster; only All / You / Favourites are
  // fixed markup, because they are not agents. Called from boot() before the
  // shared chip wiring, so these get their click handler from that, not here.
  function renderFilterChips() {
    const box = document.querySelector('#filter-chips');
    if (!box) return;
    const fixedTail = Array.from(box.querySelectorAll('.chip')).filter((c) => ['user', 'favourites'].includes(c.dataset.speaker));
    for (const c of Array.from(box.querySelectorAll('.chip'))) if (!['all', 'user', 'favourites'].includes(c.dataset.speaker)) c.remove();
    const first = box.querySelector('.chip[data-speaker="all"]');
    const frag = document.createDocumentFragment();
    for (const key of ALL) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip chip-${key}`;
      b.dataset.speaker = key;
      if (AGENT_COLOUR[key]) b.style.setProperty('--chip-dot', AGENT_COLOUR[key]);
      b.textContent = (state.config.agents[key] || {}).short || AGENT_LABEL[key] || key;
      frag.appendChild(b);
    }
    if (fixedTail.length) box.insertBefore(frag, fixedTail[0]);
    else if (first) first.after(frag);
    else box.appendChild(frag);
  }

  function applyAgentRoster(config) {
    const agents = config.agents || {};
    for (const [key, a] of Object.entries(agents)) {
      AGENT_LABEL[key] = a.label || key;
      if (a.colour) AGENT_COLOUR[key] = a.colour;
      if (a.colour_soft) AGENT_COLOUR[key + '_soft'] = a.colour_soft;
    }
    ALL.length = 0;
    ALL.push(...(config.agent_order || []));
  }
  // Inline custom properties let the stylesheet paint an agent it has never
  // heard of; the named .msg-<key> rules still win for the original three.
  function speakerStyle(key) {
    const c = AGENT_COLOUR[key];
    if (!c) return '';
    return ` style="--speaker: ${c}; --speaker-soft: ${AGENT_COLOUR[key + '_soft'] || 'transparent'}"`;
  }
  const MODE_LABEL = { opening: 'Baselines', round2: 'Challenge', round3: 'Converge', crosstalk: 'Cross-talk', reply: 'Reply', custom: 'Custom meeting', decision: 'Decision output', dive_deeper: 'Dive Deeper', autopilot: 'Autopilot' };
  // Modes where all three agents answer independently within the round — laid
  // out as a 3-column grid instead of stacked, both live and on reload.
  const GRID_MODES = ['opening', 'round2', 'round3', 'crosstalk'];
  const LENGTH_LABELS = ['300 characters', '600 characters', '1,200 characters', '2,500 characters', 'As required'];
  const LENGTH_VALUES = [300, 600, 1200, 2500, 'as_required'];
  // Fallback labels, kept in sync with prompts/stance.json; autopilotStanceRows
  // prefers the live labels from /api/config (state.config.stance_bank) when loaded.
  const STANCE_LABELS = ['Supportive', 'Constructive', 'Balanced', 'Demanding', 'Adversarial'];
  const DEPTH_LABELS = ['Brief · ~1 page', 'Standard · 3–5 pages', 'Full · 8–12 pages'];
  const DEPTH_VALUES = ['brief', 'standard', 'full'];
  const AUTOPILOT_OUTCOME_LABEL = {
    stopped_by_moderator: 'Stopped by the moderator', failed: 'A turn failed', unanimous: 'All agents reached AGREE',
    cost_cap: 'Cost cap reached', cycle_cap: 'Cycle limit reached', safety_cap: 'Safety cycle cap reached',
    resolved: 'The asker marked the question resolved',
  };
  const QUESTION_STATUS_LABEL = { open: 'Open', answered: 'Answered', resolved: 'Resolved', escalated: 'Escalated to moderator' };
  // The asker's verdict line in a question discussion (see rounds.json).
  // The last one counts: an asker may quote an earlier loop's verdict in the body.
  function parseQuestionStatus(text) {
    const all = [...String(text || '').matchAll(/QUESTION STATUS:\s*\**\s*(RESOLVED|OPEN)\b/gi)];
    return all.length ? all[all.length - 1][1].toUpperCase() : null;
  }
  function parsePosition(text) {
    const m = /POSITION:\s*(AGREE|DISAGREE)\b/i.exec(text || '');
    return m ? m[1].toUpperCase() : null;
  }
  function autopilotMeta(m) {
    if (!m.content_json) return null;
    try { return JSON.parse(m.content_json).autopilot || null; } catch { return null; }
  }
  function fmtTime(utc) {
    if (!utc) return '';
    // Postgres timestamptz rows arrive already ISO-8601 with a "Z"/offset suffix;
    // the old SQLite-era "YYYY-MM-DD HH:MM:SS" rows have neither and need both
    // added. Only add what's actually missing, or a trailing "Z" gets doubled
    // into an invalid date and this silently falls back to the raw string.
    const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(utc);
    const iso = hasZone ? utc.replace(' ', 'T') : `${utc.replace(' ', 'T')}Z`;
    const d = new Date(iso);
    return isNaN(d) ? utc : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
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

  // Safety net for a model that runs headings/rules/bullets together inline
  // instead of on their own line (FORMATTING RULES asks for real line breaks,
  // but this covers it if one slips through). Forces a blank line before each
  // recognised block-starter, then collapses any resulting excess blank lines.
  function normalizeSpacing(text) {
    if (!text) return text;
    const out = text.replace(/[ \t]*(#{1,6}\s|-{3,}(?:\s|$)|-\s(?=[A-Z*]))/g, '\n\n$1');
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  }

  // Markdown -> HTML, then decorate badges, citations, question blocks and disagreement blocks.
  function renderMarkdown(text) {
    let html = window.marked ? marked.parse(normalizeSpacing(text) || '', { breaks: true, gfm: true }) : `<p>${escapeHtml(text)}</p>`;
    // Agent/human message text is rendered as Markdown -> raw HTML; sanitize
    // before it ever touches innerHTML (marked itself does not sanitize).
    // Fail closed: if the sanitizer did not load, render the text as escaped
    // plain text rather than trusting raw HTML from an agent or another user.
    html = window.DOMPurify ? DOMPurify.sanitize(html) : `<p>${escapeHtml(text || '')}</p>`;
    html = html.replace(/\[(VERIFIED|ESTIMATE|UNKNOWN)\b\s*(?:&#8212;|—|–|:|-)?\s*([^\]]*)\]/g, (m, tag, detail) => {
      const d = detail.trim();
      return `<span class="badge badge-${tag.toLowerCase()}" title="${escapeHtml(d.replace(/<[^>]+>/g, ''))}">${tag}${d ? ` <span class="d">${d}</span>` : ''}</span>`;
    });
    const max = state.session ? state.session.sources.length : 0;
    html = html.replace(/\[(\d{1,3})\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= max ? `<a class="cite" href="#src-${n}" data-src="${n}" title="Source ${n}">[${n}]</a>` : m));
    // Closing-block labels required by FORMATTING RULES (Next step / Question / Consideration / Conclusion).
    // Tolerant of case drift and the colon landing inside or outside the bold —
    // the model is prompted for an exact literal, but treating any deviation
    // as "not a closing block" would just silently drop the badge, not fail loudly.
    // Matches <li> as well as <p>. The SLIDES contract puts the closing block on
    // the last slide's final bullet; today normalizeSpacing always inserts a blank
    // line before that bullet, so marked emits a loose list (<li><p>…) and the <p>
    // branch already catches it. The <li> branch is a safety net for the tight-list
    // case — it does not fire on current output, and is here so a later change to
    // normalizeSpacing cannot silently drop the badge.
    html = html.replace(/<(p|li)>(\s*)<strong>\s*(Next step|Question|Consideration|Conclusion)\s*:?\s*<\/strong>\s*:?/gi,
      (m, tag, lead, label) => {
        const norm = label.charAt(0).toUpperCase() + label.slice(1).toLowerCase();
        return `<${tag}>${lead}<span class="badge badge-endpoint badge-${norm.toLowerCase().replace(/\s+/g, '')}">${norm}</span>`;
      });
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
    // Slides deck — the SLIDES contract in prompts/evidence-rules.md. Runs last,
    // after Questions and ⚠ DISAGREEMENT: both of those stop their sibling walk
    // at a heading, so the `## Slides` heading keeps the deck out of them.
    // Grouped into cards so the summary reads as a summary and not as a second
    // argument appended to the body.
    for (const head of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
      if (!/^\s*slides\s*$/i.test(head.textContent) || head.closest('.slides')) continue;
      const deck = document.createElement('section');
      deck.className = 'slides';
      const label = document.createElement('div');
      label.className = 'slides-label';
      label.textContent = 'Summary slides';
      deck.appendChild(label);
      head.parentNode.insertBefore(deck, head);
      // Everything up to the end of the message, or to the next heading at the
      // same or a higher level if the model kept writing after the deck.
      const headLevel = Number(head.tagName.slice(1));
      const collected = [];
      for (let sib = head.nextSibling; sib;) {
        if (sib.nodeType === 1 && /^H[1-6]$/.test(sib.tagName) && Number(sib.tagName.slice(1)) <= headLevel) break;
        const next = sib.nextSibling;
        collected.push(sib);
        sib = next;
      }
      head.remove();
      let card = null;
      for (const node of collected) {
        if (node.nodeType === 1 && /^H[1-6]$/.test(node.tagName)) {
          card = document.createElement('article');
          card.className = 'slide';
          const title = document.createElement('div');
          title.className = 'slide-title';
          while (node.firstChild) title.appendChild(node.firstChild);
          // "Slide 1 — Title" -> number chip + title. Tolerates any dash, a colon,
          // or no prefix at all; a slide that deviates still renders as a slide.
          const first = title.firstChild;
          if (first && first.nodeType === 3) {
            const m = first.nodeValue.match(/^\s*slide\s*(\d+)\s*[—–:.-]*\s*/i);
            if (m) {
              first.nodeValue = first.nodeValue.slice(m[0].length);
              const chip = document.createElement('span');
              chip.className = 'slide-n';
              chip.textContent = m[1];
              title.insertBefore(chip, first);
            }
          }
          card.appendChild(title);
          deck.appendChild(card);
          node.remove();
          continue;
        }
        (card || deck).appendChild(node);
      }
    }
    return root;
  }

  // During challenge/converge/crosstalk/dive-deeper turns, hyperlink the first
  // plain-text mention of each OTHER agent to that agent's most recent prior
  // response, so "Luca" in a Round 2 rebuttal jumps to what they said.
  // The agents are on first-name terms, so the name is what actually appears in
  // their prose — matching only the full label ("Luca (Clinical)") would find
  // nothing. Longest form first, so "Luca (Clinical)" wins over the bare "Luca"
  // inside it and the link covers the whole reference.
  function mentionForms(key) {
    const a = (state.config.agents || {})[key] || {};
    // Bare "Regulatory" is deliberately not a form: it appears constantly as an
    // ordinary adjective ("the regulatory pathway") and would link the wrong word.
    return [AGENT_LABEL[key], a.function ? `${a.function} Agent` : '', a.name, a.short]
      .filter((v) => v && String(v).trim())
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort((x, y) => y.length - x.length);
  }

  function linkAgentMentions(bodyEl, m) {
    if (!['round2', 'round3', 'crosstalk', 'dive_deeper'].includes(m.mode)) return;
    const others = ALL.filter((a) => a !== m.speaker);
    for (const other of others) {
      const target = state.session.messages.filter((x) => x.speaker === other && x.seq < m.seq && !x.error).pop();
      if (!target) continue;
      const forms = mentionForms(other);
      const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
      let node;
      let linked = false;
      while (!linked && (node = walker.nextNode())) {
        if (node.parentElement.closest('a')) continue;
        for (const label of forms) {
          const idx = node.nodeValue.indexOf(label);
          if (idx === -1) continue;
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + label.length);
          const a = document.createElement('a');
          a.className = 'agent-ref'; a.href = `#msg-${target.id}`; a.title = `Jump to ${AGENT_LABEL[other]}'s response (#${target.seq})`;
          range.surroundContents(a);
          linked = true;
          break;
        }
      }
    }
  }

  // ---------------- sidebar ----------------
  // Sign-out is real now: POST /logout clears the session cookie server-side.
  //
  // This used to fetch with a deliberately wrong Basic credential, because that
  // was the only way to displace what the browser had cached for the origin.
  // That trick has to go, not just because it is unnecessary — every use of it
  // counted as a failed sign-in against the per-IP throttle, so ten sign-outs
  // would have locked the user out for five minutes.
  async function logout() {
    try {
      await fetch('/logout', { method: 'POST', cache: 'no-store' });
    } catch { /* navigating to /logout clears the cookie too */ }
    location.href = '/logout';
  }

  async function loadSessions() {
    state.sessions = await api.get('/api/sessions');
    // The dashboard and the All evaluations page read this list, so a refetch
    // after a run or a delete keeps whichever is showing current.
    if (!$('#view-dashboard').hidden) renderDashboard();
    if (!$('#view-evaluations').hidden) renderEvaluations();
  }

  // ---------------- setup view ----------------
  const OTHER_SENTINEL = '__other__';

  // ---- country-status field (REFERENCE APPROVALS) ----
  // Stored as one line per country, "Country: Status, Status", so the value
  // stays a plain string like every other input and reads sensibly in the
  // INPUTS block the agents receive.
  function csRow(f, value) {
    const row = document.createElement('div');
    row.className = 'cs-row';
    row.innerHTML = `<select class="cs-country"><option value="">— Country —</option>${f.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>
      <div class="cs-checks">${f.statuses.map((st) => `<label class="check-item"><input type="checkbox" value="${escapeHtml(st)}"> ${escapeHtml(st)}</label>`).join('')}</div>
      <button type="button" class="cs-remove" title="Remove this country" aria-label="Remove this country">×</button>`;
    if (value) {
      $('.cs-country', row).value = value.country;
      $$('input[type=checkbox]', row).forEach((b) => { b.checked = value.statuses.includes(b.value); });
    }
    return row;
  }
  // An empty field still shows one blank row, so the control never looks broken.
  function csEnsureRow(div, f) {
    const rows = $('.cs-rows', div);
    if (!$('.cs-row', rows)) rows.appendChild(csRow(f));
  }
  function csParse(val, f) {
    return (val || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const i = line.indexOf(':');
      const country = (i === -1 ? line : line.slice(0, i)).trim();
      const statuses = i === -1 ? []
        : line.slice(i + 1).split(',').map((x) => x.trim()).filter((x) => f.statuses.includes(x));
      return { country, statuses };
    }).filter((r) => f.options.includes(r.country));
  }

  function buildForm(root, { saveDefault = false } = {}) {
    const wrap = $('.fields', root);
    wrap.innerHTML = '';
    for (const f of state.config.input_fields) {
      const div = document.createElement('div');
      div.className = 'field' + (f.multiline || f.type === 'country-status' ? ' wide' : '');
      div.dataset.key = f.key;
      const id = `f-${f.key}`;
      let control;
      if (f.type === 'select-other') {
        control = `<select id="${id}" name="${f.key}"><option value="">— Select —</option>${f.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}<option value="${OTHER_SENTINEL}">Other…</option></select>
          <input type="text" class="other-input" placeholder="Specify…" hidden>`;
      } else if (f.type === 'country-status') {
        control = `<div class="cs-rows"></div>
          <button type="button" class="btn btn-sm cs-add">+ Add country</button>`;
      } else if (f.options) {
        control = `<select id="${id}" name="${f.key}"${f.required ? ' required' : ''}><option value="">— Select —</option>${f.options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>`;
      } else if (f.multiline) {
        control = `<textarea id="${id}" name="${f.key}"></textarea>`;
      } else {
        const listAttr = f.suggestions ? ` list="${id}-suggestions"` : '';
        const datalist = f.suggestions ? `<datalist id="${id}-suggestions">${f.suggestions.map((s) => `<option value="${escapeHtml(s)}">`).join('')}</datalist>` : '';
        control = `<input id="${id}" name="${f.key}" type="text"${f.required ? ' required' : ''}${listAttr}>${datalist}`;
      }
      div.innerHTML = `<div class="field-label-row"><label for="${id}">${escapeHtml(f.label)}${f.required ? ' <span class="required-star" title="Required">*</span>' : ''}</label>${saveDefault ? `<button type="button" class="save-default" data-key="${f.key}" title="Save this value as the new default">Save as default</button>` : ''}</div>${control}${f.hint ? `<span class="hint">${escapeHtml(f.hint)}</span>` : ''}`;
      wrap.appendChild(div);
      if (f.type === 'country-status') csEnsureRow(div, f);
    }
    // Delegated once per wrap: buildForm re-runs on the same element, and a
    // second listener would add two rows on every click.
    if (!wrap.dataset.csWired) {
      wrap.dataset.csWired = '1';
      wrap.addEventListener('click', (e) => {
        const div = e.target.closest('.field');
        if (!div) return;
        const f = state.config.input_fields.find((x) => x.key === div.dataset.key);
        if (!f || f.type !== 'country-status') return;
        if (e.target.closest('.cs-add')) {
          const row = csRow(f);
          $('.cs-rows', div).appendChild(row);
          $('.cs-country', row).focus();
        } else if (e.target.closest('.cs-remove')) {
          e.target.closest('.cs-row').remove();
          csEnsureRow(div, f);
        }
      });
    }
    if (saveDefault) {
      wrap.addEventListener('click', async (e) => {
        const btn = e.target.closest('.save-default');
        if (!btn) return;
        const f = state.config.input_fields.find((x) => x.key === btn.dataset.key);
        try {
          await api.send('PATCH', '/api/defaults', { key: f.key, value: readField(root, f) });
          toast(`Saved "${f.label}" as the new default.`);
        } catch (err) { toast(`Could not save default: ${err.message}`); }
      });
    }
    // select-other: reveal the free-text box only when "Other…" is picked.
    $$('.field select', wrap).forEach((sel) => {
      const other = $('.other-input', sel.closest('.field'));
      if (!other) return;
      sel.addEventListener('change', () => {
        const isOther = sel.value === OTHER_SENTINEL;
        other.hidden = !isOther;
        if (isOther) other.focus();
      });
    });
  }

  function fillForm(root, values, { clear } = { clear: false }) {
    for (const f of state.config.input_fields) {
      const div = $(`.field[data-key="${f.key}"]`, root);
      if (!div) continue;
      const val = values[f.key] !== undefined ? values[f.key] : (clear ? '' : undefined);
      if (val === undefined) continue;
      if (f.type === 'select-other') {
        const sel = $('select', div); const other = $('.other-input', div);
        if (f.options.includes(val)) { sel.value = val; other.hidden = true; other.value = ''; }
        else { sel.value = val ? OTHER_SENTINEL : ''; other.hidden = !val; other.value = val; }
      } else if (f.type === 'country-status') {
        const rows = $('.cs-rows', div);
        rows.innerHTML = '';
        for (const r of csParse(val, f)) rows.appendChild(csRow(f, r));
        csEnsureRow(div, f);
      } else {
        const el = $(`[name="${f.key}"]`, div);
        if (el) el.value = val;
      }
    }
  }

  function readField(root, f) {
    const div = $(`.field[data-key="${f.key}"]`, root);
    if (f.type === 'select-other') {
      const sel = $('select', div); const other = $('.other-input', div);
      return (sel.value === OTHER_SENTINEL ? other.value : sel.value).trim();
    }
    if (f.type === 'country-status') {
      return $$('.cs-row', div).map((row) => {
        const country = $('.cs-country', row).value.trim();
        if (!country) return '';
        const statuses = $$('input[type=checkbox]:checked', row).map((b) => b.value);
        // A row naming a country with nothing ticked is a deliberate "not
        // known", not a blank — say so in the agents' own vocabulary.
        return `${country}: ${statuses.length ? statuses.join(', ') : 'INPUT MISSING'}`;
      }).filter(Boolean).join('\n');
    }
    return ($(`[name="${f.key}"]`, div).value || '').trim();
  }
  function readForm(root) {
    const inputs = {};
    for (const f of state.config.input_fields) inputs[f.key] = readField(root, f);
    return inputs;
  }
  // Shows one of the four top-level views. The sidebar's meeting and
  // Intelligence panels belong to an open evaluation, so only the session view
  // shows them.
  const VIEWS = ['dashboard', 'evaluations', 'setup', 'session'];
  function showView(name) {
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== name;
    $('#toolbar').hidden = name !== 'session';
    $('#intel-nav').hidden = name !== 'session';
  }
  function showSetup() {
    state.session = null;
    renderSetupModelSelect();
    showView('setup');
  }

  // ---------------- dashboard ----------------
  // Inline 24x24 stroke icons (Lucide geometry). Markup rather than an icon
  // font or emoji so they inherit currentColor and stay crisp at any size.
  const ICON = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M6 4.5v15l13-7.5z"/>',
    book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 17.5A1.5 1.5 0 0 1 5.5 16H20"/>',
    users: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="3.5"/><path d="M17 4.2a3.5 3.5 0 0 1 0 6.6M22 20v-1.5a4 4 0 0 0-3-3.85"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.7 5.7 3.7 9s-1.2 6.3-3.7 9c-2.5-2.7-3.7-5.7-3.7-9S9.5 5.7 12 3z"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.3l2.4 2.4 4.6-4.9"/>',
    chat: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
    folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l2 2.5h8.8A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" stroke-width="2.4"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    notes: '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.6-2.7 2.6M12 16.8h.01"/>',
    flag: '<path d="M5 21V4M5 4.5s1.2-1 4-1 4.5 2 7.5 2 2.5-.5 2.5-.5v9s-.5.5-2.5.5-4.5-2-7.5-2-4 1-4 1"/>',
    clipboard: '<rect x="8.5" y="2.5" width="7" height="4" rx="1"/><path d="M15.5 4.5h2A1.5 1.5 0 0 1 19 6v14a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V6a1.5 1.5 0 0 1 1.5-1.5h2M9 12h6M9 16h4"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
    repeat: '<path d="m17 2.5 3.5 3.5-3.5 3.5"/><path d="M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5M7 21.5 3.5 18 7 14.5"/><path d="M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5"/>',
    pencil: '<path d="M12 20h8.5"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4z"/>',
    download: '<path d="M20.5 15v3.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V15"/><path d="m7 10 5 5 5-5M12 15V3.5"/>',
    panelLeft: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15.5 10 13.5 12l2 2"/>',
  };
  const icon = (name, cls = '') =>
    `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] || ''}</svg>`;

  // "3 days ago" reads faster than a timestamp when scanning a wall of cards;
  // the exact time stays in the card's title attribute.
  function fmtRelative(utc) {
    if (!utc) return '';
    const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(utc);
    const d = new Date(hasZone ? utc.replace(' ', 'T') : `${utc.replace(' ', 'T')}Z`);
    if (isNaN(d)) return fmtTime(utc);
    const mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
    return fmtTime(utc);
  }
  const isAdminUser = () => !document.body.classList.contains('non-admin');

  function showDashboard() {
    state.session = null;
    showView('dashboard');
    renderDashboard();
  }

  function renderDashboard() {
    renderDashStats();
  }

  // KPI strip. Cost is admin-only for the same reason the session header's cost
  // meter is (body.non-admin): operational detail, not part of reading a
  // launch recommendation.
  function renderDashStats() {
    const list = state.sessions;
    const countries = new Set(list.map((s) => s.country || 'Unspecified'));
    const decided = list.filter((s) => s.has_decision).length;
    const messages = list.reduce((n, s) => n + Number(s.message_count || 0), 0);
    const cost = list.reduce((n, s) => n + Number(s.cost_usd || 0), 0);
    const stats = [
      { icon: 'folder', label: 'Evaluations tabled', value: list.length, sub: `${list.length - decided} awaiting decision` },
      { icon: 'globe', label: 'Countries', value: list.length ? countries.size : 0, sub: 'markets under review' },
      { icon: 'check', label: 'Board decisions', value: decided, sub: list.length ? `${Math.round((decided / list.length) * 100)}% of evaluations` : 'none yet', tone: decided ? 'accent' : '' },
      { icon: 'chat', label: 'Contributions on record', value: messages.toLocaleString(), sub: 'across all evaluations' },
    ];
    if (isAdminUser()) stats.push({ icon: 'sliders', label: 'API spend', value: `$${cost.toFixed(2)}`, sub: 'all sessions, estimated' });
    $('#dash-stats').innerHTML = stats.map((s) => `
      <div class="stat ${s.tone ? `stat-${s.tone}` : ''}">
        <span class="stat-icon">${icon(s.icon)}</span>
        <span class="stat-text">
          <span class="stat-label">${s.label}</span>
          <span class="stat-value">${s.value}</span>
          <span class="stat-sub">${s.sub}</span>
        </span>
      </div>`).join('');
  }

  // ---------------- all evaluations ----------------
  function showEvaluations() {
    state.session = null;
    showView('evaluations');
    renderEvaluations();
    $('#evals-filter').focus();
  }

  // The four standard meetings in order, as dots: which have been held.
  function meetingProgressHtml(run) {
    const held = new Set((run || []).filter((m) => GRID_MODES.includes(m)));
    const steps = GRID_MODES.map((m) => `<span class="evals-step${held.has(m) ? ' on' : ''}" title="${escapeHtml(MODE_LABEL[m])}: ${held.has(m) ? 'held' : 'not yet held'}"></span>`).join('');
    const last = [...GRID_MODES].reverse().find((m) => held.has(m));
    return `<span class="evals-progress" aria-label="${held.size} of ${GRID_MODES.length} meetings held">${steps}</span><span class="evals-progress-label">${last ? escapeHtml(MODE_LABEL[last]) : 'Not started'}</span>`;
  }

  function renderEvaluations() {
    const all = state.sessions;
    const q = state.evalsFilter.trim().toLowerCase();
    const rows = q ? all.filter((s) => [s.title, s.product, s.country].some((v) => String(v || '').toLowerCase().includes(q))) : all;
    const decided = all.filter((s) => s.has_decision).length;
    $('#evals-sub').textContent = all.length ? `${all.length} on record · ${decided} with a board decision · most recent first` : '';
    const box = $('#evals-table');
    if (!all.length) {
      box.innerHTML = '<div class="empty">No evaluations yet. Table a new market evaluation from the dashboard to start one.</div>';
      return;
    }
    if (!rows.length) {
      box.innerHTML = `<div class="empty">No evaluation matches “${escapeHtml(state.evalsFilter.trim())}”.</div>`;
      return;
    }
    const admin = isAdminUser();
    const num = (v) => Number(v || 0);
    box.innerHTML = `<table class="evals-table">
      <thead><tr>
        <th scope="col">Evaluation</th><th scope="col">Market</th><th scope="col">Meetings</th><th scope="col">Decision</th>
        <th scope="col" class="num">Responses</th><th scope="col" class="num">Reports</th><th scope="col">Needs attention</th>
        ${admin ? '<th scope="col" class="num">Spend</th>' : ''}<th scope="col">Last activity</th>
      </tr></thead>
      <tbody>${rows.map((s) => {
        const flags = [
          num(s.open_disagreements) ? `<span class="evals-flag">${num(s.open_disagreements)} open disagreement${num(s.open_disagreements) === 1 ? '' : 's'}</span>` : '',
          num(s.escalated_questions) ? `<span class="evals-flag evals-flag-alert">${num(s.escalated_questions)} escalated</span>` : '',
        ].filter(Boolean).join('');
        return `<tr data-open="${escapeHtml(String(s.id))}" tabindex="0">
          <th scope="row"><button type="button" class="evals-open" data-open="${escapeHtml(String(s.id))}">${escapeHtml(s.title)}</button>
            <span class="evals-meta">Tabled ${escapeHtml(fmtTime(s.created_at))}</span></th>
          <td><span class="evals-country">${escapeHtml(s.country || '—')}</span><span class="evals-meta">${escapeHtml(s.product || '')}</span></td>
          <td class="evals-progress-cell">${meetingProgressHtml(s.meetings_run)}</td>
          <td>${s.has_decision ? '<span class="evals-badge evals-badge-done">Decided</span>' : '<span class="evals-badge">Awaiting</span>'}</td>
          <td class="num">${num(s.message_count).toLocaleString()}</td>
          <td class="num">${num(s.report_count)}</td>
          <td>${flags || '<span class="evals-none">—</span>'}</td>
          ${admin ? `<td class="num">$${num(s.cost_usd).toFixed(2)}</td>` : ''}
          <td title="${escapeHtml(fmtTime(s.updated_at))}">${escapeHtml(fmtRelative(s.updated_at))}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  // Header power buttons, filled into every view's .power-nav. User Guide,
  // Agents and Admin open the left slide-over through the shared [data-nav]
  // delegation. Intelligence is reached from the sidebar (or, on a narrow
  // screen, the session header's picker), not from here.
  function renderPowerNav() {
    const links = [
      { nav: 'guide', title: 'User Guide', label: 'User Guide', icon: 'book' },
      { nav: 'agents', title: 'Agent Profiles', label: 'Agents', icon: 'users' },
    ];
    if (state.me && state.me.is_admin) links.push({ nav: 'admin', title: 'Admin', label: 'Admin', icon: 'sliders' });
    const linkHtml = links.map((l) => `
      <button type="button" class="btn power-btn" data-nav="${l.nav}" data-nav-title="${escapeHtml(l.title)}" title="${escapeHtml(l.title)}" aria-pressed="false">${icon(l.icon)}<span>${escapeHtml(l.label)}</span></button>`).join('');
    $$('.power-nav').forEach((nav) => { nav.innerHTML = linkHtml; });
    syncPowerNav();
  }

  // Pressed state mirrors whichever drawer is open, so the header shows it.
  function syncPowerNav() {
    $$('.power-btn[data-nav]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nav === state.navPanel)));
  }

  // Intelligence is a page of the session view, shown in place of the
  // transcript. Its tabs are the sidebar's #intel-nav items; "transcript" is
  // the meeting itself. state.warRoomOpen is true while the page is showing and
  // state.activeTab remembers the tab. Reports are part of the Decision tab.
  const INTEL_TABS = ['sources', 'knowledgebase', 'intelligence', 'questions', 'escalations', 'disagreements', 'decision', 'minutes', 'favourites', 'inputs'];
  const INTEL_TITLE = {
    sources: 'Sources', knowledgebase: 'Knowledgebase', disagreements: 'Disagreements', intelligence: 'Agent notes', questions: 'Agent Questions', escalations: 'Escalations',
    decision: 'Decision & reports', minutes: 'Minutes', favourites: 'Favourites', inputs: 'Inputs',
  };
  function showSessionPane(pane) {
    const intel = INTEL_TABS.includes(pane);
    const transcript = $('#transcript');
    // Hiding the transcript can drop its scroll position; keep it for the way back.
    if (intel && !state.warRoomOpen) state.transcriptScroll = transcript.scrollTop;
    if (intel) state.activeTab = pane;
    // Shared with other evaluations and other admins, so fetch it fresh each visit.
    if (pane === 'knowledgebase') loadKnowledge();
    const wasOpen = state.warRoomOpen;
    state.warRoomOpen = intel;
    $('.transcript-col').hidden = intel;
    $('#intel-page').hidden = !intel;
    INTEL_TABS.forEach((k) => { $(`#tab-${k}`).hidden = k !== state.activeTab; });
    $('#intel-page-title').textContent = INTEL_TITLE[state.activeTab];
    const current = intel ? state.activeTab : 'transcript';
    $$('#intel-nav [data-pane]').forEach((b) => {
      if (b.dataset.pane === current) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // The narrow-screen stand-in for #intel-nav.
    const picker = $('#intel-page-select');
    if (picker) picker.value = current;
    if (intel) $('#intel-page').scrollTop = 0;
    else if (wasOpen && state.transcriptScroll != null) transcript.scrollTop = state.transcriptScroll;
  }

  // ---------------- session view ----------------
  async function openSession(id) {
    state.session = await api.get(`/api/sessions/${id}`);
    state.sessionActiveMs = 0; // per-tab stopwatch; not persisted, resets when (re)opening a session
    showView('session');
    // A session always opens on its transcript, not on the page the last one was left on.
    state.transcriptScroll = null;
    showSessionPane('transcript');
    renderSession();
    loadKnowledge();
    await loadSessions();
  }

  function renderSession() {
    const s = state.session;
    $('#session-title').textContent = s.title;
    $('#session-sub').textContent = `${s.inputs.product || 'Product: INPUT MISSING'} · ${s.inputs.country || 'Country: INPUT MISSING'} · created ${fmtTime(s.created_at)}`;
    renderSessionModelSelect();
    updateActiveClock(0);
    // inputs summary — editable in place; changes only affect turns run after saving.
    const missing = state.config.input_fields.filter((f) => !(s.inputs[f.key] || '').trim());
    $('#inputs-summary-label').textContent = `Inputs · ${state.config.input_fields.length - missing.length} filled, ${missing.length} INPUT MISSING`;
    fillForm($('#session-inputs-form'), s.inputs, { clear: true });
    // transcript
    renderTranscript();
    renderSources(); renderDisagreements(); renderQuestions(); renderDecisionTab(); renderFavourites(); renderReports(); renderCost(); renderMinutes(); renderIntelligence();
    renderMeetingNav();
    setRunning(state.running);
    const t = $('#transcript');
    t.scrollTop = t.scrollHeight;
  }

  // extraMs: the running turn's not-yet-committed elapsed time, added on top of
  // state.sessionActiveMs (which only accumulates once a turn finishes).
  function updateActiveClock(extraMs) {
    const el = $('#active-clock');
    if (el) el.textContent = `⏱ ${fmtElapsed(state.sessionActiveMs + extraMs)}`;
  }

  // The model is first chosen on the New Evaluation form and can be switched
  // from the session header later; the server writes each switch into the
  // transcript, so the record shows which turns ran on which model.
  function renderSetupModelSelect() {
    fillModelSelect($('#setup-model'), state.config.model);
  }
  function renderSessionModelSelect() {
    fillModelSelect($('#session-model'), state.session.model || state.config.model);
  }
  function fillModelSelect(sel, current) {
    const isAdmin = Boolean(state.me && state.me.is_admin);
    // Paid models cost real spend with no per-user budget anywhere — offering
    // them to a non-admin would just earn a 403 from the server, so don't show
    // them as choices in the first place. The current model always stays
    // selectable even if it is paid, so the picker never misrepresents state.
    const opts = state.config.model_options.filter((o) => o.free !== false || o.id === current || isAdmin);
    const known = opts.some((o) => o.id === current) ? opts : [{ id: current, label: current === state.config.model ? `${current} (configured default)` : current }, ...opts];
    sel.innerHTML = known.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === current ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
    sel.value = current;
  }

  const modelLabel = (id) => (state.config.model_options.find((o) => o.id === id) || { label: id }).label;
  // The picker's labels carry the price and the trade-off, which is what makes
  // them useful at the point of choosing and far too long for a header line.
  const modelLabelShort = (id) => modelLabel(id).replace(/\s*\(.*$/, '');

  // Speaker filter (chips above the transcript) + round/mode dividers, so a long
  // session stays navigable: jump to one agent's thread, or see where a round starts.
  // One column per agent, always in the same order and always all three, so a
  // column position means the same agent everywhere on the page. An agent that
  // didn't speak in a block leaves its column empty rather than shifting the
  // other two along — that shifting is what made the old layout hard to read
  // down. The agent's name is not repeated on each card: it's in the column
  // head above the transcript, which stays put while the transcript scrolls.
  function agentGridBlock(msgs) {
    const frag = document.createDocumentFragment();
    const grid = document.createElement('div'); grid.className = 'agent-grid';
    if (msgs.length) grid.dataset.mode = msgs[0].mode;
    for (const key of ALL) {
      const col = document.createElement('div');
      col.className = `agent-col agent-col-${key}`;
      col.dataset.speaker = key;
      for (const m of msgs) if (m.speaker === key) col.appendChild(messageElement(m));
      grid.appendChild(col);
    }
    frag.appendChild(grid);
    // Anything in the block that isn't one of the three columned agents (a
    // moderator note that landed inside a round) still has to be shown.
    for (const m of msgs) if (!ALL.includes(m.speaker)) frag.appendChild(messageElement(m));
    return frag;
  }

  // The heads live inside the transcript as a sticky row, not above it: that
  // way they share the scroll container's box and padding, so they stay aligned
  // with the columns whether or not a scrollbar is taking width.
  // Headshots cropped from the dashboard hero photo (web/avatars/<key>.jpg).
  // Only the three founding agents have one; any agent added to the roster
  // later keeps the plain coloured dot.
  const AGENT_AVATARS = new Set(['regulatory', 'clinical', 'commercial']);
  function columnHeadsRow() {
    const row = document.createElement('div');
    row.className = 'agent-columns-heads';
    row.id = 'agent-columns-heads';
    row.innerHTML = ALL
      .map((key) => {
        const avatar = AGENT_AVATARS.has(key) ? `<img class="agent-avatar" src="/avatars/${key}.jpg" alt="" width="47" height="47">` : '';
        return `<div class="agent-head agent-head-${key}${avatar ? ' has-avatar' : ''}" data-speaker="${key}"${speakerStyle(key)}>${avatar}${escapeHtml(AGENT_LABEL[key])}</div>`;
      })
      .join('');
    return row;
  }

  function renderTranscript() {
    const s = state.session;
    const t = $('#transcript');
    t.innerHTML = '';
    if (!s.messages.length) { t.innerHTML = '<div class="empty">No messages yet. Run Baselines to start.</div>'; return; }
    t.appendChild(columnHeadsRow());
    renderByMeeting(t, s.messages);
    applyFilter();
  }

  // By meeting: rows are meetings. Each round (and each autopilot cycle) is one
  // aligned row across the three columns, under a divider naming the meeting.
  function renderByMeeting(t, msgs) {
    let lastMode = null;
    let i = 0;
    while (i < msgs.length) {
      const m = msgs[i];
      if (m.mode && m.mode !== lastMode && m.role !== 'user') {
        const div = document.createElement('div'); div.className = 'round-divider'; div.dataset.mode = m.mode;
        div.innerHTML = `<span>${escapeHtml(MODE_LABEL[m.mode] || m.mode)}</span>`;
        t.appendChild(div);
        lastMode = m.mode;
      }
      if (m.mode === 'autopilot' && m.role !== 'user') {
        // Cycle boundary, not mode boundary: group consecutive autopilot
        // messages that share the same cycle number into one grid with its
        // own header, so a whole run doesn't render as a single giant grid.
        const meta = autopilotMeta(m) || {};
        const header = document.createElement('div'); header.className = 'cycle-header';
        header.innerHTML = `<span>Cycle ${meta.cycle ?? '?'}${meta.run_id ? ` · run ${meta.run_id}` : ''}</span>`;
        t.appendChild(header);
        const cycle = meta.cycle;
        const group = [];
        while (i < msgs.length && msgs[i].mode === 'autopilot' && msgs[i].role !== 'user' && (autopilotMeta(msgs[i]) || {}).cycle === cycle) { group.push(msgs[i]); i++; }
        t.appendChild(agentGridBlock(group));
      } else if (GRID_MODES.includes(m.mode) && m.role !== 'user') {
        const mode = m.mode;
        const group = [];
        while (i < msgs.length && msgs[i].mode === mode && msgs[i].role !== 'user') { group.push(msgs[i]); i++; }
        t.appendChild(agentGridBlock(group));
      } else {
        t.appendChild(messageElement(m));
        i++;
      }
    }
  }

  function applyFilter() {
    const active = state.filterSpeaker || 'all';
    $$('#filter-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.speaker === active));
    // Filtering to a single agent collapses the three columns to that one,
    // full width, instead of leaving two empty thirds on screen.
    const single = ALL.includes(active) ? active : null;
    $('#transcript').classList.toggle('single-agent', Boolean(single));
    $$('#transcript .agent-columns-heads').forEach((r) => r.classList.toggle('single-agent', Boolean(single)));
    $$('#transcript .agent-col').forEach((c) => { c.hidden = Boolean(single) && c.dataset.speaker !== single; });
    $$('#agent-columns-heads .agent-head').forEach((h) => { h.hidden = Boolean(single) && h.dataset.speaker !== single; });
    $$('#transcript .msg').forEach((el) => {
      el.hidden = active !== 'all' && el.dataset.speaker !== active;
    });
    $$('#transcript .round-divider').forEach((el) => {
      // Hide a divider only if every message in its group is filtered out.
      // Agent rounds are wrapped in a .agent-grid, not flat .msg siblings.
      let sib = el.nextElementSibling; let anyVisible = false;
      while (sib && !sib.classList.contains('round-divider')) {
        if (sib.classList.contains('msg') && !sib.hidden) anyVisible = true;
        if (sib.classList.contains('agent-grid') && sib.querySelector('.msg:not([hidden])')) anyVisible = true;
        sib = sib.nextElementSibling;
      }
      el.hidden = !anyVisible;
    });
  }

  function messageElement(m) {
    const speaker = m.role === 'user' ? 'user' : m.speaker;
    const isSystem = m.role === 'system';
    const el = document.createElement('article');
    el.className = `msg msg-${speaker}${isSystem ? ' msg-system' : ''}${m.favourite ? ' favourited' : ''}`;
    if (AGENT_COLOUR[speaker]) { el.style.setProperty('--speaker', AGENT_COLOUR[speaker]); el.style.setProperty('--speaker-soft', AGENT_COLOUR[speaker + '_soft'] || 'transparent'); }
    el.id = `msg-${m.id}`;
    el.dataset.speaker = speaker;
    const to = m.role === 'user' && m.addressed_to && m.addressed_to !== 'all' ? ` → ${AGENT_LABEL[m.addressed_to]}` : '';
    const responseTime = m.duration_ms != null ? `⏱ ${fmtElapsed(m.duration_ms)}` : fmtTime(m.created_at);
    el.innerHTML = `<div class="msg-head"><span class="msg-who">${escapeHtml(AGENT_LABEL[speaker] || speaker)}${escapeHtml(to)}</span>${m.mode && m.role !== 'user' ? `<span class="msg-mode">${escapeHtml(MODE_LABEL[m.mode] || m.mode)}</span>` : ''}<span class="msg-meta" title="${escapeHtml(fmtTime(m.created_at))}">#${m.seq} · ${responseTime}</span><span class="spacer"></span><span class="msg-meta msg-cost">${m.cost_usd ? money(m.cost_usd) : ''}</span>${isSystem ? '' : `<button type="button" class="fav-btn${m.favourite ? ' on' : ''}" title="${m.favourite ? 'Remove from favourites' : 'Favourite this response'}" aria-pressed="${m.favourite ? 'true' : 'false'}">${m.favourite ? '★' : '☆'}</button>`}</div>`;
    if (m.mode === 'autopilot' && !m.error) {
      const meta = autopilotMeta(m) || {};
      if (meta.question_id != null) {
        // A question discussion: only the asker writes a verdict line.
        const qs = parseQuestionStatus(m.text);
        if (qs) {
          const badge = document.createElement('span');
          badge.className = `badge-position ${qs === 'RESOLVED' ? 'agree' : 'disagree'}`;
          badge.textContent = qs === 'RESOLVED' ? 'QUESTION RESOLVED' : 'QUESTION OPEN';
          $('.msg-head', el).appendChild(badge);
        }
      } else {
        const pos = parsePosition(m.text);
        const badge = document.createElement('span');
        badge.className = `badge-position ${pos === 'AGREE' ? 'agree' : pos === 'DISAGREE' ? 'disagree' : 'missing'}`;
        badge.textContent = pos || 'no position line';
        $('.msg-head', el).appendChild(badge);
      }
    }
    if (!isSystem) {
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
          renderFavourites();
        } catch (e) { toast(`Could not update favourite: ${e.message}`); } finally { favBtn.disabled = false; }
      });
    }
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
    } else if (m.text === null || m.text === undefined) {
      // A row with no text and no error is a turn that was mid-flight when this
      // page loaded — on Vercel the server-side turn dies with the connection
      // that started it, so this row will otherwise sit here forever looking
      // like a blank response with no indication anything is wrong.
      const pending = document.createElement('div'); pending.className = 'msg-error';
      pending.innerHTML = '<span>This turn was still running when the page loaded, or the connection to it was interrupted. It will not resume on its own.</span>';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-sm'; retry.textContent = 'Retry';
      retry.addEventListener('click', async () => {
        if (state.running) return;
        await api.send('DELETE', `/api/sessions/${state.session.id}/messages/${m.id}`);
        state.session.messages = state.session.messages.filter((x) => x.id !== m.id);
        el.remove();
        await runSequence([{ speaker: m.speaker, mode: m.mode }]);
      });
      pending.appendChild(retry);
      el.appendChild(pending);
    } else {
      body.appendChild(renderMarkdown(m.text));
      linkAgentMentions(body, m);
      el.appendChild(body);
      if (!isSystem) {
      const openFullBtn = document.createElement('button');
      openFullBtn.type = 'button'; openFullBtn.className = 'msg-openfull'; openFullBtn.title = 'Open full response in a wide view'; openFullBtn.textContent = '⤢';
      openFullBtn.addEventListener('click', () => openMessageModal(m, speaker));
      $('.msg-head', el).insertBefore(openFullBtn, $('.msg-head', el).firstChild);
      }
      if ((m.text || '').length > 2500 && m.mode !== 'decision') {
        body.classList.add('collapsed');
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn btn-sm msg-expand'; btn.textContent = 'Show full message';
        btn.addEventListener('click', () => { const c = body.classList.toggle('collapsed'); btn.textContent = c ? 'Show full message' : 'Collapse'; });
        el.appendChild(btn);
      }
      // Custom rounds aren't offered: the free-form instruction that produced this
      // response isn't stored on the message, so it can't be reproduced faithfully.
      if (m.role !== 'user' && !isSystem && m.mode !== 'custom' && m.mode !== 'autopilot') {
        const regen = document.createElement('button'); regen.type = 'button'; regen.className = 'btn btn-sm msg-regen'; regen.textContent = '↻ Regenerate';
        regen.title = 'Delete this response and have the agent answer again';
        regen.addEventListener('click', async () => {
          if (state.running) return;
          if (!confirm('Delete this response and regenerate it? This cannot be undone.')) return;
          await api.send('DELETE', `/api/sessions/${state.session.id}/messages/${m.id}`);
          state.session.messages = state.session.messages.filter((x) => x.id !== m.id);
          el.remove();
          // dive_deeper's instruction isn't stored on the message row, but it's
          // always this same deterministic template (see the Dive Deeper button
          // below) — reconstruct it so regenerate doesn't silently drop it.
          const instruction = m.mode === 'dive_deeper' ? `Expand your response #${m.seq} above.` : undefined;
          await runSequence([{ speaker: m.speaker, mode: m.mode, instruction }]);
        });
        el.appendChild(regen);
      }
      // Responses are compact by default (see COMPACT_SUFFIX server-side); this asks
      // the same agent to expand THIS specific response as a new follow-up message.
      if (m.role !== 'user' && !isSystem && m.mode !== 'decision') {
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

  function sourceRowHtml(src) {
    const by = [...new Set(src.cited_by.map((c) => AGENT_LABEL[c.speaker] || c.speaker))].join(', ');
    const backlink = src.first_message_id ? ` · <a href="#msg-${src.first_message_id}" class="src-back" data-msg="${src.first_message_id}">↑ view in message</a>` : '';
    return `<div class="src" id="src-${src.n}"><span class="n">[${src.n}]</span>${escapeHtml(src.title || src.url)}<span class="kind ${src.kind}">${src.kind === 'cited' ? 'cited' : 'searched'}</span><br><a href="${escapeHtml(src.url)}" target="_blank" rel="noopener">${escapeHtml(src.url)}</a><div class="meta">First ${fmtTime(src.first_cited_at)} · ${escapeHtml(by)}${backlink}</div></div>`;
  }

  function renderSources() {
    const s = state.session;
    $('#count-sources').textContent = s.sources.filter((src) => src.kind === 'cited').length;
    const box = $('#tab-sources');
    if (!s.sources.length) { box.innerHTML = '<div class="empty">No sources yet. Every URL the agents search or cite appears here, numbered.</div>'; return; }
    // Default to cited sources only — a research turn can search a dozen pages
    // and cite two; listing every search result as if it were evidence used
    // buries the sources actually backing the claims. The rest stay one click away.
    const cited = s.sources.filter((src) => src.kind === 'cited');
    const searchedOnly = s.sources.filter((src) => src.kind !== 'cited');
    const citedHtml = cited.length ? cited.map(sourceRowHtml).join('') : '<div class="empty">No sources have been cited in a claim yet.</div>';
    const toggleHtml = searchedOnly.length
      ? `<button type="button" class="btn btn-sm" id="btn-toggle-searched">${state.showAllSources ? 'Hide' : 'Show'} ${searchedOnly.length} more searched but not cited</button>`
      : '';
    const searchedHtml = state.showAllSources ? searchedOnly.map(sourceRowHtml).join('') : '';
    box.innerHTML = citedHtml + toggleHtml + searchedHtml;
    const toggleBtn = $('#btn-toggle-searched', box);
    if (toggleBtn) toggleBtn.addEventListener('click', () => { state.showAllSources = !state.showAllSources; renderSources(); });
  }

  // ---------------- knowledgebase ----------------
  // Curated internal documents every agent is told about at the start of each
  // turn. Shared by all evaluations, so it is fetched on its own rather than
  // with the session. Anyone can read it; the server lets only admins change
  // it, so the add/edit form is only drawn for them. The form sits at the top:
  // adding a source is the reason to open this tab.
  async function loadKnowledge() {
    try {
      state.knowledge = await api.get('/api/knowledge');
    } catch (e) {
      state.knowledge = null;
      state.knowledgeError = e.message;
    }
    renderKnowledge();
  }

  function renderKnowledge() {
    const box = $('#tab-knowledgebase');
    const items = state.knowledge;
    $('#count-knowledge').textContent = items ? items.length : '0';
    if (!items) {
      box.innerHTML = `<div class="empty">${state.knowledgeError ? `Could not load the knowledgebase: ${escapeHtml(state.knowledgeError)}` : 'Loading the knowledgebase…'}</div>`;
      return;
    }
    // No sign-in configured (authenticated false) counts as admin, as it does
    // on the server; a /api/me that failed to load does not.
    const me = state.me || { failed: true };
    const admin = Boolean(me.is_admin) || (!me.authenticated && !me.failed);
    const editing = admin && state.kbEditId != null ? items.find((i) => String(i.id) === String(state.kbEditId)) : null;
    const categories = [...new Set(items.map((i) => i.category).filter(Boolean))];
    const v = (k) => escapeHtml((editing && editing[k]) || '');
    const form = admin ? `
      <form class="kb-add" id="kb-form" autocomplete="off">
        <div class="kb-add-head">
          <h3>${editing ? 'Edit source' : 'Add a source'}</h3>
          <p class="muted">${editing ? `Editing “${escapeHtml(editing.title)}”.` : 'A Drive or web link the agents are told about at the start of every turn, in every evaluation.'}</p>
        </div>
        <div class="kb-add-grid">
          <label class="kb-wide">URL<input type="url" name="url" required placeholder="https://drive.google.com/…" value="${v('url')}"></label>
          <label>Title<input type="text" name="title" required value="${v('title')}"></label>
          <label>Category<input type="text" name="category" required list="kb-categories" value="${v('category')}"></label>
          <datalist id="kb-categories">${categories.map((c) => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
          <label class="kb-wide">Note<input type="text" name="note" placeholder="What it covers, and when an agent should use it" value="${v('note')}"></label>
        </div>
        <div class="kb-add-actions">
          <label class="check-inline"><input type="checkbox" name="sensitive"${editing && editing.sensitive ? ' checked' : ''}> Commercially sensitive (pricing, royalties, deal terms)</label>
          <span class="spacer"></span>
          ${editing ? '<button type="button" class="btn" id="kb-cancel">Cancel</button>' : ''}
          <button type="submit" class="btn btn-primary">${editing ? 'Save changes' : 'Add source'}</button>
        </div>
      </form>` : '<p class="muted kb-readonly">Only admins can add or change knowledgebase sources.</p>';
    const rows = items.map((i) => `
      <tr data-id="${escapeHtml(String(i.id))}"${editing && String(editing.id) === String(i.id) ? ' class="kb-editing"' : ''}>
        <td>${escapeHtml(i.category || '')}</td>
        <td class="kb-title"><a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>${i.sensitive ? ' <span class="kb-sensitive">Sensitive</span>' : ''}</td>
        <td class="kb-note">${escapeHtml(i.note || '')}</td>
        ${admin ? `<td class="kb-actions"><button type="button" class="btn btn-sm" data-kb="edit">Edit</button><button type="button" class="btn btn-sm btn-danger-ghost" data-kb="delete">Delete</button></td>` : ''}
      </tr>`).join('');
    box.innerHTML = `${form}
      ${items.length ? `<div class="kb-table-wrap"><table class="kb-table">
        <thead><tr><th scope="col">Category</th><th scope="col">Source</th><th scope="col">Note</th>${admin ? '<th scope="col"><span class="visually-hidden">Actions</span></th>' : ''}</tr></thead>
        <tbody>${rows}</tbody></table></div>` : '<div class="empty">No sources in the knowledgebase yet.</div>'}`;
    if (!admin) return;
    $('#kb-form', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = $('button[type=submit]', f);
      // namedItem, not f.title: a form's own properties can shadow its fields.
      const field = (n) => f.elements.namedItem(n);
      const body = {
        category: field('category').value.trim(), title: field('title').value.trim(), url: field('url').value.trim(),
        note: field('note').value.trim(), sensitive: field('sensitive').checked,
      };
      btn.disabled = true;
      try {
        if (editing) await api.send('PATCH', `/api/knowledge/${editing.id}`, body);
        else await api.send('POST', '/api/knowledge', body);
        toast(editing ? 'Source updated.' : 'Source added.');
        state.kbEditId = null;
        await loadKnowledge();
      } catch (err) { btn.disabled = false; toast(`Could not save the source: ${err.message}`); }
    });
    $('#kb-cancel', box)?.addEventListener('click', () => { state.kbEditId = null; renderKnowledge(); });
    $$('[data-kb]', box).forEach((b) => b.addEventListener('click', async () => {
      const id = b.closest('tr').dataset.id;
      const item = items.find((i) => String(i.id) === id);
      if (b.dataset.kb === 'edit') {
        state.kbEditId = id;
        renderKnowledge();
        $('#kb-form input[name=url]').focus();
        $('#intel-page').scrollTop = 0;
        return;
      }
      if (!confirm(`Delete "${item.title}" from the knowledgebase?`)) return;
      try {
        await api.send('DELETE', `/api/knowledge/${id}`);
        if (String(state.kbEditId) === id) state.kbEditId = null;
        toast('Source deleted.');
        await loadKnowledge();
      } catch (err) { toast(`Could not delete: ${err.message}`); }
    }));
  }

  // Splits the stored ⚠ DISAGREEMENT block into its fixed rows (Position A/B,
  // evidence, status — see the format required in prompts/evidence-rules.md) so
  // the tab shows the actual back-and-forth instead of one opaque text blob.
  function parseDisagreementBody(body) {
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const rows = [];
    let current = null;
    for (const line of lines) {
      const m = line.match(/^(Position A|Position B|What evidence would settle it|Status)\s*(?:\(([^)]*)\))?\s*[:\-—]\s*(.*)$/i);
      if (m) { current = { label: m[1], agent: /^Position/i.test(m[1]) ? (m[2] || '').trim() : '', text: m[3] }; rows.push(current); }
      else if (current) { current.text += ' ' + line; }
      else if (!/^⚠/.test(line)) { rows.push({ label: '', text: line }); }
    }
    return rows;
  }

  function renderDisagreements() {
    const s = state.session;
    const open = s.disagreements.filter((d) => d.status !== 'resolved').length;
    $('#count-dis').textContent = s.disagreements.length ? `${open}/${s.disagreements.length}` : '0';
    const box = $('#tab-disagreements');
    if (!s.disagreements.length) { box.innerHTML = '<div class="empty">No disagreements logged. Agents mark genuine disputes with ⚠ DISAGREEMENT; they appear here with a status you can toggle.</div>'; return; }
    box.innerHTML = '';
    for (const d of s.disagreements) {
      const el = document.createElement('div'); el.className = 'dis'; el.id = `dis-${d.n}`;
      el.innerHTML = `<div class="topic">#${d.n} ${escapeHtml(d.topic)}<button type="button" class="status ${d.status}" title="Click to toggle">${d.status.toUpperCase()}</button></div>${disRaisedHtml(d)}<div class="body">${disRowsHtml(d)}</div>`;
      $('.status', el).addEventListener('click', async (e) => {
        e.stopPropagation();
        const next = d.status === 'resolved' ? 'unresolved' : 'resolved';
        state.session.disagreements = await api.send('PATCH', `/api/sessions/${s.id}/disagreements/${d.n}`, { status: next });
        renderDisagreements();
      });
      el.addEventListener('click', () => openDisagreementModal(d));
      box.appendChild(el);
    }
  }

  function disRowsHtml(d) {
    const rows = parseDisagreementBody(d.body);
    return (rows.length ? rows : [{ label: '', text: d.body }])
      .map((r) => {
        const agent = r.agent ? agentKeyFromText(r.agent) : null;
        const who = agent ? agentChipHtml(agent) : (r.agent ? `<span class="agent-chip">${escapeHtml(r.agent)}</span>` : '');
        return `<div class="dis-row${/status/i.test(r.label) ? ' dis-status-row' : ''}">${r.label ? `<span class="dis-label">${escapeHtml(r.label)}${who}</span>` : ''}<span class="dis-text">${escapeHtml(r.text)}</span></div>`;
      })
      .join('');
  }

  // The agent a free-text mention names ("Luca", "Clinical", "Luca (Clinical)"),
  // or null. Positions are written by the model, so match loosely, as whole
  // words, on the roster's name, function and key.
  const escapeRegExp = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function agentKeyFromText(text) {
    const t = String(text || '').toLowerCase();
    for (const key of ALL) {
      const a = ((state.config && state.config.agents) || {})[key] || {};
      const names = [a.name, a.short, a.function, key].filter(Boolean).map((x) => escapeRegExp(String(x).toLowerCase()));
      if (names.some((n) => new RegExp('\\b' + n + '\\b').test(t))) return key;
    }
    return null;
  }
  function agentChipHtml(key) {
    const colour = AGENT_COLOUR[key];
    return `<span class="agent-chip"${colour ? ` style="--speaker:${escapeHtml(colour)}"` : ''}>${escapeHtml(AGENT_LABEL[key] || key)}</span>`;
  }
  // Who raised a disagreement: the speaker of the message it was logged from.
  function disRaisedBy(d) {
    const m = d.message_id && state.session.messages.find((x) => x.id === d.message_id);
    return m && ALL.includes(m.speaker) ? m.speaker : null;
  }
  const disRaisedHtml = (d) => { const k = disRaisedBy(d); return k ? `<div class="dis-raised">Raised by ${agentChipHtml(k)}</div>` : ''; };

  // Clicking a disagreement card opens the full detail, with the option to ask
  // any subset of agents to weigh in on it directly (posts as a custom round).
  function openDisagreementModal(d) {
    const s = state.session;
    $('#dis-modal-title').textContent = `#${d.n} ${d.topic}`;
    const statusBtn = $('#dis-modal-status');
    statusBtn.className = `status ${d.status}`;
    statusBtn.textContent = d.status.toUpperCase();
    statusBtn.onclick = async () => {
      const next = d.status === 'resolved' ? 'unresolved' : 'resolved';
      state.session.disagreements = await api.send('PATCH', `/api/sessions/${s.id}/disagreements/${d.n}`, { status: next });
      renderDisagreements();
      $('#dlg-disagreement').close();
    };
    $('#dis-modal-body').innerHTML = `${disRaisedHtml(d)}${disRowsHtml(d)}`;
    const back = $('#dis-modal-back');
    if (d.message_id) { back.href = `#msg-${d.message_id}`; back.hidden = false; back.onclick = () => $('#dlg-disagreement').close(); }
    else back.hidden = true;
    $('#dis-modal-downloads').innerHTML = itemDownloadsHtml('disagreement', d.n);
    $$('#dlg-disagreement .agent-picks input').forEach((c) => { c.checked = false; });
    $('#dis-modal-instruction').value = '';
    const dlg = $('#dlg-disagreement');
    dlg.dataset.n = d.n;
    dlg.showModal();
  }

  // Opens one response full-width — the inline card can be quite narrow when
  // laid out 3-up, and "Show full message" only lifts the collapse height cap.
  function openMessageModal(m, speaker) {
    openItemModal('message', m.id, {
      title: `${AGENT_LABEL[speaker] || speaker}${m.mode ? ' · ' + (MODE_LABEL[m.mode] || m.mode) : ''} · #${m.seq}`,
      markdown: m.text || '',
    });
  }

  // ---------------- item view and downloads ----------------
  // Every item on the page (a report, the decision, a minutes entry, a
  // meeting's transcript, a response, a disagreement, a question) opens in the
  // wide modal and downloads as Word, PDF or Excel from one server route
  // (GET /api/sessions/:id/items/:kind/:key, see src/intel-export.js itemDoc).
  const ITEM_DOWNLOADS = [['docx', 'Word'], ['pdf', 'PDF'], ['xlsx', 'Excel']];
  const itemUrl = (kind, key, format) => `/api/sessions/${state.session.id}/items/${kind}/${encodeURIComponent(key)}${format ? `/export.${format}` : ''}`;
  function itemDownloadsHtml(kind, key) {
    return `<span class="item-downloads">${ITEM_DOWNLOADS.map(([f, label]) => `<a href="${escapeHtml(itemUrl(kind, key, f))}" download title="Download as ${label}">${label}</a>`).join('')}</span>`;
  }
  // markdown given: it is already on the page, so it renders at once. Without
  // it the server builds the item, which is how a meeting's transcript opens.
  async function openItemModal(kind, key, { title, markdown } = {}) {
    const dlg = $('#dlg-message');
    const seq = (state.itemSeq = (state.itemSeq || 0) + 1);
    $('#msg-modal-title').textContent = title || 'Loading…';
    $('#msg-modal-downloads').innerHTML = itemDownloadsHtml(kind, key);
    if (markdown != null) $('#msg-modal-body').replaceChildren(renderMarkdown(markdown));
    else $('#msg-modal-body').innerHTML = '<p class="muted">Loading…</p>';
    if (!dlg.open) dlg.showModal();
    if (markdown != null) return;
    try {
      const doc = await api.get(itemUrl(kind, key));
      if (seq !== state.itemSeq || !dlg.open) return;
      $('#msg-modal-title').textContent = doc.title;
      $('#msg-modal-body').replaceChildren(renderMarkdown(doc.markdown));
    } catch (e) {
      if (seq === state.itemSeq) $('#msg-modal-body').innerHTML = `<p class="usage-failed" role="alert">Could not load this item: ${escapeHtml(e.message)}</p>`;
    }
  }

  // ---------------- LLM usage ----------------
  // Header cost chip. The transcript's own message costs miss every model call
  // that writes no message (answered-check, meeting minutes, interim reports,
  // failed turns), so the chip shows the server's usage total (src/usage.js)
  // and only falls back to the message sum until that first arrives.
  let usageSeq = 0;
  function renderCost() {
    const s = state.session;
    if (!s) return;
    const cached = state.usage && String(state.usage.session_id) === String(s.id) ? state.usage : null;
    $('#cost-meter').textContent = money(cached ? cached.total.cost_usd : s.messages.reduce((a, m) => a + (m.cost_usd || 0), 0));
    // The usage endpoint is admin-only, like the chip.
    if (isAdminUser()) refreshUsage().catch(() => {});
  }
  // Latest request wins: a slow reply for an earlier session or an earlier
  // turn must not overwrite a newer one.
  async function refreshUsage() {
    const s = state.session;
    if (!s) return null;
    const seq = ++usageSeq;
    const data = await api.get(`/api/sessions/${s.id}/usage`);
    if (seq !== usageSeq || !state.session || String(state.session.id) !== String(s.id)) return null;
    state.usage = { ...data, session_id: s.id };
    $('#cost-meter').textContent = money(data.total.cost_usd);
    // Whichever refresh lands last redraws an open modal, so a turn finishing
    // while it is open cannot strand it on older figures or "Loading usage…".
    if ($('#dlg-usage').open) renderUsageModal(state.usage);
    return state.usage;
  }

  const fmtInt = (n) => (Number(n) || 0).toLocaleString();
  const usageAgentLabel = (key) => (key === 'unknown' ? 'Unknown' : AGENT_LABEL[key] || key);
  function usageBar(cost, total) {
    const pct = total > 0 ? (cost / total) * 100 : 0;
    return `<div class="usage-share"><span class="usage-bar" aria-hidden="true"><span style="width:${Math.min(100, pct).toFixed(1)}%"></span></span><span class="usage-pct">${pct >= 0.1 || pct === 0 ? pct.toFixed(1) : '&lt;0.1'}%</span></div>`;
  }
  const usageCallsCell = (g) => `${fmtInt(g.calls)}${g.failed_calls ? ` <span class="usage-failed">${fmtInt(g.failed_calls)} failed</span>` : ''}`;
  // One breakdown table: name, calls, tokens, cost, share of the session total.
  // childRows, when given, lists indented sub-rows under each row.
  function usageGroupTable(caption, nameHeader, rows, total, nameOf, childRows) {
    const row = (g, cls, name) => `<tr class="${cls}">
        <th scope="row">${name}</th>
        <td class="num">${usageCallsCell(g)}</td>
        <td class="num">${fmtInt(g.input_tokens)} / ${fmtInt(g.output_tokens)}</td>
        <td class="num">${money(Number(g.cost_usd) || 0)}</td>
        <td>${usageBar(Number(g.cost_usd) || 0, total)}</td></tr>`;
    const body = rows.map((g) => row(g, g.calls ? 'usage-row' : 'usage-row usage-zero', nameOf(g))
      + (childRows ? childRows(g).map((f) => row(f, 'usage-sub', escapeHtml(f.label))).join('') : '')).join('');
    return `<section class="usage-section"><h3>${escapeHtml(caption)}</h3><div class="usage-scroll"><table class="usage-table">
      <thead><tr><th scope="col">${escapeHtml(nameHeader)}</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Tokens in / out</th><th scope="col" class="num">Cost</th><th scope="col">Share</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="muted">No model calls yet.</td></tr>'}</tbody></table></div></section>`;
  }

  function renderUsageModal(u) {
    const t = u.total;
    const total = t.cost_usd;
    // Every named use is listed, even at zero, so "nothing spent on it" reads
    // as a fact rather than a missing row. "Other" only appears when used.
    const byKey = new Map(u.by_category.map((g) => [g.key, g]));
    const categories = u.categories
      .map((c) => byKey.get(c.key) || { key: c.key, label: c.label, cost_usd: 0, calls: 0, failed_calls: 0, input_tokens: 0, output_tokens: 0, features: [] })
      .filter((g) => g.key !== 'other' || g.calls)
      .sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls);
    const tiles = [
      ['Total cost', money(total)],
      ['Model calls', usageCallsCell(t)],
      ['API requests', fmtInt(t.requests)],
      ['Tokens in / out', `${fmtInt(t.input_tokens)} / ${fmtInt(t.output_tokens)}`],
      ['Web searches', fmtInt(t.searches)],
    ].map(([label, value]) => `<div class="usage-tile"><div class="usage-tile-label">${label}</div><div class="usage-tile-value">${value}</div></div>`).join('');
    const calls = u.calls.map((c) => `<tr${c.error ? ' class="usage-error"' : ''}>
      <td class="nowrap">${escapeHtml(fmtTime(c.created_at))}</td>
      <td>${escapeHtml(c.category_label)}</td>
      <td>${escapeHtml(c.feature_label)}</td>
      <td>${escapeHtml(usageAgentLabel(c.speaker || 'unknown'))}</td>
      <td><code>${escapeHtml(c.model)}</code></td>
      <td class="num">${fmtInt(c.input_tokens)} / ${fmtInt(c.output_tokens)}</td>
      <td class="num">${money(Number(c.cost_usd) || 0)}</td>
      <td>${c.error ? `<span class="usage-failed" title="${escapeHtml(c.error)}">Failed</span>` : 'OK'}${c.source === 'transcript' ? ' <span class="muted" title="Recorded before per-call tracking; read from the transcript">· transcript</span>' : ''}</td></tr>`).join('');
    const notes = [
      u.ledger_available ? '' : 'Per-call tracking is not enabled on this database yet (the <code>llm_calls</code> table is missing), so these figures come from transcript messages and reports only. Answered-checks, meeting minutes and failed turns are not included.',
      u.ledger_available && u.legacy_calls ? `${fmtInt(u.legacy_calls)} call(s) ran before per-call tracking and are read from the transcript, so their model and request count may be missing.` : '',
      'Costs are what OpenRouter reported for each request. £ figures use the configured exchange rate and are estimates.',
    ].filter(Boolean).map((n) => `<p class="muted">${n}</p>`).join('');
    $('#usage-modal-body').innerHTML = `
      <div class="usage-tiles">${tiles}</div>
      ${usageGroupTable('By use', 'Use', categories, total, (g) => escapeHtml(g.label), (g) => (g.features.length > 1 ? g.features : []))}
      <div class="usage-pair">
        ${usageGroupTable('By model', 'Model', u.by_model, total, (g) => `<code>${escapeHtml(g.label)}</code>`)}
        ${usageGroupTable('By agent', 'Agent', u.by_agent, total, (g) => escapeHtml(usageAgentLabel(g.key)))}
      </div>
      <section class="usage-section"><h3>Calls${u.call_count > u.calls.length ? ` <span class="muted">(latest ${fmtInt(u.calls.length)} of ${fmtInt(u.call_count)})</span>` : ''}</h3>
        <div class="usage-scroll usage-calls"><table class="usage-table">
          <thead><tr><th scope="col">When</th><th scope="col">Use</th><th scope="col">Feature</th><th scope="col">Agent</th><th scope="col">Model</th><th scope="col" class="num">Tokens in / out</th><th scope="col" class="num">Cost</th><th scope="col">Status</th></tr></thead>
          <tbody>${calls || '<tr><td colspan="8" class="muted">No model calls yet.</td></tr>'}</tbody>
        </table></div>
      </section>
      ${notes}`;
  }

  async function openUsageModal() {
    const s = state.session;
    if (!s) return;
    const dlg = $('#dlg-usage');
    $('#usage-modal-title').textContent = `LLM usage and cost · ${s.title}`;
    const cached = state.usage && String(state.usage.session_id) === String(s.id) ? state.usage : null;
    if (cached) renderUsageModal(cached);
    else $('#usage-modal-body').innerHTML = '<p class="muted">Loading usage…</p>';
    if (!dlg.open) dlg.showModal();
    try {
      await refreshUsage();
    } catch (e) {
      if (!cached && dlg.open) $('#usage-modal-body').innerHTML = `<p class="usage-failed" role="alert">Could not load usage: ${escapeHtml(e.message)}</p>`;
    }
  }

  // Marks each Simulation Process step as "ran" once at least one message exists for its mode.
  function renderMeetingNav() {
    const s = state.session;
    if (!s) return;
    $$('#toolbar [data-round]').forEach((b) => {
      const mode = b.dataset.round;
      const started = s.messages.some((m) => m.mode === mode);
      const complete = started && !turnsForRound(mode, ALL).length;
      b.classList.toggle('ran', complete);
      b.classList.toggle('partial', started && !complete);
    });
    const stalled = stalledMeeting();
    const resume = $('#btn-resume-meeting');
    resume.hidden = !stalled;
    if (stalled) {
      const label = MODE_LABEL[stalled.mode] || stalled.mode;
      resume.textContent = `↻ Resume ${label}`;
      resume.title = `${label} stopped before every agent answered. Still to answer: ${stalled.pending.map((k) => AGENT_LABEL[k] || k).join(', ')}.`;
    }
  }

  // The latest standard meeting that has been started but not answered by every
  // agent, as { mode, pending }, or null. Only the latest one: an earlier gap
  // is caught by the round-order check before a later meeting can start.
  // Matches the server's stale-turn sweep (TURN_TIMEOUT_MS + 2 min, see
  // STALE_TURN_MS in src/db.js): an unfinished row younger than this may still
  // be running.
  const resumeStaleMs = () => ((state.config && state.config.turn_timeout_ms) || 750000) + 120000;
  function stalledMeeting() {
    const s = state.session;
    if (!s) return null;
    for (const mode of [...GRID_MODES].reverse()) {
      if (!s.messages.some((m) => m.mode === mode && m.role === 'agent')) continue;
      const pending = turnsForRound(mode, ALL);
      return pending.length ? { mode, pending } : null;
    }
    return null;
  }

  // Unsticks a meeting that stopped partway: clears the pending agents'
  // cut-off or failed rows for that meeting (a cut-off row also blocks that
  // agent's next turn on the server for ~14 minutes), then asks the agents
  // who have not answered, in order.
  async function resumeStalledMeeting() {
    if (state.running) return;
    const id = state.session.id;
    // Hold the controls (this button included) through the reload and the
    // confirms, so a double-click or a meeting started meanwhile cannot run
    // alongside it. Released before runSequence, which takes them itself.
    setRunning(true);
    let go = false;
    try {
      // Work from the server's copy: a turn that failed on this page, or one
      // started from another tab, is not in the local message list, and a row
      // missing here would be left behind to block that agent with a 409.
      let fresh;
      try {
        fresh = await api.get(`/api/sessions/${id}`);
      } catch (err) {
        return toast(`Could not reload the evaluation: ${err.message}`);
      }
      if (!state.session || state.session.id !== id) return; // user opened another evaluation meanwhile
      state.session.messages = fresh.messages;
      renderTranscript();
      go = await confirmAndClearStalled(id);
    } finally {
      setRunning(false);
    }
    if (go) await runSequence(go);
  }

  // Returns the turns to run, or false. Assumes the caller holds setRunning.
  async function confirmAndClearStalled(id) {
    const stalled = stalledMeeting();
    if (!stalled) { toast('Every agent has answered this meeting. Nothing to resume.'); return false; }
    const { mode, pending } = stalled;
    const label = MODE_LABEL[mode] || mode;
    const unmet = unmetPriorRound(mode);
    if (unmet) { toast(`Run ${MODE_LABEL[unmet] || unmet} for all ${ALL.length} agents before resuming ${label}.`); return false; }
    const who = pending.map((k) => AGENT_LABEL[k] || k).join(', ');
    if (!confirm(`Resume ${label}?

${who} will be asked, in order. Any of their turns in this meeting that were cut off or failed are cleared first.`)) return false;
    const stuck = state.session.messages.filter((m) => m.mode === mode && m.role === 'agent' && pending.includes(m.speaker) && (m.error || m.text == null));
    // An unfinished row this young may still be streaming somewhere (another
    // tab, or a server turn that outlived its page). Clearing it discards that
    // work, so say so and ask again rather than deciding silently.
    const recent = stuck.filter((m) => !m.error && Date.now() - new Date(m.created_at).getTime() < resumeStaleMs());
    if (recent.length) {
      const names = recent.map((m) => `${AGENT_LABEL[m.speaker] || m.speaker} (started ${fmtRelative(m.created_at)})`).join(', ');
      if (!confirm(`${names} may still be running, in another tab or on the server.

Clear it and ask again anyway? Any answer still on its way will be discarded.`)) return false;
    }
    try {
      for (const m of stuck) await api.send('DELETE', `/api/sessions/${id}/messages/${m.id}`);
    } catch (err) {
      toast(`Could not clear the stuck turn: ${err.message}`);
      return false;
    }
    if (!state.session || state.session.id !== id) return false;
    state.session.messages = state.session.messages.filter((m) => !stuck.includes(m));
    renderTranscript();
    return pending.map((speaker) => ({ speaker, mode }));
  }

  function renderMinutes() {
    const s = state.session;
    const list = s.meeting_minutes || [];
    $('#count-minutes').textContent = list.length;
    const box = $('#tab-minutes');
    if (!list.length) { box.innerHTML = '<div class="empty">No minutes yet. They\'re written automatically once a meeting (Baselines/Challenge/Converge/Cross-talk) finishes, and an entry is added whenever an agent\'s question is answered, discussed, escalated or reopened.</div>'; return; }
    // One line per meeting or question action, in the order they happened; a
    // line opens to the full minutes, and open lines stay open across re-renders.
    // A question entry is a record, not minutes awaiting approval, so it has no
    // Approve button or Pending badge.
    state.openMinutes = state.openMinutes || new Set();
    const isOpen = (mm) => state.openMinutes.has(mm.id);
    const isQuestion = (mm) => mm.round === 'question';
    box.innerHTML = `<ol class="minutes-list">${list.map((mm, i) => `
      <li class="minutes-card${isQuestion(mm) ? ' minutes-question' : ''}${isOpen(mm) ? ' open' : ''}" data-id="${mm.id}">
        <div class="minutes-head">
          <button type="button" class="minutes-toggle" aria-expanded="${isOpen(mm)}"><span class="minutes-num">${i + 1}</span><span class="label">${escapeHtml(mm.label)}</span><span class="muted minutes-date">${escapeHtml(fmtTime(mm.created_at))}</span></button>
          ${isQuestion(mm) ? '' : `<span class="${mm.approved ? 'minutes-approved' : 'minutes-pending'}">${mm.approved ? 'Approved' : 'Pending'}</span>
          ${mm.approved ? '' : '<button type="button" class="btn btn-sm btn-accent minutes-approve">Approve</button>'}
          ${!mm.approved && nextMeeting(mm.round) ? `<button type="button" class="btn btn-sm btn-primary minutes-approve minutes-continue" data-next="${escapeHtml(nextMeeting(mm.round))}" title="Approve these minutes, then convene ${escapeHtml(MODE_LABEL[nextMeeting(mm.round)])}">Approve and continue</button>` : ''}`}
        </div>
        <div class="minutes-tools">
          <span class="minutes-tool"><span class="minutes-tool-label">Minutes</span><button type="button" class="item-view" data-item-kind="minutes" data-item-key="${escapeHtml(String(mm.id))}">View</button>${itemDownloadsHtml('minutes', mm.id)}</span>
          ${GRID_MODES.includes(mm.round) ? `<span class="minutes-tool"><span class="minutes-tool-label">Full transcript</span><button type="button" class="item-view" data-item-kind="meeting" data-item-key="${escapeHtml(mm.round)}">View</button>${itemDownloadsHtml('meeting', mm.round)}</span>` : ''}
        </div>
        <div class="minutes-detail"${isOpen(mm) ? '' : ' hidden'}>
          <div class="minutes-body"></div>
          ${mm.anchor_message_id ? `<a href="#msg-${mm.anchor_message_id}" class="minutes-back">↑ ${isQuestion(mm) ? 'view in transcript' : 'view meeting'}</a>` : ''}
        </div>
      </li>`).join('')}</ol>`;
    $$('#tab-minutes .minutes-card').forEach((el, i) => { $('.minutes-body', el).replaceChildren(renderMarkdown(list[i].text)); });
    $$('#tab-minutes .item-view').forEach((b) => b.addEventListener('click', () => openItemModal(b.dataset.itemKind, b.dataset.itemKey)));
    $$('#tab-minutes .minutes-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.minutes-card');
        const id = Number(card.dataset.id);
        const open = !state.openMinutes.has(id);
        if (open) state.openMinutes.add(id); else state.openMinutes.delete(id);
        card.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', String(open));
        $('.minutes-detail', card).hidden = !open;
      });
    });
    $$('#tab-minutes .minutes-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.minutes-card');
        const id = Number(card.dataset.id);
        btn.disabled = true;
        try {
          const row = await api.send('PATCH', `/api/meeting-minutes/${id}/approve`);
          const mm = state.session.meeting_minutes.find((x) => x.id === id);
          if (mm) mm.approved = row.approved;
          renderMinutes();
          toast('Meeting approved.');
        } catch (e) { btn.disabled = false; toast(`Could not approve: ${e.message}`); return; }
        // "Approve and continue" goes on to the next meeting on the agenda. The
        // approval has landed by now, so a failure here is the meeting's alone.
        if (!btn.dataset.next) return;
        try {
          await startMeeting(btn.dataset.next);
        } catch (e) { toast(`Could not start ${MODE_LABEL[btn.dataset.next] || btn.dataset.next}: ${e.message}`); }
      });
    });
  }

  // Client-only "cuts" through the transcript already in state.session — no server call.
  function renderIntelligence() {
    const box = $('#tab-intelligence');
    box.innerHTML = `<div class="intel-cuts">
        <button type="button" class="chip${state.intelCut === 'agent' ? ' active' : ''}" data-cut="agent">By Agent</button>
        <button type="button" class="chip${state.intelCut === 'meeting' ? ' active' : ''}" data-cut="meeting">By Meeting</button>
        <button type="button" class="chip${state.intelCut === 'disagreement' ? ' active' : ''}" data-cut="disagreement">By Disagreement</button>
        <button type="button" class="chip${state.intelCut === 'resolution' ? ' active' : ''}" data-cut="resolution">By Resolution</button>
      </div>
      <div id="intel-body"></div>`;
    $$('.intel-cuts .chip', box).forEach((c) => c.addEventListener('click', () => { state.intelCut = c.dataset.cut; renderIntelligence(); }));
    renderIntelligenceBody($('#intel-body', box));
    $$('.intel-open', box).forEach((b) => b.addEventListener('click', () => {
      // Compare as strings: messages.id is bigserial, which node-pg returns as "123".
      const m = state.session.messages.find((x) => String(x.id) === b.dataset.msg);
      if (m) openMessageModal(m, m.role === 'user' ? 'user' : m.speaker);
    }));
  }

  function intelRow(href, title, meta) {
    return `<div class="intel-row"><a href="${href}">${escapeHtml(title)}</a><span class="muted">${escapeHtml(meta || '')}</span></div>`;
  }
  // A response row: opens the full response in the message modal.
  function intelMsgRow(m, title) {
    return `<div class="intel-row"><button type="button" class="intel-open" data-msg="${m.id}">${escapeHtml(title)}</button><span class="muted">${escapeHtml(fmtTime(m.created_at))}</span></div>`;
  }

  // An Autopilot message is named after the conversation it belongs to, not the
  // engine that ran it: the question or disagreement it discussed, or which
  // open panel debate. Returns { key, label }; key groups one run's messages.
  function conversationOf(m) {
    if (m.mode !== 'autopilot') return { key: m.mode, label: MODE_LABEL[m.mode] || m.mode || '' };
    const s = state.session;
    const meta = autopilotMeta(m) || {};
    const runs = s.autopilot_runs || [];
    const run = runs.find((r) => String(r.id) === String(meta.run_id));
    const key = `autopilot:${meta.run_id ?? 'unknown'}`;
    if (meta.question_id != null || (run && run.scope === 'question')) {
      const q = meta.question_id == null ? null : (s.questions || []).find((x) => String(x.id) === String(meta.question_id));
      const to = q ? q.addressees.split(',').filter(Boolean).map((k) => (k === 'moderator' ? 'Moderator' : AGENT_LABEL[k] || k)).join(', ') : '';
      return { key, label: q ? `Question discussion: ${AGENT_LABEL[q.asker] || q.asker} → ${to}` : 'Question discussion' };
    }
    if (run && run.scope === 'disagreement' && run.disagreement_n != null) {
      const d = (s.disagreements || []).find((x) => String(x.n) === String(run.disagreement_n));
      return { key, label: `Disagreement debate #${run.disagreement_n}${d ? `: ${d.topic}` : ''}` };
    }
    const debates = runs.filter((r) => r.scope !== 'question' && r.scope !== 'disagreement');
    const n = run ? debates.indexOf(run) + 1 : 0;
    return { key, label: n ? `Panel debate ${n}` : 'Panel debate' };
  }

  function renderIntelligenceBody(body) {
    const s = state.session;
    if (state.intelCut === 'agent') {
      const groups = [...ALL, 'moderator', 'user'].map((sp) => ({
        key: sp, label: AGENT_LABEL[sp], rows: s.messages.filter((m) => (m.role === 'user' ? 'user' : m.speaker) === sp && !m.error && m.text != null),
      })).filter((g) => g.rows.length);
      body.innerHTML = groups.length ? groups.map((g) => `<div class="intel-group"><h4>${escapeHtml(g.label)} (${g.rows.length})</h4>${g.rows.map((m) => intelMsgRow(m, `#${m.seq} · ${conversationOf(m).label}`)).join('')}</div>`).join('')
        : '<div class="empty">No messages yet.</div>';
    } else if (state.intelCut === 'meeting') {
      // One group per meeting type, and one per Autopilot conversation.
      const groups = new Map();
      for (const m of s.messages) {
        if (!m.mode) continue;
        const c = conversationOf(m);
        if (!groups.has(c.key)) groups.set(c.key, { ...c, mode: m.mode, rows: [] });
        if (!m.error && m.text != null) groups.get(c.key).rows.push(m);
      }
      body.innerHTML = groups.size ? [...groups.values()].map((g) => {
        const mm = g.mode === 'autopilot' ? null : (s.meeting_minutes || []).find((x) => x.round === g.mode);
        return `<div class="intel-group"><h4>${escapeHtml(g.label)}${mm ? ' · minutes ✓' : ''}</h4>${g.rows.map((m) => intelMsgRow(m, `${AGENT_LABEL[m.role === 'user' ? 'user' : m.speaker] || m.speaker} #${m.seq}`)).join('')}</div>`;
      }).join('') : '<div class="empty">No meetings run yet.</div>';
    } else if (state.intelCut === 'disagreement') {
      body.innerHTML = s.disagreements.length ? s.disagreements.map((d) => intelRow(`#dis-${d.n}`, `#${d.n} ${d.topic}`, d.status.toUpperCase())).join('')
        : '<div class="empty">No disagreements logged.</div>';
    } else {
      const resolved = s.disagreements.filter((d) => d.status === 'resolved');
      const unresolved = s.disagreements.filter((d) => d.status !== 'resolved');
      body.innerHTML = s.disagreements.length ? `
        <div class="intel-group"><h4>Unresolved (${unresolved.length})</h4>${unresolved.map((d) => intelRow(`#dis-${d.n}`, `#${d.n} ${d.topic}`, '')).join('') || '<div class="empty">None.</div>'}</div>
        <div class="intel-group"><h4>Resolved (${resolved.length})</h4>${resolved.map((d) => intelRow(`#dis-${d.n}`, `#${d.n} ${d.topic}`, '')).join('') || '<div class="empty">None.</div>'}</div>`
        : '<div class="empty">No disagreements logged.</div>';
    }
  }

  // Sends { round, label, anchor_message_id } to the moderator; the response is
  // pushed into state.session.meeting_minutes and the Minutes tab re-rendered.
  // Fire-and-forget from the caller's point of view — failures just toast.
  // Minutes for a standard meeting once every agent has answered it. A full
  // run of the meeting always gets fresh minutes; a resume or retry that
  // completes it gets them only if the meeting has none yet. Every path that
  // can complete a meeting calls this: runSequence, parallel Baselines and the
  // inline Retry on a failed turn.
  function writeMinutesIfComplete(mode, fullRun) {
    if (!GRID_MODES.includes(mode) || turnsForRound(mode, ALL).length) return;
    if (fullRun || !(state.session.meeting_minutes || []).some((x) => x.round === mode)) generateMeetingMinutes(mode);
    // A completed meeting is also when questions asked earlier are most likely
    // to have been answered, so check the open ones at the same point.
    checkAnsweredQuestions({ quiet: true });
  }

  // ---------------- agent questions ----------------
  // The Moderator Assistant reads the transcript and marks open questions that a
  // later message answered. quiet: no toast unless something changed.
  async function checkAnsweredQuestions({ quiet = false } = {}) {
    const s = state.session;
    if (!s || !(s.questions || []).some((x) => x.status === 'open')) {
      if (!quiet) toast('There are no open questions to check.');
      return;
    }
    const id = s.id;
    if (!quiet) toast('Checking the transcript for answers…');
    try {
      const r = await api.send('POST', `/api/sessions/${id}/questions/check`, {});
      if (!state.session || String(state.session.id) !== String(id)) return;
      applyQuestionResponse(r);
      renderCost();
      if (r.updated) toast(`${r.updated} question(s) found answered in the transcript`);
      else if (!quiet) toast('None of the open questions has been answered yet.');
    } catch (e) {
      if (!quiet) toast(`Could not check questions: ${e.message}`);
    }
  }

  const findMessage = (id) => (id == null ? null : state.session.messages.find((x) => String(x.id) === String(id)));
  function questionPartyChip(key) {
    return key === 'moderator' ? '<span class="agent-chip">Moderator</span>' : agentChipHtml(key);
  }
  // Panel agents a question was put to, other than the asker: the people a
  // discussion to resolution can be held between.
  const questionAgentAddressees = (qRow) => qRow.addressees.split(',').filter((k) => ALL.includes(k) && k !== qRow.asker);
  // Any panel agent but the asker can be asked to answer; the ones the
  // question was put to are ticked first.
  const questionAskableAgents = (qRow) => ALL.filter((k) => k !== qRow.asker);
  // The brief for an agent asked to answer a question outside a discussion.
  function questionAnswerInstruction(qRow) {
    const party = (k) => (k === 'moderator' ? 'the Moderator' : AGENT_LABEL[k] || k);
    const to = qRow.addressees.split(',').filter(Boolean).map(party).join(' and ') || 'the panel';
    return `The moderator asks you to answer this question, which ${party(qRow.asker)} put to ${to}:\n\n"${qRow.text}"\n\nAnswer it directly and specifically, with tagged evidence (search first if the answer needs it). If someone has already answered it in the transcript, add only what is missing or say where you disagree. Do not raise other topics.`;
  }

  // Question routes answer with the session's minutes as well, since every
  // action on a question adds an entry. Merged by id rather than replaced, so a
  // meeting's minutes written while the request was out are not dropped.
  function applyQuestionResponse(r) {
    if (r.questions) state.session.questions = r.questions;
    if (r.meeting_minutes) {
      const byId = new Map((state.session.meeting_minutes || []).map((x) => [String(x.id), x]));
      for (const row of r.meeting_minutes) byId.set(String(row.id), row);
      state.session.meeting_minutes = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
      renderMinutes();
    }
    renderQuestions();
  }

  // The same question cards are drawn in two places: the Agent Questions tab
  // (every question, filterable) and the Escalations tab (escalated ones only).
  const QUESTION_BOXES = { questions: '#tab-questions', escalations: '#tab-escalations' };

  function renderQuestions() {
    const s = state.session;
    const list = s.questions || [];
    // The lists are rebuilt after every turn, and Answer… can be open during a
    // meeting: keep any answer being typed, and keep its box open. Drafts are
    // kept per box, as the same question can be open in both.
    state.questionDrafts = state.questionDrafts || {};
    for (const [name, sel] of Object.entries(QUESTION_BOXES)) {
      $$('.qn', $(sel)).forEach((card) => {
        const panel = $('.qn-answer', card);
        const key = `${name}:${card.dataset.qid}`;
        if (panel && !panel.hidden) state.questionDrafts[key] = $('textarea', panel).value;
        else if (panel) delete state.questionDrafts[key];
      });
    }
    const openN = list.filter((x) => x.status === 'open' || x.status === 'escalated').length;
    $('#count-questions').textContent = list.length ? `${openN}/${list.length}` : '0';
    renderEscalations(list);
    const box = $(QUESTION_BOXES.questions);
    if (!list.length) {
      const hasAgentTurns = s.messages.some((m) => m.role === 'agent' && m.text);
      box.innerHTML = `<div class="empty">No questions logged yet. When an agent ends a response with "Questions for …", each question appears here with who asked whom, and you can answer it or have the agents discuss it to resolution.</div>
        ${hasAgentTurns ? '<div class="qn-footer"><button type="button" class="btn btn-sm" id="btn-questions-scan">Find questions in this evaluation</button></div>' : ''}`;
      $('#btn-questions-scan', box)?.addEventListener('click', scanQuestions);
      return;
    }
    const filter = state.questionFilter || 'open';
    const counts = {
      open: list.filter((x) => x.status === 'open').length,
      escalated: list.filter((x) => x.status === 'escalated').length,
      done: list.filter((x) => x.status === 'answered' || x.status === 'resolved').length,
      all: list.length,
    };
    const shown = list.filter((x) => filter === 'all' || (filter === 'done' ? (x.status === 'answered' || x.status === 'resolved') : x.status === filter));
    const chip = (key, label) => `<button type="button" class="chip${filter === key ? ' active' : ''}" data-qfilter="${key}">${label} (${counts[key]})</button>`;
    box.innerHTML = `<div class="qn-filters">${chip('open', 'Open')}${chip('escalated', 'Escalated')}${chip('done', 'Answered')}${chip('all', 'All')}
        <span class="qn-filters-actions">
          <button type="button" class="btn btn-sm" id="btn-questions-check">Check for answers now</button>
          <button type="button" class="btn btn-sm btn-quiet" id="btn-questions-scan">Rescan transcript</button>
        </span>
      </div>
      ${shown.length ? shown.map(questionCardHtml).join('') : '<div class="empty">No questions in this view.</div>'}`;
    $$('[data-qfilter]', box).forEach((b) => b.addEventListener('click', () => { state.questionFilter = b.dataset.qfilter; renderQuestions(); }));
    wireQuestionCards('questions', list);
    $('#btn-questions-check', box).addEventListener('click', () => checkAnsweredQuestions());
    $('#btn-questions-scan', box).addEventListener('click', scanQuestions);
  }

  // Escalations: the questions waiting on the moderator. The count turns amber
  // while there are any.
  function renderEscalations(list) {
    const escalated = list.filter((x) => x.status === 'escalated');
    const count = $('#count-escalations');
    count.textContent = escalated.length;
    count.className = escalated.length ? 'count count-alert' : 'count';
    const box = $(QUESTION_BOXES.escalations);
    box.innerHTML = escalated.length
      ? `<p class="qn-intro">Questions the panel could not settle within its loop or cost limit, and any you escalated yourself. Answer one, have the agents discuss it again, or reopen it.</p>${escalated.map(questionCardHtml).join('')}`
      : '<div class="empty">Nothing is escalated. A question comes here when a discussion to resolution runs out of loops or reaches the cost limit, or when you escalate it.</div>';
    wireQuestionCards('escalations', list);
  }

  function wireQuestionCards(name, list) {
    const box = $(QUESTION_BOXES[name]);
    $$('[data-open-msg]', box).forEach((b) => b.addEventListener('click', () => {
      const m = findMessage(b.dataset.openMsg);
      if (m) openMessageModal(m, m.role === 'user' ? 'user' : m.speaker);
    }));
    $$('.qn', box).forEach((card) => {
      const qRow = list.find((x) => String(x.id) === card.dataset.qid);
      if (!qRow) return;
      $('[data-qview]', card)?.addEventListener('click', () => openItemModal('question', qRow.id));
      $$('[data-qact]', card).forEach((b) => b.addEventListener('click', () => questionAction(qRow, b.dataset.qact, card)));
    });
    const prefix = `${name}:`;
    for (const [key, draft] of Object.entries(state.questionDrafts)) {
      if (!key.startsWith(prefix)) continue;
      const card = $$('.qn', box).find((c) => c.dataset.qid === key.slice(prefix.length));
      if (!card) continue;
      $('.qn-answer', card).hidden = false;
      $('.qn-answer textarea', card).value = draft;
    }
  }

  function questionCardHtml(qRow) {
    const asked = findMessage(qRow.message_id);
    const answer = findMessage(qRow.answer_message_id);
    const addressees = qRow.addressees.split(',').filter(Boolean);
    const canDiscuss = ALL.includes(qRow.asker) && questionAgentAddressees(qRow).length > 0;
    const statusActions = qRow.status === 'open'
      ? '<button type="button" class="btn btn-sm btn-quiet" data-qact="mark-resolved">Mark as Resolved</button><button type="button" class="btn btn-sm btn-quiet" data-qact="escalate">Escalate to Moderator</button>'
      : '<button type="button" class="btn btn-sm btn-quiet" data-qact="reopen">Reopen</button>';
    // Only an open question: the answered-check that follows an ask looks at
    // open questions only, so asking about an escalated or settled one would
    // spend the turns and change nothing.
    const askable = qRow.status === 'open' ? questionAskableAgents(qRow) : [];
    const askDefault = new Set(questionAgentAddressees(qRow).length ? questionAgentAddressees(qRow) : askable);
    const note = qRow.resolution_note ? escapeHtml(qRow.resolution_note) : '';
    return `<div class="qn qn-${escapeHtml(qRow.status)}" data-qid="${escapeHtml(String(qRow.id))}">
      <div class="qn-head">${questionPartyChip(qRow.asker)} <span>asked</span> ${addressees.map(questionPartyChip).join(' ')}
        <span class="qn-status qn-status-${escapeHtml(qRow.status)}">${escapeHtml(QUESTION_STATUS_LABEL[qRow.status] || qRow.status)}</span></div>
      <div class="qn-text">${escapeHtml(qRow.text)}</div>
      <div class="qn-meta">Asked in ${escapeHtml(MODE_LABEL[qRow.round] || qRow.round || 'the transcript')}${asked ? ` <button type="button" class="qn-link" data-open-msg="${escapeHtml(String(asked.id))}">#${asked.seq}</button>` : ''}${qRow.status !== 'open' && (note || answer) ? ` · ${note || 'Answered'}${answer ? ` <button type="button" class="qn-link" data-open-msg="${escapeHtml(String(answer.id))}">#${answer.seq}</button>` : ''}` : ''} · <button type="button" class="qn-link" data-qview>View</button>${itemDownloadsHtml('question', qRow.id)}</div>
      <div class="qn-actions">
        <button type="button" class="btn btn-sm" data-qact="answer">Answer…</button>
        ${askable.length ? '<button type="button" class="btn btn-sm" data-qact="ask">Ask agents to answer…</button>' : ''}
        ${canDiscuss ? '<button type="button" class="btn btn-sm" data-qact="discuss">Discuss to resolution…</button>' : ''}
        ${statusActions}
      </div>
      ${askable.length ? `<div class="qn-ask" hidden>
        <fieldset class="agent-picks">
          <legend>Who answers, in order</legend>
          ${askable.map((k) => `<label><input type="checkbox" value="${escapeHtml(k)}"${askDefault.has(k) ? ' checked' : ''}> ${escapeHtml(AGENT_LABEL[k] || k)}</label>`).join('')}
        </fieldset>
        <div><button type="button" class="btn btn-sm btn-primary" data-qact="send-ask">Ask selected agents</button></div>
      </div>` : ''}
      <div class="qn-answer" hidden>
        <textarea rows="3" placeholder="Your answer, as moderator"></textarea>
        ${ALL.includes(qRow.asker) ? `<label class="check-inline"><input type="checkbox" class="qn-ask-back" checked> Ask ${escapeHtml(AGENT_LABEL[qRow.asker] || qRow.asker)} to respond</label>` : ''}
        <div><button type="button" class="btn btn-sm btn-primary" data-qact="send-answer">Send answer</button></div>
      </div>
    </div>`;
  }

  async function scanQuestions() {
    if (state.running) return toast('Wait for the current turn to finish.');
    const id = state.session.id;
    try {
      const r = await api.send('POST', `/api/sessions/${id}/questions/scan`, {});
      if (String(state.session.id) !== String(id)) return;
      state.session.questions = r.questions;
      renderQuestions();
      toast(r.added ? `${r.added} new question(s) found` : 'No new questions found');
      if (r.added) checkAnsweredQuestions({ quiet: true });
    } catch (e) { toast(`Could not scan for questions: ${e.message}`); }
  }

  // discussion: { run_id, outcome, cycles } when a discuss-to-resolution run is
  // what this change closes, so its minutes entry records the run.
  async function setQuestionStatus(qRow, status, resolution_note, answer_message_id, discussion) {
    const id = state.session.id;
    const r = await api.send('PATCH', `/api/sessions/${id}/questions/${qRow.id}`, { status, resolution_note, answer_message_id, discussion });
    if (String(state.session.id) !== String(id)) return;
    applyQuestionResponse(r);
  }

  async function questionAction(qRow, act, card) {
    if (!['answer', 'ask'].includes(act) && state.running) return toast('Wait for the current turn to finish.');
    try {
      if (act === 'answer') {
        const panel = $('.qn-answer', card);
        panel.hidden = !panel.hidden;
        if (!panel.hidden) $('textarea', panel).focus();
      } else if (act === 'ask') {
        const panel = $('.qn-ask', card);
        panel.hidden = !panel.hidden;
      } else if (act === 'send-ask') {
        const picks = $$('.qn-ask input:checked', card).map((c) => c.value);
        if (!picks.length) return toast('Pick at least one agent');
        $('.qn-ask', card).hidden = true;
        const instruction = questionAnswerInstruction(qRow);
        // A custom turn per agent, in order; question_id is carried for the record.
        const ok = await runSequence(picks.map((speaker) => ({ speaker, mode: 'custom', instruction, question_id: String(qRow.id) })));
        // The Moderator Assistant then decides whether that answered it, but
        // only if every agent answered: after a stop or a failed turn the check
        // would be a model call with nothing new to read.
        if (ok) await checkAnsweredQuestions({ quiet: true });
      } else if (act === 'send-answer') {
        const text = $('.qn-answer textarea', card).value.trim();
        if (!text) return toast('Write an answer first.');
        const askBack = Boolean($('.qn-ask-back', card)?.checked);
        // Tracked by question id, not by this card element: the list can be
        // redrawn while the answer posts, replacing the card, and a second click
        // on the new card must not post the answer twice.
        const qid = String(qRow.id);
        state.sendingAnswer = state.sendingAnswer || new Set();
        if (state.sendingAnswer.has(qid)) return;
        state.sendingAnswer.add(qid);
        let r;
        try {
          r = await api.send('POST', `/api/sessions/${state.session.id}/questions/${qid}/answer`, { text });
        } finally { state.sendingAnswer.delete(qid); }
        // Sent: close the box on whichever card is live now, and drop the draft
        // so the redraw below does not reopen it.
        for (const [name, sel] of Object.entries(QUESTION_BOXES)) {
          delete (state.questionDrafts || {})[`${name}:${qid}`];
          const live = $$('.qn', $(sel)).find((c) => c.dataset.qid === qid);
          if (live) $('.qn-answer', live).hidden = true;
        }
        state.session.messages.push(r.message);
        $('.empty', $('#transcript'))?.remove();
        $('#transcript').appendChild(messageElement(r.message));
        applyQuestionResponse(r);
        toast('Answer sent');
        if (askBack && r.respondents.length) await runSequence(r.respondents.map((a) => ({ speaker: a, mode: 'reply' })));
      } else if (act === 'mark-resolved') {
        await setQuestionStatus(qRow, 'resolved', 'Marked resolved by the moderator');
      } else if (act === 'escalate') {
        await setQuestionStatus(qRow, 'escalated', 'Escalated by the moderator for offline review');
      } else if (act === 'reopen') {
        await setQuestionStatus(qRow, 'open', null);
      } else if (act === 'discuss') {
        openQuestionDiscussDialog(qRow);
      }
    } catch (e) { toast(`Could not update the question: ${e.message}`); }
  }

  function openQuestionDiscussDialog(qRow) {
    const dlg = $('#dlg-question-discuss');
    const addressees = questionAgentAddressees(qRow);
    dlg.dataset.qid = String(qRow.id);
    $('#qd-question').textContent = `“${qRow.text}”`;
    $('#qd-summary').textContent = `Each loop, ${addressees.map((k) => AGENT_LABEL[k] || k).join(' and ')} answer${addressees.length === 1 ? 's' : ''}, then ${AGENT_LABEL[qRow.asker] || qRow.asker} says whether that settles it. If it is still not settled after the last loop, the question is escalated to you for offline review.`;
    $('#qd-loops').value = 3;
    $('#qd-loops-label').textContent = '3';
    $('#qd-length').value = 2;
    $('#qd-length-label').textContent = LENGTH_LABELS[2];
    dlg.showModal();
  }

  // Autopilot outcome → question status. Resolved when the asker said so;
  // escalated when the loop or cost limit ran out first. A failed turn or a
  // manual stop leaves the status as it was, since nothing was decided, but
  // still reports the run so it gets its minutes entry.
  async function settleQuestionAfterDiscussion(settings, outcome, cycle, resolvedMsg, runId) {
    const qRow = (state.session.questions || []).find((x) => String(x.id) === String(settings.question_id));
    if (!qRow) return;
    const discussion = { run_id: runId, outcome: outcome || 'stopped_by_moderator', cycles: cycle };
    try {
      if (outcome === 'resolved') {
        await setQuestionStatus(qRow, 'resolved', `Resolved in discussion after ${cycle} loop(s)`, resolvedMsg ? resolvedMsg.id : null, discussion);
        toast('Question resolved');
      } else if (['cycle_cap', 'safety_cap', 'cost_cap'].includes(outcome)) {
        const why = outcome === 'cost_cap' ? 'the cost limit was reached' : `${cycle} loop(s)`;
        await setQuestionStatus(qRow, 'escalated', `Not resolved after ${why}; escalated to the moderator for offline review`, undefined, discussion);
        toast('Question not resolved: escalated to you for offline review', 5000);
      } else {
        // Nothing was decided: send no status, so a change made while the run
        // was going (the answered-check, another tab) is not overwritten.
        await setQuestionStatus(qRow, undefined, undefined, undefined, discussion);
      }
    } catch (e) { toast(`Could not update the question: ${e.message}`); }
  }

  async function generateMeetingMinutes(mode) {
    const anchor = state.session.messages.find((m) => m.mode === mode);
    try {
      toast(`Writing meeting minutes for ${MODE_LABEL[mode] || mode}…`);
      const row = await api.send('POST', `/api/sessions/${state.session.id}/meeting-minutes`, {
        round: mode, label: MODE_LABEL[mode] || mode, anchor_message_id: anchor ? anchor.id : null,
      });
      state.session.meeting_minutes = [...(state.session.meeting_minutes || []), row];
      renderMinutes(); renderIntelligence();
      toast('Meeting minutes ready');
    } catch (e) { toast(`Could not write meeting minutes: ${e.message}`); } finally { renderCost(); }
  }

  function setRunning(on) {
    state.running = on;
    $$('#toolbar button, #btn-send, #btn-delete, .report-generate').forEach((b) => { if (!['btn-stop', 'btn-toggle-process'].includes(b.id)) b.disabled = on; });
    // A turn reads the model when it starts, so a switch mid-meeting would split
    // one meeting across two models. Switching waits until the meeting is over.
    $('#session-model').disabled = on;
    $('#btn-stop').hidden = !on;
    if (!on) { state.stopRequested = false; renderMeetingNav(); }
  }

  // Meetings and autopilot are driven from this page, one request per turn,
  // and on Vercel a turn can die with the connection that started it. Reloading
  // or navigating away mid-meeting therefore strands the current turn and
  // never asks the remaining agents, so ask the browser to confirm first.
  function warnIfMeetingRunning(e) {
    if (!state.running || signingInAgain) return undefined;
    e.preventDefault();
    e.returnValue = ''; // older Chromium/Safari still need this to show the prompt
    return '';
  }

  // ---------------- running turns ----------------
  // Streams one agent turn. Resolves when the turn is done or has failed.
  // `container` (optional): where to append the live element — a Round 1
  // column instead of the flat transcript, when running in parallel.
  function runTurn(turn, container) {
    const { speaker, mode, instruction } = turn;
    // Every agent turn streams into the transcript, so show it: a meeting,
    // discussion or reply can be started from the Intelligence page.
    // Land at the end, where the new turn is, not where reading was left.
    if (state.warRoomOpen) {
      showSessionPane('transcript');
      $('#transcript').scrollTop = $('#transcript').scrollHeight;
    }
    return new Promise(async (resolve) => {
      const t = $('#transcript');
      $('.empty', t)?.remove();
      const appendTarget = container || t;
      const el = document.createElement('article');
      el.className = `msg msg-${speaker}`;
      el.dataset.speaker = speaker;
      el.innerHTML = `<div class="msg-head"><span class="msg-who">${escapeHtml(AGENT_LABEL[speaker])}</span><span class="msg-mode">${escapeHtml(MODE_LABEL[mode] || mode)}</span><span class="msg-meta">now</span></div><div class="msg-status"><span class="spinner"></span><span class="txt">Thinking…</span><span class="turn-timer">0:00</span></div><div class="msg-searches"></div><div class="msg-body"></div>`;
      appendTarget.appendChild(el);
      // In a column the new card can sit well above the bottom of the transcript
      // (a resumed agent whose column is shorter than the others), so bring it
      // into view rather than leaving it streaming off-screen.
      if (container) el.scrollIntoView({ block: 'nearest' });
      const body = $('.msg-body', el); const statusEl = $('.msg-status .txt', el); const searchesEl = $('.msg-searches', el);
      const turnTimerEl = $('.msg-status .turn-timer', el);
      const turnStart = Date.now();
      const tick = () => { const ms = Date.now() - turnStart; if (turnTimerEl) turnTimerEl.textContent = fmtElapsed(ms); updateActiveClock(ms); };
      const tickInterval = setInterval(tick, 1000);
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
        clearInterval(tickInterval);
        state.sessionActiveMs += Date.now() - turnStart;
        updateActiveClock(0);
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
            setRunning(true);
            try {
              if (await runTurn(turn, container)) writeMinutesIfComplete(turn.mode, false);
            } finally { setRunning(false); loadSessions(); }
          });
          err.appendChild(retry);
          el.appendChild(err);
        }
        resolve(ok);
      };
      try {
        const r = await fetch(`/api/sessions/${state.session.id}/turn`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(turn) });
        await signInAgainIf401(r);
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
              if (data.message.mode === 'decision') { state.session.decision_text = data.message.text; renderDecisionTab(); }
              renderSources(); renderDisagreements(); renderCost();
              if (data.new_disagreements.length) toast(`${data.new_disagreements.length} disagreement(s) logged`);
              if (data.questions) { state.session.questions = data.questions; renderQuestions(); }
              if (data.new_questions) toast(`${data.new_questions} question(s) logged`);
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

  // Agents in `agents` that don't already have a finished answer for this
  // round — what re-clicking the round button should actually run. A row with
  // no error but text still null is not an answer: it is a turn in flight, or
  // one orphaned when the page that drove it was left (see messageElement).
  function agentsAnswered(mode) {
    return new Set(state.session.messages.filter((m) => m.mode === mode && m.role === 'agent' && !m.error && m.text != null).map((m) => m.speaker));
  }
  function turnsForRound(mode, agents) {
    const done = agentsAnswered(mode);
    return agents.filter((a) => !done.has(a));
  }
  // The first earlier standard meeting that not every agent has answered, or
  // null. Mirrors the server's round-order check (src/app.js).
  function unmetPriorRound(mode) {
    const seqIdx = GRID_MODES.indexOf(mode);
    for (let i = 0; i < seqIdx; i++) {
      const done = agentsAnswered(GRID_MODES[i]);
      if (ALL.some((a) => !done.has(a))) return GRID_MODES[i];
    }
    return null;
  }

  // The standard meeting after `mode` on the agenda, or null after the last.
  const nextMeeting = (mode) => {
    const i = GRID_MODES.indexOf(mode);
    return i >= 0 && i < GRID_MODES.length - 1 ? GRID_MODES[i + 1] : null;
  };

  // Convenes one of the four standard meetings: the sidebar's agenda steps and
  // the Minutes tab's "Approve and continue" both come here.
  function startMeeting(mode) {
    if (state.running) return toast('A turn is already running');
    // Mirrors the server's round-order check (src/app.js) so a premature
    // click gets one clear toast instead of three separate "Turn failed"
    // messages, one per agent.
    const prior = unmetPriorRound(mode);
    if (prior) return toast(`Run ${MODE_LABEL[prior] || prior} for all ${ALL.length} agents before starting ${MODE_LABEL[mode] || mode}.`);
    const pending = turnsForRound(mode, ALL);
    if (pending.length === ALL.length) return mode === 'opening' ? runRound1Parallel() : runSequence(ALL.map((a) => ({ speaker: a, mode })));
    if (!pending.length) {
      if (!confirm(`${MODE_LABEL[mode] || mode} already has a response from every agent. Run it again? This adds new responses; it does not replace the old ones.`)) return;
      return mode === 'opening' ? runRound1Parallel() : runSequence(ALL.map((a) => ({ speaker: a, mode })));
    }
    // A previous run of this round failed partway through — only run the
    // agents that don't already have a response, instead of duplicating
    // the ones that succeeded.
    toast(`Resuming ${MODE_LABEL[mode] || mode}: ${pending.length} agent(s) haven't answered yet.`);
    return runSequence(pending.map((a) => ({ speaker: a, mode })));
  }

  // The columns a live meeting's turns stream into, keyed by agent. Reuses the
  // transcript's last grid when it is this meeting's and nothing follows it
  // (resuming, or retrying one agent), so answers line up with the ones already
  // there; otherwise starts a new grid. fresh: always start a new one.
  function meetingColumns(t, mode, { fresh = false } = {}) {
    const last = t.lastElementChild;
    if (!fresh && last && last.classList.contains('agent-grid') && last.dataset.mode === mode) {
      const cols = {};
      for (const a of ALL) cols[a] = last.querySelector(`:scope > .agent-col[data-speaker="${a}"]`);
      if (ALL.every((a) => cols[a])) return cols;
    }
    const grid = document.createElement('div'); grid.className = 'agent-grid'; grid.dataset.mode = mode;
    const cols = {};
    for (const a of ALL) {
      const col = document.createElement('div'); col.className = `agent-col agent-col-${a}`; col.dataset.speaker = a;
      grid.appendChild(col); cols[a] = col;
    }
    t.appendChild(grid);
    return cols;
  }

  // Resolves true when every turn ran, false after a stop, a failed turn or
  // when another turn was already running.
  async function runSequence(turns) {
    if (state.running) { toast('A turn is already running'); return false; }
    setRunning(true);
    try {
      // These rounds still run one agent at a time, in order — Round 2/3 and
      // cross-talk need each agent to see what came before. But when the full
      // trio is running the same round, lay it out as 3 columns like Round 1,
      // filling in left to right as each agent finishes.
      const t = $('#transcript');
      $('.empty', t)?.remove();
      const gridEligible = turns.length === 3 && GRID_MODES.includes(turns[0].mode) &&
        turns.every((x) => x.mode === turns[0].mode) && new Set(turns.map((x) => x.speaker)).size === 3 &&
        turns.every((x) => ALL.includes(x.speaker));
      // Any turns of one standard meeting go in their agents' columns, not just
      // a full trio: a resumed meeting or a Retry asks one or two agents, and
      // their answers belong under their own heads beside the others'.
      const columned = GRID_MODES.includes(turns[0].mode) &&
        turns.every((x) => x.mode === turns[0].mode && ALL.includes(x.speaker));
      const cols = columned ? meetingColumns(t, turns[0].mode) : null;
      if (cols) t.scrollTop = t.scrollHeight;
      let allOk = true;
      for (const turn of turns) {
        if (state.stopRequested) { toast('Stopped'); allOk = false; break; }
        const ok = await runTurn(turn, cols ? cols[turn.speaker] : undefined);
        if (!ok) { allOk = false; break; } // leave the retry button in place; don't cascade failures
      }
      // Meeting minutes only for the four standard meetings run as a full trio —
      // not for custom rounds, replies, or dive-deeper follow-ups.
      if (allOk && columned) writeMinutesIfComplete(turns[0].mode, gridEligible);
      return allOk;
    } finally {
      setRunning(false);
      loadSessions();
    }
  }

  // Round 1 specifically: its own prompt tells agents not to see or reference
  // each other, so unlike every other round it's safe to run all three at
  // once — shown as 3 columns via renderTranscript()'s agent-grid grouping.
  async function runRound1Parallel() {
    if (state.running) { toast('A turn is already running'); return; }
    setRunning(true);
    try {
      const t = $('#transcript');
      $('.empty', t)?.remove();
      const cols = meetingColumns(t, 'opening', { fresh: true });
      t.scrollTop = t.scrollHeight;
      await Promise.allSettled(ALL.map((a) => runTurn({ speaker: a, mode: 'opening' }, cols[a])));
      // Refresh from the server once all three have settled — each turn's own
      // 'done' snapshot of sources/disagreements can be stale relative to a
      // sibling turn that finished microseconds later; re-fetching guarantees
      // the final render is consistent instead of racing on SSE arrival order.
      state.session = await api.get(`/api/sessions/${state.session.id}`);
      renderSession();
      if (!state.stopRequested) writeMinutesIfComplete('opening', true);
    } finally {
      setRunning(false);
      loadSessions();
    }
  }

  // ---------------- autopilot ----------------
  // A boosted, multi-cycle cross-talk that runs until a stop condition is met.
  // Each cycle is one sequential pass of the checked agents (same ordering
  // model as Round 2/3), speaking order rotating each cycle. Client-driven so
  // each turn stays one HTTP request (Vercel's 800s function cap).
  async function runAutopilot(settings) {
    if (state.running) { toast('A turn is already running'); return; }
    setRunning(true);
    const sessionId = state.session.id;
    let run;
    try {
      run = await api.send('POST', `/api/sessions/${sessionId}/autopilot-runs`, {
        scope: settings.scope, disagreement_n: settings.disagreement_n, settings,
      });
      if (!run || run.id == null) throw new Error('no run was created');
      // Agent notes names each run's messages from this list, so the new run
      // has to be on it before the first turn lands.
      state.session.autopilot_runs = [...(state.session.autopilot_runs || []), run];
    } catch (e) { toast(`Could not start autopilot: ${e.message}`); setRunning(false); return; }

    const base = settings.agents.slice();
    const t = $('#transcript');
    $('.empty', t)?.remove();
    const hardCap = state.config.autopilot.max_cycles;
    const interactionsCap = settings.interactions === 'inf' ? Infinity : settings.interactions;
    let cycle = 0;
    let costSum = 0;
    let outcome = null;
    // A question discussion keeps a fixed order (whoever was asked, then the
    // asker) and ends when the asker's verdict line says RESOLVED.
    const isQuestion = settings.scope === 'question';
    let resolvedMsg = null;

    try {
      cycleLoop:
      while (true) {
        if (state.stopRequested) { outcome = 'stopped_by_moderator'; break; }
        cycle++;
        const shift = isQuestion ? 0 : (cycle - 1) % base.length;
        const order = base.slice(shift).concat(base.slice(0, shift));
        const header = document.createElement('div'); header.className = 'cycle-header';
        header.innerHTML = `<span>${isQuestion ? 'Question discussion · loop' : 'Cycle'} ${cycle}${Number.isFinite(interactionsCap) ? ` of ${interactionsCap}` : ''}</span>`;
        t.appendChild(header);
        const grid = document.createElement('div'); grid.className = 'agent-grid';
        t.appendChild(grid);
        t.scrollTop = t.scrollHeight;
        const positions = [];
        for (const speaker of order) {
          if (state.stopRequested) { outcome = 'stopped_by_moderator'; break cycleLoop; }
          const col = document.createElement('div'); col.className = 'agent-col';
          grid.appendChild(col);
          const turn = isQuestion
            ? { speaker, mode: 'autopilot', max_chars: settings.max_chars, question_id: settings.question_id, autopilot: { run_id: run.id, cycle, question_id: settings.question_id } }
            : {
              speaker, mode: 'autopilot', max_chars: settings.max_chars,
              stance_index: settings.stances[speaker], disagreement_n: settings.disagreement_n,
              // The Custom meeting dialog's agenda item, when one was given.
              instruction: settings.instruction || undefined,
              autopilot: { run_id: run.id, cycle },
            };
          const ok = await runTurn(turn, col);
          if (!ok) { outcome = 'failed'; break cycleLoop; }
          const last = state.session.messages[state.session.messages.length - 1];
          costSum += last.cost_usd || 0;
          positions.push(parsePosition(last.text));
          if (isQuestion && speaker === settings.asker && parseQuestionStatus(last.text) === 'RESOLVED') {
            resolvedMsg = last;
            outcome = 'resolved';
            await api.send('PATCH', `/api/sessions/${sessionId}/autopilot-runs/${run.id}`, { cycles_run: cycle, cost_usd: costSum }).catch(() => {});
            break cycleLoop;
          }
        }
        await api.send('PATCH', `/api/sessions/${sessionId}/autopilot-runs/${run.id}`, { cycles_run: cycle, cost_usd: costSum }).catch(() => {});
        const unanimous = positions.length === order.length && positions.every((p) => p === 'AGREE');
        if (!isQuestion && settings.stopOnUnanimous && unanimous) { outcome = 'unanimous'; break; }
        if (costSum >= state.config.autopilot.max_cost_usd) { outcome = 'cost_cap'; break; }
        if (cycle >= Math.min(interactionsCap, hardCap)) { outcome = cycle >= hardCap ? 'safety_cap' : 'cycle_cap'; break; }
      }
    } finally {
      await api.send('PATCH', `/api/sessions/${sessionId}/autopilot-runs/${run.id}`, {
        cycles_run: cycle, outcome: outcome || 'stopped_by_moderator', cost_usd: costSum, ended_at: new Date().toISOString(),
      }).catch(() => {});
      const reasonText = AUTOPILOT_OUTCOME_LABEL[outcome] || outcome || 'stopped';
      try {
        const noteText = isQuestion
          ? `Question discussion stopped after ${cycle} loop(s): ${outcome === 'resolved' ? 'resolved' : ['cycle_cap', 'safety_cap', 'cost_cap'].includes(outcome) ? `${reasonText}; escalated to the moderator` : reasonText}.`
          : `Autopilot stopped after ${cycle} cycle(s): ${reasonText}.`;
        const note = await api.send('POST', `/api/sessions/${sessionId}/system-note`, { speaker: 'autopilot', text: noteText });
        state.session.messages.push(note);
        $('.empty', t)?.remove();
        t.appendChild(messageElement(note));
        t.scrollTop = t.scrollHeight;
      } catch (e) { /* non-fatal: the run row still has the outcome */ }
      if (isQuestion && String(state.session.id) === String(sessionId)) await settleQuestionAfterDiscussion(settings, outcome, cycle, resolvedMsg, run.id);
      if (outcome === 'unanimous' && settings.autoResolve && settings.scope === 'disagreement' && settings.disagreement_n) {
        try {
          state.session.disagreements = await api.send('PATCH', `/api/sessions/${sessionId}/disagreements/${settings.disagreement_n}`, { status: 'resolved' });
          renderDisagreements();
        } catch (e) { toast(`Could not auto-resolve disagreement: ${e.message}`); }
      }
      renderCost();
      setRunning(false);
      loadSessions();
    }
  }

  function autopilotStanceRows(container, agents) {
    container.innerHTML = agents.map((a) => `
      <div class="stance-row" data-agent="${a}">
        <label>${escapeHtml(AGENT_LABEL[a])} stance
          <input type="range" class="stance-slider" min="0" max="4" step="1" value="2" data-agent="${a}">
          <span class="range-label stance-label"></span>
        </label>
      </div>`).join('');
    const bank = state.config.stance_bank || {};
    $$('.stance-slider', container).forEach((sl) => {
      const label = $('.stance-label', sl.closest('.stance-row'));
      const update = () => {
        const i = Number(sl.value);
        const entry = bank[String(i + 1)];
        label.textContent = (entry && entry.label) || STANCE_LABELS[i];
      };
      sl.addEventListener('input', update);
      update();
    });
  }

  // Custom meeting and Autopilot share one dialog: the agenda item and the
  // panel are the same either way, and "How it runs" decides whether each
  // agent answers once or the panel debates it over several cycles. Opened
  // from the sidebar (discussion scope) or from a disagreement, which presets
  // Autopilot on that disagreement.
  function openCustomMeetingDialog({ scope = 'discussion', disagreementN, disagreementTopic } = {}) {
    const dlg = $('#dlg-custom');
    const onDisagreement = scope === 'disagreement';
    dlg.dataset.scope = scope;
    dlg.dataset.disagreementN = disagreementN || '';
    $('#custom-title').textContent = onDisagreement ? `Autopilot: Disagreement #${disagreementN}` : 'Custom meeting';
    $('#custom-subtitle').textContent = onDisagreement
      ? `Let the panel debate ${disagreementTopic} unaided. Add a steer if you want one, set the limits, then observe.`
      : 'Table your own agenda item. It replaces the standard meeting brief; the evidence rules still apply.';
    $('#custom-instruction').value = '';
    $$('#custom-agents input').forEach((c) => { c.checked = true; });
    // A disagreement debate is autopilot by definition; the choice is hidden.
    $('#custom-run-mode').hidden = onDisagreement;
    $(`#custom-run-mode input[value="${onDisagreement ? 'autopilot' : 'once'}"]`).checked = true;
    $('#autopilot-auto-resolve-row').hidden = !onDisagreement;
    $('#autopilot-length').value = 1;
    $('#autopilot-length-label').textContent = LENGTH_LABELS[1];
    $('#autopilot-interactions').value = 6;
    $('#autopilot-interactions-label').textContent = '6';
    $('#autopilot-stop-unanimous').checked = true;
    $('#autopilot-auto-resolve').checked = true;
    autopilotStanceRows($('#autopilot-stances'), ALL);
    syncCustomRunMode();
    dlg.showModal();
    $('#custom-instruction').focus();
  }
  const customRunMode = () => ($('#custom-run-mode input:checked') || {}).value || 'once';
  function syncCustomRunMode() {
    const auto = customRunMode() === 'autopilot';
    $('#custom-autopilot').hidden = !auto;
    $('#btn-custom-run').textContent = auto ? 'Start autopilot' : 'Convene meeting';
    $('#custom-instruction').placeholder = auto
      ? 'Optional: the point to debate, e.g. Is a 2027 launch realistic without a local bridging study?'
      : 'e.g. Assume the dossier includes a 12-month ICH stability package. Re-state your timeline and cost only.';
  }

  // ---------------- reports ----------------
  const KIND_LABEL = { interim: 'Interim report', final: 'Final report' };
  const DEPTH_LABEL_SHORT = { brief: 'Brief', standard: 'Standard', full: 'Full' };

  // Decision output tab. The recommendation is not a Report (those are
  // separately generated documents in the reports table) and not Minutes (one
  // per meeting) — it's the moderator's single decision message. It lives here
  // rather than as a transcript filter chip because the pinned banner above the
  // transcript already shows it in full on the main screen.
  function renderDecisionTab() {
    const box = $('#decision-output');
    const text = state.session.decision_text;
    if (!text) {
      box.innerHTML = '<div class="empty">No decision output yet. It is written after Converge, or whenever you ask the moderator for one.</div>';
      return;
    }
    box.innerHTML = `<div class="decision-tab-actions"><h3>Decision output</h3><span class="decision-tab-tools"><button type="button" class="btn btn-sm" id="btn-decision-view">View</button>${itemDownloadsHtml('decision', 'latest')}<button type="button" class="btn btn-sm" id="btn-decision-tab-jump">View in transcript ↓</button></span></div>`;
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.replaceChildren(renderMarkdown(text));
    box.appendChild(body);
    $('#btn-decision-tab-jump').addEventListener('click', jumpToDecision);
    $('#btn-decision-view').addEventListener('click', () => openItemModal('decision', 'latest', { title: 'Decision output', markdown: text }));
  }

  function jumpToDecision() {
    const m = [...state.session.messages].reverse().find((x) => x.mode === 'decision');
    if (!m) return;
    // The transcript is hidden while this tab's page is showing.
    showSessionPane('transcript');
    $(`#msg-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Favourites tab. Was a transcript filter chip; as a tab you can read the
  // starred responses while the transcript stays where you left it.
  function renderFavourites() {
    const list = (state.session.messages || []).filter((m) => m.favourite && m.role !== 'system');
    $('#count-favourites').textContent = list.length;
    const box = $('#tab-favourites');
    if (!list.length) {
      box.innerHTML = '<div class="empty">No favourites yet. Star a response with the ☆ in its header and it will be collected here.</div>';
      return;
    }
    box.innerHTML = list.map((m) => {
      const speaker = m.role === 'user' ? 'user' : m.speaker;
      const snippet = (m.text || '').replace(/\s+/g, ' ').slice(0, 220);
      return `
        <div class="fav-card" data-id="${m.id}">
          <div class="fav-card-head">
            <span class="fav-card-who fav-card-who-${escapeHtml(speaker)}">${escapeHtml(AGENT_LABEL[speaker] || speaker)}</span>
            <span class="fav-card-mode">${escapeHtml(MODE_LABEL[m.mode] || m.mode || '')}</span>
            <span class="spacer"></span>
            <span class="fav-card-meta">#${m.seq}</span>
          </div>
          <div class="fav-card-snippet">${escapeHtml(snippet)}${(m.text || '').length > 220 ? '…' : ''}</div>
          <div class="fav-card-actions">
            <button type="button" class="fav-open">View</button>
            ${itemDownloadsHtml('message', m.id)}
            <button type="button" class="fav-jump">View in transcript</button>
            <button type="button" class="fav-remove danger">Unfavourite</button>
          </div>
        </div>`;
    }).join('');
    for (const el of $$('.fav-card', box)) {
      const m = list.find((x) => String(x.id) === el.dataset.id);
      $('.fav-open', el).addEventListener('click', () => openMessageModal(m, m.role === 'user' ? 'user' : m.speaker));
      $('.fav-jump', el).addEventListener('click', () => {
        const target = $(`#msg-${m.id}`);
        if (!target) return toast('That response is not in the current transcript view.');
        showSessionPane('transcript');
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '2px solid var(--primary)';
        setTimeout(() => { target.style.outline = ''; }, 1500);
      });
      $('.fav-remove', el).addEventListener('click', async () => {
        try {
          const updated = await api.send('PATCH', `/api/sessions/${state.session.id}/messages/${m.id}/favourite`, { favourite: false });
          m.favourite = updated.favourite;
          const card = $(`#msg-${m.id}`);
          if (card) {
            card.classList.remove('favourited');
            const btn = $('.fav-btn', card);
            if (btn) { btn.classList.remove('on'); btn.textContent = '☆'; btn.setAttribute('aria-pressed', 'false'); btn.title = 'Favourite this response'; }
          }
          renderFavourites();
        } catch (e) { toast(`Could not update favourite: ${e.message}`); }
      });
    }
  }

  function renderReports() {
    const s = state.session;
    const reports = s.reports || [];
    $('#count-reports').textContent = reports.length;
    const box = $('#reports-list');
    if (!reports.length) { box.innerHTML = '<div class="empty">No reports yet. Generate an Interim report any time, or a Final report once Converge has run.</div>'; return; }
    box.innerHTML = '';
    for (const r of reports) {
      const el = document.createElement('div'); el.className = 'report-card';
      el.innerHTML = `
        <div class="rc-head"><span class="${r.kind === 'final' ? 'report-kind-final' : ''}">${escapeHtml(KIND_LABEL[r.kind] || r.kind)}</span> · ${escapeHtml(DEPTH_LABEL_SHORT[r.depth] || r.depth)}</div>
        <div class="rc-meta">${fmtTime(r.created_at)}${r.created_by ? ` · ${escapeHtml(r.created_by)}` : ''}${r.cost_usd ? ` · ${money(r.cost_usd)}` : ''}</div>
        <div class="rc-actions">
          <button type="button" class="rc-view">View</button>
          ${itemDownloadsHtml('report', r.id)}
          <button type="button" class="rc-email">Email…</button>
          <button type="button" class="rc-delete danger">Delete</button>
        </div>`;
      $('.rc-view', el).addEventListener('click', () => openItemModal('report', r.id, {
        title: `${KIND_LABEL[r.kind] || r.kind} · ${DEPTH_LABEL_SHORT[r.depth] || r.depth}`, markdown: r.text || '',
      }));
      $('.rc-email', el).addEventListener('click', () => {
        if (!state.config.email_configured) return toast('Email not configured: set RESEND_API_KEY and MAIL_FROM.');
        const dlg = $('#dlg-email-report');
        dlg.dataset.reportId = r.id;
        $('#email-to').value = ''; $('#email-note').value = ''; $('#email-format').value = 'pdf';
        dlg.showModal();
      });
      $('.rc-delete', el).addEventListener('click', async () => {
        if (!confirm('Delete this report? This cannot be undone.')) return;
        await api.send('DELETE', `/api/sessions/${s.id}/reports/${r.id}`);
        state.session.reports = state.session.reports.filter((x) => x.id !== r.id);
        renderReports();
      });
      box.appendChild(el);
    }
  }

  async function generateReport(kind, depth) {
    if (state.running) { toast('A turn is already running'); return; }
    setRunning(true);
    try {
      const r = await fetch(`/api/sessions/${state.session.id}/turn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker: 'moderator', mode: 'report', kind, depth }),
      });
      await signInAgainIf401(r);
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || r.statusText); }
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; let done = false; let failed = null; let payload = null;
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
          if (name === 'done') { payload = data; done = true; }
          else if (name === 'error') { failed = data.message; done = true; }
        }
      }
      if (failed) throw new Error(failed);
      state.session.reports = [payload.report, ...(state.session.reports || [])];
      if (payload.message) {
        state.session.messages.push(payload.message);
        state.session.decision_text = payload.message.text;
        $('.empty', $('#transcript'))?.remove();
        $('#transcript').appendChild(messageElement(payload.message));
        renderDecisionTab();
      }
      renderReports();
      showSessionPane('decision');
      toast(`${KIND_LABEL[kind]} generated.`);
    } catch (e) { toast(`Could not generate report: ${e.message}`); } finally { setRunning(false); loadSessions(); renderCost(); }
  }

  // ---------------- events ----------------
  async function init() {
    $$('[data-icon]').forEach((el) => { el.outerHTML = icon(el.dataset.icon); });
    state.config = await api.get('/api/config');
    applyAgentRoster(state.config);
    renderFilterChips();
    buildForm($('#setup-form'), { saveDefault: true });
    buildForm($('#session-inputs-form'), { saveDefault: false });
    // failed: the check could not run, which is not the same as no sign-in
    // being configured (renderKnowledge treats only the latter as admin).
    const me = await api.get('/api/me').catch(() => ({ authenticated: false, failed: true }));
    state.me = me;
    // Model picker, run-time stopwatch and $/£ cost meter are operational
    // detail an admin cares about — for anyone here to read a launch
    // recommendation they're pure header noise. Dev-bypass (me.authenticated
    // false, no auth configured at all) is treated as admin, same as every
    // server-side admin gate in this app (auth.js noAuthConfigured()).
    document.body.classList.toggle('non-admin', Boolean(me.authenticated) && !me.is_admin);
    renderPowerNav();
    // Only a missing API key is worth the sidebar's space: the default model is
    // shown on the New Evaluation form's picker instead. Hidden when empty so a
    // bare bordered strip isn't left behind.
    const footLines = [
      state.config.has_api_key ? '' : '<strong style="color:#B91C1C">No API key: add it to .env and restart</strong>',
    ].filter(Boolean);
    $('#sidebar-foot').innerHTML = footLines.join('<br>');
    $('#sidebar-foot').hidden = !footLines.length;
    await loadSessions();
    // Deep link from a meeting-minutes email (?session=<id>); otherwise land on
    // the dashboard rather than silently reopening whatever session was last used.
    const params = new URLSearchParams(location.search);
    // Compare as strings: sessions.id is bigserial, which node-pg returns as "123".
    const linkedId = params.get('session');
    if (linkedId && state.sessions.some((s) => String(s.id) === linkedId)) {
      await openSession(linkedId);
      if (params.get('approved')) toast(`Meeting approved: ${MODE_LABEL[params.get('approved')] || params.get('approved')}`);
    } else {
      showDashboard();
    }

    const setSidebarCollapsed = (collapsed) => {
      $('.app').classList.toggle('sidebar-collapsed', collapsed);
      $('#btn-sidebar-expand').hidden = !collapsed;
    };
    $('#btn-sidebar-collapse').addEventListener('click', () => setSidebarCollapsed(true));
    $('#btn-sidebar-expand').addEventListener('click', () => setSidebarCollapsed(false));

    $('#btn-new').addEventListener('click', showSetup);
    $('#btn-all-evals').addEventListener('click', showEvaluations);
    $('#evals-filter').addEventListener('input', (e) => { state.evalsFilter = e.target.value; renderEvaluations(); });
    // A row opens its evaluation from anywhere on it; the title is the real
    // button, so keyboard users get Enter on the row as well.
    $('#evals-table').addEventListener('click', (e) => {
      const row = e.target.closest('[data-open]');
      if (row) openSession(Number(row.dataset.open));
    });
    $('#evals-table').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'TR') return;
      openSession(Number(e.target.dataset.open));
    });
    // Same head component, same behaviour; this one starts open because the
    // meeting buttons are the main reason the sidebar exists during a session.
    $('#btn-toggle-process').addEventListener('click', () => {
      const head = $('#btn-toggle-process');
      const open = $('#process-body').hidden;
      $('#process-body').hidden = !open;
      head.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    $('#btn-load-korea').addEventListener('click', async () => {
      const defaults = await api.get('/api/defaults');
      fillForm($('#setup-form'), defaults, { clear: true });
      toast('Default values restored. Remaining fields stay INPUT MISSING unless you fill them.');
    });
    $('#btn-copy-last').addEventListener('click', async () => { const last = await api.get('/api/sessions/last-inputs'); if (!Object.keys(last).length) return toast('No previous session'); fillForm($('#setup-form'), last, { clear: true }); });

    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!state.config.has_api_key) return toast('No API key set. Add OPENROUTER_API_KEY to .env and restart the server.', 5000);
      const form = e.target;
      if (!form.reportValidity()) return; // native tooltip on the first missing required field
      const inputs = readForm(form);
      if (!(inputs.product || '').trim() || !(inputs.country || '').trim()) return toast('PRODUCT and COUNTRY are required to start a session.');
      const model = $('#setup-model').value;
      let created;
      try {
        created = await api.send('POST', '/api/sessions', { inputs, model });
      } catch (err) { return toast(`Could not start the session: ${err.message}`, 5000); }
      await openSession(created.id);
      await runRound1Parallel();
    });

    $('#session-inputs-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const inputs = readForm($('#session-inputs-form'));
      try {
        state.session = await api.send('PATCH', `/api/sessions/${state.session.id}`, { inputs });
        renderSession();
        toast('Inputs saved. Applies to turns run from now on.');
      } catch (err) { toast(`Could not save inputs: ${err.message}`); }
    });

    $$('#toolbar [data-round]').forEach((b) => b.addEventListener('click', () => startMeeting(b.dataset.round)));
    $('#btn-resume-meeting').addEventListener('click', resumeStalledMeeting);
    $('#btn-stop').addEventListener('click', () => { state.stopRequested = true; $('#btn-stop').textContent = 'Stopping after this turn…'; });

    // Reports, generated from the Decision tab.
    function openReportDialog(kind) {
      const dlg = $('#dlg-report');
      dlg.dataset.kind = kind;
      $('#report-modal-title').textContent = KIND_LABEL[kind];
      const hasRound3 = state.session.messages.some((m) => m.mode === 'round3' && !m.error);
      $('#report-modal-warning').hidden = !(kind === 'final' && !hasRound3);
      $('#report-depth').value = 1;
      $('#report-depth-label').textContent = DEPTH_LABELS[1];
      dlg.showModal();
    }
    $('#btn-report-interim').addEventListener('click', () => openReportDialog('interim'));
    $('#btn-report-final').addEventListener('click', () => openReportDialog('final'));
    $('#report-depth').addEventListener('input', (e) => { $('#report-depth-label').textContent = DEPTH_LABELS[Number(e.target.value)]; });
    $('#dlg-report form').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'generate') {
        const kind = $('#dlg-report').dataset.kind;
        const depth = DEPTH_VALUES[Number($('#report-depth').value)];
        setTimeout(() => generateReport(kind, depth), 0);
      }
    });

    // Autopilot settings, inside the Custom meeting dialog
    $$('#custom-run-mode input').forEach((r) => r.addEventListener('change', syncCustomRunMode));
    $('#autopilot-length').addEventListener('input', (e) => { $('#autopilot-length-label').textContent = LENGTH_LABELS[Number(e.target.value)]; });
    $('#autopilot-interactions').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      $('#autopilot-interactions-label').textContent = v > 20 ? '∞ (until unanimous)' : String(v);
    });
    $$('#custom-agents input').forEach((c) => c.addEventListener('change', () => {
      autopilotStanceRows($('#autopilot-stances'), $$('#custom-agents input:checked').map((x) => x.value));
    }));
    $('#btn-custom').addEventListener('click', () => openCustomMeetingDialog({ scope: 'discussion' }));
    $('#dlg-custom form').addEventListener('submit', (e) => {
      if (!(e.submitter && e.submitter.value === 'run')) return;
      const dlg = $('#dlg-custom');
      const instruction = $('#custom-instruction').value.trim();
      const agents = $$('#custom-agents input:checked').map((c) => c.value);
      if (!agents.length) { e.preventDefault(); return toast('Pick at least one agent'); }
      if (customRunMode() === 'once') {
        if (!instruction) { e.preventDefault(); return toast('Write an agenda item first'); }
        setTimeout(() => runSequence(agents.map((a) => ({ speaker: a, mode: 'custom', instruction }))), 0);
        return;
      }
      const interactionsRaw = Number($('#autopilot-interactions').value);
      const stances = {};
      $$('.stance-slider', $('#autopilot-stances')).forEach((sl) => { stances[sl.dataset.agent] = Number(sl.value) + 1; });
      const settings = {
        scope: dlg.dataset.scope, disagreement_n: dlg.dataset.disagreementN ? Number(dlg.dataset.disagreementN) : null,
        agents, max_chars: LENGTH_VALUES[Number($('#autopilot-length').value)],
        interactions: interactionsRaw > 20 ? 'inf' : interactionsRaw,
        stopOnUnanimous: $('#autopilot-stop-unanimous').checked,
        autoResolve: $('#autopilot-auto-resolve').checked,
        stances, instruction,
      };
      setTimeout(() => runAutopilot(settings), 0);
    });

    // Agent Questions: discuss to resolution
    $('#qd-loops').addEventListener('input', (e) => { $('#qd-loops-label').textContent = e.target.value; });
    $('#qd-length').addEventListener('input', (e) => { $('#qd-length-label').textContent = LENGTH_LABELS[Number(e.target.value)]; });
    $('#dlg-question-discuss form').addEventListener('submit', (e) => {
      if (!(e.submitter && e.submitter.value === 'start')) return;
      const dlg = $('#dlg-question-discuss');
      const qRow = (state.session.questions || []).find((x) => String(x.id) === dlg.dataset.qid);
      if (!qRow) return;
      if (state.running) { e.preventDefault(); return toast('Wait for the current turn to finish.'); }
      const settings = {
        scope: 'question', question_id: String(qRow.id), asker: qRow.asker,
        agents: [...questionAgentAddressees(qRow), qRow.asker],
        max_chars: LENGTH_VALUES[Number($('#qd-length').value)],
        interactions: Number($('#qd-loops').value),
        stopOnUnanimous: false, autoResolve: false, stances: {},
      };
      setTimeout(() => runAutopilot(settings), 0);
    });

    // Email report
    $('#dlg-email-report form').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'send') {
        e.preventDefault();
        const dlg = $('#dlg-email-report');
        const to = $('#email-to').value.split(',').map((x) => x.trim()).filter(Boolean);
        if (!to.length) return toast('Add at least one recipient');
        const format = $('#email-format').value;
        const note = $('#email-note').value.trim();
        (async () => {
          try {
            await api.send('POST', `/api/sessions/${state.session.id}/reports/${dlg.dataset.reportId}/email`, { to, format, note });
            toast(`Sent to ${to.join(', ')}.`);
            dlg.close();
          } catch (err) { toast(`Could not send: ${err.message}`); }
        })();
      }
    });

    $$('#filter-chips .chip').forEach((c) => c.addEventListener('click', () => { state.filterSpeaker = c.dataset.speaker; applyFilter(); }));

    $('#cost-meter').addEventListener('click', () => openUsageModal());

    $('#dlg-disagreement form').addEventListener('submit', (e) => {
      const n = $('#dlg-disagreement').dataset.n;
      const d = state.session.disagreements.find((x) => String(x.n) === n);
      if (e.submitter && e.submitter.value === 'discuss') {
        const picks = $$('#dlg-disagreement .agent-picks input:checked').map((c) => c.value);
        if (!picks.length) { e.preventDefault(); return toast('Pick at least one agent'); }
        const note = $('#dis-modal-instruction').value.trim();
        const instruction = `The moderator wants to discuss ⚠ DISAGREEMENT #${d.n} — ${d.topic} (see the full transcript above for both positions).${note ? ` ${note}` : ' State your current position and whether anything changes it.'}`;
        // disagreement_n only classifies the cost as disagreement resolution.
        setTimeout(() => runSequence(picks.map((a) => ({ speaker: a, mode: 'custom', instruction, disagreement_n: d.n }))), 0);
      } else if (e.submitter && e.submitter.value === 'autopilot') {
        setTimeout(() => openCustomMeetingDialog({ scope: 'disagreement', disagreementN: d.n, disagreementTopic: d.topic }), 0);
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
    $('#session-model').addEventListener('change', async (e) => {
      const model = e.target.value;
      const id = state.session.id;
      // Hold the meeting controls until the switch is saved: a meeting started
      // mid-save could run its first turn on the old model, and the re-render
      // below would wipe its streaming cards.
      setRunning(true);
      try {
        state.session = await api.send('PATCH', `/api/sessions/${id}`, { model });
        toast(`Model switched to ${modelLabelShort(model)}. Turns from here on use it.`);
      } catch (err) {
        toast(`Could not switch model: ${err.message}`);
        // Show what the server holds rather than assuming the switch did not land.
        try { state.session = await api.get(`/api/sessions/${id}`); } catch { /* keep what we had */ }
      } finally {
        setRunning(false);
        // Not renderSession(): that refills the Inputs form, which sits right
        // below this picker, and would throw away edits not yet saved.
        renderTranscript(); renderSessionModelSelect(); renderMeetingNav(); renderIntelligence();
      }
    });
    $('#btn-delete').addEventListener('click', async () => {
      if (!confirm(`Delete "${state.session.title}"? This cannot be undone.`)) return;
      try {
        await api.send('DELETE', `/api/sessions/${state.session.id}`);
        showSetup(); await loadSessions();
      } catch (err) { toast(`Could not delete session: ${err.message}`); }
    });

    // Intelligence page navigation in the sidebar.
    $$('#intel-nav [data-pane]').forEach((b) => b.addEventListener('click', () => showSessionPane(b.dataset.pane)));
    $('#intel-page-select').addEventListener('change', (e) => showSessionPane(e.target.value));
    $('#btn-toggle-intel').addEventListener('click', () => {
      const head = $('#btn-toggle-intel');
      const open = $('#intel-nav-body').hidden;
      $('#intel-nav-body').hidden = !open;
      head.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // A link into the transcript (#msg-…) from the Intelligence page, or from a
    // dialog opened on it, has to bring the transcript back before the browser
    // scrolls to the target. Click handlers run before that default action.
    document.addEventListener('click', (e) => {
      if (state.warRoomOpen && e.target.closest('a[href^="#msg-"]')) showSessionPane('transcript');
    });

    // Left slide-over for the guide / agent profiles / admin pages. The pages
    // themselves are unchanged and still work as standalone URLs (the ↗ in the
    // panel head opens one); here they're framed so the session stays behind.
    function setNavPanel(page, title) {
      const panel = $('#nav-panel');
      if (!page) {
        state.navPanel = null;
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
        // Drop the frame so an admin edit isn't left half-typed behind a
        // closed panel, and so the next open shows fresh server state.
        $('#nav-frame').removeAttribute('src');
        syncPowerNav();
        return;
      }
      const url = `/${page}.html`;
      state.navPanel = page;
      $('#nav-panel-title').textContent = title;
      $('#nav-open-full').href = url;
      $('#nav-frame').src = url;
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
      syncPowerNav();
    }
    // Delegated from the document: [data-nav] is on the header power buttons,
    // which are rendered after load.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nav]');
      if (!btn) return;
      setNavPanel(btn.dataset.nav === state.navPanel ? null : btn.dataset.nav, btn.dataset.navTitle);
    });
    $('#btn-nav-close').addEventListener('click', () => setNavPanel(null));
    // The onboarding callout is only useful until you know the flow, so a
    // dismissal sticks. localStorage rather than the server: it is a per-person,
    // per-browser preference, not session state worth a column.
    const PROCESS_HIDDEN = 'lwg.hideProcess';
    const setProcessHidden = (hidden) => {
      $('#process-callout').hidden = hidden;
      try { localStorage.setItem(PROCESS_HIDDEN, hidden ? '1' : '0'); } catch { /* private mode: it just reappears next load */ }
    };
    try { if (localStorage.getItem(PROCESS_HIDDEN) === '1') $('#process-callout').hidden = true; } catch { /* ignore */ }
    $('#btn-close-process').addEventListener('click', () => setProcessHidden(true));
    addEventListener('beforeunload', warnIfMeetingRunning);
    // Escape pressed with focus inside the frame: the keydown never reaches
    // this document, so the framed page forwards it.
    addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data) return;
      if (e.data.type === 'nav-panel-close') setNavPanel(null);
      // The guide's restore link has already cleared the flag; bring the
      // callout back now rather than leaving it until the next load.
      if (e.data.type === 'restore-process') setProcessHidden(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (state.navPanel) setNavPanel(null);
    });

    $('#brand-home').addEventListener('click', showDashboard);
    $('#btn-logout').addEventListener('click', logout);
    // Citation clicks open the Sources tab and highlight the entry.
    $('#transcript').addEventListener('click', (e) => {
      const a = e.target.closest('a.cite');
      if (!a) return;
      showSessionPane('sources');
      const target = $(`#src-${a.dataset.src}`);
      if (target) { target.scrollIntoView({ block: 'center' }); target.style.background = 'var(--primary-soft)'; setTimeout(() => (target.style.background = ''), 1500); }
      e.preventDefault();
    });
    // Intelligence tab: disagreement rows open the Disagreements tab's detail modal
    // instead of anchor-scrolling into a hidden tab body.
    $('#tab-intelligence').addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#dis-"]');
      if (!a) return;
      e.preventDefault();
      const n = a.getAttribute('href').replace('#dis-', '');
      const d = state.session.disagreements.find((x) => String(x.n) === n);
      if (d) openDisagreementModal(d);
    });
  }

  init().catch((e) => { console.error(e); toast(`Failed to start: ${e.message}`, 8000); });
})();
