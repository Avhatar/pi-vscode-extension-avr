param(
    [string]$Executable,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Executable) {
    $packageVersion = (Get-Content (Join-Path $packageRoot 'package.json') -Raw | ConvertFrom-Json).version
    $Executable = (Resolve-Path (
        Join-Path $packageRoot "release\Pi-Code-Desktop-Portable-$packageVersion.exe"
    )).Path
}
$env:ELECTRON_RUN_AS_NODE = $null
$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pi-code-desktop-smoke-$([guid]::NewGuid())"
$workspaceA = Join-Path $temporaryRoot 'workspace-a'
$workspaceB = Join-Path $temporaryRoot 'workspace-b'
New-Item -ItemType Directory -Path $workspaceA, $workspaceB -Force | Out-Null
$launchedPortableProcessIds = [System.Collections.Generic.List[int]]::new()

function Get-DesktopProcesses {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like 'Pi*Code*Desktop*'
    }
}

function Wait-ForNewWindow([string]$title, [int[]]$excludedProcessIds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $errorWindow = Get-DesktopProcesses | Where-Object {
            $excludedProcessIds -notcontains $_.Id -and (
                $_.MainWindowTitle -eq 'Error' -or
                $_.MainWindowTitle -eq 'Pi Code Desktop failed to start'
            )
        } | Select-Object -First 1
        if ($errorWindow) {
            throw "Packaged desktop opened an error window: $($errorWindow.MainWindowTitle)"
        }
        $window = Get-DesktopProcesses | Where-Object {
            $excludedProcessIds -notcontains $_.Id -and $_.MainWindowTitle -eq $title
        } | Select-Object -First 1
        if ($window) { return $window }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for new packaged desktop window: $title"
}

function Start-WorkspaceProcess([string]$workspace) {
    $existingIds = @(Get-DesktopProcesses | ForEach-Object Id)
    $portable = Start-Process -FilePath $Executable -ArgumentList @('--cwd', $workspace) -PassThru
    $launchedPortableProcessIds.Add($portable.Id)
    $trustProcess = Wait-ForNewWindow 'Trust this workspace?' $existingIds
    $shell = New-Object -ComObject WScript.Shell
    if (-not $shell.AppActivate($trustProcess.Id)) {
        throw 'Could not activate the workspace trust dialog.'
    }
    Start-Sleep -Milliseconds 250
    $shell.SendKeys('{TAB}{ENTER}')
    $renderer = Wait-ForNewWindow 'Pi Code Desktop' $existingIds
    return [pscustomobject]@{
        PortableProcessId = $portable.Id
        RendererProcessId = $renderer.Id
    }
}

function Get-ProcessTreeIds([int]$rootProcessId) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $pending = [System.Collections.Generic.Queue[int]]::new()
    $result = [System.Collections.Generic.HashSet[int]]::new()
    $pending.Enqueue($rootProcessId)
    while ($pending.Count -gt 0) {
        $current = $pending.Dequeue()
        if (-not $result.Add($current)) { continue }
        foreach ($child in $all | Where-Object ParentProcessId -eq $current) {
            $pending.Enqueue([int]$child.ProcessId)
        }
    }
    return @($result)
}

function Stop-WorkspaceProcess([int]$portableProcessId) {
    $ids = Get-ProcessTreeIds $portableProcessId
    foreach ($id in ($ids | Sort-Object -Descending)) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
}

$first = $null
$second = $null
try {
    $first = Start-WorkspaceProcess $workspaceA
    $second = Start-WorkspaceProcess $workspaceB

    if ($first.PortableProcessId -eq $second.PortableProcessId) {
        throw 'Independent launches reused the same portable process.'
    }
    Stop-WorkspaceProcess $first.PortableProcessId
    Start-Sleep -Seconds 2
    $secondRenderer = Get-Process -Id $second.RendererProcessId -ErrorAction SilentlyContinue
    if (-not $secondRenderer -or $secondRenderer.MainWindowTitle -ne 'Pi Code Desktop') {
        throw 'Stopping the first workspace process terminated the second workspace window.'
    }

    Write-Output 'Portable desktop smoke passed: two independent workspace processes opened, and the second remained alive after the first stopped.'
} finally {
    foreach ($portableProcessId in ($launchedPortableProcessIds | Select-Object -Unique)) {
        Stop-WorkspaceProcess $portableProcessId
    }
    Remove-Item $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}
