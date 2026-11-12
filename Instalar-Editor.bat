@echo off
title Instalar Editor V2
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  No encontre Node.js. Corre primero Instalar-HyperFrames.bat en F:\edicionesclaude.
  echo.
  pause
  exit /b 1
)
echo.
echo  Creando el acceso "Editor V2" en tu escritorio y en el menu Inicio...
node -e "require('./window').fixShortcuts(process.cwd(), true)"
echo  OK - Busca "Editor V2" en tu escritorio o en el menu Inicio.
echo.
pause
