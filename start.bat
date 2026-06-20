@echo off
cd /d "%~dp0"
if not exist node_modules npm install
netstat -an 2>nul | find ":3001 " >nul 2>&1
if not errorlevel 1 goto :open
start /min "SNS Downloader" node server/index.js
timeout /t 2 /nobreak >nul
:open
start "" http://localhost:3001
