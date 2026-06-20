@echo off
chcp 65001 > nul
title SNS Downloader
cd /d "%~dp0"

:: Check if port 3001 is already in use
netstat -an 2>nul | find ":3001 " > nul 2>&1
if not errorlevel 1 (
  echo [SNS Downloader] 서버가 이미 실행 중입니다.
  start "" http://localhost:3001
  exit
)

:: Install dependencies if needed
if not exist "node_modules" (
  echo [SNS Downloader] 처음 실행 - 의존성 설치 중...
  npm install
  if errorlevel 1 (
    echo npm install 실패. Node.js가 설치되어 있는지 확인하세요.
    pause
    exit /b 1
  )
)

:: Start server in a minimized window (keep it running)
start /min "SNS Downloader 서버" node server/index.js

:: Wait for server to start
timeout /t 2 /nobreak > nul

:: Open browser
start "" http://localhost:3001
exit
