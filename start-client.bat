@echo off
rem GateDesk client (controlled endpoint) launcher for Windows.
rem Usage: start-client.bat <api-token> [server]
rem   server  : ops web-server address; may be ip / ip:port / http(s)://host / full URL
rem             (default 127.0.0.1:3000). Omit if using -Port switch style instead.
rem Prefers pwsh (PowerShell 7) if available, falls back to Windows PowerShell 5.1.

where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-client.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-client.ps1" %*
)

