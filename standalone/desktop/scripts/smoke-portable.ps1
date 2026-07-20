param(
    [string]$Workspace,
    [string]$Executable,
    [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Workspace) {
    $Workspace = (Resolve-Path (Join-Path $packageRoot '..\..')).Path
}
if (-not $Executable) {
    $packageVersion = (Get-Content (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json).version
    $Executable = (Resolve-Path (
        Join-Path $packageRoot "release\Pi-Code-Desktop-Portable-$packageVersion.exe"
    )).Path
}
$env:ELECTRON_RUN_AS_NODE = $null
$startedAt = Get-Date
$deadline = $startedAt.AddSeconds($TimeoutSeconds)

function Get-DesktopProcesses {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like 'Pi*Code*Desktop*' -and $_.StartTime -ge $startedAt
    }
}

function Wait-ForWindow([string]$title) {
    do {
        $errorWindow = Get-DesktopProcesses | Where-Object {
            $_.MainWindowTitle -eq 'Error' -or $_.MainWindowTitle -eq 'Pi Code Desktop failed to start'
        } | Select-Object -First 1
        if ($errorWindow) {
            throw "Packaged desktop opened an error window: $($errorWindow.MainWindowTitle)"
        }
        $window = Get-DesktopProcesses | Where-Object {
            $_.MainWindowTitle -eq $title
        } | Select-Object -First 1
        if ($window) { return $window }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for packaged desktop window: $title"
}

try {
    Start-Process -FilePath $Executable -ArgumentList @('--cwd', $Workspace) | Out-Null
    $trustProcess = Wait-ForWindow 'Trust this workspace?'
    $shell = New-Object -ComObject WScript.Shell
    if (-not $shell.AppActivate($trustProcess.Id)) {
        throw 'Could not activate the workspace trust dialog.'
    }
    Start-Sleep -Milliseconds 250
    $shell.SendKeys('{TAB}{ENTER}')

    Wait-ForWindow 'Pi Code Desktop' | Out-Null
    Write-Output 'Portable desktop smoke passed: workspace trust completed and the shared agent host opened the renderer window.'
} finally {
    Get-DesktopProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}
