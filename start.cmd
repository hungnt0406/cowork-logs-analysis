@echo off
REM start.cmd — Windows entry point. Delegates to start.ps1 with execution-policy
REM bypass so you can run `.\start.cmd` from cmd/PowerShell or double-click it,
REM without changing your machine's PowerShell policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
exit /b %ERRORLEVEL%
