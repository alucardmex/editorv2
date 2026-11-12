// Recursos: descarga en segundo plano los archivos listados en ..\recursos\descargar.json
// (por ejemplo imagenes oficiales de prensa) a la carpeta ..\recursos. Solo baja lo que falta.
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'recursos');
const LIST = path.join(DIR, 'descargar.json');
const state = { running: false, done: [], failed: [], pending: 0 };

function get(url, file, hops = 0) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) return reject(new Error('solo https'));
    const req = https.get(url, { headers: { 'User-Agent': 'EditorV2' }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return resolve(get(new URL(res.headers.location, url).href, file, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const tmp = file + '.part'; const out = fs.createWriteStream(tmp);
      res.pipe(out); out.on('finish', () => out.close(() => { fs.renameSync(tmp, file); resolve(); })); out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('tiempo agotado'))); req.on('error', reject);
  });
}

async function sync() {
  if (state.running || !fs.existsSync(LIST)) return state;
  let items; try { items = JSON.parse(fs.readFileSync(LIST, 'utf8')).archivos || []; } catch (e) { console.log('recursos: descargar.json no es valido'); return state; }
  state.running = true; state.done = []; state.failed = [];
  const todo = items.filter(it => it.url && it.archivo && !fs.existsSync(path.join(DIR, it.archivo)));
  state.pending = todo.length;
  for (const it of todo) {
    const file = path.join(DIR, it.archivo);
    const rel = path.relative(DIR, file); if (rel.startsWith('..') || path.isAbsolute(rel)) { state.failed.push(it.archivo + ': ruta no valida'); state.pending--; continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { await get(it.url, file); state.done.push(it.archivo); console.log('recursos: descargado ' + it.archivo); }
    catch (e) { state.failed.push(it.archivo + ': ' + e.message); console.log('recursos: fallo ' + it.archivo + ' (' + e.message + ')'); }
    state.pending--;
  }
  state.running = false; return state;
}

function list() {
  const out = [];
  const walk = (d, depth) => { if (depth > 3 || !fs.existsSync(d)) return; for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) walk(p, depth + 1); else if (/\.(png|jpe?g|webp|mp4|mov|m4a|mp3|wav)$/i.test(f)) out.push(path.relative(ROOT, p).split(path.sep).join('/')); } };
  walk(DIR, 0); return out;
}

module.exports = { sync, list, state };
