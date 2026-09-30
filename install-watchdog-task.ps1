# Registers the "WMS Agent" task in Windows Task Scheduler for the current user (no admin, no password):
# runs wms-agent-watchdog.vbs 1 minute after logon and every 5 minutes, which (re)starts the agent if it isn't running.
# Run:    powershell -ExecutionPolicy Bypass -File install-watchdog-task.ps1
# Remove: Unregister-ScheduledTask -TaskName "WMS Agent" -Confirm:$false
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $dir 'wms-agent-watchdog.vbs'
if (-not (Test-Path $vbs)) { throw "wms-agent-watchdog.vbs not found next to this script" }
$action   = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $dir
$atLogon  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$atLogon.Delay = 'PT1M'
$every5   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
              -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'WMS Agent' -Description 'Keeps the local WMS agent (localhost:8790) running: starts it if it is not running.' `
  -Action $action -Trigger @($atLogon, $every5) -Settings $settings -Principal $principal -Force | Out-Null
Get-ScheduledTask -TaskName 'WMS Agent' | Select-Object TaskName, State
