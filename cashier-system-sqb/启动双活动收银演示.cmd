@echo off
cd /d "%~dp0"
call npm run build -- --outDir output/dual-lottery-20261008/preview-dist
if errorlevel 1 (
  pause
  exit /b 1
)
call npm run activities:preview
pause
