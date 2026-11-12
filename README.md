# Editor V2

Vista previa y linea de tiempo para los videos verticales (TikTok) que edita Claude.
Antes de gastar tiempo en renderizar, aqui ves y ajustas los cortes, los subtitulos,
los zooms a la cara, los graficos sobre el gameplay y la musica.

## Instalar (Windows)

Necesita **Node.js** y **Git** (los instala `Instalar-HyperFrames.bat`).

1. Copia esta carpeta como `F:\edicionesclaude\editor` (o deja que Claude la ponga ahi).
2. Doble clic en `Instalar-Editor.bat`: crea el acceso **Editor V2** en el escritorio y en el menu Inicio.
3. Abre **Editor V2**.

Cada vez que lo abres busca actualizaciones en este repositorio y se pone al dia solo.

## Carpetas

```
F:\edicionesclaude\
  editor\         esta app (se actualiza desde GitHub)
  proyectos\      un .json por video; aqui guarda el editor (copias en proyectos\.historial)
  editor_media\   copia ligera del video para la vista previa y la musica
  material\       tus videos originales
```

## Atajos

Espacio reproducir · ← → un cuadro (Shift: 1 s) · S dividir · Supr quitar/restaurar o borrar ·
Z zoom · C grafico · V vista Editado/Original · M musica · Ctrl+Z / Ctrl+Y · Ctrl+S guardar.

## Formato del proyecto

Todo esta en segundos del video **original**: `segments` (clips que se quedan `keep:true` o se cortan),
`words` (palabras de los subtitulos), `zooms`, `cards` (graficos), `music`, `speed`, `subtitles`, `layout`
y `status.approved` (lo marca el boton "Listo para renderizar"; Claude renderiza desde ese archivo).
