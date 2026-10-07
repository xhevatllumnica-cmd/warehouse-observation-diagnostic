' Watchdog for the WMS agent - run every 5 minutes (and 1 minute after logon) by the
' "WMS Agent" task in Windows Task Scheduler (see install-watchdog-task.ps1).
' Starts the agent hidden only if no wms-agent node process is running, so it never
' starts a second copy. Being launched by Task Scheduler, the agent does not depend on
' whichever program happened to start it before (it used to die when Claude Desktop closed).
' The same goes for the schedule editor "Orari i Warehouse" (warehouse-schedule, Next.js on
' port 3000): started hidden if no node process of it is running and its folder exists.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
scheduleDir = "D:\Xhevat\Warehouse\App\warehouse-observation-diagnostic\.claude\worktrees\warehouse-observation-app-986fe1\warehouse-schedule"
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set sh = CreateObject("WScript.Shell")
Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%wms-agent.js%'")
If procs.Count = 0 Then
  sh.CurrentDirectory = here
  sh.Run "cmd /c node """ & here & "\wms-agent.js""", 0, False
End If
If fso.FolderExists(scheduleDir & "\node_modules\next") Then
  Set sched = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%warehouse-schedule%next%'")
  If sched.Count = 0 Then
    sh.CurrentDirectory = scheduleDir
    sh.Run "cmd /c npm run dev", 0, False
  End If
End If
