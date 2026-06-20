@echo off
cd /d "%~dp0"
if not exist node_modules npm install

netstat -an 2>nul | find ":3001 " >nul 2>&1
if not errorlevel 1 goto :open
start "SNS Downloader Server" node server/index.js
timeout /t 2 /nobreak >nul

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
