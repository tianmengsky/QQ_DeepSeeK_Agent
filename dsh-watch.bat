@echo off
rem ---------------------------------------------------------------------------
rem  DSH watchdog - keeps the desktop app from staying dead.
rem
rem  What it does (tools\dsh-guard.mjs watch): probes every 30s; if DSH is gone
rem  it prunes the piled-up dsh-auth-* cookies (the real cause of the 10-31
rem  "Web authentication failed" boot loop) and launches it again, backing off
rem  30s -> 1m -> 2m -> 5m. It never stops DSH on its own.
rem
rem  Keep this window open; closing it stops the watchdog (DSH keeps running).
rem  Log is also appended to %TEMP%\qq-dsh-watch.log
rem
rem  Usage:
rem    dsh-watch.bat               watch with the default 30s interval
rem    dsh-watch.bat --interval 60 probe every 60 seconds
rem
rem  ASCII-only on purpose: cmd.exe reads .bat byte-by-byte in the OEM codepage.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
title DSH watchdog
setlocal

set "GUARD=%~dp0tools\dsh-guard.mjs"
if not exist "%GUARD%" (
  echo [fail] missing: %GUARD%
  pause
  exit /b 1
)

node "%GUARD%" watch %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" pause
exit /b %RC%
