// Editor V2 - arranque con auto-actualizacion.
// 1) Si el editor ya esta abierto, solo abre otra ventana y termina.
// 2) Si hay internet y Git, baja la ultima version de github.com/alucardmex/editorv2 (rama main).
// 3) Arranca el servidor (server.js) ya actualizado. El servidor se apaga solo al cerrar la ventana.
// Tus proyectos viven fuera de esta carpeta (..\proyectos), asi que una actualizacion nunca los toca.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const DIR = __dirname;
const PORT = Number(process.env.EDITOR_PORT || 5178);
const upd = require('./update');

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
  const c = upd.check();
  if (!c.ok) { log('No busco actualizaciones (' + c.reason + '), sigo con la version ' + upd.version()); return; }
  if (!c.available) { log('Ya tienes la ultima version (' + c.current + ')'); return; }
  const a = upd.apply();
  log(a.ok ? 'Actualizado ' + a.from + ' -> ' + a.to : 'No se pudo actualizar: ' + a.reason);
}

(async () => {
  log('Editor V2 ' + upd.version());
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
