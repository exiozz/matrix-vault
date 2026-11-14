// Onglet OSINT : outils intégrés (sources publiques uniquement) + annuaire d'outils légaux.
// Tout tourne dans le navigateur ; seules des API publiques sont appelées (DNS, RDAP, crt.sh, Wayback, ipwho.is).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (url, label) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label || url)}</a>`;
const kv = (rows) => `<dl class="kv">${rows.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const host = (s) => String(s).trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').toLowerCase();

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${new URL(url).host} a répondu ${r.status}`);
  return r.json();
}

const DNS_TYPES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, NS: 2, TXT: 16, SOA: 6, CAA: 257 };
const DNS_NAMES = Object.fromEntries(Object.entries(DNS_TYPES).map(([k, v]) => [v, k]));
async function doh(name, type) {
  const j = await getJSON(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
  return (j.Answer || []).map((a) => ({ type: DNS_NAMES[a.type] || a.type, data: a.data, ttl: a.TTL }));
}

function vcardName(entity) {
  const v = entity?.vcardArray?.[1] || [];
  return (v.find((x) => x[0] === 'fn') || [])[3] || entity?.handle;
}

function rdapSummary(j) {
  const ev = Object.fromEntries((j.events || []).map((e) => [e.eventAction, e.eventDate?.slice(0, 10)]));
  const role = (r) => (j.entities || []).filter((e) => (e.roles || []).includes(r)).map(vcardName).filter(Boolean).join(', ');
  return kv([
    ['Objet', esc(j.ldhName || j.name || j.handle)],
    ['Plage', j.startAddress ? esc(`${j.startAddress} – ${j.endAddress}`) : ''],
    ['Pays', esc(j.country)],
    ['Registrar', esc(role('registrar'))],
    ['Titulaire', esc(role('registrant'))],
    ['Contact abus', esc(role('abuse'))],
    ['Création', esc(ev.registration)],
    ['Expiration', esc(ev.expiration)],
    ['Modifié', esc(ev['last changed'])],
    ['Statut', esc((j.status || []).join(', '))],
    ['Serveurs DNS', esc((j.nameservers || []).map((n) => n.ldhName).join(', '))],
  ]) + `<details><summary>JSON brut</summary><pre>${esc(JSON.stringify(j, null, 2))}</pre></details>`;
}

const USER_SITES = [
  ['GitHub', 'https://github.com/{}'], ['GitLab', 'https://gitlab.com/{}'], ['X / Twitter', 'https://x.com/{}'],
  ['Instagram', 'https://www.instagram.com/{}/'], ['TikTok', 'https://www.tiktok.com/@{}'], ['YouTube', 'https://www.youtube.com/@{}'],
  ['Twitch', 'https://www.twitch.tv/{}'], ['Reddit', 'https://www.reddit.com/user/{}'], ['Pinterest', 'https://www.pinterest.com/{}/'],
  ['Snapchat', 'https://www.snapchat.com/add/{}'], ['Telegram', 'https://t.me/{}'], ['Threads', 'https://www.threads.net/@{}'],
  ['Bluesky', 'https://bsky.app/profile/{}.bsky.social'], ['Mastodon.social', 'https://mastodon.social/@{}'], ['Facebook', 'https://www.facebook.com/{}'],
  ['VK', 'https://vk.com/{}'], ['Medium', 'https://medium.com/@{}'], ['Dev.to', 'https://dev.to/{}'],
  ['Steam', 'https://steamcommunity.com/id/{}'], ['SoundCloud', 'https://soundcloud.com/{}'], ['Behance', 'https://www.behance.net/{}'],
  ['Dribbble', 'https://dribbble.com/{}'], ['Vimeo', 'https://vimeo.com/{}'], ['Flickr', 'https://www.flickr.com/people/{}'],
  ['Keybase', 'https://keybase.io/{}'], ['Hacker News', 'https://news.ycombinator.com/user?id={}'], ['Linktree', 'https://linktr.ee/{}'],
  ['Patreon', 'https://www.patreon.com/{}'], ['Chess.com', 'https://www.chess.com/member/{}'], ['Lichess', 'https://lichess.org/@/{}'],
  ['Replit', 'https://replit.com/@{}'], ['npm', 'https://www.npmjs.com/~{}'], ['PyPI', 'https://pypi.org/user/{}/'],
  ['Docker Hub', 'https://hub.docker.com/u/{}'], ['Kaggle', 'https://www.kaggle.com/{}'], ['CodePen', 'https://codepen.io/{}'],
  ['About.me', 'https://about.me/{}'], ['Gravatar', 'https://gravatar.com/{}'], ['Roblox', 'https://www.roblox.com/search/users?keyword={}'],
];

const SEARCH_ENGINES = [
  ['Google', 'https://www.google.com/search?q='], ['Bing', 'https://www.bing.com/search?q='],
  ['DuckDuckGo', 'https://duckduckgo.com/?q='], ['Yandex', 'https://yandex.com/search/?text='], ['Brave', 'https://search.brave.com/search?q='],
];
const engineLinks = (q) => SEARCH_ENGINES.map(([n, u]) => link(u + encodeURIComponent(q), n)).join(' · ');

async function digest(algo, buf) {
  return [...new Uint8Array(await crypto.subtle.digest(algo, buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const b64enc = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64dec = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')), (c) => c.charCodeAt(0)));

export const TOOLS = [
  {
    id: 'dns', title: 'DNS', desc: 'Tous les enregistrements d\'un domaine (A, AAAA, MX, TXT, NS, CNAME, SOA, CAA).',
    inputs: [{ name: 'q', placeholder: 'exemple.com' }],
    async run({ q }) {
      const d = host(q);
      const res = await Promise.all(Object.keys(DNS_TYPES).map((t) => doh(d, t).catch(() => [])));
      const seen = new Set();
      const rows = res.flat().filter((a) => { const k = a.type + a.data; if (seen.has(k)) return false; seen.add(k); return true; });
      if (!rows.length) return '<p class="muted">Aucun enregistrement.</p>';
      return `<table class="tbl"><tr><th>Type</th><th>Valeur</th><th>TTL</th></tr>${rows.map((a) => `<tr><td>${esc(a.type)}</td><td>${esc(a.data)}</td><td>${a.ttl}</td></tr>`).join('')}</table>`;
    },
  },
  {
    id: 'whois', title: 'WHOIS / RDAP', desc: 'Registrar, dates, statut d\'un domaine — ou propriétaire réseau d\'une IP.',
    inputs: [{ name: 'q', placeholder: 'exemple.com ou 8.8.8.8' }],
    async run({ q }) {
      const v = host(q);
      const kind = /^[\d.]+$|:/.test(v) ? 'ip' : 'domain';
      return rdapSummary(await getJSON(`https://rdap.org/${kind}/${encodeURIComponent(v)}`));
    },
  },
  {
    id: 'ip', title: 'IP', desc: 'Localisation approximative, opérateur et ASN d\'une adresse IP publique.',
    inputs: [{ name: 'q', placeholder: '8.8.8.8' }],
    async run({ q }) {
      const j = await getJSON(`https://ipwho.is/${encodeURIComponent(q.trim())}`);
      if (j.success === false) throw new Error(j.message || 'IP invalide');
      return kv([
        ['IP', esc(`${j.ip} (${j.type})`)],
        ['Lieu', esc([j.city, j.region, j.country].filter(Boolean).join(', '))],
        ['Coordonnées', j.latitude != null ? link(`https://www.openstreetmap.org/?mlat=${j.latitude}&mlon=${j.longitude}#map=10/${j.latitude}/${j.longitude}`, `${j.latitude}, ${j.longitude}`) : ''],
        ['Opérateur', esc(j.connection?.isp)],
        ['Organisation', esc(j.connection?.org)],
        ['ASN', j.connection?.asn ? link(`https://bgp.he.net/AS${j.connection.asn}`, `AS${j.connection.asn}`) : ''],
        ['Fuseau', esc(j.timezone?.id)],
        ['Plus', [link(`https://www.shodan.io/host/${j.ip}`, 'Shodan'), link(`https://www.abuseipdb.com/check/${j.ip}`, 'AbuseIPDB'), link(`https://www.virustotal.com/gui/ip-address/${j.ip}`, 'VirusTotal')].join(' · ')],
      ]) + '<p class="muted">Géolocalisation IP = ville/opérateur, jamais une adresse précise.</p>';
    },
  },
  {
    id: 'subs', title: 'Sous-domaines', desc: 'Via les journaux Certificate Transparency (crt.sh). Peut prendre ~30 s.',
    inputs: [{ name: 'q', placeholder: 'exemple.com' }],
    async run({ q }) {
      const d = host(q);
      const j = await getJSON(`https://crt.sh/?q=${encodeURIComponent('%.' + d)}&output=json`);
      const names = [...new Set(j.flatMap((c) => c.name_value.split('\n')).map((n) => n.trim().replace(/^\*\./, '').toLowerCase()).filter((n) => /^[a-z0-9.-]+$/.test(n) && (n === d || n.endsWith('.' + d))))].sort();
      return `<p class="muted">${names.length} noms uniques</p><pre>${esc(names.join('\n'))}</pre>`;
    },
  },
  {
    id: 'wayback', title: 'Archives web', desc: 'Dernière capture Wayback Machine d\'une URL + liens vers les autres archives.',
    inputs: [{ name: 'q', placeholder: 'https://exemple.com/page' }],
    async run({ q }) {
      const u = q.trim();
      const j = await getJSON(`https://archive.org/wayback/available?url=${encodeURIComponent(u)}`);
      const snap = j.archived_snapshots?.closest;
      const ts = snap?.timestamp;
      return kv([
        ['Dernière capture', snap ? link(snap.url, `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`) : 'aucune'],
        ['Historique', link(`https://web.archive.org/web/*/${u}`, 'calendrier Wayback')],
        ['Toutes les URLs', link(`https://web.archive.org/web/*/${host(u)}/*`, `${host(u)}/*`)],
        ['archive.today', link(`https://archive.ph/${u}`, 'archive.ph')],
      ]);
    },
  },
  {
    id: 'email', title: 'Email', desc: 'Configuration mail du domaine (MX, SPF, DMARC), Gravatar public, liens de vérification.',
    inputs: [{ name: 'q', placeholder: 'nom@exemple.com' }],
    async run({ q }) {
      const email = q.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Adresse invalide');
      const d = email.split('@')[1];
      const [mx, txt, dmarc] = await Promise.all([doh(d, 'MX'), doh(d, 'TXT'), doh('_dmarc.' + d, 'TXT')]);
      const spf = txt.map((a) => a.data).find((t) => t.includes('v=spf1'));
      const hash = await digest('SHA-256', new TextEncoder().encode(email));
      return kv([
        ['Domaine', esc(d)],
        ['MX', esc(mx.map((a) => a.data).join(', ') || 'aucun — le domaine ne reçoit pas de mail')],
        ['SPF', esc(spf || 'absent')],
        ['DMARC', esc(dmarc.map((a) => a.data).join(' ') || 'absent')],
        ['Gravatar', `<img class="grav" alt="" src="https://gravatar.com/avatar/${hash}?d=404&s=80" onerror="this.replaceWith('aucun')"> ${link(`https://gravatar.com/${hash}`, 'profil')}`],
        ['Fuites connues', link('https://haveibeenpwned.com/', 'Have I Been Pwned')],
        ['Recherche', engineLinks(`"${email}"`)],
      ]);
    },
  },
  {
    id: 'user', title: 'Pseudo', desc: `Liens directs vers le profil sur ${USER_SITES.length} plateformes.`,
    inputs: [{ name: 'q', placeholder: 'pseudo' }],
    async run({ q }) {
      const u = q.trim().replace(/^@/, '');
      if (!/^[\w.-]{1,40}$/.test(u)) throw new Error('Pseudo invalide');
      return `<div class="links">${USER_SITES.map(([n, url]) => link(url.replace('{}', encodeURIComponent(u)), n)).join('')}</div>
        <p class="muted">Vérification automatique : ${link('https://whatsmyname.app/', 'WhatsMyName')} · ${link('https://github.com/sherlock-project/sherlock', 'Sherlock')} · ${link('https://github.com/soxoj/maigret', 'Maigret')}</p>
        <p>Recherche web : ${engineLinks(`"${u}"`)}</p>`;
    },
  },
  {
    id: 'dorks', title: 'Dorks', desc: 'Construit une requête avancée et l\'ouvre sur 5 moteurs. Remplis seulement ce qui sert.',
    inputs: [
      { name: 'words', placeholder: 'mots-clés' }, { name: 'exact', placeholder: 'phrase exacte' },
      { name: 'site', placeholder: 'site: (domaine)' }, { name: 'filetype', placeholder: 'filetype: pdf, xlsx…' },
      { name: 'intitle', placeholder: 'intitle:' }, { name: 'inurl', placeholder: 'inurl:' },
      { name: 'not', placeholder: 'exclure (mots séparés par espace)' }, { name: 'after', placeholder: 'après (AAAA-MM-JJ)' },
    ],
    async run(v) {
      const parts = [
        v.words, v.exact && `"${v.exact}"`, v.site && `site:${host(v.site)}`, v.filetype && `filetype:${v.filetype.replace(/^\./, '')}`,
        v.intitle && `intitle:"${v.intitle}"`, v.inurl && `inurl:${v.inurl}`,
        ...(v.not || '').split(/\s+/).filter(Boolean).map((w) => `-${w}`), v.after && `after:${v.after}`,
      ].filter(Boolean);
      if (!parts.length) throw new Error('Remplis au moins un champ');
      const q = parts.join(' ');
      let out = `<pre>${esc(q)}</pre><p>${engineLinks(q)}</p>`;
      if (v.site) {
        const d = host(v.site);
        const presets = [
          ['Documents publics', `site:${d} (filetype:pdf OR filetype:doc OR filetype:docx OR filetype:xlsx OR filetype:pptx)`],
          ['Sous-domaines indexés', `site:*.${d} -site:www.${d}`],
          ['Mentions ailleurs', `"${d}" -site:${d}`],
          ['Profils pros', `site:linkedin.com "${d}"`],
          ['Code public', `site:github.com "${d}"`],
        ];
        out += `<p class="muted">Recettes pour ${esc(d)} :</p><ul class="presets">${presets.map(([n, p]) => `<li>${esc(n)} — ${link('https://www.google.com/search?q=' + encodeURIComponent(p), p)}</li>`).join('')}</ul>`;
      }
      return out;
    },
  },
  {
    id: 'revimg', title: 'Image inversée', desc: 'Retrouve d\'où vient une image publique (URL) sur 4 moteurs.',
    inputs: [{ name: 'q', placeholder: 'https://…/image.jpg' }],
    async run({ q }) {
      const u = encodeURIComponent(q.trim());
      return `<div class="links">${[
        ['Google Lens', `https://lens.google.com/uploadbyurl?url=${u}`], ['Bing Visual', `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${u}`],
        ['Yandex', `https://yandex.com/images/search?rpt=imageview&url=${u}`], ['TinEye', `https://tineye.com/search?url=${u}`],
      ].map(([n, url]) => link(url, n)).join('')}</div><p class="muted">Pour un fichier local : utilise l'outil EXIF puis dépose l'image directement sur ces sites.</p>`;
    },
  },
  {
    id: 'exif', title: 'Métadonnées EXIF', desc: 'Appareil, date, logiciel, GPS d\'une photo. Le fichier ne quitte pas ton navigateur.',
    inputs: [{ name: 'file', type: 'file', accept: 'image/*' }],
    async run({ file }) {
      if (!file) throw new Error('Choisis une image');
      const exifr = (await import('https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs')).default;
      const data = await exifr.parse(file, true).catch(() => null);
      if (!data) return '<p class="muted">Aucune métadonnée (souvent supprimées par les réseaux sociaux).</p>';
      const gps = data.latitude != null ? link(`https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}#map=16/${data.latitude}/${data.longitude}`, `${data.latitude.toFixed(6)}, ${data.longitude.toFixed(6)}`) : '';
      const main = kv([
        ['Appareil', esc([data.Make, data.Model].filter(Boolean).join(' '))], ['Objectif', esc(data.LensModel)],
        ['Prise de vue', esc(data.DateTimeOriginal?.toLocaleString?.('fr-FR') || data.DateTimeOriginal)],
        ['Logiciel', esc(data.Software)], ['Auteur', esc(data.Artist || data.Copyright)],
        ['Dimensions', esc(data.ExifImageWidth && `${data.ExifImageWidth} × ${data.ExifImageHeight}`)],
        ['GPS', gps], ['Altitude', esc(data.GPSAltitude && `${Math.round(data.GPSAltitude)} m`)],
      ]);
      const all = Object.entries(data).filter(([, v]) => typeof v !== 'object' || v instanceof Date).map(([k, v]) => `${k}: ${v instanceof Date ? v.toISOString() : v}`).join('\n');
      return main + `<details><summary>Tout (${Object.keys(data).length} champs)</summary><pre>${esc(all)}</pre></details>`;
    },
  },
  {
    id: 'hash', title: 'Empreinte (hash)', desc: 'SHA-1 / 256 / 512 d\'un fichier (≤ 500 Mo) ou d\'un texte — pour comparer avec VirusTotal.',
    inputs: [{ name: 'file', type: 'file' }, { name: 'text', placeholder: '…ou un texte' }],
    async run({ file, text }) {
      let buf;
      if (file) { if (file.size > 500 * 1024 ** 2) throw new Error('Fichier > 500 Mo'); buf = await file.arrayBuffer(); }
      else if (text) buf = new TextEncoder().encode(text);
      else throw new Error('Choisis un fichier ou tape un texte');
      const [s1, s256, s512] = await Promise.all(['SHA-1', 'SHA-256', 'SHA-512'].map((a) => digest(a, buf)));
      return kv([['SHA-1', `<code>${s1}</code>`], ['SHA-256', `<code>${s256}</code>`], ['SHA-512', `<code class="wrap">${s512}</code>`],
        ['VirusTotal', link(`https://www.virustotal.com/gui/file/${s256}`, 'chercher ce hash')]]);
    },
  },
  {
    id: 'decode', title: 'Décodeur', desc: 'Base64, URL, hexadécimal, ROT13, timestamp Unix.',
    inputs: [
      { name: 'op', type: 'select', options: [['b64d', 'Base64 → texte'], ['b64e', 'texte → Base64'], ['urld', 'URL → texte'], ['urle', 'texte → URL'], ['hexd', 'hex → texte'], ['hexe', 'texte → hex'], ['rot13', 'ROT13'], ['unix', 'timestamp → date']] },
      { name: 'q', type: 'textarea', placeholder: 'entrée' },
    ],
    async run({ op, q }) {
      const s = q || '';
      const out = {
        b64d: () => b64dec(s), b64e: () => b64enc(s), urld: () => decodeURIComponent(s.replace(/\+/g, ' ')), urle: () => encodeURIComponent(s),
        hexd: () => new TextDecoder().decode(Uint8Array.from(s.replace(/[^0-9a-f]/gi, '').match(/.{2}/g) || [], (h) => parseInt(h, 16))),
        hexe: () => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
        rot13: () => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26)),
        unix: () => { const n = Number(s.trim()); const d = new Date(n < 1e12 ? n * 1000 : n); if (isNaN(d)) throw new Error('Nombre invalide'); return `${d.toISOString()}\n${d.toLocaleString('fr-FR')}`; },
      }[op]();
      return `<pre>${esc(out)}</pre>`;
    },
  },
];

// ---------- annuaire ----------
// [catégorie, [[nom, url, description], …]]
export const DIRECTORY = [
  ['Méthodo & collections', [
    ['OSINT Framework', 'https://osintframework.com/', 'Arbre de centaines d\'outils par type de donnée'],
    ['Bellingcat Toolkit', 'https://bellingcat.gitbook.io/toolkit', 'Boîte à outils des enquêteurs de Bellingcat'],
    ['Awesome OSINT', 'https://github.com/jivoi/awesome-osint', 'Liste communautaire géante'],
    ['IntelTechniques Tools', 'https://inteltechniques.com/tools/', 'Formulaires de recherche de M. Bazzell'],
    ['OSINT Dojo', 'https://www.osintdojo.com/resources/', 'Parcours d\'apprentissage'],
    ['Google Fact Check Explorer', 'https://toolbox.google.com/factcheck/explorer', 'Vérifications déjà publiées'],
    ['AFP Factuel', 'https://factuel.afp.com/', 'Fact-checking AFP'],
  ]],
  ['Moteurs de recherche', [
    ['Google Recherche avancée', 'https://www.google.com/advanced_search', 'Formulaire des opérateurs'],
    ['Google Hacking Database', 'https://www.exploit-db.com/google-hacking-database', 'Catalogue de dorks'],
    ['Bing', 'https://www.bing.com/', 'Index différent de Google'],
    ['Yandex', 'https://yandex.com/', 'Fort sur l\'Est et les images'],
    ['DuckDuckGo', 'https://duckduckgo.com/', 'Sans bulle de filtre'],
    ['Brave Search', 'https://search.brave.com/', 'Index indépendant'],
    ['Mojeek', 'https://www.mojeek.com/', 'Index indépendant'],
    ['Startpage', 'https://www.startpage.com/', 'Résultats Google sans pistage'],
    ['Google Dataset Search', 'https://datasetsearch.research.google.com/', 'Jeux de données publics'],
  ]],
  ['Pseudos & réseaux sociaux', [
    ['WhatsMyName', 'https://whatsmyname.app/', 'Pseudo sur 600+ sites'],
    ['Namechk', 'https://namechk.com/', 'Disponibilité d\'un pseudo'],
    ['Instant Username', 'https://instantusername.com/', 'Vérif rapide de pseudo'],
    ['Sherlock', 'https://github.com/sherlock-project/sherlock', 'CLI : pseudo sur 400+ sites'],
    ['Maigret', 'https://github.com/soxoj/maigret', 'CLI : dossier complet par pseudo'],
    ['Social Searcher', 'https://www.social-searcher.com/', 'Mentions sur les réseaux'],
    ['TGStat', 'https://tgstat.com/', 'Annuaire & stats de chaînes Telegram'],
    ['Telemetr', 'https://telemetr.io/', 'Recherche dans Telegram public'],
    ['YouTube Metadata', 'https://mattw.io/youtube-metadata/', 'Date exacte, tags, géoloc d\'une vidéo'],
    ['Reddit Search', 'https://www.reddit.com/search/', 'Recherche native Reddit'],
  ]],
  ['Emails', [
    ['Have I Been Pwned', 'https://haveibeenpwned.com/', 'Fuites dans lesquelles apparaît un email'],
    ['Hunter', 'https://hunter.io/', 'Format d\'email d\'une entreprise'],
    ['Epieos', 'https://epieos.com/', 'Comptes liés à un email / téléphone'],
    ['Holehe', 'https://github.com/megadose/holehe', 'CLI : sites où un email est inscrit'],
    ['MXToolbox', 'https://mxtoolbox.com/', 'Diagnostic mail / blacklists'],
    ['Email Header Analyzer', 'https://mxtoolbox.com/EmailHeaders.aspx', 'Trace le chemin d\'un mail'],
  ]],
  ['Domaines & sites web', [
    ['ICANN Lookup', 'https://lookup.icann.org/', 'WHOIS officiel'],
    ['crt.sh', 'https://crt.sh/', 'Certificats TLS émis'],
    ['DNSDumpster', 'https://dnsdumpster.com/', 'Cartographie DNS'],
    ['SecurityTrails', 'https://securitytrails.com/', 'Historique DNS'],
    ['ViewDNS', 'https://viewdns.info/', 'Reverse IP, historique, etc.'],
    ['urlscan.io', 'https://urlscan.io/', 'Capture et analyse d\'une page'],
    ['BuiltWith', 'https://builtwith.com/', 'Technologies d\'un site'],
    ['Wappalyzer', 'https://www.wappalyzer.com/', 'Technologies (extension)'],
    ['PublicWWW', 'https://publicwww.com/', 'Recherche dans le code source des sites'],
    ['DomainTools Whois', 'https://whois.domaintools.com/', 'WHOIS détaillé'],
    ['Robtex', 'https://www.robtex.com/', 'Relations DNS/IP'],
  ]],
  ['IP & infrastructure', [
    ['Shodan', 'https://www.shodan.io/', 'Appareils exposés sur Internet'],
    ['Censys', 'https://search.censys.io/', 'Hôtes et certificats'],
    ['GreyNoise', 'https://viz.greynoise.io/', 'Bruit de scan Internet'],
    ['AbuseIPDB', 'https://www.abuseipdb.com/', 'Signalements d\'abus par IP'],
    ['IPinfo', 'https://ipinfo.io/', 'Géoloc & ASN'],
    ['Hurricane Electric BGP', 'https://bgp.he.net/', 'ASN, préfixes, peers'],
    ['VirusTotal', 'https://www.virustotal.com/', 'Fichiers, URLs, domaines, IP'],
  ]],
  ['Archives', [
    ['Wayback Machine', 'https://web.archive.org/', 'Historique de pages web'],
    ['archive.today', 'https://archive.ph/', 'Captures à la demande'],
    ['Common Crawl', 'https://commoncrawl.org/', 'Corpus géant du web'],
    ['CachedView', 'https://cachedview.nl/', 'Caches Google/Bing/Wayback'],
    ['Ghostarchive', 'https://ghostarchive.org/', 'Archive de pages et vidéos'],
  ]],
  ['Images & vidéos', [
    ['Google Lens', 'https://lens.google.com/', 'Recherche inversée'],
    ['TinEye', 'https://tineye.com/', 'Recherche inversée, tri par date'],
    ['Yandex Images', 'https://yandex.com/images/', 'Très bon sur les lieux'],
    ['Bing Visual Search', 'https://www.bing.com/visualsearch', 'Recherche inversée'],
    ['FotoForensics', 'https://fotoforensics.com/', 'Analyse ELA de retouche'],
    ['Forensically', 'https://29a.ch/photo-forensics/', 'Clonage, bruit, ELA'],
    ['Jimpl', 'https://jimpl.com/', 'Lecteur EXIF en ligne'],
    ['ExifTool', 'https://exiftool.org/', 'Référence des métadonnées (CLI)'],
    ['InVID / WeVerify', 'https://weverify.eu/verification-plugin/', 'Vérification vidéo (extension)'],
  ]],
  ['Géolocalisation & cartes', [
    ['Google Earth', 'https://earth.google.com/web/', 'Globe 3D + historique'],
    ['Sentinel Hub EO Browser', 'https://apps.sentinel-hub.com/eo-browser/', 'Images satellite récentes'],
    ['Zoom Earth', 'https://zoom.earth/', 'Satellite quasi temps réel'],
    ['SunCalc', 'https://www.suncalc.org/', 'Position du soleil → heure/lieu'],
    ['Overpass Turbo', 'https://overpass-turbo.eu/', 'Requêtes sur OpenStreetMap'],
    ['Mapillary', 'https://www.mapillary.com/', 'Photos de rue participatives'],
    ['OpenStreetMap', 'https://www.openstreetmap.org/', 'Carte libre'],
    ['PeakVisor', 'https://peakvisor.com/', 'Identifier des montagnes'],
    ['Wikimapia', 'https://wikimapia.org/', 'Lieux annotés'],
    ['Géoportail', 'https://www.geoportail.gouv.fr/', 'Cartes IGN, cadastre, photos anciennes'],
  ]],
  ['Transports', [
    ['Flightradar24', 'https://www.flightradar24.com/', 'Vols en temps réel'],
    ['ADS-B Exchange', 'https://globe.adsbexchange.com/', 'Vols non filtrés'],
    ['MarineTraffic', 'https://www.marinetraffic.com/', 'Navires (AIS)'],
    ['VesselFinder', 'https://www.vesselfinder.com/', 'Navires (AIS)'],
    ['OpenRailwayMap', 'https://www.openrailwaymap.org/', 'Réseaux ferrés'],
  ]],
  ['Entreprises & argent public', [
    ['Annuaire des Entreprises', 'https://annuaire-entreprises.data.gouv.fr/', 'Officiel FR (SIREN, dirigeants)'],
    ['Pappers', 'https://www.pappers.fr/', 'Comptes, dirigeants, actes FR'],
    ['Societe.com', 'https://www.societe.com/', 'Fiches entreprises FR'],
    ['Infogreffe', 'https://www.infogreffe.fr/', 'Registre du commerce'],
    ['BODACC', 'https://www.bodacc.fr/', 'Annonces légales'],
    ['OpenCorporates', 'https://opencorporates.com/', '200M+ sociétés mondiales'],
    ['GLEIF', 'https://search.gleif.org/', 'Identifiants LEI'],
    ['Companies House', 'https://find-and-update.company-information.service.gov.uk/', 'Registre UK'],
    ['SEC EDGAR', 'https://www.sec.gov/edgar/search/', 'Dépôts des sociétés US'],
    ['OpenSanctions', 'https://www.opensanctions.org/', 'Sanctions & personnes exposées'],
    ['ICIJ Offshore Leaks', 'https://offshoreleaks.icij.org/', 'Panama/Pandora Papers'],
    ['OCCRP Aleph', 'https://aleph.occrp.org/', 'Documents d\'enquête'],
    ['data.gouv.fr', 'https://www.data.gouv.fr/', 'Open data FR'],
    ['Légifrance', 'https://www.legifrance.gouv.fr/', 'Textes officiels FR'],
  ]],
  ['Crypto (registres publics)', [
    ['Blockchain.com Explorer', 'https://www.blockchain.com/explorer', 'Bitcoin'],
    ['Etherscan', 'https://etherscan.io/', 'Ethereum'],
    ['Blockchair', 'https://blockchair.com/', 'Multi-chaînes'],
    ['WalletExplorer', 'https://www.walletexplorer.com/', 'Regroupement d\'adresses BTC'],
  ]],
  ['Code & dev', [
    ['GitHub Search', 'https://github.com/search', 'Code, commits, utilisateurs'],
    ['grep.app', 'https://grep.app/', 'Recherche dans le code open source'],
    ['Sourcegraph', 'https://sourcegraph.com/search', 'Recherche de code'],
    ['CyberChef', 'https://gchq.github.io/CyberChef/', 'Couteau suisse de décodage'],
  ]],
  ['Outils à installer', [
    ['SpiderFoot', 'https://github.com/smicallef/spiderfoot', 'Automatisation de reconnaissance'],
    ['theHarvester', 'https://github.com/laramies/theHarvester', 'Emails, sous-domaines, hôtes'],
    ['Recon-ng', 'https://github.com/lanmaster53/recon-ng', 'Framework modulaire'],
    ['Amass', 'https://github.com/owasp-amass/amass', 'Cartographie de surface (OWASP)'],
    ['Subfinder', 'https://github.com/projectdiscovery/subfinder', 'Sous-domaines passifs'],
    ['PhoneInfoga', 'https://github.com/sundowndev/phoneinfoga', 'Infos publiques d\'un numéro'],
    ['Maltego', 'https://www.maltego.com/', 'Graphes de liens'],
    ['Hunchly', 'https://www.hunch.ly/', 'Capture automatique d\'enquête'],
  ]],
];
