// Matrix Vault — Cloudflare Worker : API du site (le bot Discord tourne à part, voir bot/).
import {
  HttpError, checkAdmin, checkCode, checkFileLink, checkSession, completeFile, createFile, deleteFile,
  downloadFile, fileLink, listFiles, makeSession, updateFile, uploadPart,
} from './core.js';

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

  if (m === 'POST' && p === '/api/login') {
    const body = await request.json().catch(() => ({}));
    if (!(await checkCode(env, body.password))) {
      await new Promise((res) => setTimeout(res, 800)); // freine le bruteforce
      throw new HttpError(401, 'Code invalide');
    }
    return json(await makeSession(env));
  }

  // Téléchargement : session OU lien signé propre au fichier.
  if ((r = p.match(/^\/api\/files\/(\d+)\/download$/)) && m === 'GET') {
    const ok = (await checkSession(env, url.searchParams.get('t'))) || (await checkFileLink(env, r[1], url.searchParams.get('dl')));
    if (!ok) throw new HttpError(401, 'Lien expiré');
    return downloadFile(env, ctx, r[1], { inline: url.searchParams.has('inline'), rangeHeader: request.headers.get('range') });
  }

  // Tout le reste exige une session (site) ou le jeton admin (bot).
  const auth = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  const isAdmin = await checkAdmin(env, auth);
  if (!isAdmin && !(await checkSession(env, auth))) throw new HttpError(401, 'Session expirée');

  if (m === 'GET' && p === '/api/files') return json(await listFiles(env));
  if (m === 'POST' && p === '/api/files') return json(await createFile(env, await request.json().catch(() => null)));
  if ((r = p.match(/^\/api\/files\/(\d+)\/parts\/(\d+)$/)) && m === 'PUT') return json(await uploadPart(env, r[1], Number(r[2]), request));
  if ((r = p.match(/^\/api\/files\/(\d+)\/complete$/)) && m === 'POST') return json(await completeFile(env, r[1]));
  if ((r = p.match(/^\/api\/files\/(\d+)\/link$/)) && m === 'POST') return json(await fileLink(env, url.origin, r[1]));
  if ((r = p.match(/^\/api\/files\/(\d+)$/)) && m === 'PATCH') {
    if (!isAdmin) throw new HttpError(403, 'Renommer et taguer se font avec le bot Discord (/renommer, /tags)');
    return json(await updateFile(env, r[1], await request.json().catch(() => null)));
  }
  if ((r = p.match(/^\/api\/files\/(\d+)$/)) && m === 'DELETE') return json(await deleteFile(env, r[1], { draftOnly: !isAdmin }));

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
};
