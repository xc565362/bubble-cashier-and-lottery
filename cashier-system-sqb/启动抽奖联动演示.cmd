@echo off
cd /d "%~dp0"
call npm.cmd run build -- --outDir output/lottery-catalog-20260930/preview-dist
if errorlevel 1 goto finish
echo Open http://127.0.0.1:5208/ after the server starts.
call npm.cmd run lottery:preview
:finish
pause
