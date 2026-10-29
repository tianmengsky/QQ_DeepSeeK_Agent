@echo off
rem ---------------------------------------------------------------------------
rem  Open the qq-bridge panel (/qq/onebot/panel) in the default browser.
rem
rem  All logic lives in tools\open-panel.ps1 on purpose: cmd.exe reads a .bat file
rem  byte-by-byte in the OEM codepage, so Chinese text stored as UTF-8 in a .bat
rem  gets shredded into bogus commands even with `chcp 65001`. Keeping this file
rem  ASCII-only (and CRLF) avoids that entirely, and the .ps1 (UTF-8 with BOM)
rem  prints the Chinese safely. Same split as start-qq-mcp.bat.
rem
rem  Usage:
rem    open-panel.bat                 find the DSH port and open the panel
rem    open-panel.bat night           open the dark theme (day / night)
rem    open-panel.bat -Port 10692     skip discovery, use this port
rem    open-panel.bat -Token xxxx     when config.token is set (or QQ_PANEL_TOKEN)
rem    open-panel.bat -NoOpen         print the URL only
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title qq-bridge panel
setlocal

set "SCRIPT=%~dp0tools\open-panel.ps1"
if not exist "%SCRIPT%" (
  echo [fail] missing: %SCRIPT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"

rem  On failure keep the window open so the reason can be read; on success the
rem  browser already opened, so no extra keypress.
if not "%RC%"=="0" pause
exit /b %RC%
