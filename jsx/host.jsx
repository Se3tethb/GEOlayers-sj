/*
 * GeoMotion — After Effects host script (ExtendScript / ES3).
 *
 * Map Comp structure (GEOlayers-style workflow):
 *   <name>                      main comp (unique name; the World expressions refer to it)
 *     GEO Camera                3D camera; orbits the map centre by Pitch (same model as MapLibre: D = h/2/tan(fov/2))
 *     GEO Map Controls          null with 5 keyframable sliders: Latitude, Longitude, Zoom, Bearing, Pitch
 *     GEO Map Anchor            3D null parented to the map: parent your own 3D layers here
 *     GEO World                 3D precomp, Collapse Transformations ON; anchor/scale/rotation by expression
 *   <name> World                precomp in a FIXED reference space (zoom ZR, origin X0/Y0):
 *                               imagery plates (replaced by Finalize), borders, arrows
 * Pinned layers (labels, images) live in the main comp and follow a lat/lon via toComp()/toWorld().
 *
 * The panel talks to these functions with JSON job files on disk; results come back as "OK|..." / "ERR|...".
 * Every job carries compId so a long Finalize never lands in a different comp than the one it sampled.
 */

var GEO_TILE = 512;

function geoPing() { return "OK|" + app.version; }

function geoReadJob(path) {
    var f = new File(path);
    f.encoding = "UTF-8";
    if (!f.open("r")) throw new Error("تعذّر فتح ملف المهمة: " + path);
    var txt = f.read();
    f.close();
    return eval("(" + txt + ")");
}
function geoWriteFile(path, txt) {
    var f = new File(path);
    f.encoding = "UTF-8";
    f.open("w"); f.write(txt); f.close();
}
function geoEsc(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function geoNum(v) { return Math.round(v * 1e6) / 1e6; }
function geoErr(step, e) { return "ERR|" + (step ? step + ": " : "") + e.toString() + (e.line ? " (line " + e.line + ")" : ""); }

function geoImport(proj, path, folder, sequence) {
    var io = new ImportOptions(new File(path));
    if (sequence) { io.sequence = true; io.forceAlphabetical = true; }
    var item = proj.importFile(io);
    if (folder) item.parentFolder = folder;
    return item;
}

// ---------- find the map comp ----------
function geoMeta(comp) {
    if (!comp || !(comp instanceof CompItem)) return null;
    var m = /GEOMOTION;ZR=([-\d.e]+);X0=([-\d.e]+);Y0=([-\d.e]+)/.exec(comp.comment || "");
    if (!m) return null;
    var st = /STYLE=([^;]*)/.exec(comp.comment);
    return { zr: parseFloat(m[1]), x0: parseFloat(m[2]), y0: parseFloat(m[3]), style: st ? st[1] : "" };
}
function geoActiveMap() {
    var c = app.project ? app.project.activeItem : null;
    var meta = geoMeta(c);
    if (meta) { meta.comp = c; return meta; }
    // the World precomp may be the active one
    if (c && c instanceof CompItem) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            var mm = geoMeta(it);
            if (mm) {
                for (var l = 1; l <= it.numLayers; l++) if (it.layer(l).source === c) { mm.comp = it; return mm; }
            }
        }
    }
    return null;
}
// the comp a job was prepared for (by id), else the active map comp
function geoMapFor(J) {
    if (J && J.compId) {
        var it = null;
        try { it = app.project.itemByID(J.compId); } catch (e) {}
        var m = geoMeta(it);
        if (!m) throw new Error("لم يعد Map Comp الذي جُهّزت له هذه العملية موجوداً.");
        m.comp = it;
        return m;
    }
    var a = geoActiveMap();
    if (!a) throw new Error("افتح Map Comp في After Effects أولاً.");
    return a;
}
function geoControls(comp) { return comp.layer("GEO Map Controls"); }
function geoSlider(ctrl, name) { return ctrl.property("ADBE Effect Parade").property(name).property(1); }
function geoWorldComp(mainComp) { return mainComp.layer("GEO World").source; }

function geoUniqueName(base) {
    var name = base, n = 1, taken = {};
    for (var i = 1; i <= app.project.numItems; i++) taken[app.project.item(i).name] = true;
    while (taken[name] || taken[name + " World"]) { n++; name = base + " " + n; }
    return name;
}

// ---------- expressions (property values always read with .value) ----------
var GEO_CTRL = 'thisComp.layer("GEO Map Controls")';
function geoMercFn() {
    return "function merc(lon,lat){lat=Math.max(-85.05112878,Math.min(85.05112878,lat));var r=lat*Math.PI/180;" +
           "return [(lon+180)/360,(1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2];}";
}
function geoAnchorExpr(meta) {
    // map centre with "fixed-point" zoom between keys, so a zoom never swims off target
    return geoMercFn() +
        'var C=' + GEO_CTRL + ';var Z=C.effect("Zoom")(1),LA=C.effect("Latitude")(1),LO=C.effect("Longitude")(1);' +
        'var m=merc(LO.value,LA.value);var n=Z.numKeys;' +
        'if(n>=2&&LA.numKeys==n&&LO.numKeys==n&&time>Z.key(1).time&&time<Z.key(n).time){' +
        ' var i=1;while(i<n-1&&Z.key(i+1).time<=time)i++;' +
        ' var z0=Z.key(i).value,z1=Z.key(i+1).value,z=Z.value;' +
        ' var a=merc(LO.key(i).value,LA.key(i).value),b=merc(LO.key(i+1).value,LA.key(i+1).value);var f;' +
        ' if(Math.abs(z1-z0)>1e-4){f=(Math.pow(2,-(z-z0))-1)/(Math.pow(2,-(z1-z0))-1);}' +
        ' else{var dl=LO.key(i+1).value-LO.key(i).value,da=LA.key(i+1).value-LA.key(i).value;' +
        '  f=Math.abs(dl)>=Math.abs(da)?(Math.abs(dl)>1e-12?(LO.value-LO.key(i).value)/dl:0):(LA.value-LA.key(i).value)/da;}' +
        ' m=[a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f];}' +
        'var ws=' + GEO_TILE + '*Math.pow(2,' + meta.zr + ');[m[0]*ws-(' + meta.x0 + '),m[1]*ws-(' + meta.y0 + '),0];';
}
function geoScaleExpr(meta) {
    return 'var s=100*Math.pow(2,' + GEO_CTRL + '.effect("Zoom")(1).value-(' + meta.zr + '));[s,s,s];';
}
function geoMapScaleSnippet(mainName) {
    // factor between World precomp pixels and screen pixels right now
    return 'var s=comp("' + geoEsc(mainName) + '").layer("GEO World").transform.scale.value[0]/100;';
}
function geoZoomSnippet(mainName) {
    return 'var z=comp("' + geoEsc(mainName) + '").layer("GEO Map Controls").effect("Zoom")(1).value;';
}
function geoEase(p, i) {
    p.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    var e = new KeyframeEase(0, 66);
    p.setTemporalEaseAtKey(i, [e], [e]);
}

// ---------- create the map comp ----------
function geoCreateMapComp(jobPath) {
    var step = "read job";
    try {
        var J = geoReadJob(jobPath);
        app.beginUndoGroup("GeoMotion: create map comp");
        var proj = app.project || app.newProject();
        var C = J.comp, meta = { zr: J.zr, x0: J.x0, y0: J.y0 };
        var name = geoUniqueName(J.name);

        step = "comps";
        var folder = proj.items.addFolder("GeoMotion - " + name);
        var world = proj.items.addComp(name + " World", J.worldW, J.worldH, 1, C.duration, C.fps);
        world.parentFolder = folder;
        world.bgColor = [0, 0, 0];
        var main = proj.items.addComp(name, C.w, C.h, 1, C.duration, C.fps);
        main.parentFolder = folder;
        main.bgColor = [0, 0, 0];
        main.comment = "GEOMOTION;ZR=" + geoNum(meta.zr) + ";X0=" + geoNum(meta.x0) + ";Y0=" + geoNum(meta.y0) +
                       ";FOLDER=" + folder.id + ";STYLE=" + J.style;

        // controls first, so every expression below evaluates on creation
        step = "controls";
        var ctrl = main.layers.addNull(C.duration);
        ctrl.name = "GEO Map Controls";
        var names = ["Latitude", "Longitude", "Zoom", "Bearing", "Pitch"];
        var vals = [J.view.lat, J.view.lng, J.view.zoom, J.view.bearing, J.view.pitch];
        var i;
        for (i = 0; i < names.length; i++) main.layer("GEO Map Controls").property("ADBE Effect Parade").addProperty("ADBE Slider Control").name = names[i];
        for (i = 0; i < names.length; i++) geoSlider(main.layer("GEO Map Controls"), names[i]).setValue(vals[i]);

        step = "world layer";
        var wl = main.layers.add(world);
        wl.name = "GEO World";
        wl.threeDLayer = true;
        wl.collapseTransformation = true;
        var wtg = wl.property("ADBE Transform Group");
        wtg.property("ADBE Position").setValue([C.w / 2, C.h / 2, 0]);
        wtg.property("ADBE Anchor Point").expression = geoAnchorExpr(meta);
        wtg.property("ADBE Scale").expression = geoScaleExpr(meta);
        wtg.property("ADBE Rotate Z").expression = '-' + GEO_CTRL + '.effect("Bearing")(1).value';

        step = "anchor";
        var anc = main.layers.addNull(C.duration);
        anc.name = "GEO Map Anchor";
        anc.threeDLayer = true;
        anc.setParentWithJump(main.layer("GEO World"));     // no compensation offset: anchor sits in World pixels
        var atg = anc.property("ADBE Transform Group");
        atg.property("ADBE Anchor Point").setValue([50, 50, 0]);
        atg.property("ADBE Position").setValue([J.worldW / 2, J.worldH / 2, 0]);
        atg.property("ADBE Scale").setValue([100, 100, 100]);
        atg.property("ADBE Rotate Z").setValue(0);
        anc.comment = "Parent 3D layers here to stick them to the map.";

        step = "camera";
        var D = C.h / 2 / Math.tan(J.fovDeg / 2 * Math.PI / 180);
        var cam = main.layers.addCamera("GEO Camera", [C.w / 2, C.h / 2]);
        cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(D);
        var ctg = cam.property("ADBE Transform Group");
        ctg.property("ADBE Anchor Point").setValue([C.w / 2, C.h / 2, 0]);            // point of interest = map centre
        ctg.property("ADBE Position").expression =
            'var p=' + GEO_CTRL + '.effect("Pitch")(1).value*Math.PI/180;var D=' + geoNum(D) + ';' +
            '[' + (C.w / 2) + ',' + (C.h / 2) + '+D*Math.sin(p),-D*Math.cos(p)];';

        main.layer("GEO World").moveToEnd();
        app.endUndoGroup();
        try { main.openInViewer(); } catch (e2) {}
        return "OK|" + main.id + "|" + main.name;
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr(step, e);
    }
}

// ---------- link: state for the panel ----------
function geoGetState() {
    try {
        var M = geoActiveMap();
        if (!M) return "OK|{\"map\":false}";
        var c = M.comp, ctrl = geoControls(c);
        var names = ["Latitude", "Longitude", "Zoom", "Bearing", "Pitch"], v = [], i;
        // effective centre (what the anchor expression computes) so the panel matches AE exactly
        var a = c.layer("GEO World").property("ADBE Transform Group").property("ADBE Anchor Point").valueAtTime(c.time, false);
        var ws = GEO_TILE * Math.pow(2, M.zr);
        for (i = 0; i < names.length; i++) v.push(geoNum(geoSlider(ctrl, names[i]).valueAtTime(c.time, false)));
        var keys = [], Z = geoSlider(ctrl, "Zoom");
        for (i = 1; i <= Z.numKeys; i++) keys.push(geoNum(Z.keyTime(i)));
        return "OK|{\"map\":true,\"id\":" + c.id + ",\"zr\":" + M.zr + ",\"x0\":" + M.x0 + ",\"y0\":" + M.y0 +
               ",\"style\":\"" + geoEsc(M.style) + "\",\"name\":\"" + geoEsc(c.name) + "\",\"time\":" + geoNum(c.time) +
               ",\"w\":" + c.width + ",\"h\":" + c.height + ",\"fps\":" + c.frameRate + ",\"duration\":" + geoNum(c.duration) +
               ",\"mx\":" + geoNum((a[0] + M.x0) / ws) + ",\"my\":" + geoNum((a[1] + M.y0) / ws) +
               ",\"lat\":" + v[0] + ",\"lng\":" + v[1] + ",\"zoom\":" + v[2] + ",\"bearing\":" + v[3] + ",\"pitch\":" + v[4] +
               ",\"keys\":[" + keys.join(",") + "]}";
    } catch (e) { return geoErr("", e); }
}

// ---------- write camera keys ----------
// job: {compId, keys:[{t, lat,lng,zoom,bearing,pitch, linear}], relative}; t<0 means "at the playhead"
function geoSetKeys(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J);
        var c = M.comp, ctrl = geoControls(c);
        app.beginUndoGroup("GeoMotion: keyframe");
        var names = ["Latitude", "Longitude", "Zoom", "Bearing", "Pitch"], fields = ["lat", "lng", "zoom", "bearing", "pitch"];
        var base = c.time, i, k, n;
        var tOf = function (K) { return K.t < 0 ? base : (J.relative ? base + K.t : K.t); };
        for (n = 0; n < names.length; n++) {
            var p = geoSlider(ctrl, names[n]);
            for (k = 0; k < J.keys.length; k++) {
                var K = J.keys[k], t = tOf(K), val = K[fields[n]];
                if (names[n] === "Bearing" && p.numKeys > 0) { // continuous rotation, no 359->0 spins
                    var prev = p.valueAtTime(t, false);
                    val = prev + ((((val - prev) % 360) + 540) % 360 - 180);
                }
                p.setValueAtKey(p.addKey(t), val);
            }
            for (i = 1; i <= p.numKeys; i++) {
                var kt = p.keyTime(i), mine = -1;
                for (k = 0; k < J.keys.length; k++) if (Math.abs(tOf(J.keys[k]) - kt) < 1e-4) mine = k;
                if (mine < 0) continue;
                // baked in-between keys (fly path) are linear; the user's own keys get Easy Ease
                if (J.keys[mine].linear) p.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
                else geoEase(p, i);
            }
        }
        if (J.gotoAfter !== undefined) c.time = Math.max(0, Math.min(c.duration, base + J.gotoAfter));
        app.endUndoGroup();
        return "OK|" + J.keys.length;
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr("", e);
    }
}

// ---------- Finalize: sample every frame of the real camera ----------
function geoSample(outPath) {
    try {
        var M = geoActiveMap();
        if (!M) return "ERR|افتح Map Comp في After Effects أولاً.";
        var c = M.comp, ctrl = geoControls(c), A = c.layer("GEO World").property("ADBE Transform Group").property("ADBE Anchor Point");
        var Z = geoSlider(ctrl, "Zoom"), B = geoSlider(ctrl, "Bearing"), P = geoSlider(ctrl, "Pitch");
        var LA = geoSlider(ctrl, "Latitude"), LO = geoSlider(ctrl, "Longitude");
        var ws = GEO_TILE * Math.pow(2, M.zr), fd = c.frameDuration, n = Math.max(1, Math.round(c.duration / fd));
        var rows = [], keys = [], i;
        // AE quirk: a script's first evaluation of an expression must happen at the comp's current time
        try { A.valueAtTime(c.time, false); } catch (eW) {}
        for (i = 0; i < n; i++) {   // frames 0 .. n-1 (the comp's last frame starts at duration - frameDuration)
            var t = i * fd, a = A.valueAtTime(t, false);
            rows.push("[" + geoNum((a[0] + M.x0) / ws) + "," + geoNum((a[1] + M.y0) / ws) + "," + geoNum(Z.valueAtTime(t, false)) + "," +
                      geoNum(B.valueAtTime(t, false)) + "," + geoNum(P.valueAtTime(t, false)) + "]");
        }
        for (i = 1; i <= Z.numKeys; i++) {
            var kt = Z.keyTime(i);
            keys.push("[" + geoNum(LO.valueAtTime(kt, false)) + "," + geoNum(LA.valueAtTime(kt, false)) + "," + geoNum(Z.keyValue(i)) + "," + geoNum(P.valueAtTime(kt, false)) + "]");
        }
        if (!Z.numKeys) keys.push("[" + geoNum(LO.value) + "," + geoNum(LA.value) + "," + geoNum(Z.value) + "," + geoNum(P.value) + "]");
        var s = "{\"compId\":" + c.id + ",\"zr\":" + M.zr + ",\"x0\":" + M.x0 + ",\"y0\":" + M.y0 + ",\"w\":" + c.width + ",\"h\":" + c.height +
                ",\"fps\":" + c.frameRate + ",\"duration\":" + geoNum(c.duration) + ",\"name\":\"" + geoEsc(c.name) + "\"" +
                ",\"frames\":[" + rows.join(",") + "],\"keys\":[" + keys.join(",") + "]}";
        geoWriteFile(outPath, s);
        return "OK|" + n;
    } catch (e) { return geoErr("", e); }
}

// job: {compId, style, plates:[{file,x,y,scale,w,zoom,isBase}], seq:{first,count}|null}
function geoFinalize(jobPath) {
    var step = "read";
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J);
        var main = M.comp, world = geoWorldComp(main), proj = app.project, i;
        app.beginUndoGroup("GeoMotion: finalize");
        var folder = null;
        var fm = /FOLDER=(\d+)/.exec(main.comment);
        if (fm) { try { folder = proj.itemByID(parseInt(fm[1], 10)); } catch (e0) {} }
        if (J.style) main.comment = main.comment.replace(/STYLE=[^;]*/, "STYLE=" + J.style);

        step = "durations";   // the user may have lengthened the main comp
        world.duration = main.duration;
        for (i = 1; i <= main.numLayers; i++) {
            var ml = main.layer(i);
            if (/^GEO /.test(ml.name)) { try { ml.outPoint = main.duration; } catch (eD) {} }
        }

        step = "remove old imagery";
        for (i = world.numLayers; i >= 1; i--) if (world.layer(i).comment === "GEO IMAGERY") world.layer(i).remove();
        for (i = main.numLayers; i >= 1; i--) if (main.layer(i).comment === "GEO 3D RENDER") main.layer(i).remove();

        step = "plates";
        var zoomExpr = geoZoomSnippet(main.name);
        // plates come base-first then by zoom; add them in reverse so each moveToEnd leaves base at the bottom
        for (i = J.plates.length - 1; i >= 0; i--) {
            var P = J.plates[i];
            var item = geoImport(proj, P.file, folder, false);
            var L = world.layers.add(item);
            L.comment = "GEO IMAGERY";
            L.name = P.isBase ? "Map imagery (base)" : "Map imagery z" + Math.round(P.zoom * 10) / 10;
            var tg = L.property("ADBE Transform Group");
            tg.property("ADBE Position").setValue([P.x, P.y]);
            var sc = P.scale * (P.w / item.width);
            tg.property("ADBE Scale").setValue([sc, sc]);
            if (!P.isBase) tg.property("ADBE Opacity").expression = zoomExpr + ' linear(z,' + (P.zoom - 1.0) + ',' + (P.zoom - 0.4) + ',0,100);';
            L.moveToEnd();
        }

        if (J.seq) {
            step = "3D frames";
            var sItem = geoImport(proj, J.seq.first, folder, true);
            sItem.mainSource.conformFrameRate = main.frameRate;
            var sl = main.layers.add(sItem);
            sl.name = "GEO 3D Render";
            sl.comment = "GEO 3D RENDER";
            sl.moveToEnd();
            // World layer above it keeps borders/arrows; its imagery is replaced by the render
            for (i = 1; i <= world.numLayers; i++) if (world.layer(i).comment === "GEO IMAGERY") world.layer(i).enabled = false;
        }
        app.endUndoGroup();
        return "OK|" + J.plates.length + " صور" + (J.seq ? "، إطارات 3D: " + J.seq.count : "");
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr(step, e);
    }
}

// ---------- features: borders, lines, arrows ----------
// job: {compId, shapes:[{name, paths:[{closed,v,inT,outT}], stroke, strokeW, fill, fillOpacity, drawStart, drawEnd,
//        glow, dash, arrowHead, blend, opacity}], relative}
function geoAddShapes(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J);
        app.beginUndoGroup("GeoMotion: draw features");
        var world = geoWorldComp(M.comp), base = J.relative ? M.comp.time : 0;
        for (var i = 0; i < J.shapes.length; i++) geoAddShape(world, J.shapes[i], geoMapScaleSnippet(M.comp.name), base);
        app.endUndoGroup();
        return "OK|" + J.shapes.length;
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr("", e);
    }
}

function geoAddShape(world, S, SCALE_EXPR, t0) {
    var sl = world.layers.addShape();
    sl.name = S.name;
    sl.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
    sl.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
    sl.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Feature";
    var gc = function () { return sl.property("ADBE Root Vectors Group").property("Feature").property("ADBE Vectors Group"); };
    var i, hasClosed = false;
    for (i = 0; i < S.paths.length; i++) {
        var pg = gc().addProperty("ADBE Vector Shape - Group");
        pg.name = "Path " + (i + 1);
        var shp = new Shape();
        shp.vertices = S.paths[i].v;
        shp.closed = S.paths[i].closed;
        if (S.paths[i].inT) { shp.inTangents = S.paths[i].inT; shp.outTangents = S.paths[i].outT; }
        gc().property("Path " + (i + 1)).property("ADBE Vector Shape").setValue(shp);
        if (S.paths[i].closed) hasClosed = true;
    }
    var wantFill = hasClosed && S.fillOpacity > 0;
    gc().addProperty("ADBE Vector Filter - Trim").name = "Trim Paths 1";   // fixed names: expressions refer to them
    gc().addProperty("ADBE Vector Graphic - Stroke").name = "Stroke 1";
    if (wantFill) gc().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";

    var tEnd = gc().property("Trim Paths 1").property("ADBE Vector Trim End");
    if (S.drawEnd > S.drawStart) {
        tEnd.setValueAtTime(t0 + S.drawStart, 0);
        tEnd.setValueAtTime(t0 + S.drawEnd, 100);
        geoEase(tEnd, 1); geoEase(tEnd, 2);
    } else tEnd.setValue(100);

    var st = function () { return gc().property("Stroke 1"); };
    st().property("ADBE Vector Stroke Color").setValue(S.stroke);
    st().property("ADBE Vector Stroke Width").expression = SCALE_EXPR + " " + S.strokeW + " / s;";
    try { st().property("ADBE Vector Stroke Line Join").setValue(2); } catch (e) {}
    try { st().property("ADBE Vector Stroke Line Cap").setValue(2); } catch (e) {}
    if (S.dash) {
        try {
            var dashes = function () { return st().property("ADBE Vector Stroke Dashes"); };
            dashes().addProperty("ADBE Vector Stroke Dash 1");
            dashes().addProperty("ADBE Vector Stroke Gap 1");
            dashes().property("ADBE Vector Stroke Dash 1").expression = SCALE_EXPR + " " + (S.strokeW * 3) + " / s;";
            dashes().property("ADBE Vector Stroke Gap 1").expression = SCALE_EXPR + " " + (S.strokeW * 2) + " / s;";
        } catch (e) {}
    }
    if (wantFill) {
        var fl = gc().property("Fill 1");
        fl.property("ADBE Vector Fill Color").setValue(S.fill);
        var fo = gc().property("Fill 1").property("ADBE Vector Fill Opacity");
        var fs = t0 + (S.drawEnd > S.drawStart ? S.drawEnd : 0);
        fo.setValueAtTime(fs, 0);
        fo.setValueAtTime(fs + 0.6, S.fillOpacity);
    }
    if (S.glow) {
        try {
            sl.property("ADBE Effect Parade").addProperty("ADBE Glo2");
            var g = sl.property("ADBE Effect Parade").property(1);
            g.property("ADBE Glo2-0002").setValue(40);     // threshold %
            g.property("ADBE Glo2-0003").setValue(30);     // radius
            g.property("ADBE Glo2-0004").setValue(1.5);    // intensity
        } catch (e) {}
    }
    if (S.blend && BlendingMode[S.blend] !== undefined) { try { sl.blendingMode = BlendingMode[S.blend]; } catch (e) {} }
    if (S.opacity !== undefined && S.opacity < 100) sl.property("ADBE Transform Group").property("ADBE Opacity").setValue(S.opacity);
    if (S.arrowHead) geoAddArrowHead(sl, S, SCALE_EXPR);
    return sl;
}

// arrow head that rides the end of the trimmed path
function geoAddArrowHead(sl, S, SCALE_EXPR) {
    sl.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Head";
    var hv = function () { return sl.property("ADBE Root Vectors Group").property("Head").property("ADBE Vectors Group"); };
    var tri = new Shape();
    tri.vertices = [[0, 0], [-3.2, -1.6], [-3.2, 1.6]];
    tri.closed = true;
    hv().addProperty("ADBE Vector Shape - Group").name = "Path 1";
    hv().property("Path 1").property("ADBE Vector Shape").setValue(tri);
    hv().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
    hv().property("Fill 1").property("ADBE Vector Fill Color").setValue(S.stroke);
    var tr = sl.property("ADBE Root Vectors Group").property("Head").property("ADBE Vector Transform Group");
    var PATH = 'content("Feature").content("Path 1").path', TRIM = 'content("Feature").content("Trim Paths 1").end.value';
    tr.property("ADBE Vector Position").expression = 'var t=Math.max(0.001,' + TRIM + '/100);' + PATH + '.pointOnPath(t);';
    tr.property("ADBE Vector Rotation").expression = 'var t=Math.max(0.001,' + TRIM + '/100);var d=' + PATH + '.tangentOnPath(t);radiansToDegrees(Math.atan2(d[1],d[0]));';
    tr.property("ADBE Vector Scale").expression = SCALE_EXPR + ' var k=' + (S.strokeW * 100) + '/s;[k,k];';
    tr.property("ADBE Vector Group Opacity").expression = TRIM + '>0.5?100:0;';
}

// ---------- pin: labels & selected layers follow a lat/lon ----------
function geoPinExprPos(meta) {
    return geoMercFn() +
        'var m=merc(effect("Pin Longitude")(1).value,effect("Pin Latitude")(1).value);' +
        'var ws=' + GEO_TILE + '*Math.pow(2,' + meta.zr + ');var p=[m[0]*ws-(' + meta.x0 + '),m[1]*ws-(' + meta.y0 + '),0];' +
        'var w=thisComp.layer("GEO World");var o=[effect("Pin Offset X")(1).value,effect("Pin Offset Y")(1).value];' +
        'if(value.length==3){var r=w.toWorld(p);[r[0]+o[0],r[1]+o[1],r[2]];}else{var r=w.toComp(p);[r[0]+o[0],r[1]+o[1]];}';
}
function geoPinExprScale() {
    return 'var on=effect("Pin Scale With Map")(1).value==1;' +
           'var k=on?Math.pow(2,' + GEO_CTRL + '.effect("Zoom")(1).value-effect("Pin Zoom")(1).value):1;' +
           'value.length==3?[value[0]*k,value[1]*k,value[2]*k]:[value[0]*k,value[1]*k];';   // JS engine: no array*number
}
function geoPinLayer(L, lat, lng, zoom, meta, scaleWithMap) {
    var fxp = function () { return L.property("ADBE Effect Parade"); };
    var add = function (match, name, val) {
        if (!fxp().property(name)) fxp().addProperty(match).name = name;
        if (val !== undefined) fxp().property(name).property(1).setValue(val);
    };
    add("ADBE Slider Control", "Pin Latitude", lat);
    add("ADBE Slider Control", "Pin Longitude", lng);
    // two sliders, not a Point control: a Point control is spatial and would make the position expression circular
    add("ADBE Slider Control", "Pin Offset X", 0);
    add("ADBE Slider Control", "Pin Offset Y", 0);
    add("ADBE Checkbox Control", "Pin Scale With Map", scaleWithMap ? 1 : 0);
    add("ADBE Slider Control", "Pin Zoom", zoom);
    var tg = L.property("ADBE Transform Group");
    tg.property("ADBE Position").expression = geoPinExprPos(meta);
    tg.property("ADBE Scale").expression = geoPinExprScale();
    if (L.name.indexOf("(pinned)") < 0) L.name = L.name + " (pinned)";
}
function geoPinnable(L) {
    return !(/^GEO /.test(L.name) || L instanceof CameraLayer || L instanceof LightLayer);
}

// screen positions of the selected layers, so the panel can turn them into lat/lon at the linked view
function geoSelectedInfo() {
    try {
        var M = geoActiveMap();
        if (!M) return "ERR|افتح Map Comp في After Effects أولاً.";
        var c = M.comp, sel = c.selectedLayers, out = [];
        for (var i = 0; i < sel.length; i++) {
            var L = sel[i];
            if (!geoPinnable(L)) continue;
            var p = L.property("ADBE Transform Group").property("ADBE Position").valueAtTime(c.time, false);
            var isMedia = (L instanceof AVLayer) && L.source && !(L.source instanceof CompItem) && L.source.mainSource && !(L.source.mainSource instanceof SolidSource);
            out.push("{\"index\":" + L.index + ",\"x\":" + geoNum(p[0]) + ",\"y\":" + geoNum(p[1]) + ",\"media\":" + (isMedia ? "true" : "false") +
                     ",\"name\":\"" + geoEsc(L.name) + "\"}");
        }
        return "OK|{\"compId\":" + c.id + ",\"layers\":[" + out.join(",") + "]}";
    } catch (e) { return geoErr("", e); }
}

// job: {compId, zoom, layers:[{index, lat, lng, scaleWithMap}]}
function geoPinLayers(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J);
        app.beginUndoGroup("GeoMotion: pin layers");
        for (var i = 0; i < J.layers.length; i++) {
            var P = J.layers[i], L = M.comp.layer(P.index);
            if (L && geoPinnable(L)) geoPinLayer(L, P.lat, P.lng, J.zoom, M, P.scaleWithMap);
        }
        app.endUndoGroup();
        return "OK|" + J.layers.length;
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr("", e);
    }
}

// job: {compId, labels:[{text,lat,lng,size,color,appear,font,dot,dotColor}], relative}
function geoAddLabels(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J);
        var c = M.comp, base = J.relative ? c.time : 0;
        var z = geoSlider(geoControls(c), "Zoom").valueAtTime(c.time, false);
        app.beginUndoGroup("GeoMotion: labels");
        for (var i = 0; i < J.labels.length; i++) {
            var L = J.labels[i], appear = base + (L.appear || 0);
            if (L.dot) {
                var dot = c.layers.addShape();
                dot.name = L.text + " - dot";
                dot.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Dot";
                var dv = function () { return dot.property("ADBE Root Vectors Group").property("Dot").property("ADBE Vectors Group"); };
                dv().addProperty("ADBE Vector Shape - Ellipse").name = "Ellipse 1";
                dv().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
                dv().addProperty("ADBE Vector Graphic - Stroke").name = "Stroke 1";
                var r = Math.max(10, L.size * 0.32);
                dv().property("Ellipse 1").property("ADBE Vector Ellipse Size").setValue([r, r]);
                dv().property("Fill 1").property("ADBE Vector Fill Color").setValue(L.dotColor || L.color);
                dv().property("Stroke 1").property("ADBE Vector Stroke Color").setValue([0, 0, 0]);
                dv().property("Stroke 1").property("ADBE Vector Stroke Width").setValue(Math.max(2, r * 0.15));
                dot.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
                geoPinLayer(dot, L.lat, L.lng, z, M, false);
                var dop = dot.property("ADBE Transform Group").property("ADBE Opacity");
                dop.setValueAtTime(appear, 0); dop.setValueAtTime(appear + 0.4, 100);
            }
            var tl = c.layers.addText(L.text);
            tl.name = L.text;
            var tp = tl.property("ADBE Text Properties").property("ADBE Text Document");
            var td = tp.value;
            td.resetCharStyle();
            td.fontSize = L.size;
            try { td.font = L.font; } catch (e) {}
            td.applyFill = true; td.fillColor = L.color;
            td.applyStroke = true; td.strokeColor = [0, 0, 0]; td.strokeWidth = Math.max(2, L.size * 0.08); td.strokeOverFill = false;
            td.justification = ParagraphJustification.CENTER_JUSTIFY;
            try { td.direction = ParagraphDirection.DIRECTION_RIGHT_TO_LEFT; } catch (e) {}   // AE 24+
            tp.setValue(td);
            tl.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, L.dot ? L.size * 0.55 : L.size * -0.35]);
            geoPinLayer(tl, L.lat, L.lng, z, M, false);
            var top = tl.property("ADBE Transform Group").property("ADBE Opacity");
            top.setValueAtTime(appear, 0); top.setValueAtTime(appear + 0.5, 100);
        }
        app.endUndoGroup();
        return "OK|" + J.labels.length;
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr("", e);
    }
}
