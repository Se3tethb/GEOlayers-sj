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
 *                               imagery plates (replaced by Finalize), borders, arrows — all 3D layers:
 *                               a collapsed precomp passes the camera (tilt) only to its 3D layers
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
    // non-spatial 2D/3D values (Scale, shape-group Scale) need one ease per dimension; spatial and 1D need one
    var n = 1, t = p.propertyValueType;
    if (t === PropertyValueType.TwoD) n = 2;
    else if (t === PropertyValueType.ThreeD) n = 3;
    var arr = [];
    for (var k = 0; k < n; k++) arr.push(new KeyframeEase(0, 66));
    p.setTemporalEaseAtKey(i, arr, arr);
}

var GEO_CONTROLS = ["Latitude", "Longitude", "Zoom", "Bearing", "Pitch", "Roll", "Shake"];
var GEO_FIELDS = ["lat", "lng", "zoom", "bearing", "pitch", "roll", "shake"];

// camera = MapLibre model: distance D = h/2/tan(fov/2), orbits the centre by Pitch; Roll tilts the horizon;
// Shake adds smooth noise (px) to the camera and its point of interest
function geoCameraExpressions(main, fovDeg) {
    var w = main.width, h = main.height;
    var D = h / 2 / Math.tan((fovDeg || 36.8699) / 2 * Math.PI / 180);
    var cam = main.layer("GEO Camera");
    cam.property("ADBE Camera Options Group").property("ADBE Camera Zoom").setValue(D);
    // "Free Camera" checkbox on the controls hands the camera back to AE (value = what the user keyed)
    var FC = 'var F=0;try{F=' + GEO_CTRL + '.effect("Free Camera")(1).value;}catch(eF){}var res;';
    var SH = 'var s=' + GEO_CTRL + '.effect("Shake")(1).value;var nx=s?noise(time*1.7)*s:0,ny=s?noise(time*1.9+37.1)*s:0;';
    var ctg = cam.property("ADBE Transform Group");
    ctg.property("ADBE Anchor Point").expression = FC + 'if(F==1){res=value;}else{' + SH +
        'res=[' + (w / 2) + '+nx*0.6,' + (h / 2) + '+ny*0.6,0];}res;';   // point of interest
    ctg.property("ADBE Position").expression = FC + 'if(F==1){res=value;}else{' + SH +
        'var p=' + GEO_CTRL + '.effect("Pitch")(1).value*Math.PI/180;var D=' + geoNum(D) + ';' +
        'res=[' + (w / 2) + '+nx,' + (h / 2) + '+D*Math.sin(p)+ny,-D*Math.cos(p)];}res;';
    ctg.property("ADBE Rotate Z").expression = FC + 'if(F==1){res=value;}else{res=' + GEO_CTRL + '.effect("Roll")(1).value;}res;';
}

// comps made by an older GeoMotion lack Roll/Shake: add them and refresh the camera
function geoUpgrade(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp;
        app.beginUndoGroup("GeoMotion: upgrade");
        var fx = function () { return geoControls(c).property("ADBE Effect Parade"); };
        var added = 0;
        for (var i = 0; i < GEO_CONTROLS.length; i++) {
            if (!fx().property(GEO_CONTROLS[i])) { fx().addProperty("ADBE Slider Control").name = GEO_CONTROLS[i]; added++; }
        }
        if (!fx().property("Free Camera")) { fx().addProperty("ADBE Checkbox Control").name = "Free Camera"; added++; }
        geoCameraExpressions(c, 36.8699);
        app.endUndoGroup();
        return "OK|" + added;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// set plain control values (e.g. Shake); keyed controls get a key at the playhead
function geoSetValues(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), ctrl = geoControls(M.comp);
        app.beginUndoGroup("GeoMotion: set values");
        for (var k in J.values) {
            if (!J.values.hasOwnProperty(k)) continue;
            var p = geoSlider(ctrl, k);
            if (p.numKeys > 0) p.setValueAtTime(M.comp.time, J.values[k]); else p.setValue(J.values[k]);
        }
        app.endUndoGroup();
        return "OK|";
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
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
        var names = GEO_CONTROLS;
        var vals = [J.view.lat, J.view.lng, J.view.zoom, J.view.bearing, J.view.pitch, J.view.roll || 0, 0];
        var i;
        for (i = 0; i < names.length; i++) main.layer("GEO Map Controls").property("ADBE Effect Parade").addProperty("ADBE Slider Control").name = names[i];
        for (i = 0; i < names.length; i++) geoSlider(main.layer("GEO Map Controls"), names[i]).setValue(vals[i]);
        main.layer("GEO Map Controls").property("ADBE Effect Parade").addProperty("ADBE Checkbox Control").name = "Free Camera";

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
        main.layers.addCamera("GEO Camera", [C.w / 2, C.h / 2]);
        geoCameraExpressions(main, J.fovDeg);

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
        var fxp = ctrl.property("ADBE Effect Parade"), hasRoll = !!fxp.property("Roll") && !!fxp.property("Shake");
        var roll = hasRoll ? geoNum(geoSlider(ctrl, "Roll").valueAtTime(c.time, false)) : 0;
        var shake = hasRoll ? geoNum(geoSlider(ctrl, "Shake").valueAtTime(c.time, false)) : 0;
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
               ",\"lat\":" + v[0] + ",\"lng\":" + v[1] + ",\"zoom\":" + v[2] + ",\"bearing\":" + v[3] + ",\"pitch\":" + v[4] + ",\"roll\":" + roll + ",\"shake\":" + shake + ",\"v2\":" + (hasRoll ? "true" : "false") +
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
        var names = GEO_CONTROLS.slice(0, 6), fields = GEO_FIELDS.slice(0, 6);
        var base = c.time, i, k, n;
        var tOf = function (K) { return K.t < 0 ? base : (J.relative ? base + K.t : K.t); };
        for (n = 0; n < names.length; n++) {
            if (!ctrl.property("ADBE Effect Parade").property(names[n])) continue;
            var used = false;
            for (k = 0; k < J.keys.length; k++) if (J.keys[k][fields[n]] != null) used = true;
            if (!used) continue;
            var p = geoSlider(ctrl, names[n]);
            for (k = 0; k < J.keys.length; k++) {
                var K = J.keys[k], t = tOf(K), val = K[fields[n]];
                if (val == null || isNaN(val)) continue;
                if (names[n] === "Bearing" && p.numKeys > 0 && !J.rawBearing) { // continuous rotation, no 359->0 spins
                    var prev = p.valueAtTime(t, false);
                    val = prev + ((((val - prev) % 360) + 540) % 360 - 180);
                }
                p.setValueAtKey(p.addKey(t), val);
            }
            for (i = 1; i <= p.numKeys; i++) {
                var kt = p.keyTime(i), mine = -1;
                for (k = 0; k < J.keys.length; k++) if (J.keys[k][fields[n]] != null && Math.abs(tOf(J.keys[k]) - kt) < 1e-4) mine = k;
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
            L.name = P.isMask ? "قناع الماء (Water mask)" : (P.isBase ? "Map imagery (base)" : "Map imagery z" + Math.round(P.zoom * 10) / 10);
            L.threeDLayer = true;   // inside a collapsed precomp only 3D layers receive the main comp's camera (tilt)
            var tg = L.property("ADBE Transform Group");
            tg.property("ADBE Position").setValue([P.x, P.y, 0]);
            var sc = P.scale * (P.w / item.width);
            tg.property("ADBE Scale").setValue([sc, sc, 100]);
            if (!P.isBase && !P.isMask) tg.property("ADBE Opacity").expression = zoomExpr + ' linear(z,' + (P.zoom - 1.0) + ',' + (P.zoom - 0.4) + ',0,100);';
            L.moveToEnd();
            if (P.isMask) { L.moveToBeginning(); L.enabled = false; L.comment = "GEO IMAGERY"; }   // off by default; use as a track matte
            else if (J.tint) {
                try {
                    L.property("ADBE Effect Parade").addProperty("ADBE Tint");
                    var tfx = L.property("ADBE Effect Parade").property(1);
                    tfx.property(1).setValue(J.tint.dark);      // Map Black To
                    tfx.property(2).setValue(J.tint.light);     // Map White To
                    tfx.property(3).setValue(J.tint.amount);    // Amount to Tint
                } catch (eT) {}
            }
        }

        if (J.seq) {
            step = "3D frames";
            var sItem = geoImport(proj, J.seq.first, folder, true);
            sItem.mainSource.conformFrameRate = main.frameRate;
            var sl = main.layers.add(sItem);
            sl.name = "GEO 3D Render";
            sl.comment = "GEO 3D RENDER";
            // the frames are 2D, so apply the camera Roll here (opposite sign to the camera) and scale to cover the corners
            if (geoControls(main).property("ADBE Effect Parade").property("Roll")) {
                var RL = GEO_CTRL + '.effect("Roll")(1).value';
                sl.property("ADBE Transform Group").property("ADBE Rotate Z").expression = '-' + RL;
                sl.property("ADBE Transform Group").property("ADBE Scale").expression =
                    'var r=Math.abs(' + RL + ')*Math.PI/180;var w=thisComp.width,h=thisComp.height;' +
                    'var k=100*Math.max((w*Math.cos(r)+h*Math.sin(r))/w,(w*Math.sin(r)+h*Math.cos(r))/h);[k,k];';
            }
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
        var world = geoWorldComp(M.comp), base = J.relative ? M.comp.time : 0, names = [];
        for (var i = 0; i < J.shapes.length; i++) names.push(geoAddShape(world, J.shapes[i], geoMapScaleSnippet(M.comp.name), base).name);
        app.endUndoGroup();
        return "OK|" + J.shapes.length + "|" + names.join("\t");
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr("", e);
    }
}

function geoAddShape(world, S, SCALE_EXPR, t0) {
    var sl = world.layers.addShape();
    sl.name = geoUniqueLayerName(world, S.name);
    sl.threeDLayer = true;  // inside a collapsed precomp only 3D layers receive the main comp's camera (tilt)
    sl.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
    sl.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0, 0]);
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
    if (S.spotlight) return geoSpotlight(sl, S, t0, gc);
    var wantFill = hasClosed && S.fillOpacity > 0;
    var anim = S.anim || "draw", animDur = Math.max(0, S.drawEnd - S.drawStart);
    var wantStroke = !(S.strokeW <= 0) || S.arrowHead;
    gc().addProperty("ADBE Vector Filter - Trim").name = "Trim Paths 1";   // fixed names: expressions refer to them
    gc().addProperty("ADBE Vector Graphic - Stroke").name = "Stroke 1";
    if (wantFill) gc().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
    if (!wantStroke) gc().property("Stroke 1").enabled = false;

    var tEnd = gc().property("Trim Paths 1").property("ADBE Vector Trim End");
    if (anim === "draw" && S.drawEnd > S.drawStart) {
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
            if (S.marching) {   // dashes travel along the line (movement direction)
                dashes().property("ADBE Vector Stroke Offset").expression = SCALE_EXPR + " -time*" + geoNum(S.strokeW * 14) + " / s;";
            }
        } catch (e) {}
    }
    if (wantFill) {
        var fl = gc().property("Fill 1");
        fl.property("ADBE Vector Fill Color").setValue(S.fill);
        var fo = gc().property("Fill 1").property("ADBE Vector Fill Opacity");
        if (anim === "draw") {
            var fs = t0 + (S.drawEnd > S.drawStart ? S.drawEnd : 0);
            fo.setValueAtTime(fs, 0);
            fo.setValueAtTime(fs + 0.6, S.fillOpacity);
        } else fo.setValue(S.fillOpacity);
    }
    if (S.pattern === "stripes" && hasClosed) geoAddStripes(sl, S, t0);
    // whole-layer reveal animations
    var tgL = sl.property("ADBE Transform Group");
    if (anim === "fade" && animDur > 0) {
        var opF = tgL.property("ADBE Opacity");
        opF.setValueAtTime(t0 + S.drawStart, 0); opF.setValueAtTime(t0 + S.drawEnd, S.opacity === undefined ? 100 : S.opacity);
        geoEase(opF, 1); geoEase(opF, 2);
    } else if (anim === "grow" && animDur > 0 && S.center) {
        tgL.property("ADBE Anchor Point").setValue([S.center[0], S.center[1], 0]);
        tgL.property("ADBE Position").setValue([S.center[0], S.center[1], 0]);
        var scG = tgL.property("ADBE Scale");
        scG.setValueAtTime(t0 + S.drawStart, [0, 0, 100]); scG.setValueAtTime(t0 + S.drawEnd, [100, 100, 100]);
        geoEase(scG, 1); geoEase(scG, 2);
    }
    if (S.shadow) geoDropShadow(sl, 14, 28);
    if (S.glow) {
        try {
            sl.property("ADBE Effect Parade").addProperty("ADBE Glo2");
            var g = sl.property("ADBE Effect Parade").property(1);
            g.property("ADBE Glo2-0002").setValue(40);     // threshold %
            g.property("ADBE Glo2-0003").setValue(24);     // radius
            g.property("ADBE Glo2-0004").setValue(0.8);    // intensity: keeps fills their own colour
        } catch (e) {}
    }
    if (S.blend && BlendingMode[S.blend] !== undefined) { try { sl.blendingMode = BlendingMode[S.blend]; } catch (e) {} }
    var op = S.opacity === undefined ? 100 : S.opacity;
    if (op < 100 && !(anim === "fade" && animDur > 0)) sl.property("ADBE Transform Group").property("ADBE Opacity").setValue(op);
    if (S.flicker) {   // news-style flicker for ~1.2 s after the feature appears
        sl.property("ADBE Transform Group").property("ADBE Opacity").expression =
            'posterizeTime(14);var t=time-(' + geoNum(t0 + (S.drawEnd > S.drawStart ? S.drawStart : 0)) + ');' +
            't<0?value:(t<1.2?(random()<0.55?value:value*0.15):value);';
    }
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
    // put the head above the line so the stroke's round cap does not blunt the tip
    try { sl.property("ADBE Root Vectors Group").property("Head").moveTo(1); } catch (eM) {}
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

function geoUniqueLayerName(comp, base) {
    var name = base, n = 1, taken = {};
    for (var i = 1; i <= comp.numLayers; i++) taken[comp.layer(i).name] = true;
    while (taken[name] || taken[name + " (pinned)"]) { n++; name = base + " " + n; }
    return name;
}

// darken everything except the feature: a huge rectangle with the feature rings as holes (even-odd fill)
function geoSpotlight(sl, S, t0, gc) {
    // outer rectangle = feature bbox + 30000 World px each side (AE does not draw shapes hundreds of thousands of px wide)
    var x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12, pi, vi;
    for (pi = 0; pi < S.paths.length; pi++) for (vi = 0; vi < S.paths[pi].v.length; vi++) {
        var q = S.paths[pi].v[vi];
        if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[0] > x1) x1 = q[0]; if (q[1] > y1) y1 = q[1];
    }
    var M = 30000;
    var big = new Shape();
    big.vertices = [[x0 - M, y0 - M], [x1 + M, y0 - M], [x1 + M, y1 + M], [x0 - M, y1 + M]];
    big.closed = true;
    gc().addProperty("ADBE Vector Shape - Group").name = "Outside";
    gc().property("Outside").property("ADBE Vector Shape").setValue(big);
    gc().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
    var fl = function () { return gc().property("Fill 1"); };
    fl().property("ADBE Vector Fill Color").setValue(S.fill || [0, 0, 0]);
    try { fl().property("ADBE Vector Fill Rule").setValue(2); } catch (e) {}   // 2 = even-odd: feature rings become holes
    var fo = fl().property("ADBE Vector Fill Opacity");
    var dim = S.dim === undefined ? 65 : S.dim;
    fo.setValueAtTime(t0, 0);
    fo.setValueAtTime(t0 + Math.max(0.6, S.drawEnd || 0.8), dim);
    geoEase(fo, 1); geoEase(fo, 2);
    sl.name = geoUniqueLayerName(sl.containingComp, S.name + " (تعتيم)");
    return sl;
}

// selected layers -> 3D and parented to "GEO Map Anchor" (they then follow pan, zoom, bearing and tilt)
function geoLinkToAnchor() {
    try {
        var M = geoActiveMap();
        if (!M) return "ERR|افتح Map Comp في After Effects أولاً.";
        var c = M.comp, sel = c.selectedLayers, n = 0, anc = c.layer("GEO Map Anchor");
        if (!sel.length) return "ERR|حدّد الطبقات في AE أولاً.";
        app.beginUndoGroup("GeoMotion: link to anchor");
        for (var i = 0; i < sel.length; i++) {
            var L = sel[i];
            if (!geoPinnable(L) || L === anc) continue;
            if (!L.threeDLayer) L.threeDLayer = true;
            L.parent = anc;            // AE compensates the transform so the layer keeps its current look
            n++;
        }
        app.endUndoGroup();
        return "OK|" + n;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// an empty 3D shape layer inside the World comp: draw on it with the Pen tool and it stays on the map
function geoCreateDrawLayer() {
    try {
        var M = geoActiveMap();
        if (!M) return "ERR|افتح Map Comp في After Effects أولاً.";
        app.beginUndoGroup("GeoMotion: draw layer");
        var world = geoWorldComp(M.comp);
        var sl = world.layers.addShape();
        sl.name = "رسم حر";
        sl.threeDLayer = true;
        sl.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0, 0]);
        sl.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0, 0]);
        app.endUndoGroup();
        try { world.openInViewer(); } catch (e2) {}
        return "OK|" + world.name;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// scale bar (km / m) that updates with zoom and latitude: a bar + a label in the main comp
function geoAddScaleBar(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp;
        app.beginUndoGroup("GeoMotion: scale bar");
        var CALC = 'var C=thisComp.layer("GEO Map Controls").effect;var z=C("Zoom")(1).value,la=C("Latitude")(1).value;' +
            'var mpp=40075016.686*Math.cos(la*Math.PI/180)/(512*Math.pow(2,z));' +
            'var mx=thisComp.layer("GEO Scale Bar").effect("Max Width")(1).value*mpp;' +
            'var p=Math.pow(10,Math.floor(Math.log(mx)/Math.LN10)),n=mx/p,m=(n>=5?5:(n>=2?2:1))*p;';
        var bar = c.layers.addShape();
        bar.name = "GEO Scale Bar";
        bar.property("ADBE Effect Parade").addProperty("ADBE Slider Control").name = "Max Width";
        bar.property("ADBE Effect Parade").property("Max Width").property(1).setValue(Math.round(c.width * 0.16));
        bar.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Bar";
        var g = function () { return bar.property("ADBE Root Vectors Group").property("Bar").property("ADBE Vectors Group"); };
        g().addProperty("ADBE Vector Shape - Rect").name = "Rect 1";
        g().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
        g().addProperty("ADBE Vector Graphic - Stroke").name = "Stroke 1";
        g().property("Fill 1").property("ADBE Vector Fill Color").setValue([1, 1, 1]);
        g().property("Stroke 1").property("ADBE Vector Stroke Color").setValue([0, 0, 0]);
        g().property("Stroke 1").property("ADBE Vector Stroke Width").setValue(2);
        g().property("Rect 1").property("ADBE Vector Rect Size").expression = CALC + '[m/mpp,10];';
        g().property("Rect 1").property("ADBE Vector Rect Position").expression = CALC + '[m/mpp/2,0];';
        bar.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
        bar.property("ADBE Transform Group").property("ADBE Position").setValue([Math.round(c.width * 0.05), Math.round(c.height * 0.92)]);

        var tl = c.layers.addText("0 كم");
        tl.name = "GEO Scale Text";
        var tp = tl.property("ADBE Text Properties").property("ADBE Text Document");
        var td = tp.value;
        td.resetCharStyle();
        td.fontSize = Math.round(c.height * 0.028);
        try { td.font = J.font || "Al-Jazeera-Arabic-Bold"; } catch (e) {}
        td.applyFill = true; td.fillColor = [1, 1, 1];
        td.applyStroke = true; td.strokeColor = [0, 0, 0]; td.strokeWidth = 3; td.strokeOverFill = false;
        td.justification = ParagraphJustification.LEFT_JUSTIFY;
        tp.setValue(td);
        tp.expression = CALC + '(m>=1000?(m/1000)+" كم":m+" م");';
        tl.property("ADBE Transform Group").property("ADBE Position").expression =
            'var b=thisComp.layer("GEO Scale Bar").transform.position.value;[b[0],b[1]-14];';
        app.endUndoGroup();
        return "OK|" + c.name;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// move the selected main-comp layers along a path drawn in the World comp (plane, car, dot...)
// job: {compId, pathLayer, duration, orient}
function geoAttachToPath(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp, world = geoWorldComp(c);
        var src = null;
        for (var i = 1; i <= world.numLayers; i++) if (world.layer(i).name === J.pathLayer) src = world.layer(i);
        if (!src) return "ERR|لم أجد طبقة المسار «" + J.pathLayer + "» في كومب World";
        var sel = c.selectedLayers, n = 0;
        if (!sel.length) return "ERR|حدّد في AE الطبقة التي ستتحرك على المسار";
        app.beginUndoGroup("GeoMotion: move along path");
        var PATH = 'var W=thisComp.layer("GEO World");var S=W.source.layer("' + geoEsc(J.pathLayer) + '");' +
            'var P=S.content("Feature").content("Path 1").path;var u=Math.max(0,Math.min(1,effect("Path Progress")(1).value/100));';
        for (var k = 0; k < sel.length; k++) {
            var L = sel[k];
            if (!geoPinnable(L) || L.threeDLayer) continue;
            var fx = function () { return L.property("ADBE Effect Parade"); };
            if (!fx().property("Path Progress")) fx().addProperty("ADBE Slider Control").name = "Path Progress";
            if (!fx().property("Path Rotate Offset")) fx().addProperty("ADBE Angle Control").name = "Path Rotate Offset";
            var pp = fx().property("Path Progress").property(1);
            while (pp.numKeys) pp.removeKey(1);
            pp.setValueAtTime(c.time, 0);
            pp.setValueAtTime(c.time + J.duration, 100);
            geoEase(pp, 1); geoEase(pp, 2);
            var tg = L.property("ADBE Transform Group");
            tg.property("ADBE Position").expression = PATH +
                'var q=P.pointOnPath(u);var r=W.toComp([q[0],q[1],0]);[r[0],r[1]];';
            if (J.orient) {
                tg.property("ADBE Rotate Z").expression = PATH +
                    'var a=P.pointOnPath(Math.max(0,u-0.002)),b=P.pointOnPath(Math.min(1,u+0.002));' +
                    'var A=W.toComp([a[0],a[1],0]),B=W.toComp([b[0],b[1],0]);' +
                    'radiansToDegrees(Math.atan2(B[1]-A[1],B[0]-A[0]))+effect("Path Rotate Offset")(1).value;';
            }
            n++;
        }
        app.endUndoGroup();
        return "OK|" + n;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// marker at the place: "dot" | "pulse" | "square" | "ring" | "target"
function geoAddMarker(c, L, z, M, appear) {
    var mk = c.layers.addShape();
    mk.name = geoUniqueLayerName(c, L.text + " - علامة");
    var root = function () { return mk.property("ADBE Root Vectors Group"); };
    var r = Math.max(10, L.size * 0.32);
    var col = L.dotColor || L.color;
    var T = "(" + geoNum(appear) + ")";
    var addShapeGroup = function (gname, kind, size, fillCol, strokeCol, strokeW) {
        root().addProperty("ADBE Vector Group").name = gname;
        var g = function () { return root().property(gname).property("ADBE Vectors Group"); };
        if (kind === "rect") {
            g().addProperty("ADBE Vector Shape - Rect").name = "Shape 1";
            g().property("Shape 1").property("ADBE Vector Rect Size").setValue([size, size]);
        } else {
            g().addProperty("ADBE Vector Shape - Ellipse").name = "Shape 1";
            g().property("Shape 1").property("ADBE Vector Ellipse Size").setValue([size, size]);
        }
        if (fillCol) {
            g().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
            g().property("Fill 1").property("ADBE Vector Fill Color").setValue(fillCol);
        }
        if (strokeCol) {
            g().addProperty("ADBE Vector Graphic - Stroke").name = "Stroke 1";
            g().property("Stroke 1").property("ADBE Vector Stroke Color").setValue(strokeCol);
            g().property("Stroke 1").property("ADBE Vector Stroke Width").setValue(strokeW);
        }
    };
    if (L.marker === "pulse") {
        addShapeGroup("Ring", "ellipse", r, null, col, Math.max(2, r * 0.12));
        var tr = root().property("Ring").property("ADBE Vector Transform Group");
        tr.property("ADBE Vector Scale").expression = 'var p=Math.max(0,time-' + T + ')%1.6/1.6;var k=100+p*280;[k,k];';
        tr.property("ADBE Vector Group Opacity").expression = 'time<' + T + '?0:(1-(Math.max(0,time-' + T + ')%1.6/1.6))*100;';
        addShapeGroup("Dot", "ellipse", r, col, [0, 0, 0], Math.max(2, r * 0.15));
    } else if (L.marker === "square") {
        addShapeGroup("Square", "rect", r * 1.15, col, [1, 1, 1], Math.max(1.5, r * 0.08));
    } else if (L.marker === "ring") {
        addShapeGroup("Ring", "ellipse", r * 0.9, [1, 1, 1], [0, 0, 0], Math.max(2, r * 0.2));
    } else if (L.marker === "target") {
        addShapeGroup("Outer", "ellipse", r * 2.6, null, col, Math.max(3, r * 0.22));
        addShapeGroup("Middle", "ellipse", r * 1.6, null, [1, 1, 1], Math.max(3, r * 0.2));
        addShapeGroup("Core", "ellipse", r * 0.7, col, null, 0);
        // rings open up when the marker appears
        var to = root().property("Outer").property("ADBE Vector Transform Group").property("ADBE Vector Scale");
        to.setValueAtTime(appear, [0, 0]); to.setValueAtTime(appear + 0.5, [100, 100]); geoEase(to, 1); geoEase(to, 2);
    } else {
        addShapeGroup("Dot", "ellipse", r, col, [0, 0, 0], Math.max(2, r * 0.15));
    }
    mk.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
    geoPinLayer(mk, L.lat, L.lng, z, M, false);
    var op = mk.property("ADBE Transform Group").property("ADBE Opacity");
    op.setValueAtTime(appear, 0); op.setValueAtTime(appear + 0.4, 100);
    return mk;
}

function geoDropShadow(L, distance, softness) {
    try {
        L.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
        var fx = L.property("ADBE Effect Parade").property(L.property("ADBE Effect Parade").numProperties);
        fx.property(4).setValue(distance);   // Distance
        fx.property(5).setValue(softness);   // Softness
    } catch (e) {}
}

// job: {compId, labels:[{text,lat,lng,size,color,appear,font,marker,style,dotColor,boxColor}], relative}
// style: "box" | "pointer" | "plain" | "shadow" | "inside" | "tag"
function geoAddLabels(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J);
        var c = M.comp, base = J.relative ? c.time : 0;
        var z = geoSlider(geoControls(c), "Zoom").valueAtTime(c.time, false);
        app.beginUndoGroup("GeoMotion: labels");
        for (var i = 0; i < J.labels.length; i++) {
            var L = J.labels[i], appear = base + (L.appear || 0);
            var style = L.style || "plain", marker = L.marker || (L.dot ? "dot" : "none");
            if (style === "inside") marker = "none";
            L.marker = marker;
            if (style === "shadow") L.size = Math.round(L.size * 1.5);
            var lineLen = Math.round(L.size * 1.6);
            var boxed = style === "box" || style === "pointer";

            if (marker !== "none") geoAddMarker(c, L, z, M, appear);

            if (style === "tag") {          // leader line from the place up to the text
                var ln = c.layers.addShape();
                ln.name = geoUniqueLayerName(c, L.text + " - خط");
                ln.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Line";
                var lg = function () { return ln.property("ADBE Root Vectors Group").property("Line").property("ADBE Vectors Group"); };
                lg().addProperty("ADBE Vector Shape - Group").name = "Path 1";
                var sh = new Shape(); sh.vertices = [[0, 0], [0, -lineLen]]; sh.closed = false;
                lg().property("Path 1").property("ADBE Vector Shape").setValue(sh);
                lg().addProperty("ADBE Vector Filter - Trim").name = "Trim Paths 1";
                lg().addProperty("ADBE Vector Graphic - Stroke").name = "Stroke 1";
                lg().property("Stroke 1").property("ADBE Vector Stroke Color").setValue(L.color);
                lg().property("Stroke 1").property("ADBE Vector Stroke Width").setValue(Math.max(2, L.size * 0.06));
                var te = lg().property("Trim Paths 1").property("ADBE Vector Trim End");
                te.setValueAtTime(appear, 0); te.setValueAtTime(appear + 0.5, 100); geoEase(te, 1); geoEase(te, 2);
                ln.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
                geoPinLayer(ln, L.lat, L.lng, z, M, false);
            }

            var tname = geoUniqueLayerName(c, L.text);
            var box = null;
            if (boxed) { box = c.layers.addShape(); box.name = tname + " - صندوق"; }   // added first: sits below the text

            var tl = c.layers.addText(L.text);
            tl.name = tname;
            var tp = tl.property("ADBE Text Properties").property("ADBE Text Document");
            var td = tp.value;
            td.resetCharStyle();
            td.fontSize = L.size;
            try { td.font = L.font; } catch (e) {}
            td.applyFill = true; td.fillColor = L.color;
            if (style === "plain" || style === "tag") {
                td.applyStroke = true; td.strokeColor = [0, 0, 0]; td.strokeWidth = Math.max(2, L.size * 0.08); td.strokeOverFill = false;
            } else td.applyStroke = false;
            td.justification = ParagraphJustification.CENTER_JUSTIFY;
            try { td.direction = ParagraphDirection.DIRECTION_RIGHT_TO_LEFT; } catch (e) {}   // AE 24+
            tp.setValue(td);
            tl.property("ADBE Transform Group").property("ADBE Anchor Point").expression =
                'var r=sourceRectAtTime(time,false);[r.left+r.width/2,r.top+r.height/2];';
            if (style === "shadow" || style === "inside") geoDropShadow(tl, style === "shadow" ? 6 : 3, style === "shadow" ? 18 : 10);
            geoPinLayer(tl, L.lat, L.lng, z, M, false);

            var pad = Math.round(L.size * 0.35), tip = Math.round(L.size * 0.45);
            var offY = 0;
            if (style === "tag") offY = -(lineLen + L.size * 0.7);
            else if (style === "pointer") offY = -(L.size * 0.85 + pad / 2 + tip + (marker !== "none" ? L.size * 0.25 : 0));
            else if (marker !== "none") offY = -(L.size * 0.95);
            tl.property("ADBE Effect Parade").property("Pin Offset Y").property(1).setValue(offY);
            var top = tl.property("ADBE Transform Group").property("ADBE Opacity");
            var tIn = appear + (style === "tag" ? 0.35 : 0);
            top.setValueAtTime(tIn, 0); top.setValueAtTime(tIn + 0.5, 100);

            if (box) {
                var TL = 'thisComp.layer("' + geoEsc(tl.name) + '")';   // read after pinning renamed it
                var RECT = 'var t=' + TL + ';var r=t.sourceRectAtTime(time,false);var k=t.transform.scale.value[0]/100;';
                box.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Box";
                var bg = function () { return box.property("ADBE Root Vectors Group").property("Box").property("ADBE Vectors Group"); };
                bg().addProperty("ADBE Vector Shape - Rect").name = "Rect 1";
                bg().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
                bg().property("Fill 1").property("ADBE Vector Fill Color").setValue(L.boxColor || [0.75, 0.05, 0.05]);
                bg().property("Rect 1").property("ADBE Vector Rect Size").expression = RECT + '[r.width*k+' + (pad * 2) + ',r.height*k+' + pad + '];';
                try { bg().property("Rect 1").property("ADBE Vector Rect Roundness").setValue(style === "pointer" ? 4 : Math.round(L.size * 0.08)); } catch (e) {}
                if (style === "pointer") {     // small triangle under the box, pointing at the place
                    box.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group").name = "Pointer";
                    var pg = function () { return box.property("ADBE Root Vectors Group").property("Pointer").property("ADBE Vectors Group"); };
                    pg().addProperty("ADBE Vector Shape - Group").name = "Path 1";
                    var tri = new Shape(); tri.vertices = [[-tip, 0], [tip, 0], [0, tip * 1.4]]; tri.closed = true;
                    pg().property("Path 1").property("ADBE Vector Shape").setValue(tri);
                    pg().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
                    pg().property("Fill 1").property("ADBE Vector Fill Color").setValue(L.boxColor || [1, 1, 1]);
                    box.property("ADBE Root Vectors Group").property("Pointer").property("ADBE Vector Transform Group")
                        .property("ADBE Vector Position").expression = RECT + '[0,(r.height*k+' + pad + ')/2-1];';
                    geoDropShadow(box, 4, 12);
                }
                var btg = box.property("ADBE Transform Group");
                btg.property("ADBE Anchor Point").setValue([0, 0]);
                btg.property("ADBE Position").expression = TL + '.transform.position.value;';
                btg.property("ADBE Opacity").expression = TL + '.transform.opacity.value;';
            }
        }
        app.endUndoGroup();
        return "OK|" + J.labels.length;
    } catch (e) {
        try { app.endUndoGroup(); } catch (e3) {}
        return geoErr("", e);
    }
}

// picture (tank, ship, flag, logo...) pinned to a lat/lon; grows with the map if asked
// job: {compId, file, lat, lng, size, scaleWithMap, shadow, name}
function geoAddImage(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp;
        var f = new File(J.file);
        if (!f.exists) return "ERR|الملف غير موجود: " + J.file;
        app.beginUndoGroup("GeoMotion: image");
        var fm = /FOLDER=(\d+)/.exec(c.comment), folder = null;
        if (fm) { try { folder = app.project.itemByID(parseInt(fm[1], 10)); } catch (e0) {} }
        var item = geoImport(app.project, J.file, folder, false);
        var L = c.layers.add(item);
        L.name = geoUniqueLayerName(c, J.name || item.name);
        var k = 100 * (J.size || 200) / Math.max(1, item.width);
        L.property("ADBE Transform Group").property("ADBE Scale").setValue([k, k]);
        if (J.shadow) geoDropShadow(L, 10, 30);
        var z = geoSlider(geoControls(c), "Zoom").valueAtTime(c.time, false);
        geoPinLayer(L, J.lat, J.lng, z, M, !!J.scaleWithMap);
        var op = L.property("ADBE Transform Group").property("ADBE Opacity");
        op.setValueAtTime(c.time, 0); op.setValueAtTime(c.time + 0.4, 100);
        app.endUndoGroup();
        return "OK|" + L.name;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// north arrow that turns with the map bearing
function geoAddNorthArrow(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp;
        app.beginUndoGroup("GeoMotion: north arrow");
        var s = Math.round(c.height * 0.045);
        var L = c.layers.addShape();
        L.name = geoUniqueLayerName(c, "GEO North");
        var root = function () { return L.property("ADBE Root Vectors Group"); };
        root().addProperty("ADBE Vector Group").name = "Arrow";
        var g = function () { return root().property("Arrow").property("ADBE Vectors Group"); };
        g().addProperty("ADBE Vector Shape - Group").name = "Path 1";
        var tri = new Shape(); tri.vertices = [[0, -s], [s * 0.55, s * 0.7], [0, s * 0.35], [-s * 0.55, s * 0.7]]; tri.closed = true;
        g().property("Path 1").property("ADBE Vector Shape").setValue(tri);
        g().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
        g().property("Fill 1").property("ADBE Vector Fill Color").setValue([1, 1, 1]);
        g().addProperty("ADBE Vector Graphic - Stroke").name = "Stroke 1";
        g().property("Stroke 1").property("ADBE Vector Stroke Color").setValue([0, 0, 0]);
        g().property("Stroke 1").property("ADBE Vector Stroke Width").setValue(2);
        L.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
        L.property("ADBE Transform Group").property("ADBE Position").setValue([c.width - s * 2.2, s * 2.6]);
        L.property("ADBE Transform Group").property("ADBE Rotate Z").expression = '-' + GEO_CTRL + '.effect("Bearing")(1).value';
        var t = c.layers.addText("N");
        t.name = geoUniqueLayerName(c, "GEO North N");
        var tp = t.property("ADBE Text Properties").property("ADBE Text Document"), td = tp.value;
        td.resetCharStyle(); td.fontSize = Math.round(s * 0.8); td.applyFill = true; td.fillColor = [1, 1, 1];
        td.applyStroke = true; td.strokeColor = [0, 0, 0]; td.strokeWidth = 2; td.strokeOverFill = false;
        td.justification = ParagraphJustification.CENTER_JUSTIFY; tp.setValue(td);
        t.property("ADBE Transform Group").property("ADBE Position").expression =
            'var a=thisComp.layer("' + geoEsc(L.name) + '");var r=degreesToRadians(a.transform.rotation.value);var p=a.transform.position.value;' +
            '[p[0]+Math.sin(r)*' + (s * 1.7) + ',p[1]-Math.cos(r)*' + (s * 1.7) + '+' + Math.round(s * 0.3) + '];';
        app.endUndoGroup();
        return "OK|" + L.name;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// colour legend (box + name per item) in the lower corner
// job: {compId, items:[{name,color}], font}
function geoAddLegend(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp;
        app.beginUndoGroup("GeoMotion: legend");
        var fs = Math.round(c.height * 0.024), row = Math.round(fs * 1.7), n = J.items.length;
        var x0 = Math.round(c.width * 0.04), y0 = Math.round(c.height * 0.94) - n * row;
        var bg = c.layers.addShape();
        bg.name = geoUniqueLayerName(c, "GEO Legend");
        var root = function () { return bg.property("ADBE Root Vectors Group"); };
        root().addProperty("ADBE Vector Group").name = "Panel";
        var pg = function () { return root().property("Panel").property("ADBE Vectors Group"); };
        pg().addProperty("ADBE Vector Shape - Rect").name = "Rect 1";
        var w = Math.round(fs * 11), h = n * row + fs;
        pg().property("Rect 1").property("ADBE Vector Rect Size").setValue([w, h]);
        pg().property("Rect 1").property("ADBE Vector Rect Position").setValue([w / 2, h / 2]);
        try { pg().property("Rect 1").property("ADBE Vector Rect Roundness").setValue(8); } catch (e) {}
        pg().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
        pg().property("Fill 1").property("ADBE Vector Fill Color").setValue([0.08, 0.1, 0.16]);
        pg().property("Fill 1").property("ADBE Vector Fill Opacity").setValue(80);
        for (var i = 0; i < n; i++) {
            var gname = "Swatch " + (i + 1);
            root().addProperty("ADBE Vector Group").name = gname;
            var sg = function () { return root().property(gname).property("ADBE Vectors Group"); };
            sg().addProperty("ADBE Vector Shape - Rect").name = "Rect 1";
            sg().property("Rect 1").property("ADBE Vector Rect Size").setValue([fs, fs]);
            sg().property("Rect 1").property("ADBE Vector Rect Position").setValue([w - fs * 1.2, fs + i * row + fs / 2]);
            sg().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
            sg().property("Fill 1").property("ADBE Vector Fill Color").setValue(J.items[i].color);
            var t = c.layers.addText(J.items[i].name);
            t.name = geoUniqueLayerName(c, "GEO Legend " + J.items[i].name);
            var tp = t.property("ADBE Text Properties").property("ADBE Text Document"), td = tp.value;
            td.resetCharStyle(); td.fontSize = fs; try { td.font = J.font; } catch (eF) {}
            td.applyFill = true; td.fillColor = [1, 1, 1]; td.applyStroke = false;
            td.justification = ParagraphJustification.RIGHT_JUSTIFY; tp.setValue(td);
            t.property("ADBE Transform Group").property("ADBE Position").setValue([x0 + w - fs * 2.2, y0 + fs + i * row + fs * 0.85]);
        }
        bg.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
        bg.property("ADBE Transform Group").property("ADBE Position").setValue([x0, y0]);
        bg.moveToEnd(); bg.moveBefore(c.layer("GEO World"));
        app.endUndoGroup();
        return "OK|" + n;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// dark vignette on top of the comp
function geoAddVignette(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp;
        app.beginUndoGroup("GeoMotion: vignette");
        var L = c.layers.addSolid([0, 0, 0], "GEO Vignette", c.width, c.height, 1, c.duration);
        var mask = L.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
        var sh = new Shape(), w = c.width, h = c.height, kx = w * 0.06, ky = h * 0.06;
        // ellipse made of 4 bezier points
        var cx = w / 2, cy = h / 2, rx = w * 0.62, ry = h * 0.66, q = 0.5523;
        sh.vertices = [[cx, cy - ry], [cx + rx, cy], [cx, cy + ry], [cx - rx, cy]];
        sh.inTangents = [[-rx * q, 0], [0, -ry * q], [rx * q, 0], [0, ry * q]];
        sh.outTangents = [[rx * q, 0], [0, ry * q], [-rx * q, 0], [0, -ry * q]];
        sh.closed = true;
        L.property("ADBE Mask Parade").property(1).property("ADBE Mask Shape").setValue(sh);
        L.property("ADBE Mask Parade").property(1).inverted = true;
        L.property("ADBE Mask Parade").property(1).property("ADBE Mask Feather").setValue([w * 0.22, w * 0.22]);
        L.property("ADBE Transform Group").property("ADBE Opacity").setValue(60);
        try { L.moveBefore(c.layer("GEO World")); } catch (eV) {}   // above the map, below labels / legend / images
        app.endUndoGroup();
        return "OK|" + L.name;
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// free camera: the AE user animates "GEO Camera" directly (camera tools / keys); map zoom & place stay on the controls
function geoSetFreeCam(jobPath) {
    try {
        var J = geoReadJob(jobPath);
        var M = geoMapFor(J), c = M.comp;
        app.beginUndoGroup("GeoMotion: free camera");
        var fx = function () { return geoControls(c).property("ADBE Effect Parade"); };
        if (!fx().property("Free Camera")) fx().addProperty("ADBE Checkbox Control").name = "Free Camera";
        if (J.on) {   // start the free camera from where the expression camera is now
            var tg = c.layer("GEO Camera").property("ADBE Transform Group");
            var pos = tg.property("ADBE Position").valueAtTime(c.time, false), poi = tg.property("ADBE Anchor Point").valueAtTime(c.time, false);
            fx().property("Free Camera").property(1).setValue(1);
            geoCameraExpressions(c, 36.8699);
            if (!tg.property("ADBE Position").numKeys) tg.property("ADBE Position").setValue(pos);
            if (!tg.property("ADBE Anchor Point").numKeys) tg.property("ADBE Anchor Point").setValue(poi);
        } else {
            fx().property("Free Camera").property(1).setValue(0);
            geoCameraExpressions(c, 36.8699);
        }
        app.endUndoGroup();
        return "OK|" + (J.on ? 1 : 0);
    } catch (e) { try { app.endUndoGroup(); } catch (e3) {} return geoErr("", e); }
}

// diagonal stripes clipped to the area: group "Hatch" = (Lines merged) INTERSECT (Area merged), filled with the stripe colour
function geoAddStripes(sl, S, t0) {
    var x0 = 1e12, y0 = 1e12, x1 = -1e12, y1 = -1e12, i, j;
    for (i = 0; i < S.paths.length; i++) if (S.paths[i].closed) for (j = 0; j < S.paths[i].v.length; j++) {
        var q = S.paths[i].v[j];
        if (q[0] < x0) x0 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[0] > x1) x1 = q[0]; if (q[1] > y1) y1 = q[1];
    }
    var gap = Math.max(0.5, S.stripeGap || 16), cMin = x0 - y1, cMax = x1 - y0;
    while ((cMax - cMin) / gap > 500) gap *= 1.5;              // keep the vertex count sane
    var w = gap * 0.5;
    var root = function () { return sl.property("ADBE Root Vectors Group"); };
    root().addProperty("ADBE Vector Group").name = "Hatch";
    var hg = function () { return root().property("Hatch").property("ADBE Vectors Group"); };
    hg().addProperty("ADBE Vector Group").name = "Lines";
    var lg = function () { return hg().property("Lines").property("ADBE Vectors Group"); };
    var n = 0;
    for (var cc = cMin; cc <= cMax; cc += gap) {     // band between y = x - cc and y = x - cc - w across the bbox
        n++;
        lg().addProperty("ADBE Vector Shape - Group").name = "Stripe " + n;
        var sh = new Shape();
        sh.vertices = [[x0, x0 - cc], [x1, x1 - cc], [x1, x1 - cc - w], [x0, x0 - cc - w]];
        sh.closed = true;
        lg().property("Stripe " + n).property("ADBE Vector Shape").setValue(sh);
    }
    lg().addProperty("ADBE Vector Filter - Merge").name = "Merge 1";
    lg().property("Merge 1").property("ADBE Vector Merge Type").setValue(2);     // Add
    hg().addProperty("ADBE Vector Group").name = "Area";
    var ag = function () { return hg().property("Area").property("ADBE Vectors Group"); };
    var k = 0;
    for (i = 0; i < S.paths.length; i++) if (S.paths[i].closed) {
        k++;
        ag().addProperty("ADBE Vector Shape - Group").name = "Ring " + k;
        var rs = new Shape(); rs.vertices = S.paths[i].v; rs.closed = true;
        ag().property("Ring " + k).property("ADBE Vector Shape").setValue(rs);
    }
    ag().addProperty("ADBE Vector Filter - Merge").name = "Merge 1";
    ag().property("Merge 1").property("ADBE Vector Merge Type").setValue(2);     // Add
    hg().addProperty("ADBE Vector Filter - Merge").name = "Merge 1";
    hg().property("Merge 1").property("ADBE Vector Merge Type").setValue(4);     // Intersect
    hg().addProperty("ADBE Vector Graphic - Fill").name = "Fill 1";
    hg().property("Fill 1").property("ADBE Vector Fill Color").setValue(S.stripe || [0.95, 0.72, 0.02]);
    // stripes fade in with the fill
    var ho = root().property("Hatch").property("ADBE Vector Transform Group").property("ADBE Vector Group Opacity");
    var tIn = t0 + ((S.anim || "draw") === "draw" ? Math.max(0, S.drawEnd) : S.drawStart || 0);
    ho.setValueAtTime(tIn, 0); ho.setValueAtTime(tIn + 0.6, 100);
    try { root().property("Hatch").moveTo(1); } catch (e) {}
}
