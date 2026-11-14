# VAULT_

Stockage de fichiers perso, gratuit, protégé par un code qui change toutes les 30 min et arrive sur Discord.

```
docs/      site (GitHub Pages)          → https://exiozz.github.io/matrix-vault/
worker/    API (Cloudflare Worker free) → vérifie le code, garde le token GitHub, streame les fichiers
stockage   Releases du repo privé exiozz/vault-data (1 release = 1 fichier, découpé en morceaux de 95 Mo)
```

- Code : `XXXX-XXXX-XXXX`, dérivé de `SEED` + l'heure (fenêtres de 30 min alignées sur :00/:30 UTC). L'ancien code reste valide 2 min après la rotation.
- Le cron du Worker poste le nouveau code sur le webhook Discord à chaque rotation. Bouton « renvoyer sur discord » sur la page de login (1×/min).
- Session : 1 h après connexion.
- Max 2 Go par fichier (limite de sous-requêtes du plan gratuit Cloudflare). Pas de limite totale.

## Mise en place (une seule fois)

1. **Token GitHub** : https://github.com/settings/personal-access-tokens/new → *Only select repositories* : `vault-data` → *Contents : Read and write*. Expiration : la plus longue possible.
2. **Webhook Discord** : Paramètres du salon → Intégrations → Webhooks → Nouveau → Copier l'URL.
3. **Cloudflare** (compte gratuit) :
   ```bash
   cd worker
   npx wrangler login
   npx wrangler secret put GH_TOKEN
   npx wrangler secret put DISCORD_WEBHOOK
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put SEED
   npx wrangler deploy
   ```
4. Mettre l'URL `https://matrix-vault.<toi>.workers.dev` affichée par `deploy` dans `docs/config.js`, commit, push.

Changer `SEED` invalide tous les codes et sessions en cours.
