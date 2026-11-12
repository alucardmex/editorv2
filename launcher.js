// Editor V2 - arranque con auto-actualizacion.
// 1) Si hay internet y Git, baja la ultima version de github.com/alucardmex/editorv2 (rama main).
// 2) Arranca el servidor (server.js) ya actualizado.
// Tus proyectos viven fuera de esta carpeta (..\proyectos), asi que una actualizacion nunca los toca.
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const REPO = 'https://github.com/alucardmex/editorv2.git';
const BRANCH = 'main';

function git(args, timeout = 30000) {
  return spawnSync('git', args, { cwd: DIR, encoding: 'utf8', timeout, windowsHide: true });
}
function version() {
  try { return fs.readFileSync(path.join(DIR, 'VERSION'), 'utf8').trim(); } catch (e) { return '?'; }
}

function update() {
  if (process.env.EDITOR_NO_UPDATE) return;
  const has = git(['--version'], 8000);
  if (has.error || has.status !== 0) { console.log('  (Sin Git: no busco actualizaciones)'); return; }
  const before = version();
  if (!fs.existsSync(path.join(DIR, '.git'))) {
    console.log('  Conectando esta carpeta con GitHub para recibir actualizaciones...');
    git(['init', '-q']);
    git(['remote', 'add', 'origin', REPO]);
  }
  process.stdout.write('  Buscando actualizaciones... ');
  const f = git(['fetch', '-q', '--depth', '1', 'origin', BRANCH], 25000);
  if (f.error || f.status !== 0) { console.log('sin conexion, sigo con la version ' + before + '.'); return; }
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const remote = git(['rev-parse', 'FETCH_HEAD']).stdout.trim();
  if (head === remote) { console.log('ya tienes la ultima (' + before + ').'); return; }
  const r = git(['reset', '-q', '--hard', 'FETCH_HEAD']);
  if (r.status !== 0) { console.log('no se pudo actualizar: ' + (r.stderr || '').trim()); return; }
  git(['branch', '-q', '-f', BRANCH, 'FETCH_HEAD']);
  const after = version();
  console.log('actualizado ' + before + ' -> ' + after + '.');
  try {
    const notes = fs.readFileSync(path.join(DIR, 'CAMBIOS.md'), 'utf8').split(/\r?\n## /)[1];
    if (notes) console.log('\n  Novedades:\n  ## ' + notes.trim().split(/\r?\n/).slice(0, 8).join('\n  ') + '\n');
  } catch (e) {}
}

console.log('');
console.log('  ==== Editor V2 ====');
update();
const child = spawn(process.execPath, [path.join(DIR, 'server.js')], { stdio: 'inherit', cwd: DIR });
child.on('exit', code => process.exit(code || 0));
process.on('SIGINT', () => child.kill('SIGINT'));
