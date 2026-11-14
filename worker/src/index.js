// Matrix Vault — Cloudflare Worker : API du site + bot Discord + rotation du code (cron).
import {
  HttpError, checkCode, checkFileLink, checkSession, completeFile, createFile, deleteFile,
  downloadFile, fileLink, listFiles, makeSession, nowSec, updateFile, uploadPart,
} from './core.js';
import { handleInteraction, sendCodeDM, verifyInteraction } from './discord.js';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
  let r;

  if (m === 'POST' && p === '/discord') {
    const i = await verifyInteraction(request, env);
    if (!i) return new Response('Signature invalide', { status: 401 });
    return handleInteraction(i, env, ctx, url.origin);
  }

  if (m === 'POST' && p === '/api/login') {
    const body = await request.json().catch(() => ({}));
    if (!(await checkCode(env, body.password))) {
      await new Promise((res) => setTimeout(res, 800)); // freine le bruteforce
      throw new HttpError(401, 'Code invalide');
    }
    return json(await makeSession(env));
  }

  if (m === 'POST' && p === '/api/resend') {
    // Anti-spam : au plus un envoi par minute (cache du datacenter).
    const key = new Request(`https://vault.internal/resend/${Math.floor(Date.now() / 60000)}`);
    if (await caches.default.match(key)) throw new HttpError(429, 'Patiente une minute');
    await caches.default.put(key, new Response('1', { headers: { 'Cache-Control': 'max-age=60' } }));
    await sendCodeDM(env, nowSec());
    return json({ ok: true });
  }

  // Téléchargement : session OU lien signé propre au fichier.
  if ((r = p.match(/^\/api\/files\/(\d+)\/download$/)) && m === 'GET') {
    const ok = (await checkSession(env, url.searchParams.get('t'))) || (await checkFileLink(env, r[1], url.searchParams.get('dl')));
    if (!ok) throw new HttpError(401, 'Lien expiré');
    return downloadFile(env, ctx, r[1]);
  }

  // Tout le reste exige une session.
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!(await checkSession(env, auth))) throw new HttpError(401, 'Session expirée');

  if (m === 'GET' && p === '/api/files') return json(await listFiles(env));
  if (m === 'POST' && p === '/api/files') return json(await createFile(env, await request.json().catch(() => null)));
  if ((r = p.match(/^\/api\/files\/(\d+)\/parts\/(\d+)$/)) && m === 'PUT') return json(await uploadPart(env, r[1], Number(r[2]), request));
  if ((r = p.match(/^\/api\/files\/(\d+)\/complete$/)) && m === 'POST') return json(await completeFile(env, r[1]));
  if ((r = p.match(/^\/api\/files\/(\d+)\/link$/)) && m === 'POST') return json(await fileLink(env, url.origin, r[1]));
  if ((r = p.match(/^\/api\/files\/(\d+)$/)) && m === 'PATCH') return json(await updateFile(env, r[1], await request.json().catch(() => null)));
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
      res = json({ error: e instanceof HttpError ? e.message : 'Erreur serveur' }, status);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(env))) out.headers.set(k, v);
    return out;
  },

  async scheduled(event, env, ctx) {
    // Le cron tourne juste après la rotation : on envoie le code de la nouvelle fenêtre.
    ctx.waitUntil(sendCodeDM(env, Math.floor(event.scheduledTime / 1000) + 5));
  },
};
