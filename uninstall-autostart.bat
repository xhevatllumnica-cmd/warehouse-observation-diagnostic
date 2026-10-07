@echo off
REM Removes the WMS agent from Windows startup (both the current launcher and the old-style copy).
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wms-agent-startup.vbs" 2>nul
del /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wms-agent-hidden.vbs" 2>nul
echo [OK] Agjenti u hoq nga Startup. (Nese eshte duke punuar tani, mbyllet me ristartimin e Windows-it ose nga Task Manager: node.exe)
pause
