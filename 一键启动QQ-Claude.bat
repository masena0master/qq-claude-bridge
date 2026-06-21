@echo off
title QQ-Claude ???????

echo.
echo ============================================
echo   QQ-Claude Bridge - Yi Jian Qi Dong
echo ============================================
echo.

:: --- 1. Start Bridge ---
echo [1/2] Starting bridge...
cd /d "C:\Users\i\Desktop\qq-claude-bridge"
start "QQ-Claude Bridge" /MIN node bridge.js
echo   Waiting for port 8080...
powershell -NoProfile -Command "for($i=0;$i -lt 15;$i++){Start-Sleep 1; if(Get-NetTCPConnection -LocalPort 8080 -EA 0){exit 0}} exit 1"
if errorlevel 1 (
    echo   [FAIL] Bridge did not start!
    pause
    exit /b
)
echo   Bridge OK

:: --- 2. Start NapCat ---
echo.
echo [2/2] Starting NapCatQQ...
cd /d "C:\Users\i\Desktop\napcat\NapCat.44498.Shell"
start "NapCatQQ" /MIN .\NapCatWinBootMain.exe

echo   Waiting for login...

:: Wait 3 seconds for NapCat to connect to bridge
set CONNECTED=0
timeout /t 3 /nobreak >nul
powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 8080 -EA 0|?{$_.State -eq 'Established'}; if($c){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 (
    set CONNECTED=1
)

:connected
if "%CONNECTED%"=="1" (
    echo.
    echo ============================================
    echo   All services started!
    echo   Bridge: ws://127.0.0.1:8080
    echo   You can now chat via QQ
    echo ============================================
) else (
    echo.
    echo ============================================
    echo   NapCat needs QR code login
    echo   Opening QR code image...
    echo ============================================
    start "" "C:\Users\i\Desktop\napcat\NapCat.44498.Shell\versions\9.9.26-44498\resources\app\napcat\cache\qrcode.png"
    echo.
    echo   Scan QR code with phone QQ to login
    echo   Then chat with 3226214425
)

echo.
timeout /t 5 /nobreak >nul
