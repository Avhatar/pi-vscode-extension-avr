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

function Start-TrustedWorkspaceProcess([string]$workspace) {
    $existingIds = @(Get-DesktopProcesses | ForEach-Object Id)
    $portable = Start-Process -FilePath $Executable -ArgumentList @('--cwd', $workspace) -PassThru
    $launchedPortableProcessIds.Add($portable.Id)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $newProcesses = @(Get-DesktopProcesses | Where-Object { $existingIds -notcontains $_.Id })
        if ($newProcesses | Where-Object MainWindowTitle -eq 'Trust this workspace?') {
            throw 'Previously trusted canonical workspace prompted for trust again.'
        }
        $renderer = $newProcesses | Where-Object MainWindowTitle -eq 'Pi Code Desktop' | Select-Object -First 1
        if ($renderer) {
            return [pscustomobject]@{
                PortableProcessId = $portable.Id
                RendererProcessId = $renderer.Id
            }
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'Timed out waiting for a previously trusted workspace to open.'
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

function Close-WorkspaceProcess($workspaceProcess) {
    $renderer = Get-Process -Id $workspaceProcess.RendererProcessId -ErrorAction SilentlyContinue
    if (-not $renderer -or -not $renderer.CloseMainWindow()) {
        throw 'Could not request graceful desktop window closure.'
    }
    $deadline = (Get-Date).AddSeconds(15)
    do {
        if (-not (Get-Process -Id $workspaceProcess.PortableProcessId -ErrorAction SilentlyContinue)) {
            return
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'Desktop process did not exit within the graceful shutdown deadline.'
}

function Stop-WorkspaceProcess([int]$portableProcessId) {
    $ids = Get-ProcessTreeIds $portableProcessId
    foreach ($id in ($ids | Sort-Object -Descending)) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
}

$first = $null
$second = $null
$reopened = $null
try {
    $first = Start-WorkspaceProcess $workspaceA
    $second = Start-WorkspaceProcess $workspaceB

    if ($first.PortableProcessId -eq $second.PortableProcessId) {
        throw 'Independent launches reused the same portable process.'
    }
    Close-WorkspaceProcess $first
    Start-Sleep -Seconds 2
    $secondRenderer = Get-Process -Id $second.RendererProcessId -ErrorAction SilentlyContinue
    if (-not $secondRenderer -or $secondRenderer.MainWindowTitle -ne 'Pi Code Desktop') {
        throw 'Gracefully closing the first workspace process terminated the second workspace window.'
    }

    $reopened = Start-TrustedWorkspaceProcess $workspaceA
    Write-Output 'Portable desktop smoke passed: two independent workspaces opened, graceful closure preserved the other process, and canonical trust persisted across relaunch.'
} finally {
    foreach ($portableProcessId in ($launchedPortableProcessIds | Select-Object -Unique)) {
        Stop-WorkspaceProcess $portableProcessId
    }
    Remove-Item $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}
