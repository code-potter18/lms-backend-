$ErrorActionPreference = "Stop"

$postgresBin = "C:\Program Files\PostgreSQL\18\bin"
$initdb = Join-Path $postgresBin "initdb.exe"
$pgCtl = Join-Path $postgresBin "pg_ctl.exe"
$psql = Join-Path $postgresBin "psql.exe"
$createdb = Join-Path $postgresBin "createdb.exe"
$testRoot = Join-Path $env:LOCALAPPDATA "HMS-New-Lab-Walkin-Test"
$testRootParent = Split-Path $testRoot -Parent
$dataDirectory = Join-Path $testRoot "data"
$logFile = Join-Path $testRoot "postgres.log"
$passwordFile = Join-Path $testRoot "bootstrap-password.tmp"
$envFile = Join-Path $PSScriptRoot "..\.env.test.local"
$databaseName = "hms_new_lab_walkin_test"
$databaseUser = "hms_test_admin"
$postgresPort = 55432
$apiPort = 5011

foreach ($tool in @($initdb, $pgCtl, $psql, $createdb)) {
    if (-not (Test-Path $tool)) {
        throw "Required PostgreSQL utility is missing: $tool"
    }
}
if (Test-Path $testRoot) {
    throw "Test data directory already exists; refusing to overwrite it: $testRoot"
}
if (Test-Path $envFile) {
    throw "Test environment file already exists; refusing to overwrite it: $envFile"
}
if (Test-NetConnection -ComputerName 127.0.0.1 -Port $postgresPort -InformationLevel Quiet -WarningAction SilentlyContinue) {
    throw "Port $postgresPort is already in use; no database was created."
}

New-Item -ItemType Directory -Path $testRootParent -Force | Out-Null
New-Item -ItemType Directory -Path $testRoot | Out-Null
$passwordBytes = New-Object byte[] 36
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($passwordBytes)
$databasePassword = [Convert]::ToBase64String($passwordBytes).TrimEnd("=").Replace("+", "A").Replace("/", "B")
$jwtBytes = New-Object byte[] 48
$rng.GetBytes($jwtBytes)
$rng.Dispose()
$jwtSecret = [Convert]::ToBase64String($jwtBytes).TrimEnd("=").Replace("+", "C").Replace("/", "D")
[System.IO.File]::WriteAllText($passwordFile, $databasePassword, [System.Text.Encoding]::ASCII)

try {
    & $initdb --username=$databaseUser --pwfile=$passwordFile --auth-local=scram-sha-256 --auth-host=scram-sha-256 --encoding=UTF8 --data-checksums --pgdata=$dataDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "Could not initialize the isolated PostgreSQL cluster (exit $LASTEXITCODE)."
    }
} finally {
    if (Test-Path $passwordFile) {
        Remove-Item -LiteralPath $passwordFile -Force
    }
}

& $pgCtl start --pgdata=$dataDirectory --log=$logFile --options="-h 127.0.0.1 -p $postgresPort -c listen_addresses=127.0.0.1" --wait
if ($LASTEXITCODE -ne 0) {
    throw "Could not start the isolated PostgreSQL cluster. See $logFile."
}

$env:PGPASSWORD = $databasePassword
$identity = & $psql -X -w -h 127.0.0.1 -p $postgresPort -U $databaseUser -d postgres -Atc "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
if ($LASTEXITCODE -ne 0 -or $identity.Trim() -ne "postgres|$databaseUser|127.0.0.1|$postgresPort") {
    throw "Local cluster verification failed; no test database was created."
}

& $createdb -h 127.0.0.1 -p $postgresPort -U $databaseUser -w $databaseName
if ($LASTEXITCODE -ne 0) {
    throw "Could not create the isolated test database."
}

$testIdentity = & $psql -X -w -h 127.0.0.1 -p $postgresPort -U $databaseUser -d $databaseName -Atc "SELECT current_database(), current_user, inet_server_addr(), inet_server_port(), (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public');"
if ($LASTEXITCODE -ne 0 -or $testIdentity.Trim() -ne "$databaseName|$databaseUser|127.0.0.1|$postgresPort|0") {
    throw "The new test database did not pass isolation verification."
}

$encodedPassword = [Uri]::EscapeDataString($databasePassword)
$databaseUrl = "postgresql://${databaseUser}:${encodedPassword}@127.0.0.1:${postgresPort}/${databaseName}"
$envContents = @(
    "DATABASE_URL=$databaseUrl"
    "JWT_SECRET=$jwtSecret"
    "PORT=$apiPort"
    "BCRYPT_SALT_ROUNDS=4"
) -join "`n"
[System.IO.File]::WriteAllText($envFile, $envContents + "`n", (New-Object System.Text.UTF8Encoding($false)))
Remove-Item Env:\PGPASSWORD

Write-Output "Verified isolated PostgreSQL cluster and empty test database."
Write-Output "Database: postgresql://127.0.0.1:$postgresPort/$databaseName"
Write-Output "Backend API: http://127.0.0.1:$apiPort/api"
Write-Output "Private test config: $envFile"
Write-Output "Existing .env files and the existing PostgreSQL service were not changed."
