@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node serve.mjs --open
) else (
  if exist "C:\Program Files\nodejs\node.exe" (
    "C:\Program Files\nodejs\node.exe" serve.mjs --open
  ) else (
    echo Установите Node.js 22 или новее, затем запустите START.cmd ещё раз.
  )
)
pause
