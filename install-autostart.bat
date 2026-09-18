@echo off
REM Adds the WMS agent to Windows startup (starts hidden at every login).
setlocal
set "SRC=%~dp0wms-agent-hidden.vbs"
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\wms-agent-hidden.vbs"

if not exist "%SRC%" (
  echo [gabim] Nuk u gjet wms-agent-hidden.vbs prane ketij skedari.
  pause & exit /b 1
)
if not exist "%~dp0wms-agent.config.json" (
  echo [kujdes] wms-agent.config.json nuk ekziston ende.
  echo    Kopjo wms-agent.config.example.json -^> wms-agent.config.json dhe vendos cookie-n para se te vazhdosh.
  echo.
)
copy /Y "%SRC%" "%DST%" >nul
if %errorlevel%==0 (
  echo [OK] Agjenti u shtua ne Startup. Do te niset vetvetiu sa here qe ndez Windows-in.
  echo    Po e nis edhe tani...
  start "" wscript.exe "%DST%"
  echo    Hape: http://localhost:8790/app.html
) else (
  echo [gabim] Nuk u kopjua ne Startup.
)
echo.
pause
