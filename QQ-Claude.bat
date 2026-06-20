@echo off
chcp 65001 >nul
title QQ-Claude Bridge

:: ═══════════════════════════════════════════════════════
::  QQ-Claude Bridge - 一键启动器 (v2.0)
::  直接调用 Node.js launcher，可靠且功能完整
:: ═══════════════════════════════════════════════════════

set "BRIDGE_DIR=%~dp0"
cd /d "%BRIDGE_DIR%"

:: ── 检查 Node.js ─────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo    ❌ 未找到 Node.js，请先安装 Node.js
    echo    https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: ── 启动 launcher ────────────────────────────────────
node "%BRIDGE_DIR%launcher.js" %*

:: launcher.js 退出后短暂停留让用户看到结果
if errorlevel 1 (
    echo.
    pause
)
