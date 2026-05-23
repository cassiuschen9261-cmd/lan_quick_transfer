Option Explicit

Dim shell, fso, scriptDir, projectRoot, psCommand

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)

psCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\start_server_hidden.ps1"" node"
shell.CurrentDirectory = projectRoot
shell.Run psCommand, 0, False
