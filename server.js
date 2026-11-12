// Editor V2 - servidor local (sin dependencias). Sirve la app y los archivos de la carpeta
// F:\edicionesclaude (la carpeta padre de /editor) y guarda los proyectos en /proyectos.
// Solo escucha en 127.0.0.1: nadie fuera de tu computadora puede entrar.
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { openWindow, fixShortcuts } = require('./window');

const APP_DIR = path.join(__dirname, 'app');
const ROOT = path.resolve(__dirname, '..');
const PROJ_DIR = path.join(ROOT, 'proyectos');
const HIST_DIR = path.join(PROJ_DIR, '.historial');
let PORT = Number(process.env.EDITOR_PORT || 5178);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webm': 'video/webm', '.woff2': 'font/woff2'
};

function inside(base, p) {
  const rel = path.relative(base, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sendFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('No encontrado'); }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function safeName(n) { return String(n || '').replace(/[^\w\-. áéíóúñÁÉÍÓÚÑ]/g, '').trim(); }

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  let p = decodeURIComponent(u.pathname);

  if (p === '/' || p === '/index.html') return sendFile(req, res, path.join(APP_DIR, 'index.html'));
  if (p.startsWith('/app/')) {
    const f = path.join(APP_DIR, p.slice(5));
    if (!inside(APP_DIR, f)) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, f);
  }
  if (p.startsWith('/media/')) {
    const f = path.join(ROOT, p.slice(7));
    if (!inside(ROOT, f)) { res.writeHead(403); return res.end(); }
    return sendFile(req, res, f);
  }
  if (p === '/api/version') {
    let v = '?', upd = null;
    try { v = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch (e) {}
    try { upd = JSON.parse(fs.readFileSync(path.join(__dirname, '.ultima-actualizacion.json'), 'utf8')); } catch (e) {}
    return json(res, 200, { app: 'editorv2', version: v, update: upd });
  }
  if (p === '/api/update/check') {
    return json(res, 200, require('./update').check());
  }
  if (p === '/api/update/apply' && req.method === 'POST') {
    const u = require('./update'), c = u.check();
    if (!c.ok) return json(res, 200, c);
    if (!c.available) return json(res, 200, { ok: true, from: c.current, to: c.current, restarting: false });
    const a = u.apply();
    json(res, 200, Object.assign({ restarting: a.ok }, a));
    if (a.ok) setTimeout(restart, 300);
    return;
  }
  if (p === '/api/ping') { lastPing = Date.now(); hadPing = true; return json(res, 200, { ok: true }); }
  if (p === '/api/bye') { lastBye = Date.now(); return json(res, 200, { ok: true }); }
  if (p === '/api/projects') {
    fs.mkdirSync(PROJ_DIR, { recursive: true });
    const list = fs.readdirSync(PROJ_DIR).filter(f => f.endsWith('.json')).map(f => {
      const st = fs.statSync(path.join(PROJ_DIR, f));
      return { name: f.replace(/\.json$/, ''), modified: st.mtimeMs };
    }).sort((a, b) => b.modified - a.modified);
    return json(res, 200, list);
  }
  if (p === '/api/project') {
    const name = safeName(u.query.name);
    if (!name) return json(res, 400, { error: 'Falta el nombre del proyecto' });
    const file = path.join(PROJ_DIR, name + '.json');
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return json(res, 404, { error: 'No existe ' + name });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 50e6) req.destroy(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          fs.mkdirSync(HIST_DIR, { recursive: true });
          if (fs.existsSync(file)) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(file, path.join(HIST_DIR, `${name}_${stamp}.json`));
            // deja solo las ultimas 30 copias de este proyecto
            const old = fs.readdirSync(HIST_DIR).filter(f => f.startsWith(name + '_')).sort();
            old.slice(0, Math.max(0, old.length - 30)).forEach(f => { try { fs.unlinkSync(path.join(HIST_DIR, f)); } catch (e) {} });
          }
          data.savedAt = new Date().toISOString();
          const tmp = file + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
          fs.renameSync(tmp, file);
          json(res, 200, { ok: true, savedAt: data.savedAt });
        } catch (e) { json(res, 400, { error: 'No se pudo guardar: ' + e.message }); }
      });
      return;
    }
  }
  if (p === '/api/media') {
    // lista audio/video de material/ para elegir musica u otros archivos
    const out = [];
    for (const dir of ['material', 'musica', 'editor_media']) {
      const d = path.join(ROOT, dir);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) if (/\.(mp4|mov|m4a|mp3|wav)$/i.test(f)) out.push(dir + '/' + f);
    }
    return json(res, 200, out);
  }
  res.writeHead(404); res.end('No encontrado');
});

// Reinicia el servidor con el codigo nuevo (la ventana del editor se recarga sola).
function restart() {
  console.log('Reiniciando con la version nueva...');
  server.close();
  let out = 'ignore';
  try { out = fs.openSync(path.join(__dirname, 'editor.log'), 'a'); } catch (e) {}
  const env = Object.assign({}, process.env, { EDITOR_NO_BROWSER: '1', EDITOR_PORT: String(PORT) });
  require('child_process').spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, env, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  setTimeout(() => process.exit(0), 200);
}

// Se apaga solo cuando cierras la ventana del editor (la ventana avisa que sigue abierta cada 4 s;
// minimizada el navegador puede espaciar los avisos hasta 1 por minuto, por eso el margen de 150 s).
let lastPing = 0, lastBye = 0, hadPing = false;
const BOOT = Date.now();
if (!process.env.EDITOR_KEEP_ALIVE) setInterval(() => {
  const now = Date.now();
  if (lastBye > lastPing && now - lastBye > 8000) { console.log('Ventana cerrada: apago el editor.'); process.exit(0); }
  if (hadPing && now - lastPing > 150000) { console.log('La ventana dejo de responder: apago el editor.'); process.exit(0); }
  if (!hadPing && now - BOOT > 180000) { console.log('No se abrio ninguna ventana: apago el editor.'); process.exit(0); }
}, 3000).unref();

function start() {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && PORT < 5190) { PORT++; start(); }
    else { console.error('No se pudo iniciar el editor:', e.message); process.exit(1); }
  });
  server.listen(PORT, '127.0.0.1', () => {
    const link = `http://localhost:${PORT}/`;
    console.log('Editor V2 abierto en ' + link + '  (carpeta de trabajo: ' + ROOT + ')');
    openWindow(link);
    setTimeout(() => fixShortcuts(__dirname), 1500);
  });
}
start();
