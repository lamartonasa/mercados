// Robot diario (GitHub Actions, 1 vez por día). Guarda en JSON:
//  - pizarra.json + mercados.json (pizarra, flash y dólar de la Cámara Arbitral)
//  - historial-pizarra.json (pizarras de los últimos ~90 días)
//  - mag.json (resumen de hacienda del Mercado Agroganadero)
import * as cheerio from "cheerio";
import fs from "fs";

const URL = "https://www.bolsadecereales.com/camara-arbitral";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FUENTE = "Cámara Arbitral de Cereales — Bolsa de Cereales de Buenos Aires";

const norm = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
function num(raw) {
  const c = (raw || "").replace(/\(e\)/gi, "").replace(/[^0-9.,]/g, "");
  if (!c || /s\/c/i.test(raw)) return null;
  const ld = c.lastIndexOf("."), lc = c.lastIndexOf(",");
  const n = ld === -1 && lc === -1 ? c : lc > ld ? c.replace(/\./g, "").replace(",", ".") : c.replace(/,/g, "");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
const PLAZA = { rosario: "rosario", "bahia blanca": "bahiaBlanca", quequen: "quequen", darsena: "darsena" };
const GRANO = { trigo: "trigo", maiz: "maiz", girasol: "girasol", soja: "soja" };

// La Bolsa bloquea a los servidores: leemos a través de ScraperAPI (IP permitida).
const KEY = process.env.SCRAPER_API_KEY;
const fetchUrl = KEY
  ? `https://api.scraperapi.com/?api_key=${KEY}&url=${encodeURIComponent(URL)}`
  : URL;

async function traerHtml() {
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const r = await fetch(fetchUrl, { headers: { "User-Agent": UA, Accept: "text/html" } });
      if (r.ok) {
        const t = await r.text();
        if (t.includes("bloque-tabla")) return t;
        console.log("Intento", intento, "sin datos esperados");
      } else {
        console.log("Intento", intento, "respondió", r.status);
      }
    } catch (e) {
      console.log("Intento", intento, "falló:", e.message);
    }
    await new Promise((s) => setTimeout(s, 5000));
  }
  return null;
}

const html = await traerHtml();
if (!html) {
  console.log("No se pudo leer la Cámara - se mantienen los datos previos.");
} else {
  const $ = cheerio.load(html);

  let fecha = new Date().toISOString().slice(0, 10);
  const fi = $('input[name="fecha"]').attr("value");
  if (fi) fecha = fi;

  // --- Pizarra ---
  const cell = () => ({ pesos: null, usd: null });
  const precios = {
    rosario: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
    bahiaBlanca: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
    quequen: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
    darsena: { trigo: cell(), maiz: cell(), girasol: cell(), soja: cell() },
  };
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

  // --- Dólar BNA Divisas (de la Cámara) ---
  let dolar = null;
  $("tr").each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length >= 3 && norm($(td[0]).text()).includes("banco nacion")) {
      dolar = { compra: num($(td[1]).text()), venta: num($(td[2]).text()) };
    }
  });

  // --- Flash de cotizaciones ---
  const FG = [["trigo", "Trigo"], ["maiz", "Maíz"], ["soja", "Soja"], ["girasol", "Girasol"]];
  const flash = FG.map(([k, label]) => {
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

  fs.writeFileSync("pizarra.json", JSON.stringify({ fecha, fuente: FUENTE, automatica: true, precios }, null, 2));
  fs.writeFileSync("mercados.json", JSON.stringify({ fecha, flash, dolar }, null, 2));

  // --- Historial completo de pizarras ---
  let histP = [];
  try {
    histP = JSON.parse(fs.readFileSync("historial-pizarra.json", "utf-8"));
  } catch {}
  const hayDato = Object.values(precios).some((p) =>
    Object.values(p).some((c) => c.pesos != null || c.usd != null)
  );
  if (hayDato) {
    histP = histP.filter((d) => d.fecha !== fecha);
    histP.push({ fecha, precios });
    histP.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    histP = histP.slice(-90);
    fs.writeFileSync("historial-pizarra.json", JSON.stringify(histP, null, 2));
  }
  console.log("Cámara OK", fecha, "| dólar", JSON.stringify(dolar), "| historial", histP.length, "días");
}

// ===== MAG (hacienda — Mercado Agroganadero de Cañuelas) =====
// Formato MAG: coma = decimal; punto = miles ("5.130" = 5130 cabezas).
function magNum(raw) {
  const clean = (raw || "").replace(/[^0-9.,]/g, "");
  if (!clean) return null;
  const n = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean.replace(/\./g, "");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
function parseMag(htmlMag) {
  const $ = cheerio.load(htmlMag);
  const categorias = [];
  let inmag = null, igmag = null, totalCabezas = null, fechaMag = "";
  const m = htmlMag.match(/(\d{2}\/\d{2}\/\d{4})\s+AL/i);
  if (m) fechaMag = m[1];
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
  return { fecha: fechaMag, inmag, igmag, totalCabezas, categorias, fuente: "Mercado Agroganadero (MAG) — Cañuelas" };
}

try {
  const magRes = await fetch("https://www.mercadoagroganadero.com.ar/dll/hacienda1.dll/haciinfo000002", {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (magRes.ok) {
    const magHtml = Buffer.from(await magRes.arrayBuffer()).toString("latin1");
    const mag = parseMag(magHtml);
    if (mag.categorias.length > 0) {
      fs.writeFileSync("mag.json", JSON.stringify(mag, null, 2));
      console.log("MAG OK", mag.fecha, "|", mag.categorias.length, "categorías");
    } else {
      console.log("MAG sin tabla (feriado/jueves) - se mantiene el previo");
    }
  } else {
    console.log("MAG respondió", magRes.status);
  }
} catch (e) {
  console.log("MAG falló:", e.message);
}
