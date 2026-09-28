@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "ATLAS_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "ATLAS_NODE=C:\Program Files\nodejs\node.exe"
  ) else (
    echo Установите Node.js 22 или новее.
    goto finish
  )
)
set "ATLAS_PYTHON=python"
python -c "import sys" >nul 2>nul
if errorlevel 1 (
  if exist "%LocalAppData%\Programs\Python\Python313\python.exe" (
    set "ATLAS_PYTHON=%LocalAppData%\Programs\Python\Python313\python.exe"
  ) else (
    echo Установите Python 3.10 или новее, затем повторите запуск.
    goto finish
  )
)
"%ATLAS_PYTHON%" scripts\create-local-cert.py --node "%ATLAS_NODE%"
if errorlevel 1 goto finish
echo.
echo Доверие на телефоне настраивается вручную один раз. Откройте GPS-HTTPS.md.
"%ATLAS_NODE%" serve.mjs --https
:finish
pause
