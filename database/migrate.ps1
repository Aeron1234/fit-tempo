param(
  [Parameter(Mandatory = $true)][string]$Database,
  [string]$Psql = 'psql'
)

$ErrorActionPreference = 'Stop'
$migrationDir = Join-Path $PSScriptRoot 'migrations'
$files = @(Get-ChildItem -LiteralPath $migrationDir -Filter '*.sql' | Sort-Object Name)
if ($files.Count -eq 0) { throw 'No migrations found.' }

# Connection is supplied through standard PGHOST/PGPORT/PGUSER/PGPASSWORD (or a
# user-managed service file). Never pass a password or URL on a command line.
function Invoke-Psql([string[]]$Arguments) {
  $result = & $Psql -X -w -v ON_ERROR_STOP=1 -d $Database @Arguments
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE)." }
  return $result
}

Invoke-Psql -Arguments @('-c', 'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL CHECK (sha256 ~ ''^[0-9a-f]{64}$''), applied_at timestamptz NOT NULL DEFAULT now())') | Out-Null
foreach ($file in $files) {
  if ($file.Name -notmatch '^\d{3}_[a-z0-9_]+\.sql$') { throw "Invalid migration filename: $($file.Name)" }
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $prior = @(Invoke-Psql -Arguments @('-A', '-t', '-c', "SELECT sha256 FROM schema_migrations WHERE name = '$($file.Name)'")) -join ''
  if ($prior) {
    if ($prior -ne $hash) { throw "Applied migration changed: $($file.Name)" }
    Write-Output "Already applied: $($file.Name)"
    continue
  }
  # -1 encloses the SQL and its ledger insert in one server transaction. An SQL
  # error stops psql, rolls back both and leaves no applied marker.
  Invoke-Psql -Arguments @('-1', '-f', $file.FullName, '-c', "INSERT INTO schema_migrations(name, sha256) VALUES ('$($file.Name)', '$hash')") | Out-Null
  Write-Output "Applied: $($file.Name)"
}
