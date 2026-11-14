// Logique du bot sans dépendance Discord : codes, jetons signés, appels au Worker, construction des messages.
// Les jetons sont signés avec la même SEED que le Worker (même schéma que worker/src/core.js).
import { createHmac } from 'node:crypto';
import { CATEGORIES, HELP, SORTS, categoryOf, formatSize, runQuery } from '../docs/search.js';

const WINDOW = 30 * 60;   // doit matcher worker/src/core.js
const LINK_TTL = 24 * 60 * 60;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const GREEN = 0x00ff41;
const PER_PAGE = 10;

const nowSec = () => Math.floor(Date.now() / 1000);
const hmac = (seed, msg) => createHmac('sha256', seed).update(msg);

export function currentCode(seed, sec = nowSec()) {
  const w = Math.floor(sec / WINDOW);
  const h = hmac(seed, 'pw:' + w).digest();
  let s = '';
  for (let i = 0; i < 12; i++) s += ALPHABET[h[i] & 31];
  return { code: s.match(/.{4}/g).join('-'), until: (w + 1) * WINDOW };
}

/** Millisecondes jusqu'à la prochaine rotation. */
export const msToNextRotation = () => (WINDOW - (nowSec() % WINDOW)) * 1000;

function sign(seed, scope, ttl) {
  const exp = nowSec() + ttl;
  return `${exp}.${hmac(seed, `${scope}:${exp}`).digest('base64url')}`;
}

export function fileUrl(cfg, id) {
  return `${cfg.workerUrl}/api/files/${id}/download?dl=${sign(cfg.seed, `dl:${id}`, LINK_TTL)}`;
}

export async function listFiles(cfg) {
  const res = await fetch(`${cfg.workerUrl}/api/files`, {
    headers: { Authorization: `Bearer ${sign(cfg.seed, 's', 120)}` },
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Le Worker refuse le bot : la SEED du bot est différente de celle du Worker.');
  if (!res.ok) throw new Error(data.error || `Worker ${res.status}`);
  return data;
}

// ---------- messages ----------

const escMd = (s) => String(s).replace(/([\\[\]()*_~`|>])/g, '\\$1');
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const QUERY_RE = /^```\n([\s\S]*?)\n```/;

/** Requête stockée dans l'embed d'un message de résultats (le bot reste sans état). */
export const queryFromEmbed = (description) => (QUERY_RE.exec(description || '') || [])[1]?.trim() || '';

/** Remplace (ou retire si value vide) un filtre `key:` dans la requête. */
export function setToken(query, key, value) {
  const rest = query.replace(new RegExp(`(^|\\s)-?${key}:\\S+`, 'gi'), ' ').replace(/\s+/g, ' ').trim();
  return value ? `${rest} ${key}:${value}`.trim() : rest;
}

export async function resultsMessage(cfg, query, page) {
  const { results, errors } = runQuery(await listFiles(cfg), query);
  const pages = Math.max(1, Math.ceil(results.length / PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const lines = results.slice(page * PER_PAGE, (page + 1) * PER_PAGE).map((f, i) => {
    const ts = Math.floor(Date.parse(f.created) / 1000);
    const tags = (f.tags || []).length ? ' · ' + f.tags.map((t) => `#${t}`).join(' ') : '';
    return `\`${String(page * PER_PAGE + i + 1).padStart(2)}\` \`${CATEGORIES[categoryOf(f)].tag}\` [${escMd(short(f.name, 60))}](${fileUrl(cfg, f.id)})\n      ${formatSize(f.size)} · <t:${ts}:d>${escMd(tags)}`;
  });

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

export async function statsMessage(cfg) {
  const files = await listFiles(cfg);
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

export function helpMessage() {
  return {
    embeds: [{
      title: 'Syntaxe de recherche',
      color: GREEN,
      description: HELP.map(([k, v]) => `\`${k}\` ${v}`).join('\n') +
        '\n\n**Exemples**\n`rapport type:doc after:30d sort:size-desc`\n`ext:mp4|mkv size:>500mo -tag:vu`\n`/^IMG_\\d+/ date:2026-07 sort:name`',
    }],
  };
}

export const CODE_TITLE = '🟩 Code d\'accès VAULT_';

export function codeEmbed(seed) {
  const { code, until } = currentCode(seed);
  return {
    title: CODE_TITLE,
    description: `\`\`\`\n${code}\n\`\`\`\nValide jusqu'à <t:${until}:t> (<t:${until}:R>)`,
    color: GREEN,
  };
}

export const COMMANDS = [
  {
    name: 'recherche', description: 'Chercher dans le vault (syntaxe avancée : /aide)',
    integration_types: [0, 1], contexts: [0, 1, 2],
    options: [
      { type: 3, name: 'requete', description: 'ex : rapport type:doc size:>10mo after:30d -tag:vieux', max_length: 400 },
      { type: 3, name: 'tri', description: 'Ordre des résultats', choices: Object.entries(SORTS).map(([value, name]) => ({ name, value })) },
      { type: 3, name: 'type', description: 'Type de fichier', choices: Object.entries(CATEGORIES).map(([value, c]) => ({ name: c.label, value })) },
      { type: 4, name: 'page', description: 'Page de résultats', min_value: 1 },
    ],
  },
  { name: 'stats', description: 'Statistiques du vault', integration_types: [0, 1], contexts: [0, 1, 2] },
  { name: 'code', description: 'Code d\'accès actuel du site (visible par toi seul)', integration_types: [0, 1], contexts: [0, 1, 2] },
  { name: 'aide', description: 'Syntaxe de recherche avancée', integration_types: [0, 1], contexts: [0, 1, 2] },
];
