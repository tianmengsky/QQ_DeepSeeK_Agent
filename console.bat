@echo off
rem ---------------------------------------------------------------------------
rem  QQ bridge console - the ops page that does NOT depend on the bridge.
rem
rem  The health panel (/qq/onebot/panel) is served by the bridge plugin, so it
rem  disappears exactly when things are down. This console is a separate node
rem  process: it shows DSH / SnowLuma / bridge state and can start them in order.
rem
rem  All logic lives in tools\console.ps1 on purpose: cmd.exe reads a .bat file
rem  byte-by-byte in the OEM codepage, so Chinese text stored as UTF-8 in a .bat
rem  gets shredded into bogus commands even with `chcp 65001`. Keeping this file
rem  ASCII-only (and CRLF) avoids that entirely, and the .ps1 (UTF-8 with BOM)
rem  prints the Chinese safely. Same split as start-qq-mcp.bat / open-panel.bat.
rem
rem  Usage:
rem    console.bat               start (if needed) and open the console
rem    console.bat -Port 7799    use another port
rem    console.bat -NoOpen       start only, print the URL
rem    console.bat -Stop         stop the console (DSH / QQ are left alone)
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title QQ bridge console
setlocal

set "SCRIPT=%~dp0tools\console.ps1"
if not exist "%SCRIPT%" (
  echo [fail] missing: %SCRIPT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" pause
exit /b %RC%
