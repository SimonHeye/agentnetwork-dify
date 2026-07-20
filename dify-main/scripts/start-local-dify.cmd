@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-dify.ps1"
if errorlevel 1 pause
