/* Editor V2 — vista previa y linea de tiempo para los videos que edita Claude.
   Todo se guarda en tiempo del video ORIGINAL (segundos de la fuente); la vista "Editado"
   lo convierte al tiempo final saltando los cortes y aplicando la velocidad. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const vid = $('#vid'), mus = $('#mus'), scr = $('#screen'), sctx = scr.getContext('2d');
const tl = $('#tl'), tctx = tl.getContext('2d');
const FPS = 30;

let P = null, projName = '';
let view = 'edit';
let sel = null;                // {type:'segment'|'word'|'zoom'|'card'|'music', id}
let playing = false, dirty = false;
let undoStack = [], redoStack = [];
let pxPerSec = 20, scrollT = 0; // linea de tiempo: pixeles por segundo (vista) y desplazamiento (vista)
let map = [];                  // [{s,e,o}] segmentos conservados, o = inicio en salida (segundos fuente)
let groups = [];               // grupos de subtitulos
let mediaList = [];
let faceTrack = [];

// ---------- utilidades ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r3 = v => Math.round(v * 1000) / 1000;
const uid = p => p + Math.random().toString(36).slice(2, 8);
function fmt(t) { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0'); }
function toast(msg, ms = 1800) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms); }
function mediaUrl(p) { return '/media/' + p.split('/').map(encodeURIComponent).join('/'); }
const easeOut = x => 1 - Math.pow(1 - x, 3);
const easeBack = x => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

// ---------- mapa de tiempo ----------
function rebuild() {
  P.segments.sort((a, b) => a.start - b.start);
  map = []; let o = 0;
  for (const s of P.segments) if (s.keep) { map.push({ s: s.start, e: s.end, o, seg: s }); o += s.end - s.start; }
  buildGroups();
  updateStats();
  renderWarnings();
}
const speed = () => (P && P.speed) || 1;
const outDur = () => map.length ? (map[map.length - 1].o + map[map.length - 1].e - map[map.length - 1].s) / speed() : 0;
function keptAt(t) { for (const m of map) if (t >= m.s && t < m.e) return m; return null; }
function srcToOut(t) {
  for (const m of map) { if (t < m.s) return m.o / speed(); if (t < m.e) return (m.o + t - m.s) / speed(); }
  return outDur();
}
function outToSrc(o) {
  o = o * speed();
  for (const m of map) { if (o < m.o + (m.e - m.s)) return m.s + Math.max(0, o - m.o); }
  const last = map[map.length - 1]; return last ? last.e : 0;
}
const toView = t => view === 'edit' ? srcToOut(t) : t;
const fromView = v => view === 'edit' ? outToSrc(v) : v;
const viewDur = () => view === 'edit' ? outDur() : P.source.duration;
// piezas visibles de un intervalo [a,b] en la vista actual
function pieces(a, b) {
  if (view === 'orig') return b > a ? [[a, b]] : [];
  const out = [];
  for (const m of map) { const x = Math.max(a, m.s), y = Math.min(b, m.e); if (y > x) out.push([srcToOut(x), srcToOut(x) + (y - x) / speed()]); }
  return out;
}

// ---------- subtitulos ----------
function cleanWord(t) { return String(t).replace(/[¡!¿?.,;:…"“”]+/g, '').replace(/\.\.\./g, ''); }
function buildGroups() {
  groups = [];
  const st = P.subtitles || {};
  const max = st.style === 'frase' ? Math.max(4, st.maxWords || 7) : Math.max(1, st.maxWords || 3);
  // que el bloque quepa en una linea: ~ancho util / ancho medio de una letra mayuscula gruesa
  const maxChars = Math.max(6, Math.floor(940 / ((st.size || 80) * 0.74)));
  const ws = P.words.filter(w => !w.hidden && keptAt((w.start + w.end) / 2)).sort((a, b) => a.start - b.start);
  let g = null;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], prev = ws[i - 1];
    const chars = g ? g.words.reduce((a, x) => a + cleanWord(x.text).length + 1, 0) + cleanWord(w.text).length : 0;
    const brk = !g || g.words.length >= max || (st.style !== 'frase' && chars > maxChars) || (prev && (w.start - prev.end) > 0.35) || (prev && /[.!?…]$/.test(prev.text.trim())) ||
      (prev && keptAt((prev.start + prev.end) / 2) !== keptAt((w.start + w.end) / 2) && (w.start - prev.end) > 0.12);
    if (brk) { g = { words: [], start: w.start }; groups.push(g); }
    g.words.push(w);
  }
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i], lastW = g.words[g.words.length - 1];
    const nxt = groups[i + 1];
    g.end = nxt ? Math.min(nxt.start, lastW.end + 0.6) : lastW.end + 0.5;
    if (nxt && nxt.start - lastW.end < 0.6) g.end = nxt.start;
  }
}

// ---------- historial ----------
const snapKeys = ['segments', 'words', 'zooms', 'cards', 'effects', 'music', 'subtitles', 'speed', 'layout', 'status', 'style', 'camera', 'grading'];
function snap() { const o = {}; for (const k of snapKeys) o[k] = P[k]; return JSON.stringify(o); }
function pushUndo() { undoStack.push(snap()); if (undoStack.length > 150) undoStack.shift(); redoStack = []; }
function restore(s) { const o = JSON.parse(s); for (const k of snapKeys) P[k] = o[k]; rebuild(); renderInspector(); drawAll(); }
function undo() { if (!undoStack.length) return toast('Nada que deshacer'); redoStack.push(snap()); restore(undoStack.pop()); setDirty(true); toast('Deshecho'); }
function redo() { if (!redoStack.length) return toast('Nada que rehacer'); undoStack.push(snap()); restore(redoStack.pop()); setDirty(true); toast('Rehecho'); }
function setDirty(v) {
  dirty = v; $('#dirty').classList.toggle('on', v);
  if (v && P.status && P.status.approved) { P.status.approved = false; updateApprove(); toast('Cambiaste algo: vuelve a marcar "Listo para renderizar" cuando termines', 3200); }
}
function mutate(fn) { pushUndo(); fn(); rebuild(); setDirty(true); renderInspector(); drawAll(); }

// ---------- carga y guardado ----------
async function loadProjects() {
  const list = await (await fetch('/api/projects')).json();
  const sel_ = $('#projSel'); sel_.innerHTML = '';
  if (!list.length) { sel_.innerHTML = '<option>(sin proyectos)</option>'; $('#loading').textContent = 'No hay proyectos en la carpeta proyectos. Pídele a Claude que prepare uno.'; return; }
  for (const p of list) { const o = document.createElement('option'); o.value = p.name; o.textContent = p.name; sel_.appendChild(o); }
  const want = new URLSearchParams(location.search).get('p');
  await loadProject(want && list.some(p => p.name === want) ? want : list[0].name);
  sel_.value = projName;
}
async function loadProject(name) {
  if (dirty && !confirm('Hay cambios sin guardar. ¿Cambiar de proyecto de todas formas?')) { $('#projSel').value = projName; return; }
  const r = await fetch('/api/project?name=' + encodeURIComponent(name));
  if (!r.ok) return toast('No se pudo abrir ' + name);
  P = await r.json(); projName = name;
  P.zooms = P.zooms || []; P.cards = P.cards || []; P.effects = P.effects || []; P.words = P.words || []; P.status = P.status || {};
  P.subtitles = P.subtitles || { style: 'amarillo', maxWords: 3, y: 770, size: 84 };
  faceTrack = P.faces || [];
  undoStack = []; redoStack = []; sel = null; setDirty(false);
  $('#loading').classList.remove('hidden'); $('#loading').textContent = 'Cargando video…';
  vid.src = mediaUrl(P.source.proxy || P.source.file);
  vid.load();
  if (P.music && P.music.file) { mus.src = mediaUrl(P.music.file); mus.load(); } else mus.removeAttribute('src');
  rebuild();
  try { mediaList = await (await fetch('/api/media')).json(); } catch (e) { mediaList = []; }
  rebuild(); fitTimeline(); renderInspector(); updateApprove(); drawAll();
  document.title = 'Editor V2 — ' + name;
}
async function save() {
  if (!P) return;
  const r = await fetch('/api/project?name=' + encodeURIComponent(projName), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(P) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { setDirty(false); toast('Guardado ✓'); } else toast(j.error || 'Error al guardar', 3500);
}
function updateApprove() {
  const b = $('#btnApprove'), ok = P && P.status && P.status.approved;
  b.textContent = ok ? '✓ Listo para renderizar' : 'Listo para renderizar';
  b.classList.toggle('ok', !!ok);
}

// ---------- reproduccion ----------
vid.addEventListener('loadeddata', () => { $('#loading').classList.add('hidden'); drawScreen(); });
vid.addEventListener('error', () => { $('#loading').textContent = 'No se pudo cargar el video: ' + (P && (P.source.proxy || P.source.file)); });
vid.addEventListener('seeked', () => { if (!playing) drawAll(); });
function cur() { return vid.currentTime || 0; }
function seekSrc(t) {
  t = clamp(t, 0, P.source.duration - 0.001);
  if (view === 'edit' && !keptAt(t)) { const n = map.find(m => m.s > t); t = n ? n.s : (map.length ? map[map.length - 1].e - 0.02 : t); }
  vid.currentTime = t; syncMusic(true); drawAll();
}
function seekView(v) { seekSrc(fromView(clamp(v, 0, viewDur()))); }
function play() {
  if (!P) return;
  if (view === 'edit') {
    const t = cur();
    if (!keptAt(t) || t >= map[map.length - 1].e - 0.03) { const n = map.find(m => m.s > t); vid.currentTime = n ? n.s : map[0].s; }
  }
  vid.playbackRate = view === 'edit' ? speed() : 1;
  vid.play().catch(() => {}); playing = true; $('#btnPlay').textContent = '❚❚'; syncMusic(true);
}
function pause() { vid.pause(); mus.pause(); playing = false; $('#btnPlay').textContent = '▶'; drawAll(); }
function musicWanted() { return view === 'edit' && P.music && P.music.file && P.music.enabled !== false && $('#chkMusic').checked; }
function syncMusic(force) {
  if (!P) return;
  if (!musicWanted()) { mus.pause(); return; }
  mus.volume = musicVolumeAt(cur());
  const want = srcToOut(cur()) + (P.music.offset || 0);
  if (mus.duration && want > mus.duration) { mus.pause(); return; }
  if (force || Math.abs(mus.currentTime - want) > 0.25) { try { mus.currentTime = want; } catch (e) {} }
  if (playing && mus.paused) mus.play().catch(() => {});
  if (!playing && !mus.paused) mus.pause();
}
// musica: baja mientras hablas (ducking) y sube en las pausas
let duckGain = 1;
function musicVolumeAt(t) {
  const m = P.music || {}, base = clamp(m.volume == null ? 0.15 : m.volume, 0, 1);
  if (!m.duck || m.duck.enabled === false) return base;
  const talking = P.words.some(w => !w.hidden && t >= w.start - 0.12 && t < w.end + 0.18);
  const target = talking ? (m.duck.level == null ? 0.55 : m.duck.level) : 1;
  duckGain += (target - duckGain) * 0.18;
  return clamp(base * duckGain, 0, 1);
}
// efectos de sonido: suenan cuando el cursor de reproduccion pasa por su inicio (vista Editado)
let lastFxT = null; const sfxCache = {};
function playSfxBetween(t0, t1) {
  if (!$('#chkSfx') || !$('#chkSfx').checked) return;
  for (const e of P.effects || []) {
    if (!e.file || e.enabled === false) continue;
    if (e.start > t0 && e.start <= t1 && keptAt(e.start)) {
      try {
        const a = new Audio(mediaUrl(e.file)); a.volume = clamp(e.volume == null ? 0.35 : e.volume, 0, 1); a.play().catch(() => {});
        sfxCache[e.id] = a;
      } catch (err) {}
    }
  }
}
function tick() {
  if (playing && P) {
    const t = cur();
    if (view === 'edit') {
      const m = keptAt(t);
      if (!m) {
        const n = map.find(x => x.s > t);
        if (n) { vid.currentTime = n.s; syncMusic(true); lastFxT = n.s - 0.001; } else pause();
      } else if (t >= m.e - 0.012) {
        const i = map.indexOf(m), n = map[i + 1];
        if (lastFxT != null) playSfxBetween(lastFxT, m.e);
        if (n) { vid.currentTime = n.s; syncMusic(true); lastFxT = n.s - 0.001; } else { pause(); vid.currentTime = m.e - 0.02; }
      } else {
        if (lastFxT != null && t > lastFxT && t - lastFxT < 1) playSfxBetween(lastFxT, t);
        lastFxT = t; syncMusic(false);
      }
    }
    if (vid.ended) pause();
    // seguir el cursor en la linea de tiempo
    const x = (toView(cur()) - scrollT) * pxPerSec, w = tl.clientWidth;
    if (x > w * 0.85 || x < 0) { scrollT = Math.max(0, toView(cur()) - (w * 0.15) / pxPerSec); }
    drawAll();
  } else lastFxT = null;
  requestAnimationFrame(tick);
}

// ---------- estilo ----------
const DEFAULT_STYLE = {
  colores: { fondo: '#0A0A0A', texto: '#FFFFFF', acento: '#FFD400', secundario: '#E0242F' },
  fuentes: { titulos: 'Sora', pesoTitulos: 800, texto: 'Inter', pesoTexto: 700 },
  movimiento: 'suave',
  subtitulos: { activos: true, modo: 'palabra', mayusculas: true, caja: true, textoActivo: '#0A0A0A', palabrasPorBloque: 3 }
};
function ST() {
  const s = (P && P.style) || {};
  return {
    colores: Object.assign({}, DEFAULT_STYLE.colores, s.colores || {}),
    fuentes: Object.assign({}, DEFAULT_STYLE.fuentes, s.fuentes || {}),
    movimiento: s.movimiento || DEFAULT_STYLE.movimiento,
    subtitulos: Object.assign({}, DEFAULT_STYLE.subtitulos, s.subtitulos || {})
  };
}
const fontT = (st, size, w) => `${w || st.fuentes.pesoTitulos} ${size}px "${st.fuentes.titulos}", Sora, Inter, "Segoe UI", Arial, sans-serif`;
const fontB = (st, size, w) => `${w || st.fuentes.pesoTexto} ${size}px "${st.fuentes.texto}", Inter, "Segoe UI", Arial, sans-serif`;
// entradas segun el movimiento elegido
function enter(st, p) {
  if (st.movimiento === 'energico') return easeBack(p);
  if (st.movimiento === 'cinematico') return 1 - Math.pow(2, -10 * p);
  return easeOut(p);
}
const inDur = st => st.movimiento === 'cinematico' ? 0.5 : st.movimiento === 'energico' ? 0.22 : 0.32;

// iconos lineales (24x24)
const ICONS = {
  store: 'M3 9l1.5-5h15L21 9M3 9h18v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0zM5 13v7h14v-7M10 20v-4h4v4',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 7',
  fire: 'M12 22a7 7 0 0 0 7-7c0-4-3-6-4-9-1 2-2 3-4 3 0-2-1-4-2-5-1 4-4 6-4 11a7 7 0 0 0 7 7z',
  phone: 'M7 2h10v20H7zM11 18h2',
  gift: 'M3 8h18v4H3zM5 12v9h14v-9M12 8v13M12 8S10 3 7.5 4 9 8 12 8zM12 8s2-5 4.5-4S15 8 12 8z',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  star: 'M12 3l2.8 5.8 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.3l1.1-6.2L3 9.7l6.2-.9z',
  ticket: 'M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4zM14 6v12',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12zM8.5 12h.01M12 12h.01M15.5 12h.01',
  gamepad: 'M6 8h12a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L15 13H9l-1.6 1.8A3 3 0 0 1 2 13v-1a4 4 0 0 1 4-4zM7 11v3M5.5 12.5h3M15.5 11.5h.01M17.5 13h.01',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8M9 21l1-4h4l1 4',
  check: 'M4 12l5 5L20 6',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z'
};
const iconPaths = {};
function iconPath(name) { if (!ICONS[name]) return null; return iconPaths[name] || (iconPaths[name] = new Path2D(ICONS[name])); }
function drawIcon(c, name, x, y, size, color) {
  const p = iconPath(name); if (!p) return false;
  c.save(); c.translate(x - size / 2, y - size / 2); c.scale(size / 24, size / 24);
  c.strokeStyle = color; c.lineWidth = 2.2; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke(p); c.restore(); return true;
}
// "Stand *Huawei*" -> partes con acento
function parts(text) { const out = []; String(text || '').split(/(\*[^*]+\*)/).forEach(s => { if (!s) return; if (/^\*.*\*$/.test(s)) out.push({ s: s.slice(1, -1), acc: true }); else out.push({ s, acc: false }); }); return out; }
function drawParts(c, ps, x, y, colorN, colorA, upper) { for (const p of ps) { const s = upper ? p.s.toUpperCase() : p.s; c.fillStyle = p.acc ? colorA : colorN; c.fillText(s, x, y); x += c.measureText(s).width; } return x; }
function partsWidth(c, ps, upper) { return ps.reduce((a, p) => a + c.measureText(upper ? p.s.toUpperCase() : p.s).width, 0); }
function fitParts(c, ps, fontFn, size, maxW, upper) { let s = size; c.font = fontFn(s); while (partsWidth(c, ps, upper) > maxW && s > 24) { s -= 2; c.font = fontFn(s); } return s; }

// ---------- composicion del cuadro ----------
function zoomAt(t) {
  let z = 1, cx = null, cy = null;
  for (const zz of P.zooms) {
    if (t >= zz.start && t < zz.end) {
      const pin = clamp((t - zz.start) / (zz.ramp == null ? 0.12 : Math.max(0.001, zz.ramp)), 0, 1);
      z = 1 + (zz.z - 1) * easeOut(pin);
      if (zz.x != null) cx = zz.x; if (zz.y != null) cy = zz.y;
    }
  }
  // camara en movimiento (nivel 3): empuje lento dentro de cada clip
  const cam = P.camera || {};
  if (cam.drift) { const m = keptAt(t); if (m) { const p = clamp((t - m.s) / Math.max(0.3, m.e - m.s), 0, 1); z *= 1 + cam.drift * p; } }
  return { z, cx, cy };
}
function faceAt(t) {
  if (!faceTrack.length) return { x: P.layout.faceX, y: P.layout.faceY };
  let best = faceTrack[0];
  for (const f of faceTrack) { if (Math.abs(f[0] - t) < Math.abs(best[0] - t)) best = f; }
  return { x: best[1], y: best[2] };
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function fitFont(c, text, font, size, maxW) { let s = size; c.font = font.replace('{s}', s); while (c.measureText(text).width > maxW && s > 20) { s -= 2; c.font = font.replace('{s}', s); } return s; }

function drawCard(c, card, t) {
  const st = ST(), K = st.colores, L = P.layout;
  const inP = clamp((t - card.start) / inDur(st), 0, 1), outP = clamp((card.end - t) / 0.18, 0, 1);
  const a = Math.min(easeOut(inP), outP); if (a <= 0) return;
  const e = enter(st, inP);
  const cx = 540, cy = card.y != null ? card.y : bands().game.dy + bands().game.sh / 2;
  const hasSub = !!(card.subtitle && card.subtitle.trim());
  const W = 900, H = hasSub ? 230 : 170, accent = card.color || K.secundario;
  c.save(); c.globalAlpha = a; c.translate(cx + (1 - e) * -60, cy + (1 - e) * 26);
  c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 40; c.shadowOffsetY = 14;
  roundRect(c, -W / 2, -H / 2, W, H, 30); c.fillStyle = hexA(K.fondo, 0.92); c.fill();
  c.shadowColor = 'transparent';
  // barra de color a la izquierda
  c.save(); roundRect(c, -W / 2, -H / 2, W, H, 30); c.clip(); c.fillStyle = accent; c.fillRect(-W / 2, -H / 2, 14, H); c.restore();
  // icono
  const ix = -W / 2 + 44 + 65, iy = 0;
  roundRect(c, ix - 65, iy - 65, 130, 130, 30); c.fillStyle = accent; c.fill();
  if (!drawIcon(c, card.icon, ix, iy, 76, '#FFFFFF')) { c.font = '64px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'; c.fillText(card.icon || '★', ix, iy + 4); }
  // textos
  const tx = ix + 65 + 34, maxW = W / 2 - 40 - tx;
  const ps = parts(card.title);
  const fs = fitParts(c, ps, s => fontT(st, s), 88, maxW, true);
  c.textAlign = 'left'; c.textBaseline = hasSub ? 'alphabetic' : 'middle';
  drawParts(c, ps, tx, hasSub ? 8 : 6, K.texto, K.acento, true);
  if (hasSub) {
    const sub = card.subtitle.toUpperCase(); c.font = fontB(st, 40); fitFont(c, sub, fontB(st, '{s}').replace('{s}px', '{s}px'), 40, maxW);
    c.fillStyle = hexA(K.texto, 0.8); c.textBaseline = 'top'; c.fillText(sub, tx, 30);
  }
  void fs; c.restore();
}
function hexA(hex, a) { const h = String(hex || '#000').replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; }

function drawSubtitle(c, t) {
  const sp = P.subtitles || {};
  if (sp.enabled === false) return;
  const g = groups.find(g => t >= g.start && t < g.end); if (!g) return;
  for (const card of P.cards) if (card.hideSubtitles && t >= card.start && t < card.end) return;
  for (const e of P.effects || []) if (e.hideSubtitles && t >= e.start && t < e.end) return;
  const st = ST(), K = st.colores, ss = st.subtitulos;
  const frase = sp.style === 'frase' || ss.modo === 'frase';
  const upper = ss.mayusculas !== false;
  const size = sp.size || (frase ? 62 : 96);
  const subFont = ss.fuente ? `400 ${size}px "${ss.fuente}", Impact, "Arial Narrow", sans-serif` : fontT(st, size);
  c.save(); c.font = subFont; c.textBaseline = 'middle'; c.lineJoin = 'round';
  const words = g.words.map(w => ({ w, s: upper ? cleanWord(w.text).toUpperCase() : cleanWord(w.text) })).filter(x => x.s);
  const padX = ss.caja ? size * 0.2 : 0, gap = size * 0.18, maxW = 960;
  const lines = [[]]; let lw = 0;
  for (const x of words) { x.width = c.measureText(x.s).width + padX * 2; if (lw + x.width > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push(x); lw += x.width + gap; }
  const lh = size * 1.28, y0 = (sp.y || bands().seam - 50) - (lines.length - 1) * lh / 2;
  // entrada suave del bloque
  const inP = clamp((t - g.start) / 0.14, 0, 1), blockA = easeOut(inP);
  lines.forEach((ln, li) => {
    const total = ln.reduce((a, x) => a + x.width, 0) + gap * (ln.length - 1);
    let x = 540 - total / 2; const y = y0 + li * lh;
    for (const it of ln) {
      const active = t >= it.w.start && t < Math.max(it.w.end, it.w.start + 0.08);
      const spoken = t >= it.w.start;
      const pop = active ? 1 + 0.06 * (1 - clamp((t - it.w.start) / 0.14, 0, 1)) : 1;
      c.save(); c.globalAlpha = blockA; c.translate(x + it.width / 2, y + (1 - blockA) * 14); c.scale(pop, pop); c.textAlign = 'center';
      if (ss.caja && active) {
        c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 24; c.shadowOffsetY = 8;
        roundRect(c, -it.width / 2, -size * 0.62, it.width, size * 1.2, size * 0.16); c.fillStyle = K.acento; c.fill();
        c.shadowColor = 'transparent'; c.fillStyle = ss.textoActivo || K.fondo; c.fillText(it.s, 0, size * 0.04);
      } else {
        c.shadowColor = 'rgba(0,0,0,.75)'; c.shadowBlur = 18; c.shadowOffsetY = 5;
        if (!ss.caja && ss.contorno !== false) { c.lineWidth = size * 0.12; c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(it.s, 0, size * 0.04); }
        c.fillStyle = ss.caja ? K.texto : (active ? K.acento : (frase && !spoken ? hexA(K.texto, 0.55) : K.texto));
        c.fillText(it.s, 0, size * 0.04);
      }
      c.restore(); x += it.width + gap;
    }
  });
  c.restore();
}

// ---------- efectos de nivel 3 ----------
function rng(seed) { let s = 0; for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function drawParticles(c, e, t) {
  const st = ST(), K = st.colores, dur = Math.max(0.3, e.end - e.start), p = clamp((t - e.start) / dur, 0, 1);
  const r = rng(e.id), n = e.count || 70, R0 = e.spread || 0, x0 = e.x != null ? e.x : 540, y0 = e.y != null ? e.y : (P.layout.gameTop + P.layout.gameBottom) / 2;
  const cols = [K.acento, K.secundario, '#FFFFFF'];
  c.save();
  for (let i = 0; i < n; i++) {
    const ang = r() * Math.PI * 2, sp = e.spread ? 260 + r() * 520 : 380 + r() * 820, life = 0.55 + r() * 0.45, sz = 6 + r() * 12, col = cols[i % 3], rot0 = r() * 6;
    const q = clamp(p / life, 0, 1); if (q >= 1) continue;
    const tt = q * dur * life, x = x0 + Math.cos(ang) * (R0 * 0.9 + sp * tt * (1 - q * 0.35)), y = y0 + Math.sin(ang) * (R0 * 0.45 + sp * tt * (1 - q * 0.35)) + 520 * tt * tt;
    c.globalAlpha = (1 - q) * (q < 0.08 ? q / 0.08 : 1); c.fillStyle = col;
    c.save(); c.translate(x, y); c.rotate(rot0 + q * 8);
    if (i % 2) c.fillRect(-sz / 2, -sz / 4, sz, sz / 2); else { c.beginPath(); c.arc(0, 0, sz / 2.4, 0, Math.PI * 2); c.fill(); }
    c.restore();
  }
  c.restore();
}
function drawText3D(c, e, t) {
  const st = ST(), K = st.colores, dur = e.end - e.start;
  const inP = clamp((t - e.start) / 0.45, 0, 1), outP = clamp((e.end - t) / 0.25, 0, 1);
  const a = Math.min(1, outP), k = 1 - Math.pow(1 - inP, 4);
  const x = e.x != null ? e.x : 540, y = e.y != null ? e.y : (P.layout.gameTop + P.layout.gameBottom) / 2;
  const lines = String(e.text || '').split('|');
  const size = e.size || 132, depth = 16;
  c.save(); c.globalAlpha = a; c.translate(x, y);
  const sc = 0.55 + 0.45 * k, tilt = (1 - k) * 0.9;
  c.scale(sc, sc * (1 - tilt * 0.45)); c.rotate(-0.06 * (1 - k));
  c.textAlign = 'center'; c.textBaseline = 'middle';
  const lh = size * 1.02, y0 = -(lines.length - 1) * lh / 2;
  lines.forEach((ln, i) => {
    const ps = parts(ln); c.font = fontT(st, size, 800);
    const w = partsWidth(c, ps, true); let fsz = size; while (w * fsz / size > 980 && fsz > 50) fsz -= 4; c.font = fontT(st, fsz, 800);
    const ww = partsWidth(c, ps, true), yy = y0 + i * lh;
    c.textAlign = 'left';
    for (let d = depth; d > 0; d--) { c.fillStyle = d === depth ? 'rgba(0,0,0,.55)' : hexA(K.secundario, 0.35 + 0.5 * (1 - d / depth)); const px = -ww / 2 + d * 1.2, py = yy + d * 1.6; drawParts(c, ps.map(p => ({ s: p.s, acc: false })), px, py, c.fillStyle, c.fillStyle, true); }
    drawParts(c, ps, -ww / 2, yy, K.texto, K.acento, true);
  });
  void dur; c.restore();
}
function drawFlash(c, e, t) { const p = clamp((t - e.start) / Math.max(0.05, e.end - e.start), 0, 1); c.save(); c.globalAlpha = (e.strength || 0.55) * (1 - p) * (1 - p); c.fillStyle = '#fff'; c.fillRect(0, 0, 1080, 1920); c.restore(); }
function drawEffects(c, t) {
  for (const e of P.effects || []) {
    if (e.enabled === false || t < e.start || t >= e.end) continue;
    if (e.type === 'particles') drawParticles(c, e, t);
    else if (e.type === 'text3d') drawText3D(c, e, t);
    else if (e.type === 'flash') drawFlash(c, e, t);
  }
}

// bandas de la composicion: de donde sale cada parte del video original y a donde va
function bands() {
  const L = P.layout, camH = L.camBottom - L.camTop, gameH = L.gameBottom - L.gameTop;
  const gameTop = L.order === 'game-top', top0 = Math.min(L.camTop, L.gameTop);
  const cam = { sy: L.camTop, sh: camH, dy: gameTop ? top0 + gameH : top0 };
  const game = { sy: L.gameTop, sh: gameH, dy: gameTop ? top0 : top0 + camH };
  const f = L.frame || {}, inset = f.enabled ? (f.inset == null ? 26 : f.inset) : 0;
  const frame = { x: inset, y: game.dy + inset, w: 1080 - inset * 2, h: gameH - inset * 2, r: f.enabled ? (f.radius == null ? 28 : f.radius) : 0, on: !!f.enabled };
  const seam = gameTop ? cam.dy : game.dy;
  return { cam, game, frame, seam, gameTop, top: top0, bottom: top0 + camH + gameH };
}
function drawPanel(c, card, t, fr) {
  const st = ST(), K = st.colores;
  const inP = clamp((t - card.start) / 0.28, 0, 1), outP = clamp((card.end - t) / 0.16, 0, 1);
  const a = Math.min(easeOut(inP), outP); if (a <= 0) return;
  const e = easeOut(inP), accent = card.color || K.acento;
  c.save(); roundRect(c, fr.x, fr.y, fr.w, fr.h, fr.r); c.clip();
  c.globalAlpha = a;
  // fondo oscuro con un brillo suave del color secundario
  const g = c.createRadialGradient(fr.x + fr.w * 0.85, fr.y + fr.h * 0.2, 20, fr.x + fr.w * 0.85, fr.y + fr.h * 0.2, fr.w * 0.9);
  g.addColorStop(0, hexA(K.secundario, 0.16)); g.addColorStop(1, hexA(K.fondo, 1));
  c.fillStyle = K.fondo; c.fillRect(fr.x, fr.y, fr.w, fr.h); c.fillStyle = g; c.fillRect(fr.x, fr.y, fr.w, fr.h);
  // rejilla sutil
  c.strokeStyle = 'rgba(255,255,255,0.04)'; c.lineWidth = 1;
  for (let x = fr.x; x < fr.x + fr.w; x += 48) { c.beginPath(); c.moveTo(x, fr.y); c.lineTo(x, fr.y + fr.h); c.stroke(); }
  for (let y = fr.y; y < fr.y + fr.h; y += 48) { c.beginPath(); c.moveTo(fr.x, y); c.lineTo(fr.x + fr.w, y); c.stroke(); }
  // icono grande al fondo a la derecha
  if (ICONS[card.icon]) { c.save(); c.globalAlpha = a * 0.18; drawIcon(c, card.icon, fr.x + fr.w - 170, fr.y + fr.h / 2 + 10, 300, accent); c.restore(); }
  const px = fr.x + 56, dx = (1 - e) * -40;
  c.translate(dx, 0);
  // etiqueta pequena arriba
  c.textAlign = 'left'; c.textBaseline = 'top';
  c.font = fontB(st, 30, 800); c.fillStyle = hexA(K.texto, 0.6);
  const label = (card.label || '').toUpperCase().split('').join(' ');
  c.fillText(label, px, fr.y + 46);
  c.fillStyle = accent; c.fillRect(px, fr.y + 90, 70, 6);
  // titulo grande
  const ps = parts(card.title), maxW = fr.w - 112 - (ICONS[card.icon] ? 120 : 0);
  const tf = s => `400 ${s}px "Anton", Impact, "Arial Narrow", sans-serif`;
  const words = ps.map(p => p.s);
  // titulo en 1 o 2 lineas
  let lines = [ps];
  c.font = tf(150);
  if (partsWidth(c, ps, true) > maxW) {
    const flat = []; ps.forEach(p => p.s.split(/(\s+)/).forEach(w => { if (w) flat.push({ s: w, acc: p.acc }); }));
    let best = null;
    for (let i = 1; i < flat.length; i++) { const l1 = flat.slice(0, i), l2 = flat.slice(i); const w = Math.max(partsWidth(c, l1, true), partsWidth(c, l2, true)); if (!best || w < best.w) best = { w, l: [l1, l2] }; }
    if (best) lines = best.l.map(l => { while (l.length && !l[0].s.trim()) l.shift(); while (l.length && !l[l.length - 1].s.trim()) l.pop(); return l; });
  }
  let size = lines.length > 1 ? 130 : 150;
  c.font = tf(size); while (Math.max(...lines.map(l => partsWidth(c, l, true))) > maxW && size > 50) { size -= 4; c.font = tf(size); }
  const hasSub = !!(card.subtitle && card.subtitle.trim());
  const blockH = lines.length * size * 1.02 + (hasSub ? 62 : 0);
  let y = fr.y + 112 + (fr.h - 112 - 40 - blockH) / 2;
  c.textBaseline = 'top';
  for (const l of lines) { drawParts(c, l, px, y, K.texto, accent, true); y += size * 1.02; }
  if (hasSub) { c.font = fontB(st, 44, 800); c.fillStyle = hexA(K.texto, 0.85); c.fillText(card.subtitle.toUpperCase(), px, y + 10); }
  if (card.counter) { c.font = tf(46); c.textAlign = 'right'; c.textBaseline = 'bottom'; c.fillStyle = accent; c.fillText(card.counter, fr.x + fr.w - 44 - dx, fr.y + fr.h - 30); }
  void words; c.restore();
}

// ---------- tarjetas 3D (nivel 3) ----------
const imgCache = {};
function loadImg(p) {
  if (!p) return null;
  if (imgCache[p]) return imgCache[p].complete && imgCache[p].naturalWidth ? imgCache[p] : null;
  const im = new Image(); im.onload = () => drawAll(); im.src = mediaUrl(p); imgCache[p] = im; return null;
}
const cardCanvas = document.createElement('canvas');
function renderCardFace(card, W, H) {
  const st = ST(), K = st.colores, accent = card.color || K.acento;
  cardCanvas.width = W; cardCanvas.height = H;
  const c = cardCanvas.getContext('2d'); c.clearRect(0, 0, W, H);
  // fondo
  roundRect(c, 0, 0, W, H, 34); c.save(); c.clip();
  const g = c.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#16171c'); g.addColorStop(1, K.fondo);
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const rg = c.createRadialGradient(W * 0.9, H * 0.1, 10, W * 0.9, H * 0.1, W * 0.8); rg.addColorStop(0, hexA(K.secundario, 0.22)); rg.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = rg; c.fillRect(0, 0, W, H);
  const img = loadImg(card.image);
  const hasImg = !!img;
  if (hasImg && card.style === 'imagen') {
    // la imagen llena la tarjeta; etiqueta y titulo pequenos abajo, como en la referencia 2
    const ar = W / H, iar = img.naturalWidth / img.naturalHeight; let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
    if (iar > ar) { sw = sh * ar; sx = (img.naturalWidth - sw) * (card.focusX == null ? 0.5 : card.focusX); } else { sh = sw / ar; sy = (img.naturalHeight - sh) * (card.focusY == null ? 0.5 : card.focusY); }
    c.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    const gb = c.createLinearGradient(0, H * 0.45, 0, H); gb.addColorStop(0, 'rgba(0,0,0,0)'); gb.addColorStop(1, 'rgba(0,0,0,0.88)'); c.fillStyle = gb; c.fillRect(0, 0, W, H);
    c.restore();
    c.save(); roundRect(c, 2, 2, W - 4, H - 4, 32); c.lineWidth = 3; c.strokeStyle = 'rgba(255,255,255,0.85)'; c.stroke(); c.restore();
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    if (card.label) { c.font = fontB(st, 22, 800); c.fillStyle = hexA(K.texto, 0.7); c.fillText(card.label.toUpperCase().split('').join('\u200A'), 34, H - 92); }
    const ps2 = parts(card.title), tf2 = s => `400 ${s}px "Anton", Impact, "Arial Narrow", sans-serif`; let s2 = 64; c.font = tf2(s2); while (partsWidth(c, ps2, true) > W - 200 && s2 > 30) { s2 -= 2; c.font = tf2(s2); }
    drawParts(c, ps2, 34, H - 32, K.texto, accent, true);
    c.fillStyle = accent; c.fillRect(34, H - 22, 52, 5);
    if (card.counter) { c.font = tf2(34); c.textAlign = 'right'; c.fillStyle = K.texto; c.fillText(card.counter, W - 30, H - 30); }
    return cardCanvas;
  }
  const imgW = hasImg ? Math.round(W * 0.42) : 0;
  if (hasImg) {
    // imagen a la derecha, recortada para llenar
    const bx = W - imgW, ar = imgW / H, iar = img.naturalWidth / img.naturalHeight;
    let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
    if (iar > ar) { sw = sh * ar; sx = (img.naturalWidth - sw) / 2; } else { sh = sw / ar; sy = (img.naturalHeight - sh) / 2; }
    c.drawImage(img, sx, sy, sw, sh, bx, 0, imgW, H);
    const fade = c.createLinearGradient(bx, 0, bx + imgW * 0.45, 0); fade.addColorStop(0, '#111216'); fade.addColorStop(1, 'rgba(17,18,22,0)');
    c.fillStyle = fade; c.fillRect(bx, 0, imgW * 0.45, H);
  } else if (ICONS[card.icon]) { c.save(); c.globalAlpha = 0.2; drawIcon(c, card.icon, W - H * 0.42, H / 2, H * 0.62, accent); c.restore(); }
  c.restore();
  // borde con brillo
  c.save(); roundRect(c, 2, 2, W - 4, H - 4, 32); c.lineWidth = 4; c.strokeStyle = accent; c.shadowColor = hexA(accent, 0.8); c.shadowBlur = 16; c.stroke(); c.restore();
  // textos
  const px = 44, maxW = W - px * 2 - (hasImg ? imgW - 20 : H * 0.5);
  c.textAlign = 'left'; c.textBaseline = 'top';
  c.font = fontB(st, 24, 800); c.fillStyle = hexA(K.texto, 0.62);
  c.fillText((card.label || '').toUpperCase().split('').join(' '), px, 34);
  c.fillStyle = accent; c.fillRect(px, 70, 56, 5);
  const ps = parts(card.title), tf = s => `400 ${s}px "Anton", Impact, "Arial Narrow", sans-serif`;
  let lines = [ps]; c.font = tf(110);
  if (partsWidth(c, ps, true) > maxW) {
    const flat = []; ps.forEach(p => p.s.split(/(\s+)/).forEach(w => { if (w) flat.push({ s: w, acc: p.acc }); }));
    let best = null;
    for (let i = 1; i < flat.length; i++) { const l1 = flat.slice(0, i), l2 = flat.slice(i); const w = Math.max(partsWidth(c, l1, true), partsWidth(c, l2, true)); if (!best || w < best.w) best = { w, l: [l1, l2] }; }
    if (best) lines = best.l.map(l => { while (l.length && !l[0].s.trim()) l.shift(); while (l.length && !l[l.length - 1].s.trim()) l.pop(); return l; });
  }
  let size = lines.length > 1 ? 96 : 110;
  c.font = tf(size); while (Math.max(...lines.map(l => partsWidth(c, l, true))) > maxW && size > 40) { size -= 4; c.font = tf(size); }
  const hasSub = !!(card.subtitle && card.subtitle.trim());
  const blockH = lines.length * size * 1.02 + (hasSub ? 50 : 0);
  let y = 86 + (H - 86 - 30 - blockH) / 2;
  for (const l of lines) { drawParts(c, l, px, y, K.texto, accent, true); y += size * 1.02; }
  if (hasSub) { c.font = fontB(st, 34, 800); c.fillStyle = hexA(K.texto, 0.85); c.fillText(card.subtitle.toUpperCase(), px, y + 8); }
  if (card.counter) { c.font = tf(34); c.textAlign = 'right'; c.textBaseline = 'alphabetic'; c.fillStyle = K.texto; c.fillText(card.counter, W - 30, H - 26); }
  return cardCanvas;
}
// dibuja una imagen girada en Y con perspectiva real (por columnas)
function drawPerspective(c, src, cx, cy, W, H, angY, angX) {
  const f = 1500, cols = 90, ca = Math.cos(angY), sa = Math.sin(angY);
  const sxStep = src.width / cols;
  const pts = [];
  for (let i = 0; i <= cols; i++) { const u = i / cols - 0.5, x3 = u * W, z = x3 * sa, s = f / (f + z); pts.push({ x: cx + x3 * ca * s, s }); }
  for (let i = 0; i < cols; i++) {
    const p0 = pts[i], p1 = pts[i + 1], s = (p0.s + p1.s) / 2, h = H * s, x = p0.x, w = p1.x - p0.x;
    const tilt = Math.sin(angX || 0) * (i / cols - 0.5) * H * 0.2;
    if (w > 0) c.drawImage(src, i * sxStep, 0, sxStep + 0.6, src.height, x, cy - h / 2 + tilt, w + 0.6, h);
  }
  // sombreado segun el angulo
  const shade = Math.min(0.45, Math.abs(sa) * 0.6);
  if (shade > 0.01) {
    c.save(); c.globalAlpha = shade; c.beginPath();
    c.moveTo(pts[0].x, cy - H * pts[0].s / 2); c.lineTo(pts[cols].x, cy - H * pts[cols].s / 2); c.lineTo(pts[cols].x, cy + H * pts[cols].s / 2); c.lineTo(pts[0].x, cy + H * pts[0].s / 2); c.closePath();
    const lg = c.createLinearGradient(pts[0].x, 0, pts[cols].x, 0);
    if (sa > 0) { lg.addColorStop(0, 'rgba(0,0,0,0)'); lg.addColorStop(1, '#000'); } else { lg.addColorStop(0, '#000'); lg.addColorStop(1, 'rgba(0,0,0,0)'); }
    c.fillStyle = lg; c.fill(); c.restore();
  }
}
function drawComment(c, card, t, fr) {
  const st = ST(), K = st.colores;
  const inP = clamp((t - card.start) / 0.3, 0, 1), outP = clamp((card.end - t) / 0.2, 0, 1); const a = Math.min(easeOut(inP), outP); if (a <= 0) return;
  const W = Math.min(fr.w - 60, 900), x = fr.x + (fr.w - W) / 2, y0 = fr.y + (card.dy == null ? 40 : card.dy) + (1 - easeOut(inP)) * 30;
  c.save(); c.globalAlpha = a;
  c.font = fontB(st, 36, 700); const lines = []; let line = [];
  const words = parts(card.title).flatMap(p => p.s.split(/\s+/).filter(Boolean).map(w => ({ s: w, acc: p.acc })));
  for (const w of words) { const test = line.concat([w]); const tw = test.reduce((s2, x2) => s2 + c.measureText(x2.s + ' ').width, 0); if (tw > W - 150 && line.length) { lines.push(line); line = [w]; } else line = test; }
  if (line.length) lines.push(line);
  const H = 92 + lines.length * 46;
  c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = 30; roundRect(c, x, y0, W, H, 24); c.fillStyle = 'rgba(28,28,32,0.94)'; c.fill(); c.shadowColor = 'transparent';
  c.beginPath(); c.arc(x + 56, y0 + 56, 30, 0, Math.PI * 2); c.fillStyle = card.color || K.secundario; c.fill();
  c.fillStyle = '#fff'; c.font = fontT(st, 30, 800); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText((card.label || '?').slice(0, 1).toUpperCase(), x + 56, y0 + 57);
  c.textAlign = 'left'; c.textBaseline = 'top'; c.font = fontB(st, 28, 700); c.fillStyle = hexA(K.texto, 0.65); c.fillText(card.label || 'Usuario', x + 104, y0 + 24);
  let yy = y0 + 62;
  for (const ln of lines) { let xx = x + 104; for (const w of ln) { c.font = fontB(st, 36, w.acc ? 800 : 600); c.fillStyle = w.acc ? K.acento : K.texto; c.fillText(w.s, xx, yy); xx += c.measureText(w.s + ' ').width; } yy += 46; }
  if (card.subtitle) { c.font = fontB(st, 24, 600); c.fillStyle = hexA(K.texto, 0.45); c.fillText(card.subtitle, x + 104, yy + 4); }
  c.restore();
}
function drawCard3D(c, card, t, fr) {
  const st = ST(), K = st.colores;
  const sc = card.scale || 0.78;
  const W = Math.round(fr.w * sc), H = Math.round(Math.min(fr.h * 0.86, W * 0.56));
  const inP = clamp((t - card.start) / 0.5, 0, 1), outP = clamp((card.end - t) / 0.28, 0, 1);
  if (inP <= 0 || outP <= 0) return;
  const e = 1 - Math.pow(1 - inP, 3), o = 1 - outP;
  const side = card.side === 'right' ? -1 : 1;
  // entra girando desde un lado, se queda flotando con un leve vaiven, sale girando al otro
  const idle = Math.sin((t - card.start) * 1.6) * 0.05;
  const angY = side * ((1 - e) * 1.05 - 0.12) + idle - o * side * 0.9;
  const angX = Math.sin((t - card.start) * 1.1) * 0.15;
  const face = renderCardFace(card, W, H);
  const cx = fr.x + fr.w / 2 + (card.dx || 0) + (1 - e) * side * -120, cy = fr.y + fr.h / 2 + (card.dy || 0) + Math.sin((t - card.start) * 2) * 6;
  c.save(); c.globalAlpha = Math.min(1, inP * 2.5) * outP;
  // sombra
  c.save(); c.fillStyle = 'rgba(0,0,0,0.45)'; c.filter = 'blur(18px)'; c.fillRect(cx - W * 0.4, cy + H * 0.38, W * 0.8, 30); c.restore();
  drawPerspective(c, face, cx, cy, W * (0.92 + 0.08 * e), H * (0.92 + 0.08 * e), angY, angX);
  c.restore();
  // particulas de entrada alrededor de la tarjeta
  if (card.particles !== false) {
    const pe = { id: card.id, start: card.start, end: card.start + 1.1, x: cx, y: cy, count: 36, spread: W / 2 };
    if (t < pe.end) drawParticles(c, pe, t);
  }
}

function drawScreen() {
  if (!P) return;
  const c = sctx, k = vid.videoWidth ? vid.videoWidth / 1080 : 0.5, t = cur(), L = P.layout, st = ST(), K = st.colores;
  c.setTransform(scr.width / 1080, 0, 0, scr.height / 1920, 0, 0);
  c.fillStyle = '#000'; c.fillRect(0, 0, 1080, 1920);
  const B = bands();
  if (vid.readyState >= 2) {
    const grade = P.grading && P.grading.enabled !== false && P.grading.filter && $('#chkGrade') && $('#chkGrade').checked ? P.grading.filter : 'none';
    c.filter = grade;
    c.drawImage(vid, 0, 0, 1080, 1920);
    if (B.frame.on || B.gameTop) { c.filter = 'none'; c.fillStyle = K.fondo; c.fillRect(0, B.top, 1080, B.bottom - B.top); c.filter = grade; }
    // camara (con zoom si hay)
    const zz = zoomAt(t), camH = B.cam.sh;
    let sx = 0, sy = B.cam.sy, sw = 1080, sh = camH;
    if (zz.z > 1.001) {
      const f = faceAt(t), w = 1080 / zz.z, h = camH / zz.z;
      const bias = L.zoomBiasY == null ? -45 : L.zoomBiasY;
      const cx = clamp(zz.cx != null ? zz.cx : f.x, w / 2, 1080 - w / 2), cy = clamp(zz.cy != null ? zz.cy : f.y + bias, B.cam.sy + h / 2, B.cam.sy + camH - h / 2);
      sx = cx - w / 2; sy = cy - h / 2; sw = w; sh = h;
    }
    if (zz.z > 1.001 || B.gameTop || B.frame.on) {
      c.save(); c.beginPath(); c.rect(0, B.cam.dy, 1080, camH); c.clip();
      c.drawImage(vid, sx * k, sy * k, sw * k, sh * k, 0, B.cam.dy, 1080, camH); c.restore();
    }
    // gameplay (en marco redondeado si esta activo)
    if (B.frame.on || B.gameTop) {
      const fr = B.frame, ar = fr.w / fr.h; let gw = 1080, gh = gw / ar; if (gh > B.game.sh) { gh = B.game.sh; gw = gh * ar; }
      const gx = (1080 - gw) / 2, gy = B.game.sy + (B.game.sh - gh) / 2;
      c.save(); roundRect(c, fr.x, fr.y, fr.w, fr.h, fr.r); c.clip();
      c.drawImage(vid, gx * k, gy * k, gw * k, gh * k, fr.x, fr.y, fr.w, fr.h); c.restore();
    }
    c.filter = 'none';
  }
  if (B.frame.on) for (const card of P.cards) if (card.kind === 'panel' && t >= card.start && t < card.end) drawPanel(c, card, t, B.frame);
  const fr3 = B.frame.on ? B.frame : { x: 0, y: B.game.dy, w: 1080, h: B.game.sh };
  for (const card of P.cards) if (card.kind === 'card3d' && t >= card.start && t < card.end) drawCard3D(c, card, t, fr3);
  for (const card of P.cards) if (card.kind === 'comentario' && t >= card.start && t < card.end) drawComment(c, card, t, fr3);
  if (B.frame.on) {
    const fr = B.frame, f = L.frame || {};
    c.save(); roundRect(c, fr.x, fr.y, fr.w, fr.h, fr.r);
    c.shadowColor = hexA(f.color || K.acento, 0.55); c.shadowBlur = 18; c.lineWidth = f.border == null ? 4 : f.border; c.strokeStyle = f.color || K.acento; c.stroke(); c.restore();
  }
  for (const card of P.cards) if (card.kind !== 'panel' && card.kind !== 'card3d' && card.kind !== 'comentario' && t >= card.start && t < card.end) drawCard(c, card, t);
  drawEffects(c, t);

  drawSubtitle(c, t);
  if ($('#chkGuides').checked) {
    c.save(); c.fillStyle = 'rgba(224,36,47,.18)'; c.fillRect(0, 0, 1080, 220); c.fillRect(0, 1500, 1080, 420); c.fillRect(960, 220, 120, 1280);
    c.strokeStyle = '#27b39e'; c.lineWidth = 3; c.setLineDash([14, 10]);
    c.strokeRect(2, B.cam.dy, 1076, B.cam.sh); c.strokeStyle = '#3b6fe0'; c.strokeRect(2, B.game.dy, 1076, B.game.sh);
    c.fillStyle = '#fff'; c.font = '600 28px Inter, sans-serif'; c.fillText('Zona de botones de TikTok', 20, 1550); c.restore();
  }
  // tiempo
  $('#tcOut').textContent = fmt(view === 'edit' ? srcToOut(t) : t);
  $('#tcSrc').textContent = 'orig ' + fmt(t);
}

// ---------- linea de tiempo ----------
const ROWS = [
  { key: 'ruler', name: '', h: 22 },
  { key: 'video', name: 'Video', h: 46 },
  { key: 'audio', name: 'Audio', h: 42 },
  { key: 'words', name: 'Subtítulos', h: 30 },
  { key: 'zoom', name: 'Zoom', h: 28 },
  { key: 'cards', name: 'Gráficos', h: 34 },
  { key: 'effects', name: 'Efectos', h: 30 },
  { key: 'music', name: 'Música', h: 26 },
];
let rowY = {};
function layoutRows() {
  let y = 0; const heads = $('#tlHeads'); heads.innerHTML = '';
  for (const r of ROWS) { rowY[r.key] = { y, h: r.h }; if (r.name) { const d = document.createElement('div'); d.style.top = y + 'px'; d.style.height = r.h + 'px'; d.textContent = r.name; heads.appendChild(d); } y += r.h; }
}
function resizeTl() {
  const dpr = window.devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
  tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function fitTimeline() { if (!P) return; const w = tl.clientWidth || 800; pxPerSec = Math.max(2, (w - 30) / Math.max(1, viewDur())); scrollT = 0; }
const X = v => (v - scrollT) * pxPerSec;
const T = x => x / pxPerSec + scrollT;

function itemsFor(rowKey) {
  // devuelve [{type,id,obj,a,b,label,color}]
  switch (rowKey) {
    case 'video': return P.segments.filter(s => view === 'orig' || s.keep).map(s => ({ type: 'segment', id: s.id, obj: s, a: s.start, b: s.end }));
    case 'words': return P.words.map(w => ({ type: 'word', id: w.id, obj: w, a: w.start, b: w.end }));
    case 'zoom': return P.zooms.map(z => ({ type: 'zoom', id: z.id, obj: z, a: z.start, b: z.end }));
    case 'cards': return P.cards.map(c => ({ type: 'card', id: c.id, obj: c, a: c.start, b: c.end }));
    case 'effects': return (P.effects || []).map(e => ({ type: 'effect', id: e.id, obj: e, a: e.start, b: e.end }));
    case 'music': return P.music && P.music.file ? [{ type: 'music', id: 'music', obj: P.music, a: 0, b: P.source.duration }] : [];
  }
  return [];
}
function isSel(type, id) { return sel && sel.type === type && sel.id === id; }

function drawTimeline() {
  if (!P) return;
  const c = tctx, W = tl.clientWidth, H = tl.clientHeight;
  c.clearRect(0, 0, W, H); c.fillStyle = '#15171d'; c.fillRect(0, 0, W, H);
  // fondo de filas
  for (const r of ROWS) { const ry = rowY[r.key]; c.fillStyle = r.key === 'ruler' ? '#111318' : '#171a21'; c.fillRect(0, ry.y, W, ry.h); c.fillStyle = '#1e2128'; c.fillRect(0, ry.y + ry.h - 1, W, 1); }
  const vd = viewDur();
  // regla
  const ry = rowY.ruler; const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find(s => s * pxPerSec >= 60) || 60;
  c.fillStyle = '#8a90a0'; c.font = '10px Inter, sans-serif'; c.textBaseline = 'top';
  for (let s = Math.floor(scrollT / step) * step; s <= T(W); s += step) { const x = X(s); if (x < -40) continue; c.fillRect(x, ry.y + 14, 1, 8); c.fillText(fmt(s).replace(/\.\d\d$/, ''), x + 3, ry.y + 3); }
  c.fillStyle = '#2a2e38'; c.fillRect(X(vd), 0, 2, H);

  // video
  const vy = rowY.video;
  for (const s of P.segments) {
    if (view === 'orig') {
      const x = X(s.start), w = (s.end - s.start) * pxPerSec;
      if (x > W || x + w < 0) continue;
      if (s.keep) { c.fillStyle = isSel('segment', s.id) ? '#2fd1b8' : '#1f8a7a'; c.fillRect(x, vy.y + 4, Math.max(1, w - 1), vy.h - 8); }
      else { c.fillStyle = '#3a1418'; c.fillRect(x, vy.y + 4, w, vy.h - 8); hatch(c, x, vy.y + 4, w, vy.h - 8); if (isSel('segment', s.id)) { c.strokeStyle = '#ff6b74'; c.lineWidth = 2; c.strokeRect(x + 1, vy.y + 5, w - 2, vy.h - 10); } }
      label(c, s.keep ? segText(s) : '✂ ' + (s.label || 'corte'), x, vy.y + 4, w, vy.h - 8, s.keep ? '#e9fffb' : '#ffb3b8');
      if (s.note) { c.fillStyle = '#ffd400'; c.fillText('⚠', x + 3, vy.y + vy.h - 18); }
    } else if (s.keep) {
      const [o0] = [srcToOut(s.start)], w = (s.end - s.start) / speed() * pxPerSec, x = X(o0);
      if (x > W || x + w < 0) continue;
      c.fillStyle = isSel('segment', s.id) ? '#2fd1b8' : '#1f8a7a'; c.fillRect(x, vy.y + 4, Math.max(1, w - 1), vy.h - 8);
      label(c, segText(s), x, vy.y + 4, w, vy.h - 8, '#e9fffb');
      if (s.note) { c.fillStyle = '#ffd400'; c.font = '11px Inter'; c.fillText('⚠', x + 3, vy.y + vy.h - 18); }
      // marca de corte
      if (map.length && s !== map[0].seg) { c.fillStyle = '#e0242f'; c.fillRect(x - 1, vy.y, 2, vy.h); }
    }
  }
  // audio (onda)
  const ay = rowY.audio, pk = P.peaks;
  if (pk && pk.data) {
    c.fillStyle = '#3f6f9a';
    const mid = ay.y + ay.h / 2, amp = ay.h / 2 - 3;
    for (let x = 0; x < W; x++) {
      const v0 = T(x), v1 = T(x + 1); if (v0 > vd) break;
      let s0, s1;
      if (view === 'edit') { s0 = outToSrc(v0); s1 = outToSrc(v1); if (s1 < s0) s1 = s0; } else { s0 = v0; s1 = v1; }
      const i0 = Math.floor(s0 * pk.rate), i1 = Math.max(i0 + 1, Math.ceil(s1 * pk.rate));
      let m = 0; for (let i = i0; i < i1 && i < pk.data.length; i++) m = Math.max(m, pk.data[i]);
      const hh = Math.min(1, m * 1.6) * amp;
      if (view === 'orig' && !keptAt(s0)) c.fillStyle = '#4a2a30'; else c.fillStyle = '#3f6f9a';
      c.fillRect(x, mid - hh, 1, hh * 2 || 1);
    }
  }
  // palabras
  const wy = rowY.words; c.font = '11px Inter, sans-serif';
  for (const w of P.words) {
    for (const [a, b] of pieces(w.start, w.end)) {
      const x = X(a), ww = (b - a) * pxPerSec; if (x > W || x + ww < 0) continue;
      c.fillStyle = isSel('word', w.id) ? '#ffd400' : w.hidden ? '#2a2d36' : (view === 'orig' && !keptAt((w.start + w.end) / 2) ? '#2b2025' : '#3a4152');
      c.fillRect(x, wy.y + 4, Math.max(1, ww - 1), wy.h - 8);
      if (ww > 18) label(c, w.text, x, wy.y + 4, ww, wy.h - 8, isSel('word', w.id) ? '#111' : w.hidden ? '#666' : '#dfe3ea', 10);
    }
  }
  // zoom
  const zy = rowY.zoom;
  for (const z of P.zooms) for (const [a, b] of pieces(z.start, z.end)) {
    const x = X(a), w = (b - a) * pxPerSec; if (x > W || x + w < 0) continue;
    c.fillStyle = isSel('zoom', z.id) ? '#6f99ff' : '#2f56b5'; c.fillRect(x, zy.y + 4, Math.max(2, w - 1), zy.h - 8);
    label(c, '🔍 ×' + Number(z.z).toFixed(2) + (z.label ? ' ' + z.label : ''), x, zy.y + 4, w, zy.h - 8, '#eef3ff', 10);
  }
  // graficos
  const cy = rowY.cards;
  for (const k of P.cards) for (const [a, b] of pieces(k.start, k.end)) {
    const x = X(a), w = (b - a) * pxPerSec; if (x > W || x + w < 0) continue;
    c.fillStyle = isSel('card', k.id) ? '#de9cf5' : '#8d3fb0'; c.fillRect(x, cy.y + 4, Math.max(2, w - 1), cy.h - 8);
    label(c, (k.icon || '') + ' ' + (k.title || ''), x, cy.y + 4, w, cy.h - 8, '#fff', 11);
  }
  // efectos
  const ey = rowY.effects, FXC = { sfx: '#2f8f5b', particles: '#c99a16', text3d: '#c2410c', flash: '#6b7280' }, FXN = { sfx: '🔊', particles: '✨', text3d: '3D', flash: '⚡' };
  for (const e of P.effects || []) for (const [a, b] of pieces(e.start, Math.max(e.end, e.start + 0.25))) {
    const x = X(a), w = Math.max(8, (b - a) * pxPerSec); if (x > W || x + w < 0) continue;
    c.fillStyle = isSel('effect', e.id) ? '#ffe07a' : (e.enabled === false ? '#33363f' : FXC[e.type] || '#555'); c.fillRect(x, ey.y + 4, w - 1, ey.h - 8);
    label(c, (FXN[e.type] || '') + ' ' + (e.label || (e.type === 'sfx' ? (e.file || '').split('/').pop().replace(/\.mp3$/, '') : e.text || e.type)), x, ey.y + 4, w, ey.h - 8, isSel('effect', e.id) ? '#111' : '#fff', 10);
  }
  // musica
  const my = rowY.music;
  if (P.music && P.music.file) {
    const x = X(0), w = vd * pxPerSec;
    c.fillStyle = P.music.enabled === false ? '#3a3326' : (isSel('music', 'music') ? '#f0ad4e' : '#9a6418');
    c.fillRect(x, my.y + 4, w, my.h - 8);
    label(c, '♪ ' + P.music.file.split('/').pop() + '  · vol ' + Math.round((P.music.volume || 0) * 100) + '%' + (P.music.enabled === false ? ' (apagada)' : ''), x, my.y + 4, w, my.h - 8, '#fff', 10);
  }
  // cursor
  const px = X(toView(cur()));
  c.fillStyle = '#ffd400'; c.fillRect(px - 1, 0, 2, H);
  c.beginPath(); c.moveTo(px - 6, 0); c.lineTo(px + 6, 0); c.lineTo(px, 8); c.closePath(); c.fill();
}
function hatch(c, x, y, w, h) { c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip(); c.strokeStyle = 'rgba(224,36,47,.45)'; c.lineWidth = 1; for (let i = -h; i < w; i += 7) { c.beginPath(); c.moveTo(x + i, y + h); c.lineTo(x + i + h, y); c.stroke(); } c.restore(); }
function label(c, text, x, y, w, h, color, size = 11) {
  if (w < 14) return; c.save(); c.beginPath(); c.rect(Math.max(0, x), y, w - (Math.max(0, x) - x), h); c.clip();
  c.fillStyle = color; c.font = `600 ${size}px Inter, sans-serif`; c.textBaseline = 'middle'; c.fillText(text, Math.max(0, x) + 5, y + h / 2); c.restore();
}
function segText(s) { const ws = P.words.filter(w => w.start >= s.start - 0.05 && w.end <= s.end + 0.05).slice(0, 8).map(w => w.text); return ws.join(' ') || (s.label || ''); }
function drawAll() { drawScreen(); drawTimeline(); }

// ---------- interaccion en la linea de tiempo ----------
let drag = null;
function rowAt(y) { for (const r of ROWS) { const ry = rowY[r.key]; if (y >= ry.y && y < ry.y + ry.h) return r.key; } return null; }
function hit(x, y) {
  const rk = rowAt(y); if (!rk || rk === 'ruler' || rk === 'audio') return { row: rk };
  const its = itemsFor(rk);
  for (let i = its.length - 1; i >= 0; i--) {
    const it = its[i];
    const ps = rk === 'video' && view === 'edit' ? [[srcToOut(it.a), srcToOut(it.a) + (it.b - it.a) / speed()]] : rk === 'music' ? [[0, viewDur()]] : pieces(it.a, it.b);
    for (const [a, b] of ps) {
      const x0 = X(a), x1 = X(b);
      if (x >= x0 - 3 && x <= x1 + 3) {
        let edge = null;
        if (rk !== 'music' && x1 - x0 > 10) { if (Math.abs(x - x0) <= 6) edge = 'L'; else if (Math.abs(x - x1) <= 6) edge = 'R'; }
        return { row: rk, it, edge };
      }
    }
  }
  return { row: rk };
}
tl.addEventListener('mousemove', e => {
  if (drag) return;
  const h = hit(e.offsetX, e.offsetY);
  tl.style.cursor = h.it ? (h.edge ? 'ew-resize' : (h.it.type === 'zoom' || h.it.type === 'card' ? 'grab' : 'pointer')) : (h.row === 'ruler' ? 'col-resize' : 'default');
});
tl.addEventListener('mousedown', e => {
  if (!P) return;
  const x = e.offsetX, y = e.offsetY, h = hit(x, y);
  if (!h.it) { sel = null; renderInspector(); drag = { mode: 'seek' }; if (playing) pause(); seekView(T(x)); return; }
  sel = { type: h.it.type, id: h.it.id }; renderInspector();
  const o = h.it.obj;
  if (h.it.type === 'music' || h.it.type === 'word' && !h.edge) { drag = null; drawAll(); if (!playing) seekSrc(Math.max(h.it.a, fromView(T(x)))); return; }
  if (h.it.type === 'segment' && !h.edge) { drag = null; drawAll(); seekSrc(clamp(fromView(T(x)), o.start, o.end - 0.01)); return; }
  pushUndo();
  drag = { mode: h.edge ? 'trim' + h.edge : 'move', it: h.it, o, x0: x, a0: o.start, b0: o.end, v0: toView(o.start), moved: false };
  if (drag.mode === 'move') tl.style.cursor = 'grabbing';
  drawAll();
});
window.addEventListener('mousemove', e => {
  if (!drag || !P) return;
  const rect = tl.getBoundingClientRect(), x = e.clientX - rect.left;
  if (drag.mode === 'seek') { seekView(T(x)); return; }
  const dxv = (x - drag.x0) / pxPerSec, o = drag.o, k = view === 'edit' ? speed() : 1; drag.moved = true;
  const t = drag.it.type;
  if (t === 'segment') {
    const segs = P.segments, i = segs.indexOf(o);
    if (drag.mode === 'trimL') {
      const prev = segs[i - 1]; let nt = clamp(drag.a0 + dxv * k, prev ? prev.start + 0.034 : 0, o.end - 0.034);
      nt = Math.round(nt * FPS) / FPS; o.start = r3(nt); if (prev) prev.end = r3(nt);
      if (!prev && nt > 0.001) { segs.unshift({ id: uid('s'), start: 0, end: r3(nt), keep: false, label: 'inicio' }); }
    } else {
      const next = segs[i + 1]; let nt = clamp(drag.b0 + dxv * k, o.start + 0.034, next ? next.end - 0.034 : P.source.duration);
      nt = Math.round(nt * FPS) / FPS; o.end = r3(nt); if (next) next.start = r3(nt);
      if (!next && nt < P.source.duration - 0.001) segs.push({ id: uid('s'), start: r3(nt), end: P.source.duration, keep: false, label: 'final' });
    }
    rebuild();
  } else if (t === 'word') {
    if (drag.mode === 'trimL') o.start = r3(clamp(drag.a0 + dxv * k, 0, o.end - 0.03)); else if (drag.mode === 'trimR') o.end = r3(clamp(drag.b0 + dxv * k, o.start + 0.03, P.source.duration));
    buildGroups();
  } else {
    const dur = drag.b0 - drag.a0;
    if (drag.mode === 'move') { const ns = fromView(Math.max(0, drag.v0 + dxv)); o.start = r3(clamp(ns, 0, P.source.duration - dur)); o.end = r3(o.start + dur); }
    else if (drag.mode === 'trimL') o.start = r3(clamp(fromView(toView(drag.a0) + dxv), 0, o.end - 0.1));
    else o.end = r3(clamp(fromView(toView(drag.b0) + dxv), o.start + 0.1, P.source.duration));
  }
  renderInspector(true); drawAll();
});
window.addEventListener('mouseup', () => {
  if (drag && drag.mode !== 'seek') { if (drag.moved) { setDirty(true); rebuild(); renderWarnings(); } else undoStack.pop(); }
  drag = null; drawAll();
});
tl.addEventListener('dblclick', e => {
  const h = hit(e.offsetX, e.offsetY);
  if (h.it && h.it.type === 'word') {
    const w = h.it.obj, nt = prompt('Texto del subtítulo:', w.text);
    if (nt != null && nt !== w.text) mutate(() => { w.text = nt.trim(); });
  } else if (h.it && h.it.type === 'card') { const f = document.querySelector('#inspector [data-k="title"]'); if (f) f.focus(); }
});
tl.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const tAt = T(e.offsetX); pxPerSec = clamp(pxPerSec * (e.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 600); scrollT = Math.max(0, tAt - e.offsetX / pxPerSec);
  } else scrollT = clamp(scrollT + (e.deltaY + e.deltaX) / pxPerSec * 0.6, 0, Math.max(0, viewDur() - 5));
  drawTimeline();
}, { passive: false });

// ---------- acciones ----------
function selectedObj() {
  if (!sel || !P) return null;
  const list = { segment: P.segments, word: P.words, zoom: P.zooms, card: P.cards, effect: P.effects || [] }[sel.type];
  if (sel.type === 'music') return P.music;
  return list ? list.find(o => o.id === sel.id) : null;
}
function splitAtCursor() {
  const t = cur(); const s = P.segments.find(s => t > s.start + 0.03 && t < s.end - 0.03);
  if (!s) return toast('Pon el cursor dentro de un clip');
  mutate(() => { const tt = r3(Math.round(t * FPS) / FPS); const n = { id: uid('s'), start: tt, end: s.end, keep: s.keep, label: s.label }; s.end = tt; P.segments.splice(P.segments.indexOf(s) + 1, 0, n); sel = { type: 'segment', id: n.id }; });
  toast('Clip dividido');
}
function toggleOrDelete() {
  const o = selectedObj(); if (!o) return toast('Elige algo en la línea de tiempo');
  if (sel.type === 'segment') { mutate(() => { o.keep = !o.keep; if (!o.keep && !o.label) o.label = 'quitado a mano'; }); toast(o.keep ? 'Clip restaurado' : 'Clip quitado'); if (view === 'edit' && !o.keep) sel = null; }
  else if (sel.type === 'zoom') { mutate(() => { P.zooms = P.zooms.filter(z => z !== o); sel = null; }); toast('Zoom borrado'); }
  else if (sel.type === 'card') { mutate(() => { P.cards = P.cards.filter(z => z !== o); sel = null; }); toast('Gráfico borrado'); }
  else if (sel.type === 'word') { mutate(() => { o.hidden = !o.hidden; }); toast(o.hidden ? 'Palabra oculta en subtítulos' : 'Palabra visible'); }
  else if (sel.type === 'effect') { mutate(() => { P.effects = P.effects.filter(z => z !== o); sel = null; }); toast('Efecto borrado'); }
  drawAll(); renderInspector();
}
function addZoom() { const t = cur(); mutate(() => { const z = { id: uid('z'), start: r3(t), end: r3(Math.min(P.source.duration, t + 1.5)), z: 1.25, label: '' }; P.zooms.push(z); sel = { type: 'zoom', id: z.id }; }); toast('Zoom agregado: ajusta el nivel a la izquierda'); }
function addEffect() { const t = cur(); mutate(() => { P.effects = P.effects || []; const e = { id: uid('e'), type: 'sfx', start: r3(t), end: r3(Math.min(P.source.duration, t + 0.6)), file: 'editor_media/sfx/whoosh-short.mp3', volume: 0.35 }; P.effects.push(e); sel = { type: 'effect', id: e.id }; }); toast('Efecto agregado: elige el tipo a la izquierda'); }
function addCard() { const t = cur(); mutate(() => { const k = { id: uid('c'), start: r3(t), end: r3(Math.min(P.source.duration, t + 2.2)), kind: P.layout.frame && P.layout.frame.enabled ? 'panel' : 'tarjeta', label: 'ETIQUETA', title: 'Texto *clave*', subtitle: '', icon: 'star' }; P.cards.push(k); sel = { type: 'card', id: k.id }; }); toast('Gráfico agregado: escribe el texto a la izquierda'); }
function stepFrames(n) {
  if (playing) pause();
  if (view === 'edit') seekSrc(outToSrc(clamp(srcToOut(cur()) + n / FPS, 0, outDur() - 0.001)));
  else seekSrc(cur() + n / FPS);
}
function setView(v) {
  if (v === view) return; const t = cur(); const wasPlaying = playing; if (playing) pause();
  view = v; document.querySelectorAll('#viewMode button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  fitTimeline(); seekSrc(t); if (wasPlaying) play();
}

// ---------- inspector ----------
function field(lbl, html) { return `<div class="field"><label>${lbl}</label>${html}</div>`; }
function num(k, v, step = 0.01, extra = '') { return `<input type="number" data-k="${k}" value="${v}" step="${step}" ${extra}>`; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function renderInspector(soft) {
  const box = $('#inspector'); if (!P) { box.innerHTML = ''; return; }
  const o = selectedObj();
  if (soft && document.activeElement && box.contains(document.activeElement)) return;
  if (!o) {
    $('#inspTitle').textContent = 'Proyecto';
    const st = P.subtitles, L = P.layout, m = P.music || {};
    const files = Array.from(new Set([m.file, ...mediaList.filter(f => /\.(m4a|mp3|wav)$/i.test(f))].filter(Boolean)));
    box.innerHTML =
      `<div class="small">Fuente: ${esc(P.source.file)}<br>Original ${fmt(P.source.duration)} → final <b>${fmt(outDur())}</b></div>` +
      field('Velocidad del habla (×)', `<input type="range" min="0.9" max="1.4" step="0.01" data-k="speed" value="${speed()}"><div class="small">×${speed().toFixed(2)} · más de ×1.3 suena acelerado</div>`) +
      `<div class="row">` + field('Subtítulos', `<select data-k="sub.style"><option value="amarillo" ${st.style !== 'frase' ? 'selected' : ''}>Amarillo 1-3 palabras</option><option value="frase" ${st.style === 'frase' ? 'selected' : ''}>Frase blanca</option></select>`) +
      field('Palabras por bloque', num('sub.maxWords', st.maxWords || 3, 1, 'min="1" max="8"')) + `</div>` +
      `<div class="row">` + field('Altura subtítulos (y)', num('sub.y', st.y || 770, 2)) + field('Tamaño', num('sub.size', st.size || 84, 2)) + `</div>` +
      field('Música', m.file ? `<select data-k="music.file">${files.map(f => `<option ${f === m.file ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
        <div class="row" style="margin-top:6px"><input type="range" min="0" max="0.6" step="0.01" data-k="music.volume" value="${m.volume || 0.15}"><label class="chk"><input type="checkbox" data-k="music.enabled" ${m.enabled !== false ? 'checked' : ''}> activa</label></div>` : '<div class="small">Sin música</div>') +
      `<details><summary class="small">Diseño (bandas y cara)</summary><div class="row">` + field('Cámara arriba', num('layout.camTop', L.camTop, 1)) + field('Cámara abajo', num('layout.camBottom', L.camBottom, 1)) + `</div><div class="row">` + field('Gameplay arriba', num('layout.gameTop', L.gameTop, 1)) + field('Gameplay abajo', num('layout.gameBottom', L.gameBottom, 1)) + `</div></details>` +
      `<details open><summary class="small">Tu estilo${P.style && P.style.nombre ? ' · ' + esc(P.style.nombre) : ''}</summary>` +
      `<div class="row">` + field('Acento', `<input type="color" data-k="style.colores.acento" value="${ST().colores.acento}">`) + field('Secundario', `<input type="color" data-k="style.colores.secundario" value="${ST().colores.secundario}">`) + field('Fondo', `<input type="color" data-k="style.colores.fondo" value="${ST().colores.fondo}">`) + `</div>` +
      `<div class="row">` + field('Movimiento', `<select data-k="style.movimiento">${['suave', 'energico', 'cinematico'].map(v => `<option ${v === ST().movimiento ? 'selected' : ''}>${v}</option>`).join('')}</select>`) + field('Caja en la palabra', `<select data-k="style.subtitulos.caja"><option value="1" ${ST().subtitulos.caja ? 'selected' : ''}>sí</option><option value="" ${ST().subtitulos.caja ? '' : 'selected'}>no</option></select>`) + `</div>` +
      `<div class="row">` + field('Cámara en movimiento', `<input type="range" min="0" max="0.12" step="0.005" data-k="camera.drift" value="${(P.camera && P.camera.drift) || 0}">`) + field('Música baja al hablar', `<input type="range" min="0.2" max="1" step="0.05" data-k="music.duck.level" value="${(P.music && P.music.duck && P.music.duck.level) || 1}">`) + `</div>` +
      `<div class="row">` + field('Orden', `<select data-k="layout.order"><option value="cam-top" ${P.layout.order !== 'game-top' ? 'selected' : ''}>Cámara arriba</option><option value="game-top" ${P.layout.order === 'game-top' ? 'selected' : ''}>Gameplay arriba</option></select>`) + field('Marco del gameplay', `<select data-k="layout.frame.enabled"><option value="1" ${P.layout.frame && P.layout.frame.enabled ? 'selected' : ''}>sí</option><option value="" ${P.layout.frame && P.layout.frame.enabled ? '' : 'selected'}>no</option></select>`) + `</div>` +
      field('Color (filtro)', `<input type="text" data-k="grading.filter" value="${esc((P.grading && P.grading.filter) || '')}" placeholder="contrast(1.06) saturate(1.1)">`) + `</details>` +
      field('Notas para Claude', `<textarea data-k="status.notes" placeholder="Ej.: el zoom de 'gratis' más fuerte, cambia el beat…">${esc(P.status.notes || '')}</textarea>`);
  } else if (sel.type === 'segment') {
    $('#inspTitle').textContent = o.keep ? 'Clip (se queda)' : 'Corte (se quita)';
    box.innerHTML = (o.note ? `<div class="note">⚠ ${esc(o.note)}</div>` : '') +
      `<div class="small">${esc(segText(o) || o.label || '')}</div>` +
      `<div class="row">` + field('Inicio (orig)', num('start', o.start, 0.033)) + field('Fin (orig)', num('end', o.end, 0.033)) + `</div>` +
      field('Etiqueta', `<input type="text" data-k="label" value="${esc(o.label || '')}">`) +
      `<div class="btnrow"><button data-act="toggle">${o.keep ? '⊘ Quitar este clip' : '↺ Restaurar este clip'}</button><button data-act="play">▶ Escuchar</button><button data-act="split">✂ Dividir en cursor</button></div>`;
  } else if (sel.type === 'word') {
    $('#inspTitle').textContent = 'Palabra del subtítulo';
    box.innerHTML = field('Texto', `<input type="text" data-k="text" value="${esc(o.text)}">`) +
      `<div class="row">` + field('Inicio', num('start', o.start)) + field('Fin', num('end', o.end)) + `</div>` +
      `<label class="chk"><input type="checkbox" data-k="hidden" ${o.hidden ? 'checked' : ''}> Ocultar en subtítulos</label>`;
  } else if (sel.type === 'zoom') {
    $('#inspTitle').textContent = 'Zoom a la cara';
    box.innerHTML = field('Nivel', `<input type="range" min="1.02" max="1.6" step="0.01" data-k="z" value="${o.z}"><div class="small">×${Number(o.z).toFixed(2)}</div>`) +
      `<div class="row">` + field('Inicio (orig)', num('start', o.start)) + field('Fin (orig)', num('end', o.end)) + `</div>` +
      field('Entrada (s)', num('ramp', o.ramp == null ? 0.12 : o.ramp, 0.02, 'min="0" max="1"')) +
      field('Nota', `<input type="text" data-k="label" value="${esc(o.label || '')}">`) +
      `<div class="btnrow"><button data-act="play">▶ Ver</button><button data-act="del">🗑 Borrar</button></div>`;
  } else if (sel.type === 'card') {
    $('#inspTitle').textContent = 'Gráfico sobre el gameplay';
    box.innerHTML = field('Tipo', `<select data-k="kind"><option value="card3d" ${o.kind === 'card3d' ? 'selected' : ''}>Tarjeta 3D (gira y flota)</option><option value="comentario" ${o.kind === 'comentario' ? 'selected' : ''}>Comentario (gancho)</option><option value="panel" ${o.kind === 'panel' ? 'selected' : ''}>Panel (llena el gameplay)</option><option value="tarjeta" ${!o.kind || o.kind === 'tarjeta' ? 'selected' : ''}>Tarjeta plana</option></select>`) +
      (o.kind === 'card3d' ? `<div class="row">` + field('Tamaño', `<input type="range" min="0.5" max="0.95" step="0.01" data-k="scale" value="${o.scale || 0.78}">`) + field('Entra por', `<select data-k="side"><option value="left" ${o.side !== 'right' ? 'selected' : ''}>izquierda</option><option value="right" ${o.side === 'right' ? 'selected' : ''}>derecha</option></select>`) + `</div>` +
        field('Imagen (opcional)', `<select data-k="image"><option value="">(sin imagen: usa el icono)</option>${Array.from(new Set([o.image, ...mediaList.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))].filter(Boolean))).map(f => `<option ${f === o.image ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
          <div class="imgpick" data-drop="1">${o.image ? `<img src="${mediaUrl(o.image)}" alt="">` : '<span class="small">Sin imagen</span>'}
            <div><button data-act="pickimg">📁 Buscar en mi PC…</button>${o.image ? ' <button data-act="noimg">Quitar</button>' : ''}<div class="small">o arrastra una imagen aquí</div></div></div>`) +
        `<div class="row">` + field('Diseño', `<select data-k="style"><option value="" ${o.style !== 'imagen' ? 'selected' : ''}>Texto + imagen</option><option value="imagen" ${o.style === 'imagen' ? 'selected' : ''}>Imagen completa</option></select>`) + field('Contador (ej. 01/06)', `<input type="text" data-k="counter" value="${esc(o.counter || '')}">`) + `</div>` +
        `<div class="row">` + field('Mover x', num('dx', o.dx || 0, 2)) + field('Mover y', num('dy', o.dy || 0, 2)) + `</div>` +
        `<label class="chk"><input type="checkbox" data-k="particles" ${o.particles !== false ? 'checked' : ''}> Partículas al entrar</label>` : '') +
      (o.kind === 'comentario' ? `<div class="small">Etiqueta = nombre de quien comenta; Título = el comentario (*palabras* en amarillo); Subtítulo = "hace 2 h · Responder"</div>` : '') +
      (o.kind === 'panel' || o.kind === 'card3d' || o.kind === 'comentario' ? field('Etiqueta pequeña de arriba', `<input type="text" data-k="label" value="${esc(o.label || '')}">`) : '') +
      field('Título', `<input type="text" data-k="title" value="${esc(o.title)}">`) +
      field('Subtítulo (opcional)', `<input type="text" data-k="subtitle" value="${esc(o.subtitle || '')}">`) +
      `<div class="small">Pon entre *asteriscos* la palabra que va en color: Stand *Huawei*</div>` +
      `<div class="row">` + field('Icono', `<select data-k="icon">${Object.keys(ICONS).map(n => `<option ${n === o.icon ? 'selected' : ''}>${n}</option>`).join('')}${ICONS[o.icon] ? '' : `<option selected>${esc(o.icon || '')}</option>`}</select>`) + field('Color de la barra', `<input type="color" data-k="color" value="${o.color || ST().colores.secundario}">`) + `</div>` +
      `<div class="row">` + field('Inicio (orig)', num('start', o.start)) + field('Fin (orig)', num('end', o.end)) + `</div>` +
      field('Altura (y, vacío = centro del gameplay)', `<input type="number" data-k="y" value="${o.y == null ? '' : o.y}" step="2">`) +
      `<label class="chk"><input type="checkbox" data-k="hideSubtitles" ${o.hideSubtitles ? 'checked' : ''}> Ocultar subtítulos mientras se ve</label>` +
      `<div class="btnrow"><button data-act="play">▶ Ver</button><button data-act="del">🗑 Borrar</button></div>`;
  } else if (sel.type === 'effect') {
    const FXL = { sfx: 'Efecto de sonido', particles: 'Partículas', text3d: 'Texto 3D', flash: 'Destello' };
    $('#inspTitle').textContent = FXL[o.type] || 'Efecto';
    const sfxFiles = Array.from(new Set([o.file, ...mediaList.filter(f => /sfx\//.test(f))].filter(Boolean)));
    box.innerHTML = field('Tipo', `<select data-k="type">${Object.keys(FXL).map(k => `<option value="${k}" ${k === o.type ? 'selected' : ''}>${FXL[k]}</option>`).join('')}</select>`) +
      (o.type === 'text3d' ? field('Texto (| = otra línea, *palabra* = color)', `<input type="text" data-k="text" value="${esc(o.text || '')}">`) + field('Tamaño', num('size', o.size || 132, 2)) : '') +
      (o.type !== 'sfx' && o.type !== 'flash' ? `<div class="row">` + field('Posición x', num('x', o.x == null ? 540 : o.x, 2)) + field('Posición y', num('y', o.y == null ? Math.round((P.layout.gameTop + P.layout.gameBottom) / 2) : o.y, 2)) + `</div>` : '') +
      field('Sonido', `<select data-k="file"><option value="">(sin sonido)</option>${sfxFiles.map(f => `<option ${f === o.file ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>`) +
      field('Volumen del sonido', `<input type="range" min="0" max="1" step="0.01" data-k="volume" value="${o.volume == null ? 0.35 : o.volume}">`) +
      `<div class="row">` + field('Inicio (orig)', num('start', o.start)) + field('Fin (orig)', num('end', o.end)) + `</div>` +
      `<label class="chk"><input type="checkbox" data-k="hideSubtitles" ${o.hideSubtitles ? 'checked' : ''}> Ocultar subtítulos mientras se ve</label>` +
      `<div class="btnrow"><button data-act="play">▶ Ver</button><button data-act="sound">🔊 Oír</button><button data-act="del">🗑 Borrar</button></div>`;
  } else if (sel.type === 'music') {
    sel = null; return renderInspector();
  }
}
function setPath(obj, path, v) { const ks = path.split('.'); let o = obj; for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] = o[ks[i]] || {}; o = o[ks[i]]; } o[ks[ks.length - 1]] = v; }
$('#inspector').addEventListener('change', e => {
  const el = e.target, k = el.dataset.k; if (!k || !P) return;
  let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.type === 'range' ? (el.value === '' ? null : Number(el.value)) : el.value;
  const o = selectedObj();
  mutate(() => {
    if (!o) {
      if (k === 'speed') P.speed = v;
      else if (k.startsWith('sub.')) setPath(P.subtitles, k.slice(4), v);
      else if (k === 'music.duck.level') { P.music.duck = P.music.duck || {}; P.music.duck.level = v; P.music.duck.enabled = v < 1; }
      else if (k.startsWith('music.')) { setPath(P.music, k.slice(6), v); if (k === 'music.file') { mus.src = mediaUrl(v); mus.load(); } }
      else if (k.startsWith('layout.')) { if (k === 'layout.frame.enabled') v = !!v; setPath(P.layout, k.slice(7), v); }
      else if (k.startsWith('status.')) setPath(P.status, k.slice(7), v);
      else if (k.startsWith('style.')) { P.style = P.style || {}; if (k === 'style.subtitulos.caja') v = !!v; setPath(P.style, k.slice(6), v); }
      else if (k.startsWith('camera.')) { P.camera = P.camera || {}; setPath(P.camera, k.slice(7), v); }
      else if (k.startsWith('grading.')) { P.grading = P.grading || { enabled: true }; setPath(P.grading, k.slice(8), v); }
      else if (k === 'music.duck.level') { P.music.duck = P.music.duck || { enabled: true }; P.music.duck.level = v; P.music.duck.enabled = v < 1; }
    } else if (sel.type === 'segment' && (k === 'start' || k === 'end')) {
      const segs = P.segments, i = segs.indexOf(o);
      if (k === 'start') { const prev = segs[i - 1]; v = clamp(v, prev ? prev.start + 0.034 : 0, o.end - 0.034); o.start = r3(v); if (prev) prev.end = r3(v); }
      else { const next = segs[i + 1]; v = clamp(v, o.start + 0.034, next ? next.end - 0.034 : P.source.duration); o.end = r3(v); if (next) next.start = r3(v); }
    } else o[k] = v;
  });
  if (playing) vid.playbackRate = view === 'edit' ? speed() : 1;
});
$('#inspector').addEventListener('input', e => {
  // vista previa en vivo de deslizadores y textos de graficos
  const el = e.target, k = el.dataset.k, o = selectedObj(); if (!k || !P) return;
  if (el.type === 'range') { const n = el.nextElementSibling; if (n && n.classList.contains('small') && k === 'z') n.textContent = '×' + Number(el.value).toFixed(2); }
  if (o && sel.type === 'card' && (k === 'title' || k === 'subtitle' || k === 'icon' || k === 'label')) { o[k] = el.value; drawScreen(); setDirty(true); }
  if (o && sel.type === 'zoom' && k === 'z') { o.z = Number(el.value); drawScreen(); }
  if (o && sel.type === 'effect' && k === 'text') { o.text = el.value; drawScreen(); setDirty(true); }
  if (!o && k === 'music.volume') { mus.volume = Number(el.value); }
});
$('#inspector').addEventListener('click', e => {
  const a = e.target.dataset.act; if (!a) return; const o = selectedObj();
  if (a === 'pickimg') { imgFile.click(); return; }
  if (a === 'noimg' && o) { mutate(() => { delete o.image; }); return; }
  if (a === 'sound' && o && o.file) { try { const au = new Audio(mediaUrl(o.file)); au.volume = clamp(o.volume == null ? 0.35 : o.volume, 0, 1); au.play(); } catch (err) {} return; }
  if (a === 'toggle' || a === 'del') toggleOrDelete();
  else if (a === 'split') splitAtCursor();
  else if (a === 'play' && o) { seekSrc(o.start); play(); const stopAt = o.end; const chk = () => { if (!playing) return; if (cur() >= stopAt - 0.02) pause(); else requestAnimationFrame(chk); }; requestAnimationFrame(chk); }
});

// ---------- imagenes desde la PC ----------
async function uploadImage(file) {
  const o = selectedObj(); if (!o || sel.type !== 'card') return toast('Primero elige un gráfico en la línea de tiempo');
  if (!/^image\//.test(file.type)) return toast('Ese archivo no es una imagen');
  toast('Subiendo ' + file.name + '…', 4000);
  try {
    const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
    const j = await r.json();
    if (!r.ok || !j.ok) return toast(j.error || 'No se pudo subir la imagen', 3500);
    try { mediaList = await (await fetch('/api/media')).json(); } catch (e) {}
    mutate(() => { o.image = j.path; if (o.kind !== 'card3d' && o.kind !== 'panel') o.kind = 'card3d'; });
    toast('Imagen agregada ✓ (guardada en imagenes)');
  } catch (e) { toast('No se pudo subir: ' + e.message, 3500); }
}
const imgFile = document.createElement('input'); imgFile.type = 'file'; imgFile.accept = 'image/*'; imgFile.style.display = 'none'; document.body.appendChild(imgFile);
imgFile.addEventListener('change', () => { if (imgFile.files[0]) uploadImage(imgFile.files[0]); imgFile.value = ''; });
['dragover', 'dragleave', 'drop'].forEach(ev => $('#inspector').addEventListener(ev, e => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
  e.preventDefault();
  const zone = $('#inspector .imgpick'); if (zone) zone.classList.toggle('over', ev === 'dragover');
  if (ev === 'drop' && e.dataTransfer.files[0]) uploadImage(e.dataTransfer.files[0]);
}));

// ---------- avisos ----------
function renderWarnings() {
  if (!P) return;
  const out = [];
  for (const s of P.segments) if (s.keep && s.note) out.push({ t: s.start, msg: s.note, sel: { type: 'segment', id: s.id } });
  for (const s of P.segments) if (s.keep && s.end - s.start < 0.25) out.push({ t: s.start, msg: 'Clip muy corto (' + Math.round((s.end - s.start) * 1000) + ' ms): puede sonar a salto', sel: { type: 'segment', id: s.id } });
  for (const k of P.cards) { if (!pieces(k.start, k.end).length || view === 'orig' && !map.some(m => k.end > m.s && k.start < m.e)) out.push({ t: k.start, err: true, msg: `Gráfico "${k.title}" cae en una parte cortada: no se verá`, sel: { type: 'card', id: k.id } }); }
  for (const z of P.zooms) { if (!map.some(m => z.end > m.s && z.start < m.e)) out.push({ t: z.start, err: true, msg: 'Zoom en una parte cortada: no se verá', sel: { type: 'zoom', id: z.id } }); }
  for (const e of P.effects || []) { if (!map.some(m => e.start >= m.s && e.start < m.e)) out.push({ t: e.start, err: true, msg: 'Efecto en una parte cortada: no se verá ni sonará', sel: { type: 'effect', id: e.id } }); }
  const cs = P.cards.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < cs.length; i++) if (cs[i].start < cs[i - 1].end - 0.05) out.push({ t: cs[i].start, msg: `Dos gráficos encimados: "${cs[i - 1].title}" y "${cs[i].title}"`, sel: { type: 'card', id: cs[i].id } });
  // huecos sin nada nuevo en pantalla > 3.5 s (salida)
  const ev = [];
  for (const k of P.cards) for (const [a] of pieces(k.start, k.end)) ev.push(a);
  for (const z of P.zooms) for (const [a, b] of pieces(z.start, z.end)) { ev.push(a); ev.push(b); }
  for (let i = 1; i < map.length; i++) ev.push(map[i].o / speed());
  ev.push(0); ev.push(outDur()); ev.sort((a, b) => a - b);
  for (let i = 1; i < ev.length; i++) if (ev[i] - ev[i - 1] > 3.5) out.push({ t: outToSrc(ev[i - 1] + 0.05), msg: `${(ev[i] - ev[i - 1]).toFixed(1)} s sin zoom ni gráfico nuevo (en el final ${fmt(ev[i - 1])})` });
  out.sort((a, b) => a.t - b.t);
  $('#warnCount').textContent = out.length || '';
  const box = $('#warnings'); box.innerHTML = '';
  if (!out.length) { box.innerHTML = '<div class="w ok">Todo en orden ✓</div>'; return; }
  for (const w of out) {
    const d = document.createElement('div'); d.className = 'w' + (w.err ? ' err' : '');
    d.innerHTML = `<span class="t">${fmt(srcToOut(w.t))}</span>${esc(w.msg)}`;
    d.onclick = () => { if (w.sel) sel = w.sel; renderInspector(); seekSrc(w.t); };
    box.appendChild(d);
  }
}
function updateStats() {
  if (!P) return;
  const cuts = P.segments.filter(s => !s.keep).length;
  $('#statDur').innerHTML = `Final <b>${fmt(outDur())}</b> de ${fmt(P.source.duration)}`;
  $('#statCuts').innerHTML = `<b>${cuts}</b> cortes · <b>${P.zooms.length}</b> zooms · <b>${P.cards.length}</b> gráficos · <b>${(P.effects || []).length}</b> efectos`;
}

// ---------- botones y teclado ----------
$('#btnPlay').onclick = () => playing ? pause() : play();
$('#btnStart').onclick = () => { pause(); seekView(0); };
$('#btnEnd').onclick = () => { pause(); seekView(viewDur() - 0.05); };
$('#btnBack').onclick = () => stepFrames(-1);
$('#btnFwd').onclick = () => stepFrames(1);
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnSave').onclick = save;
$('#btnApprove').onclick = async () => { if (!P) return; P.status.approved = !P.status.approved; updateApprove(); await save(); if (P.status.approved) toast('Listo ✓  Dile a Claude: "renderiza"', 3500); };
$('#btnSplit').onclick = splitAtCursor; $('#btnToggle').onclick = toggleOrDelete;
$('#btnAddZoom').onclick = addZoom; $('#btnAddCard').onclick = addCard; $('#btnAddFx').onclick = addEffect;
$('#chkSfx').onchange = () => {}; $('#chkGrade').onchange = drawScreen;
$('#btnZoomIn').onclick = () => { pxPerSec = Math.min(600, pxPerSec * 1.4); drawTimeline(); };
$('#btnZoomOut').onclick = () => { pxPerSec = Math.max(1, pxPerSec / 1.4); drawTimeline(); };
$('#btnZoomFit').onclick = () => { fitTimeline(); drawTimeline(); };
$('#btnHelp').onclick = () => $('#help').classList.remove('hidden');
$('#helpClose').onclick = () => $('#help').classList.add('hidden');
$('#projSel').onchange = e => loadProject(e.target.value);
document.querySelectorAll('#viewMode button').forEach(b => b.onclick = () => setView(b.dataset.v));
$('#chkMusic').onchange = () => syncMusic(true);
$('#chkGuides').onchange = drawScreen;
window.addEventListener('keydown', e => {
  if (!P) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  switch (e.key) {
    case ' ': e.preventDefault(); playing ? pause() : play(); break;
    case 'ArrowLeft': e.preventDefault(); stepFrames(e.shiftKey ? -FPS : -1); break;
    case 'ArrowRight': e.preventDefault(); stepFrames(e.shiftKey ? FPS : 1); break;
    case 'Home': pause(); seekView(0); break;
    case 'End': pause(); seekView(viewDur() - 0.05); break;
    case 's': case 'S': splitAtCursor(); break;
    case 'Delete': case 'Backspace': e.preventDefault(); toggleOrDelete(); break;
    case 'z': case 'Z': addZoom(); break;
    case 'c': case 'C': addCard(); break;
    case 'e': case 'E': addEffect(); break;
    case 'v': case 'V': setView(view === 'edit' ? 'orig' : 'edit'); break;
    case 'm': case 'M': $('#chkMusic').checked = !$('#chkMusic').checked; syncMusic(true); toast($('#chkMusic').checked ? 'Música encendida' : 'Música apagada'); break;
    case '+': case '=': $('#btnZoomIn').click(); break;
    case '-': $('#btnZoomOut').click(); break;
    case 'Escape': sel = null; renderInspector(); drawAll(); $('#help').classList.add('hidden'); break;
  }
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('resize', () => { resizeTl(); drawAll(); });
if (document.fonts) Promise.all(['400 60px Anton', '800 60px Sora', '700 60px Sora', '700 40px Inter', '800 40px Inter'].map(f => document.fonts.load(f).catch(() => {}))).then(() => drawAll());

layoutRows(); resizeTl();
fetch('/api/version').then(r => r.json()).then(j => {
  $('#topbar .brand').innerHTML = 'EDITOR <b>V2</b> <span class="ver">' + j.version + '</span>';
  // novedades despues de una actualizacion (una sola vez por version)
  let seen = null; try { seen = localStorage.getItem('editorv2.seen'); } catch (e) {}
  if (j.update && j.update.to === j.version && seen !== j.version) {
    $('#newsTitle').textContent = 'Editor V2 se actualizó a la versión ' + j.version;
    $('#newsBody').innerHTML = esc(j.update.notes || '').replace(/^## .*$/m, '').trim().split(/\r?\n/).filter(Boolean).map(l => '<div>' + l.replace(/^- /, '• ') + '</div>').join('');
    $('#news').classList.remove('hidden');
  }
  try { localStorage.setItem('editorv2.seen', j.version); } catch (e) {}
}).catch(() => {});
// la ventana avisa que sigue abierta; al cerrarla el editor se apaga solo
let offline = false;
function ping() {
  fetch('/api/ping', { cache: 'no-store' }).then(() => { if (offline) { offline = false; $('#offline').classList.add('hidden'); } })
    .catch(() => { offline = true; $('#offline').classList.remove('hidden'); });
}
ping(); setInterval(ping, 4000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
window.addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye'); } catch (e) {} });
$('#newsClose').onclick = () => $('#news').classList.add('hidden');
// actualizaciones: revisa al entrar y cada 10 minutos; si hay version nueva, un clic la instala
let updInfo = null, updBusy = false;
function setUpd(cls, text, title) { const b = $('#upd'); b.className = 'upd ' + cls; b.textContent = text; b.title = title || ''; }
async function checkUpdates() {
  if (updBusy) return;
  setUpd('busy', 'Buscando actualizaciones…');
  try {
    const j = await (await fetch('/api/update/check', { cache: 'no-store' })).json();
    updInfo = j;
    if (!j.ok) setUpd('', 'v' + (j.current || '') + ' · ' + j.reason, 'No se pudo revisar GitHub: ' + j.reason);
    else if (j.available) setUpd('new', '⬆ Actualizar a ' + j.remoteVersion, 'Hay una versión nueva. Clic para instalarla (no se pierde nada de tu proyecto).');
    else setUpd('ok', '✓ Al día', 'Tienes la última versión (' + j.current + ')');
  } catch (e) { setUpd('', 'Sin conexión con el editor'); }
}
async function applyUpdate() {
  if (!updInfo || !updInfo.available || updBusy) return checkUpdates();
  if (dirty) await save();
  updBusy = true; setUpd('busy', 'Actualizando…');
  try {
    const j = await (await fetch('/api/update/apply', { method: 'POST' })).json();
    if (!j.ok) { updBusy = false; setUpd('', 'No se pudo actualizar', j.reason || ''); return; }
    if (!j.restarting) { updBusy = false; return checkUpdates(); }
    const t0 = Date.now();
    const wait = async () => {
      try { const v = await (await fetch('/api/version', { cache: 'no-store' })).json(); if (v.version === j.to) { location.reload(); return; } } catch (e) {}
      if (Date.now() - t0 < 30000) setTimeout(wait, 700); else { updBusy = false; setUpd('', 'Reinicia Editor V2 para terminar'); }
    };
    setTimeout(wait, 1200);
  } catch (e) { updBusy = false; setUpd('', 'No se pudo actualizar'); }
}
$('#upd').onclick = () => (updInfo && updInfo.available ? applyUpdate() : checkUpdates());
setTimeout(checkUpdates, 1500); setInterval(checkUpdates, 10 * 60 * 1000);
loadProjects().catch(err => { $('#loading').textContent = 'No se pudo conectar con el editor: ' + err.message; });
requestAnimationFrame(tick);
window.__editor = { get P() { return P; }, seekSrc, play, pause, setView, get view() { return view; } };
})();
