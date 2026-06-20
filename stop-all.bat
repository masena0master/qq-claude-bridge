@echo off
chcp 65001 >nul
title 停止 QQ-Claude Bridge

echo 正在停止 QQ-Claude Bridge...
echo.

:: 方式1: 使用 launcher 的停止命令
node "%~dp0launcher.js" --stop 2>nul

:: 方式2: 兜底 - 直接杀进程
taskkill /f /im NapCatWinBootMain.exe 2>nul
taskkill /f /im NapCatInstaller.exe 2>nul

echo.
echo ✅ 已停止所有服务
timeout /t 2 /nobreak >nul
exit
