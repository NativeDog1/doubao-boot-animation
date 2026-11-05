Option Explicit
' Doubao Boot Animation - create a desktop shortcut that plays the intro
Dim shell, fso, base, script, rc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

base = fso.GetParentFolderName(WScript.ScriptFullName)
script = base & "\bin\install-shortcut.mjs"

rc = shell.Run("cmd /c where node >nul 2>nul", 0, True)
If rc <> 0 Then
  shell.Run "cmd /c """ & base & "\install-shortcut.cmd""", 1, False
  WScript.Quit 1
End If

shell.Run "node """ & script & """", 0, False
