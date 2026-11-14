import { CATEGORIES, HELP, SORTS, categoryOf, cleanTags, formatSize, runQuery } from './search.js';
import { DIRECTORY, TOOLS } from './osint.js';

const API = String(window.VAULT_API || '').replace(/\/+$/, '');
const WINDOW = 30 * 60; // doit matcher le Worker
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- pluie matrix ----------
const canvas = $('#rain');
const g = canvas.getContext('2d');
const glyphs = 'アカサタナハマヤラワガザダバパイキシチニヒミリギジヂビピウクスツヌフムユルグズブプエケセテネヘメレゲゼデベペオコソトノホモヨロゴゾドボポ0123456789ABCDEF<>/{}[]=+*';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let cols = [], fs = 16;
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  fs = innerWidth < 640 ? 14 : 16;
  cols = Array.from({ length: Math.ceil(innerWidth / fs) }, () => Math.random() * -innerHeight / fs);
  g.fillStyle = '#000'; g.fillRect(0, 0, innerWidth, innerHeight);
}
function frame() {
  g.fillStyle = 'rgba(0,0,0,0.08)';
  g.fillRect(0, 0, innerWidth, innerHeight);
  g.font = `${fs}px JetBrains Mono, monospace`;
  for (let i = 0; i < cols.length; i++) {
    const y = cols[i] * fs;
    g.fillStyle = Math.random() > 0.975 ? '#d8ffe0' : '#00ff41';
    g.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * fs, y);
    if (y > innerHeight && Math.random() > 0.975) cols[i] = 0;
    cols[i] += 1;
  }
}
resize();
addEventListener('resize', resize);
if (reduced) { for (let i = 0; i < 60; i++) frame(); }
else { let last = 0; const loop = (t) => { if (t - last > 50) { frame(); last = t; } requestAnimationFrame(loop); }; requestAnimationFrame(loop); }

// ---------- session ----------
const store = {
  get() { try { return JSON.parse(sessionStorage.getItem('vault') || 'null'); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem('vault', JSON.stringify(v)) : sessionStorage.removeItem('vault'); } catch {} },
};
let session = store.get();
if (session && session.exp * 1000 < Date.now()) session = null;

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { ...(typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && session) logout('Session expirée — entre le nouveau code.');
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.max(0, s % 60)).padStart(2, '0')}`;
const fmtDate = (d) => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2600);
}

setInterval(tick, 1000);
function tick() {
  const now = Math.floor(Date.now() / 1000);
  $('#rotate').textContent = fmtClock(WINDOW - (now % WINDOW));
  if (session) {
    const left = session.exp - now;
    if (left <= 0) logout('Session expirée — entre le nouveau code.');
    else $('#session-left').textContent = fmtClock(left);
  }
}

function show(which) {
  $('#login').hidden = which !== 'login';
  $('#app').hidden = which !== 'app';
  document.body.classList.toggle('in', which === 'app');
  if (which === 'login') setTimeout(() => $('#pw').focus(), 0);
}

function logout(msg) {
  session = null; store.set(null); files = [];
  $('#login-msg').textContent = msg || '';
  $('#login-msg').classList.toggle('err', !!msg);
  show('login');
}

// ---------- login ----------
$('#pw').addEventListener('input', (e) => {
  const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  e.target.value = raw.match(/.{1,4}/g)?.join('-') || '';
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const msg = $('#login-msg');
  btn.disabled = true; msg.className = 'msg'; msg.textContent = '> vérification…';
  try {
    session = await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('#pw').value }) });
    store.set(session);
    $('#pw').value = ''; msg.textContent = '';
    enter();
  } catch (err) {
    msg.className = 'msg err'; msg.textContent = `> ${err.message}`;
  } finally { btn.disabled = false; }
});

$('#resend').addEventListener('click', async () => {
  const msg = $('#login-msg');
  try { await api('/api/resend', { method: 'POST' }); msg.className = 'msg'; msg.textContent = '> code envoyé en MP par le bot.'; }
  catch (err) { msg.className = 'msg err'; msg.textContent = `> ${err.message}`; }
});

$('#logout').addEventListener('click', () => logout());

// ---------- onglets ----------
function setTab(name) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  $('#tab-files').hidden = name !== 'files';
  $('#tab-osint').hidden = name !== 'osint';
  if (name === 'osint') initOsint();
  local.set('vault.tab', name);
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// ---------- fichiers : état ----------
let files = [];
let chip = local.get('vault.chip', '');
const sortSel = $('#sort');
sortSel.innerHTML = Object.entries(SORTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
sortSel.value = SORTS[local.get('vault.sort', 'date-desc')] ? local.get('vault.sort', 'date-desc') : 'date-desc';

$('#help').innerHTML = `<dl>${HELP.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
  <p class="muted">Exemples (cliquer pour essayer) : ${['rapport type:doc after:30d sort:size-desc', 'ext:mp4|mkv size:>500mo -tag:vu', 'tag:none sort:size-desc', '/^IMG_\\d+/ date:2026']
    .map((q) => `<button class="ex link" data-q="${esc(q)}">${esc(q)}</button>`).join(' · ')}</p>`;

async function enter() {
  show('app'); tick();
  setTab(local.get('vault.tab', 'files'));
  await refresh();
}

async function refresh() {
  try { files = await api('/api/files'); render(); }
  catch (err) { if (session) $('#list').innerHTML = `<p class="empty">&gt; ${esc(err.message)}</p>`; }
}

function highlight(name, words) {
  let out = esc(name);
  for (const w of words.filter((x) => x.length > 1)) {
    const re = new RegExp(`(${esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    out = out.replace(re, '<mark>$1</mark>');
  }
  return out;
}

function render() {
  const q = $('#search').value;
  const base = runQuery(files, q, sortSel.value);
  const { results, errors, words, sorted } = chip ? runQuery(files, `${q} type:${chip}`, sortSel.value) : base;

  // compteurs par type (sur la requête courante, hors filtre de type)
  const counts = {};
  for (const f of base.results) { const c = categoryOf(f); counts[c] = (counts[c] || 0) + 1; }
  $('#chips').innerHTML = [['', 'Tout', base.results.length], ...Object.entries(CATEGORIES).map(([k, c]) => [k, c.label, counts[k] || 0])]
    .filter(([k, , n]) => !k || n || k === chip)
    .map(([k, l, n]) => `<button class="chip" data-chip="${k}" aria-pressed="${k === chip}">${l} <span>${n}</span></button>`).join('');

  const total = files.reduce((a, f) => a + f.size, 0);
  $('#stat-count').textContent = files.length;
  $('#stat-size').textContent = formatSize(total);
  const shownSize = results.reduce((a, f) => a + f.size, 0);
  $('#info').innerHTML = (errors.length ? `<span class="err">⚠ ${esc(errors.join(' · '))}</span> ` : '') +
    `${results.length} / ${files.length} fichiers · ${formatSize(shownSize)}${sorted ? ' · tri de la requête' : ''}`;

  const [sk, sd] = sortSel.value.split('-');
  for (const b of document.querySelectorAll('.thead [data-col]')) b.dataset.dir = !sorted && b.dataset.col === sk ? sd : '';

  $('#list').innerHTML = results.length
    ? results.map((f, i) => `
      <div class="row" style="animation-delay:${Math.min(i, 20) * 15}ms">
        <span class="row-name" title="${esc(f.name)}"><i class="cat">${CATEGORIES[categoryOf(f)].tag}</i>${highlight(f.name, words)}</span>
        <span class="row-tags">${(f.tags || []).map((t) => `<button class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</span>
        <span class="row-meta">${formatSize(f.size)}</span>
        <span class="row-meta date" title="${esc(new Date(f.created).toLocaleString('fr-FR'))}">${fmtDate(f.created)}</span>
        <span class="row-actions">
          <button class="icon" data-act="dl" data-id="${f.id}" title="Télécharger" aria-label="Télécharger ${esc(f.name)}">↓</button>
          <button class="icon" data-act="link" data-id="${f.id}" title="Copier un lien de partage (24 h)" aria-label="Lien de partage">⧉</button>
          <button class="icon" data-act="rename" data-id="${f.id}" title="Renommer" aria-label="Renommer">✎</button>
          <button class="icon" data-act="tags" data-id="${f.id}" title="Modifier les tags" aria-label="Tags">#</button>
          <button class="icon del" data-act="del" data-id="${f.id}" title="Supprimer" aria-label="Supprimer ${esc(f.name)}">×</button>
        </span>
      </div>`).join('')
    : `<p class="empty">&gt; ${files.length ? 'aucun résultat' : 'vault vide — dépose ton premier fichier'}</p>`;
}

// ---------- fichiers : contrôles ----------
let searchT;
$('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(render, 80); });
sortSel.addEventListener('change', () => { local.set('vault.sort', sortSel.value); render(); });
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chip]'); if (!b) return;
  chip = b.dataset.chip === chip ? '' : b.dataset.chip; local.set('vault.chip', chip); render();
});
document.querySelectorAll('.thead [data-col]').forEach((b) => b.addEventListener('click', () => {
  const col = b.dataset.col;
  const [k, d] = sortSel.value.split('-');
  const def = col === 'name' ? 'asc' : 'desc';
  sortSel.value = `${col}-${k === col ? (d === 'asc' ? 'desc' : 'asc') : def}`;
  local.set('vault.sort', sortSel.value); render();
}));
$('#help-btn').addEventListener('click', () => {
  const h = $('#help'); h.hidden = !h.hidden; $('#help-btn').setAttribute('aria-expanded', String(!h.hidden));
});
$('#help').addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]'); if (!b) return;
  $('#search').value = b.dataset.q; render();
});
addEventListener('keydown', (e) => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('#tab-files').hidden && session) { e.preventDefault(); $('#search').focus(); }
  if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; render(); }
});

$('#list').addEventListener('click', async (e) => {
  const tag = e.target.closest('[data-tag]');
  if (tag) { $('#search').value = `tag:${tag.dataset.tag}`; render(); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const f = files.find((x) => String(x.id) === b.dataset.id);
  if (!f) return;
  try {
    switch (b.dataset.act) {
      case 'dl': {
        const a = document.createElement('a');
        a.href = `${API}/api/files/${f.id}/download?t=${encodeURIComponent(session.token)}`;
        a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
        break;
      }
      case 'link': {
        const { url } = await api(`/api/files/${f.id}/link`, { method: 'POST' });
        await navigator.clipboard.writeText(url).then(() => toast('Lien copié — valable 24 h'), () => prompt('Lien (24 h) :', url));
        break;
      }
      case 'rename': {
        const name = prompt('Nouveau nom :', f.name);
        if (!name || name === f.name) return;
        Object.assign(f, await api(`/api/files/${f.id}`, { method: 'PATCH', body: JSON.stringify({ name }) }));
        render(); toast('Renommé');
        break;
      }
      case 'tags': {
        const input = prompt('Tags (séparés par des virgules) :', (f.tags || []).join(', '));
        if (input === null) return;
        Object.assign(f, await api(`/api/files/${f.id}`, { method: 'PATCH', body: JSON.stringify({ tags: cleanTags(input) }) }));
        render(); toast('Tags mis à jour');
        break;
      }
      case 'del': {
        if (!confirm(`Supprimer définitivement « ${f.name} » ?`)) return;
        b.disabled = true;
        await api(`/api/files/${f.id}`, { method: 'DELETE' });
        files = files.filter((x) => x !== f); render(); toast('Supprimé');
        break;
      }
    }
  } catch (err) { toast(err.message); b.disabled = false; }
});

// ---------- upload ----------
const drop = $('#drop');
const input = $('#file-input');
$('#upload-tags').value = local.get('vault.uploadTags', '');
$('#upload-tags').addEventListener('change', (e) => local.set('vault.uploadTags', e.target.value));
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
input.addEventListener('change', () => { enqueue([...input.files]); input.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); enqueue([...e.dataTransfer.files]); });
addEventListener('beforeunload', (e) => { if (active) e.preventDefault(); });

let active = 0;
const queue = [];
function enqueue(list) {
  const tags = cleanTags($('#upload-tags').value);
  for (const file of list) {
    const el = document.createElement('div');
    el.className = 'job';
    el.innerHTML = `<div class="job-top"><span class="job-name">${esc(file.name)}</span><span class="job-pct">en attente</span></div><div class="job-bar"><i></i></div>`;
    $('#queue').appendChild(el);
    queue.push({ file, el, tags });
  }
  pump();
}

function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    upload(job).finally(() => { active--; pump(); });
  }
}

async function upload({ file, el, tags }) {
  const pct = el.querySelector('.job-pct');
  const bar = el.querySelector('.job-bar i');
  const set = (done) => { const p = Math.floor((done / file.size) * 100); pct.textContent = `${p}% · ${formatSize(done)} / ${formatSize(file.size)}`; bar.style.width = `${p}%`; };
  let id;
  try {
    const meta = await api('/api/files', { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, type: file.type, tags }) });
    id = meta.id;
    for (let i = 0; i < meta.parts; i++) {
      const blob = file.slice(i * meta.chunkSize, (i + 1) * meta.chunkSize);
      const base = i * meta.chunkSize;
      for (let attempt = 1; ; attempt++) {
        try { await putPart(id, i, blob, (n) => set(base + n)); break; }
        catch (err) { if (attempt >= 3 || !session) throw err; await new Promise((r) => setTimeout(r, 1500 * attempt)); }
      }
    }
    pct.textContent = 'finalisation…';
    await api(`/api/files/${id}/complete`, { method: 'POST' });
    set(file.size); pct.textContent = 'stocké ✓';
    setTimeout(() => el.remove(), 2500);
    refresh();
  } catch (err) {
    el.classList.add('err'); pct.textContent = err.message;
    if (id && session) api(`/api/files/${id}`, { method: 'DELETE' }).catch(() => {});
    el.addEventListener('click', () => el.remove(), { once: true });
    el.title = 'Cliquer pour fermer';
  }
}

function putPart(id, i, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API}/api/files/${id}/parts/${i}`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.token}`);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status === 401) { logout('Session expirée — entre le nouveau code.'); return reject(new Error('Session expirée')); }
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Erreur ${xhr.status}`; try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Réseau coupé'));
    xhr.send(blob);
  });
}

// ---------- OSINT ----------
let osintReady = false;
function initOsint() {
  if (osintReady) return;
  osintReady = true;

  $('#tools').innerHTML = TOOLS.map((t) => `
    <form class="tool" data-tool="${t.id}">
      <h3>${esc(t.title)}</h3>
      <p class="muted">${esc(t.desc)}</p>
      <div class="tool-inputs">${t.inputs.map((inp) => {
        if (inp.type === 'select') return `<select name="${inp.name}">${inp.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
        if (inp.type === 'textarea') return `<textarea name="${inp.name}" rows="3" placeholder="${esc(inp.placeholder)}" spellcheck="false"></textarea>`;
        if (inp.type === 'file') return `<input type="file" name="${inp.name}" ${inp.accept ? `accept="${inp.accept}"` : ''}>`;
        return `<input name="${inp.name}" placeholder="${esc(inp.placeholder)}" spellcheck="false" autocomplete="off">`;
      }).join('')}</div>
      <button class="btn small">[ lancer ]</button>
      <div class="out" aria-live="polite"></div>
    </form>`).join('');

  $('#tools').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const tool = TOOLS.find((t) => t.id === form.dataset.tool);
    const out = form.querySelector('.out');
    const vals = {};
    for (const inp of tool.inputs) {
      const el = form.elements[inp.name];
      vals[inp.name] = inp.type === 'file' ? el.files[0] : el.value.trim();
    }
    if (tool.inputs.length === 1 && !vals[tool.inputs[0].name]) return;
    out.innerHTML = '<p class="muted blink">&gt; requête en cours…</p>';
    try { out.innerHTML = await tool.run(vals); }
    catch (err) { out.innerHTML = `<p class="err">&gt; ${esc(err.message)}</p>`; }
  });

  const total = DIRECTORY.reduce((a, [, l]) => a + l.length, 0);
  $('#dir-count').textContent = `(${total} outils)`;
  const renderDir = () => {
    const q = $('#dir-search').value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const match = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q);
    $('#directory').innerHTML = DIRECTORY.map(([cat, list]) => {
      const items = list.filter(([n, u, d]) => !q || match(`${cat} ${n} ${d} ${u}`));
      if (!items.length) return '';
      return `<section class="dir-cat"><h3>${esc(cat)} <span>${items.length}</span></h3><ul>${items.map(([n, u, d]) => `
        <li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer"><b>${esc(n)}</b><span>${esc(d)}</span><i>${esc(new URL(u).host.replace(/^www\./, ''))}</i></a></li>`).join('')}</ul></section>`;
    }).join('') || '<p class="empty">&gt; aucun outil</p>';
  };
  $('#dir-search').addEventListener('input', renderDir);
  renderDir();
}

// ---------- démarrage ----------
tick();
if (session) enter(); else show('login');
