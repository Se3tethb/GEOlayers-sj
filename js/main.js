/* GeoMotion panel logic — GEOlayers-style workflow:
 *   create Map Comp -> keyframe the 5 map controls (linked preview) -> draw features / labels / arrows / pin -> Finalize
 */
(function () {
  'use strict';
  var G = window.GeoMath, GI = window.GeoImport;
  var FOV_DEG = 36.8699;     // MapLibre default vertical field of view; the AE camera uses the same
  var FONT = 'Al-Jazeera-Arabic-Bold';
  var $ = function (id) { return document.getElementById(id); };

  // ---------- CEP / Node bridges (panel also runs in a normal browser for testing) ----------
  var nodeRequire = (window.cep_node && window.cep_node.require) || window.require || null;
  var fs = null, pathM = null, os = null, BufferC = null;
  if (nodeRequire) {
    try { fs = nodeRequire('fs'); pathM = nodeRequire('path'); os = nodeRequire('os'); BufferC = nodeRequire('buffer').Buffer; } catch (e) {}
  }
  var inCEP = !!(window.__adobe_cep__);
  function evalScript(src) {
    return new Promise(function (res) {
      if (!inCEP) { res('ERR|غير متصل بـ After Effects (وضع معاينة المتصفح)'); return; }
      window.__adobe_cep__.evalScript(src, function (r) { res(r); });
    });
  }
  function workDir(sub) {
    var d = pathM.join(os.homedir(), 'Documents', 'GeoMotion', sub);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  // write a job file, call a host function with its path, return the payload after "OK|"
  async function host(fn, job, dir) {
    if (!inCEP) throw new Error('افتح اللوحة من داخل After Effects لتنفيذ هذا الأمر.');
    if (fn !== 'geoCreateMapComp' && job.compId === undefined && aeState) job.compId = aeState.id;
    var p = pathM.join(dir || workDir('_jobs'), fn + '_' + Date.now() + '.json');
    fs.writeFileSync(p, JSON.stringify(job), 'utf8');
    var r = await evalScript(fn + '("' + p.replace(/\\/g, '/') + '")');
    if (!r || r.indexOf('OK|') !== 0) throw new Error(String(r).replace(/^ERR\|/, ''));
    return r.slice(3);
  }

  // ---------- log & one-job-at-a-time ----------
  function log(msg, isErr) {
    var el = $('log'), line = document.createElement('div');
    if (isErr) line.className = 'err';
    line.textContent = msg;
    el.appendChild(line); el.scrollTop = el.scrollHeight;
  }
  var busy = false;
  function run(label, fn) {
    return function () {
      if (busy) { log('انتظر حتى تنتهي العملية الحالية.', true); return; }
      busy = true;
      Promise.resolve().then(fn).catch(function (e) { log(label + ': ' + (e && e.message || e), true); })
        .then(function () { busy = false; });
    };
  }

  // ---------- tabs ----------
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.onclick = function () {
      document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t.id === b.dataset.tab); });
    };
  });

  // ---------- state (features also saved to a file: localStorage is too small for big borders) ----------
  var state = { features: [] };
  var STORE = 'geomotion.v2';
  var UI_IDS = ['cw', 'ch', 'fps', 'dur', 'cname', 'quality', 'style', 'labels', 'outMode', 'details', 'customUrl', 'link', 'autoKey',
    'terrain', 'exag', 'hillshade', 'buildings3d', 'sky', 'customColors', 'colLand', 'colWater', 'colRoads', 'bakeBorders',
    'animDur', 'animPath', 'hold', 'keepTilt', 'arColor', 'arW', 'arBend', 'arDash', 'drawKind'];
  function uiGet(id) { var el = $(id); return el.type === 'checkbox' ? el.checked : el.value; }
  function uiSet(id, v) { var el = $(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; }
  var stateFile = fs ? pathM.join(workDir('state'), 'features.json') : null;
  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var s = { ui: {}, groups: groups() };
      UI_IDS.forEach(function (id) { s.ui[id] = uiGet(id); });
      if (stateFile) {
        try { fs.writeFileSync(stateFile, JSON.stringify(state.features), 'utf8'); } catch (e) { log('تعذّر حفظ المعالم: ' + e.message, true); }
      } else s.features = state.features;
      try { localStorage.setItem(STORE, JSON.stringify(s)); }
      catch (e) { log('تعذّر حفظ الإعدادات (المساحة ممتلئة).', true); }
    }, 300);
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null') || {};
      Object.keys(s.ui || {}).forEach(function (id) { uiSet(id, s.ui[id]); });
      if (s.groups) toggles().forEach(function (cb) { if (cb.dataset.g in s.groups) cb.checked = s.groups[cb.dataset.g]; });
      var feats = s.features || [];
      if (stateFile && fs.existsSync(stateFile)) feats = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state.features = feats.filter(function (f) { return f && f.geom; });
    } catch (e) { log('تعذّر تحميل الحالة المحفوظة: ' + e.message, true); }
  }

  function comp() {
    return {
      w: Math.max(16, parseInt($('cw').value, 10) || 1920),
      h: Math.max(16, parseInt($('ch').value, 10) || 1080),
      fps: Math.max(1, parseFloat($('fps').value) || 25),
      duration: Math.max(0.1, parseFloat($('dur').value) || 15)
    };
  }
  function hexToRgb(h) {
    var n = parseInt(h.replace('#', ''), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---------- styles & layers ----------
  var OFM = 'https://tiles.openfreemap.org';
  var ESRI = function (svc) { return 'https://server.arcgisonline.com/ArcGIS/rest/services/' + svc + '/MapServer/tile/{z}/{y}/{x}'; };
  var RASTER = {
    satellite: { tiles: ESRI('World_Imagery'), max: 19, attr: 'Imagery © Esri, Maxar, Earthstar Geographics' },
    sentinel: { tiles: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg', max: 15,
      attr: 'Sentinel-2 cloudless by EOX (Copernicus Sentinel data 2020) — CC BY-NC-SA 4.0: غير تجاري' },
    'esri-topo': { tiles: ESRI('World_Topo_Map'), max: 19, attr: '© Esri' },
    'esri-street': { tiles: ESRI('World_Street_Map'), max: 19, attr: '© Esri' },
    'esri-relief': { tiles: ESRI('World_Shaded_Relief'), max: 13, attr: '© Esri' },
    'esri-ocean': { tiles: ESRI('Ocean/World_Ocean_Base'), max: 13, attr: '© Esri, GEBCO, NOAA' },
    'esri-dark': { tiles: ESRI('Canvas/World_Dark_Gray_Base'), max: 16, attr: '© Esri' },
    'esri-light': { tiles: ESRI('Canvas/World_Light_Gray_Base'), max: 16, attr: '© Esri' }
  };
  var DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
  var styleCache = {};

  function fetchJSON(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }); }

  function getStyleSpec(v) {
    if (v !== 'custom' && styleCache[v]) return Promise.resolve(JSON.parse(JSON.stringify(styleCache[v])));
    var p;
    if (RASTER[v] || v === 'hybrid' || v === 'custom') {
      p = fetchJSON(OFM + '/styles/liberty').then(function (lib) {
        var r = v === 'custom' ? { tiles: $('customUrl').value.trim(), max: 20, attr: '' } : RASTER[v === 'hybrid' ? 'satellite' : v];
        if (!r.tiles) throw new Error('اكتب رابط البلاطات أولاً');
        var layers = [{ id: 'gm-raster', type: 'raster', source: 'gm-raster' }];
        if (v === 'hybrid') {
          var keep = { transportation: 1, transportation_name: 1, boundary: 1, place: 1, waterway: 1, water_name: 1 };
          lib.layers.forEach(function (l) { if (keep[l['source-layer']] && l.type !== 'fill') layers.push(l); });
        }
        return { version: 8, glyphs: lib.glyphs, sprite: lib.sprite,
          sources: { 'gm-raster': { type: 'raster', tiles: [r.tiles], tileSize: 256, maxzoom: r.max, attribution: r.attr },
                     openmaptiles: lib.sources.openmaptiles }, layers: layers };
      });
    } else p = fetchJSON(OFM + '/styles/' + v);
    return p.then(function (spec) { if (v !== 'custom') styleCache[v] = spec; return JSON.parse(JSON.stringify(spec)); });
  }

  function groupOf(l) {
    if (l.source === 'ne2_shaded') return 'relief';
    switch (l['source-layer']) {
      case 'water': return 'water';
      case 'waterway': return l.type === 'symbol' ? 'otherNames' : 'rivers';
      case 'transportation': case 'aeroway': return 'roads';
      case 'transportation_name': case 'poi': case 'water_name': case 'aerodrome_label':
      case 'mountain_peak': case 'housenumber': return 'otherNames';
      case 'building': return 'buildings';
      case 'boundary': return 'boundaries';
      case 'landuse': case 'landcover': case 'park': return 'landcover';
      case 'place': return 'places';
    }
    return null;
  }
  function toggles() { return Array.prototype.slice.call(document.querySelectorAll('#layerToggles input[data-g]')); }
  function groups() { var g = {}; toggles().forEach(function (cb) { g[cb.dataset.g] = cb.checked; }); return g; }

  function getLook() {
    return {
      style: $('style').value, lang: $('labels').value, groups: groups(),
      custom: $('customColors').checked, land: $('colLand').value, water: $('colWater').value, roads: $('colRoads').value,
      terrain: $('terrain').checked, exag: Math.max(0.1, parseFloat($('exag').value) || 1.5),
      hillshade: $('hillshade').checked, buildings3d: $('buildings3d').checked, sky: $('sky').checked
    };
  }
  var DARK_STYLES = { dark: 1, fiord: 1, satellite: 1, hybrid: 1, sentinel: 1, 'esri-dark': 1 };

  function applyLook(m, L, opts) {
    opts = opts || {};
    var style = m.getStyle();
    if (!style) return;
    var layers = style.layers || [];
    var firstSymbol = null;
    layers.forEach(function (l) { if (!firstSymbol && l.type === 'symbol') firstSymbol = l.id; });

    layers.forEach(function (l) {
      if (l.id.indexOf('gm-') === 0) return;
      var g = groupOf(l), vis = true;
      if (g && L.groups[g] === false) vis = false;
      if (l.type === 'fill-extrusion') vis = vis && L.buildings3d;
      m.setLayoutProperty(l.id, 'visibility', vis ? 'visible' : 'none');
      if (l.type === 'symbol' && l.layout && l.layout['text-field'] && L.lang === 'ar') {
        m.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ar'], ['get', 'name']]);
      }
      if (L.custom) {
        var sl = l['source-layer'];
        if (l.type === 'background') m.setPaintProperty(l.id, 'background-color', L.land);
        if (sl === 'water' && l.type === 'fill') m.setPaintProperty(l.id, 'fill-color', L.water);
        if (sl === 'waterway' && l.type === 'line') m.setPaintProperty(l.id, 'line-color', L.water);
        if (sl === 'transportation' && l.type === 'line') m.setPaintProperty(l.id, 'line-color', L.roads);
        if ((sl === 'landcover' || sl === 'landuse' || sl === 'park') && l.type === 'fill') m.setPaintProperty(l.id, 'fill-opacity', 0.25);
      }
    });

    var hasExtrusion = layers.some(function (l) { return l.type === 'fill-extrusion' && l.id.indexOf('gm-') !== 0; });
    if (L.buildings3d && !hasExtrusion && !m.getLayer('gm-buildings-3d') && L.groups.buildings !== false && m.getSource('openmaptiles')) {
      m.addLayer({ id: 'gm-buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
        paint: { 'fill-extrusion-color': DARK_STYLES[L.style] ? '#5b6270' : '#d9d2c5',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.92 } }, firstSymbol || undefined);
    } else if (m.getLayer('gm-buildings-3d') && (!L.buildings3d || L.groups.buildings === false)) m.removeLayer('gm-buildings-3d');

    if (L.hillshade) {
      if (!m.getSource('gm-dem-hs')) m.addSource('gm-dem-hs', { type: 'raster-dem', tiles: DEM_TILES, encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
      if (!m.getLayer('gm-hillshade')) {
        var before = null;
        layers.forEach(function (l) { if (!before && (l['source-layer'] === 'water' || l['source-layer'] === 'transportation' || l.type === 'symbol')) before = l.id; });
        m.addLayer({ id: 'gm-hillshade', type: 'hillshade', source: 'gm-dem-hs',
          paint: { 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': '#ffffff' } },
          m.getLayer('gm-raster') ? undefined : (before || undefined));
      }
    } else if (m.getLayer('gm-hillshade')) m.removeLayer('gm-hillshade');

    var useTerrain = L.terrain && !opts.flat;
    if (useTerrain) {
      if (!m.getSource('gm-dem')) m.addSource('gm-dem', { type: 'raster-dem', tiles: DEM_TILES, encoding: 'terrarium', tileSize: 256, maxzoom: 15 });
      m.setTerrain({ source: 'gm-dem', exaggeration: L.exag });
    } else if (m.getTerrain && m.getTerrain()) m.setTerrain(null);

    if (typeof m.setSky === 'function') {
      try {
        var dark = !!DARK_STYLES[L.style];
        m.setSky(L.sky
          ? { 'sky-color': dark ? '#0b1726' : '#8cc0f0', 'horizon-color': dark ? '#24364d' : '#e6eef6', 'fog-color': dark ? '#1a2638' : '#e6eef6',
              'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.75, 'atmosphere-blend': 0 }
          : { 'sky-color': '#000000', 'horizon-color': '#000000', 'fog-color': '#000000', 'fog-ground-blend': 1, 'horizon-fog-blend': 1, 'sky-horizon-blend': 1, 'atmosphere-blend': 0 });
      } catch (e) {}
    }
  }

  try { maplibregl.setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js', true); } catch (e) {}

  // ---------- main map ----------
  load();
  var map = new maplibregl.Map({
    container: 'map', style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#111' } }] },
    center: [44.36, 33.31], zoom: 4, maxPitch: 85, attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  function styleName() { var o = $('style').selectedOptions[0]; return o ? o.textContent : $('style').value; }
  function setStyle() {
    $('customRow').classList.toggle('hidden', $('style').value !== 'custom');
    $('curStyle').textContent = styleName();
    var r = RASTER[$('style').value === 'hybrid' ? 'satellite' : $('style').value];
    $('attrib').textContent = r ? 'المصدر: ' + r.attr : 'المصدر: © OpenMapTiles © OpenStreetMap contributors (OpenFreeMap)';
    getStyleSpec($('style').value).then(function (spec) { map.setStyle(spec); })
      .catch(function (e) { log('النمط: ' + e.message, true); });
  }
  map.on('style.load', function () { applyLook(map, getLook()); drawPreviewShapes(); drawDraft(); });
  setStyle();
  function relook() { if (map.isStyleLoaded()) applyLook(map, getLook()); save(); }
  $('style').onchange = function () { setStyle(); save(); };
  $('customUrl').onchange = function () { setStyle(); save(); };
  ['labels', 'customColors', 'colLand', 'colWater', 'colRoads'].forEach(function (id) {
    $(id).addEventListener('change', function () { setStyle(); updateHints(); save(); });
  });
  ['hillshade', 'buildings3d', 'sky', 'exag'].forEach(function (id) { $(id).addEventListener('change', relook); });
  $('terrain').addEventListener('change', function () {
    relook();
    if (this.checked && map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 800 });
    if (this.checked) $('outMode').value = 'frames3d';
    updateHints(); save();
  });
  $('buildings3d').addEventListener('change', function () { if (this.checked) $('outMode').value = 'frames3d'; updateHints(); save(); });
  toggles().forEach(function (cb) { cb.addEventListener('change', relook); });
  ['outMode', 'bakeBorders', 'quality', 'details', 'animDur', 'animPath', 'hold', 'keepTilt', 'arColor', 'arW', 'arBend', 'arDash',
    'link', 'autoKey', 'cname', 'fps', 'dur', 'drawKind']
    .forEach(function (id) { $(id).addEventListener('change', function () { updateHints(); save(); }); });
  $('pitchNow').addEventListener('input', function () { map.setPitch(parseFloat(this.value)); });
  map.on('pitch', function () { $('pitchNow').value = map.getPitch(); });
  $('btnReset').onclick = function () { map.easeTo({ bearing: 0, pitch: 0, duration: 500 }); };

  function updateHints() {
    $('colorRow').className = $('customColors').checked ? 'grid3' : 'grid3 off';
    var m3 = $('outMode').value === 'frames3d';
    $('modeHint').textContent = m3
      ? 'تُصوَّر كل لقطة من كاميرا AE بالـ3D الحقيقي (تضاريس، مبانٍ) كتسلسل صور أسفل طبقة GEO World. الحدود والأسماء تبقى طبقات AE فوقها. أبطأ.'
      : 'تُصوَّر الخريطة من الأعلى بصورة كبيرة + صور تفصيلية للقطات القريبة، والكاميرا في AE تتحرك فوقها. التضاريس تظهر كتظليل فقط. الميل حتى 70° تقريباً.';
  }

  // map element always has the comp aspect ratio, so panel framing == AE framing
  function layoutMap() {
    var box = $('mapbox'), c = comp();
    var bw = box.clientWidth - 16, bh = box.clientHeight - 16;
    var s = Math.min(bw / c.w, bh / c.h);
    $('map').style.width = Math.floor(c.w * s) + 'px';
    $('map').style.height = Math.floor(c.h * s) + 'px';
    map.resize();
    if (map.isStyleLoaded() && map.getLayer('gm-line')) map.setPaintProperty('gm-line', 'line-width', ['*', ['get', 'w'], $('map').clientWidth / c.w]);
  }
  function dz() { return Math.log(comp().w / $('map').clientWidth) / Math.LN2; }
  window.addEventListener('resize', layoutMap);
  ['cw', 'ch'].forEach(function (id) { $(id).addEventListener('change', function () { layoutMap(); save(); }); });
  setTimeout(layoutMap, 0);

  function hud() {
    var c = map.getCenter();
    $('hud').textContent = 'lat ' + c.lat.toFixed(4) + '  lng ' + c.lng.toFixed(4) +
      '  zoom ' + (map.getZoom() + dz()).toFixed(2) + '  bearing ' + map.getBearing().toFixed(1) + '  pitch ' + map.getPitch().toFixed(1);
  }
  map.on('move', hud);

  // current panel view in "comp zoom" (what the AE comp will show)
  function captureView() {
    var c = map.getCenter();
    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() + dz(), bearing: map.getBearing(), pitch: map.getPitch() };
  }
  function stateView(s) {
    var ll = G.mercToLngLat(s.mx, s.my);
    return { lat: ll[1], lng: ll[0], zoom: s.zoom, bearing: s.bearing, pitch: s.pitch };
  }
  function jumpToState(s) { map.jumpTo({ center: G.mercToLngLat(s.mx, s.my), zoom: s.zoom - dz(), bearing: s.bearing, pitch: s.pitch }); }

  // ---------- link with the AE timeline ----------
  var aeState = null, userMoving = false, userTimer = null, pollP = null, lastChange = 0, lastCompId = null;
  map.on('movestart', function (e) { if (e.originalEvent) { userMoving = true; clearTimeout(userTimer); } });
  map.on('moveend', function (e) {
    if (!(e.originalEvent || userMoving)) return;
    clearTimeout(userTimer);
    userTimer = setTimeout(function () { userMoving = false; }, 1500);
    // auto-key: moving the map writes a key at the playhead once the comp already has keys
    if ($('autoKey').checked && aeState && aeState.keys.length && !busy && !drawing) {
      host('geoSetKeys', { keys: [Object.assign({ t: -1 }, captureView())] })
        .then(function () { log('◆ كيفريم تلقائي عند ' + aeState.time.toFixed(2) + 's'); })
        .catch(function (err) { log('كيفريم: ' + err.message, true); });
    }
  });

  function poll() {           // shared in-flight promise: callers that await poll() get fresh state
    if (!inCEP) return Promise.resolve();
    if (pollP) return pollP;
    pollP = (async function () {
      var r = await evalScript('geoGetState()');
      if (!r || r.indexOf('OK|') !== 0) return;
      var s = JSON.parse(r.slice(3));
      var prev = aeState;
      aeState = s.map ? s : null;
      if (!s.map) { $('linkState').textContent = '(لا يوجد Map Comp نشط — افتح الكومب في AE)'; return; }
      $('linkState').textContent = '(' + s.name + ' · ' + s.time.toFixed(2) + 's · ' + s.keys.length + ' كيفريم)';
      if (String(s.w) !== $('cw').value || String(s.h) !== $('ch').value) { $('cw').value = s.w; $('ch').value = s.h; layoutMap(); }
      if (s.id !== lastCompId) {                       // switched to another map comp: adopt its style
        lastCompId = s.id;
        if (s.style && s.style !== $('style').value && $('style').querySelector('option[value="' + s.style + '"]')) {
          $('style').value = s.style; setStyle();
        }
      }
      var changed = !prev || prev.id !== s.id || ['time', 'mx', 'my', 'zoom', 'bearing', 'pitch'].some(function (k) { return prev[k] !== s[k]; });
      if (changed) lastChange = Date.now();
      if ($('link').checked && !userMoving && !drawing && changed) jumpToState(s);
    })().catch(function () {}).then(function () { pollP = null; });
    return pollP;
  }
  // poll fast while things change, slower when idle, never during a host job or while hidden
  (function loop() {
    var idle = Date.now() - lastChange > 3000;
    setTimeout(function () {
      if (inCEP && !busy && !document.hidden) poll().then(loop); else loop();
    }, idle ? 900 : 250);
  })();
  function needMap() { if (!aeState) throw new Error('افتح Map Comp في After Effects أولاً (أو أنشئ واحداً).'); return aeState; }

  // ---------- create map comp ----------
  $('btnCreate').onclick = run('إنشاء', async function () {
    var c = comp(), v = captureView();
    var zr = Math.round(v.zoom * 100) / 100;         // reference zoom for the World precomp coordinate space
    var m = G.lngLatToMerc(v.lng, v.lat), ws = G.worldSize(zr);
    var W = 4096, H = 4096;
    var job = { name: $('cname').value || 'GEO Map', comp: c, zr: zr, x0: m[0] * ws - W / 2, y0: m[1] * ws - H / 2,
      worldW: W, worldH: H, fovDeg: FOV_DEG, view: v, style: $('style').value };
    var r = await host('geoCreateMapComp', job);
    log('أُنشئ Map Comp: ' + r.split('|')[1]);
    await sleep(200);
    await poll();
    if (!aeState || String(aeState.id) !== r.split('|')[0]) { await sleep(500); await poll(); }
    log('معاينة أولية منخفضة الدقة…');
    await finalize({ preview: true });
  });

  // ---------- keyframes ----------
  $('btnKey').onclick = run('كيفريم', async function () {
    await poll(); needMap();
    await host('geoSetKeys', { keys: [Object.assign({ t: -1 }, captureView())] });
    log('◆ كيفريم عند ' + aeState.time.toFixed(2) + 's');
  });

  // animate the camera from the view at the playhead to a target view, then hold; playhead moves to the end
  async function animateTo(target) {
    await poll();
    var s = needMap();
    var dur = Math.max(0.1, parseFloat($('animDur').value) || 3), hold = Math.max(0, parseFloat($('hold').value) || 0);
    var A = stateView(s);
    if ($('keepTilt').checked) { target.bearing = A.bearing; target.pitch = A.pitch; }
    var keys = [Object.assign({ t: 0 }, A), Object.assign({ t: dur }, target)];
    if ($('animPath').value === 'fly') {
      // bake the fly arc (already eased) as linear keys every ~0.2 s
      var c = comp(), vp = Math.max(c.w, c.h), n = Math.max(4, Math.round(dur / 0.2));
      var KA = Object.assign({ t: 0 }, A), KB = Object.assign({ t: dur, ease: 'inout', path: 'fly' }, target);
      keys = [];
      for (var i = 0; i <= n; i++) {
        var t = dur * i / n, v = G.viewAt([KA, KB], t, vp), ll = G.mercToLngLat(v.mx, v.my);
        keys.push({ t: t, lat: ll[1], lng: ll[0], zoom: v.zoom, bearing: v.bearing, pitch: v.pitch, linear: true });
      }
    }
    if (hold > 0) keys.push(Object.assign({ t: dur + hold }, target));
    await host('geoSetKeys', { keys: keys, relative: true, gotoAfter: dur + hold });
    log('حركة كاميرا ' + dur + 's' + (hold ? ' + ثبات ' + hold + 's' : '') + ' — رأس التشغيل انتقل لنهايتها');
  }

  // ---------- search (Nominatim) ----------
  var nomQueue = Promise.resolve(), lastNom = 0;
  function nominatim(path) {       // policy: max 1 request / second
    nomQueue = nomQueue.then(async function () {
      var wait = 1100 - (Date.now() - lastNom);
      if (wait > 0) await sleep(wait);
      lastNom = Date.now();
    });
    return nomQueue.then(function () { return fetchJSON('https://nominatim.openstreetmap.org/' + path); });
  }
  function search() {
    var q = $('q').value.trim();
    if (!q) return;
    $('results').innerHTML = '<li>…جارٍ البحث</li>';
    nominatim('search?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0003&addressdetails=1&limit=8&accept-language=ar&q=' + encodeURIComponent(q))
      .then(showResults).catch(function (e) { $('results').innerHTML = '<li class="err">فشل البحث: ' + e.message + '</li>'; });
  }
  $('btnSearch').onclick = search;
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });

  function showResults(arr) {
    var ul = $('results'); ul.innerHTML = '';
    if (!arr.length) { ul.innerHTML = '<li>لا نتائج</li>'; return; }
    arr.forEach(function (r) {
      var li = document.createElement('li');
      var title = r.name || r.display_name.split(',')[0];
      var isCountry = r.addresstype === 'country' || (r.type === 'administrative' && r.place_rank <= 4);
      var cc = r.address && r.address.country_code ? r.address.country_code.toUpperCase() : null;
      li.innerHTML = '<div><b></b> <span class="sub"></span></div><div class="sub"></div>' +
        '<div class="fbtns"><button class="mini go">اذهب</button><button class="mini add">أضف للمتصفح</button>' +
        (isCountry && cc ? '<button class="mini prov">+ المحافظات</button><button class="mini inner">+ الحدود الداخلية</button>' : '') + '</div>';
      li.querySelector('b').textContent = title;
      li.querySelector('span.sub').textContent = '(' + (r.addresstype || r.type || r.category) + ')';
      li.querySelectorAll('div.sub')[0].textContent = r.display_name;
      li.querySelector('.go').onclick = function () { fitBBox(bboxOf(r)); };
      li.ondblclick = function () { fitBBox(bboxOf(r)); };
      li.querySelector('.add').onclick = function () {
        addFeature(title, r.geojson && r.geojson.type ? r.geojson : { type: 'Point', coordinates: [+r.lon, +r.lat] }, +r.lon, +r.lat);
      };
      if (li.querySelector('.prov')) {
        li.querySelector('.prov').onclick = run('المحافظات', function () { return addProvinces(cc, title, false); });
        li.querySelector('.inner').onclick = run('الحدود الداخلية', function () { return addProvinces(cc, title, true); });
      }
      ul.appendChild(li);
    });
  }
  function bboxOf(r) { var b = r.boundingbox.map(parseFloat); return [b[2], b[0], b[3], b[1]]; }
  function fitBBox(b) {
    if (b[0] === b[2] && b[1] === b[3]) { map.flyTo({ center: [b[0], b[1]], zoom: 12 - dz() }); return; }
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 30, duration: 800, bearing: map.getBearing(), pitch: map.getPitch() });
  }

  // ---------- provinces (Natural Earth admin-1, downloaded once and cached) ----------
  var NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
  var neCache = {};
  async function naturalEarth(file) {
    if (neCache[file]) return neCache[file];
    var txt = null, cacheFile = fs ? pathM.join(workDir('cache'), file) : null;
    if (cacheFile && fs.existsSync(cacheFile)) txt = fs.readFileSync(cacheFile, 'utf8');
    else {
      log('تحميل بيانات المحافظات (مرة واحدة فقط، ' + (file.indexOf('lines') > 0 ? '~21' : '~40') + ' MB)…');
      var r = await fetch(NE + file);
      if (!r.ok) throw new Error('Natural Earth ' + r.status);
      txt = await r.text();
      if (cacheFile) fs.writeFileSync(cacheFile, txt, 'utf8');
    }
    neCache[file] = JSON.parse(txt);
    return neCache[file];
  }
  async function addProvinces(cc, countryName, innerOnly) {
    var polys = await naturalEarth('ne_10m_admin_1_states_provinces.geojson');
    var mine = polys.features.filter(function (f) { return f.properties.iso_a2 === cc; });
    if (!mine.length) throw new Error('لا توجد محافظات لهذه الدولة في Natural Earth');
    if (innerOnly) {
      var a3 = mine[0].properties.adm0_a3;
      var lines = await naturalEarth('ne_10m_admin_1_states_provinces_lines.geojson');
      var ls = lines.features.filter(function (f) { return f.properties.adm0_a3 === a3; });
      var coords = [];
      ls.forEach(function (f) {
        if (f.geometry.type === 'LineString') coords.push(f.geometry.coordinates);
        else if (f.geometry.type === 'MultiLineString') coords = coords.concat(f.geometry.coordinates);
      });
      addFeature('الحدود الداخلية — ' + countryName, { type: 'MultiLineString', coordinates: coords }, undefined, undefined, { group: countryName, strokeW: 2 });
      log('أُضيفت الحدود الداخلية (' + coords.length + ' خط)');
      return;
    }
    mine.forEach(function (f) {
      var p = f.properties;
      addFeature(p.name_ar || p.name, f.geometry, p.longitude, p.latitude, { group: countryName, quiet: true });
    });
    renderFeatures(); drawPreviewShapes(); save();
    log('أُضيفت ' + mine.length + ' محافظة لـ ' + countryName + ' (محددة كمجموعة: اضغط «ارسم المحدد»)');
  }

  // ---------- reverse lookup: Alt + click ----------
  async function lookupAt(lngLat) {
    $('results').innerHTML = '<li>…ما الموجود هنا؟</li>';
    document.querySelector('.tabs button[data-tab=t-feat]').click();
    var levels = [3, 5, 8, 10, 14], out = [], seen = {};
    for (var i = 0; i < levels.length; i++) {
      try {
        var r = await nominatim('reverse?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0003&addressdetails=1&accept-language=ar&zoom=' + levels[i] +
          '&lat=' + lngLat.lat + '&lon=' + lngLat.lng);
        if (r && r.osm_id && !seen[r.osm_type + r.osm_id]) { seen[r.osm_type + r.osm_id] = 1; out.push(r); }
      } catch (e) {}
    }
    showResults(out);
  }

  // ---------- draw a shape on the map ----------
  var drawing = false, draft = [];
  function drawDraft() {
    if (!map.isStyleLoaded()) return;
    var fc = { type: 'FeatureCollection', features: [] };
    if (draft.length) {
      fc.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: $('drawKind').value === 'Polygon' && draft.length > 2 ? draft.concat([draft[0]]) : draft } });
      draft.forEach(function (p) { fc.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p } }); });
    }
    if (map.getSource('gm-draft')) { map.getSource('gm-draft').setData(fc); return; }
    map.addSource('gm-draft', { type: 'geojson', data: fc });
    map.addLayer({ id: 'gm-draft-l', type: 'line', source: 'gm-draft', paint: { 'line-color': '#ff3b30', 'line-width': 2, 'line-dasharray': [2, 1] } });
    map.addLayer({ id: 'gm-draft-p', type: 'circle', source: 'gm-draft', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#ff3b30', 'circle-stroke-width': 2 } });
  }
  function setDrawing(on) {
    drawing = on; draft = [];
    $('btnDraw').textContent = on ? 'إلغاء الرسم' : 'ابدأ الرسم';
    $('map').classList.toggle('drawing', on);
    if (on) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
    drawDraft();
  }
  $('btnDraw').onclick = function () { setDrawing(!drawing); };
  map.on('click', function (e) {
    if (e.originalEvent.altKey) { lookupAt(e.lngLat); return; }
    if (!drawing) return;
    draft.push([e.lngLat.lng, e.lngLat.lat]); drawDraft();
  });
  map.on('dblclick', function (e) {
    if (!drawing) return;
    e.preventDefault();
    var kind = $('drawKind').value, pts = draft.slice();
    // the dblclick also fired two clicks: drop the duplicate last point
    if (pts.length > 1) { var a = pts[pts.length - 1], b = pts[pts.length - 2]; if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop(); }
    if ((kind === 'Polygon' && pts.length < 3) || pts.length < 2) { log('نقاط غير كافية', true); return; }
    var geom = kind === 'Polygon' ? { type: 'Polygon', coordinates: [pts.concat([pts[0]])] } : { type: 'LineString', coordinates: pts };
    setDrawing(false);
    addFeature(kind === 'Polygon' ? 'منطقة مرسومة' : 'مسار مرسوم', geom);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && drawing) setDrawing(false); });

  // ---------- feature browser ----------
  var COLORS = ['#ffd400', '#ff3b30', '#33c1ff', '#4cd964', '#ff9500', '#ffffff', '#c86bff'];
  function addFeature(name, geom, lng, lat, opt) {
    opt = opt || {};
    var bb = G.geomBBox(geom);
    if (lng === undefined || lng === null || isNaN(lng)) { lng = (bb[0] + bb[2]) / 2; lat = (bb[1] + bb[3]) / 2; }
    var isArea = /Polygon/.test(geom.type), isPoint = geom.type === 'Point';
    state.features.push({
      id: 'f' + Date.now() + Math.random().toString(36).slice(2, 6), name: name, geom: geom, lng: lng, lat: lat, bbox: bb,
      color: COLORS[state.features.length % COLORS.length], labelColor: '#ffffff', strokeW: opt.strokeW || (isPoint ? 0 : 4),
      fillOpacity: isArea ? 15 : 0, drawDur: 2, labelSize: 56, glow: false, dash: false, blend: 'NORMAL', opacity: 100,
      sel: !!opt.group, group: opt.group || ''
    });
    if (opt.quiet) return;
    renderFeatures(); drawPreviewShapes(); save();
    if (!isPoint) fitBBox(bb);
  }

  function renderFeatures() {
    var ul = $('features'); ul.innerHTML = '';
    if (state.features.length) {
      var top = document.createElement('li');
      top.innerHTML = '<div class="fbtns"><button class="mini dsel">ارسم المحدد</button><button class="mini lsel">أسماء للمحدد</button>' +
        '<button class="mini asel">تحديد الكل</button><button class="mini nsel">إلغاء التحديد</button><button class="mini xsel">حذف المحدد</button></div>';
      top.querySelector('.dsel').onclick = run('رسم', function () { return drawFeatures(selected().filter(function (f) { return f.geom.type !== 'Point'; })); });
      top.querySelector('.lsel').onclick = run('اسم', function () { return addLabels(selected()); });
      top.querySelector('.asel').onclick = function () { state.features.forEach(function (f) { f.sel = true; }); renderFeatures(); save(); };
      top.querySelector('.nsel').onclick = function () { state.features.forEach(function (f) { f.sel = false; }); renderFeatures(); save(); };
      top.querySelector('.xsel').onclick = function () { state.features = state.features.filter(function (f) { return !f.sel; }); renderFeatures(); drawPreviewShapes(); save(); };
      ul.appendChild(top);
    }
    state.features.forEach(function (f, i) {
      var isPoint = f.geom.type === 'Point', isArea = /Polygon/.test(f.geom.type) || f.geom.type === 'GeometryCollection';
      var li = document.createElement('li');
      li.innerHTML =
        '<div class="feat"><input type="checkbox" class="sel" title="تحديد"><input type="color" class="col" title="لون الحدود"><input type="text" class="nm">' +
        '<button class="mini del" title="حذف">×</button></div>' +
        (f.group ? '<div class="group">' + escapeHtml(f.group) + '</div>' : '') +
        '<div class="sopts">' +
        (isPoint ? '' : '<label>السمك<input type="number" class="w" step="0.5"></label>') +
        (isArea ? '<label>تعبئة %<input type="number" class="fo" min="0" max="100"></label>' : '') +
        (isPoint ? '' : '<label>مدة الرسم<input type="number" class="dd" step="0.1"></label>') +
        '<label>حجم الاسم<input type="number" class="ls"></label>' +
        '<label>لون الاسم<input type="color" class="lc"></label>' +
        (isPoint ? '' : '<label>الدمج<select class="bl"><option value="NORMAL">Normal</option><option value="SCREEN">Screen</option>' +
          '<option value="MULTIPLY">Multiply</option><option value="ADD">Add</option><option value="OVERLAY">Overlay</option><option value="SOFT_LIGHT">Soft Light</option></select></label>' +
          '<label>الشفافية %<input type="number" class="op" min="0" max="100"></label>') +
        '</div><div class="fbtns">' +
        (isPoint ? '' : '<label class="check"><input type="checkbox" class="gl"> توهج</label><label class="check"><input type="checkbox" class="da"> متقطع</label>') +
        '</div><div class="fbtns">' +
        '<button class="mini fit">اذهب</button>' +
        (isPoint ? '' : '<button class="mini draw">ارسم في AE</button>') +
        '<button class="mini lab">أضف اسم</button>' +
        '<button class="mini anim">حرّك الكاميرا إليه</button></div>';
      var q = function (c) { return li.querySelector(c); };
      q('.sel').checked = !!f.sel; q('.col').value = f.color; q('.nm').value = f.name; q('.ls').value = f.labelSize;
      q('.lc').value = f.labelColor || '#ffffff';
      if (q('.w')) q('.w').value = f.strokeW;
      if (q('.fo')) q('.fo').value = f.fillOpacity;
      if (q('.dd')) q('.dd').value = f.drawDur;
      if (q('.gl')) q('.gl').checked = f.glow;
      if (q('.da')) q('.da').checked = f.dash;
      if (q('.bl')) q('.bl').value = f.blend || 'NORMAL';
      if (q('.op')) q('.op').value = f.opacity === undefined ? 100 : f.opacity;
      li.addEventListener('change', function () {
        f.sel = q('.sel').checked; f.color = q('.col').value; f.name = q('.nm').value;
        f.labelSize = parseFloat(q('.ls').value) || 56; f.labelColor = q('.lc').value;
        if (q('.w')) f.strokeW = parseFloat(q('.w').value) || 4;
        if (q('.fo')) f.fillOpacity = Math.max(0, Math.min(100, parseFloat(q('.fo').value) || 0));
        if (q('.dd')) f.drawDur = Math.max(0, parseFloat(q('.dd').value) || 0);
        if (q('.gl')) f.glow = q('.gl').checked;
        if (q('.da')) f.dash = q('.da').checked;
        if (q('.bl')) f.blend = q('.bl').value;
        if (q('.op')) f.opacity = Math.max(0, Math.min(100, parseFloat(q('.op').value)));
        drawPreviewShapes(); fillArrowSelects(); save();
      });
      q('.del').onclick = function () { state.features.splice(i, 1); renderFeatures(); drawPreviewShapes(); save(); };
      q('.fit').onclick = function () { fitBBox(f.bbox); };
      li.querySelector('.nm').ondblclick = function () { fitBBox(f.bbox); };
      if (q('.draw')) q('.draw').onclick = run('رسم', function () { return drawFeatures([f]); });
      q('.lab').onclick = run('اسم', function () { return addLabels([f]); });
      q('.anim').onclick = run('حركة', function () { return animateTo(Object.assign({ bearing: 0, pitch: 0 }, G.fitZoom(f.bbox, comp(), 0.12))); });
      ul.appendChild(li);
    });
    fillArrowSelects();
  }
  function selected() { return state.features.filter(function (f) { return f.sel; }); }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fillArrowSelects() {
    ['arFrom', 'arTo'].forEach(function (id, k) {
      var sel = $(id), cur = sel.value;
      sel.innerHTML = '';
      state.features.forEach(function (f) { var o = document.createElement('option'); o.value = f.id; o.textContent = f.name; sel.appendChild(o); });
      if (cur && state.features.some(function (f) { return f.id === cur; })) sel.value = cur;
      else if (state.features[k]) sel.value = state.features[k].id;
    });
  }

  // file import / export
  $('fileIn').onchange = function () {
    Array.prototype.forEach.call(this.files, function (file) {
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var items = GI.parseFile(file.name, rd.result);
          items.forEach(function (it) { addFeature(it.name, it.geom, undefined, undefined, { quiet: true, group: items.length > 1 ? file.name : '' }); });
          renderFeatures(); drawPreviewShapes(); save();
          log('استيراد ' + file.name + ': ' + items.length + ' معلم');
        } catch (e) { log('استيراد ' + file.name + ': ' + e.message, true); }
      };
      rd.readAsText(file);
    });
    this.value = '';
  };
  $('btnExport').onclick = function () {
    var list = selected().length ? selected() : state.features;
    var fc = { type: 'FeatureCollection', features: list.map(function (f) { return { type: 'Feature', properties: { name: f.name, color: f.color }, geometry: f.geom }; }) };
    var txt = JSON.stringify(fc);
    if (fs) {
      var p = pathM.join(workDir('export'), 'features_' + Date.now() + '.geojson');
      fs.writeFileSync(p, txt, 'utf8'); log('صُدّرت ' + list.length + ' معالم إلى ' + p);
    } else {
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'application/geo+json' }));
      a.download = 'features.geojson'; a.click();
    }
  };

  // ---------- preview layers for features ----------
  function shapeCollections(t) {
    var lines = { type: 'FeatureCollection', features: [] }, fills = { type: 'FeatureCollection', features: [] },
        dots = { type: 'FeatureCollection', features: [] };
    state.features.forEach(function (f) {
      if (f.geom.type === 'Point') { dots.features.push({ type: 'Feature', geometry: f.geom, properties: { c: f.color } }); return; }
      var g = f.geom, fo = f.fillOpacity / 100;
      if (t !== undefined) {
        if (f.drawStart === undefined) return;              // only features drawn into this comp are baked into 3D frames
        if (f.drawDur > 0) {
          var u = (t - f.drawStart) / f.drawDur;
          g = G.trimGeometry(f.geom, G.EASE.inout(Math.max(0, Math.min(1, u))));
          fo *= Math.max(0, Math.min(1, (t - f.drawStart - f.drawDur) / 0.6));
        }
      }
      lines.features.push({ type: 'Feature', geometry: g, properties: { c: f.color, w: f.strokeW } });
      if (/Polygon/.test(f.geom.type)) fills.features.push({ type: 'Feature', geometry: f.geom, properties: { c: f.color, fo: fo } });
    });
    return { lines: lines, fills: fills, dots: dots };
  }
  function ensureShapeLayers(m, widthScale) {
    if (m.getSource('gm-lines')) return;
    var empty = { type: 'FeatureCollection', features: [] };
    m.addSource('gm-lines', { type: 'geojson', data: empty });
    m.addSource('gm-fills', { type: 'geojson', data: empty });
    m.addSource('gm-dots', { type: 'geojson', data: empty });
    m.addLayer({ id: 'gm-fill', type: 'fill', source: 'gm-fills', paint: { 'fill-color': ['get', 'c'], 'fill-opacity': ['get', 'fo'] } });
    m.addLayer({ id: 'gm-line', type: 'line', source: 'gm-lines', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'c'], 'line-width': ['*', ['get', 'w'], widthScale] } });
    m.addLayer({ id: 'gm-dot', type: 'circle', source: 'gm-dots',
      paint: { 'circle-color': ['get', 'c'], 'circle-radius': 5, 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
  }
  function setShapeData(m, t, onlyLines) {
    var c = shapeCollections(t);
    m.getSource('gm-lines').setData(c.lines);
    m.getSource('gm-fills').setData(c.fills);
    m.getSource('gm-dots').setData(onlyLines ? { type: 'FeatureCollection', features: [] } : c.dots);
  }
  function drawPreviewShapes() {
    if (!map.isStyleLoaded()) return;
    ensureShapeLayers(map, $('map').clientWidth / comp().w);
    setShapeData(map);
  }

  // ---------- draw features / labels / arrows / pins into AE ----------
  function refSpace(s) { return { zb: s.zr, x0: s.x0, y0: s.y0 }; }
  function featurePaths(f, s) {
    // keep the closest zoom clean: tolerance 0.35 screen px at (feature fit zoom + 2), vertex budget 30k
    var targetZ = Math.max(s.zoom, G.fitZoom(f.bbox, comp(), 0.1).zoom) + 2;
    var k = Math.pow(2, s.zr - targetZ), tol = 0.35 * k, minA = Math.pow(3 * k, 2), paths = [];
    for (var tries = 0; tries < 10; tries++) {
      paths = G.geometryToPaths(f.geom, refSpace(s), tol, minA);
      var nv = paths.reduce(function (a, p) { return a + p.v.length; }, 0);
      if (nv < 30000) break;
      tol *= 2; minA *= 2;
    }
    return paths;
  }
  async function drawFeatures(list) {
    await poll();
    var s = needMap();
    if (!list.length) throw new Error('لم تحدد معالم');
    var shapes = list.map(function (f) {
      return { name: f.name, paths: featurePaths(f, s), stroke: hexToRgb(f.color), strokeW: f.strokeW, fill: hexToRgb(f.color),
        fillOpacity: f.fillOpacity, drawStart: 0, drawEnd: f.drawDur, glow: f.glow, dash: f.dash, blend: f.blend || 'NORMAL',
        opacity: f.opacity === undefined ? 100 : f.opacity };
    }).filter(function (x) { return x.paths.length; });
    var r = await host('geoAddShapes', { shapes: shapes, relative: true });
    list.forEach(function (f) { f.drawStart = s.time; });
    save();
    log('رُسم ' + r + ' معلم عند ' + s.time.toFixed(2) + 's (داخل كومب «' + s.name + ' World»)');
  }
  async function addLabels(list) {
    await poll(); needMap();
    if (!list.length) throw new Error('لم تحدد معالم');
    var labels = list.map(function (f) {
      return { text: f.name, lat: f.lat, lng: f.lng, size: f.labelSize, color: hexToRgb(f.labelColor || '#ffffff'),
        dotColor: hexToRgb(f.color), appear: 0, font: FONT, dot: f.geom.type === 'Point' };
    });
    var r = await host('geoAddLabels', { labels: labels, relative: true });
    log('أُضيف ' + r + ' اسم مثبت على الخريطة');
  }
  $('btnArrow').onclick = run('سهم', async function () {
    await poll();
    var s = needMap();
    var A = state.features.filter(function (f) { return f.id === $('arFrom').value; })[0];
    var B = state.features.filter(function (f) { return f.id === $('arTo').value; })[0];
    if (!A || !B || A === B) throw new Error('اختر مكانين مختلفين (أضفهما للمتصفح أولاً)');
    var ma = G.lngLatToMerc(A.lng, A.lat), mb = G.lngLatToMerc(B.lng, B.lat);
    var pa = G.mercToWorldPx(refSpace(s), ma[0], ma[1]), pb = G.mercToWorldPx(refSpace(s), mb[0], mb[1]);
    var dur = Math.max(0.1, parseFloat($('animDur').value) || 3);
    var shape = { name: 'سهم ' + A.name + ' ← ' + B.name, paths: [G.arcPath(pa, pb, parseFloat($('arBend').value) || 0)],
      stroke: hexToRgb($('arColor').value), strokeW: parseFloat($('arW').value) || 6, fill: [0, 0, 0], fillOpacity: 0,
      drawStart: 0, drawEnd: dur, dash: $('arDash').checked, arrowHead: true };
    await host('geoAddShapes', { shapes: [shape], relative: true });
    log('سهم ' + A.name + ' ← ' + B.name);
  });
  // pin the selected AE layers where they currently sit: comp px -> lat/lon through the linked preview
  $('btnPin').onclick = run('تثبيت', async function () {
    await poll();
    var s = needMap();
    var r = await evalScript('geoSelectedInfo()');
    if (r.indexOf('OK|') !== 0) throw new Error(r.replace(/^ERR\|/, ''));
    var info = JSON.parse(r.slice(3));
    if (!info.layers.length) throw new Error('حدّد في AE الطبقات التي تريد تثبيتها.');
    jumpToState(s);                                     // preview == AE frame right now
    var k = $('map').clientWidth / s.w;
    var layers = info.layers.map(function (L) {
      var ll = map.unproject([L.x * k, L.y * k]);
      return { index: L.index, lat: ll.lat, lng: ll.lng, scaleWithMap: L.media };
    });
    var res = await host('geoPinLayers', { compId: info.compId, zoom: s.zoom, layers: layers });
    log('ثُبّتت ' + res + ' طبقة في أماكنها على الخريطة');
  });

  // ---------- off-screen rendering ----------
  function makeOffscreen(spec, w, h, view) {
    var div = document.createElement('div');
    div.style.cssText = 'position:absolute;left:-40000px;top:0;width:' + w + 'px;height:' + h + 'px;';
    document.body.appendChild(div);
    var m = new maplibregl.Map({
      container: div, style: spec, center: view.center, zoom: view.zoom, bearing: view.bearing || 0, pitch: view.pitch || 0,
      maxPitch: 85, interactive: false, attributionControl: false, preserveDrawingBuffer: true, pixelRatio: 1,
      fadeDuration: 0, renderWorldCopies: false, maxCanvasSize: [16384, 16384]
    });
    m._gmDiv = div;
    return m;
  }
  function destroyOffscreen(m) { try { m.remove(); } catch (e) {} try { m._gmDiv.remove(); } catch (e) {} }
  function waitIdle(m, ms) {
    return new Promise(function (res, rej) {
      var timer = setTimeout(function () { rej(new Error('انتهت المهلة أثناء تحميل البلاطات')); }, ms || 120000);
      m.once('idle', function () { clearTimeout(timer); res(); });
      m.triggerRepaint();
    });
  }
  function waitLoad(m) {
    return new Promise(function (res, rej) {
      var timer = setTimeout(function () { rej(new Error('انتهت مهلة تحميل النمط')); }, 60000);
      m.once('load', function () { clearTimeout(timer); res(); });
      m.on('error', function (e) { if (e && e.error && /WebGL|context/i.test(String(e.error.message))) { clearTimeout(timer); rej(e.error); } });
    });
  }
  // the GPU may give a smaller drawing buffer than asked for: check, so plates are never silently cropped
  var gpuMax = null;
  function gpuLimit() {
    if (gpuMax) return gpuMax;
    try {
      var gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
      gpuMax = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
    } catch (e) { gpuMax = 4096; }
    return gpuMax;
  }
  async function canvasToFile(m, dir, name) {
    var cv = m.getCanvas();
    var gl = cv.getContext('webgl2') || cv.getContext('webgl');
    if (gl && (gl.drawingBufferWidth !== cv.width || gl.drawingBufferHeight !== cv.height)) {
      throw new Error('حد كرت الشاشة ' + gl.drawingBufferWidth + '×' + gl.drawingBufferHeight + ' — اختر دقة أقل');
    }
    var blob = await new Promise(function (r) { cv.toBlob(r, 'image/png'); });
    if (!blob || !blob.size) throw new Error('فشل ترميز PNG');
    var p = pathM.join(dir, name);
    fs.writeFileSync(p, BufferC.from(await blob.arrayBuffer()));
    return { file: p.replace(/\\/g, '/'), w: cv.width, h: cv.height };
  }
  async function renderPlate(spec, look, center, zoom, w, h, dir, name) {
    var m = makeOffscreen(spec, w, h, { center: center, zoom: zoom });
    try {
      await waitLoad(m);
      applyLook(m, look, { flat: true });
      await waitIdle(m);
      await sleep(150);
      return await canvasToFile(m, dir, name);
    } finally { destroyOffscreen(m); }
  }

  // ---------- Finalize ----------
  $('btnFinalize').onclick = run('Finalize', function () { return finalize({}); });

  async function finalize(opt) {
    await poll();
    needMap();
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var dir = workDir((aeState.name || 'GEO').replace(/[\\\/:*?"<>|]/g, '_') + '_' + stamp);
    var samplePath = pathM.join(dir, 'camera.json');
    var r = await evalScript('geoSample("' + samplePath.replace(/\\/g, '/') + '")');
    if (r.indexOf('OK|') !== 0) throw new Error(r.replace(/^ERR\|/, ''));
    var S = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    var c = { w: S.w, h: S.h, fps: S.fps, duration: S.duration };
    var look = getLook(), spec = await getStyleSpec(look.style);
    var space = { zb: S.zr, x0: S.x0, y0: S.y0 };
    var mode = opt.preview ? 'layers' : $('outMode').value;
    log((opt.preview ? 'معاينة' : 'Finalize') + ': ' + S.frames.length + ' إطار · ' + dir);

    if (mode === 'frames3d') return finalize3D(S, c, look, spec, dir);

    var limit = Math.min(opt.preview ? 2048 : parseInt($('quality').value, 10), gpuLimit());
    var views = S.frames.map(function (f) { return { mx: f[0], my: f[1], zoom: f[2], pitch: f[4] }; });
    if (views.some(function (v) { return v.pitch > 70; })) log('تنبيه: ميل فوق 70° يُظهر الأفق؛ استخدم «إطارات 3D» لسماء حقيقية.', true);
    var plan = G.planFromViews(views, c, limit);
    log('صورة الأساس: zoom ' + plan.zb.toFixed(2) + ' · ' + plan.w + '×' + plan.h + ' px');
    var baseLL = G.mercToLngLat(plan.centerMerc[0], plan.centerMerc[1]);
    var img = await renderPlate(spec, look, baseLL, plan.zb, plan.w, plan.h, dir, 'base.png');
    var bp = G.mercToWorldPx(space, plan.centerMerc[0], plan.centerMerc[1]);
    var plates = [{ file: img.file, x: bp[0], y: bp[1], w: plan.w, scale: 100 * Math.pow(2, S.zr - plan.zb), zoom: plan.zb, isBase: true }];

    if (!opt.preview && $('details').checked) {
      var done = [];
      for (var i = 0; i < S.keys.length; i++) {
        var k = { lng: S.keys[i][0], lat: S.keys[i][1], zoom: S.keys[i][2], pitch: S.keys[i][3] };
        if (k.zoom < plan.zb + 1.5) continue;
        if (done.some(function (d) { return Math.abs(d.zoom - k.zoom) < 0.5 && Math.abs(d.lng - k.lng) < 1e-3 && Math.abs(d.lat - k.lat) < 1e-3; })) continue;
        done.push(k);
        var grow = 1.8 * (1 + Math.min(k.pitch, 60) / 40);
        var dw = Math.min(limit, Math.ceil(c.w * grow)), dh = Math.min(limit, Math.ceil(c.h * grow));
        log('صورة تفصيلية ' + done.length + ' (zoom ' + k.zoom.toFixed(2) + ')…');
        var di = await renderPlate(spec, look, [k.lng, k.lat], k.zoom, dw, dh, dir, 'detail_' + done.length + '.png');
        var km = G.lngLatToMerc(k.lng, k.lat), kp = G.mercToWorldPx(space, km[0], km[1]);
        plates.push({ file: di.file, x: kp[0], y: kp[1], w: dw, scale: 100 * Math.pow(2, S.zr - k.zoom), zoom: k.zoom, isBase: false });
      }
    }
    plates = [plates[0]].concat(plates.slice(1).sort(function (a, b) { return a.zoom - b.zoom; }));
    var res = await host('geoFinalize', { compId: S.compId, style: look.style, plates: plates, seq: null }, dir);
    log('تم ✔ ' + res);
  }

  // every frame rendered from the AE camera in real 3D (terrain, buildings), as an image sequence under GEO World
  async function finalize3D(S, c, look, spec, dir) {
    if (Math.max(c.w, c.h) > gpuLimit()) throw new Error('حجم الكومب أكبر من حد كرت الشاشة');
    var f0 = S.frames[0];
    var m = makeOffscreen(spec, c.w, c.h, { center: G.mercToLngLat(f0[0], f0[1]), zoom: f0[2], bearing: f0[3], pitch: f0[4] });
    var framesDir = pathM.join(dir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
    var first = null, t0 = performance.now(), bake = $('bakeBorders').checked;
    try {
      await waitLoad(m);
      applyLook(m, look);
      if (bake) ensureShapeLayers(m, 1);
      log('تصوير ' + S.frames.length + ' إطار 3D…');
      for (var f = 0; f < S.frames.length; f++) {
        var v = S.frames[f], t = f / c.fps;
        m.jumpTo({ center: G.mercToLngLat(v[0], v[1]), zoom: v[2], bearing: v[3], pitch: v[4] });
        if (bake) setShapeData(m, t, true);
        await waitIdle(m, 60000);
        var out = await canvasToFile(m, framesDir, 'frame_' + ('00000' + f).slice(-5) + '.png');
        if (!first) first = out.file;
        if (f % 10 === 0 || f === S.frames.length - 1) {
          var el = (performance.now() - t0) / 1000;
          log('إطار ' + f + '/' + (S.frames.length - 1) + ' (~' + Math.round(el / (f + 1) * (S.frames.length - 1 - f)) + 's متبقية)');
        }
      }
    } finally { destroyOffscreen(m); }
    var res = await host('geoFinalize', { compId: S.compId, style: look.style, plates: [], seq: { first: first, count: S.frames.length } }, dir);
    log('تم ✔ ' + res + (bake ? ' — الحدود مرسومة داخل الإطارات؛ أطفئ طبقات الحدود المكررة في كومب World إن وُجدت.' : ''));
  }

  // ---------- init ----------
  renderFeatures(); hud(); updateHints(); $('curStyle').textContent = styleName();
  if (inCEP) evalScript('geoPing()').then(function (r) { log('After Effects ' + String(r).replace('OK|', '')); });
  else log('وضع معاينة المتصفح: أوامر AE تعمل فقط داخل After Effects');
})();
