@echo off
powershell -NoProfile -Command "$conn = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | Select-Object -First 1; if ($conn) { Stop-Process -Id $conn.OwningProcess -Force; Write-Host 'SNS Downloader server stopped.' } else { Write-Host 'Server is not running.' }"
echo.
echo Press any key to close . . .
pause >nul
