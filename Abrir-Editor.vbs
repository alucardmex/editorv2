' Editor V2 - abre el editor sin ventana negra.
' (Para ver los mensajes del editor usa Abrir-Editor-con-consola.bat.)
Option Explicit
Dim sh, fso, dir, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
rc = sh.Run("cmd /c where node >nul 2>&1", 0, True)
If rc <> 0 Then
  MsgBox "No encontre Node.js en esta computadora." & vbCrLf & vbCrLf & _
         "Corre Instalar-HyperFrames.bat en F:\edicionesclaude y vuelve a abrir Editor V2.", 48, "Editor V2"
  WScript.Quit 1
End If
sh.Run "cmd /c node launcher.js > editor.log 2>&1", 0, False
