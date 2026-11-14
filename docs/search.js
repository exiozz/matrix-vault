// Moteur de recherche/tri du site. Le bot Python en a un portage (bot/search.py) :
// toute modif de syntaxe se fait dans les deux, et bot/test_search.py vérifie qu'ils donnent les mêmes résultats.
// Un fichier = { id, name, size, type, created, tags: [] }

export const CATEGORIES = {
  image: { label: 'Images', tag: 'IMG', ext: 'jpg jpeg png gif webp bmp tif tiff svg heic heif avif ico raw cr2 nef arw dng psd' },
  video: { label: 'Vidéos', tag: 'VID', ext: 'mp4 mkv mov avi webm wmv flv m4v mpg mpeg 3gp ts' },
  audio: { label: 'Audio', tag: 'AUD', ext: 'mp3 wav flac aac ogg opus m4a wma aiff mid midi' },
  doc: { label: 'Documents', tag: 'DOC', ext: 'pdf doc docx odt rtf txt md epub pages ppt pptx odp key xls xlsx ods numbers tex' },
  data: { label: 'Données', tag: 'DAT', ext: 'csv tsv json jsonl ndjson xml yaml yml sql db sqlite sqlite3 parquet log ini toml' },
  archive: { label: 'Archives', tag: 'ZIP', ext: 'zip rar 7z tar gz tgz bz2 xz zst cab lz' },
  code: { label: 'Code', tag: 'SRC', ext: 'js mjs ts jsx tsx py java c cpp h hpp cs go rs rb php html css scss sh ps1 bat lua kt swift dart r ipynb' },
  app: { label: 'Applis', tag: 'APP', ext: 'exe msi apk ipa dmg iso img deb rpm appimage jar' },
  other: { label: 'Autres', tag: '···', ext: '' },
};

const EXT_TO_CAT = {};
for (const [k, c] of Object.entries(CATEGORIES)) for (const e of c.ext.split(' ').filter(Boolean)) EXT_TO_CAT[e] = k;

export const extOf = (name) => { const m = /\.([a-z0-9]{1,10})$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };

export function categoryOf(f) {
  const e = extOf(f.name);
  if (EXT_TO_CAT[e]) return EXT_TO_CAT[e];
  const t = (f.type || '').split('/')[0];
  if (t === 'image' || t === 'video' || t === 'audio') return t;
  if (t === 'text') return 'doc';
  return 'other';
}

export const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const SORTS = {
  'date-desc': 'Plus récents', 'date-asc': 'Plus anciens',
  'name-asc': 'Nom A→Z', 'name-desc': 'Nom Z→A',
  'size-desc': 'Plus lourds', 'size-asc': 'Plus légers',
  'type-asc': 'Type', 'ext-asc': 'Extension',
};

export const HELP = [
  ['mots libres', 'tous doivent apparaître dans le nom ou les tags (accents ignorés)'],
  ['"phrase exacte"', 'suite de mots exacte'],
  ['-mot', 'exclut (marche avec tout : -ext:tmp, -tag:vieux)'],
  ['a|b', 'OU : vacances|voyage, ext:jpg|png'],
  ['/regex/', 'expression régulière sur le nom'],
  ['type:', Object.keys(CATEGORIES).join(' | ')],
  ['ext:', 'extension — ext:pdf|docx'],
  ['tag:', 'tag:perso — tag:none = sans tag'],
  ['name:', 'texte uniquement dans le nom'],
  ['id:', 'identifiant affiché sur chaque fichier — id:445576569'],
  ['size:', '>100mb  <1go  10mb..2gb  (ko/mo/go/to acceptés)'],
  ['date:', '2026 — 2026-11 — 2026-11-14 — today — 7d'],
  ['after: / before:', '2026-01-01 ou relatif : 7d 2w 3m 1y'],
  ['sort:', 'date|name|size|type|ext + -asc/-desc, plusieurs clés : sort:type,size-desc'],
];

const UNITS = { '': 1, b: 1, o: 1, k: 1024, kb: 1024, ko: 1024, m: 1024 ** 2, mb: 1024 ** 2, mo: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, go: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, to: 1024 ** 4 };

function parseBytes(s) {
  const m = /^(\d+(?:[.,]\d+)?)\s*([a-z]*)$/i.exec(s.trim());
  if (!m || !(m[2].toLowerCase() in UNITS)) return NaN;
  return parseFloat(m[1].replace(',', '.')) * UNITS[m[2].toLowerCase()];
}

function parseSize(v) {
  const range = v.split('..');
  if (range.length === 2) {
    const a = range[0] ? parseBytes(range[0]) : 0, b = range[1] ? parseBytes(range[1]) : Infinity;
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return (s) => s >= a && s <= b;
  }
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(v);
  const n = parseBytes(m[2]);
  if (Number.isNaN(n)) return null;
  return { '>': (s) => s > n, '<': (s) => s < n, '>=': (s) => s >= n, '<=': (s) => s <= n, '=': (s) => Math.abs(s - n) < Math.max(1, n * 0.05) }[m[1] || '>='];
}

const DAY = 864e5;
function relative(v, now) {
  const m = /^(\d+)([dwmy])$/i.exec(v);
  if (!m) return null;
  return now - Number(m[1]) * { d: 1, w: 7, m: 30.44, y: 365.25 }[m[2].toLowerCase()] * DAY;
}

// Renvoie [début, fin[ en ms pour une date absolue partielle.
function period(v) {
  let m;
  if ((m = /^(\d{4})$/.exec(v))) return [Date.UTC(+m[1], 0, 1), Date.UTC(+m[1] + 1, 0, 1)];
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(v))) return [Date.UTC(+m[1], m[2] - 1, 1), Date.UTC(+m[1], +m[2], 1)];
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v))) { const s = Date.UTC(+m[1], m[2] - 1, +m[3]); return [s, s + DAY]; }
  return null;
}

function parseDate(key, v, now) {
  if (key === 'date') {
    if (v === 'today' || v === 'aujourdhui') { const d = new Date(now); const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); return (t) => t >= s; }
    const r = relative(v, now);
    if (r != null) return (t) => t >= r;
    const p = period(v);
    return p && ((t) => t >= p[0] && t < p[1]);
  }
  const r = relative(v, now);
  const p = r != null ? [r, r] : period(v);
  if (!p) return null;
  return key === 'after' ? (t) => t >= p[0] : (t) => t < p[0];
}

const KEYS = new Set(['id', 'name', 'ext', 'type', 'tag', 'size', 'date', 'after', 'before', 'sort']);
const TOKEN = /(-?)(?:([a-z]+):)?("([^"]*)"?|\/((?:\\.|[^/\\])+)\/([a-z]*)|\S+)/gi;

export function parseQuery(q) {
  const tests = [];
  const errors = [];
  let sort = null;
  const words = [];
  for (const m of String(q || '').matchAll(TOKEN)) {
    const neg = m[1] === '-';
    let key = (m[2] || '').toLowerCase();
    let raw = m[3];
    if (key && !KEYS.has(key)) { raw = `${m[2]}:${raw}`; key = ''; }
    let test = null;

    if (m[5] !== undefined) {
      try { const re = new RegExp(m[5], 'i'); test = (f) => re.test(f.name); }
      catch { errors.push(`regex invalide : /${m[5]}/`); continue; }
    } else {
      const val = m[4] !== undefined ? m[4] : raw;
      if (!val) continue;
      const alts = (m[4] !== undefined ? [val] : val.split('|')).filter(Boolean);
      const vals = alts.map(norm);
      switch (key) {
        case 'sort': {
          const parts = val.toLowerCase().split(',').map((s) => {
            const [k, d] = s.split('-');
            return ['date', 'name', 'size', 'type', 'ext'].includes(k) ? { key: k, dir: d === 'asc' ? 1 : d === 'desc' ? -1 : (k === 'date' || k === 'size') ? -1 : 1 } : null;
          });
          if (parts.some((p) => !p)) errors.push(`tri inconnu : ${val}`); else sort = parts;
          continue;
        }
        case 'id': test = (f) => vals.includes(String(f.id)); break;
        case 'ext': test = (f) => vals.includes(extOf(f.name)); break;
        case 'type': {
          const bad = vals.filter((v) => !CATEGORIES[v]);
          if (bad.length) { errors.push(`type inconnu : ${bad.join(', ')}`); continue; }
          test = (f) => vals.includes(categoryOf(f)); break;
        }
        case 'tag': test = (f) => vals.some((v) => (v === 'none' ? !(f.tags || []).length : (f.tags || []).some((t) => norm(t) === v))); break;
        case 'name': test = (f) => vals.some((v) => norm(f.name).includes(v)); break;
        case 'size': {
          const fns = alts.map(parseSize);
          if (fns.some((x) => !x)) { errors.push(`taille invalide : ${val}`); continue; }
          test = (f) => fns.some((fn) => fn(f.size)); break;
        }
        case 'date': case 'after': case 'before': {
          const now = Date.now();
          const fns = alts.map((v) => parseDate(key, v.toLowerCase(), now));
          if (fns.some((x) => !x)) { errors.push(`date invalide : ${key}:${val}`); continue; }
          test = (f) => { const t = Date.parse(f.created); return fns.some((fn) => fn(t)); }; break;
        }
        default:
          if (!neg) words.push(...vals);
          test = (f) => { const hay = norm(`${f.name} ${(f.tags || []).join(' ')}`); return vals.some((v) => hay.includes(v)); };
      }
    }
    tests.push(neg ? (f) => !test(f) : test);
  }
  return { tests, sort, errors, words };
}

const CMP = {
  date: (a, b) => Date.parse(a.created) - Date.parse(b.created),
  name: (a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }),
  size: (a, b) => a.size - b.size,
  type: (a, b) => categoryOf(a).localeCompare(categoryOf(b)),
  ext: (a, b) => extOf(a.name).localeCompare(extOf(b.name)),
};

export function sortKeys(s) {
  return String(s || 'date-desc').split(',').map((p) => { const [key, d] = p.split('-'); return { key, dir: d === 'asc' ? 1 : -1 }; });
}

// defaultSort : clé de SORTS utilisée si la requête ne contient pas de sort:
export function runQuery(files, q, defaultSort = 'date-desc') {
  const { tests, sort, errors, words } = parseQuery(q);
  const keys = [...(sort || sortKeys(defaultSort)), { key: 'date', dir: -1 }];
  const results = files.filter((f) => tests.every((t) => t(f)));
  results.sort((a, b) => { for (const k of keys) { const c = CMP[k.key](a, b) * k.dir; if (c) return c; } return 0; });
  return { results, errors, words, sorted: !!sort };
}

export function formatSize(n) {
  const u = ['o', 'Ko', 'Mo', 'Go', 'To']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
}

export function cleanTags(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/[,\s#]+/);
  return [...new Set(arr.map((t) => String(t).trim().toLowerCase().replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 32)).filter(Boolean))].slice(0, 20);
}
