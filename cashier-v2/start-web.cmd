@echo off
cd /d "%~dp0"
set "PORT=5173"
node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)"
if errorlevel 1 (
  echo Please install Node.js 24 LTS or newer.
  pause
  exit /b 1
)
echo Cashier web: http://localhost:5173/
echo Keep this window open while using the cashier.
echo Close other cashier web services before starting this one.
node payments\web.cjs
pause
