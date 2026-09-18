@echo off
REM Removes the WMS agent from Windows startup.
setlocal
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wms-agent-hidden.vbs"
if exist "%DST%" (
  del /F /Q "%DST%"
  echo [OK] Agjenti u hoq nga Startup. Nuk do te niset me vetvetiu.
) else (
  echo [info] Nuk kishte asnje hyrje autostart per te hequr.
)
echo.
echo Shenim: nese agjenti eshte duke punuar tani, mbylle nga Task Manager (node.exe) ose rindiz PC-ne.
pause
