Option Explicit

Dim shell, files, appDirectory, npmPath, nodePath, electronVitePath, logPath, command, quote

Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")

appDirectory = files.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDirectory

If Not files.FileExists(files.BuildPath(appDirectory, "package.json")) Then
  MsgBox "Не найден package.json рядом с файлом запуска.", vbCritical, "KreOsFTP"
  WScript.Quit 1
End If

If Not files.FolderExists(files.BuildPath(appDirectory, "node_modules")) Then
  MsgBox "Зависимости ещё не установлены." & vbCrLf & vbCrLf & _
    "Один раз выполните npm install в папке программы.", vbExclamation, "KreOsFTP"
  WScript.Quit 1
End If

npmPath = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\npm.cmd"
If Not files.FileExists(npmPath) Then
  npmPath = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\npm.cmd"
End If

nodePath = files.BuildPath(files.GetParentFolderName(npmPath), "node.exe")
electronVitePath = files.BuildPath(appDirectory, "node_modules\electron-vite\bin\electron-vite.js")
If Not files.FileExists(nodePath) Or Not files.FileExists(electronVitePath) Then
  MsgBox "Не найдены node.exe или локальный electron-vite.", _
    vbCritical, "KreOsFTP"
  WScript.Quit 1
End If

If Not files.FileExists(npmPath) Then
  MsgBox "Не найден Node.js (npm.cmd)." & vbCrLf & vbCrLf & _
    "Установите Node.js LTS и повторите запуск.", vbCritical, "KreOsFTP"
  WScript.Quit 1
End If

quote = Chr(34)
logPath = shell.ExpandEnvironmentStrings("%TEMP%") & "\KreOsFTP-launch.log"
command = "cmd.exe /d /s /c " & quote & quote & nodePath & quote & " " & _
  quote & electronVitePath & quote & " dev >> " & quote & logPath & quote & " 2>&1" & quote

' Used by automated checks without starting an Electron window.
If WScript.Arguments.Named.Exists("check") Then WScript.Quit 0

' Window style 0 keeps the npm/Vite console hidden. The Electron window opens normally.
shell.Run command, 0, False
