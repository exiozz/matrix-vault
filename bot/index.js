// Bot Discord du Matrix Vault — à lancer chez ton hébergeur : `npm install` puis `npm start`.
import { existsSync, readFileSync } from 'node:fs';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import {
  COMMANDS, CODE_TITLE, codeEmbed, currentCode, helpMessage, msToNextRotation,
  queryFromEmbed, resultsMessage, setToken, statsMessage,
} from './lib.js';

// .env optionnel (sinon variables d'environnement de l'hébergeur)
const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const missing = ['DISCORD_TOKEN', 'SEED', 'WORKER_URL', 'OWNER_IDS'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Variables manquantes : ${missing.join(', ')} (voir .env.example)`);
  process.exit(1);
}

const cfg = { seed: process.env.SEED, workerUrl: process.env.WORKER_URL.replace(/\/+$/, '') };
const owners = process.env.OWNER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
const siteUrl = process.env.SITE_URL || 'https://exiozz.github.io/matrix-vault/';
const EPHEMERAL = 64;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------- code en MP à chaque rotation ----------

async function sendCodeDM() {
  for (const uid of owners) {
    try {
      const dm = await (await client.users.fetch(uid)).createDM();
      const old = await dm.messages.fetch({ limit: 20 }).catch(() => null);
      for (const m of old?.values() || []) {
        if (m.author.id === client.user.id && m.embeds[0]?.title === CODE_TITLE) await m.delete().catch(() => {});
      }
      await dm.send({
        embeds: [codeEmbed(cfg.seed)],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Ouvrir le vault', url: siteUrl }] }],
      });
    } catch (e) {
      console.error(`MP impossible à ${uid} (il faut partager un serveur avec le bot) :`, e.message);
    }
  }
}

function scheduleRotation() {
  setTimeout(async () => {
    await sendCodeDM();
    scheduleRotation();
  }, msToNextRotation() + 3000);
}

// ---------- interactions ----------

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() && !i.isButton() && !i.isStringSelectMenu()) return;
  if (!owners.includes(i.user.id)) return i.reply({ content: '⛔ Accès refusé.', flags: EPHEMERAL }).catch(() => {});

  try {
    if (i.isChatInputCommand()) {
      switch (i.commandName) {
        case 'recherche': {
          await i.deferReply({ flags: EPHEMERAL });
          let q = (i.options.getString('requete') || '').trim();
          const type = i.options.getString('type');
          const tri = i.options.getString('tri');
          if (type) q = setToken(q, 'type', type);
          if (tri) q = setToken(q, 'sort', tri);
          return await i.editReply(await resultsMessage(cfg, q, (i.options.getInteger('page') || 1) - 1));
        }
        case 'stats':
          await i.deferReply({ flags: EPHEMERAL });
          return await i.editReply(await statsMessage(cfg));
        case 'code': {
          const { code, until } = currentCode(cfg.seed);
          return await i.reply({ content: `\`\`\`\n${code}\n\`\`\`Valide jusqu'à <t:${until}:t> (<t:${until}:R>)`, flags: EPHEMERAL });
        }
        case 'aide':
          return await i.reply({ ...helpMessage(), flags: EPHEMERAL });
      }
      return;
    }

    // boutons de pagination / menus de tri et de type
    await i.deferUpdate();
    const query = queryFromEmbed(i.message.embeds[0]?.description);
    const id = i.customId;
    let msg;
    if (id.startsWith('pg:')) msg = await resultsMessage(cfg, query, Number(id.split(':')[2]) || 0);
    else if (id === 'sort') msg = await resultsMessage(cfg, setToken(query, 'sort', i.values[0]), 0);
    else if (id === 'type') msg = await resultsMessage(cfg, setToken(query, 'type', i.values[0] === 'all' ? '' : i.values[0]), 0);
    if (msg) await i.editReply(msg);
  } catch (e) {
    console.error(e);
    const content = `⚠️ ${e.message}`.slice(0, 1900);
    if (i.deferred || i.replied) await i.editReply({ content, embeds: [], components: [] }).catch(() => {});
    else await i.reply({ content, flags: EPHEMERAL }).catch(() => {});
  }
});

client.once(Events.ClientReady, async (c) => {
  await c.application.commands.set(COMMANDS);
  console.log(`Connecté en tant que ${c.user.tag} · ${COMMANDS.length} commandes · prochain code dans ${Math.round(msToNextRotation() / 60000)} min`);
  console.log(`Invitation : https://discord.com/oauth2/authorize?client_id=${c.application.id}&scope=bot+applications.commands&permissions=0`);
  scheduleRotation();
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Connexion Discord impossible (token du bot invalide ?) :', e.message);
  process.exitCode = 1;
  client.destroy();
});
