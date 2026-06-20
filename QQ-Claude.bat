@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title QQ-Claude Bridge

:: ═══════════════════════════════════════════════════════
::  QQ-Claude Bridge - 一键启动器
::  首次使用输入QQ号即可，之后直接启动
:: ═══════════════════════════════════════════════════════

set "BRIDGE_DIR=%~dp0"
set "BRIDGE_DIR=%BRIDGE_DIR:~0,-1%"
set "CONFIG=%BRIDGE_DIR%\config.yaml"
set "INSTALLED_FLAG=%BRIDGE_DIR%\.installed"

:: ── 首次安装 ───────────────────────────────────────────
if not exist "%INSTALLED_FLAG%" goto :first_run

:: ── 日常启动 ───────────────────────────────────────────
goto :launch


:first_run
cls
echo.
echo    ╔══════════════════════════════════════════╗
echo    ║     欢迎使用 QQ-Claude Bridge           ║
echo    ║     首次设置，只需一步                  ║
echo    ╚══════════════════════════════════════════╝
echo.
echo    这个程序让你在手机上用QQ远程操控Claude Code
echo.

:: ── 1. 输入QQ号 ────────────────────────────────────
:input_qq
echo    ┌──────────────────────────────────────────┐
set /p qq="    │ 请输入你的QQ号: "
echo    └──────────────────────────────────────────┘
if "%qq%"=="" (
    echo    请填写有效的QQ号
    goto :input_qq
)

:: 验证QQ号为纯数字
for /f "delims=0123456789" %%a in ("%qq%") do (
    echo    请输入纯数字的QQ号
    goto :input_qq
)

:: ── 2. 自动检测 claude ────────────────────────────
echo.
echo    正在检测环境...

set "CLAUDE_PATH=claude"

:: 尝试多个常见路径
for %%p in (
    "claude"
    "C:\Users\%USERNAME%\AppData\Roaming\npm\claude.cmd"
    "D:\npm-global\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
    "%APPDATA%\npm\claude.cmd"
) do (
    if exist %%p set "CLAUDE_PATH=%%~p"
)

:: 通过 where 命令查找
for /f "delims=" %%p in ('where claude 2^>nul') do (
    if exist "%%p" set "CLAUDE_PATH=%%p"
)

echo    找到 Claude: %CLAUDE_PATH%

:: ── 3. 生成配置文件 ────────────────────────────────
echo    正在生成配置...

(
echo # QQ-Claude Bridge 配置 (自动生成^)
echo # 生成时间: %date% %time%
echo.
echo bridge:
echo   host: "127.0.0.1"
echo   port: 8080
echo.
echo security:
echo   allowed_users:
echo     - %qq%
echo   rate_limit:
echo     max_requests: 30
echo     window_seconds: 60
echo.
echo claude:
echo   binary: %CLAUDE_PATH:\=/%
echo   max_turns: 10
echo   max_budget_usd: 0.50
echo   timeout_seconds: 120
echo   allowed_tools:
echo     - Read
echo     - Write
echo     - Bash
echo     - Glob
echo     - Grep
echo     - WebSearch
echo     - WebFetch
echo.
echo features:
echo   streaming_reply: true
echo   session_timeout_minutes: 30
) > "%CONFIG%"

:: ── 4. 检查并自动配置 NapCat ──────────────────────
echo    正在检查 NapCat...

set "NAPCAT_FOUND=0"

:: 搜索 NapCat 配置
for /d %%d in (
    "%BRIDGE_DIR%\..\napcat\NapCat.*.Shell"
    "C:\NapCat"
    "D:\NapCat"
    "%USERPROFILE%\Desktop\napcat\NapCat.*.Shell"
) do (
    if exist "%%d\" (
        for /r "%%d" %%f in (onebot11_*.json) do (
            if exist "%%f" (
                echo    找到 NapCat 配置: %%f
                set "NAPCAT_CFG=%%f"
                set "NAPCAT_FOUND=1"
            )
        )
    )
)

if "%NAPCAT_FOUND%"=="1" (
    echo    正在配置 NapCat 连接...
    :: 使用 PowerShell 修改 JSON 配置
    powershell -NoProfile -Command "
        $cfgPath = '%NAPCAT_CFG%'
        if (Test-Path $cfgPath) {
            $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
            $client = @{
                name = 'QQ-Claude'
                url = 'ws://127.0.0.1:8080'
                messagePostFormat = 'array'
                reportSelfMessage = $false
                reconnectInterval = 5000
                heartInterval = 30000
                enable = $true
            }
            $cfg.network.websocketClients = @($client)
            $cfg | ConvertTo-Json -Depth 10 | Set-Content $cfgPath -Encoding UTF8
            Write-Host 'NapCat 配置完成'
        }
    " 2>nul
) else (
    echo.
    echo    ⚠️ 未检测到 NapCatQQ
    echo    ──────────────────────────────────────
    echo    请下载 NapCatQQ 并扫码登录:
    echo    https://github.com/NapNeko/NapCatQQ/releases
    echo.
    echo    下载 Windows 一键包，解压到桌面 napcat 文件夹
    echo    运行后扫码登录，然后重新运行本程序即可
    echo    ──────────────────────────────────────
    echo.
)

:: ── 5. 完成 ────────────────────────────────────────
echo. > "%INSTALLED_FLAG%"
echo    安装完成！
echo.
echo    按任意键启动...
pause >nul


:launch
cls
echo.
echo    ╔══════════════════════════════════════════╗
echo    ║        QQ-Claude Bridge                 ║
echo    ╚══════════════════════════════════════════╝
echo.
echo    正在启动服务...

:: 关掉旧进程
taskkill /f /fi "WINDOWTITLE eq QQ-Claude Bridge" /im node.exe 2>nul
taskkill /f /fi "WINDOWTITLE eq QQ-Claude Bridge" /im cmd.exe 2>nul

:: 启动桥接服务（完全隐藏）
start "QQ-Claude Bridge" /min cmd /c "cd /d "%BRIDGE_DIR%" && node bridge.js"

:: 等待桥接就绪
echo    等待桥接服务就绪...
ping -n 4 127.0.0.1 >nul

:: 检查 claude
claude --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo    ⚠️ 找不到 claude 命令
    echo    请先安装 Claude Code CLI
    echo.
    pause
    exit /b 1
)

:: 启动 NapCat（如果存在）
for /d %%d in ("%BRIDGE_DIR%\..\napcat\NapCat.*.Shell") do (
    if exist "%%d\napcat.bat" (
        echo    启动 NapCatQQ...
        start "NapCatQQ" /min cmd /c "cd /d %%d && napcat.bat"
    )
)

:: 检查 NapCat 是否在运行
ping -n 5 127.0.0.1 >nul
curl -s -o nul http://127.0.0.1:6099/webui 2>nul
if errorlevel 1 (
    echo.
    echo    ⚠️ NapCatQQ 可能未启动
    echo    请手动启动 NapCat 并扫码登录
    echo.
)

echo.
echo    ┌──────────────────────────────────────────┐
echo    │  ✅ QQ-Claude 已启动                     │
echo    │                                          │
echo    │  用手机QQ给机器人发消息即可              │
echo    │                                          │
echo    │  本窗口可以关闭，服务在后台运行          │
echo    │  下次直接双击本程序即可启动              │
echo    └──────────────────────────────────────────┘
echo.

:: 等8秒后自动关闭此窗口
timeout /t 8 /nobreak >nul
exit
