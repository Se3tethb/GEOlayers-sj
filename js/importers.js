/* GeoMotion file importers: GeoJSON, KML, GPX, CSV/TSV -> [{name, geom}] */
(function (root) {
  'use strict';

  function fromGeoJSON(obj) {
    var out = [];
    function add(f, i) {
      if (!f) return;
      if (f.type === 'Feature') {
        if (f.geometry) out.push({ name: pickName(f.properties) || ('Feature ' + (i + 1)), geom: f.geometry, props: f.properties || {} });
      } else if (f.type === 'FeatureCollection') {
        f.features.forEach(add);
      } else if (f.coordinates || f.geometries) {
        out.push({ name: f.type + ' ' + (i + 1), geom: f, props: {} });
      }
    }
    add(obj, 0);
    return out;
  }
  function pickName(p) {
    if (!p) return null;
    return p['name:ar'] || p.name || p.NAME || p.Name || p.title || p.ADMIN || p.NAME_AR || null;
  }

  function coordsText(txt) {
    return txt.trim().split(/\s+/).map(function (t) {
      var c = t.split(',').map(parseFloat);
      return [c[0], c[1]];
    }).filter(function (c) { return isFinite(c[0]) && isFinite(c[1]); });
  }
  function fromKML(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var out = [];
    var pms = doc.getElementsByTagName('Placemark');
    for (var i = 0; i < pms.length; i++) {
      var pm = pms[i];
      var nameEl = pm.getElementsByTagName('name')[0];
      var name = nameEl ? nameEl.textContent.trim() : 'Placemark ' + (i + 1);
      var geoms = [];
      var polys = pm.getElementsByTagName('Polygon');
      for (var p = 0; p < polys.length; p++) {
        var rings = [];
        var outer = polys[p].getElementsByTagName('outerBoundaryIs')[0];
        var inners = polys[p].getElementsByTagName('innerBoundaryIs');
        if (outer) rings.push(coordsText(outer.getElementsByTagName('coordinates')[0].textContent));
        for (var q = 0; q < inners.length; q++) rings.push(coordsText(inners[q].getElementsByTagName('coordinates')[0].textContent));
        if (rings.length) geoms.push({ type: 'Polygon', coordinates: rings });
      }
      var lines = pm.getElementsByTagName('LineString');
      for (var l = 0; l < lines.length; l++) geoms.push({ type: 'LineString', coordinates: coordsText(lines[l].getElementsByTagName('coordinates')[0].textContent) });
      var tracks = pm.getElementsByTagNameNS ? pm.getElementsByTagNameNS('*', 'coord') : [];
      if (tracks.length) {
        var tc = [];
        for (var t = 0; t < tracks.length; t++) { var c = tracks[t].textContent.trim().split(/\s+/).map(parseFloat); tc.push([c[0], c[1]]); }
        geoms.push({ type: 'LineString', coordinates: tc });
      }
      if (!geoms.length) {
        var pt = pm.getElementsByTagName('Point')[0];
        if (pt) geoms.push({ type: 'Point', coordinates: coordsText(pt.getElementsByTagName('coordinates')[0].textContent)[0] });
      }
      if (!geoms.length) continue;
      out.push({ name: name, geom: geoms.length === 1 ? geoms[0] : { type: 'GeometryCollection', geometries: geoms }, props: {} });
    }
    return out;
  }

  function fromGPX(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var out = [];
    function pts(nodes) {
      var a = [];
      for (var i = 0; i < nodes.length; i++) a.push([parseFloat(nodes[i].getAttribute('lon')), parseFloat(nodes[i].getAttribute('lat'))]);
      return a;
    }
    var trks = doc.getElementsByTagName('trk');
    for (var i = 0; i < trks.length; i++) {
      var segs = trks[i].getElementsByTagName('trkseg'), lines = [];
      for (var s = 0; s < segs.length; s++) lines.push(pts(segs[s].getElementsByTagName('trkpt')));
      var nm = trks[i].getElementsByTagName('name')[0];
      out.push({ name: nm ? nm.textContent : 'Track ' + (i + 1), geom: { type: 'MultiLineString', coordinates: lines }, props: {} });
    }
    var rtes = doc.getElementsByTagName('rte');
    for (var r = 0; r < rtes.length; r++) {
      var rn = rtes[r].getElementsByTagName('name')[0];
      out.push({ name: rn ? rn.textContent : 'Route ' + (r + 1), geom: { type: 'LineString', coordinates: pts(rtes[r].getElementsByTagName('rtept')) }, props: {} });
    }
    var wpts = doc.getElementsByTagName('wpt');
    for (var w = 0; w < wpts.length; w++) {
      var wn = wpts[w].getElementsByTagName('name')[0];
      out.push({ name: wn ? wn.textContent : 'Point ' + (w + 1),
        geom: { type: 'Point', coordinates: [parseFloat(wpts[w].getAttribute('lon')), parseFloat(wpts[w].getAttribute('lat'))] }, props: {} });
    }
    return out;
  }

  function splitCSVLine(line, sep) {
    var out = [], cur = '', q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === sep && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function fromCSV(text) {
    var lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (lines.length < 2) return [];
    var head = lines[0];
    var sep = head.indexOf('\t') >= 0 ? '\t' : (head.split(';').length > head.split(',').length ? ';' : ',');
    var cols = splitCSVLine(head, sep).map(function (c) { return c.toLowerCase(); });
    var find = function (names) { for (var i = 0; i < cols.length; i++) if (names.indexOf(cols[i]) >= 0) return i; return -1; };
    var la = find(['lat', 'latitude', 'y', 'خط العرض']), lo = find(['lon', 'lng', 'long', 'longitude', 'x', 'خط الطول']);
    var nm = find(['name', 'title', 'label', 'الاسم', 'اسم']);
    if (la < 0 || lo < 0) throw new Error('CSV needs lat and lon columns');
    var out = [];
    for (var i = 1; i < lines.length; i++) {
      var c = splitCSVLine(lines[i], sep);
      var lat = parseFloat(c[la]), lon = parseFloat(c[lo]);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      var props = {};
      cols.forEach(function (k, j) { props[k] = c[j]; });
      out.push({ name: nm >= 0 ? c[nm] : 'Point ' + i, geom: { type: 'Point', coordinates: [lon, lat] }, props: props });
    }
    return out;
  }

  function parseFile(name, text) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'kml') return fromKML(text);
    if (ext === 'gpx') return fromGPX(text);
    if (ext === 'csv' || ext === 'tsv') return fromCSV(text);
    return fromGeoJSON(JSON.parse(text));
  }

  var api = { parseFile: parseFile, fromGeoJSON: fromGeoJSON, fromKML: fromKML, fromGPX: fromGPX, fromCSV: fromCSV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GeoImport = api;
})(typeof window !== 'undefined' ? window : null);
