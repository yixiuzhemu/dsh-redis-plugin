# Live integration runner.
# Connection defaults to the LAN Redis; the password is read from the
# environment so no secret is committed to the repo.
#
#   $env:REDIS_LIVE_PASSWORD = 'your-password'
#   powershell -ExecutionPolicy Bypass -File scripts/run-live.ps1
param(
  [string] $Host_ = '192.168.4.189',
  [int]    $Port = 6379,
  [string] $Password = ''
)

$env:REDIS_LIVE = '1'
$env:REDIS_LIVE_HOST = $Host_
$env:REDIS_LIVE_PORT = "$Port"
if ($Password) { $env:REDIS_LIVE_PASSWORD = $Password }
if (-not $env:REDIS_LIVE_PASSWORD) {
  Write-Warning 'REDIS_LIVE_PASSWORD is not set; connecting without AUTH.'
}
npx.cmd vitest run test/live.integration.test.ts
