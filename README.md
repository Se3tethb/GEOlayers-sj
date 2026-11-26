# GeoMotion — خرائط متحركة داخل After Effects

إضافة (CEP panel) لـ Adobe After Effects تعمل بأسلوب GEOlayers 3، مبنية بالكامل على أدوات ومصادر مفتوحة:
MapLibre GL، OpenStreetMap / OpenFreeMap، صور الأقمار الصناعية من Esri و Sentinel-2، تضاريس AWS Terrain Tiles، بحث Nominatim، وحدود المحافظات من Natural Earth.

An open-source After Effects extension for animated maps with a GEOlayers-3-style workflow (MapLibre, OpenStreetMap, Esri World Imagery, AWS terrain, Nominatim, Natural Earth).

## التثبيت (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

يسمح بتشغيل الإضافات غير الموقّعة (PlayerDebugMode) وينسخ المجلد إلى `%APPDATA%\Adobe\CEP\extensions\com.sajad.geomotion`.
أعد تشغيل After Effects ثم: **Window ▸ Extensions ▸ GeoMotion**.

يحتاج After Effects 2021 أو أحدث (CEP 9+)، واتصالاً بالإنترنت لتحميل الخرائط.

## طريقة العمل

| الخطوة | التبويب | ماذا يحدث في AE |
|---|---|---|
| 1. اختر النمط (قمر صناعي، هجين، متجه…) وشغّل/أطفئ الطبقات | النمط | — |
| 2. حرّك الخريطة واضغط **إنشاء Map Comp** | الكومب | كومب جديد + `GEO Map Controls` (Latitude, Longitude, Zoom, Bearing, Pitch) + كاميرا + `GEO Map Anchor` + معاينة أولية |
| 3. حرّك رأس التشغيل في AE، حرّك الخريطة، اضغط **◆ كيفريم** (أو فعّل الكيفريم التلقائي) | الكومب | 5 كيفريمات على طبقة التحكم، Easy Ease |
| 4. ابحث عن دولة / مدينة / نهر، أضفها للمتصفح، أو استورد GeoJSON / KML / GPX / CSV، أو ارسم شكلاً بالنقر | المعالم | — |
| 5. **ارسم في AE**، **أضف اسم**، **حرّك الكاميرا إليه**، **سهم بين مكانين** | المعالم | Shape Layers داخل كومب World مع Trim Paths، أسماء عربية مثبتة على الخريطة، حركة كاميرا، سهم برأس |
| 6. **ثبّت الطبقات المحددة** (صورة جندي، علم، نص…) | الكومب | تبقى في مكانها الجغرافي: Pin Latitude / Longitude / Offset / Scale With Map |
| 7. **Finalize** | الإخراج | صور عالية الدقة (حتى 8K) + صور تفصيلية للقطات القريبة، أو إطارات 3D حقيقية بالتضاريس والمباني |

أعد Finalize بعد أي تغيير في حركة الكاميرا أو النمط.

> ملاحظة: كل الطبقات داخل كومب `World` طبقات 3D (لأن الكومب المطوي Collapse يمرر ميل الكاميرا لطبقاته الـ3D فقط). إن رسمت شيئاً بيدك داخله فاجعله 3D أيضاً حتى يميل مع الخريطة.

### الكاميرا
- **قيم دقيقة**: خط العرض، خط الطول، الزوم، الدوران (Bearing)، الميل (Pitch)، ميلان الأفق (Roll)، واهتزاز الكاميرا (Shake).
- **حركات جاهزة** تبدأ من رأس التشغيل: دوران حول المكان (Orbit)، اقتراب، ابتعاد، زاوية منخفضة نحو الأفق، العودة لمنظر علوي، Crane up، حلزون، طيران منخفض، تحريك يمين/يسار/أعلى/أسفل، Dutch angle، كشف. مع معاينة داخل اللوحة.
- **ثبّت الكاميرا عليه** (Fit view بلا حركة)، **حرّك الكاميرا إليه** مع ثبات بعدها، و**الكاميرا على المسار** (تسير على خط وتتجه معه).

### الرسم والتحديد
- رسم بالنقر: منطقة، خط، **سهم بنقرتين**، **دائرة بنقرتين** (مركز ثم حافة)، نقطة. و**دائرة حول المحدد** بنصف قطر بالكيلومتر (دائرة جغرافية حقيقية).
- لكل معلم: توهج، متقطع، **وميض**، **تعتيم ما حولها (Spotlight)**، الدمج (Screen / Multiply…)، الشفافية.
- **الأسماء**: نص بحدّ أسود، **صندوق ملوّن بأسلوب الجزيرة**، أو **خط إشارة**؛ والعلامة: نقطة أو **نقطة نابضة**.
- **المفضلة** ☆ تبقى لكل المشاريع، **اربط المحدد بالمرساة (3D)**، و**طبقة رسم بالقلم** ثابتة على الخريطة.

### مزايا إضافية
- **المحافظات**: على نتيجة دولة اضغط «+ المحافظات» أو «+ الحدود الداخلية» (Natural Earth، بأسماء عربية؛ يُحمَّل مرة واحدة).
- **ما الموجود هنا؟**: Alt + نقرة على الخريطة تعرض الدولة والمحافظة والمدينة في تلك النقطة.
- **3D**: تضاريس حقيقية، تظليل، مبانٍ مجسمة، سماء وضباب؛ الكاميرا في AE تدور وتميل بنفس نموذج MapLibre (مسافة الكاميرا = 1.5 × ارتفاع الكومب).
- **الأنماط**: Esri World Imagery، هجين (قمر صناعي + طرق وحدود وأسماء)، Sentinel-2 (غير تجاري)، Liberty، Positron، Dark، Fiord، Bright، Esri Topo / Streets / Relief / Ocean / Dark / Light، ورابط بلاطات مخصص.
- **الخطوط**: الأسماء بخط Al Jazeera Arabic Bold إن كان مثبتاً.

## البنية

```
CSXS/manifest.xml     CEP manifest (AEFT 18+, Node enabled)
index.html, css/      واجهة اللوحة (عربية، RTL)
js/main.js            منطق اللوحة: الخريطة، الربط مع التايملاين، المعالم، Finalize
js/geomath.js         Web Mercator، استيفاء الكاميرا، تخطيط الصور، تبسيط الحدود
js/importers.js       GeoJSON / KML / GPX / CSV
js/lib/               MapLibre GL JS 4.7.1 (BSD-3)
jsx/host.jsx          ExtendScript: بناء الكومب والتعابير (expressions) داخل AE
```

داخل AE: كومب `World` بمرجع إحداثيات ثابت (zoom ZR، أصل X0/Y0) يحمل الصور والحدود؛ طبقته في الكومب الرئيسي 3D مع Collapse Transformations، وتعابيرها تقرأ المتحكمات الخمسة. الكاميرا تدور حول المركز بزاوية Pitch.

## الحقوق والمصادر

- MapLibre GL JS — BSD-3-Clause.
- بيانات الخرائط © OpenStreetMap contributors (ODbL)، أنماط OpenFreeMap / OpenMapTiles.
- صور Esri: راجع شروط استخدام Esri قبل الاستخدام التجاري.
- Sentinel-2 cloudless by EOX — CC BY-NC-SA 4.0 (غير تجاري).
- Terrain Tiles on AWS (Mapzen) — راجع الإسناد المطلوب.
- Natural Earth — ملكية عامة.

أنت مسؤول عن شروط كل مزوّد عند الاستخدام في البث.
