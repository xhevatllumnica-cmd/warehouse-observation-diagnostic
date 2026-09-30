' Watchdog for the WMS agent - run every 5 minutes (and 1 minute after logon) by the
' "WMS Agent" task in Windows Task Scheduler (see install-watchdog-task.ps1).
' Starts the agent hidden only if no wms-agent node process is running, so it never
' starts a second copy. Being launched by Task Scheduler, the agent does not depend on
' whichever program happened to start it before (it used to die when Claude Desktop closed).
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='node.exe' AND CommandLine LIKE '%wms-agent.js%'")
If procs.Count = 0 Then
  Set sh = CreateObject("WScript.Shell")
  sh.CurrentDirectory = here
  sh.Run "cmd /c node """ & here & "\wms-agent.js""", 0, False
End If
