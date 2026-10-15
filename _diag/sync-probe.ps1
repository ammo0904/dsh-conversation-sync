# 在公司的 cmd 貼這一行即可：
# powershell -NoProfile -Command "iwr 'https://raw.githubusercontent.com/ammo0904/dsh-conversation-sync/main/_diag/sync-probe.ps1' -OutFile \"$env:TEMP\sync-probe.ps1\"; & \"$env:TEMP\sync-probe.ps1\""
$ErrorActionPreference = 'Continue'
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$plugin  = Join-Path $env:USERPROFILE 'DSH-Plugins\dsh-conversation-sync'

Write-Output "PLUGIN_VERSION = $((Get-Content (Join-Path $plugin 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version)"
Write-Output "PLUGIN_CORE_EXISTS = $(Test-Path (Join-Path $plugin 'core.mjs'))"
Write-Output "PLUGIN_KOFFI_EXISTS = $(Test-Path (Join-Path $plugin 'node_modules\koffi'))"

$env:SYNC_HOME = $dshHome
$env:SYNC_PLUGIN = ($plugin -replace '\\', '/')
$js = @'
const home = process.env.SYNC_HOME
const plugin = 'file:///' + process.env.SYNC_PLUGIN
const { SyncClient } = await import(plugin + '/core.mjs')
const { withSessionLease } = await import(plugin + '/dsh-lease.mjs')
const fs = await import('node:fs')
const st = JSON.parse(fs.readFileSync(home + '\\conversation-sync-state.json', 'utf8'))
const client = new SyncClient({
  home,
  apiBaseUrl: 'https://149-88-70-170.sslip.io',
  deviceName: '公司電腦',
  restoreProjectKey: '--C-Users-admin-Desktop-Test--',
  ignoredSessionIds: '71498275-506f-4433-a832-5dda0713b33a b742d71b-8080-43d9-8e4e-5c1d2e6e30c3 bfdbae91-fe4e-438c-83a0-71196a8887e9 c806d6e3-e820-493c-8f03-23fe35360ff5 eee1a544-bd08-4b95-8f27-c96f691a2589 da777cb4-a2fa-43b5-8d69-e2b97f1f72d9 c68f085a-72d1-42b0-8136-4ec558a92ce3 fb5ae4bd-7450-492d-9c05-afc4116cc92f',
  withSessionLease,
})
client.state = st
const before = Object.keys(st.sessions).length
const manifest = await client._request('/v1/sync/manifest')
console.log('REMOTE_CONVERSATIONS = ' + (manifest.value.items || []).length)
let r
try { r = await client.sync({ upload: false, download: true }) } catch (e) { console.log('SYNC_THREW = ' + e.message) }
if (r) console.log('RESULT = ' + JSON.stringify({ uploaded: r.uploaded, downloaded: r.downloaded, unchanged: r.unchanged, deferred: r.deferred, remapped: r.remapped, removed: r.removed, ignored: r.ignored, errors: r.errors.slice(0, 5), unresolved: r.unresolved.length, skipped: r.skipped.length }))
const after = JSON.parse(fs.readFileSync(home + '\\conversation-sync-state.json', 'utf8'))
const ids = Object.keys(after.sessions)
console.log('TRACKED_BEFORE = ' + before + ' ; TRACKED_AFTER = ' + ids.length)
console.log('TARGETS_IN_STATE = ' + ids.filter((id) => id.startsWith('3c31299e') || id.startsWith('1a93183a')).join(', '))
'@
$jsPath = Join-Path $env:TEMP 'sync-probe.mjs'
Set-Content -LiteralPath $jsPath -Value $js -Encoding UTF8

Push-Location $plugin
node $jsPath 2>&1 | ForEach-Object { $_ }
Pop-Location
Write-Output 'SCRIPT_DONE'
Write-Output '--- 目標目錄檢查 ---'
$k = '--C-Users-admin-Desktop-Test--'
$dir = Join-Path $dshHome "sessions\$k"
foreach ($id in '3c31299e-195a-45a4-bb9a-bc3c5a1219e8', '1a93183a-5ace-4bfe-b2b1-f2588190fbdb') {
  $hits = Get-ChildItem (Join-Path $dshHome 'sessions') -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match $id }
  if ($hits) { foreach ($h in $hits) { Write-Output ("  FOUND $($h.FullName)") } } else { Write-Output "  MISSING $id" }
}
