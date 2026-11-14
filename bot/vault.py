"""Logique du bot sans Discord : codes, jetons signés (même SEED et même schéma que worker/src/core.js),
appels au Worker et construction des messages."""
import base64
import hashlib
import hmac
import re
import time

import aiohttp

from search import CATEGORIES, HELP, SORTS, category_of, format_size, run_query, ts_ms

WINDOW = 30 * 60      # doit matcher worker/src/core.js
LINK_TTL = 24 * 60 * 60
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
GREEN = 0x00FF41
PER_PAGE = 10
CODE_TITLE = "🟩 Code d'accès VAULT_"


def _hmac(seed, msg):
    return hmac.new(seed.encode(), msg.encode(), hashlib.sha256).digest()


def current_code(seed, sec=None):
    w = int((sec if sec is not None else time.time()) // WINDOW)
    h = _hmac(seed, f"pw:{w}")
    s = "".join(ALPHABET[h[i] & 31] for i in range(12))
    return "-".join(s[i:i + 4] for i in range(0, 12, 4)), (w + 1) * WINDOW


def seconds_to_next_rotation():
    return WINDOW - (int(time.time()) % WINDOW)


def _sign(seed, scope, ttl):
    exp = int(time.time()) + ttl
    sig = base64.urlsafe_b64encode(_hmac(seed, f"{scope}:{exp}")).rstrip(b"=").decode()
    return f"{exp}.{sig}"


class Vault:
    def __init__(self, seed, worker_url):
        self.seed = seed
        self.worker_url = worker_url.rstrip("/")

    def file_url(self, file_id):
        return f"{self.worker_url}/api/files/{file_id}/download?dl={_sign(self.seed, f'dl:{file_id}', LINK_TTL)}"

    async def list_files(self):
        headers = {"Authorization": f"Bearer {_sign(self.seed, 's', 120)}"}
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as s:
            async with s.get(f"{self.worker_url}/api/files", headers=headers) as r:
                try:
                    data = await r.json(content_type=None)
                except Exception:
                    data = {}
                if r.status == 401:
                    raise RuntimeError("Le Worker refuse le bot : la SEED du bot est différente de celle du Worker.")
                if r.status >= 400:
                    raise RuntimeError((data or {}).get("error") or f"Worker {r.status}")
                return data


# ---------- messages (dict au format de l'API Discord, convertis dans bot.py) ----------

def _esc_md(s):
    return re.sub(r"([\\\[\]()*_~`|>])", r"\\\1", str(s))


def _short(s, n):
    return s[: n - 1] + "…" if len(s) > n else s


def query_from_embed(description):
    m = re.match(r"```\n([\s\S]*?)\n```", description or "")
    return m.group(1).strip() if m else ""


def set_token(query, key, value):
    """Remplace (ou retire si value vide) un filtre `key:` dans la requête."""
    rest = re.sub(rf"(^|\s)-?{key}:\S+", " ", query, flags=re.I)
    rest = re.sub(r"\s+", " ", rest).strip()
    return f"{rest} {key}:{value}".strip() if value else rest


async def results_message(vault, query, page):
    r = run_query(await vault.list_files(), query)
    results, errors = r["results"], r["errors"]
    pages = max(1, -(-len(results) // PER_PAGE))
    page = min(max(0, page), pages - 1)
    lines = []
    for i, f in enumerate(results[page * PER_PAGE:(page + 1) * PER_PAGE]):
        ts = int(ts_ms(f["created"]) // 1000)
        tags = (" · " + " ".join(f"#{t}" for t in f["tags"])) if f.get("tags") else ""
        lines.append(
            f"`{str(page * PER_PAGE + i + 1).rjust(2)}` `{CATEGORIES[category_of(f)]['tag']}` "
            f"[{_esc_md(_short(f['name'], 60))}]({vault.file_url(f['id'])})\n"
            f"      {format_size(f['size'])} · <t:{ts}:d>{_esc_md(tags)}"
        )

    sort_tok = (re.search(r"(?:^|\s)sort:(\S+)", query, re.I) or [None, "date-desc"])[1].lower()
    if "-" not in sort_tok:  # sort:name → name-asc, sort:size → size-desc (comme le moteur)
        sort_tok += "-desc" if sort_tok in ("date", "size") else "-asc"
    type_tok = (re.search(r"(?:^|\s)type:(\S+)", query, re.I) or [None, ""])[1]
    total = sum(f["size"] for f in results)

    desc = f"```\n{query or ' '}\n```\n"
    if errors:
        desc += f"⚠️ {' · '.join(errors)}\n\n"
    desc += "\n".join(lines) if lines else "_Aucun résultat._"

    return {
        "embed": {
            "title": f"{len(results)} fichier{'s' if len(results) > 1 else ''} · {format_size(total)}",
            "description": desc[:4096],
            "color": GREEN,
            "footer": f"page {page + 1}/{pages} · liens valables 24 h · /aide pour la syntaxe",
        },
        "buttons": [
            ("pg:first:0", "⏮", page == 0),
            (f"pg:prev:{page - 1}", "◀", page == 0),
            ("pg:info", f"{page + 1} / {pages}", True),
            (f"pg:next:{page + 1}", "▶", page >= pages - 1),
            (f"pg:last:{pages - 1}", "⏭", page >= pages - 1),
        ],
        "selects": [
            ("sort", "Trier…", [(label, v, v == sort_tok) for v, label in SORTS.items()]),
            ("type", "Filtrer par type…", [("Tous les types", "all", not type_tok)] + [(c["label"], v, v == type_tok) for v, c in CATEGORIES.items()]),
        ],
    }


async def stats_message(vault):
    files = await vault.list_files()
    total = sum(f["size"] for f in files)
    by_cat = {}
    for f in files:
        c = by_cat.setdefault(category_of(f), [0, 0])
        c[0] += 1
        c[1] += f["size"]
    tag_count = {}
    for f in files:
        for t in f.get("tags") or []:
            tag_count[t] = tag_count.get(t, 0) + 1
    top_tags = sorted(tag_count.items(), key=lambda x: -x[1])[:15]
    biggest = sorted(files, key=lambda f: -f["size"])[:5]
    latest = sorted(files, key=lambda f: -ts_ms(f["created"]))[:5]

    def lst(items):
        return "\n".join(items) or "—"

    return {
        "embed": {
            "title": f"VAULT_ · {len(files)} fichiers · {format_size(total)}",
            "color": GREEN,
            "fields": [
                ("Par type", lst(f"`{CATEGORIES[c]['tag']}` {CATEGORIES[c]['label']} — {n} · {format_size(s)}"
                                 for c, (n, s) in sorted(by_cat.items(), key=lambda x: -x[1][1])), False),
                ("Plus lourds", lst(f"{_esc_md(_short(f['name'], 50))} — {format_size(f['size'])}" for f in biggest), True),
                ("Derniers ajouts", lst(f"{_esc_md(_short(f['name'], 50))} — <t:{int(ts_ms(f['created']) // 1000)}:R>" for f in latest), True),
                ("Tags", " · ".join(f"#{_esc_md(t)} ({n})" for t, n in top_tags) or "—", False),
            ],
        }
    }


def help_message():
    return {
        "embed": {
            "title": "Syntaxe de recherche",
            "color": GREEN,
            "description": "\n".join(f"`{k}` {v}" for k, v in HELP)
            + "\n\n**Exemples**\n`rapport type:doc after:30d sort:size-desc`\n`ext:mp4|mkv size:>500mo -tag:vu`\n`/^IMG_\\d+/ date:2026-07 sort:name`",
        }
    }


def code_message(seed):
    code, until = current_code(seed)
    return {
        "embed": {
            "title": CODE_TITLE,
            "description": f"```\n{code}\n```\nValide jusqu'à <t:{until}:t> (<t:{until}:R>)",
            "color": GREEN,
        }
    }
