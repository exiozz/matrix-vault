// Cœur du vault : codes tournants, sessions, liens signés, stockage GitHub Releases.
import { cleanTags } from '../../docs/search.js';

const WINDOW = 30 * 60;                    // durée de vie d'un code (s) — doit matcher bot/lib.js et docs/app.js
const GRACE = 120;                         // l'ancien code reste valide 2 min après la rotation
const SESSION_TTL = 60 * 60;               // durée d'une session (s)
const LINK_TTL = 24 * 60 * 60;             // durée d'un lien de téléchargement signé (s)
const CHUNK = 95 * 1024 * 1024;            // < 100 Mo (limite de body Cloudflare free)
const MAX_PARTS = 22;                      // 2 sous-requêtes par morceau au download, limite free = 50
const MAX_SIZE = CHUNK * MAX_PARTS;        // ≈ 2 Go par fichier
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symboles, sans 0/O/1/I

const te = new TextEncoder();

export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(msg)));
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const windowAt = (sec) => Math.floor(sec / WINDOW);

// ---------- codes tournants (le bot génère les mêmes, voir bot/lib.js) ----------

async function codeFor(env, w) {
  const h = await hmac(env.SEED, 'pw:' + w);
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[h[i] & 31];
  return s;
}

export async function checkCode(env, input) {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const t = nowSec();
  const windows = [windowAt(t)];
  if (t % WINDOW < GRACE) windows.push(windowAt(t) - 1);
  let ok = false;
  for (const w of windows) ok = safeEqual(clean, await codeFor(env, w)) || ok;
  return ok;
}

// ---------- jetons signés ----------

async function sign(env, scope, ttl) {
  const exp = nowSec() + ttl;
  return { token: `${exp}.${b64url(await hmac(env.SEED, `${scope}:${exp}`))}`, exp };
}

async function verify(env, scope, token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < nowSec()) return false;
  return safeEqual(sig, b64url(await hmac(env.SEED, `${scope}:${exp}`)));
}

export const makeSession = (env) => sign(env, 's', SESSION_TTL);
export const checkSession = (env, token) => verify(env, 's', token);

/** Lien de téléchargement d'un seul fichier, valable LINK_TTL, sans session. */
export async function fileLink(env, origin, id) {
  const { token, exp } = await sign(env, `dl:${id}`, LINK_TTL);
  return { url: `${origin}/api/files/${id}/download?dl=${token}`, exp };
}
export const checkFileLink = (env, id, token) => verify(env, `dl:${id}`, token);

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
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, { ...init, headers: ghHeaders(env, init.headers) });
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `GitHub ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

function parseMeta(release) {
  try {
    const m = JSON.parse(release.body || '{}');
    if (typeof m.size === 'number' && typeof m.parts === 'number') return { tags: [], ...m };
  } catch {}
  throw new HttpError(404, 'Release sans métadonnées vault');
}

const partName = (i) => `part-${String(i).padStart(3, '0')}`;
const partSize = (meta, i) => (i < meta.parts - 1 ? CHUNK : meta.size - CHUNK * (meta.parts - 1));
const toFile = (r, m) => ({ id: r.id, name: m.name, size: m.size, type: m.type, tags: m.tags, created: r.published_at || r.created_at });

export async function listFiles(env) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const rels = await gh(env, `/releases?per_page=100&page=${page}`);
    for (const r of rels) {
      if (r.draft) continue;
      try { out.push(toFile(r, parseMeta(r))); } catch {}
    }
    if (rels.length < 100) break;
  }
  return out;
}

export async function createFile(env, body) {
  const name = String(body?.name || '').trim().slice(0, 255);
  const size = Number(body?.size);
  const type = String(body?.type || 'application/octet-stream').slice(0, 200);
  const tags = cleanTags(body?.tags);
  if (!name) throw new HttpError(400, 'Nom manquant');
  if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, 'Fichier vide ou taille invalide');
  if (size > MAX_SIZE) throw new HttpError(413, `Fichier trop gros (max ${Math.floor((MAX_SIZE / 1024 ** 3) * 10) / 10} Go)`);
  const parts = Math.ceil(size / CHUNK);
  const tag = `f-${Date.now().toString(36)}-${b64url(crypto.getRandomValues(new Uint8Array(4)))}`;
  const rel = await gh(env, '/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name, body: JSON.stringify({ name, size, type, parts, tags }), draft: true }),
  });
  return { id: rel.id, parts, chunkSize: CHUNK };
}

export async function uploadPart(env, id, i, request) {
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

export async function completeFile(env, id) {
  const rel = await gh(env, `/releases/${id}`);
  const meta = parseMeta(rel);
  for (let i = 0; i < meta.parts; i++) {
    const a = rel.assets.find((x) => x.name === partName(i));
    if (!a || a.state !== 'uploaded' || a.size !== partSize(meta, i)) throw new HttpError(409, `Morceau ${i} manquant ou incomplet`);
  }
  await gh(env, `/releases/${id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) });
  return { ok: true };
}

/** Renommer et/ou changer les tags. */
export async function updateFile(env, id, body) {
  const rel = await gh(env, `/releases/${id}`);
  const meta = parseMeta(rel);
  if (body?.name !== undefined) {
    const name = String(body.name).trim().slice(0, 255);
    if (!name) throw new HttpError(400, 'Nom vide');
    meta.name = name;
  }
  if (body?.tags !== undefined) meta.tags = cleanTags(body.tags);
  const out = await gh(env, `/releases/${id}`, { method: 'PATCH', body: JSON.stringify({ name: meta.name, body: JSON.stringify(meta) }) });
  return toFile(out, meta);
}

export async function deleteFile(env, id) {
  const rel = await gh(env, `/releases/${id}`);
  parseMeta(rel); // ne supprime que des releases créées par le vault
  await gh(env, `/releases/${id}`, { method: 'DELETE' });
  if (!rel.draft) await gh(env, `/git/refs/tags/${encodeURIComponent(rel.tag_name)}`, { method: 'DELETE' }).catch(() => {});
  return { ok: true };
}

export async function downloadFile(env, ctx, id) {
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
        // L'URL signée de GitHub ne doit pas recevoir le token.
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
