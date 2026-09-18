@echo off
cd /d "%~dp0"
if not exist wms-agent.config.json (
  echo.
  echo   [setup] wms-agent.config.json not found.
  echo   1^) Copy wms-agent.config.example.json to wms-agent.config.json
  echo   2^) Paste your WMS cookie into it
  echo.
  pause
  exit /b 1
)
echo Starting WMS agent... open http://localhost:8790/app.html
node wms-agent.js
pause
