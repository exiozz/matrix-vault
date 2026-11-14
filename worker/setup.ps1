﻿# Installation du Matrix Vault : Worker Cloudflare + préparation du bot (bot/.env).
# Lancer depuis le dossier worker :  powershell -ExecutionPolicy Bypass -File .\setup.ps1
# Les tokens sont saisis masqués ; seuls bot/.env (ignoré par git) et Cloudflare les reçoivent.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repo = 'exiozz/vault-data'

function Ask-Secret($label) {
  $s = Read-Host -AsSecureString $label
  $p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
  if (-not $p.Trim()) { throw "$label : valeur vide" }
  return $p.Trim()
}
function Ask($label) {
  $v = (Read-Host $label).Trim()
  if (-not $v) { throw "$label : valeur vide" }
  return $v
}
function Step($t) { Write-Host "`n== $t" -ForegroundColor Green }

Step 'Connexion Cloudflare'
# `wrangler whoami` renvoie 0 même sans connexion : on lit sa sortie.
$who = npx wrangler whoami 2>&1 | Out-String
if ($who -match 'not authenticated' -or $LASTEXITCODE -ne 0) {
  npx wrangler login
  $who = npx wrangler whoami 2>&1 | Out-String
  if ($who -match 'not authenticated') { throw 'Connexion Cloudflare échouée' }
}
Write-Host '  connecté à Cloudflare'

Step 'Valeurs'
$gh = Ask-Secret 'Token GitHub (vault-data, Contents read/write)'
try {
  Invoke-RestMethod "https://api.github.com/repos/$repo" -Headers @{ Authorization = "Bearer $gh"; 'User-Agent' = 'matrix-vault' } | Out-Null
  Write-Host '  token GitHub OK'
} catch { throw "Le token GitHub n'a pas accès à $repo" }

$dt = Ask-Secret 'Token du bot Discord'
try {
  $me = Invoke-RestMethod 'https://discord.com/api/v10/users/@me' -Headers @{ Authorization = "Bot $dt" }
  Write-Host "  bot OK : $($me.username)"
} catch { throw 'Token du bot Discord invalide' }
$owners = Ask 'Ton ID Discord (plusieurs : séparés par des virgules)'
$seed = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

Step 'Déploiement du Worker'
$out = npx wrangler deploy 2>&1 | Out-String
Write-Host $out
$url = ([regex]'https://[\w.-]+\.workers\.dev').Match($out).Value
if (-not $url) { throw 'URL du Worker introuvable dans la sortie de deploy' }

Step 'Secrets du Worker'
foreach ($pair in @(@('GH_TOKEN', $gh), @('SEED', $seed))) {
  $pair[1] | npx wrangler secret put $pair[0] | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Échec du secret $($pair[0])" }
  Write-Host "  $($pair[0]) enregistré"
}

Step 'Site'
Set-Content -Encoding utf8 ..\docs\config.js "// URL du Cloudflare Worker (affichée par ``npx wrangler deploy``)`nwindow.VAULT_API = '$url';"
git -C .. add docs/config.js
git -C .. commit -q -m "config: URL du Worker"
git -C .. push -q
Write-Host '  config.js mis à jour et poussé (le site se met à jour en ~1 min)'

Step 'Bot'
$envPath = Join-Path (Resolve-Path ..\bot) '.env'
@"
DISCORD_TOKEN=$dt
SEED=$seed
WORKER_URL=$url
OWNER_IDS=$owners
SITE_URL=https://exiozz.github.io/matrix-vault/
"@ | Set-Content -Encoding ascii $envPath
Write-Host "  $envPath créé (ne le partage pas, il contient le token du bot)"
Write-Host "`nEnvoie le dossier bot/ ET docs/search.js chez ton hébergeur (garde l'arborescence), puis : npm install ; npm start"
Write-Host 'Ou recopie les 5 lignes de bot/.env dans les variables d''environnement de ton hébergeur.'
