@echo off
setlocal
cd /d "%~dp0.."
echo === WiFi Attendance - one-time setup ===

where node >nul 2>nul
if errorlevel 1 ( echo [ERROR] Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and run this again. & pause & exit /b 1 )
for /f "tokens=1 delims=." %%v in ('node -v') do set NODEMAJOR=%%v
if "%NODEMAJOR%"=="v18" goto oldnode
if "%NODEMAJOR%"=="v20" goto oldnode
goto nodeok
:oldnode
echo [ERROR] Node.js is too old. Install Node.js 22 LTS or newer. & pause & exit /b 1
:nodeok

if not exist .env (
  copy windows\env.template .env >nul
  echo.
  echo A file named .env was created in this folder.
  echo Open it in Notepad, set POSTGRES password, ADMIN_PASSWORD and ROUTER_ENCRYPTION_KEY, save it, then run setup.bat again.
  notepad .env
  pause & exit /b 0
)

call npm install || ( echo [ERROR] npm install failed & pause & exit /b 1 )
node --env-file=.env src/db/create-db.ts || ( pause & exit /b 1 )
node --env-file=.env src/db/migrate.ts || ( pause & exit /b 1 )
echo.
echo Setup finished. Now double-click windows\start.bat
pause
