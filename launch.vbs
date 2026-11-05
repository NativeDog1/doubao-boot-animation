Option Explicit
' Doubao Boot Animation - launcher (silent: no console window)
Dim shell, fso, base, script, rc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
script = base & "\bin\inject.mjs"

rc = shell.Run("cmd /c where node >nul 2>nul", 0, True)
If rc <> 0 Then
  shell.Run "cmd /c """ & base & "\launch.cmd""", 1, False
  WScript.Quit 1
End If

shell.Run "node """ & script & """", 0, False