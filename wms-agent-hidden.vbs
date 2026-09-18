' Starts the WMS agent silently (no console window) from its own folder.
' Used by the Windows Startup entry so the agent is always running.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
' 0 = hidden window, False = don't wait
sh.Run "cmd /c node """ & here & "\wms-agent.js""", 0, False
