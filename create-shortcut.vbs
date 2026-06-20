Set WshShell = WScript.CreateObject("WScript.Shell")
Set Shortcut = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") & "\QQ-Claude.lnk")
Shortcut.TargetPath = "C:\Users\i\Desktop\qq-claude-bridge\QQ-Claude.bat"
Shortcut.WorkingDirectory = "C:\Users\i\Desktop\qq-claude-bridge"
Shortcut.IconLocation = "C:\Windows\System32\shell32.dll,14"
Shortcut.Description = "QQ-Claude Bridge - 手机远程操控Claude"
Shortcut.Save()
WScript.Echo "桌面快捷方式已创建！"
