# Installation complète du Matrix Vault (Worker Cloudflare + bot Discord).
# Lancer depuis le dossier worker :  powershell -ExecutionPolicy Bypass -File .\setup.ps1
# Les tokens sont saisis masqués et envoyés directement à Cloudflare ; rien n'est écrit sur le disque.

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
npx wrangler whoami 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { npx wrangler login; if ($LASTEXITCODE -ne 0) { throw 'Connexion Cloudflare échouée' } }

Step 'Valeurs (voir README)'
$gh = Ask-Secret 'Token GitHub (fine-grained, vault-data, Contents read/write)'
try {
  Invoke-RestMethod "https://api.github.com/repos/$repo" -Headers @{ Authorization = "Bearer $gh"; 'User-Agent' = 'matrix-vault' } | Out-Null
  Write-Host '  token GitHub OK'
} catch { throw "Le token GitHub n'a pas accès à $repo" }

$dt = Ask-Secret 'Token du bot Discord'
try {
  $me = Invoke-RestMethod 'https://discord.com/api/v10/users/@me' -Headers @{ Authorization = "Bot $dt" }
  Write-Host "  bot OK : $($me.username)"
} catch { throw 'Token du bot Discord invalide' }

$appId  = Ask 'Application ID'
$pubKey = Ask 'Public Key'
if ($pubKey -notmatch '^[0-9a-fA-F]{64}$') { throw 'Public Key invalide (64 caractères hexadécimaux attendus)' }
$owners = Ask 'Ton ID Discord (plusieurs : séparés par des virgules)'
$seed = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })

Step 'Déploiement du Worker'
$out = npx wrangler deploy 2>&1 | Out-String
Write-Host $out
$url = ([regex]'https://[\w.-]+\.workers\.dev').Match($out).Value
if (-not $url) { throw "URL du Worker introuvable dans la sortie de deploy" }

Step 'Secrets'
$secrets = [ordered]@{ GH_TOKEN = $gh; DISCORD_TOKEN = $dt; DISCORD_APP_ID = $appId; DISCORD_PUBLIC_KEY = $pubKey; OWNER_IDS = $owners; SEED = $seed }
foreach ($k in $secrets.Keys) {
  $secrets[$k] | npx wrangler secret put $k | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Échec du secret $k" }
  Write-Host "  $k enregistré"
}

Step 'Commandes slash'
$env:DISCORD_TOKEN = $dt; $env:DISCORD_APP_ID = $appId
node register-commands.mjs
Remove-Item Env:DISCORD_TOKEN, Env:DISCORD_APP_ID

Step 'Site'
Set-Content -Encoding utf8 ..\docs\config.js "// URL du Cloudflare Worker (affichée par ``npx wrangler deploy``)`nwindow.VAULT_API = '$url';"
git -C .. add docs/config.js
git -C .. commit -q -m "config: URL du Worker"
git -C .. push -q
Write-Host '  config.js mis à jour et poussé (le site se met à jour en ~1 min)'

Step 'Il reste 2 clics'
Write-Host "1. Developer Portal > General Information > Interactions Endpoint URL :"
Write-Host "   $url/discord" -ForegroundColor Yellow
Write-Host "   puis Save Changes"
Write-Host "2. Inviter le bot :"
Write-Host "   https://discord.com/oauth2/authorize?client_id=$appId&scope=bot+applications.commands&permissions=0" -ForegroundColor Yellow
Write-Host "`nSite : https://exiozz.github.io/matrix-vault/  (code : /code dans Discord)"
