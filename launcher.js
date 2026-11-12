// Editor V2 - arranque con auto-actualizacion.
// 1) Si el editor ya esta abierto, solo abre otra ventana y termina.
// 2) Si hay internet y Git, baja la ultima version de github.com/alucardmex/editorv2 (rama main).
// 3) Arranca el servidor (server.js) ya actualizado. El servidor se apaga solo al cerrar la ventana.
// Tus proyectos viven fuera de esta carpeta (..\proyectos), asi que una actualizacion nunca los toca.
const { spawnSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const REPO = 'https://github.com/alucardmex/editorv2.git';
const BRANCH = 'main';
const PORT = Number(process.env.EDITOR_PORT || 5178);
const INFO = path.join(DIR, '.ultima-actualizacion.json');

function git(args, timeout = 30000) {
  return spawnSync('git', args, { cwd: DIR, encoding: 'utf8', timeout, windowsHide: true });
}
function version() {
  try { return fs.readFileSync(path.join(DIR, 'VERSION'), 'utf8').trim(); } catch (e) { return '?'; }
}
function log(s) { console.log(new Date().toISOString().slice(11, 19) + '  ' + s); }

function alreadyRunning() {
  return new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/version', timeout: 800 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b).app === 'editorv2'); } catch (e) { res(false); } });
    });
    req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
  });
}

function update() {
  if (process.env.EDITOR_NO_UPDATE) return;
  const has = git(['--version'], 8000);
  if (has.error || has.status !== 0) { log('Sin Git: no busco actualizaciones'); return; }
  const before = version();
  if (!fs.existsSync(path.join(DIR, '.git'))) {
    log('Conectando esta carpeta con GitHub para recibir actualizaciones');
    git(['init', '-q']);
    git(['remote', 'add', 'origin', REPO]);
  }
  const f = git(['fetch', '-q', '--depth', '1', 'origin', BRANCH], 25000);
  if (f.error || f.status !== 0) { log('Sin conexion con GitHub, sigo con la version ' + before); return; }
  const head = (git(['rev-parse', 'HEAD']).stdout || '').trim();
  const remote = (git(['rev-parse', 'FETCH_HEAD']).stdout || '').trim();
  if (head && head === remote) { log('Ya tienes la ultima version (' + before + ')'); return; }
  const r = git(['reset', '-q', '--hard', 'FETCH_HEAD']);
  if (r.status !== 0) { log('No se pudo actualizar: ' + (r.stderr || '').trim()); return; }
  git(['branch', '-q', '-f', BRANCH, 'FETCH_HEAD']);
  const after = version();
  log('Actualizado ' + before + ' -> ' + after);
  let notes = '';
  try { notes = (fs.readFileSync(path.join(DIR, 'CAMBIOS.md'), 'utf8').split(/\r?\n## /)[1] || '').trim(); } catch (e) {}
  try { fs.writeFileSync(INFO, JSON.stringify({ from: before, to: after, at: new Date().toISOString(), notes: '## ' + notes })); } catch (e) {}
}

(async () => {
  log('Editor V2 ' + version());
  if (await alreadyRunning()) {
    log('El editor ya estaba abierto: abro otra ventana');
    require('./window').openWindow(`http://localhost:${PORT}/`);
    return;
  }
  update();
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], { stdio: 'inherit', cwd: DIR, windowsHide: true });
  child.on('exit', code => process.exit(code || 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
})();
