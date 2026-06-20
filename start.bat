@echo off
cd /d "%~dp0"
if not exist node_modules npm install

:: Check if server is already running and responsive (not just port open)
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://localhost:3001/health' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :open

:: Server not ready — start it
start "SNS Downloader Server" node server/index.js

:: Poll /health every 500ms until server responds (up to 15 seconds)
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
