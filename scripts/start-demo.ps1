param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repositoryRoot
$dockerDirectory = Join-Path $repositoryRoot 'dify-main\docker'
$legacyDockerDirectory = Join-Path $workspaceRoot 'dify-main\docker'
$agentNetworkDirectory = Join-Path $workspaceRoot 'agent-network'
$agentNetworkLauncher = Join-Path $agentNetworkDirectory 'run_demo.cmd'
$agentNetworkCompose = Join-Path $dockerDirectory 'docker-compose.agentnetwork.yaml'
$localImagesCompose = Join-Path $dockerDirectory 'docker-compose.local-images.yaml'

$dockerExe = 'D:\DockerDesktop\Docker\resources\bin\docker.exe'
$dockerDesktopExe = 'D:\DockerDesktop\Docker\Docker Desktop.exe'

foreach ($requiredPath in @(
    $dockerDirectory,
    $agentNetworkDirectory,
    $agentNetworkLauncher,
    $agentNetworkCompose,
    $localImagesCompose,
    $dockerExe,
    $dockerDesktopExe
)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path was not found: $requiredPath"
    }
}

function Test-DockerReady {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $dockerExe
    $startInfo.Arguments = 'info --format "{{.ServerVersion}}"'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        [void]$process.Start()
        $process.WaitForExit()
        return $process.ExitCode -eq 0
    }
    finally {
        $process.Dispose()
    }
}

function Test-ListeningPort {
    param([int]$Port)

    return $null -ne (
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    )
}

if (-not (Test-DockerReady)) {
    Write-Host 'Starting Docker Desktop...'
    Start-Process -FilePath $dockerDesktopExe -WindowStyle Normal
    for ($attempt = 1; $attempt -le 45 -and -not (Test-DockerReady); $attempt++) {
        Start-Sleep -Seconds 2
    }
}

if (-not (Test-DockerReady)) {
    throw 'Docker Desktop did not become ready within 90 seconds.'
}

if (Test-Path -LiteralPath (Join-Path $legacyDockerDirectory 'docker-compose.middleware.yaml')) {
    Write-Host 'Stopping the legacy source-deployment middleware containers...'
    Push-Location $legacyDockerDirectory
    try {
        & $dockerExe compose -p dify --env-file middleware.env -f docker-compose.middleware.yaml stop
        if ($LASTEXITCODE -ne 0) {
            throw "Stopping the legacy middleware failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-ListeningPort -Port 18080)) {
    Write-Host 'Starting the real AgentNetwork service...'
    Start-Process -FilePath $agentNetworkLauncher `
        -WorkingDirectory $agentNetworkDirectory `
        -WindowStyle Normal

    for ($attempt = 1; $attempt -le 180 -and -not (Test-ListeningPort -Port 18080); $attempt++) {
        Start-Sleep -Seconds 1
    }
}

if (-not (Test-ListeningPort -Port 18080)) {
    throw 'AgentNetwork did not become ready on port 18080 within 180 seconds.'
}

Write-Host 'Starting AgentNetwork Dify containers...'
Push-Location $dockerDirectory
try {
    & $dockerExe compose `
        -p agentnetwork-dify `
        -f docker-compose.yaml `
        -f docker-compose.agentnetwork.yaml `
        -f docker-compose.local-images.yaml `
        up -d
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$siteReady = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost' -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            $siteReady = $true
            break
        }
    }
    catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $siteReady) {
    throw 'Dify did not become reachable at http://localhost within 60 seconds.'
}

Write-Host 'AgentNetwork Dify is ready at http://localhost'
if (-not $NoBrowser) {
    Start-Process 'http://localhost'
}
