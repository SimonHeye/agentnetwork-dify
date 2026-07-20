param()

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$dockerDirectory = Join-Path $repositoryRoot 'docker'
$apiDirectory = Join-Path $repositoryRoot 'api'
$webDirectory = Join-Path $repositoryRoot 'web'

$dockerExe = 'D:\DockerDesktop\Docker\resources\bin\docker.exe'
$uvExe = 'D:\DifyDevTools\uv\uv.exe'
$pnpmCmd = 'D:\DifyDevTools\npm-global\pnpm.cmd'
$nodeDirectory = 'D:\DifyDevTools\node-v22.22.1-win-x64'
$npmGlobalDirectory = 'D:\DifyDevTools\npm-global'

foreach ($requiredPath in @($dockerDirectory, $apiDirectory, $webDirectory, $dockerExe, $uvExe, $pnpmCmd, $nodeDirectory)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required path was not found: $requiredPath"
    }
}

function Start-LogWindow {
    param(
        [Parameter(Mandatory)]
        [string]$Title,
        [Parameter(Mandatory)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory)]
        [string]$Command
    )

    $windowCommand = @"
`$Host.UI.RawUI.WindowTitle = '$Title'
Set-Location -LiteralPath '$WorkingDirectory'
$Command
"@
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($windowCommand))
    Start-Process -FilePath 'powershell.exe' -WorkingDirectory $WorkingDirectory -ArgumentList @(
        '-NoExit',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', $encodedCommand
    )
}

Write-Host 'Starting Dify middleware containers...'
$env:PATH = "$(Split-Path -Parent $dockerExe);$env:PATH"
Push-Location $dockerDirectory
try {
    & $dockerExe compose --env-file middleware.env -f docker-compose.middleware.yaml -p dify up -d
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$apiCommand = @'
$env:UV_CACHE_DIR = 'D:\DifyDevTools\uv-cache'
$env:UV_PYTHON_INSTALL_DIR = 'D:\DifyDevTools\uv-python'
$env:LOG_OUTPUT_FORMAT = 'text'
$env:LOG_FORMAT = '%(asctime)s,%(msecs)d %(levelname)-2s [%(filename)s:%(lineno)d] %(req_id)s %(message)s'
& 'D:\DifyDevTools\uv\uv.exe' run --no-sync flask run --host 0.0.0.0 --port=5001 --debug
'@

$workerCommand = @'
$env:UV_CACHE_DIR = 'D:\DifyDevTools\uv-cache'
$env:UV_PYTHON_INSTALL_DIR = 'D:\DifyDevTools\uv-python'
$env:LOG_OUTPUT_FORMAT = 'text'
$env:LOG_FORMAT = '%(asctime)s,%(msecs)d %(levelname)-2s [%(filename)s:%(lineno)d] %(req_id)s %(message)s'
& 'D:\DifyDevTools\uv\uv.exe' run --no-sync celery -A app.celery worker -P solo --without-gossip --without-mingle --loglevel INFO -Q dataset,dataset_summary,priority_dataset,priority_pipeline,pipeline,mail,ops_trace,app_deletion,plugin,workflow_storage,conversation,workflow,schedule_poller,schedule_executor,triggered_workflow_dispatcher,trigger_refresh_executor,retention,workflow_based_app_execution
'@

$webCommand = @'
$env:PATH = 'D:\DifyDevTools\node-v22.22.1-win-x64;D:\DifyDevTools\npm-global;' + $env:PATH
& 'D:\DifyDevTools\npm-global\pnpm.cmd' run dev:vinext
'@

Start-LogWindow -Title 'Dify API' -WorkingDirectory $apiDirectory -Command $apiCommand
Start-LogWindow -Title 'Dify Worker' -WorkingDirectory $apiDirectory -Command $workerCommand
Start-LogWindow -Title 'Dify Web' -WorkingDirectory $webDirectory -Command $webCommand

Write-Host 'Dify is starting. Wait for the Web window to report ready, then open http://localhost:3000.'
