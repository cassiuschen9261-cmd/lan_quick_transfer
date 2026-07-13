; LANQuickTransfer.iss - Inno Setup script for EXE installer
; Builds a self-contained EXE installer with the portable Node.js runtime bundled.

#define MyAppName "LAN Quick Transfer"
#define MyAppVersion "1.2.0"
#define MyAppPublisher "LAN Quick Transfer"
#define MyAppURL "https://github.com/cassiuschen9261-cmd/lan_quick_transfer"
#define MyAppExeName "launch_app.bat"
#define StagingDir "build\staging\LANQuickTransfer"

[Setup]
AppId={{7B3F2A1C-9D4E-4F5A-8B6C-1E2D3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=wix\LICENSE_HINT.txt
OutputDir=build
OutputBaseFilename=LANQuickTransfer-1.2.0-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
UninstallDisplayIcon={app}\runtime\node.exe
UninstallDisplayName={#MyAppName}
SetupIconFile=wix\app.ico
VersionInfoVersion=1.2.0.0

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; Recursively include the entire staging directory
Source: "{#StagingDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Comment: "Start LAN Quick Transfer server"
Name: "{group}\{#MyAppName} (Tray)"; Filename: "{app}\launch_tray.bat"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Comment: "Start in Windows tray background mode"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\runtime\node.exe"; Tasks: desktopicon; Comment: "Start LAN Quick Transfer server"

[Run]
Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Kill any running node.exe from the app folder before uninstalling
Filename: "{cmd}"; Parameters: "/c taskkill /f /im node.exe 2>nul"; Flags: runhidden; RunOnceId: "KillNode"

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}\uploads"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"