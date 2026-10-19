@echo off
rem ---------------------------------------------------------------------------
rem  QQ MCP launcher (thin ASCII wrapper).
rem
rem  All logic lives in tools\start-qq-mcp.ps1 on purpose:
rem  cmd.exe reads a .bat file byte-by-byte in the OEM codepage, so Chinese text
rem  stored as UTF-8 in a .bat gets shredded into bogus commands even with
rem  `chcp 65001`. Keeping this file ASCII-only avoids that entirely, and the
rem  .ps1 (UTF-8 with BOM) prints the Chinese safely.
rem
rem  Usage:
rem    start-qq-mcp.bat            start SnowLuma + enable bridge hosting
rem    start-qq-mcp.bat status     show status only
rem    start-qq-mcp.bat stop       disable hosting only (QQ stays online)
rem    start-qq-mcp.bat restart    reset bridge hosting; keep QQ online
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title QQ MCP
setlocal

set "MODE=%~1"
if "%MODE%"=="" set "MODE=start"

set "SCRIPT=%~dp0tools\start-qq-mcp.ps1"
if not exist "%SCRIPT%" (
  echo [fail] missing: %SCRIPT%
  pause
  exit /b 1
)

echo [QQ MCP] mode=%MODE% - loading startup checks...
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%SCRIPT%" -Mode "%MODE%"
set "RC=%ERRORLEVEL%"

if /i "%MODE%"=="start" if "%RC%"=="0" (
  node "%~dp0tools\watch-snowluma.mjs"
)

echo.
pause
exit /b %RC%
