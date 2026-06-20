@echo off
chcp 65001 >nul
title 停止 QQ-Claude Bridge

echo 正在停止 QQ-Claude Bridge...
echo.

:: 停止桥接 (node.js 进程)
echo [1/2] 停止桥接服务...
taskkill /f /fi "WINDOWTITLE eq QQ-Claude Bridge" /im cmd.exe 2>nul
taskkill /f /fi "WINDOWTITLE eq QQ-Claude Bridge" /im node.exe 2>nul

:: 停止 NapCatQQ
echo [2/2] 停止 NapCatQQ...
taskkill /f /im QQ.exe 2>nul
taskkill /f /im NapCatWinBootMain.exe 2>nul

echo.
echo ✅ 已停止所有服务
timeout /t 2 /nobreak >nul
exit
