// Enregistre les slash commands du bot. Usage (PowerShell) :
//   $env:DISCORD_TOKEN="..."; $env:DISCORD_APP_ID="..."; node register-commands.mjs
import { CATEGORIES, SORTS } from '../docs/search.js';

const { DISCORD_TOKEN, DISCORD_APP_ID } = process.env;
if (!DISCORD_TOKEN || !DISCORD_APP_ID) throw new Error('DISCORD_TOKEN et DISCORD_APP_ID requis');

const everywhere = { integration_types: [0, 1], contexts: [0, 1, 2] };
const commands = [
  {
    name: 'recherche', description: 'Chercher dans le vault (syntaxe avancée : /aide)', ...everywhere,
    options: [
      { type: 3, name: 'requete', description: 'ex : rapport type:doc size:>10mo after:30d -tag:vieux', max_length: 400 },
      { type: 3, name: 'tri', description: 'Ordre des résultats', choices: Object.entries(SORTS).map(([value, name]) => ({ name, value })) },
      { type: 3, name: 'type', description: 'Type de fichier', choices: Object.entries(CATEGORIES).map(([value, c]) => ({ name: c.label, value })) },
      { type: 4, name: 'page', description: 'Page de résultats', min_value: 1 },
    ],
  },
  { name: 'stats', description: 'Statistiques du vault', ...everywhere },
  { name: 'code', description: 'Code d\'accès actuel du site (visible par toi seul)', ...everywhere },
  { name: 'aide', description: 'Syntaxe de recherche avancée', ...everywhere },
];

const res = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commands),
});
console.log(res.status, res.ok ? `${commands.length} commandes enregistrées` : await res.text());
