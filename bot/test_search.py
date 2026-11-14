"""Vérifie que search.py donne exactement les mêmes résultats que docs/search.js (site).
À lancer sur ton PC (Node requis) après toute modification de la syntaxe : python test_search.py
"""
import json
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from search import run_query

NAMES = ["Vacances été 2025.jpg", "rapport-final.pdf", "rapport_final_v2.pdf", "backup.tar.gz", "film vacances.mkv",
         "IMG_0001.JPG", "IMG_0010.jpg", "IMG_0002.jpg", "notes.txt", "Notes.md", "export clients.csv", "données.json",
         "script.py", "setup.exe", "musique.mp3", "Mix été.flac", "archive.7z", "page.html", "présentation.pptx",
         "budget 2026.xlsx", "photo (1).png", "photo (10).png", "photo (2).png", "sans_extension", "video.webm", "README",
         "a.b.c.d.zip", "Évènement.mov", "zèbre.svg", "Zoo.gif", "2026-11-14 compte rendu.docx", "app.apk", "image.heic",
         "x-y_z.txt", "x_y-z.txt", "~tmp.doc", "#notes.md", "é.txt", "e.txt", "E.txt", "10.txt", "9.txt", "100.txt",
         "data.SQLITE", "mime-only", "text-only"]
QUERIES = ["", "vacances", "ÉTÉ", '"film vacances"', "-vacances", "vacances|backup", "type:image|video", "type:doc -ext:txt",
           "type:foo", "ext:jpg|png", "tag:perso|travail", "-tag:perso", "tag:none", "tag:ete", "name:photo|notes",
           "size:>1gb", "size:<1ko", "size:=5mo", "size:100mb..2gb", "size:..1mo", "size:abc", "date:7d", "after:2w before:3d",
           "before:1y", "date:today", r"/^IMG_\d+/", "/[unclosed/", "sort:size", "sort:name", "sort:name-desc",
           "sort:type,size-asc", "sort:ext,name", "sort:date-asc", "sort:bogus", "txt sort:name", '-"rapport final"',
           '"unterminated', "tag:perso sort:size-asc type:image|doc", "https://x.com"]

JS = """
import fs from 'fs';
const { runQuery } = await import(process.argv[1]);
const { files, queries } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify(queries.map((q) => { const r = runQuery(files, q); return [r.results.map((f) => f.id), r.errors]; })));
"""


def main():
    now = time.time()
    days = [0, 1, 3, 6, 8, 15, 40, 100, 200, 400, 800]
    sizes = [0, 5, 1023, 1024, 5e5, 2.1e6, 99e6, 1.5e9, 3e9]
    tags = [["perso"], ["travail", "2026"], [], ["Perso", "films"], ["été"], []]
    files = [{
        "id": i + 1, "name": n, "size": sizes[i % 9] + i,
        "type": {"mime-only": "video/mp4", "text-only": "text/plain"}.get(n, ""),
        "created": datetime.fromtimestamp(now - days[i % 11] * 86400 - i, timezone.utc).isoformat().replace("+00:00", "Z"),
        "tags": tags[i % 6],
    } for i, n in enumerate(NAMES)]

    search_js = (Path(__file__).parent.parent / "docs" / "search.js").resolve().as_uri()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
        json.dump({"files": files, "queries": QUERIES}, tmp, ensure_ascii=False)
    js = json.loads(subprocess.run(["node", "--input-type=module", "-e", JS, search_js, tmp.name],
                                   capture_output=True, text=True, encoding="utf-8", check=True).stdout)
    Path(tmp.name).unlink()

    bad = 0
    for q, (js_ids, js_err) in zip(QUERIES, js):
        r = run_query(files, q)
        py_ids, py_err = [f["id"] for f in r["results"]], r["errors"]
        if (py_ids, py_err) != (js_ids, js_err):
            bad += 1
            print(f"DIFF {q!r}\n  js {js_ids} {js_err}\n  py {py_ids} {py_err}")
    print(f"{len(QUERIES) - bad}/{len(QUERIES)} requêtes identiques")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
