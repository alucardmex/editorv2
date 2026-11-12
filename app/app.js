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
  const ws = P.words.filter(w => !w.hidden && keptAt((w.start + w.end) / 2)).sort((a, b) => a.start - b.start);
  let g = null;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i], prev = ws[i - 1];
    const brk = !g || g.words.length >= max || (prev && (w.start - prev.end) > 0.35) || (prev && /[.!?…]$/.test(prev.text.trim())) ||
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
const snapKeys = ['segments', 'words', 'zooms', 'cards', 'music', 'subtitles', 'speed', 'layout', 'status'];
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
  P.zooms = P.zooms || []; P.cards = P.cards || []; P.words = P.words || []; P.status = P.status || {};
  P.subtitles = P.subtitles || { style: 'amarillo', maxWords: 3, y: 770, size: 84 };
  faceTrack = P.faces || [];
  undoStack = []; redoStack = []; sel = null; setDirty(false);
  $('#loading').classList.remove('hidden'); $('#loading').textContent = 'Cargando video…';
  vid.src = mediaUrl(P.source.proxy || P.source.file);
  vid.load();
  if (P.music && P.music.file) { mus.src = mediaUrl(P.music.file); mus.load(); } else mus.removeAttribute('src');
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
  mus.volume = clamp(P.music.volume == null ? 0.15 : P.music.volume, 0, 1);
  const want = srcToOut(cur()) + (P.music.offset || 0);
  if (mus.duration && want > mus.duration) { mus.pause(); return; }
  if (force || Math.abs(mus.currentTime - want) > 0.25) { try { mus.currentTime = want; } catch (e) {} }
  if (playing && mus.paused) mus.play().catch(() => {});
  if (!playing && !mus.paused) mus.pause();
}
function tick() {
  if (playing && P) {
    const t = cur();
    if (view === 'edit') {
      const m = keptAt(t);
      if (!m) {
        const n = map.find(x => x.s > t);
        if (n) { vid.currentTime = n.s; syncMusic(true); } else pause();
      } else if (t >= m.e - 0.012) {
        const i = map.indexOf(m), n = map[i + 1];
        if (n) { vid.currentTime = n.s; syncMusic(true); } else { pause(); vid.currentTime = m.e - 0.02; }
      } else syncMusic(false);
    }
    if (vid.ended) pause();
    // seguir el cursor en la linea de tiempo
    const x = (toView(cur()) - scrollT) * pxPerSec, w = tl.clientWidth;
    if (x > w * 0.85 || x < 0) { scrollT = Math.max(0, toView(cur()) - (w * 0.15) / pxPerSec); }
    drawAll();
  }
  requestAnimationFrame(tick);
}

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
  const L = P.layout, inP = clamp((t - card.start) / 0.22, 0, 1), outP = clamp((card.end - t) / 0.15, 0, 1);
  const a = Math.min(easeOut(inP), outP); if (a <= 0) return;
  const sc = 0.82 + 0.18 * easeBack(inP);
  const cx = 540, cy = card.y != null ? card.y : (L.gameTop + L.gameBottom) / 2;
  const hasSub = !!(card.subtitle && card.subtitle.trim());
  const W = 900, H = hasSub ? 190 : 140, color = card.color || '#e0242f';
  c.save(); c.globalAlpha = a; c.translate(cx, cy); c.scale(sc, sc);
  c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 30; c.shadowOffsetY = 10;
  roundRect(c, -W / 2, -H / 2, W, H, 28); c.fillStyle = 'rgba(12,12,16,0.92)'; c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 4; c.strokeStyle = color; c.stroke();
  // icono
  const ix = -W / 2 + 92;
  c.beginPath(); c.arc(ix, 0, 60, 0, Math.PI * 2); c.fillStyle = color; c.fill();
  c.font = '64px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillStyle = '#fff'; c.fillText(card.icon || '★', ix, 4);
  // textos
  const tx = ix + 90, maxW = W / 2 - tx - 34;
  c.textAlign = 'left';
  const title = (card.title || '').toUpperCase();
  const fs = fitFont(c, title, '{s}px Anton, Impact, "Arial Black", sans-serif', 84, maxW + (W / 2 - 34) - (W / 2 - 34));
  c.fillStyle = '#ffd400'; c.textBaseline = hasSub ? 'alphabetic' : 'middle';
  c.fillText(title, tx, hasSub ? -2 : 4);
  if (hasSub) {
    const sub = card.subtitle.toUpperCase();
    fitFont(c, sub, '800 {s}px Inter, "Segoe UI", Arial, sans-serif', 40, maxW + (W / 2 - 34) - (W / 2 - 34));
    c.fillStyle = 'rgba(255,255,255,.88)'; c.textBaseline = 'top'; c.fillText(sub, tx, 18);
  }
  void fs; c.restore();
}

function drawSubtitle(c, t) {
  const st = P.subtitles || {};
  if (st.enabled === false) return;
  const g = groups.find(g => t >= g.start && t < g.end); if (!g) return;
  for (const card of P.cards) if (card.hideSubtitles && t >= card.start && t < card.end) return;
  const frase = st.style === 'frase';
  const size = st.size || (frase ? 60 : 84);
  const font = frase ? `800 ${size}px Inter, "Segoe UI", Arial, sans-serif` : `${size}px Anton, Impact, "Arial Black", sans-serif`;
  c.save(); c.font = font; c.textBaseline = 'middle'; c.lineJoin = 'round';
  const words = g.words.map(w => ({ w, s: (frase ? cleanWord(w.text) : cleanWord(w.text).toUpperCase()) })).filter(x => x.s);
  const space = c.measureText(' ').width, maxW = 940;
  // partir en lineas
  const lines = [[]]; let lw = 0;
  for (const x of words) { x.width = c.measureText(x.s).width; if (lw + x.width > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push(x); lw += x.width + space; }
  const lh = size * 1.12, y0 = (st.y || 770) - (lines.length - 1) * lh / 2;
  lines.forEach((ln, li) => {
    const total = ln.reduce((a, x) => a + x.width, 0) + space * (ln.length - 1);
    let x = 540 - total / 2; const y = y0 + li * lh;
    for (const it of ln) {
      const active = t >= it.w.start && t < Math.max(it.w.end, it.w.start + 0.08);
      const spoken = t >= it.w.start;
      const pop = active ? 1 + 0.08 * (1 - clamp((t - it.w.start) / 0.12, 0, 1)) : 1;
      c.save(); c.translate(x + it.width / 2, y); c.scale(pop, pop);
      c.textAlign = 'center';
      c.lineWidth = frase ? 8 : 13; c.strokeStyle = '#000'; c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 10; c.shadowOffsetY = 4;
      c.strokeText(it.s, 0, 0); c.shadowColor = 'transparent';
      c.fillStyle = frase ? (active ? '#ffd400' : spoken ? '#fff' : 'rgba(255,255,255,.55)') : (active ? '#ffd400' : '#fff');
      c.fillText(it.s, 0, 0); c.restore();
      x += it.width + space;
    }
  });
  c.restore();
}

function drawScreen() {
  if (!P) return;
  const c = sctx, k = vid.videoWidth ? vid.videoWidth / 1080 : 0.5, t = cur(), L = P.layout;
  c.setTransform(scr.width / 1080, 0, 0, scr.height / 1920, 0, 0);
  c.fillStyle = '#000'; c.fillRect(0, 0, 1080, 1920);
  if (vid.readyState >= 2) {
    c.drawImage(vid, 0, 0, 1080, 1920);
    const zz = zoomAt(t);
    if (zz.z > 1.001) {
      const bandH = L.camBottom - L.camTop, f = faceAt(t);
      const w = 1080 / zz.z, h = bandH / zz.z;
      const bias = L.zoomBiasY == null ? -45 : L.zoomBiasY; // un poco arriba de la cara para no cortar la gorra
      const cx = clamp(zz.cx != null ? zz.cx : f.x, w / 2, 1080 - w / 2), cy = clamp(zz.cy != null ? zz.cy : f.y + bias, L.camTop + h / 2, L.camBottom - h / 2);
      c.save(); c.beginPath(); c.rect(0, L.camTop, 1080, bandH); c.clip();
      c.drawImage(vid, (cx - w / 2) * k, (cy - h / 2) * k, w * k, h * k, 0, L.camTop, 1080, bandH);
      c.restore();
    }
  }
  for (const card of P.cards) if (t >= card.start && t < card.end) drawCard(c, card, t);
  drawSubtitle(c, t);
  if ($('#chkGuides').checked) {
    c.save(); c.fillStyle = 'rgba(224,36,47,.18)'; c.fillRect(0, 0, 1080, 220); c.fillRect(0, 1500, 1080, 420); c.fillRect(960, 220, 120, 1280);
    c.strokeStyle = '#27b39e'; c.lineWidth = 3; c.setLineDash([14, 10]);
    c.strokeRect(2, L.camTop, 1076, L.camBottom - L.camTop); c.strokeStyle = '#3b6fe0'; c.strokeRect(2, L.gameTop, 1076, L.gameBottom - L.gameTop);
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
      if (s !== map[0].seg) { c.fillStyle = '#e0242f'; c.fillRect(x - 1, vy.y, 2, vy.h); }
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
  const list = { segment: P.segments, word: P.words, zoom: P.zooms, card: P.cards }[sel.type];
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
  drawAll(); renderInspector();
}
function addZoom() { const t = cur(); mutate(() => { const z = { id: uid('z'), start: r3(t), end: r3(Math.min(P.source.duration, t + 1.5)), z: 1.25, label: '' }; P.zooms.push(z); sel = { type: 'zoom', id: z.id }; }); toast('Zoom agregado: ajusta el nivel a la izquierda'); }
function addCard() { const t = cur(); mutate(() => { const k = { id: uid('c'), start: r3(t), end: r3(Math.min(P.source.duration, t + 2.2)), title: 'TEXTO', subtitle: '', icon: '⭐', color: '#e0242f' }; P.cards.push(k); sel = { type: 'card', id: k.id }; }); toast('Gráfico agregado: escribe el texto a la izquierda'); }
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
    box.innerHTML = field('Título', `<input type="text" data-k="title" value="${esc(o.title)}">`) +
      field('Subtítulo (opcional)', `<input type="text" data-k="subtitle" value="${esc(o.subtitle || '')}">`) +
      `<div class="row">` + field('Icono', `<input type="text" data-k="icon" value="${esc(o.icon || '')}">`) + field('Color', `<input type="color" data-k="color" value="${o.color || '#e0242f'}">`) + `</div>` +
      `<div class="row">` + field('Inicio (orig)', num('start', o.start)) + field('Fin (orig)', num('end', o.end)) + `</div>` +
      field('Altura (y, vacío = centro del gameplay)', `<input type="number" data-k="y" value="${o.y == null ? '' : o.y}" step="2">`) +
      `<label class="chk"><input type="checkbox" data-k="hideSubtitles" ${o.hideSubtitles ? 'checked' : ''}> Ocultar subtítulos mientras se ve</label>` +
      `<div class="btnrow"><button data-act="play">▶ Ver</button><button data-act="del">🗑 Borrar</button></div>`;
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
      else if (k.startsWith('music.')) { setPath(P.music, k.slice(6), v); if (k === 'music.file') { mus.src = mediaUrl(v); mus.load(); } }
      else if (k.startsWith('layout.')) setPath(P.layout, k.slice(7), v);
      else if (k.startsWith('status.')) setPath(P.status, k.slice(7), v);
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
  if (o && sel.type === 'card' && (k === 'title' || k === 'subtitle' || k === 'icon')) { o[k] = el.value; drawScreen(); setDirty(true); }
  if (o && sel.type === 'zoom' && k === 'z') { o.z = Number(el.value); drawScreen(); }
  if (!o && k === 'music.volume') { mus.volume = Number(el.value); }
});
$('#inspector').addEventListener('click', e => {
  const a = e.target.dataset.act; if (!a) return; const o = selectedObj();
  if (a === 'toggle' || a === 'del') toggleOrDelete();
  else if (a === 'split') splitAtCursor();
  else if (a === 'play' && o) { seekSrc(o.start); play(); const stopAt = o.end; const chk = () => { if (!playing) return; if (cur() >= stopAt - 0.02) pause(); else requestAnimationFrame(chk); }; requestAnimationFrame(chk); }
});

// ---------- avisos ----------
function renderWarnings() {
  if (!P) return;
  const out = [];
  for (const s of P.segments) if (s.keep && s.note) out.push({ t: s.start, msg: s.note, sel: { type: 'segment', id: s.id } });
  for (const s of P.segments) if (s.keep && s.end - s.start < 0.25) out.push({ t: s.start, msg: 'Clip muy corto (' + Math.round((s.end - s.start) * 1000) + ' ms): puede sonar a salto', sel: { type: 'segment', id: s.id } });
  for (const k of P.cards) { if (!pieces(k.start, k.end).length || view === 'orig' && !map.some(m => k.end > m.s && k.start < m.e)) out.push({ t: k.start, err: true, msg: `Gráfico "${k.title}" cae en una parte cortada: no se verá`, sel: { type: 'card', id: k.id } }); }
  for (const z of P.zooms) { if (!map.some(m => z.end > m.s && z.start < m.e)) out.push({ t: z.start, err: true, msg: 'Zoom en una parte cortada: no se verá', sel: { type: 'zoom', id: z.id } }); }
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
  $('#statCuts').innerHTML = `<b>${cuts}</b> cortes · <b>${P.zooms.length}</b> zooms · <b>${P.cards.length}</b> gráficos`;
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
$('#btnAddZoom').onclick = addZoom; $('#btnAddCard').onclick = addCard;
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
    case 'v': case 'V': setView(view === 'edit' ? 'orig' : 'edit'); break;
    case 'm': case 'M': $('#chkMusic').checked = !$('#chkMusic').checked; syncMusic(true); toast($('#chkMusic').checked ? 'Música encendida' : 'Música apagada'); break;
    case '+': case '=': $('#btnZoomIn').click(); break;
    case '-': $('#btnZoomOut').click(); break;
    case 'Escape': sel = null; renderInspector(); drawAll(); $('#help').classList.add('hidden'); break;
  }
});
window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('resize', () => { resizeTl(); drawAll(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => drawAll());

layoutRows(); resizeTl();
fetch('/api/version').then(r => r.json()).then(j => { $('#topbar .brand').innerHTML = 'EDITOR <b>V2</b> <span class="ver">' + j.version + '</span>'; }).catch(() => {});
loadProjects().catch(err => { $('#loading').textContent = 'No se pudo conectar con el editor: ' + err.message; });
requestAnimationFrame(tick);
window.__editor = { get P() { return P; }, seekSrc, play, pause, setView, get view() { return view; } };
})();
