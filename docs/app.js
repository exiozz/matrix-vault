(() => {
  const API = String(window.VAULT_API || '').replace(/\/+$/, '');
  const WINDOW = 30 * 60; // doit matcher le Worker
  const $ = (s) => document.querySelector(s);

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
      const ch = glyphs[(Math.random() * glyphs.length) | 0];
      g.fillStyle = Math.random() > 0.975 ? '#d8ffe0' : '#00ff41';
      g.fillText(ch, i * fs, y);
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
      headers: { ...(opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...opts.headers },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && session) { logout('Session expirée — entre le nouveau code.'); }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  const fmtSize = (n) => { const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`; };
  const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.max(0, s % 60)).padStart(2, '0')}`;
  const fmtDate = (d) => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });

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
    $('#vault').hidden = which !== 'vault';
    document.body.classList.toggle('in', which === 'vault');
    if (which === 'login') setTimeout(() => $('#pw').focus(), 0);
  }

  function logout(msg) {
    session = null; store.set(null);
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
    try { await api('/api/resend', { method: 'POST' }); msg.className = 'msg'; msg.textContent = '> code envoyé sur Discord.'; }
    catch (err) { msg.className = 'msg err'; msg.textContent = `> ${err.message}`; }
  });

  $('#logout').addEventListener('click', () => logout());

  // ---------- fichiers ----------
  let files = [];

  async function enter() {
    show('vault'); tick();
    await refresh();
  }

  async function refresh() {
    try { files = await api('/api/files'); render(); }
    catch (err) { if (session) $('#list').innerHTML = `<p class="empty">&gt; ${esc(err.message)}</p>`; }
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    const q = $('#search').value.trim().toLowerCase();
    const shown = files.filter((f) => f.name.toLowerCase().includes(q));
    $('#stat-count').textContent = files.length;
    $('#stat-size').textContent = fmtSize(files.reduce((a, f) => a + f.size, 0));
    $('#list').innerHTML = shown.length
      ? shown.map((f, i) => `
        <div class="row" style="animation-delay:${Math.min(i, 20) * 20}ms">
          <span class="row-name" title="${esc(f.name)}">${esc(f.name)}</span>
          <span class="row-meta">${fmtSize(f.size)}</span>
          <span class="row-meta date">${fmtDate(f.created)}</span>
          <span class="row-actions">
            <button class="icon" data-dl="${f.id}" aria-label="Télécharger ${esc(f.name)}" title="Télécharger">↓</button>
            <button class="icon del" data-del="${f.id}" aria-label="Supprimer ${esc(f.name)}" title="Supprimer">×</button>
          </span>
        </div>`).join('')
      : `<p class="empty">&gt; ${files.length ? 'aucun résultat' : 'vault vide — dépose ton premier fichier'}</p>`;
  }

  $('#search').addEventListener('input', render);

  $('#list').addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl]');
    const del = e.target.closest('[data-del]');
    if (dl) {
      const a = document.createElement('a');
      a.href = `${API}/api/files/${dl.dataset.dl}/download?t=${encodeURIComponent(session.token)}`;
      a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    }
    if (del) {
      const f = files.find((x) => String(x.id) === del.dataset.del);
      if (!f || !confirm(`Supprimer définitivement « ${f.name} » ?`)) return;
      del.disabled = true;
      try { await api(`/api/files/${f.id}`, { method: 'DELETE' }); files = files.filter((x) => x !== f); render(); }
      catch (err) { alert(err.message); del.disabled = false; }
    }
  });

  // ---------- upload ----------
  const drop = $('#drop');
  const input = $('#file-input');
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { enqueue([...input.files]); input.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); enqueue([...e.dataTransfer.files]); });
  addEventListener('beforeunload', (e) => { if (active) e.preventDefault(); });

  let active = 0;
  const queue = [];
  function enqueue(list) {
    for (const file of list) {
      const el = document.createElement('div');
      el.className = 'job';
      el.innerHTML = `<div class="job-top"><span class="job-name">${esc(file.name)}</span><span class="job-pct">en attente</span></div><div class="job-bar"><i></i></div>`;
      $('#queue').appendChild(el);
      queue.push({ file, el });
    }
    pump();
  }

  async function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      active++;
      upload(job).finally(() => { active--; pump(); });
    }
  }

  async function upload({ file, el }) {
    const pct = el.querySelector('.job-pct');
    const bar = el.querySelector('.job-bar i');
    const set = (done) => { const p = Math.floor((done / file.size) * 100); pct.textContent = `${p}% · ${fmtSize(done)} / ${fmtSize(file.size)}`; bar.style.width = `${p}%`; };
    let id;
    try {
      const meta = await api('/api/files', { method: 'POST', body: JSON.stringify({ name: file.name, size: file.size, type: file.type }) });
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

  // ---------- démarrage ----------
  tick();
  if (session) enter(); else show('login');
})();
