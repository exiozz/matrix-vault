// Bot Discord (interactions HTTP, pas de gateway) : recherche dans le vault + envoi du code en MP.
import { CATEGORIES, HELP, SORTS, categoryOf, formatSize, runQuery } from '../../docs/search.js';
import { currentCode, fileLink, listFiles } from './core.js';

const API = 'https://discord.com/api/v10';
const GREEN = 0x00ff41;
const PER_PAGE = 10;
const EPHEMERAL = 64;

const owners = (env) => String(env.OWNER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

function hexBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Vérifie la signature Ed25519 envoyée par Discord. Renvoie le body parsé ou null. */
export async function verifyInteraction(request, env) {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  if (!sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return null;
  const key = await crypto.subtle.importKey('raw', hexBytes(env.DISCORD_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, hexBytes(sig), new TextEncoder().encode(ts + body));
  return ok ? JSON.parse(body) : null;
}

async function bot(env, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (matrix-vault, 1)' },
    body: init.body && JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// ---------- code en MP ----------

const CODE_TITLE = '🟩 Code d\'accès VAULT_';

async function codeEmbed(env, sec) {
  const { code, until } = await currentCode(env, sec);
  return {
    title: CODE_TITLE,
    description: `\`\`\`\n${code}\n\`\`\`\nValide jusqu'à <t:${until}:t> (<t:${until}:R>)`,
    color: GREEN,
  };
}

/** MP le code courant à chaque propriétaire, en supprimant les anciens codes envoyés. */
export async function sendCodeDM(env, sec) {
  const embed = await codeEmbed(env, sec);
  const components = env.SITE_URL ? [{ type: 1, components: [{ type: 2, style: 5, label: 'Ouvrir le vault', url: env.SITE_URL }] }] : [];
  for (const uid of owners(env)) {
    const ch = await bot(env, '/users/@me/channels', { method: 'POST', body: { recipient_id: uid } });
    const old = await bot(env, `/channels/${ch.id}/messages?limit=20`).catch(() => []);
    for (const m of old) {
      if (m.author?.id === env.DISCORD_APP_ID && m.embeds?.[0]?.title === CODE_TITLE) {
        await bot(env, `/channels/${ch.id}/messages/${m.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    await bot(env, `/channels/${ch.id}/messages`, { method: 'POST', body: { embeds: [embed], components } });
  }
}

// ---------- recherche ----------

const escMd = (s) => String(s).replace(/([\\[\]()*_~`|>])/g, '\\$1');
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const QUERY_RE = /^```\n([\s\S]*?)\n```/;

function setToken(query, key, value) {
  const rest = query.replace(new RegExp(`(^|\\s)-?${key}:\\S+`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
  return value ? `${rest} ${key}:${value}`.trim() : rest;
}

async function resultsMessage(env, origin, query, page) {
  const files = await listFiles(env);
  const { results, errors } = runQuery(files, query);
  const pages = Math.max(1, Math.ceil(results.length / PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = results.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const lines = await Promise.all(slice.map(async (f, i) => {
    const { url } = await fileLink(env, origin, f.id);
    const ts = Math.floor(Date.parse(f.created) / 1000);
    const tags = (f.tags || []).length ? ' · ' + f.tags.map((t) => `#${t}`).join(' ') : '';
    return `\`${String(page * PER_PAGE + i + 1).padStart(2)}\` \`${CATEGORIES[categoryOf(f)].tag}\` [${escMd(short(f.name, 60))}](${url})\n      ${formatSize(f.size)} · <t:${ts}:d>${escMd(tags)}`;
  }));

  const sortTok = (/(?:^|\s)sort:(\S+)/i.exec(query) || [])[1] || 'date-desc';
  const typeTok = (/(?:^|\s)type:(\S+)/i.exec(query) || [])[1] || '';
  const total = results.reduce((a, f) => a + f.size, 0);

  let desc = `\`\`\`\n${query || ' '}\n\`\`\`\n`;
  if (errors.length) desc += `⚠️ ${errors.join(' · ')}\n\n`;
  desc += lines.length ? lines.join('\n') : '_Aucun résultat._';

  const btn = (id, label, disabled) => ({ type: 2, style: 2, custom_id: id, label, disabled });
  return {
    embeds: [{
      title: `${results.length} fichier${results.length > 1 ? 's' : ''} · ${formatSize(total)}`,
      description: desc.slice(0, 4096),
      color: GREEN,
      footer: { text: `page ${page + 1}/${pages} · liens valables 24 h · /aide pour la syntaxe` },
    }],
    components: [
      { type: 1, components: [
        btn('pg:first:0', '⏮', page === 0),
        btn(`pg:prev:${page - 1}`, '◀', page === 0),
        btn('pg:info', `${page + 1} / ${pages}`, true),
        btn(`pg:next:${page + 1}`, '▶', page >= pages - 1),
        btn(`pg:last:${pages - 1}`, '⏭', page >= pages - 1),
      ] },
      { type: 1, components: [{
        type: 3, custom_id: 'sort', placeholder: 'Trier…',
        options: Object.entries(SORTS).map(([v, label]) => ({ label, value: v, default: v === sortTok })),
      }] },
      { type: 1, components: [{
        type: 3, custom_id: 'type', placeholder: 'Filtrer par type…',
        options: [{ label: 'Tous les types', value: 'all', default: !typeTok }, ...Object.entries(CATEGORIES).map(([v, c]) => ({ label: c.label, value: v, default: v === typeTok }))],
      }] },
    ],
  };
}

async function statsMessage(env) {
  const files = await listFiles(env);
  const total = files.reduce((a, f) => a + f.size, 0);
  const byCat = {};
  for (const f of files) { const c = categoryOf(f); (byCat[c] ||= { n: 0, s: 0 }); byCat[c].n++; byCat[c].s += f.size; }
  const tagCount = {};
  for (const f of files) for (const t of f.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const biggest = [...files].sort((a, b) => b.size - a.size).slice(0, 5);
  const latest = [...files].sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, 5);
  const list = (arr, fn) => arr.map(fn).join('\n') || '—';
  return {
    embeds: [{
      title: `VAULT_ · ${files.length} fichiers · ${formatSize(total)}`,
      color: GREEN,
      fields: [
        { name: 'Par type', value: list(Object.entries(byCat).sort((a, b) => b[1].s - a[1].s), ([c, v]) => `\`${CATEGORIES[c].tag}\` ${CATEGORIES[c].label} — ${v.n} · ${formatSize(v.s)}`) },
        { name: 'Plus lourds', value: list(biggest, (f) => `${escMd(short(f.name, 50))} — ${formatSize(f.size)}`), inline: true },
        { name: 'Derniers ajouts', value: list(latest, (f) => `${escMd(short(f.name, 50))} — <t:${Math.floor(Date.parse(f.created) / 1000)}:R>`), inline: true },
        { name: 'Tags', value: topTags.map(([t, n]) => `#${escMd(t)} (${n})`).join(' · ') || '—' },
      ],
    }],
  };
}

function helpMessage() {
  return {
    embeds: [{
      title: 'Syntaxe de recherche',
      color: GREEN,
      description: HELP.map(([k, v]) => `\`${k}\` ${v}`).join('\n') +
        '\n\n**Exemples**\n`rapport type:doc after:30d sort:size-desc`\n`ext:mp4|mkv size:>500mo -tag:vu`\n`/^IMG_\\d+/ date:2026-07 sort:name`',
    }],
  };
}

// ---------- interactions ----------

async function editOriginal(i, data) {
  await fetch(`${API}/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
}

const reply = (data, type = 4) => new Response(
  JSON.stringify(data ? { type, data: { flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...data } } : { type }),
  { headers: { 'Content-Type': 'application/json' } },
);

/** Réponse différée : Discord exige une réponse en < 3 s, GitHub peut être plus lent. */
function deferred(ctx, i, work, type) {
  ctx.waitUntil(work().then((d) => editOriginal(i, d), (e) => editOriginal(i, { content: `⚠️ ${e.message}`.slice(0, 1900), embeds: [], components: [] })));
  return reply(type === 6 ? null : {}, type);
}

export async function handleInteraction(i, env, ctx, origin) {
  if (i.type === 1) return reply(null, 1); // PING

  const uid = i.member?.user?.id || i.user?.id;
  if (!owners(env).includes(uid)) return reply({ content: '⛔ Accès refusé.' });

  if (i.type === 2) {
    const opt = Object.fromEntries((i.data.options || []).map((o) => [o.name, o.value]));
    switch (i.data.name) {
      case 'recherche': {
        let q = String(opt.requete || '').trim();
        if (opt.type) q = setToken(q, 'type', opt.type);
        if (opt.tri) q = setToken(q, 'sort', opt.tri);
        return deferred(ctx, i, () => resultsMessage(env, origin, q, (opt.page || 1) - 1), 5);
      }
      case 'stats': return deferred(ctx, i, () => statsMessage(env), 5);
      case 'code': {
        const { code, until } = await currentCode(env);
        return reply({ content: `\`\`\`\n${code}\n\`\`\`Valide jusqu'à <t:${until}:t> (<t:${until}:R>)` });
      }
      case 'aide': return reply(helpMessage());
    }
  }

  if (i.type === 3) {
    const query = (QUERY_RE.exec(i.message?.embeds?.[0]?.description || '') || [])[1]?.trim() || '';
    const id = i.data.custom_id;
    if (id.startsWith('pg:')) return deferred(ctx, i, () => resultsMessage(env, origin, query, Number(id.split(':')[2]) || 0), 6);
    if (id === 'sort') return deferred(ctx, i, () => resultsMessage(env, origin, setToken(query, 'sort', i.data.values[0]), 0), 6);
    if (id === 'type') return deferred(ctx, i, () => resultsMessage(env, origin, setToken(query, 'type', i.data.values[0] === 'all' ? '' : i.data.values[0]), 0), 6);
  }

  return reply({ content: 'Commande inconnue.' });
}
