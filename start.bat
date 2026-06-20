@echo off
cd /d "%~dp0"
if not exist node_modules npm install

:: Kill any existing process on port 3001
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":3001 " ^| findstr "LISTENING"') do (
  echo Stopping existing server (PID %%a)...
  taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

:: Start server (visible window — close X to stop)
start "SNS Downloader Server" node server/index.js

:: Wait until server is ready (poll /health every 500ms, up to 15 seconds)
powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { Invoke-WebRequest -Uri 'http://localhost:3001/health' -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop | Out-Null; break } catch {} ; Start-Sleep -Milliseconds 500 }"

:open
set CHROME=
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"  set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
if exist "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"  set CHROME=%PROGRAMFILES%\Google\Chrome\Application\chrome.exe
if exist "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe" set CHROME=%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe

if "%CHROME%"=="" (
  start "" "http://localhost:3001/?mode=app"
) else (
  start "" "%CHROME%" "--app=http://localhost:3001/?mode=app" --window-size=420,820
)
