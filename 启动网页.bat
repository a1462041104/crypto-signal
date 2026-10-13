@echo off
chcp 65001 >nul
title 加密货币量化交易系统
cd /d "%~dp0"

echo ================================================================
echo           加密货币实时量化信号系统 · 一键启动
echo ================================================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js 环境！
    echo 请先安装 Node.js 后再运行本程序。
    echo 官网下载: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

netstat -ano | findstr 0.0.0.0:3000 >nul 2>nul
if %errorlevel% equ 0 (
    echo [提示] 网页后台服务已在运行中，正在为您打开默认浏览器...
    start http://localhost:3000
    echo 网页地址: http://localhost:3000
    ping -n 3 127.0.0.1 >nul
    exit /b 0
)

if not exist "node_modules\" (
    echo [提示] 首次运行，正在自动安装项目依赖，请稍候...
    call npm install
)

start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:3000"

echo [提示] 正在启动后台服务...
echo [提示] 网页将在 2 秒后自动打开: http://localhost:3000
echo.
echo ================================================================
echo   * 服务地址: http://localhost:3000
echo   * 提示: 请保持此窗口运行，关闭窗口即停止量化系统
echo   * 如需退出: 直接关闭此窗口即可
echo ================================================================
echo.

node server.js
pause
