@echo off
chcp 65001 >nul
title Matrix Garden - Installer
cd /d "%~dp0"
echo.
echo  Starting installer, please wait...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo  [ERROR] Installer exited with error. Please screenshot this window.
  pause
)
