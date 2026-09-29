@echo off
cd /d "%~dp0.."
if not exist .env ( echo Run windows\setup.bat first. & pause & exit /b 1 )
echo Starting background worker (router polling + attendance finalization)...
start "WiFi Attendance - Worker" cmd /k node --env-file=.env src/worker.ts
echo Starting web server... open http://localhost:3000 in your browser
start "" http://localhost:3000
node --env-file=.env src/api/server.ts
pause
