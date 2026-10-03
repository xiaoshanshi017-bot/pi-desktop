$ErrorActionPreference = 'Stop'
$taskWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $taskWorkspace 'release')) + [System.IO.Path]::DirectorySeparatorChar
$taskShortcutPath = Join-Path $taskWorkspace '启动 Pi Desktop.lnk'
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
$taskExecutable = [System.IO.Path]::GetFullPath($taskShortcut.TargetPath)
if (-not $taskExecutable.StartsWith($taskReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetFileName($taskExecutable) -ne 'Pi Desktop.exe' -or -not (Test-Path -LiteralPath $taskExecutable -PathType Leaf)) {
    throw 'Shortcut must target an existing Pi Desktop executable inside this workspace release directory.'
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$taskOldRoots = @(Get-CimInstance Win32_Process -Filter "Name = 'Pi Desktop.exe'" | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($taskReleaseRoot, [System.StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '--type='
})
$taskRestarted = @()
foreach ($taskOldRoot in $taskOldRoots) {
    $taskPid = [int]$taskOldRoot.ProcessId
    $taskProcess = Get-Process -Id $taskPid -ErrorAction SilentlyContinue
    if (-not $taskProcess) { continue }
    $taskCloseRequested = $taskProcess.CloseMainWindow()
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(15)
    $taskConfirmed = $false
    while ([DateTime]::UtcNow -lt $taskDeadline -and (Get-Process -Id $taskPid -ErrorAction SilentlyContinue)) {
        try {
            $taskPidCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $taskPid)
            $taskWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $taskPidCondition)
            foreach ($taskWindow in $taskWindows) {
                if ($taskWindow.Current.Name -eq '任务仍在运行') {
                    $taskButtonCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '停止并退出')
                    $taskButton = $taskWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $taskButtonCondition)
                    if ($taskButton) {
                        $taskInvoke = $taskButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                        $taskInvoke.Invoke()
                        $taskConfirmed = $true
                    }
                }
            }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    $taskForced = $false
    if (Get-Process -Id $taskPid -ErrorAction SilentlyContinue) {
        $taskRemaining = Get-CimInstance Win32_Process -Filter "ProcessId = $taskPid"
        if ($taskRemaining.ExecutablePath -ne $taskOldRoot.ExecutablePath) { throw 'Old process identity changed during restart.' }
        & taskkill.exe /PID $taskPid /T /F | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not stop old Pi Desktop process $taskPid." }
        $taskForced = $true
    }
    $taskRestarted += [pscustomobject]@{pid=$taskPid;executable=$taskOldRoot.ExecutablePath;closeRequested=$taskCloseRequested;confirmedStop=$taskConfirmed;forced=$taskForced}
}

$taskNewProcess = Start-Process -FilePath $taskExecutable -WorkingDirectory (Split-Path -Parent $taskExecutable) -PassThru
$taskStartupDeadline = [DateTime]::UtcNow.AddSeconds(25)
$taskReady = $false
while ([DateTime]::UtcNow -lt $taskStartupDeadline) {
    $taskNewProcess.Refresh()
    if ($taskNewProcess.HasExited) { throw "New Pi Desktop exited before its window opened (exit $($taskNewProcess.ExitCode))." }
    if ($taskNewProcess.MainWindowHandle -ne 0) { $taskReady = $true; break }
    Start-Sleep -Milliseconds 250
}
if (-not $taskReady) { throw 'New Pi Desktop window did not open within 25 seconds.' }
$taskActual = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskNewProcess.Id)"
if ($taskActual.ExecutablePath -ne $taskExecutable) { throw 'Started executable differs from the upgraded shortcut.' }
$taskReport = [pscustomobject]@{target=$taskExecutable;pid=$taskNewProcess.Id;windowTitle=$taskNewProcess.MainWindowTitle;windowOpened=$taskReady;previousProcesses=$taskRestarted;restarted=(Get-Date).ToString('o')}
$taskReport | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskWorkspace 'release\last-desktop-restart.json') -Encoding UTF8
$taskReport | ConvertTo-Json -Depth 4
