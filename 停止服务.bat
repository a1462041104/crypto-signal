@echo off
chcp 65001 >nul
title 停止量化信号服务
cd /d "%~dp0"

echo ================================================================
echo           停止加密货币实时量化服务
echo ================================================================
echo.

set FOUND=0
for /f "tokens=5" %%a in ('netstat -aon ^| findstr 0.0.0.0:3000') do (
    set FOUND=1
    echo 正在关闭占用 3000 端口的进程 (PID: %%a) ...
    taskkill /F /PID %%a >nul 2>nul
)

echo [完成] 服务已停止。
ping -n 3 127.0.0.1 >nul
