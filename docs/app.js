import { CATEGORIES, HELP, SORTS, categoryOf, cleanTags, extOf, formatSize, runQuery } from './search.js';
import { DIRECTORY, TOOLS } from './osint.js';

const API = String(window.VAULT_API || '').replace(/\/+$/, '');
const WINDOW = 30 * 60; // doit matcher le Worker
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ---------- pluie matrix réactive ----------
// Souris : les colonnes proches accélèrent et s'illuminent. Clic : onde de glyphes.
// Frappe / upload : regain d'énergie de toute la pluie. Désactivé si « réduire les animations ».
const canvas = $('#rain');
const g = canvas.getContext('2d');
const glyphs = 'アカサタナハマヤラワガザダバパイキシチニヒミリギジヂビピウクスツヌフムユルグズブプエケセテネヘメレゲゼデベペオコソトノホモヨロゴゾドボポ0123456789ABCDEF<>/{}[]=+*';
const glyph = () => glyphs[(Math.random() * glyphs.length) | 0];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rain = { cols: [], fs: 16, mouse: { x: -1e4, y: -1e4 }, ripples: [], energy: 0, floor: 0 };
const RADIUS = 140;

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  rain.fs = innerWidth < 640 ? 14 : 16;
  rain.cols = Array.from({ length: Math.ceil(innerWidth / rain.fs) }, () => Math.random() * -innerHeight / rain.fs);
  g.fillStyle = '#000'; g.fillRect(0, 0, innerWidth, innerHeight);
}

function frame() {
  const { fs, cols, mouse } = rain;
  g.fillStyle = 'rgba(0,0,0,0.08)';
  g.fillRect(0, 0, innerWidth, innerHeight);
  g.font = `${fs}px JetBrains Mono, monospace`;
  const speed = 1 + Math.max(rain.energy, rain.floor);
  for (let i = 0; i < cols.length; i++) {
    const x = i * fs, y = cols[i] * fs;
    const near = Math.max(0, 1 - Math.hypot(x - mouse.x, y - mouse.y) / RADIUS);
    const colNear = Math.max(0, 1 - Math.abs(x - mouse.x) / RADIUS);
    g.fillStyle = near > 0.15 || Math.random() > 0.975 ? '#e8ffee' : '#00ff41';
    g.fillText(glyph(), x, y);
    if (y > innerHeight && Math.random() > 0.975) cols[i] = 0;
    cols[i] += speed + colNear * 1.5;
  }
  // halo de glyphes qui grésillent autour du curseur
  if (mouse.x > -1e3) {
    for (let k = 0; k < 6; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * RADIUS * 0.6;
      g.fillStyle = `rgba(0,255,65,${0.35 + Math.random() * 0.5})`;
      g.fillText(glyph(), mouse.x + Math.cos(a) * r, mouse.y + Math.sin(a) * r);
    }
  }
  // ondes de clic
  rain.ripples = rain.ripples.filter((rp) => rp.r < rp.max);
  for (const rp of rain.ripples) {
    rp.r += 16;
    const alpha = 1 - rp.r / rp.max;
    const n = Math.floor((2 * Math.PI * rp.r) / (fs * 1.6));
    g.fillStyle = `rgba(200,255,215,${alpha})`;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      g.fillText(glyph(), rp.x + Math.cos(a) * rp.r, rp.y + Math.sin(a) * rp.r);
    }
  }
  rain.energy *= 0.94;
}

function pulse(x, y) {
  if (reduced) return;
  rain.ripples.push({ x, y, r: 0, max: Math.max(innerWidth, innerHeight) * 0.6 });
  // relance les colonnes touchées depuis le point de clic
  const c = Math.round(x / rain.fs);
  for (let i = c - 3; i <= c + 3; i++) if (rain.cols[i] !== undefined) rain.cols[i] = y / rain.fs;
}
const kick = (n = 0.6) => { rain.energy = Math.min(rain.energy + n, 4); };

resize();
addEventListener('resize', resize);
if (reduced) { for (let i = 0; i < 60; i++) frame(); }
else {
  addEventListener('pointermove', (e) => { rain.mouse.x = e.clientX; rain.mouse.y = e.clientY; }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { rain.mouse.x = rain.mouse.y = -1e4; });
  addEventListener('pointerdown', (e) => pulse(e.clientX, e.clientY), { passive: true });
  addEventListener('keydown', () => kick(0.35));
  let last = 0;
  const loop = (t) => { if (t - last > 40) { frame(); last = t; } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

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
  // l'aperçu est dans la « top layer » : le toast doit être dedans pour rester visible
  const host = document.querySelector('#preview[open]') || document.body;
  if (t.parentElement !== host) host.appendChild(t);
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
// Filtres en clair, traduits en requête pour le moteur de recherche (même syntaxe que le bot).
const SIZE_F = [['<10mo', '< 10 Mo'], ['10mo..100mo', '10 – 100 Mo'], ['100mo..1go', '100 Mo – 1 Go'], ['>1go', '> 1 Go']];
const DATE_F = [['date:today', "aujourd'hui"], ['after:7d', '7 jours'], ['after:30d', '30 jours'], ['after:1y', '12 mois'], ['before:1y', "+ d'un an"]];
const f = { type: '', size: '', date: '', tags: [], ...local.get('vault.filters', {}) };
const saveFilters = () => local.set('vault.filters', f);

const sortSel = $('#sort');
sortSel.innerHTML = Object.entries(SORTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
sortSel.value = SORTS[local.get('vault.sort', 'date-desc')] ? local.get('vault.sort', 'date-desc') : 'date-desc';

$('#help').innerHTML = `<p>Tu peux taper ces filtres directement dans la barre de recherche, en plus des boutons :</p>
  <dl>${HELP.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
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

/** Requête complète : texte tapé + filtres cliqués, sauf `skip` (pour compter les résultats de chaque bouton). */
function query(skip) {
  const parts = [$('#search').value];
  if (f.type && skip !== 'type') parts.push(`type:${f.type}`);
  if (f.size && skip !== 'size') parts.push(`size:${f.size}`);
  if (f.date && skip !== 'date') parts.push(f.date);
  if (f.tags.length && skip !== 'tags') parts.push(`tag:${f.tags.join('|')}`);
  return parts.join(' ');
}
const count = (q) => runQuery(files, q).results.length;

function chips(el, items, isOn, key) {
  el.innerHTML = items.map(([v, label, n]) =>
    `<button class="chip" data-f="${key}" data-v="${esc(v)}" aria-pressed="${isOn(v)}"${!n && !isOn(v) ? ' data-empty' : ''}>${esc(label)} <span>${n}</span></button>`).join('');
}

function render() {
  const { results, errors, words, sorted } = runQuery(files, query(), sortSel.value);
  pvList = results;

  // boutons de filtre avec le nombre de résultats qu'ils donneraient
  const byType = {};
  for (const x of runQuery(files, query('type')).results) { const c = categoryOf(x); byType[c] = (byType[c] || 0) + 1; }
  chips($('#f-type'), Object.entries(CATEGORIES).filter(([k]) => byType[k] || f.type === k).map(([k, c]) => [k, c.label, byType[k] || 0]), (v) => f.type === v, 'type');
  const noSize = query('size'), noDate = query('date');
  chips($('#f-size'), SIZE_F.map(([v, l]) => [v, l, count(`${noSize} size:${v}`)]), (v) => f.size === v, 'size');
  chips($('#f-date'), DATE_F.map(([v, l]) => [v, l, count(`${noDate} ${v}`)]), (v) => f.date === v, 'date');
  const tagCount = {};
  for (const x of files) for (const t of x.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
  const tags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a] || a.localeCompare(b)).slice(0, 24);
  for (const t of f.tags) if (!tags.includes(t)) tags.push(t);
  $('#g-tags').hidden = !tags.length;
  const noTags = query('tags');
  chips($('#f-tags'), tags.map((t) => [t, `#${t}`, count(`${noTags} tag:${t}`)]), (v) => f.tags.includes(v), 'tags');

  const total = files.reduce((a, x) => a + x.size, 0);
  $('#stat-count').textContent = files.length;
  $('#stat-size').textContent = formatSize(total);
  const shownSize = results.reduce((a, x) => a + x.size, 0);
  const active = $('#search').value.trim() || f.type || f.size || f.date || f.tags.length;
  $('#reset').hidden = !active;
  $('#info').innerHTML = (errors.length ? `<span class="err">⚠ ${esc(errors.join(' · '))}</span> ` : '') +
    `<b>${results.length}</b> fichier${results.length > 1 ? 's' : ''} sur ${files.length} · ${formatSize(shownSize)}${sorted ? ' · tri tapé dans la recherche' : ''}`;

  const [sk, sd] = sortSel.value.split('-');
  for (const b of document.querySelectorAll('.thead [data-col]')) b.dataset.dir = !sorted && b.dataset.col === sk ? sd : '';

  $('#list').innerHTML = results.length
    ? results.map((x, i) => `
      <div class="row" style="animation-delay:${Math.min(i, 20) * 15}ms">
        <button class="row-name" data-act="open" data-id="${x.id}" title="Aperçu de ${esc(x.name)}"><i class="cat">${CATEGORIES[categoryOf(x)].tag}</i>${highlight(x.name, words)}</button>
        <span class="row-tags">${(x.tags || []).map((t) => `<button class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</span>
        <span class="row-meta">${formatSize(x.size)}</span>
        <span class="row-meta date" title="${esc(new Date(x.created).toLocaleString('fr-FR'))}">${fmtDate(x.created)}</span>
        <button class="row-id" data-act="id" data-id="${x.id}" title="Copier l'ID (pour /remove dans Discord)">${x.id}</button>
        <span class="row-actions">
          <button class="icon" data-act="dl" data-id="${x.id}" title="Télécharger" aria-label="Télécharger ${esc(x.name)}">↓</button>
          <button class="icon" data-act="link" data-id="${x.id}" title="Copier un lien de partage (24 h)" aria-label="Lien de partage">⧉</button>
        </span>
      </div>`).join('')
    : `<p class="empty">&gt; ${files.length ? 'aucun fichier ne correspond — essaie « tout effacer »' : 'vault vide — dépose ton premier fichier'}</p>`;
}

// ---------- fichiers : contrôles ----------
let searchT;
$('#search').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(render, 80); });
sortSel.addEventListener('change', () => { local.set('vault.sort', sortSel.value); render(); });
document.querySelector('.filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]'); if (!b) return;
  const { f: key, v } = b.dataset;
  if (key === 'tags') f.tags = f.tags.includes(v) ? f.tags.filter((t) => t !== v) : [...f.tags, v];
  else f[key] = f[key] === v ? '' : v;
  saveFilters(); render();
});
$('#reset').addEventListener('click', () => {
  $('#search').value = ''; Object.assign(f, { type: '', size: '', date: '', tags: [] }); saveFilters(); render();
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
  if (tag) { if (!f.tags.includes(tag.dataset.tag)) f.tags = [...f.tags, tag.dataset.tag]; saveFilters(); render(); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const x = files.find((y) => String(y.id) === b.dataset.id);
  if (!x) return;
  try {
    switch (b.dataset.act) {
      case 'id':
        await navigator.clipboard.writeText(String(x.id)).then(() => toast(`ID copié — dans Discord : /renommer, /tags ou /remove`), () => prompt('ID :', x.id));
        break;
      case 'open': openPreview(x.id); break;
      case 'dl': download(x); break;
      case 'link': await copyLink(x); break;
    }
  } catch (err) { toast(err.message); }
});

const fileUrl = (x, inline) => `${API}/api/files/${x.id}/download?${inline ? 'inline&' : ''}t=${encodeURIComponent(session.token)}`;
function download(x) {
  const a = document.createElement('a');
  a.href = fileUrl(x, false); a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
async function copyLink(x) {
  const { url } = await api(`/api/files/${x.id}/link`, { method: 'POST' });
  await navigator.clipboard.writeText(url).then(() => toast('Lien copié — valable 24 h'), () => prompt('Lien (24 h) :', url));
}

// ---------- aperçu ----------
const PREVIEW = {
  image: 'png jpg jpeg gif webp avif bmp svg ico',
  video: 'mp4 m4v webm mov mkv ogv',
  audio: 'mp3 wav flac aac ogg opus m4a',
  pdf: 'pdf',
  text: 'txt md csv tsv json jsonl ndjson xml yaml yml log ini toml sql js mjs ts jsx tsx py java c cpp h hpp cs go rs rb php html css scss sh ps1 bat lua kt swift dart r tex srt vtt',
};
const TEXT_LIMIT = 256 * 1024;
function previewKind(x) {
  const e = extOf(x.name);
  for (const [k, list] of Object.entries(PREVIEW)) if (list.split(' ').includes(e)) return k;
  return (x.type || '').startsWith('text/') ? 'text' : null;
}

const pv = $('#preview');
let pvId = null;
let pvList = []; // résultats affichés, pour ← / →

function pvMeta(x) {
  $('#pv-title').textContent = x.name;
  $('#pv-meta').innerHTML = `<span>${esc(CATEGORIES[categoryOf(x)].label)}</span><span>${formatSize(x.size)}</span>
    <span>${esc(new Date(x.created).toLocaleString('fr-FR'))}</span>
    <button class="row-id" data-pv-id="${x.id}" title="Copier l'ID">ID ${x.id}</button>
    ${(x.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}`;
  const i = pvList.findIndex((y) => y.id === x.id);
  $('#pv-prev').disabled = i <= 0;
  $('#pv-next').disabled = i < 0 || i >= pvList.length - 1;
}

async function openPreview(id) {
  const x = files.find((y) => y.id === id);
  if (!x) return;
  pvId = id;
  pvMeta(x);
  const body = $('#pv-body');
  const url = fileUrl(x, true);
  const kind = previewKind(x);
  const fallback = (msg) => `<div class="pv-none"><p>${msg}</p><button class="btn" data-pv-dl>[ télécharger ]</button></div>`;
  if (kind === 'image') body.innerHTML = `<img src="${esc(url)}" alt="${esc(x.name)}">`;
  else if (kind === 'video') body.innerHTML = `<video src="${esc(url)}" controls autoplay playsinline preload="metadata"></video>`;
  else if (kind === 'audio') body.innerHTML = `<audio src="${esc(url)}" controls autoplay></audio>`;
  else if (kind === 'pdf') body.innerHTML = `<iframe src="${esc(url)}" title="${esc(x.name)}"></iframe>`;
  else if (kind === 'text') {
    body.innerHTML = '<p class="muted blink">&gt; chargement…</p>';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Erreur ${res.status}`);
      const reader = res.body.getReader();
      const chunks = []; let n = 0;
      while (n < TEXT_LIMIT) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
      reader.cancel().catch(() => {});
      const text = new TextDecoder().decode(new Uint8Array(await new Blob(chunks).arrayBuffer()).slice(0, TEXT_LIMIT));
      if (pvId !== id) return;
      body.innerHTML = `<pre>${esc(text)}</pre>${x.size > TEXT_LIMIT ? `<p class="muted">Aperçu limité aux ${formatSize(TEXT_LIMIT)} premiers — télécharge pour voir tout.</p>` : ''}`;
    } catch (err) { if (pvId === id) body.innerHTML = fallback(`Aperçu impossible : ${esc(err.message)}`); }
  } else body.innerHTML = fallback('Pas d\'aperçu pour ce type de fichier.');
  // vidéo/audio dans un format que le navigateur ne lit pas (ex : certains .mkv)
  body.querySelector('video, audio')?.addEventListener('error', () => { if (pvId === id) body.innerHTML = fallback('Ton navigateur ne sait pas lire ce format.'); });
  if (!pv.open) pv.showModal();
}

function closePreview() { pvId = null; $('#pv-body').innerHTML = ''; if (pv.open) pv.close(); }
const step = (d) => { const i = pvList.findIndex((y) => y.id === pvId); const n = pvList[i + d]; if (n) openPreview(n.id); };

$('#pv-close').addEventListener('click', closePreview);
// Échap : coupe vidéo/audio. Ignoré si l'aperçu a été rouvert entre-temps (l'événement arrive en différé).
pv.addEventListener('close', () => { if (!pv.open) { pvId = null; $('#pv-body').innerHTML = ''; } });
pv.addEventListener('click', (e) => { if (e.target === pv) closePreview(); }); // clic sur le fond
$('#pv-prev').addEventListener('click', () => step(-1));
$('#pv-next').addEventListener('click', () => step(1));
pv.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|VIDEO|AUDIO/.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
$('#pv-dl').addEventListener('click', () => { const x = files.find((y) => y.id === pvId); if (x) download(x); });
$('#pv-link').addEventListener('click', () => { const x = files.find((y) => y.id === pvId); if (x) copyLink(x).catch((err) => toast(err.message)); });
pv.addEventListener('click', (e) => {
  if (e.target.closest('[data-pv-dl]')) $('#pv-dl').click();
  const idb = e.target.closest('[data-pv-id]');
  if (idb) navigator.clipboard.writeText(idb.dataset.pvId).then(() => toast('ID copié'), () => {});
});

// ---------- mise à jour en direct ----------
// Le site relit la liste toutes les 5 s (onglet visible) : un /remove, /renommer ou /tags du bot apparaît tout seul.
const POLL_MS = 5000;
async function poll() {
  if (!session || document.hidden || $('#app').hidden) return;
  try {
    const next = await api('/api/files');
    $('#live').classList.remove('off');
    if (JSON.stringify(next) === JSON.stringify(files)) return;
    const before = new Map(files.map((y) => [y.id, y])), after = new Map(next.map((y) => [y.id, y]));
    const added = next.filter((y) => !before.has(y.id)).length;
    const removed = files.filter((y) => !after.has(y.id)).length;
    const changed = next.filter((y) => before.has(y.id) && JSON.stringify(before.get(y.id)) !== JSON.stringify(y)).length;
    files = next;
    render();
    const msg = [added && `${added} ajouté${added > 1 ? 's' : ''}`, removed && `${removed} supprimé${removed > 1 ? 's' : ''}`, changed && `${changed} modifié${changed > 1 ? 's' : ''}`].filter(Boolean).join(' · ');
    if (msg) toast(`Mis à jour : ${msg}`);
    const r = $('#live').getBoundingClientRect(); pulse(r.left + r.width / 2, r.top + r.height / 2);
    if (pvId !== null) {
      const x = after.get(pvId);
      if (!x) { closePreview(); toast('Ce fichier vient d\'être supprimé'); } else pvMeta(x);
    }
  } catch { $('#live').classList.add('off'); }
}
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

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
    rain.floor = 0.9; // la pluie accélère tant qu'un envoi est en cours
    upload(job).finally(() => { active--; if (!active) rain.floor = 0; pump(); });
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
    const r = drop.getBoundingClientRect();
    pulse(r.left + r.width / 2, r.top + r.height / 2); kick(1.5);
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
