// Matrix Vault — Cloudflare Worker
// Rôle : vérifier le mot de passe tournant, garder le token GitHub secret,
// streamer les fichiers vers/depuis les Releases d'un repo GitHub privé,
// et poster le nouveau mot de passe sur Discord à chaque rotation (cron).

const WINDOW = 30 * 60;            // durée de vie d'un mot de passe (s) — doit matcher le cron
const GRACE = 120;                 // l'ancien mot de passe reste valide 2 min après la rotation
const SESSION_TTL = 60 * 60;       // durée d'une session après connexion (s)
const CHUNK = 95 * 1024 * 1024;    // taille d'un morceau (< 100 Mo, limite de body Cloudflare free)
const MAX_PARTS = 22;              // 2 sous-requêtes par morceau au download, limite free = 50
const MAX_SIZE = CHUNK * MAX_PARTS; // ≈ 2 Go par fichier
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symboles, sans 0/O/1/I

const te = new TextEncoder();

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(msg)));
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const windowAt = (sec) => Math.floor(sec / WINDOW);
const nowSec = () => Math.floor(Date.now() / 1000);

async function passwordFor(env, w) {
  const h = await hmac(env.SEED, 'pw:' + w);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[h[i] & 31];
  return s; // affiché XXXX-XXXX-XXXX
}

const pretty = (pw) => pw.match(/.{4}/g).join('-');

async function checkPassword(env, input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const t = nowSec();
  const candidates = [windowAt(t)];
  if (t % WINDOW < GRACE) candidates.push(windowAt(t) - 1);
  let ok = false;
  for (const w of candidates) ok = safeEqual(clean, await passwordFor(env, w)) || ok;
  return ok;
}

async function makeSession(env) {
  const exp = nowSec() + SESSION_TTL;
  return { token: `${exp}.${b64url(await hmac(env.SEED, 's:' + exp))}`, exp };
}

async function checkSession(env, token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < nowSec()) return false;
  return safeEqual(sig, b64url(await hmac(env.SEED, 's:' + exp)));
}

// ---------- GitHub ----------

function ghHeaders(env, extra = {}) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'matrix-vault',
    ...extra,
  };
}

async function gh(env, path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
    ...init,
    headers: ghHeaders(env, init.headers),
  });
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `GitHub ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function parseMeta(release) {
  try {
    const m = JSON.parse(release.body || '{}');
    if (typeof m.size === 'number' && typeof m.parts === 'number') return m;
  } catch {}
  throw new HttpError(404, 'Release sans métadonnées vault');
}

const partName = (i) => `part-${String(i).padStart(3, '0')}`;
const partSize = (meta, i) => (i < meta.parts - 1 ? CHUNK : meta.size - CHUNK * (meta.parts - 1));

async function listFiles(env) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const rels = await gh(env, `/releases?per_page=100&page=${page}`);
    for (const r of rels) {
      if (r.draft) continue;
      try {
        const m = parseMeta(r);
        out.push({ id: r.id, name: m.name, size: m.size, type: m.type, created: r.published_at || r.created_at });
      } catch {}
    }
    if (rels.length < 100) break;
  }
  return out;
}

async function createFile(env, body) {
  const name = String(body?.name || '').slice(0, 255);
  const size = Number(body?.size);
  const type = String(body?.type || 'application/octet-stream').slice(0, 200);
  if (!name) throw new HttpError(400, 'Nom manquant');
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Fichier vide ou taille invalide');
  if (size > MAX_SIZE) throw new HttpError(413, `Fichier trop gros (max ${Math.floor(MAX_SIZE / 1024 ** 3 * 10) / 10} Go)`);
  const parts = Math.ceil(size / CHUNK);
  const tag = `f-${Date.now().toString(36)}-${b64url(crypto.getRandomValues(new Uint8Array(4)))}`;
  const rel = await gh(env, '/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name, body: JSON.stringify({ name, size, type, parts }), draft: true }),
  });
  return { id: rel.id, parts, chunkSize: CHUNK };
}

async function uploadPart(env, id, i, request) {
  const rel = await gh(env, `/releases/${id}`);
  if (!rel.draft) throw new HttpError(409, 'Fichier déjà finalisé');
  const meta = parseMeta(rel);
  if (!Number.isInteger(i) || i < 0 || i >= meta.parts) throw new HttpError(400, 'Index de morceau invalide');
  const expected = partSize(meta, i);
  if (Number(request.headers.get('content-length')) !== expected) throw new HttpError(400, `Taille de morceau attendue : ${expected}`);

  // Retry : si le morceau existe déjà (upload interrompu), on le remplace.
  const existing = rel.assets.find((a) => a.name === partName(i));
  if (existing) await gh(env, `/releases/assets/${existing.id}`, { method: 'DELETE' });

  const { readable, writable } = new FixedLengthStream(expected);
  const pipe = request.body.pipeTo(writable);
  const res = await fetch(`https://uploads.github.com/repos/${env.GH_REPO}/releases/${id}/assets?name=${partName(i)}`, {
    method: 'POST',
    headers: ghHeaders(env, { 'Content-Type': 'application/octet-stream' }),
    body: readable,
  });
  await pipe.catch(() => {});
  if (!res.ok) throw new HttpError(502, `Upload GitHub ${res.status}: ${await res.text()}`);
  return { ok: true };
}

async function completeFile(env, id) {
  const rel = await gh(env, `/releases/${id}`);
  const meta = parseMeta(rel);
  for (let i = 0; i < meta.parts; i++) {
    const a = rel.assets.find((x) => x.name === partName(i));
    if (!a || a.state !== 'uploaded' || a.size !== partSize(meta, i)) throw new HttpError(409, `Morceau ${i} manquant ou incomplet`);
  }
  await gh(env, `/releases/${id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) });
  return { ok: true };
}

async function deleteFile(env, id) {
  const rel = await gh(env, `/releases/${id}`);
  parseMeta(rel); // ne supprime que des releases créées par le vault
  await gh(env, `/releases/${id}`, { method: 'DELETE' });
  if (!rel.draft) await gh(env, `/git/refs/tags/${encodeURIComponent(rel.tag_name)}`, { method: 'DELETE' }).catch(() => {});
  return { ok: true };
}

async function downloadFile(env, ctx, id) {
  const rel = await gh(env, `/releases/${id}`);
  if (rel.draft) throw new HttpError(404, 'Fichier introuvable');
  const meta = parseMeta(rel);
  const parts = [];
  for (let i = 0; i < meta.parts; i++) {
    const a = rel.assets.find((x) => x.name === partName(i));
    if (!a) throw new HttpError(500, `Morceau ${i} manquant`);
    parts.push(a);
  }

  const { readable, writable } = new FixedLengthStream(meta.size);
  ctx.waitUntil((async () => {
    try {
      for (const a of parts) {
        const r1 = await fetch(`https://api.github.com/repos/${env.GH_REPO}/releases/assets/${a.id}`, {
          headers: ghHeaders(env, { Accept: 'application/octet-stream' }),
          redirect: 'manual',
        });
        const loc = r1.headers.get('location');
        // L'URL signée ne doit pas recevoir le token GitHub.
        const r2 = loc ? await fetch(loc) : r1;
        if (!r2.ok || !r2.body) throw new Error(`Lecture du morceau ${a.name} : ${r2.status}`);
        await r2.body.pipeTo(writable, { preventClose: true });
      }
      await writable.close();
    } catch (e) {
      await writable.abort(e).catch(() => {});
    }
  })());

  return new Response(readable, {
    headers: {
      'Content-Type': meta.type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    },
  });
}

// ---------- Discord ----------

async function sendPassword(env, sec) {
  const w = windowAt(sec);
  const pw = pretty(await passwordFor(env, w));
  const until = (w + 1) * WINDOW;
  const res = await fetch(env.DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'VAULT',
      embeds: [{
        title: '🟩 Nouveau code d\'accès',
        description: `\`\`\`\n${pw}\n\`\`\`\nValide jusqu'à <t:${until}:t> (<t:${until}:R>)${env.SITE_URL ? `\n${env.SITE_URL}` : ''}`,
        color: 0x00ff41,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
}

// ---------- HTTP ----------

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const m = request.method;

  if (m === 'POST' && p === '/api/login') {
    const body = await request.json().catch(() => ({}));
    if (!(await checkPassword(env, body.password))) {
      await new Promise((r) => setTimeout(r, 800)); // freine le bruteforce
      throw new HttpError(401, 'Code invalide');
    }
    return json(await makeSession(env));
  }

  if (m === 'POST' && p === '/api/resend') {
    // Anti-spam : au plus un renvoi par minute (cache du datacenter).
    const key = new Request(`https://vault.internal/resend/${Math.floor(Date.now() / 60000)}`);
    if (await caches.default.match(key)) throw new HttpError(429, 'Patiente une minute');
    await caches.default.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=60' } }));
    await sendPassword(env, nowSec());
    return json({ ok: true });
  }

  // Tout le reste exige une session.
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer /, '') || url.searchParams.get('t');
  if (!(await checkSession(env, auth))) throw new HttpError(401, 'Session expirée');

  if (m === 'GET' && p === '/api/files') return json(await listFiles(env));
  if (m === 'POST' && p === '/api/files') return json(await createFile(env, await request.json().catch(() => null)));

  let r;
  if ((r = p.match(/^\/api\/files\/(\d+)\/parts\/(\d+)$/)) && m === 'PUT') return json(await uploadPart(env, r[1], Number(r[2]), request));
  if ((r = p.match(/^\/api\/files\/(\d+)\/complete$/)) && m === 'POST') return json(await completeFile(env, r[1]));
  if ((r = p.match(/^\/api\/files\/(\d+)\/download$/)) && m === 'GET') return downloadFile(env, ctx, r[1]);
  if ((r = p.match(/^\/api\/files\/(\d+)$/)) && m === 'DELETE') return json(await deleteFile(env, r[1]));

  throw new HttpError(404, 'Route inconnue');
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    let res;
    try {
      res = await route(request, env, ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error(e);
      res = json({ error: status >= 500 && !(e instanceof HttpError) ? 'Erreur serveur' : e.message }, status);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(env))) out.headers.set(k, v);
    return out;
  },

  async scheduled(event, env, ctx) {
    // Le cron tourne juste après la rotation : on envoie le code de la nouvelle fenêtre.
    ctx.waitUntil(sendPassword(env, Math.floor(event.scheduledTime / 1000) + 5));
  },
};
