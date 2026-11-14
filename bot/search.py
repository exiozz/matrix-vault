"""Moteur de recherche/tri — portage Python de docs/search.js (même syntaxe, mêmes résultats).

Toute évolution de la syntaxe doit être faite dans les deux fichiers ; test_search.py vérifie la parité.
Un fichier = {"id", "name", "size", "type", "created", "tags"}.
"""
import math
import re
import time
import unicodedata
from datetime import datetime, timezone
from functools import cmp_to_key

CATEGORIES = {
    "image": {"label": "Images", "tag": "IMG", "ext": "jpg jpeg png gif webp bmp tif tiff svg heic heif avif ico raw cr2 nef arw dng psd"},
    "video": {"label": "Vidéos", "tag": "VID", "ext": "mp4 mkv mov avi webm wmv flv m4v mpg mpeg 3gp ts"},
    "audio": {"label": "Audio", "tag": "AUD", "ext": "mp3 wav flac aac ogg opus m4a wma aiff mid midi"},
    "doc": {"label": "Documents", "tag": "DOC", "ext": "pdf doc docx odt rtf txt md epub pages ppt pptx odp key xls xlsx ods numbers tex"},
    "data": {"label": "Données", "tag": "DAT", "ext": "csv tsv json jsonl ndjson xml yaml yml sql db sqlite sqlite3 parquet log ini toml"},
    "archive": {"label": "Archives", "tag": "ZIP", "ext": "zip rar 7z tar gz tgz bz2 xz zst cab lz"},
    "code": {"label": "Code", "tag": "SRC", "ext": "js mjs ts jsx tsx py java c cpp h hpp cs go rs rb php html css scss sh ps1 bat lua kt swift dart r ipynb"},
    "app": {"label": "Applis", "tag": "APP", "ext": "exe msi apk ipa dmg iso img deb rpm appimage jar"},
    "other": {"label": "Autres", "tag": "···", "ext": ""},
}

EXT_TO_CAT = {}
for _k, _c in CATEGORIES.items():
    for _e in _c["ext"].split():
        EXT_TO_CAT.setdefault(_e, _k)

SORTS = {
    "date-desc": "Plus récents", "date-asc": "Plus anciens",
    "name-asc": "Nom A→Z", "name-desc": "Nom Z→A",
    "size-desc": "Plus lourds", "size-asc": "Plus légers",
    "type-asc": "Type", "ext-asc": "Extension",
}

HELP = [
    ("mots libres", "tous doivent apparaître dans le nom ou les tags (accents ignorés)"),
    ('"phrase exacte"', "suite de mots exacte"),
    ("-mot", "exclut (marche avec tout : -ext:tmp, -tag:vieux)"),
    ("a|b", "OU : vacances|voyage, ext:jpg|png"),
    ("/regex/", "expression régulière sur le nom"),
    ("type:", " | ".join(CATEGORIES)),
    ("ext:", "extension — ext:pdf|docx"),
    ("tag:", "tag:perso — tag:none = sans tag"),
    ("name:", "texte uniquement dans le nom"),
    ("size:", ">100mb  <1go  10mb..2gb  (ko/mo/go/to acceptés)"),
    ("date:", "2026 — 2026-11 — 2026-11-14 — today — 7d"),
    ("after: / before:", "2026-01-01 ou relatif : 7d 2w 3m 1y"),
    ("sort:", "date|name|size|type|ext + -asc/-desc, plusieurs clés : sort:type,size-desc"),
]


def ext_of(name):
    m = re.search(r"\.([a-z0-9]{1,10})$", name or "", re.I)
    return m.group(1).lower() if m else ""


def category_of(f):
    e = ext_of(f["name"])
    if e in EXT_TO_CAT:
        return EXT_TO_CAT[e]
    t = (f.get("type") or "").split("/")[0]
    if t in ("image", "video", "audio"):
        return t
    if t == "text":
        return "doc"
    return "other"


def norm(s):
    return "".join(c for c in unicodedata.normalize("NFD", str(s or "")) if not unicodedata.combining(c)).lower()


def ts_ms(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


UNITS = {"": 1, "b": 1, "o": 1, "k": 1024, "kb": 1024, "ko": 1024, "m": 1024 ** 2, "mb": 1024 ** 2, "mo": 1024 ** 2,
         "g": 1024 ** 3, "gb": 1024 ** 3, "go": 1024 ** 3, "t": 1024 ** 4, "tb": 1024 ** 4, "to": 1024 ** 4}


def _parse_bytes(s):
    m = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*([a-z]*)", s.strip(), re.I)
    if not m or m.group(2).lower() not in UNITS:
        return None
    return float(m.group(1).replace(",", ".")) * UNITS[m.group(2).lower()]


def _parse_size(v):
    rng = v.split("..")
    if len(rng) == 2:
        a = _parse_bytes(rng[0]) if rng[0] else 0
        b = _parse_bytes(rng[1]) if rng[1] else math.inf
        if a is None or b is None:
            return None
        return lambda s: a <= s <= b
    m = re.fullmatch(r"(>=|<=|>|<|=)?(.+)", v)
    if not m:
        return None
    n = _parse_bytes(m.group(2))
    if n is None:
        return None
    return {
        ">": lambda s: s > n, "<": lambda s: s < n, ">=": lambda s: s >= n, "<=": lambda s: s <= n,
        "=": lambda s: abs(s - n) < max(1, n * 0.05),
    }[m.group(1) or ">="]


DAY = 864e5


def _relative(v, now):
    m = re.fullmatch(r"(\d+)([dwmy])", v, re.I)
    if not m:
        return None
    return now - int(m.group(1)) * {"d": 1, "w": 7, "m": 30.44, "y": 365.25}[m.group(2).lower()] * DAY


def _utc_ms(y, mo, d):
    # mois hors bornes acceptés comme Date.UTC (ex : mois 13 = janvier suivant)
    y += (mo - 1) // 12
    mo = (mo - 1) % 12 + 1
    return datetime(y, mo, 1, tzinfo=timezone.utc).timestamp() * 1000 + (d - 1) * DAY


def _period(v):
    if m := re.fullmatch(r"(\d{4})", v):
        y = int(m.group(1))
        return _utc_ms(y, 1, 1), _utc_ms(y + 1, 1, 1)
    if m := re.fullmatch(r"(\d{4})-(\d{1,2})", v):
        y, mo = int(m.group(1)), int(m.group(2))
        return _utc_ms(y, mo, 1), _utc_ms(y, mo + 1, 1)
    if m := re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", v):
        s = _utc_ms(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return s, s + DAY
    return None


def _parse_date(key, v, now):
    if key == "date":
        if v in ("today", "aujourdhui"):
            d = datetime.fromtimestamp(now / 1000)
            s = datetime(d.year, d.month, d.day).timestamp() * 1000
            return lambda t: t >= s
        r = _relative(v, now)
        if r is not None:
            return lambda t: t >= r
        p = _period(v)
        return (lambda t: p[0] <= t < p[1]) if p else None
    r = _relative(v, now)
    p = (r, r) if r is not None else _period(v)
    if not p:
        return None
    return (lambda t: t >= p[0]) if key == "after" else (lambda t: t < p[0])


KEYS = {"name", "ext", "type", "tag", "size", "date", "after", "before", "sort"}
TOKEN = re.compile(r'(-?)(?:([a-z]+):)?("([^"]*)"?|/((?:\\.|[^/\\])+)/([a-z]*)|\S+)', re.I)


def parse_query(q):
    tests, errors, words = [], [], []
    sort = None
    for m in TOKEN.finditer(str(q or "")):
        neg = m.group(1) == "-"
        key = (m.group(2) or "").lower()
        raw = m.group(3)
        if key and key not in KEYS:
            raw = f"{m.group(2)}:{raw}"
            key = ""
        test = None

        if m.group(5) is not None:
            try:
                rx = re.compile(m.group(5), re.I)
            except re.error:
                errors.append(f"regex invalide : /{m.group(5)}/")
                continue
            test = lambda f, rx=rx: bool(rx.search(f["name"]))
        else:
            val = m.group(4) if m.group(4) is not None else raw
            if not val:
                continue
            alts = [a for a in ([val] if m.group(4) is not None else val.split("|")) if a]
            vals = [norm(a) for a in alts]
            if key == "sort":
                parts = []
                for s in val.lower().split(","):
                    k, _, d = s.partition("-")
                    if k not in ("date", "name", "size", "type", "ext"):
                        parts = None
                        break
                    parts.append({"key": k, "dir": 1 if d == "asc" else -1 if d == "desc" else (-1 if k in ("date", "size") else 1)})
                if parts is None:
                    errors.append(f"tri inconnu : {val}")
                else:
                    sort = parts
                continue
            elif key == "ext":
                test = lambda f, vals=vals: ext_of(f["name"]) in vals
            elif key == "type":
                bad = [v for v in vals if v not in CATEGORIES]
                if bad:
                    errors.append(f"type inconnu : {', '.join(bad)}")
                    continue
                test = lambda f, vals=vals: category_of(f) in vals
            elif key == "tag":
                test = lambda f, vals=vals: any(
                    (not f.get("tags")) if v == "none" else any(norm(t) == v for t in f.get("tags") or []) for v in vals)
            elif key == "name":
                test = lambda f, vals=vals: any(v in norm(f["name"]) for v in vals)
            elif key == "size":
                fns = [_parse_size(a) for a in alts]
                if any(fn is None for fn in fns):
                    errors.append(f"taille invalide : {val}")
                    continue
                test = lambda f, fns=fns: any(fn(f["size"]) for fn in fns)
            elif key in ("date", "after", "before"):
                now = time.time() * 1000
                fns = [_parse_date(key, a.lower(), now) for a in alts]
                if any(fn is None for fn in fns):
                    errors.append(f"date invalide : {key}:{val}")
                    continue
                test = lambda f, fns=fns: any(fn(ts_ms(f["created"])) for fn in fns)
            else:
                if not neg:
                    words.extend(vals)
                test = lambda f, vals=vals: any(v in norm(f"{f['name']} {' '.join(f.get('tags') or [])}") for v in vals)
        tests.append((lambda f, t=test: not t(f)) if neg else test)
    return tests, sort, errors, words


def _cmp(a, b):
    return (a > b) - (a < b)


# Ordre de la ponctuation dans la collation Unicode utilisée par localeCompare côté navigateur :
# ponctuation < chiffres (comparés comme nombres) < lettres (accents et casse ignorés).
_PUNCT = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"


def _natural(s):
    key = []
    for part in re.split(r"(\d+)", norm(s)):
        if part.isdigit():
            key.append((1, int(part)))
        else:
            for c in part:
                key.append((2, ord(c)) if c.isalnum() else (0, _PUNCT.find(c) if c in _PUNCT else len(_PUNCT) + ord(c)))
    return key


CMP = {
    "date": lambda a, b: _cmp(ts_ms(a["created"]), ts_ms(b["created"])),
    "name": lambda a, b: _cmp(_natural(a["name"]), _natural(b["name"])),
    "size": lambda a, b: _cmp(a["size"], b["size"]),
    "type": lambda a, b: _cmp(category_of(a), category_of(b)),
    "ext": lambda a, b: _cmp(ext_of(a["name"]), ext_of(b["name"])),
}


def sort_keys(s):
    out = []
    for p in str(s or "date-desc").split(","):
        k, _, d = p.partition("-")
        out.append({"key": k, "dir": 1 if d == "asc" else -1})
    return out


def run_query(files, q, default_sort="date-desc"):
    tests, sort, errors, words = parse_query(q)
    keys = (sort or sort_keys(default_sort)) + [{"key": "date", "dir": -1}]
    results = [f for f in files if all(t(f) for t in tests)]

    def compare(a, b):
        for k in keys:
            c = CMP[k["key"]](a, b) * k["dir"]
            if c:
                return c
        return 0

    results.sort(key=cmp_to_key(compare))
    return {"results": results, "errors": errors, "words": words, "sorted": sort is not None}


def format_size(n):
    u = ["o", "Ko", "Mo", "Go", "To"]
    i = 0
    while n >= 1024 and i < len(u) - 1:
        n /= 1024
        i += 1
    return f"{n:.{1 if i and n < 10 else 0}f} {u[i]}"
