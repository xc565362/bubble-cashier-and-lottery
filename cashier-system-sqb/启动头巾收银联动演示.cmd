@echo off
cd /d "%~dp0"
call npm run build -- --outDir output/scarf-cashier-20261008/preview-dist
if errorlevel 1 goto done
call npm run scarf:preview
:done
pause
