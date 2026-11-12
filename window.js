// Ventana del editor y accesos directos (compartido por launcher.js y server.js).
const { exec, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findBrowser() {
  const env = process.env;
  const cands = [
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return cands.find(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } });
}

// Abre el editor en su propia ventana (modo app de Edge o Chrome); si no hay, en el navegador normal.
function openWindow(link) {
  if (process.env.EDITOR_NO_BROWSER) return;
  if (process.platform === 'win32') {
    const exe = findBrowser();
    if (exe) {
      try {
        spawn(exe, ['--app=' + link, '--window-size=1600,950', '--autoplay-policy=no-user-gesture-required'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return;
      } catch (e) {}
    }
    exec(`start "" "${link}"`, { windowsHide: true }, () => {});
    return;
  }
  exec(process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`, () => {});
}

// Hace que los accesos "Editor V2" (escritorio y menu Inicio) abran el editor sin ventana negra.
function fixShortcuts(dir, create) {
  if (process.platform !== 'win32') return;
  const vbs = path.join(dir, 'Abrir-Editor.vbs');
  const ico = path.join(dir, 'app', 'icono.ico');
  if (!fs.existsSync(vbs)) return;
  const q = s => s.replace(/'/g, "''");
  const ps = [
    "$s=New-Object -ComObject WScript.Shell;",
    "$wscript=Join-Path $env:SystemRoot 'System32\\wscript.exe';",
    "foreach($d in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Programs'))){",
    "  $p=Join-Path $d 'Editor V2.lnk';",
    create ? "" : "  if(-not (Test-Path $p)){ continue };",
    "  $l=$s.CreateShortcut($p);",
    `  if($l.TargetPath -ne $wscript -or $l.Arguments -notlike '*Abrir-Editor.vbs*'){`,
    `    $l.TargetPath=$wscript; $l.Arguments='"${q(vbs)}"'; $l.WorkingDirectory='${q(dir)}';`,
    `    if(Test-Path '${q(ico)}'){ $l.IconLocation='${q(ico)}' } else { $l.IconLocation=(Join-Path $env:SystemRoot 'System32\\imageres.dll')+',18' };`,
    "    $l.Description='Editor V2 - vista previa y linea de tiempo'; $l.Save() } }"
  ].join(' ');
  try { spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, timeout: 20000 }); } catch (e) {}
}

module.exports = { openWindow, fixShortcuts };
