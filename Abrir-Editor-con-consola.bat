@echo off
title Editor V2 - consola (solo para revisar errores)
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto nonode
set EDITOR_KEEP_ALIVE=1
rem Todo en una sola linea: la actualizacion puede reemplazar este archivo mientras corre.
node launcher.js & echo. & echo  El editor se cerro. & pause & exit /b
:nonode
echo.
echo  No encontre Node.js. Corre primero Instalar-HyperFrames.bat en F:\edicionesclaude.
echo.
pause
