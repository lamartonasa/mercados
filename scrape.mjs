// Robot diario (GitHub Actions). Guarda en JSON:
//  - pizarra.json + mercados.json (pizarra, flash y dólar de la Cámara Arbitral)
//  - historial-pizarra.json (pizarras de los últimos ~90 días)
//  - dolar.json (Cotización Divisas del Banco Nación, valor del día)
//  - mag.json (resumen de hacienda del Mercado Agroganadero — último día cerrado)
//  - arrendamiento.json (índice de arrendamientos rurales del MAG — historial)
//
// Modo (argumento): "pizarra" | "dolar" | "all" (por defecto "all").
//  - pizarra: pizarra + flash (Cámara)   -> se corre a la mañana (10:45), 1 vez
//  - dolar:   dólar BNA                   -> se corre 15:30 y 16:30
//  - hacienda + arrendamientos: SIEMPRE (son baratos y así toman el cierre)
import * as cheerio from "cheerio";
import fs from "fs";

const MODE = (process.argv[2] || "all").toLowerCase();
const doPizarra = MODE === "all" || MODE === "pizarra";
const doDolar = MODE === "all" || MODE === "dolar";
const doHacienda = true;
const doArr = true;

const URL = "https://www.bolsadecereales.com/camara-arbitral";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FUENTE = "Cámara Arbitral de Cereales — Bolsa de Cereales de Buenos Aires";
const KEY = process.env.SCRAPER_API_KEY;
const viaScraper = (u, geo) =>
  KEY
    ? `https://api.scraperapi.com/?api_key=${KEY}${geo ? "&country_code=ar" : ""}&url=${encodeURIComponent(u)}`
    : u;

const norm = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
// Formato Cámara: "el último separador es el decimal".
// "(E)" = valor ESTIMADO (no es cotización real) -> se trata como s/c (null).
function num(raw) {
  if (/\(e\)/i.test(raw || "")) return null;
  const c = (raw || "").replace(/[^0-9.,]/g, "");
  if (!c || /s\/c/i.test(raw)) return null;
  const ld = c.lastIndexOf("."), lc = c.lastIndexOf(",");
  const n = ld === -1 && lc === -1 ? c : lc > ld ? c.replace(/\./g, "").replace(",", ".") : c.replace(/,/g, "");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
// Formato MAG: coma = decimal; punto = miles.
function magNum(raw) {
  const clean = (raw || "").replace(/[^0-9.,]/g, "");
  if (!clean) return null;
  const n = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean.replace(/\./g, "");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
const ddmmyyyy = (d) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;

const PLAZA = { rosario: "rosario", "bahia blanca": "bahiaBlanca", quequen: "quequen", darsena: "darsena" };
const GRANO = { trigo: "trigo", maiz: "maiz", girasol: "girasol", soja: "soja" };

async function traerHtml(geo) {
  const tag = geo ? "Cámara AR" : "Cámara";
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const r = await fetch(viaScraper(URL, geo), { headers: { "User-Agent": UA, Accept: "text/html" } });
      if (r.ok) {
        const t = await r.text();
        if (t.includes("bloque-tabla")) return t;
        console.log(tag, "intento", intento, "sin datos");
      } else console.log(tag, "intento", intento, "->", r.status);
    } catch (e) {
      console.log(tag, "intento", intento, "falló:", e.message);
    }
    await new Promise((s) => setTimeout(s, 5000));
  }
  return null;
}

// ===== Cámara Arbitral (pizarra + flash + historial) =====
if (doPizarra) {
  // Bolsa de Cereales (todas las plazas + flash + dólar). Standard; si falla, geo AR.
  let html = await traerHtml();
  if (!html) {
    console.log("Cámara standard sin datos — reintento con IP argentina…");
    html = await traerHtml("ar");
  }

  // Cámara de ROSARIO (cac.bcr): Rosario al día. INDEPENDIENTE de la Bolsa.
  async function getCacRosario() {
    const U = "https://cac.bcr.com.ar/es/precios-de-pizarra";
    const MAP = { trigo: "trigo", maiz: "maiz", girasol: "girasol", soja: "soja" };
    for (let i = 1; i <= 5; i++) {
      try {
        const r = await fetch(viaScraper(U), { headers: { "User-Agent": UA } });
        if (r.ok) {
          const h = await r.text();
          if (h.includes("board-prices")) {
            const $r = cheerio.load(h);
            const mF = h.match(/Pizarra del d[ií]a\s*(\d{2})\/(\d{2})\/(\d{4})/i);
            const fechaR = mF ? `${mF[3]}-${mF[2]}-${mF[1]}` : null;
            const ros = {};
            // El grano viene en la CLASE del bloque: board-trigo / board-maiz / …
            $r(".board-prices .board").each((_, b) => {
              const mg = ($r(b).attr("class") || "").match(/board-(trigo|maiz|ma[ií]z|girasol|soja)/i);
              if (!mg) return;
              const key = MAP[norm(mg[1])];
              if (!key) return;
              ros[key] = {
                pesos: num($r(b).find(".price").first().text()),
                usd: num($r(b).find(".bottom .cell").first().text().replace(/US\$/i, "")),
              };
            });
            if (Object.keys(ros).length >= 3) return { fecha: fechaR, ros };
          }
        } else console.log("cac.bcr intento", i, "->", r.status);
      } catch (e) {
        console.log("cac.bcr intento", i, "falló:", e.message);
      }
      await new Promise((s) => setTimeout(s, 4000));
    }
    return null;
  }
  const cac = await getCacRosario();

  if (!html && !cac) {
    console.log("No se pudo leer ni la Bolsa ni cac.bcr — se mantienen los datos previos.");
  } else {
    let fecha = new Date().toISOString().slice(0, 10);
    const cell = () => ({ pesos: null, usd: null });
    const precios = {
      rosario: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
      bahiaBlanca: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
      quequen: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
      darsena: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
    };
    let flash = [];
    let dolarCamara = null;
    const huboBolsa = !!html;

    if (html) {
      const $ = cheerio.load(html);
      const fi = $('input[name="fecha"]').attr("value");
      if (fi) fecha = fi;
      $(".bloque-tabla").each((_, b) => {
        const plaza = PLAZA[norm($(b).find(".titulo-tabla").first().text())];
        if (!plaza) return;
        $(b).find("table.tabla-cotizaciones").each((idx, t) => {
          const mon = idx === 0 ? "pesos" : "usd";
          $(t).find("tr").each((__, tr) => {
            const td = $(tr).find("td");
            if (td.length < 3) return;
            const g = GRANO[norm($(td[0]).text())];
            if (!g) return;
            const v = num($(td[1]).text());
            if (v != null) precios[plaza][g][mon] = v;
          });
        });
      });
      $("tr").each((_, tr) => {
        const td = $(tr).find("td");
        if (td.length >= 3 && norm($(td[0]).text()).includes("banco nacion")) {
          dolarCamara = { compra: num($(td[1]).text()), venta: num($(td[2]).text()) };
        }
      });
      const FG = [["trigo", "Trigo"], ["maiz", "Maíz"], ["soja", "Soja"], ["girasol", "Girasol"]];
      flash = FG.map(([k, label]) => {
        const cats = [];
        let cur = null;
        $(`table#flash-${k} tbody tr`).each((_, tr) => {
          const td = $(tr).find("td");
          if (td.length === 1 || $(td[0]).attr("colspan")) {
            cur = { titulo: $(td[0]).text().trim(), filas: [] };
            cats.push(cur);
          } else if (td.length >= 4 && cur) {
            const sc = $(td[2]).find("span").attr("class") || "";
            const vd = sc.includes("up") ? "up" : sc.includes("down") ? "down" : "igual";
            const n = num($(td[3]).text());
            cur.filas.push({
              mercado: $(td[0]).text().trim().replace(/\s+/g, " "),
              posicion: $(td[1]).text().trim(),
              varDir: vd,
              precio: n != null ? n.toLocaleString("es-AR") : "s/c",
            });
          }
        });
        return { grano: label, categorias: cats };
      });
    }

    // Rosario al día + fecha más fresca desde cac.bcr.
    if (cac) {
      for (const g of ["trigo", "maiz", "girasol", "soja"]) if (cac.ros[g]) precios.rosario[g] = cac.ros[g];
      if (cac.fecha) fecha = cac.fecha;
      console.log("cac.bcr OK — Rosario al día:", cac.fecha);
    } else {
      console.log("cac.bcr no respondió — Rosario queda de la Bolsa");
    }

    const hayDato = Object.values(precios).some((p) => Object.values(p).some((c) => c.pesos != null || c.usd != null));
    if (hayDato) {
      fs.writeFileSync("pizarra.json", JSON.stringify({ fecha, fuente: FUENTE, automatica: true, precios }, null, 2));
      // El flash sólo lo tiene la Bolsa: si no respondió, no pisamos el anterior.
      if (huboBolsa) {
        fs.writeFileSync("mercados.json", JSON.stringify({ fecha, flash, dolar: dolarCamara }, null, 2));
      }
      let histP = [];
      try { histP = JSON.parse(fs.readFileSync("historial-pizarra.json", "utf-8")); } catch {}
      histP = histP.filter((d) => d.fecha !== fecha);
      histP.push({ fecha, precios });
      histP.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
      histP = histP.slice(-90);
      fs.writeFileSync("historial-pizarra.json", JSON.stringify(histP, null, 2));
      console.log("Pizarra OK", fecha, "| historial", histP.length, "días", huboBolsa ? "(bolsa+cac)" : "(solo cac)");
    } else {
      console.log("Pizarra: sin datos utilizables — no se escribe.");
    }
  }
}

// ===== Dólar Banco Nación — Cotización Divisas (valor del día) =====
async function getBnaDolar() {
  for (let i = 1; i <= 5; i++) {
    try {
      const r = await fetch(viaScraper("https://www.bna.com.ar/Personas"), { headers: { "User-Agent": UA } });
      if (r.ok) {
        const $ = cheerio.load(await r.text());
        const cont = $("#divisas");
        const m = cont.text().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        const fecha = m
          ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`
          : new Date().toISOString().slice(0, 10);
        let compra = null, venta = null;
        cont.find("tr").each((_, tr) => {
          const td = $(tr).find("td");
          if (td.length >= 3 && /d[oó]lar u\.?s\.?a/i.test($(td[0]).text())) {
            compra = num($(td[1]).text());
            venta = num($(td[2]).text());
          }
        });
        if (compra != null && venta != null) return { fecha, compra, venta };
      }
      console.log("BNA intento", i, "->", r.status);
    } catch (e) { console.log("BNA intento", i, "falló:", e.message); }
    await new Promise((s) => setTimeout(s, 4000));
  }
  return null;
}

if (doDolar) {
  const bna = await getBnaDolar();
  if (bna) {
    fs.writeFileSync("dolar.json", JSON.stringify(bna, null, 2));
    console.log("Dólar BNA OK", bna.fecha, "|", bna.compra + "/" + bna.venta);
  } else {
    console.log("Dólar BNA: no se pudo (se mantiene el previo)");
  }
}

// ===== Hacienda MAG — último cuadro CERRADO (no provisorio) =====
if (doHacienda) {
  const MAGBASE = "https://www.mercadoagroganadero.com.ar/dll/hacienda1.dll/haciinfo000002";
  function parseMagBoard(html) {
    const $ = cheerio.load(html);
    const categorias = [];
    let inmag = null, igmag = null, totalCabezas = null, fecha = "";
    const m = html.match(/(\d{2}\/\d{2}\/\d{4})\s+AL/i);
    if (m) fecha = m[1];
    const provisorio = /PROVISORIO/i.test(html);
    let lastGroup = "";
    $("tr").each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length < 6) return;
      const cat = $(tds[0]).text().replace(/\s+/g, " ").trim();
      const prom = magNum($(tds[3]).text());
      if (/totales/i.test($(tr).text())) {
        igmag = prom ?? igmag;
        totalCabezas = magNum($(tds[5]).text()) ?? totalCabezas;
        return;
      }
      if (cat === "" && prom != null) {
        if (lastGroup.startsWith("NOVILLOS")) inmag = prom;
        return;
      }
      if (!cat || /categoria|m[ií]nimo/i.test($(tr).text().slice(0, 40))) return;
      const min = magNum($(tds[1]).text());
      const max = magNum($(tds[2]).text());
      const cabezas = magNum($(tds[5]).text());
      if (min == null && max == null && prom == null) return;
      lastGroup = cat;
      categorias.push({ cat, min, max, prom, cabezas });
    });
    return { fecha, provisorio, inmag, igmag, totalCabezas, categorias };
  }
  async function fetchMag(qs) {
    const u = qs ? `${MAGBASE}?${qs}` : MAGBASE;
    for (let i = 1; i <= 4; i++) {
      try {
        const r = await fetch(viaScraper(u), { headers: { "User-Agent": UA } });
        if (r.ok) {
          const h = Buffer.from(await r.arrayBuffer()).toString("latin1");
          if (h.includes("CATEGORIA") || h.includes("Totales")) return h;
        } else console.log("MAG intento", i, "->", r.status);
      } catch (e) { console.log("MAG intento", i, "falló:", e.message); }
      await new Promise((s) => setTimeout(s, 4000));
    }
    return null;
  }
  let magData = null;
  const hoy = new Date();
  for (let back = 0; back <= 7 && !magData; back++) {
    let qs = "";
    if (back > 0) {
      const d = new Date(hoy);
      d.setDate(d.getDate() - back);
      const f = encodeURIComponent(ddmmyyyy(d));
      qs = `txtFechaIni=${f}&txtFechaFin=${f}`;
    }
    const h = await fetchMag(qs);
    if (!h) continue;
    const d = parseMagBoard(h);
    // Nos quedamos con el último cuadro COMPLETO y CERRADO (no provisorio).
    if (!d.provisorio && d.categorias.length >= 5 && d.totalCabezas) magData = d;
  }
  if (magData) {
    magData.fuente = "Mercado Agroganadero (MAG) — Cañuelas";
    fs.writeFileSync("mag.json", JSON.stringify(magData, null, 2));
    console.log("MAG OK", magData.fecha, "| cab", magData.totalCabezas, "| cat", magData.categorias.length);
  } else {
    console.log("MAG: no se obtuvo un cuadro cerrado (se mantiene el previo)");
  }
}

// ===== Arrendamientos rurales (índice MAG) — historial acumulado =====
if (doArr) {
  const ARRBASE = "https://www.mercadoagroganadero.com.ar/dll/hacienda2.dll/haciinfo000013";
  const hoy = new Date();
  const ini = new Date(hoy);
  ini.setDate(ini.getDate() - 35); // ~35 días => ~15-18 operativos
  const qs = `txtFechaIni=${encodeURIComponent(ddmmyyyy(ini))}&txtFechaFin=${encodeURIComponent(ddmmyyyy(hoy))}`;
  async function fetchArr() {
    for (let i = 1; i <= 4; i++) {
      try {
        const r = await fetch(viaScraper(`${ARRBASE}?${qs}`), { headers: { "User-Agent": UA } });
        if (r.ok) {
          const h = Buffer.from(await r.arrayBuffer()).toString("latin1");
          if (/arrendamiento/i.test(h)) return h;
        } else console.log("Arr intento", i, "->", r.status);
      } catch (e) { console.log("Arr intento", i, "falló:", e.message); }
      await new Promise((s) => setTimeout(s, 4000));
    }
    return null;
  }
  const h = await fetchArr();
  if (h) {
    const $ = cheerio.load(h);
    const nuevos = [];
    $("tr").each((_, tr) => {
      const c = $(tr).find("td").map((__, x) => $(x).text().replace(/\s+/g, " ").trim()).get();
      const m = (c[0] || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (m && c.length >= 4 && !/totales/i.test(c[0])) {
        nuevos.push({ fecha: `${m[3]}-${m[2]}-${m[1]}`, cabezas: magNum(c[1]), indice: magNum(c[3]) });
      }
    });
    if (nuevos.length) {
      let hist = [];
      try { hist = JSON.parse(fs.readFileSync("arrendamiento.json", "utf-8")); } catch {}
      const map = new Map(hist.map((d) => [d.fecha, d]));
      for (const n of nuevos) {
        const prev = map.get(n.fecha);
        // Sólo piso si el nuevo trae índice (día cerrado) o si no existía.
        if (!prev || n.indice != null) map.set(n.fecha, n);
      }
      hist = [...map.values()].sort((a, b) => (a.fecha < b.fecha ? -1 : 1)).slice(-120);
      fs.writeFileSync("arrendamiento.json", JSON.stringify(hist, null, 2));
      console.log("Arrendamientos OK —", hist.length, "días");
    } else console.log("Arrendamientos: sin filas");
  } else {
    console.log("Arrendamientos: no respondió (se mantiene el previo)");
  }
}
