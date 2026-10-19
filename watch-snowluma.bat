@echo off
chcp 65001 >nul
title SnowLuma Live Logs
node "%~dp0tools\watch-snowluma.mjs"
if errorlevel 1 pause
