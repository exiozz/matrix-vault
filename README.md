# VAULT_

Stockage de fichiers perso gratuit, protégé par un code qui change toutes les 30 min et que le bot Discord t'envoie en MP. Onglet OSINT intégré (12 outils + annuaire de 109 outils légaux).

```
docs/      site (GitHub Pages)          → https://exiozz.github.io/matrix-vault/
           search.js = moteur de recherche/tri partagé avec le bot
worker/    Cloudflare Worker (gratuit)  → API du site + bot Discord (interactions HTTP) + cron de rotation
stockage   Releases du repo privé exiozz/vault-data (1 release = 1 fichier, découpé en morceaux de 95 Mo)
```

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

Commandes (réponses visibles par toi seul, refusées pour tout autre compte que `OWNER_IDS`) :
- `/recherche requete tri type page` : résultats paginés avec boutons ⏮ ◀ ▶ ⏭, menus de tri et de type, liens de téléchargement valables 24 h
- `/stats` : volume par type, plus lourds, derniers ajouts, tags
- `/code` : code d'accès actuel
- `/aide` : syntaxe

Le code est aussi envoyé en MP à chaque rotation (l'ancien MP est supprimé).

## Mise en place (une seule fois)

1. **Token GitHub** : https://github.com/settings/personal-access-tokens/new → *Only select repositories* : `vault-data` → *Contents : Read and write*.
2. **Bot Discord** : https://discord.com/developers/applications → *New Application*.
   - *General Information* : copie **Application ID** et **Public Key**.
   - *Bot* → *Reset Token* : copie le **token**.
   - Ton ID Discord : Paramètres → Avancés → Mode développeur, puis clic droit sur ton profil → *Copier l'identifiant*.
3. **Cloudflare** (compte gratuit), dans `worker/` :
   ```bash
   npx wrangler login
   npx wrangler secret put GH_TOKEN
   npx wrangler secret put DISCORD_TOKEN
   npx wrangler secret put DISCORD_APP_ID
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put OWNER_IDS
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SEED
   npx wrangler deploy
   ```
4. **Relier le bot** : Developer Portal → *General Information* → *Interactions Endpoint URL* = `https://matrix-vault.<toi>.workers.dev/discord` → Save.
5. **Commandes** (PowerShell, dans `worker/`) :
   ```powershell
   $env:DISCORD_TOKEN="..."; $env:DISCORD_APP_ID="..."; node register-commands.mjs
   ```
6. **Inviter le bot** : `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=0`
7. Mettre l'URL du Worker dans `docs/config.js`, commit, push.

Changer `SEED` invalide tous les codes, sessions et liens partagés.
