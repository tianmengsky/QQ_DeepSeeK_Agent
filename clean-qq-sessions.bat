@echo off
rem ---------------------------------------------------------------------------
rem  Clean up the disposable DSH sessions created by the QQ bridge.
rem
rem  All logic is in tools\clean-qq-sessions.ps1 on purpose: cmd.exe reads a .bat
rem  byte-by-byte in the OEM codepage, so Chinese text stored as UTF-8 in a .bat
rem  gets shredded into bogus commands even with `chcp 65001`.
rem
rem  Usage:
rem    clean-qq-sessions.bat                    dry run (lists what would go)
rem    clean-qq-sessions.bat -Apply             actually delete
rem    clean-qq-sessions.bat -Apply -KeepDays 1 keep the last day
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title QQ session cleanup
setlocal

set "SCRIPT=%~dp0tools\clean-qq-sessions.ps1"
if not exist "%SCRIPT%" (
  echo [fail] missing: %SCRIPT%
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"

echo.
pause
exit /b %RC%
