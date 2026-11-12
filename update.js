// Actualizacion desde GitHub (la usan launcher.js al abrir y server.js mientras el editor esta abierto).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const REPO = 'https://github.com/alucardmex/editorv2.git';
const BRANCH = 'main';
const INFO = path.join(DIR, '.ultima-actualizacion.json');

function git(args, timeout = 30000) {
  return spawnSync('git', args, { cwd: DIR, encoding: 'utf8', timeout, windowsHide: true });
}
function version() {
  try { return fs.readFileSync(path.join(DIR, 'VERSION'), 'utf8').trim(); } catch (e) { return '?'; }
}
function hasGit() { const r = git(['--version'], 8000); return !r.error && r.status === 0; }

// Busca si hay una version nueva. No cambia ningun archivo.
function check() {
  if (process.env.EDITOR_NO_UPDATE) return { ok: false, reason: 'desactivado' };
  if (!hasGit()) return { ok: false, reason: 'sin Git' };
  if (!fs.existsSync(path.join(DIR, '.git'))) { git(['init', '-q']); git(['remote', 'add', 'origin', REPO]); }
  const f = git(['fetch', '-q', '--depth', '1', 'origin', BRANCH], 25000);
  if (f.error || f.status !== 0) return { ok: false, reason: 'sin conexión' };
  const head = (git(['rev-parse', 'HEAD']).stdout || '').trim();
  const remote = (git(['rev-parse', 'FETCH_HEAD']).stdout || '').trim();
  const remoteVersion = (git(['show', 'FETCH_HEAD:VERSION']).stdout || '').trim() || '?';
  return { ok: true, current: version(), remoteVersion, available: !head || head !== remote };
}

// Aplica la version descargada por check(). Devuelve {from,to}.
function apply() {
  const before = version();
  const r = git(['reset', '-q', '--hard', 'FETCH_HEAD']);
  if (r.status !== 0) return { ok: false, reason: (r.stderr || '').trim() };
  git(['branch', '-q', '-f', BRANCH, 'FETCH_HEAD']);
  const after = version();
  let notes = '';
  try { notes = (fs.readFileSync(path.join(DIR, 'CAMBIOS.md'), 'utf8').split(/\r?\n## /)[1] || '').trim(); } catch (e) {}
  try { fs.writeFileSync(INFO, JSON.stringify({ from: before, to: after, at: new Date().toISOString(), notes: '## ' + notes })); } catch (e) {}
  return { ok: true, from: before, to: after };
}

module.exports = { check, apply, version };
