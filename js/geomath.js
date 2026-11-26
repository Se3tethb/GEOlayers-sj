/*
 * GeoMotion math core.
 * Web Mercator projection, camera interpolation (direct + fly), base-image planning,
 * per-frame baking for After Effects, and Douglas-Peucker simplification.
 * Works in the CEP panel (window.GeoMath) and in Node (module.exports) for tests.
 *
 * Units:
 *   merc   = normalised Web Mercator, x,y in [0,1], y grows southward (same as tiles).
 *   zoom   = MapLibre zoom, world width = TILE * 2^zoom pixels (TILE = 512).
 *   "comp zoom" = the zoom at which the AE comp width shows exactly what the panel frame showed.
 */
(function (root) {
  'use strict';

  var TILE = 512;
  var MAX_LAT = 85.0511287798066;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function lngLatToMerc(lng, lat) {
    var la = clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI / 180;
    return [
      (lng + 180) / 360,
      (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2
    ];
  }

  function mercToLngLat(x, y) {
    var n = Math.PI - 2 * Math.PI * y;
    return [x * 360 - 180, 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
  }

  function worldSize(zoom) { return TILE * Math.pow(2, zoom); }

  // ---------- easing ----------
  var EASE = {
    linear: function (u) { return u; },
    inout: function (u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; },
    'in': function (u) { return u * u * u; },
    out: function (u) { return 1 - Math.pow(1 - u, 3); }
  };

  function shortestAngle(a, b) {
    var d = ((b - a) % 360 + 540) % 360 - 180;
    return d;
  }

  /*
   * Segment between two views A -> B, parameter e in [0,1] (already eased).
   * mode 'direct': zoom changes linearly while the screen zooms about a fixed point,
   *                so the destination never drifts off screen (no "swimming").
   * mode 'fly'   : van Wijk & Nuij optimal path (same idea as MapLibre flyTo): zoom out, travel, zoom in.
   * viewportPx   : max(compW, compH), the viewport size in pixels at comp zoom.
   */
  function interpSegment(A, B, e, mode, viewportPx) {
    var a = lngLatToMerc(A.lng, A.lat), b = lngLatToMerc(B.lng, B.lat);
    var zA = A.zoom, zB = B.zoom;
    var out = {
      bearing: A.bearing + shortestAngle(A.bearing, B.bearing) * e,
      pitch: A.pitch + (B.pitch - A.pitch) * e
    };
    var mx, my, z;

    if (mode === 'fly') {
      var rho = 1.42, rho2 = rho * rho;
      var wsA = worldSize(zA);
      var u1 = Math.sqrt(Math.pow((b[0] - a[0]) * wsA, 2) + Math.pow((b[1] - a[1]) * wsA, 2));
      var w0 = viewportPx;
      var w1 = w0 / Math.pow(2, zB - zA);
      if (u1 > 1e-6) {
        var r = function (i) {
          var bb = (w1 * w1 - w0 * w0 + (i ? -1 : 1) * rho2 * rho2 * u1 * u1) /
                   (2 * (i ? w1 : w0) * rho2 * u1);
          return Math.log(Math.sqrt(bb * bb + 1) - bb);
        };
        var r0 = r(0), S = (r(1) - r0) / rho;
        if (isFinite(S) && S > 0) {
          var s = e * S;
          var frac = (w0 * ((Math.cosh(r0) * Math.tanh(r0 + rho * s) - Math.sinh(r0)) / rho2)) / u1;
          var w = w0 * (Math.cosh(r0) / Math.cosh(r0 + rho * s));
          z = zA + Math.log(w0 / w) / Math.LN2;
          if (e >= 1) { frac = 1; z = zB; }
          out.mx = a[0] + (b[0] - a[0]) * frac;
          out.my = a[1] + (b[1] - a[1]) * frac;
          out.zoom = z;
          return out;
        }
      }
      // degenerate distance: fall through to direct
    }

    z = zA + (zB - zA) * e;
    var f;
    if (Math.abs(zB - zA) < 1e-4) {
      f = e;
    } else {
      // fixed-point zoom: c(s) = c0 + (c1-c0) * (1/s - 1)/(1/s1 - 1), s = 2^(z-zA)
      var s1 = Math.pow(2, zB - zA), sc = Math.pow(2, z - zA);
      f = (1 / sc - 1) / (1 / s1 - 1);
    }
    out.mx = a[0] + (b[0] - a[0]) * f;
    out.my = a[1] + (b[1] - a[1]) * f;
    out.zoom = z;
    return out;
  }

  /* keyframes sorted by t. Each: {t,lng,lat,zoom,bearing,pitch,ease,path}. ease/path describe the ARRIVAL at that key. */
  function viewAt(keys, t, viewportPx) {
    if (!keys.length) return null;
    var k0 = keys[0];
    if (keys.length === 1 || t <= k0.t) {
      var m0 = lngLatToMerc(k0.lng, k0.lat);
      return { mx: m0[0], my: m0[1], zoom: k0.zoom, bearing: k0.bearing, pitch: k0.pitch };
    }
    var last = keys[keys.length - 1];
    if (t >= last.t) {
      var ml = lngLatToMerc(last.lng, last.lat);
      return { mx: ml[0], my: ml[1], zoom: last.zoom, bearing: last.bearing, pitch: last.pitch };
    }
    for (var i = 0; i < keys.length - 1; i++) {
      var A = keys[i], B = keys[i + 1];
      if (t >= A.t && t <= B.t) {
        var dur = B.t - A.t;
        var u = dur > 0 ? (t - A.t) / dur : 1;
        var ease = EASE[B.ease] || EASE.inout;
        return interpSegment(A, B, ease(u), B.path || 'direct', viewportPx);
      }
    }
    return null;
  }

  /*
   * Plan the base image: the union of everything any frame will show, rendered at one zoom (zb)
   * whose pixel size stays under `limitPx`. Samples the baked path so fly arcs are covered.
   */
  function planBase(keys, comp, limitPx, marginFactor) {
    var vp = Math.max(comp.w, comp.h);
    var t0 = keys[0].t, t1 = keys[keys.length - 1].t;
    var n = Math.max(2, Math.ceil((t1 - t0) * 10));
    var views = [];
    for (var i = 0; i <= n; i++) views.push(viewAt(keys, t0 + (t1 - t0) * i / n, vp));
    return planFromViews(views, comp, limitPx, marginFactor);
  }

  /* views: [{mx,my,zoom,pitch}] — e.g. every frame sampled from the AE camera */
  function planFromViews(views, comp, limitPx, marginFactor) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    var margin = marginFactor || 1.15;
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      var ws = worldSize(v.zoom);
      // radius that covers any bearing. With pitch, the top edge of the frame reaches
      // D*cos(p)*tan(p+fov/2) - D*sin(p) ahead of the centre (D = 1.5h); beyond ~71.6 deg the top is sky.
      var r = Math.sqrt(comp.w * comp.w + comp.h * comp.h) / 2;
      if (v.pitch > 0.5) {
        var Dc = 1.5 * comp.h, P = Math.min(v.pitch, 70) * Math.PI / 180;
        var reach = Dc * Math.cos(P) * Math.tan(P + 18.435 * Math.PI / 180) - Dc * Math.sin(P);
        var halfW = comp.w / 2 * (1 + reach / comp.h);
        r = Math.max(r, Math.sqrt(reach * reach + halfW * halfW));
      }
      r *= margin;
      var rm = r / ws;
      if (v.mx - rm < minX) minX = v.mx - rm;
      if (v.mx + rm > maxX) maxX = v.mx + rm;
      if (v.my - rm < minY) minY = v.my - rm;
      if (v.my + rm > maxY) maxY = v.my + rm;
      if (v.zoom > maxZ) maxZ = v.zoom;
    }
    minX = clamp(minX, 0, 1); maxX = clamp(maxX, 0, 1);
    minY = clamp(minY, 0, 1); maxY = clamp(maxY, 0, 1);
    var span = Math.max(maxX - minX, maxY - minY);
    var zb = Math.log(limitPx / (span * TILE)) / Math.LN2;
    if (zb > maxZ) zb = maxZ;
    var ws0 = worldSize(zb);
    var W = Math.max(16, Math.min(limitPx, Math.ceil((maxX - minX) * ws0)));
    var H = Math.max(16, Math.min(limitPx, Math.ceil((maxY - minY) * ws0)));
    var cm = [minX + (maxX - minX) / 2, minY + (maxY - minY) / 2];
    return {
      zb: zb, maxZoom: maxZ,
      // top-left in world px at zb, derived from the centre so a W x H render at zb covers it exactly
      x0: cm[0] * ws0 - W / 2, y0: cm[1] * ws0 - H / 2,
      w: W, h: H,
      centerMerc: cm
    };
  }

  /* merc -> pixel inside the base/world comp */
  function mercToWorldPx(base, mx, my) {
    var ws = worldSize(base.zb);
    return [mx * ws - base.x0, my * ws - base.y0];
  }

  /*
   * Bake every frame into AE transforms of the "GEO World" precomp layer
   * (anchor in world px, uniform scale %, Z rotation) and the tilt null X rotation.
   */
  function bakeFrames(keys, comp, base, pitchSign) {
    var vp = Math.max(comp.w, comp.h);
    var nFrames = Math.round(comp.duration * comp.fps);
    var times = [], anchor = [], scale = [], rot = [], tilt = [], zoom = [];
    var prevRot = null;
    for (var f = 0; f <= nFrames; f++) {
      var t = f / comp.fps;
      var v = viewAt(keys, t, vp);
      var p = mercToWorldPx(base, v.mx, v.my);
      var r = -v.bearing;
      if (prevRot !== null) r = prevRot + shortestAngle(prevRot, r); // keep rotation continuous
      prevRot = r;
      times.push(t);
      anchor.push([round3(p[0]), round3(p[1]), 0]);
      var s = 100 * Math.pow(2, v.zoom - base.zb);
      scale.push(round4(s));
      rot.push(round3(r));
      tilt.push(round3((pitchSign || -1) * v.pitch));
      zoom.push(v.zoom);
    }
    return { times: times, anchor: anchor, scale: scale, rot: rot, tilt: tilt, zoom: zoom };
  }

  function round3(v) { return Math.round(v * 1000) / 1000; }
  function round4(v) { return Math.round(v * 10000) / 10000; }

  // ---------- Douglas-Peucker ----------
  function simplify(pts, tol) {
    if (pts.length <= 2) return pts.slice();
    var tol2 = tol * tol;
    var keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var seg = stack.pop(), s = seg[0], e = seg[1];
      var ax = pts[s][0], ay = pts[s][1], bx = pts[e][0], by = pts[e][1];
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      var maxD = -1, idx = -1;
      for (var i = s + 1; i < e; i++) {
        var px = pts[i][0] - ax, py = pts[i][1] - ay, d2;
        if (len2 === 0) { d2 = px * px + py * py; }
        else {
          var tt = clamp((px * dx + py * dy) / len2, 0, 1);
          var qx = px - tt * dx, qy = py - tt * dy;
          d2 = qx * qx + qy * qy;
        }
        if (d2 > maxD) { maxD = d2; idx = i; }
      }
      if (maxD > tol2 && idx > 0) {
        keep[idx] = 1;
        stack.push([s, idx], [idx, e]);
      }
    }
    var out = [];
    for (var j = 0; j < pts.length; j++) if (keep[j]) out.push(pts[j]);
    return out;
  }

  function ringArea(pts) {
    var a = 0;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  }

  /*
   * GeoJSON geometry -> AE paths in world px. Handles (Multi)Polygon and (Multi)LineString.
   * tol: simplification tolerance in world px; minArea: drop rings smaller than this (px^2).
   */
  function geometryToPaths(geom, base, tol, minArea) {
    var paths = [];
    function line(coords, closed) {
      var pts = [];
      for (var i = 0; i < coords.length; i++) {
        var m = lngLatToMerc(coords[i][0], coords[i][1]);
        var p = mercToWorldPx(base, m[0], m[1]);
        pts.push([p[0], p[1]]);
      }
      if (closed && pts.length > 1) {
        var f = pts[0], l = pts[pts.length - 1];
        if (f[0] === l[0] && f[1] === l[1]) pts.pop();
        if (ringArea(pts) < minArea) return;
      }
      var sp = simplify(pts, tol);
      if (sp.length < 2) return;
      paths.push({ closed: !!closed, v: sp.map(function (p) { return [round3(p[0]), round3(p[1])]; }) });
    }
    if (!geom) return paths;
    var c = geom.coordinates;
    switch (geom.type) {
      case 'Polygon': c.forEach(function (r) { line(r, true); }); break;
      case 'MultiPolygon': c.forEach(function (poly) { poly.forEach(function (r) { line(r, true); }); }); break;
      case 'LineString': line(c, false); break;
      case 'MultiLineString': c.forEach(function (l) { line(l, false); }); break;
      case 'GeometryCollection': geom.geometries.forEach(function (g) { paths = paths.concat(geometryToPaths(g, base, tol, minArea)); }); break;
    }
    return paths;
  }

  /*
   * Draw-on for 3D frame mode: keep the first `frac` (0..1) of every line/ring of a geometry,
   * like AE Trim Paths with "simultaneously". Returns a MultiLineString (rings become open lines).
   */
  function trimGeometry(geom, frac) {
    var lines = [];
    function collect(g) {
      if (!g) return;
      var c = g.coordinates;
      switch (g.type) {
        case 'Polygon': c.forEach(function (r) { lines.push(r); }); break;
        case 'MultiPolygon': c.forEach(function (p) { p.forEach(function (r) { lines.push(r); }); }); break;
        case 'LineString': lines.push(c); break;
        case 'MultiLineString': c.forEach(function (l) { lines.push(l); }); break;
        case 'GeometryCollection': g.geometries.forEach(collect); break;
      }
    }
    collect(geom);
    frac = clamp(frac, 0, 1);
    var out = [];
    lines.forEach(function (l) {
      if (frac >= 1) { out.push(l); return; }
      if (frac <= 0 || l.length < 2) return;
      var lens = [0], total = 0, i;
      for (i = 1; i < l.length; i++) {
        var dx = l[i][0] - l[i - 1][0], dy = l[i][1] - l[i - 1][1];
        total += Math.sqrt(dx * dx + dy * dy); lens.push(total);
      }
      var target = total * frac, part = [l[0]];
      for (i = 1; i < l.length; i++) {
        if (lens[i] <= target) { part.push(l[i]); continue; }
        var seg = lens[i] - lens[i - 1], u = seg > 0 ? (target - lens[i - 1]) / seg : 0;
        part.push([l[i - 1][0] + (l[i][0] - l[i - 1][0]) * u, l[i - 1][1] + (l[i][1] - l[i - 1][1]) * u]);
        break;
      }
      if (part.length > 1) out.push(part);
    });
    return { type: 'MultiLineString', coordinates: out };
  }

  /* zoom that fits a lng/lat bbox [w,s,e,n] in a comp (comp zoom), with padding fraction */
  function fitZoom(bbox, comp, pad) {
    var a = lngLatToMerc(bbox[0], bbox[3]), b = lngLatToMerc(bbox[2], bbox[1]);
    var dx = Math.max(1e-9, b[0] - a[0]), dy = Math.max(1e-9, b[1] - a[1]);
    var f = 1 - 2 * (pad === undefined ? 0.1 : pad);
    var z = Math.min(Math.log(comp.w * f / (dx * TILE)), Math.log(comp.h * f / (dy * TILE))) / Math.LN2;
    var c = mercToLngLat((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    return { lng: c[0], lat: c[1], zoom: Math.min(z, 18) };
  }

  function geomBBox(geom) {
    var b = [Infinity, Infinity, -Infinity, -Infinity];
    (function walk(c) {
      if (typeof c[0] === 'number') {
        if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
        return;
      }
      for (var i = 0; i < c.length; i++) walk(c[i]);
    })(geom.type === 'GeometryCollection' ? geom.geometries.map(function (g) { return g.coordinates; }) : geom.coordinates);
    return b;
  }

  /* curved arrow path between two world-px points (bend = fraction of length, + is left) */
  function arcPath(a, b, bend) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var mx = (a[0] + b[0]) / 2 - dy * bend, my = (a[1] + b[1]) / 2 + dx * bend;
    // quadratic -> cubic tangents
    var c1 = [(mx - a[0]) * 2 / 3, (my - a[1]) * 2 / 3], c2 = [(mx - b[0]) * 2 / 3, (my - b[1]) * 2 / 3];
    return { closed: false, v: [[round3(a[0]), round3(a[1])], [round3(b[0]), round3(b[1])]],
      inT: [[0, 0], [round3(c2[0]), round3(c2[1])]], outT: [[round3(c1[0]), round3(c1[1])], [0, 0]] };
  }

  var api = {
    trimGeometry: trimGeometry, planFromViews: planFromViews, fitZoom: fitZoom, geomBBox: geomBBox, arcPath: arcPath,
    TILE: TILE, lngLatToMerc: lngLatToMerc, mercToLngLat: mercToLngLat, worldSize: worldSize,
    EASE: EASE, shortestAngle: shortestAngle, interpSegment: interpSegment, viewAt: viewAt,
    planBase: planBase, mercToWorldPx: mercToWorldPx, bakeFrames: bakeFrames,
    simplify: simplify, geometryToPaths: geometryToPaths
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GeoMath = api;
})(typeof window !== 'undefined' ? window : null);
