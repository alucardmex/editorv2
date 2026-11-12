@echo off
title Editor V2 (no cierres esta ventana mientras editas)
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto nonode
rem Todo en una sola linea: la actualizacion puede reemplazar este archivo mientras corre.
node launcher.js & echo. & echo  El editor se cerro. & pause & exit /b
:nonode
echo.
echo  No encontre Node.js. Corre primero Instalar-HyperFrames.bat
echo  en F:\edicionesclaude y vuelve a abrir el editor.
echo.
pause
