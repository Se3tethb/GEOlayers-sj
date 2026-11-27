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
    'animDur', 'animPath', 'hold', 'keepTilt', 'arColor', 'arW', 'arBend', 'arDash', 'drawKind',
    'circleKm', 'lblStyle', 'lblMarker', 'lblBox', 'moveType', 'moveAmt', 'moveDur', 'moveEase', 'vShake',
    'colBound', 'colLabel', 'climate', 'climateDate', 'climateOp', 'pickLevel', 'citiesMax', 'citiesTowns', 'routeMode',
    'choroLow', 'choroHigh', 'choroFill', 'pathDur', 'pathOrient', 'waterMask',
    'tintOn', 'tintDark', 'tintLight', 'tintAmt', 'rgFill', 'rgFillOp', 'rgStroke', 'rgStrokeW', 'rgPattern', 'rgStripe', 'rgAnim',
    'rgDur', 'rgBlend', 'rgGlow', 'rgShadow', 'rgNames', 'lblText', 'lblMarkColor', 'lblFont', 'lblFontCustom', 'imgPath', 'imgSize',
    'imgScale', 'imgShadow', 'arStyle', 'freeCam'];
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
    'esri-light': { tiles: ESRI('Canvas/World_Light_Gray_Base'), max: 16, attr: '© Esri' },
    'esri-terrain': { tiles: ESRI('World_Terrain_Base'), max: 13, attr: '© Esri, USGS, NOAA' },
    opentopo: { tiles: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', max: 17,
      attr: 'Map data © OpenStreetMap contributors, SRTM | Style © OpenTopoMap (CC-BY-SA)' },
    nightlights: { tiles: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
      max: 8, attr: 'NASA Earth Observatory / GIBS — Black Marble' }
  };
  // NASA GIBS daily layers (free, no key) + RainViewer radar
  var GIBS = function (layer, ext, level) {
    return 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' + layer + '/default/{date}/GoogleMapsCompatible_Level' + level + '/{z}/{y}/{x}.' + ext;
  };
  var CLIMATE = {
    clouds: { url: GIBS('MODIS_Terra_CorrectedReflectance_TrueColor', 'jpg', 9), max: 9, attr: 'NASA GIBS — MODIS Terra' },
    temp: { url: GIBS('MODIS_Terra_Land_Surface_Temp_Day', 'png', 7), max: 7, attr: 'NASA GIBS — MODIS Land Surface Temperature' },
    precip: { url: GIBS('IMERG_Precipitation_Rate', 'png', 6), max: 6, attr: 'NASA GIBS — GPM IMERG' },
    snow: { url: GIBS('MODIS_Terra_NDSI_Snow_Cover', 'png', 8), max: 8, attr: 'NASA GIBS — MODIS Snow Cover' },
    night: { url: GIBS('VIIRS_Black_Marble', 'png', 8).replace('{date}', '2016-01-01'), max: 8, attr: 'NASA Black Marble' },
    radar: { url: null, max: 7, attr: 'RainViewer' }
  };
  var radarUrl = null;
  function refreshRadar() {
    return fetchJSON('https://api.rainviewer.com/public/weather-maps.json').then(function (j) {
      var past = j.radar && j.radar.past; if (!past || !past.length) throw new Error('no radar frames');
      radarUrl = j.host + past[past.length - 1].path + '/256/{z}/{x}/{y}/2/1_1.png';
    });
  }
  // full-map palettes (every fill, not just borders); mono = landcover/parks/buildings take the land colour too
  var PRESETS = {
    tactical: { base: 'dark', land: '#07110d', water: '#041c1f', roads: '#173d2e', bound: '#39ff88', label: '#9dffcf' },
    white: { base: 'positron', mono: true, land: '#ffffff', water: '#eef1f4', roads: '#e3e3e3', bound: '#b9b9b9', label: '#5c5c5c' },
    black: { base: 'dark', mono: true, land: '#3a3d41', water: '#24272b', roads: '#46494e', bound: '#6c7076', label: '#d4d4d4' },
    // news looks from the reference images
    ajwhite: { base: 'positron', mono: true, land: '#f1f1f1', water: '#1b3a5c', roads: '#e2e2e2', bound: '#b0b0b0', label: '#3c3c3c' },
    ajgrey: { base: 'positron', mono: true, land: '#c6cacf', water: '#24507e', roads: '#b7bbc0', bound: '#ffffff', label: '#2d2d2d' },
    charcoal: { base: 'dark', mono: true, land: '#4a4d52', water: '#2c2f33', roads: '#55595e', bound: '#7b7f85', label: '#e0e0e0' }
  };
  // raster base + vector water / coast / borders / names on top
  var COMPOSITE = {
    ajrelief: { raster: 'esri-terrain', paint: { 'raster-contrast': 0.35, 'raster-brightness-max': 0.92 }, tint: '#b48f58', tintOp: 0.55, water: '#1b3a5c', waterOp: 1, glow: false, bound: '#ffffff' },
    ajdarksat: { raster: 'satellite', paint: { 'raster-brightness-max': 0.5, 'raster-saturation': -0.35, 'raster-contrast': 0.1 },
      water: '#0b1a2b', waterOp: 0.6, glow: true, bound: '#ffffff' },
    ajgreysat: { raster: 'satellite', paint: { 'raster-saturation': -1, 'raster-brightness-max': 0.8 }, water: '#1d2a38', waterOp: 0.35, glow: false, bound: '#ffffff' }
  };
  var DEM_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
  var styleCache = {};

  function fetchJSON(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }); }

  function getStyleSpec(v) {
    if (v !== 'custom' && styleCache[v]) return Promise.resolve(JSON.parse(JSON.stringify(styleCache[v])));
    var p;
    if (COMPOSITE[v]) {
      var C = COMPOSITE[v], R0 = RASTER[C.raster];
      p = fetchJSON(OFM + '/styles/liberty').then(function (lib) {
        var layers = [{ id: 'gm-raster', type: 'raster', source: 'gm-raster', paint: C.paint }];
        // warm tint over a pale relief: the shading still shows through (reference: beige terrain + navy sea)
        if (C.tint) layers.push({ id: 'gm-tint', type: 'background', paint: { 'background-color': C.tint, 'background-opacity': C.tintOp } });
        layers.push({ id: 'gm-water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
          paint: { 'fill-color': C.water, 'fill-opacity': C.waterOp } });
        if (C.glow) {    // glowing white coastline (reference: dark satellite maps)
          layers.push({ id: 'gm-coast-glow', type: 'line', source: 'openmaptiles', 'source-layer': 'water',
            paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-blur': 6, 'line-opacity': 0.55 } });
          layers.push({ id: 'gm-coast', type: 'line', source: 'openmaptiles', 'source-layer': 'water',
            paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-opacity': 0.95 } });
        }
        lib.layers.forEach(function (l) {
          var sl = l['source-layer'];
          if (sl === 'boundary' && l.type === 'line') { l.paint = Object.assign({}, l.paint, { 'line-color': C.bound }); layers.push(l); }
          if (sl === 'waterway' && l.type === 'line') { l.paint = Object.assign({}, l.paint, { 'line-color': C.water }); layers.push(l); }
          if ((sl === 'place' || sl === 'water_name') && l.type === 'symbol') {
            l.paint = Object.assign({}, l.paint, { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.45)', 'text-halo-width': 1, 'text-halo-blur': 1 });
            layers.push(l);
          }
        });
        return { version: 8, glyphs: lib.glyphs, sprite: lib.sprite,
          sources: { 'gm-raster': { type: 'raster', tiles: [R0.tiles], tileSize: 256, maxzoom: R0.max, attribution: R0.attr },
                     openmaptiles: lib.sources.openmaptiles }, layers: layers };
      });
    } else if (RASTER[v] || v === 'hybrid' || v === 'custom') {
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
    } else p = fetchJSON(OFM + '/styles/' + (PRESETS[v] ? PRESETS[v].base : v));
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

  function presetCol(k, id) {
    var pr = PRESETS[$('style').value];
    return pr && !$('customColors').checked ? pr[k] : $(id).value;
  }
  function getLook() {
    return {
      style: $('style').value, lang: $('labels').value, groups: groups(),
      custom: $('customColors').checked || !!PRESETS[$('style').value],
      mono: !!(PRESETS[$('style').value] && PRESETS[$('style').value].mono),
      land: presetCol('land', 'colLand'), water: presetCol('water', 'colWater'), roads: presetCol('roads', 'colRoads'),
      bound: presetCol('bound', 'colBound'), label: presetCol('label', 'colLabel'),
      climate: $('climate').value, climateDate: $('climateDate').value, climateOp: Math.max(0, Math.min(100, parseFloat($('climateOp').value) || 75)) / 100,
      terrain: $('terrain').checked, exag: Math.max(0.1, parseFloat($('exag').value) || 1.5),
      hillshade: $('hillshade').checked, buildings3d: $('buildings3d').checked, sky: $('sky').checked
    };
  }
  var DARK_STYLES = { dark: 1, fiord: 1, satellite: 1, hybrid: 1, sentinel: 1, 'esri-dark': 1, tactical: 1, nightlights: 1, black: 1,
    charcoal: 1, ajdarksat: 1, ajgreysat: 1 };

  function applyLook(m, L, opts) {
    opts = opts || {};
    var style = m.getStyle();
    if (!style) return;
    if (L.waterMask) {                       // white water on a transparent background, nothing else
      style.layers.forEach(function (l) {
        var sl = l['source-layer'], keep = (sl === 'water' && l.type === 'fill') || (sl === 'waterway' && l.type === 'line');
        if (l.type === 'background') { m.setPaintProperty(l.id, 'background-opacity', 0); return; }
        m.setLayoutProperty(l.id, 'visibility', keep ? 'visible' : 'none');
        if (keep && l.type === 'fill') { m.setPaintProperty(l.id, 'fill-color', '#ffffff'); m.setPaintProperty(l.id, 'fill-opacity', 1); }
        if (keep && l.type === 'line') m.setPaintProperty(l.id, 'line-color', '#ffffff');
      });
      return;
    }
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
        if (sl === 'boundary' && l.type === 'line') m.setPaintProperty(l.id, 'line-color', L.bound);
        if (l.type === 'symbol' && l.layout && l.layout['text-field']) {
          m.setPaintProperty(l.id, 'text-color', L.label);
          m.setPaintProperty(l.id, 'text-halo-color', L.land);
        }
        if ((sl === 'landcover' || sl === 'landuse' || sl === 'park') && l.type === 'fill') m.setPaintProperty(l.id, 'fill-opacity', L.mono ? 1 : 0.25);
        if (L.mono) {
          if (l.type === 'fill' && sl !== 'water') { m.setPaintProperty(l.id, 'fill-color', L.land); try { m.setPaintProperty(l.id, 'fill-outline-color', L.land); } catch (e) {} }
          if (l.type === 'fill-extrusion') m.setPaintProperty(l.id, 'fill-extrusion-color', L.land);
          if (l.type === 'raster') m.setLayoutProperty(l.id, 'visibility', 'none');          // shaded relief would tint the map
          if (l.type === 'line' && sl !== 'boundary' && sl !== 'transportation' && sl !== 'waterway') m.setPaintProperty(l.id, 'line-color', L.roads);
          if (l.type === 'symbol' && l.layout && l.layout['icon-image']) m.setLayoutProperty(l.id, 'icon-image', '');
        }
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

    applyClimate(m, L, firstSymbol);

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
    getStyleSpec($("style").value).then(function (spec) { map.setStyle(spec, { diff: false }); })
      .catch(function (e) { log('النمط: ' + e.message, true); });
  }
  map.on('style.load', function () { applyLook(map, getLook()); drawPreviewShapes(); drawDraft(); });
  setStyle();
  // isStyleLoaded() is false while tiles are still loading: apply now if possible, otherwise once the map settles
  function relook() {
    var apply = function () { try { applyLook(map, getLook()); } catch (e) { log('الطبقات: ' + e.message, true); } };
    if (map.isStyleLoaded()) apply(); else map.once('idle', apply);
    save();
  }
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
  $('outMode').addEventListener('change', moveHint);
  ['outMode', 'bakeBorders', 'quality', 'details', 'animDur', 'animPath', 'hold', 'keepTilt', 'arColor', 'arW', 'arBend', 'arDash',
    'link', 'autoKey', 'cname', 'fps', 'dur', 'drawKind', 'circleKm', 'lblStyle', 'lblMarker', 'lblBox', 'moveAmt', 'moveDur',
    'moveEase', 'vShake']
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
    return { lat: c.lat, lng: c.lng, zoom: map.getZoom() + dz(), bearing: map.getBearing(), pitch: map.getPitch(), roll: curRoll };
  }
  // Roll (horizon tilt) is not a MapLibre camera axis: preview it by rotating the map element
  var curRoll = 0;
  function setRoll(r) {
    curRoll = Math.max(-45, Math.min(45, parseFloat(r) || 0));
    $('map').style.transform = curRoll ? 'rotate(' + (-curRoll) + 'deg)' : '';
    if (document.activeElement !== $('vRoll')) $('vRoll').value = Math.round(curRoll * 10) / 10;
  }
  function syncFields() {
    var c = map.getCenter(), f = { vLat: c.lat.toFixed(5), vLng: c.lng.toFixed(5), vZoom: (map.getZoom() + dz()).toFixed(2),
      vBearing: map.getBearing().toFixed(1), vPitch: map.getPitch().toFixed(1) };
    Object.keys(f).forEach(function (id) { if (document.activeElement !== $(id)) $(id).value = f[id]; });
  }
  map.on('move', syncFields);
  ['vLat', 'vLng', 'vZoom', 'vBearing', 'vPitch'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      map.jumpTo({ center: [parseFloat($('vLng').value) || 0, parseFloat($('vLat').value) || 0],
        zoom: (parseFloat($('vZoom').value) || 0) - dz(), bearing: parseFloat($('vBearing').value) || 0,
        pitch: Math.max(0, Math.min(85, parseFloat($('vPitch').value) || 0)) });
    });
  });
  $('vRoll').addEventListener('change', function () { setRoll(this.value); });
  function stateView(s) {
    var ll = G.mercToLngLat(s.mx, s.my);
    return { lat: ll[1], lng: ll[0], zoom: s.zoom, bearing: s.bearing, pitch: s.pitch, roll: s.roll || 0 };
  }
  function jumpToState(s) {
    map.jumpTo({ center: G.mercToLngLat(s.mx, s.my), zoom: s.zoom - dz(), bearing: s.bearing, pitch: s.pitch });
    setRoll(s.roll || 0);
  }

  // ---------- link with the AE timeline ----------
  var upgraded = {};
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
        if (document.activeElement !== $('vShake')) $('vShake').value = s.shake || 0;
        if (!s.v2 && !upgraded[s.id]) {                // comp from an older version: add Roll / Shake
          upgraded[s.id] = true;
          host('geoUpgrade', { compId: s.id }).then(function () { log('حُدّث الكومب: أضيف Roll و Shake'); }).catch(function () {});
        }
        if (s.style && s.style !== $('style').value && $('style').querySelector('option[value="' + s.style + '"]')) {
          $('style').value = s.style; setStyle();
        }
      }
      var changed = !prev || prev.id !== s.id || ['time', 'mx', 'my', 'zoom', 'bearing', 'pitch', 'roll'].some(function (k) { return prev[k] !== s[k]; });
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
    if ($('keepTilt').checked) { target.bearing = A.bearing; target.pitch = A.pitch; target.roll = A.roll; }
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
        '<div class="fbtns"><button class="mini sel accent">حدّد</button><button class="mini go">اذهب</button><button class="mini add">أضف للمتصفح</button>' +
        (isCountry && cc ? '<button class="mini prov">+ المحافظات</button><button class="mini inner">+ الحدود الداخلية</button>' : '') + '</div>';
      li.querySelector('b').textContent = title;
      li.querySelector('span.sub').textContent = '(' + (r.addresstype || r.type || r.category) + ')';
      li.querySelectorAll('div.sub')[0].textContent = r.display_name;
      li.querySelector('.go').onclick = function () { fitBBox(bboxOf(r)); };
      li.querySelector('.sel').onclick = function () {
        var geom = r.geojson && r.geojson.type ? r.geojson : { type: 'Point', coordinates: [+r.lon, +r.lat] };
        var ex = state.features.filter(function (f) { return f.name === title && f.geom.type === geom.type; })[0];
        if (ex) ex.sel = true;
        else addFeature(title, geom, +r.lon, +r.lat, { group: 'المحدد', quiet: true, cc: r.address && r.address.country_code });
        renderFeatures(); drawPreviewShapes(); save();
        fitBBox(bboxOf(r));
        log('حُدّد: ' + title + ' — لوّنه من «تلوين المناطق المحددة» أو ارسمه في AE');
      };
      li.ondblclick = function () { fitBBox(bboxOf(r)); };
      li.querySelector('.add').onclick = function () {
        addFeature(title, r.geojson && r.geojson.type ? r.geojson : { type: 'Point', coordinates: [+r.lon, +r.lat] }, +r.lon, +r.lat,
          { cc: r.address && r.address.country_code });
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
    document.querySelector('.tabs button[data-tab=t-select]').click();
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
  var drawing = false, draft = [], dczTimer = null;
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
    // re-enable double-click zoom only after the gesture that finished the drawing is over,
    // otherwise its dblclick (or the 2nd click of an arrow/circle) zooms the map
    clearTimeout(dczTimer);
    if (on) map.doubleClickZoom.disable();
    else dczTimer = setTimeout(function () { if (!drawing) map.doubleClickZoom.enable(); }, 400);
    drawDraft();
  }
  $('btnDraw').onclick = function () { setDrawing(!drawing); };
  map.on('click', function (e) {
    if (e.originalEvent.altKey) { lookupAt(e.lngLat); return; }
    if (picking) { pickAt(e).catch(function (err) { log('التحديد: ' + err.message, true); }); return; }
    if (!drawing) return;
    draft.push([e.lngLat.lng, e.lngLat.lat]); drawDraft();
    var kind = $('drawKind').value;
    if (kind === 'Point' && draft.length === 1) { var pt = draft[0]; setDrawing(false); addFeature('مكان', { type: 'Point', coordinates: pt }); }
    else if ((kind === 'Arrow' || kind === 'Circle') && draft.length === 2) finishTwoClick(kind, draft.slice());
  });
  function finishTwoClick(kind, pts) {
    setDrawing(false);
    if (G.haversineKm(pts[0], pts[1]) < 1e-3) { log('النقطتان متطابقتان — انقر البداية ثم النهاية في مكانين مختلفين', true); return; }
    if (kind === 'Circle') {
      var km = G.haversineKm(pts[0], pts[1]);
      addFeature('دائرة ' + (km < 10 ? km.toFixed(1) : Math.round(km)) + ' كم', G.circlePolygon(pts[0][0], pts[0][1], km), pts[0][0], pts[0][1]);
    } else {
      addFeature('سهم', { type: 'LineString', coordinates: pts }, pts[1][0], pts[1][1], { arrow: true });
    }
  }
  map.on('dblclick', function (e) {
    if (!drawing) return;
    e.preventDefault();
    var kind = $('drawKind').value, pts = draft.slice();
    if (kind !== 'Polygon' && kind !== 'LineString') return;
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
      sel: !!opt.group, group: opt.group || '', arrow: !!opt.arrow, spotlight: false, flicker: false, cc: opt.cc || '',
      fillColor: null, strokeColor: null, anim: 'draw', pattern: 'solid', shadow: false
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
        '<div class="feat"><input type="checkbox" class="sel" title="تحديد"><input type="color" class="col" title="لون الحواف"><input type="text" class="nm">' +
        '<button class="mini del" title="حذف">×</button></div>' +
        (f.group ? '<div class="group">' + escapeHtml(f.group) + '</div>' : '') +
        '<div class="sopts">' +
        (isPoint ? '' : '<label>السمك<input type="number" class="w" step="0.5"></label>') +
        (isArea ? '<label>تعبئة %<input type="number" class="fo" min="0" max="100"></label>' : '') +
        (isPoint ? '' : '<label>مدة الرسم<input type="number" class="dd" step="0.1"></label>') +
        (isArea ? '<label>لون التعبئة<input type="color" class="fc"></label>' : '') +
        '<label>حجم الاسم<input type="number" class="ls"></label>' +
        '<label>لون الاسم<input type="color" class="lc"></label>' +
        (isPoint ? '' : '<label>الدمج<select class="bl"><option value="NORMAL">Normal</option><option value="SCREEN">Screen</option>' +
          '<option value="MULTIPLY">Multiply</option><option value="ADD">Add</option><option value="OVERLAY">Overlay</option><option value="SOFT_LIGHT">Soft Light</option></select></label>' +
          '<label>الشفافية %<input type="number" class="op" min="0" max="100"></label>') +
        '</div><div class="fbtns">' +
        (isPoint ? '' : '<label class="check"><input type="checkbox" class="gl"> توهج</label><label class="check"><input type="checkbox" class="da"> متقطع</label>' +
          '<label class="check"><input type="checkbox" class="fl"> وميض</label>') +
        (isArea ? '<label class="check"><input type="checkbox" class="sp"> تعتيم ما حولها</label>' : '') +
        (f.arrow ? '<span class="group">سهم</span>' : '') +
        '</div><div class="fbtns">' +
        '<button class="mini fit">اذهب</button>' +
        (isPoint ? '' : '<button class="mini draw">ارسم في AE</button>') +
        '<button class="mini lab">أضف اسم</button>' +
        '<button class="mini anim">حرّك الكاميرا إليه</button>' +
        '<button class="mini hold" title="كيفريم عند رأس التشغيل على هذا المعلم، بلا حركة">ثبّت الكاميرا عليه</button>' +
        (isPoint ? '' : '<button class="mini along" title="الكاميرا تسير على الخط وتتجه معه">الكاميرا على المسار</button>') +
        '<button class="mini fav" title="أضف للمفضلة">☆</button></div>';
      var q = function (c) { return li.querySelector(c); };
      q('.sel').checked = !!f.sel; q('.col').value = f.strokeColor || f.color; q('.nm').value = f.name; q('.ls').value = f.labelSize;
      if (q('.fc')) q('.fc').value = f.fillColor || f.color;
      q('.lc').value = f.labelColor || '#ffffff';
      if (q('.w')) q('.w').value = f.strokeW;
      if (q('.fo')) q('.fo').value = f.fillOpacity;
      if (q('.dd')) q('.dd').value = f.drawDur;
      if (q('.gl')) q('.gl').checked = f.glow;
      if (q('.da')) q('.da').checked = f.dash;
      if (q('.bl')) q('.bl').value = f.blend || 'NORMAL';
      if (q('.op')) q('.op').value = f.opacity === undefined ? 100 : f.opacity;
      if (q('.fl')) q('.fl').checked = !!f.flicker;
      if (q('.sp')) q('.sp').checked = !!f.spotlight;
      li.addEventListener('change', function () {
        f.sel = q('.sel').checked; f.strokeColor = q('.col').value; f.color = f.strokeColor; f.name = q('.nm').value;
        if (q('.fc')) f.fillColor = q('.fc').value;
        f.labelSize = parseFloat(q('.ls').value) || 56; f.labelColor = q('.lc').value;
        if (q('.w')) f.strokeW = parseFloat(q('.w').value) || 4;
        if (q('.fo')) f.fillOpacity = Math.max(0, Math.min(100, parseFloat(q('.fo').value) || 0));
        if (q('.dd')) f.drawDur = Math.max(0, parseFloat(q('.dd').value) || 0);
        if (q('.gl')) f.glow = q('.gl').checked;
        if (q('.da')) f.dash = q('.da').checked;
        if (q('.bl')) f.blend = q('.bl').value;
        if (q('.op')) { var opv = parseFloat(q('.op').value); f.opacity = isNaN(opv) ? 100 : Math.max(0, Math.min(100, opv)); }
        if (q('.fl')) f.flicker = q('.fl').checked;
        if (q('.sp')) f.spotlight = q('.sp').checked;
        drawPreviewShapes(); fillArrowSelects(); save();
      });
      q('.del').onclick = function () { state.features.splice(i, 1); renderFeatures(); drawPreviewShapes(); save(); };
      q('.fit').onclick = function () { fitBBox(f.bbox); };
      li.querySelector('.nm').ondblclick = function () { fitBBox(f.bbox); };
      if (q('.draw')) q('.draw').onclick = run('رسم', function () { return drawFeatures([f]); });
      q('.lab').onclick = run('اسم', function () { return addLabels([f]); });
      q('.anim').onclick = run('حركة', function () {
        // a point has a zero-size bbox (fitZoom would give zoom 18): go there at the current zoom, at least 10
        var fit = isPoint ? { lng: f.lng, lat: f.lat, zoom: Math.max(aeState ? aeState.zoom : 0, 10) } : G.fitZoom(f.bbox, comp(), 0.12);
        return animateTo(Object.assign({ bearing: 0, pitch: 0, roll: 0 }, fit));
      });
      q('.hold').onclick = run('تثبيت الكاميرا', function () { return fitHold(f); });
      if (q('.along')) q('.along').onclick = run('المسار', function () { return cameraAlong(f); });
      q('.fav').onclick = function () { addFavourite(f); };
      ul.appendChild(li);
    });
    fillArrowSelects();
    renderSelected();
  }
  function renderSelected() {
    var ul = $('selList'); if (!ul) return;
    var list = selected();
    $('selCount').textContent = '(' + list.length + ')';
    ul.innerHTML = list.length ? '' : '<li class="hint">لا شيء محدد: ابحث واضغط «حدّد»، أو «ابدأ التحديد» وانقر على الخريطة</li>';
    list.slice(0, 60).forEach(function (f) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="feat"><span class="sw"></span><span class="nm"></span><button class="mini go">اذهب</button><button class="mini un" title="إلغاء تحديده">×</button></div>';
      li.querySelector('.sw').style.cssText = 'display:inline-block;width:12px;height:12px;border-radius:2px;background:' + (f.fillColor || f.color);
      li.querySelector('.nm').textContent = f.name;
      li.querySelector('.go').onclick = function () { fitBBox(f.bbox); };
      li.querySelector('.un').onclick = function () { f.sel = false; renderFeatures(); drawPreviewShapes(); save(); };
      ul.appendChild(li);
    });
  }
  $('btnSelFit').onclick = function () {
    var l = selected(); if (!l.length) return;
    var b = [180, 90, -180, -90];
    l.forEach(function (f) { b = [Math.min(b[0], f.bbox[0]), Math.min(b[1], f.bbox[1]), Math.max(b[2], f.bbox[2]), Math.max(b[3], f.bbox[3])]; });
    fitBBox(b);
  };
  $('btnSelDraw').onclick = run('رسم', function () { return drawFeatures(selected().filter(function (f) { return f.geom.type !== 'Point'; })); });
  $('btnSelNames').onclick = run('اسم', function () { return addLabels(selected()); });
  $('btnSelClear').onclick = function () { state.features.forEach(function (f) { f.sel = false; }); renderFeatures(); drawPreviewShapes(); save(); };
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
      if (f.geom.type === 'Point') { dots.features.push({ type: 'Feature', geometry: f.geom, properties: { c: f.color, s: f.sel ? 1 : 0 } }); return; }
      var g = f.geom, fo = f.fillOpacity / 100;
      if (t !== undefined) {
        if (f.drawStart === undefined) return;              // only features drawn into this comp are baked into 3D frames
        if (f.drawDur > 0) {
          var u = (t - f.drawStart) / f.drawDur;
          g = G.trimGeometry(f.geom, G.EASE.inout(Math.max(0, Math.min(1, u))));
          fo *= Math.max(0, Math.min(1, (t - f.drawStart - f.drawDur) / 0.6));
        }
      }
      lines.features.push({ type: 'Feature', geometry: g, properties: { c: f.strokeColor || f.color, w: f.strokeW, s: f.sel ? 1 : 0 } });
      if (/Polygon/.test(f.geom.type)) fills.features.push({ type: 'Feature', geometry: f.geom, properties: { c: f.fillColor || f.color, fo: fo } });
    });
    return { lines: lines, fills: fills, dots: dots };
  }
  function ensureShapeLayers(m, widthScale, withSelection) {
    if (m.getSource('gm-lines')) return;
    var empty = { type: 'FeatureCollection', features: [] };
    m.addSource('gm-lines', { type: 'geojson', data: empty });
    m.addSource('gm-fills', { type: 'geojson', data: empty });
    m.addSource('gm-dots', { type: 'geojson', data: empty });
    m.addLayer({ id: 'gm-fill', type: 'fill', source: 'gm-fills', paint: { 'fill-color': ['get', 'c'], 'fill-opacity': ['get', 'fo'] } });
    if (withSelection) {   // selection halo (preview only)
      m.addLayer({ id: 'gm-sel', type: 'line', source: 'gm-lines', filter: ['==', ['get', 's'], 1], layout: { 'line-join': 'round' },
        paint: { 'line-color': '#00e5ff', 'line-width': 7, 'line-blur': 3, 'line-opacity': 0.85 } });
    }
    m.addLayer({ id: 'gm-line', type: 'line', source: 'gm-lines', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'c'], 'line-width': ['*', ['get', 'w'], widthScale] } });
    m.addLayer({ id: 'gm-dot', type: 'circle', source: 'gm-dots',
      paint: { 'circle-color': ['get', 'c'], 'circle-radius': ['case', ['==', ['get', 's'], 1], 7, 5],
        'circle-stroke-color': ['case', ['==', ['get', 's'], 1], '#00e5ff', '#000'], 'circle-stroke-width': ['case', ['==', ['get', 's'], 1], 3, 1] } });
  }
  function setShapeData(m, t, onlyLines) {
    var c = shapeCollections(t);
    m.getSource('gm-lines').setData(c.lines);
    m.getSource('gm-fills').setData(c.fills);
    m.getSource('gm-dots').setData(onlyLines ? { type: 'FeatureCollection', features: [] } : c.dots);
  }
  function drawPreviewShapes() {
    if (!map.isStyleLoaded()) return;
    ensureShapeLayers(map, $('map').clientWidth / comp().w, true);
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
      var paths;
      if (f.arrow) {
        var c0 = f.geom.coordinates[0], c1 = f.geom.coordinates[f.geom.coordinates.length - 1];
        var m0 = G.lngLatToMerc(c0[0], c0[1]), m1 = G.lngLatToMerc(c1[0], c1[1]);
        paths = [G.arcPath(G.mercToWorldPx(refSpace(s), m0[0], m0[1]), G.mercToWorldPx(refSpace(s), m1[0], m1[1]), parseFloat($('arBend').value) || 0)];
      } else paths = featurePaths(f, s);
      var cm = G.lngLatToMerc(f.lng, f.lat), cpx = G.mercToWorldPx(refSpace(s), cm[0], cm[1]);
      var anim = f.anim || 'draw', arStyle = f.arrowStyle || $('arStyle').value, arrowThick = f.arrow && arStyle === 'thick';
      return { name: f.name, paths: paths, stroke: hexToRgb(f.strokeColor || f.color),
        strokeW: arrowThick ? Math.max(14, f.strokeW * 3) : f.strokeW,
        fill: f.spotlight ? [0, 0, 0] : hexToRgb(f.fillColor || f.color),
        fillOpacity: f.arrow ? 0 : f.fillOpacity, drawStart: 0, drawEnd: f.drawDur, glow: f.glow,
        dash: f.dash || (f.arrow && arStyle === 'moving') || anim === 'marching', marching: anim === 'marching' || (f.arrow && arStyle === 'moving'),
        blend: f.blend || 'NORMAL', opacity: f.opacity === undefined ? 100 : f.opacity, arrowHead: !!f.arrow,
        spotlight: !!f.spotlight && !f.arrow, flicker: !!f.flicker || anim === 'flicker', anim: anim, shadow: !!f.shadow,
        center: [cpx[0], cpx[1]], pattern: f.pattern === 'stripes' && !f.arrow ? 'stripes' : 'solid',
        stripe: hexToRgb(f.stripeColor || '#f2b705'), stripeGap: 16 * Math.pow(2, s.zr - s.zoom) };
    });
    shapes.forEach(function (x, i) { x.fid = list[i].id; });
    shapes = shapes.filter(function (x) { return x.paths.length; });
    var r = await host('geoAddShapes', { shapes: shapes, relative: true });
    var names = String(r).split('|')[1];
    if (names) names.split('\t').forEach(function (nm, i) {
      var f = state.features.filter(function (x) { return x.id === shapes[i].fid; })[0]; if (f) f.aeName = nm;
    });
    r = String(r).split('|')[0];
    list.forEach(function (f) { f.drawStart = s.time; });
    fillPathSelect();
    save();
    log('رُسم ' + r + ' معلم عند ' + s.time.toFixed(2) + 's (داخل كومب «' + s.name + ' World»)');
  }
  function labelFont() { return $('lblFont').value === 'custom' ? ($('lblFontCustom').value.trim() || FONT) : $('lblFont').value; }
  $('lblFont').addEventListener('change', function () { $('lblFontCustom').classList.toggle('hidden', this.value !== 'custom'); });
  $('lblFontCustom').classList.toggle('hidden', $('lblFont').value !== 'custom');
  async function addLabels(list, opts) {
    await poll(); needMap();
    if (!list.length) throw new Error('لم تحدد معالم');
    var mk = $('lblMarker').value, st = opts && opts.style || $('lblStyle').value;
    var labels = list.map(function (f) {
      var isPt = f.geom.type === 'Point';
      return { text: f.name, lat: f.lat, lng: f.lng, size: f.labelSize, color: hexToRgb($('lblText').value),
        dotColor: hexToRgb($('lblMarkColor').value), boxColor: hexToRgb($('lblBox').value), appear: 0, font: labelFont(),
        style: st, marker: st === 'inside' ? 'none' : (mk === 'auto' ? (isPt ? 'square' : 'none') : mk) };
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
      drawStart: 0, drawEnd: dur, dash: $('arDash').checked || $('arStyle').value === 'moving', marching: $('arStyle').value === 'moving',
      arrowHead: true };
    if ($('arStyle').value === 'thick') shape.strokeW = Math.max(14, shape.strokeW * 3);
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
    // AE comp px include the camera Roll (scene turned by -roll); MapLibre's unproject does not: undo it first
    var rr = (s.roll || 0) * Math.PI / 180, cs = Math.cos(rr), sn = Math.sin(rr), cx = s.w / 2, cy = s.h / 2;
    var layers = info.layers.map(function (L) {
      var dx = L.x - cx, dy = L.y - cy;
      var ll = map.unproject([(cx + dx * cs - dy * sn) * k, (cy + dx * sn + dy * cs) * k]);
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
    if (!opt.preview && $('waterMask').checked) {
      log('قناع الماء…');
      var mspec = await getStyleSpec('positron');
      var wm = await renderPlate(mspec, Object.assign({}, look, { waterMask: true, terrain: false, hillshade: false, buildings3d: false, climate: 'none' }),
        baseLL, plan.zb, plan.w, plan.h, dir, 'water_mask.png');
      plates.push({ file: wm.file, x: bp[0], y: bp[1], w: plan.w, scale: 100 * Math.pow(2, S.zr - plan.zb), zoom: plan.zb, isBase: false, isMask: true });
    }
    var tint = $('tintOn').checked ? { dark: hexToRgb($('tintDark').value), light: hexToRgb($('tintLight').value),
      amount: Math.max(0, Math.min(100, parseFloat($('tintAmt').value) || 80)) } : null;
    var res = await host('geoFinalize', { compId: S.compId, style: look.style, plates: plates, seq: null, tint: tint }, dir);
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

  // ---------- camera moves ----------
  var MOVE_INFO = {
    zoomIn: ['مستويات الزوم (1 = ضعف الحجم)', 1.5], zoomOut: ['مستويات الزوم', 1.5],
    dollyIn: ['قوة الاندفاع للأمام', 1.5], dollyOut: ['قوة الرجوع للخلف', 1.5],
    approach: ['مستويات الاقتراب (مع ميل ودوران)', 2], rotate360: ['عدد اللفات (1 = 360°)', 1],
    crashZoom: ['مستويات الزوم السريع', 3], establishing: ['كم يبدأ بعيداً (مستويات زوم)', 4],
    flyToSel: ['— (يطير إلى أول مكان محدد)', 0], drift: ['قوة الانجراف', 1],
    tiltReveal: ['مستويات الابتعاد مع النزول لمنظر علوي', 1.5], orbitTilt: ['درجات الدوران مع رفع الميل', 120],
    orbit: ['درجات الدوران (360 = لفة كاملة)', 90], pushIn: ['مستويات زوم للاقتراب', 1.5], pullOut: ['مستويات زوم للابتعاد', 1.5],
    lowAngle: ['ميل الكاميرا النهائي بالدرجات (حتى 85)', 75], topDown: ['— (يعود الميل والدوران إلى صفر)', 0],
    craneUp: ['مستويات زوم للابتعاد مع الرفع', 1.5], spiral: ['درجات الدوران مع اقتراب 1.5 زوم', 180],
    flyOver: ['مسافة الطيران بعدد الشاشات', 1.5], panLeft: ['نسبة من عرض الشاشة', 0.5], panRight: ['نسبة من عرض الشاشة', 0.5],
    panUp: ['نسبة من ارتفاع الشاشة', 0.5], panDown: ['نسبة من ارتفاع الشاشة', 0.5],
    dutch: ['ميلان الأفق بالدرجات (−45 إلى 45)', 12], reveal: ['مستويات زوم للابتعاد', 2.5]
  };
  function moveHint() {
    var i = MOVE_INFO[$('moveType').value];
    $('moveHint').textContent = 'المقدار: ' + i[0] + ((/lowAngle|flyOver/.test($('moveType').value) && $('outMode').value === 'layers') ?
      ' — للميل فوق 70° استخدم «إطارات 3D» في الإخراج.' : '');
  }
  $('moveType').addEventListener('change', function () { $('moveAmt').value = MOVE_INFO[this.value][1]; moveHint(); save(); });
  function buildMove(A, type, amt, c) {
    var B = Object.assign({}, A), raw = false, start = null, bake = null;
    switch (type) {
      case 'zoomIn': B.zoom = A.zoom + amt; break;
      case 'zoomOut': B.zoom = A.zoom - amt; break;
      case 'dollyIn': case 'dollyOut': {    // the camera itself travels forward / back over the ground
        var sg = type === 'dollyIn' ? 1 : -1;
        B.zoom = A.zoom + sg * amt * 0.6; B.pitch = Math.max(0, Math.min(80, A.pitch + sg * 8));
        var ld = G.panCenter(A.lng, A.lat, A.zoom, A.bearing, 0, -sg * amt * 0.12 * c.h); B.lng = ld[0]; B.lat = ld[1]; break;
      }
      case 'approach': B.zoom = A.zoom + amt; B.pitch = Math.max(A.pitch, 55); B.bearing = A.bearing + 25; raw = true; break;
      case 'rotate360': B.bearing = A.bearing + 360 * (amt || 1); raw = true; bake = 'linear'; break;
      case 'crashZoom': B.zoom = A.zoom + amt; bake = 'in'; break;
      case 'establishing':     // starts far and flat, lands on the current view
        start = Object.assign({}, A, { zoom: A.zoom - amt, pitch: 0, bearing: A.bearing - 30 }); raw = true; bake = 'out'; break;
      case 'flyToSel': {
        var f = selected()[0];
        if (!f) throw new Error('حدّد مكاناً أولاً (تبويب التحديد)');
        var fit = f.geom.type === 'Point' ? { lng: f.lng, lat: f.lat, zoom: Math.max(A.zoom, 10) } : G.fitZoom(f.bbox, c, 0.12);
        B = Object.assign({}, A, fit); bake = 'fly'; break;
      }
      case 'drift': {
        B.zoom = A.zoom + 0.25 * amt; B.bearing = A.bearing + 4 * amt; raw = true; bake = 'linear';
        var dr = G.panCenter(A.lng, A.lat, A.zoom, A.bearing, 0.08 * amt * c.w, 0); B.lng = dr[0]; B.lat = dr[1]; break;
      }
      case 'tiltReveal': start = Object.assign({}, A, { pitch: Math.max(A.pitch, 65), zoom: A.zoom + 0.5 }); B.pitch = 0; B.zoom = A.zoom - amt; break;
      case 'orbitTilt': B.bearing = A.bearing + amt; B.pitch = Math.max(A.pitch, 60); raw = true; break;
      case 'orbit': B.bearing = A.bearing + amt; raw = true; break;
      case 'pushIn': B.zoom = A.zoom + amt; break;
      case 'pullOut': B.zoom = A.zoom - amt; break;
      case 'lowAngle': B.pitch = Math.max(0, Math.min(85, amt)); B.zoom = A.zoom + 0.6; break;
      case 'topDown': B.pitch = 0; B.bearing = 0; B.roll = 0; break;
      case 'craneUp': B.zoom = A.zoom - amt; B.pitch = Math.max(0, A.pitch - 40); break;
      case 'spiral': B.bearing = A.bearing + amt; B.zoom = A.zoom + 1.5; raw = true; break;
      case 'flyOver': {
        B.pitch = Math.max(A.pitch, 65); B.zoom = A.zoom + 0.5;
        var ll = G.panCenter(A.lng, A.lat, A.zoom, A.bearing, 0, -amt * c.h); B.lng = ll[0]; B.lat = ll[1]; break;
      }
      case 'panLeft': case 'panRight': case 'panUp': case 'panDown': {
        var dx = type === 'panLeft' ? -amt * c.w : (type === 'panRight' ? amt * c.w : 0);
        var dy = type === 'panUp' ? -amt * c.h : (type === 'panDown' ? amt * c.h : 0);
        var l2 = G.panCenter(A.lng, A.lat, A.zoom, A.bearing, dx, dy); B.lng = l2[0]; B.lat = l2[1]; break;
      }
      case 'dutch': B.roll = Math.max(-45, Math.min(45, amt)); break;
      case 'reveal': B.zoom = A.zoom - amt; B.pitch = 0; B.bearing = 0; B.roll = 0; break;
    }
    return { B: B, raw: raw, start: start, bake: bake };
  }
  function bakeKeys(A, B, dur, how, raw, c) {
    var vp = Math.max(c.w, c.h), n = Math.max(8, Math.round(dur / 0.12)), keys = [];
    var ease = how === 'in' ? G.EASE['in'] : how === 'out' ? G.EASE.out : how === 'fly' ? G.EASE.inout : G.EASE.linear;
    for (var i = 0; i <= n; i++) {
      var t = dur * i / n, e = ease(i / n);
      var v = G.interpSegment(A, B, e, how === 'fly' ? 'fly' : 'direct', vp), ll = G.mercToLngLat(v.mx, v.my);
      keys.push({ t: t, lat: ll[1], lng: ll[0], zoom: v.zoom, pitch: v.pitch,
        bearing: raw ? A.bearing + (B.bearing - A.bearing) * e : v.bearing,
        roll: (A.roll || 0) + ((B.roll || 0) - (A.roll || 0)) * e, linear: true });
    }
    return keys;
  }
  // panel-only preview of a move (does not touch AE)
  function previewMove(A, B, dur, raw) {
    var t0 = performance.now(), c = comp(), vp = Math.max(c.w, c.h);
    (function step(now) {
      var u = Math.min(1, (now - t0) / 1000 / dur), e = $('moveEase').value === 'linear' ? u : G.EASE.inout(u);
      var v = G.interpSegment(A, B, e, 'direct', vp);
      var br = raw ? A.bearing + (B.bearing - A.bearing) * e : v.bearing;
      map.jumpTo({ center: G.mercToLngLat(v.mx, v.my), zoom: v.zoom - dz(), bearing: br, pitch: v.pitch });
      setRoll((A.roll || 0) + ((B.roll || 0) - (A.roll || 0)) * e);
      if (u < 1) requestAnimationFrame(step);
    })(t0);
  }
  function currentStart() {
    if (aeState) return stateView(aeState);
    return captureView();
  }
  $('btnMovePreview').onclick = function () {
    try {
      var A = currentStart(), mv = buildMove(A, $('moveType').value, parseFloat($('moveAmt').value) || 0, comp());
      previewMove(mv.start || A, mv.B, Math.max(0.2, parseFloat($('moveDur').value) || 4), mv.raw);
    } catch (e) { log(e.message, true); }
  };
  $('btnMove').onclick = run('حركة الكاميرا', async function () {
    await poll();
    var s = needMap(), A = stateView(s), dur = Math.max(0.2, parseFloat($('moveDur').value) || 4);
    var mv = buildMove(A, $('moveType').value, parseFloat($('moveAmt').value) || 0, comp());
    var lin = $('moveEase').value === 'linear', A0 = mv.start || A, keys;
    if (mv.bake) keys = bakeKeys(A0, mv.B, dur, lin && mv.bake !== 'fly' ? 'linear' : mv.bake, mv.raw, comp());
    else keys = [Object.assign({ t: 0, linear: lin }, A0), Object.assign({ t: dur, linear: lin }, mv.B)];
    await host('geoSetKeys', { keys: keys, relative: true, rawBearing: mv.raw, gotoAfter: dur });
    log('حركة «' + $('moveType').selectedOptions[0].textContent + '» ' + dur + 's — رأس التشغيل انتقل لنهايتها');
  });
  $('btnShake').onclick = run('اهتزاز', async function () {
    await poll(); needMap();
    await host('geoSetValues', { values: { Shake: Math.max(0, parseFloat($('vShake').value) || 0) } });
    log('اهتزاز الكاميرا = ' + $('vShake').value + ' px');
  });

  // key the camera on a feature at the playhead, no animation (GEOlayers "Fit View to Feature")
  async function fitHold(f) {
    await poll();
    var s = needMap(), A = stateView(s);
    var fit = f.geom.type === 'Point' ? { lng: f.lng, lat: f.lat, zoom: Math.max(s.zoom, 10) } : G.fitZoom(f.bbox, comp(), 0.12);
    var K = Object.assign({}, A, fit, $('keepTilt').checked ? {} : { bearing: 0, pitch: 0 });
    await host('geoSetKeys', { keys: [Object.assign({ t: -1 }, K)] });
    log('ثُبّتت الكاميرا على «' + f.name + '» عند ' + s.time.toFixed(2) + 's');
  }
  // camera travels along a line, heading with it (GEOlayers "Animate View Along Feature")
  async function cameraAlong(f) {
    await poll();
    var s = needMap(), line = G.mainLine(f.geom);
    if (!line || line.length < 2) throw new Error('هذا المعلم ليس خطاً');
    var dur = Math.max(0.5, parseFloat($('moveDur').value) || 4), n = Math.max(8, Math.round(dur / 0.25));
    var sp = G.samplePath(line, n), A = stateView(s);
    // keys are written raw (no per-key unwrap): shift the whole unwrapped run next to the current bearing,
    // so the camera does not spin up to 360 deg from the previous key into the first one
    var b0 = sp.points[0].bearing, bOff = A.bearing + G.shortestAngle(A.bearing, b0) - b0;
    var keys = sp.points.map(function (pt, i) {
      return { t: dur * i / n, lng: pt.p[0], lat: pt.p[1], zoom: A.zoom, bearing: pt.bearing + bOff, pitch: A.pitch, linear: true };
    });
    await host('geoSetKeys', { keys: keys, relative: true, rawBearing: true, gotoAfter: dur });
    log('الكاميرا على مسار «' + f.name + '»: ' + Math.round(sp.km) + ' كم في ' + dur + 's (' + keys.length + ' كيفريم)');
  }

  // ---------- circle around the selected feature (or the map centre) ----------
  $('btnCircle').onclick = function () {
    var km = Math.max(0.1, parseFloat($('circleKm').value) || 50), sel = selected()[0];
    var c = sel ? [sel.lng, sel.lat] : [map.getCenter().lng, map.getCenter().lat];
    addFeature('دائرة ' + km + ' كم' + (sel ? ' حول ' + sel.name : ''), G.circlePolygon(c[0], c[1], km), c[0], c[1]);
  };

  // ---------- anchor link + pen layer ----------
  $('btnAnchor').onclick = run('المرساة', async function () {
    var r = await evalScript('geoLinkToAnchor()');
    if (r.indexOf('OK|') !== 0) throw new Error(r.replace(/^ERR\|/, ''));
    log('رُبطت ' + r.slice(3) + ' طبقة بـ GEO Map Anchor (صارت 3D وتتبع الخريطة)');
  });
  $('btnDrawLayer').onclick = run('طبقة رسم', async function () {
    var r = await evalScript('geoCreateDrawLayer()');
    if (r.indexOf('OK|') !== 0) throw new Error(r.replace(/^ERR\|/, ''));
    log('فُتح كومب «' + r.slice(3) + '» وفيه طبقة «رسم حر»: حدّدها وارسم بأداة القلم (Pen)، يبقى الرسم ثابتاً على الخريطة.');
  });

  // ---------- favourites (shared by all projects) ----------
  var favFile = fs ? pathM.join(workDir('state'), 'favorites.json') : null;
  function loadFavs() {
    try {
      if (favFile && fs.existsSync(favFile)) return JSON.parse(fs.readFileSync(favFile, 'utf8'));
      return JSON.parse(localStorage.getItem('geomotion.favs') || '[]');
    } catch (e) { return []; }
  }
  function saveFavs(list) {
    var txt = JSON.stringify(list);
    if (favFile) fs.writeFileSync(favFile, txt, 'utf8'); else { try { localStorage.setItem('geomotion.favs', txt); } catch (e) {} }
  }
  function addFavourite(f) {
    var list = loadFavs();
    if (list.some(function (x) { return x.name === f.name && Math.abs(x.lng - f.lng) < 1e-6; })) { log('«' + f.name + '» موجود في المفضلة'); return; }
    list.push({ name: f.name, geom: f.geom, lng: f.lng, lat: f.lat });
    saveFavs(list); renderFavs(); log('☆ أُضيف «' + f.name + '» للمفضلة');
  }
  function renderFavs() {
    var ul = $('favs'), list = loadFavs();
    ul.innerHTML = list.length ? '' : '<li class="hint">لا يوجد شيء بعد</li>';
    list.forEach(function (x, i) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="feat"><span class="nm"></span><span></span><button class="mini add">أضف</button><button class="mini del">×</button></div>';
      li.querySelector('.nm').textContent = x.name;
      li.querySelector('.add').onclick = function () { addFeature(x.name, x.geom, x.lng, x.lat); };
      li.querySelector('.del').onclick = function () { var l = loadFavs(); l.splice(i, 1); saveFavs(l); renderFavs(); };
      ul.appendChild(li);
    });
  }

  // ---------- climate overlay ----------
  function climateTiles(L) {
    var c = CLIMATE[L.climate];
    if (!c) return null;
    if (L.climate === 'radar') return radarUrl;
    var d = L.climateDate || defaultClimateDate();
    return c.url.replace('{date}', d);
  }
  function defaultClimateDate() { return new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10); }
  function applyClimate(m, L, before) {
    var url = L.climate && L.climate !== 'none' ? climateTiles(L) : null;
    var src = m.getSource('gm-climate');
    if (src && (!url || src._gmUrl !== url)) { if (m.getLayer('gm-climate')) m.removeLayer('gm-climate'); m.removeSource('gm-climate'); src = null; }
    if (!url) return;
    if (!src) {
      m.addSource('gm-climate', { type: 'raster', tiles: [url], tileSize: 256, maxzoom: CLIMATE[L.climate].max, attribution: CLIMATE[L.climate].attr });
      m.getSource('gm-climate')._gmUrl = url;
      m.addLayer({ id: 'gm-climate', type: 'raster', source: 'gm-climate', paint: { 'raster-opacity': L.climateOp } }, before || undefined);
    } else m.setPaintProperty('gm-climate', 'raster-opacity', L.climateOp);
  }
  if (!$('climateDate').value) $('climateDate').value = defaultClimateDate();
  ['climate', 'climateDate', 'climateOp', 'colBound', 'colLabel'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      var go = function () { if (/col/.test(id)) setStyle(); else relook(); save(); };
      if (id === 'climate' && this.value === 'radar') refreshRadar().then(go).catch(function (e) { log('الرادار: ' + e.message, true); });
      else go();
    });
  });
  if ($('climate').value === 'radar') refreshRadar().then(relook).catch(function () {});

  // ---------- one-click colours from an image ----------
  $('paletteImg').onchange = function () {
    var file = this.files[0]; if (!file) return;
    var img = new Image();
    img.onload = function () {
      var cv = document.createElement('canvas'), n = 64; cv.width = n; cv.height = n;
      var cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, n, n);
      var d = cx.getImageData(0, 0, n, n).data, px = [];
      for (var i = 0; i < d.length; i += 4) if (d[i + 3] > 128) px.push([d[i], d[i + 1], d[i + 2]]);
      var pal = kmeans(px, 6);
      var lum = function (c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
      var sat = function (c) { var mx = Math.max.apply(null, c), mn = Math.min.apply(null, c); return mx ? (mx - mn) / mx : 0; };
      var byLum = pal.slice().sort(function (a, b) { return lum(a) - lum(b); });
      var accent = pal.slice().sort(function (a, b) { return sat(b) - sat(a); })[0];
      var hex = function (c) { return '#' + c.map(function (v) { return ('0' + Math.round(v).toString(16)).slice(-2); }).join(''); };
      $('colWater').value = hex(byLum[0]); $('colLand').value = hex(byLum[1]); $('colRoads').value = hex(byLum[3]);
      $('colLabel').value = hex(byLum[byLum.length - 1]); $('colBound').value = hex(accent);
      $('customColors').checked = true; updateHints(); setStyle(); save();
      log('لُوّنت الخريطة من الصورة: ' + pal.map(hex).join(' '));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
    this.value = '';
  };
  function kmeans(px, k) {
    if (!px.length) return [[30, 30, 30]];
    var cent = [], i, j, it;
    for (i = 0; i < k; i++) cent.push(px[Math.floor((i + 0.5) * px.length / k)].slice());
    for (it = 0; it < 12; it++) {
      var sum = cent.map(function () { return [0, 0, 0, 0]; });
      for (i = 0; i < px.length; i++) {
        var best = 0, bd = 1e12;
        for (j = 0; j < k; j++) {
          var dr = px[i][0] - cent[j][0], dg = px[i][1] - cent[j][1], db = px[i][2] - cent[j][2], dd = dr * dr + dg * dg + db * db;
          if (dd < bd) { bd = dd; best = j; }
        }
        sum[best][0] += px[i][0]; sum[best][1] += px[i][1]; sum[best][2] += px[i][2]; sum[best][3]++;
      }
      for (j = 0; j < k; j++) if (sum[j][3]) cent[j] = [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]];
    }
    return cent;
  }

  // ---------- select places by clicking the map ----------
  var picking = false;
  var NOM_ZOOM = { country: 3, state: 5, county: 8, city: 10, district: 14 };
  function setPicking(on) {
    picking = on; if (on && drawing) setDrawing(false);
    $('btnPick').textContent = on ? 'إيقاف التحديد' : 'ابدأ التحديد';
    $('map').classList.toggle('drawing', on);
  }
  $('btnPick').onclick = function () { setPicking(!picking); };
  function placeLayerIds() {
    var st = map.getStyle(); if (!st) return [];
    return st.layers.filter(function (l) { return l['source-layer'] === 'place' && l.type === 'symbol' && map.getLayoutProperty(l.id, 'visibility') !== 'none'; })
      .map(function (l) { return l.id; });
  }
  function placeName(p) { return ($('labels').value === 'ar' && p['name:ar']) || p['name:ar'] || p.name || p['name:latin'] || ''; }
  async function pickAt(e) {
    var level = $('pickLevel').value;
    if (level === 'auto' || level === 'city') {
      var ids = placeLayerIds();
      if (ids.length) {
        var bb = [[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]];
        var hits = map.queryRenderedFeatures(bb, { layers: ids });
        if (hits.length && level === 'auto') {
          var h = hits[0], nm = placeName(h.properties), c = h.geometry.coordinates;
          addFeature(nm, { type: 'Point', coordinates: c }, c[0], c[1], { group: 'تحديد بالنقر', quiet: true });
          renderFeatures(); drawPreviewShapes(); save(); log('حُدّدت المدينة: ' + nm); return;
        }
      }
    }
    var z = NOM_ZOOM[level] || 5;
    log('…جارٍ تحديد ' + (level === 'auto' ? 'المنطقة' : $('pickLevel').selectedOptions[0].textContent));
    var r = await nominatim('reverse?format=jsonv2&polygon_geojson=1&polygon_threshold=0.0003&addressdetails=1&accept-language=ar&zoom=' + z +
      '&lat=' + e.lngLat.lat + '&lon=' + e.lngLat.lng);
    if (!r || r.error) { log('لا يوجد شيء في هذه النقطة', true); return; }
    var title = r.name || (r.display_name || '').split(',')[0];
    var geom = r.geojson && r.geojson.type ? r.geojson : { type: 'Point', coordinates: [+r.lon, +r.lat] };
    if (state.features.some(function (f) { return f.name === title && f.geom.type === geom.type; })) { log('«' + title + '» موجود أصلاً'); return; }
    addFeature(title, geom, +r.lon, +r.lat, { group: 'تحديد بالنقر', quiet: true, cc: r.address && r.address.country_code });
    renderFeatures(); drawPreviewShapes(); save();
    log('حُدّد: ' + title + ' (' + (r.addresstype || r.type) + ')');
  }
  // every city label visible on screen -> points in the browser
  $('btnCities').onclick = function () {
    var ids = placeLayerIds();
    if (!ids.length) { log('لا توجد أسماء مدن ظاهرة: اختر نمطاً متجهاً أو «الهجين» وشغّل طبقة أسماء المدن.', true); return; }
    var max = Math.max(1, parseInt($('citiesMax').value, 10) || 25), towns = $('citiesTowns').checked;
    var classes = towns ? { city: 1, town: 1 } : { city: 1 };
    var seen = {}, list = [];
    map.queryRenderedFeatures({ layers: ids }).forEach(function (f) {
      var p = f.properties, nm = placeName(p);
      if (!classes[p.class] || !nm || seen[nm]) return;
      seen[nm] = 1; list.push({ nm: nm, c: f.geometry.coordinates, rank: p.rank || 99 });
    });
    list.sort(function (a, b) { return a.rank - b.rank; });
    list.slice(0, max).forEach(function (x) { addFeature(x.nm, { type: 'Point', coordinates: x.c }, x.c[0], x.c[1], { group: 'مدن الشاشة', quiet: true }); });
    renderFeatures(); drawPreviewShapes(); save();
    log('أُضيفت ' + Math.min(max, list.length) + ' مدينة من الشاشة (محددة): «أسماء للمحدد» يضعها كلها في AE');
  };

  // ---------- real routes (car / foot / bike) or a flight arc ----------
  $('btnRoute').onclick = run('المسار', async function () {
    var A = state.features.filter(function (f) { return f.id === $('arFrom').value; })[0];
    var B = state.features.filter(function (f) { return f.id === $('arTo').value; })[0];
    if (!A || !B || A === B) throw new Error('اختر مكانين مختلفين في «من / إلى»');
    var mode = $('routeMode').value, geom, km;
    if (mode === 'flight') {
      var n = 64, pts = [];
      for (var i = 0; i <= n; i++) pts.push(greatCircle([A.lng, A.lat], [B.lng, B.lat], i / n));
      geom = { type: 'LineString', coordinates: pts }; km = G.haversineKm([A.lng, A.lat], [B.lng, B.lat]);
    } else {
      var prof = { car: 'routed-car', foot: 'routed-foot', bike: 'routed-bike' }[mode];
      var url = 'https://routing.openstreetmap.de/' + prof + '/route/v1/driving/' + A.lng + ',' + A.lat + ';' + B.lng + ',' + B.lat +
        '?overview=full&geometries=geojson';
      var j = await fetchJSON(url);
      if (!j.routes || !j.routes.length) throw new Error('لم يُعثر على طريق بين المكانين');
      geom = j.routes[0].geometry; km = j.routes[0].distance / 1000;
    }
    var label = { car: 'طريق سيارة', foot: 'طريق مشي', bike: 'طريق دراجة', flight: 'رحلة جوية' }[mode];
    addFeature(label + ': ' + A.name + ' ← ' + B.name, geom, undefined, undefined, { strokeW: 5 });
    log(label + ' ' + Math.round(km) + ' كم أُضيف للمتصفح');
  });
  function greatCircle(a, b, f) {
    var r = Math.PI / 180, la1 = a[1] * r, lo1 = a[0] * r, la2 = b[1] * r, lo2 = b[0] * r;
    var d = 2 * Math.asin(Math.sqrt(Math.pow(Math.sin((la2 - la1) / 2), 2) + Math.cos(la1) * Math.cos(la2) * Math.pow(Math.sin((lo2 - lo1) / 2), 2)));
    if (d < 1e-9) return a;
    var A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    var x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
    var y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
    var z = A * Math.sin(la1) + B * Math.sin(la2);
    return [Math.atan2(y, x) / r, Math.atan2(z, Math.sqrt(x * x + y * y)) / r];
  }

  // ---------- choropleth from CSV ----------
  function normName(t) {
    return String(t || '').toLowerCase().replace(/[\u064B-\u065F\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/^(محافظة|ولاية|منطقة|إقليم|اقليم|مقاطعة|governorate of|province of)\s+/, '').replace(/\s+(governorate|province|state|region)$/, '')
      .replace(/^ال/, '').replace(/[^\u0600-\u06FFa-z0-9]/g, '');
  }
  $('choroCsv').onchange = function () {
    var file = this.files[0]; if (!file) return;
    var rd = new FileReader();
    rd.onload = function () {
      var lines = rd.result.replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
      var sep = lines[0].indexOf('\t') >= 0 ? '\t' : (lines[0].split(';').length > lines[0].split(',').length ? ';' : ',');
      var rows = lines.map(function (l) { return l.split(sep).map(function (c) { return c.trim().replace(/^"|"$/g, ''); }); });
      if (isNaN(parseFloat(rows[0][1]))) rows.shift();                 // header
      var data = {}, vals = [];
      rows.forEach(function (r) { var v = parseFloat(r[1]); if (r[0] && !isNaN(v)) { data[normName(r[0])] = v; vals.push(v); } });
      if (!vals.length) { log('CSV: لا توجد أرقام في العمود الثاني', true); return; }
      var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      var c0 = hexToRgb($('choroLow').value), c1 = hexToRgb($('choroHigh').value), fill = parseFloat($('choroFill').value) || 75, hit = 0;
      state.features.forEach(function (f) {
        var v = data[normName(f.name)];
        if (v === undefined) return;
        var u = hi > lo ? (v - lo) / (hi - lo) : 1;
        var c = c0.map(function (a, i) { return a + (c1[i] - a) * u; });
        f.color = '#' + c.map(function (x) { return ('0' + Math.round(x * 255).toString(16)).slice(-2); }).join('');
        f.fillOpacity = fill; f.sel = true; f.value = v; hit++;
      });
      renderFeatures(); drawPreviewShapes(); save();
      log('Choropleth: لُوّن ' + hit + ' من ' + vals.length + ' صف (من ' + lo + ' إلى ' + hi + '). المطابقة بالاسم؛ أضف المحافظات أولاً.');
    };
    rd.readAsText(file);
    this.value = '';
  };

  // ---------- saved views (spatial bookmarks) ----------
  var bmFile = fs ? pathM.join(workDir('state'), 'views.json') : null;
  function loadBms() { try { return bmFile && fs.existsSync(bmFile) ? JSON.parse(fs.readFileSync(bmFile, 'utf8')) : JSON.parse(localStorage.getItem('geomotion.views') || '[]'); } catch (e) { return []; } }
  function saveBms(l) { var t = JSON.stringify(l); if (bmFile) fs.writeFileSync(bmFile, t, 'utf8'); else { try { localStorage.setItem('geomotion.views', t); } catch (e) {} } }
  function renderBms() {
    var ul = $('bms'), list = loadBms(); ul.innerHTML = list.length ? '' : '<li class="hint">لا توجد زوايا محفوظة</li>';
    list.forEach(function (v, i) {
      var li = document.createElement('li');
      li.innerHTML = '<div class="feat"><span class="nm"></span><button class="mini go">اذهب</button><button class="mini key">◆ كيفريم</button><button class="mini del">×</button></div>';
      li.querySelector('.nm').textContent = v.name;
      li.querySelector('.go').onclick = function () { map.jumpTo({ center: [v.lng, v.lat], zoom: v.zoom - dz(), bearing: v.bearing, pitch: v.pitch }); setRoll(v.roll || 0); };
      li.querySelector('.key').onclick = run('كيفريم', async function () {
        await poll(); needMap(); await host('geoSetKeys', { keys: [Object.assign({ t: -1 }, v)] }); log('◆ «' + v.name + '» عند ' + aeState.time.toFixed(2) + 's');
      });
      li.querySelector('.del').onclick = function () { var l = loadBms(); l.splice(i, 1); saveBms(l); renderBms(); };
      ul.appendChild(li);
    });
  }
  $('btnBm').onclick = function () {
    var v = captureView(); v.name = $('bmName').value.trim() || ('زاوية ' + (loadBms().length + 1));
    var l = loadBms(); l.push(v); saveBms(l); renderBms(); $('bmName').value = ''; log('حُفظت الزاوية «' + v.name + '»');
  };

  // ---------- AE tools: scale bar, move a layer along a drawn path ----------
  $('btnScaleBar').onclick = run('مقياس الرسم', async function () {
    await poll(); needMap();
    var r = await host('geoAddScaleBar', { font: FONT });
    log('أُضيف مقياس رسم يتغير مع الزوم (' + r + ')');
  });
  function fillPathSelect() {
    var sel = $('pathFeat'), cur = sel.value; sel.innerHTML = '';
    state.features.filter(function (f) { return f.aeName && f.geom.type !== 'Point'; }).forEach(function (f) {
      var o = document.createElement('option'); o.value = f.id; o.textContent = f.name; sel.appendChild(o);
    });
    if (cur) sel.value = cur;
  }
  $('btnOnPath').onclick = run('على المسار', async function () {
    await poll(); needMap();
    var f = state.features.filter(function (x) { return x.id === $('pathFeat').value; })[0];
    if (!f) throw new Error('ارسم خطاً أو سهماً أو مساراً في AE أولاً، ثم اختره هنا');
    var r = await host('geoAttachToPath', { pathLayer: f.aeName, duration: Math.max(0.2, parseFloat($('pathDur').value) || 4), orient: $('pathOrient').checked });
    log('تتحرك ' + r + ' طبقة على «' + f.name + '» من رأس التشغيل');
  });

  // ---------- colour the selected regions ----------
  function applyRegionStyle() {
    var list = selected();
    if (!list.length) throw new Error('حدّد المناطق أولاً (مربع الاختيار بجانب كل معلم، أو التحديد بالنقر)');
    list.forEach(function (f) {
      if (f.geom.type === 'Point') return;
      f.fillColor = $('rgFill').value; f.strokeColor = $('rgStroke').value; f.color = f.strokeColor;
      f.fillOpacity = Math.max(0, Math.min(100, parseFloat($('rgFillOp').value) || 0));
      f.strokeW = Math.max(0, parseFloat($('rgStrokeW').value) || 0);
      f.pattern = $('rgPattern').value; f.stripeColor = $('rgStripe').value;
      f.anim = $('rgAnim').value; f.drawDur = Math.max(0, parseFloat($('rgDur').value) || 0);
      f.blend = $('rgBlend').value; f.glow = $('rgGlow').checked; f.shadow = $('rgShadow').checked;
    });
    renderFeatures(); drawPreviewShapes(); save();
    return list.filter(function (f) { return f.geom.type !== 'Point'; });
  }
  $('btnRgApply').onclick = function () { try { var l = applyRegionStyle(); log('لُوّنت ' + l.length + ' منطقة'); } catch (e) { log(e.message, true); } };
  $('btnRgDraw').onclick = run('تلوين المناطق', async function () {
    var l = applyRegionStyle();
    await drawFeatures(l);
    if ($('rgNames').checked) await addLabels(l, { style: 'inside' });
  });

  // ---------- images, 3D objects as pictures, flags ----------
  $('btnImgBrowse').onclick = function () {
    try {
      var r = window.cep && window.cep.fs && window.cep.fs.showOpenDialogEx
        ? window.cep.fs.showOpenDialogEx(false, false, 'اختر صورة أو فيديو', '', ['png', 'jpg', 'jpeg', 'psd', 'tif', 'mov', 'mp4', 'ai'])
        : null;
      if (r && r.data && r.data.length) { $('imgPath').value = r.data[0]; save(); }
      else if (!r) log('اكتب مسار الملف في الخانة (نافذة الاختيار تعمل داخل AE فقط)', true);
    } catch (e) { log('اختيار الملف: ' + e.message, true); }
  };
  function placeOf() {
    var f = selected()[0];
    if (f) return { lat: f.lat, lng: f.lng, name: f.name };
    var c = map.getCenter(); return { lat: c.lat, lng: c.lng, name: 'مركز الخريطة' };
  }
  $('btnImgAdd').onclick = run('صورة', async function () {
    await poll(); needMap();
    var file = $('imgPath').value.trim().replace(/^"|"$/g, '');
    if (!file) throw new Error('اختر صورة أولاً');
    var at = placeOf();
    var r = await host('geoAddImage', { file: file.replace(/\\/g, '/'), lat: at.lat, lng: at.lng, size: parseFloat($('imgSize').value) || 220,
      scaleWithMap: $('imgScale').checked, shadow: $('imgShadow').checked });
    log('أُضيفت الصورة على «' + at.name + '» (' + r + ')');
  });
  $('btnFlag').onclick = run('العلم', async function () {
    await poll(); needMap();
    var list = selected().filter(function (f) { return f.cc; });
    if (!list.length) throw new Error('حدّد دولة أو مكاناً أُضيف من البحث أو التحديد بالنقر (يحتاج رمز الدولة)');
    for (var i = 0; i < list.length; i++) {
      var f = list[i], cc = f.cc.toLowerCase(), p = pathM.join(workDir('assets'), 'flag_' + cc + '.png');
      if (!fs.existsSync(p)) {
        var res = await fetch('https://flagcdn.com/w640/' + cc + '.png');
        if (!res.ok) throw new Error('لم أجد علم ' + cc);
        fs.writeFileSync(p, BufferC.from(await res.arrayBuffer()));
      }
      await host('geoAddImage', { file: p.replace(/\\/g, '/'), lat: f.lat, lng: f.lng, size: parseFloat($('imgSize').value) || 160,
        scaleWithMap: $('imgScale').checked, shadow: true, name: 'علم ' + f.name });
    }
    log('أُضيفت ' + list.length + ' أعلام');
  });

  // ---------- map furniture ----------
  $('btnNorth').onclick = run('الشمال', async function () { await poll(); needMap(); await host('geoAddNorthArrow', { font: labelFont() }); log('أُضيف سهم الشمال (يدور مع الخريطة)'); });
  $('btnVignette').onclick = run('Vignette', async function () { await poll(); needMap(); await host('geoAddVignette', {}); log('أُضيف إطار معتم (GEO Vignette)'); });
  $('btnLegend').onclick = run('الدليل', async function () {
    await poll(); needMap();
    var items = selected().map(function (f) { return { name: f.name, color: hexToRgb(f.fillColor || f.color) }; });
    if (!items.length) throw new Error('حدّد المعالم التي تظهر في الدليل');
    await host('geoAddLegend', { items: items.slice(0, 12), font: labelFont() });
    log('أُضيف دليل ألوان بـ ' + Math.min(12, items.length) + ' عناصر');
  });
  $('freeCam').addEventListener('change', run('الكاميرا الحرة', async function () {
    await poll(); needMap();
    await host('geoSetFreeCam', { on: $('freeCam').checked });
    log($('freeCam').checked ? 'الكاميرا حرة: حرّك «GEO Camera» في AE بأدوات الكاميرا (C) والكيفريمات' : 'عادت الكاميرا لتتبع Pitch / Roll من اللوحة');
  }));

  // ---------- init ----------
  renderBms(); fillPathSelect();
  renderFeatures(); renderFavs(); hud(); syncFields(); updateHints(); moveHint(); $('curStyle').textContent = styleName();
  if (inCEP) evalScript('geoPing()').then(function (r) { log('After Effects ' + String(r).replace('OK|', '')); });
  else log('وضع معاينة المتصفح: أوامر AE تعمل فقط داخل After Effects');
})();
