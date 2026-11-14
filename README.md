# VAULT_

Stockage de fichiers perso gratuit, protégé par un code qui change toutes les 30 min et que ton bot Discord t'envoie en MP. Onglet OSINT intégré (12 outils + annuaire de 109 outils légaux).

```
docs/      site (GitHub Pages)          → https://exiozz.github.io/matrix-vault/
           search.js = moteur de recherche/tri (aussi utilisé par le Worker)
worker/    Cloudflare Worker (gratuit)  → API du site : code, sessions, upload/download vers GitHub
bot/       bot Discord en Python (discord.py) à lancer chez ton hébergeur
           search.py = portage de search.js ; test_search.py vérifie qu'ils donnent les mêmes résultats
stockage   Releases du repo privé exiozz/vault-data (1 release = 1 fichier, découpé en morceaux de 95 Mo)
```

Le bot et le Worker partagent la même `SEED` : le bot calcule lui-même le code, ouvre une session sur le Worker et signe les liens de téléchargement. Il n'a jamais besoin du token GitHub.

## Recherche (site et bot, même syntaxe)

| syntaxe | effet |
|---|---|
| `mots libres` | tous doivent apparaître dans le nom ou les tags (accents ignorés) |
| `"phrase exacte"` · `-mot` · `a\|b` | phrase, exclusion, OU |
| `/regex/` | expression régulière sur le nom |
| `type:image\|video` | image, video, audio, doc, data, archive, code, app, other |
| `ext:pdf\|docx` · `tag:perso` · `tag:none` · `name:texte` | extension, tag, sans tag, nom seul |
| `size:>100mb` · `size:10mo..2go` | taille |
| `date:2026-11` · `date:7d` · `after:2026-01-01` · `before:3m` | dates absolues ou relatives |
| `sort:type,size-desc` | tri multi-clés : date, name, size, type, ext + `-asc`/`-desc` |

## Bot Discord

Réponses visibles par toi seul, refusées à tout autre compte que `OWNER_IDS` :
- `/recherche requete tri type page` : résultats paginés (⏮ ◀ ▶ ⏭), menus de tri et de type, liens de téléchargement valables 24 h
- `/stats` : volume par type, plus lourds, derniers ajouts, tags
- `/code` : code d'accès actuel
- `/aide` : syntaxe

Le code est envoyé en MP à chaque rotation (l'ancien MP est supprimé). Les commandes s'enregistrent toutes seules au démarrage.

## Mise en place

1. **Token GitHub** : https://github.com/settings/personal-access-tokens/new → *Only select repositories* : `vault-data` → *Contents : Read and write*.
2. **Bot Discord** : https://discord.com/developers/applications → *New Application* → *Bot* → *Reset Token*. Ton ID Discord : Paramètres → Avancés → Mode développeur, puis clic droit sur ton profil → *Copier l'identifiant*.
3. **Worker + préparation du bot** (compte Cloudflare gratuit), dans `worker/` :
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```
   Déploie le Worker, enregistre ses secrets, met à jour `docs/config.js` et crée `bot/.env`.
4. **Hébergeur** : envoie le dossier `bot/` seul (Python 3.9+), dépendances `pip install -r requirements.txt`, démarrage `python bot.py`. Mets les variables de `bot/.env` dans le panneau de l'hébergeur si tu n'envoies pas le fichier.
5. **Inviter le bot** : le lien s'affiche dans la console au démarrage (`…/oauth2/authorize?client_id=…&scope=bot+applications.commands&permissions=0`). Le bot doit partager un serveur avec toi pour t'envoyer les MP.

Changer `SEED` (dans le Worker **et** le bot) invalide tous les codes, sessions et liens partagés.
