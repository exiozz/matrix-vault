"""Bot Discord du Matrix Vault — à lancer chez ton hébergeur :
    pip install -r requirements.txt
    python bot.py
Variables : DISCORD_TOKEN, SEED, WORKER_URL, OWNER_IDS, SITE_URL (fichier .env ou panneau de l'hébergeur).
"""
import asyncio
import logging
import os
import re
import sys
from pathlib import Path
from typing import Optional

import discord
from discord import app_commands

from search import CATEGORIES, SORTS
from vault import (CODE_TITLE, Vault, code_message, current_code, help_message, query_from_embed,
                   results_message, seconds_to_next_rotation, set_token, stats_message)

# .env optionnel. Les variables de l'hébergeur sont prioritaires, sauf si elles sont vides
# (certains panneaux définissent DISCORD_TOKEN vide par défaut).
env_file = Path(__file__).with_name(".env")
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*?)\s*$", line)
        if m and not os.environ.get(m.group(1), "").strip():
            os.environ[m.group(1)] = m.group(2).strip("\"'")

missing = [k for k in ("DISCORD_TOKEN", "SEED", "WORKER_URL", "OWNER_IDS") if not os.environ.get(k)]
if missing:
    sys.exit(f"Variables manquantes : {', '.join(missing)} (voir .env.example)")

SEED = os.environ["SEED"]
OWNERS = {int(x) for x in os.environ["OWNER_IDS"].replace(" ", "").split(",") if x}
SITE_URL = os.environ.get("SITE_URL", "https://exiozz.github.io/matrix-vault/")
vault = Vault(SEED, os.environ["WORKER_URL"])
log = logging.getLogger("vault")


# ---------- conversion des messages de vault.py en objets discord.py ----------

def build(msg):
    e = msg["embed"]
    embed = discord.Embed(title=e.get("title"), description=e.get("description"), color=e.get("color"))
    if e.get("footer"):
        embed.set_footer(text=e["footer"])
    for name, value, inline in e.get("fields", []):
        embed.add_field(name=name, value=value[:1024], inline=inline)

    # Vue « figée » (stop) : composants envoyés sans être gardés en mémoire ; on_interaction
    # traite les clics à partir du custom_id et de la requête stockée dans l'embed, même après redémarrage.
    view = discord.ui.View(timeout=None)
    for custom_id, label, disabled in msg.get("buttons", []):
        view.add_item(discord.ui.Button(style=discord.ButtonStyle.secondary, custom_id=custom_id, label=label, disabled=disabled, row=0))
    for row, (custom_id, placeholder, options) in enumerate(msg.get("selects", []), start=1):
        view.add_item(discord.ui.Select(custom_id=custom_id, placeholder=placeholder, row=row,
                                        options=[discord.SelectOption(label=l, value=v, default=d) for l, v, d in options]))
    view.stop()
    return {"content": None, "embed": embed, "view": view if view.children else discord.utils.MISSING}


# ---------- client ----------

class VaultBot(discord.Client):
    def __init__(self):
        super().__init__(intents=discord.Intents.none())
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self):
        self.tree.interaction_check = only_owners
        await self.tree.sync()
        self.loop.create_task(rotation_loop())

    async def on_ready(self):
        log.info("Connecté en tant que %s · prochain code dans %d min", self.user, seconds_to_next_rotation() // 60)
        log.info("Invitation : https://discord.com/oauth2/authorize?client_id=%s&scope=bot+applications.commands&permissions=0", self.user.id)

    async def on_interaction(self, i: discord.Interaction):
        if i.type is not discord.InteractionType.component:
            return
        if i.user.id not in OWNERS:
            return await i.response.send_message("⛔ Accès refusé.", ephemeral=True)
        cid = i.data.get("custom_id", "")
        query = query_from_embed(i.message.embeds[0].description if i.message and i.message.embeds else "")
        if cid.startswith("pg:"):
            page, q = int(cid.split(":")[2]) if cid.count(":") == 2 else 0, query
        elif cid == "sort":
            page, q = 0, set_token(query, "sort", i.data["values"][0])
        elif cid == "type":
            value = i.data["values"][0]
            page, q = 0, set_token(query, "type", "" if value == "all" else value)
        else:
            return
        await i.response.defer()
        try:
            await i.edit_original_response(**build(await results_message(vault, q, page)))
        except Exception as e:
            log.exception("composant")
            await i.edit_original_response(content=f"⚠️ {e}"[:1900], embed=None, view=None)


bot = VaultBot()


async def only_owners(i: discord.Interaction) -> bool:
    if i.user.id in OWNERS:
        return True
    await i.response.send_message("⛔ Accès refusé.", ephemeral=True)
    return False


async def rotation_loop():
    """Envoie le nouveau code en MP juste après chaque rotation (30 min), en supprimant l'ancien."""
    await bot.wait_until_ready()
    while not bot.is_closed():
        await asyncio.sleep(seconds_to_next_rotation() + 3)
        msg = build(code_message(SEED))
        link = discord.ui.View()
        link.add_item(discord.ui.Button(style=discord.ButtonStyle.link, label="Ouvrir le vault", url=SITE_URL))
        for uid in OWNERS:
            try:
                user = await bot.fetch_user(uid)
                dm = await user.create_dm()
                async for m in dm.history(limit=20):
                    if m.author.id == bot.user.id and m.embeds and m.embeds[0].title == CODE_TITLE:
                        await m.delete()
                await dm.send(embed=msg["embed"], view=link)
            except Exception as e:
                log.warning("MP impossible à %s (il faut partager un serveur avec le bot) : %s", uid, e)


# ---------- commandes ----------

def installable(cmd):
    """Commande utilisable sur un serveur, en MP et en appli installée sur le compte."""
    cmd = app_commands.allowed_installs(guilds=True, users=True)(cmd)
    return app_commands.allowed_contexts(guilds=True, dms=True, private_channels=True)(cmd)


async def reply_error(i: discord.Interaction, e: Exception):
    log.exception("commande")
    await i.edit_original_response(content=f"⚠️ {e}"[:1900], embed=None, view=None)


@bot.tree.command(name="recherche", description="Chercher dans le vault (syntaxe avancée : /aide)")
@app_commands.describe(requete="ex : rapport type:doc size:>10mo after:30d -tag:vieux", tri="Ordre des résultats",
                       type="Type de fichier", page="Page de résultats")
@app_commands.choices(
    tri=[app_commands.Choice(name=label, value=v) for v, label in SORTS.items()],
    type=[app_commands.Choice(name=c["label"], value=v) for v, c in CATEGORIES.items()],
)
@installable
async def recherche(i: discord.Interaction, requete: Optional[app_commands.Range[str, 0, 400]] = None,
                    tri: Optional[app_commands.Choice[str]] = None, type: Optional[app_commands.Choice[str]] = None,
                    page: Optional[app_commands.Range[int, 1]] = None):
    await i.response.defer(ephemeral=True, thinking=True)
    q = (requete or "").strip()
    if type:
        q = set_token(q, "type", type.value)
    if tri:
        q = set_token(q, "sort", tri.value)
    try:
        await i.edit_original_response(**build(await results_message(vault, q, (page or 1) - 1)))
    except Exception as e:
        await reply_error(i, e)


@bot.tree.command(name="stats", description="Statistiques du vault")
@installable
async def stats(i: discord.Interaction):
    await i.response.defer(ephemeral=True, thinking=True)
    try:
        await i.edit_original_response(**build(await stats_message(vault)))
    except Exception as e:
        await reply_error(i, e)


@bot.tree.command(name="code", description="Code d'accès actuel du site (visible par toi seul)")
@installable
async def code(i: discord.Interaction):
    c, until = current_code(SEED)
    await i.response.send_message(f"```\n{c}\n```Valide jusqu'à <t:{until}:t> (<t:{until}:R>)", ephemeral=True)


@bot.tree.command(name="aide", description="Syntaxe de recherche avancée")
@installable
async def aide(i: discord.Interaction):
    await i.response.send_message(embed=build(help_message())["embed"], ephemeral=True)


if __name__ == "__main__":
    try:
        bot.run(os.environ["DISCORD_TOKEN"], root_logger=True)
    except discord.LoginFailure:
        sys.exit("Connexion Discord impossible : token du bot invalide.")
