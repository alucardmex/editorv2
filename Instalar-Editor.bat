@echo off
title Instalar Editor V2
cd /d "%~dp0"
echo.
echo  Creando acceso directo "Editor V2" en tu escritorio y en el menu Inicio...
set "TARGET=%~dp0Abrir-Editor.bat"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=New-Object -ComObject WScript.Shell;" ^
  "foreach($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))){" ^
  "  $l=$s.CreateShortcut((Join-Path $d 'Editor V2.lnk'));" ^
  "  $l.TargetPath='%TARGET%'; $l.WorkingDirectory='%~dp0'; $l.IconLocation='%SystemRoot%\System32\imageres.dll,18';" ^
  "  $l.Description='Editor V2 - vista previa y linea de tiempo'; $l.Save() }"
if errorlevel 1 (
  echo  !! No se pudo crear el acceso directo. Puedes abrir el editor con Abrir-Editor.bat
) else (
  echo  OK - Busca "Editor V2" en tu escritorio o en el menu Inicio.
)
echo.
pause
