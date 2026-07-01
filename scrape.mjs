// Robot diario (GitHub Actions). Guarda en JSON:
//  - pizarra.json + mercados.json (pizarra, flash y dólar de la Cámara Arbitral)
//  - historial-pizarra.json (pizarras de los últimos ~90 días)
//  - dolar.json (Cotización Divisas del Banco Nación, valor del día)
import * as cheerio from "cheerio";
import fs from "fs";

const URL = "https://www.bolsadecereales.com/camara-arbitral";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FUENTE = "Cámara Arbitral de Cereales — Bolsa de Cereales de Buenos Aires";
const KEY = process.env.SCRAPER_API_KEY;
const viaScraper = (u) =>
  KEY ? `https://api.scraperapi.com/?api_key=${KEY}&url=${encodeURIComponent(u)}` : u;

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

async function traerHtml() {
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const r = await fetch(viaScraper(URL), { headers: { "User-Agent": UA, Accept: "text/html" } });
      if (r.ok) {
        const t = await r.text();
        if (t.includes("bloque-tabla")) return t;
        console.log("Cámara intento", intento, "sin datos");
      } else console.log("Cámara intento", intento, "->", r.status);
    } catch (e) {
      console.log("Cámara intento", intento, "falló:", e.message);
    }
    await new Promise((s) => setTimeout(s, 5000));
  }
  return null;
}

// ===== Cámara Arbitral (pizarra + flash + historial) =====
const html = await traerHtml();
if (!html) {
  console.log("No se pudo leer la Cámara - se mantienen los datos previos.");
} else {
  const $ = cheerio.load(html);
  let fecha = new Date().toISOString().slice(0, 10);
  const fi = $('input[name="fecha"]').attr("value");
  if (fi) fecha = fi;

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

  let dolarCamara = null;
  $("tr").each((_, tr) => {
    const td = $(tr).find("td");
    if (td.length >= 3 && norm($(td[0]).text()).includes("banco nacion")) {
      dolarCamara = { compra: num($(td[1]).text()), venta: num($(td[2]).text()) };
    }
  });

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

  // --- Rosario AL DÍA desde la Cámara de Rosario (cac.bcr), que va más rápido ---
  async function getCacRosario() {
    const U = "https://cac.bcr.com.ar/es/precios-de-pizarra";
    const api = KEY ? `https://api.scraperapi.com/?api_key=${KEY}&url=${encodeURIComponent(U)}` : U;
    const MAP = { trigo: "trigo", maiz: "maiz", girasol: "girasol", soja: "soja" };
    for (let i = 1; i <= 5; i++) {
      try {
        const r = await fetch(api, { headers: { "User-Agent": UA } });
        if (r.ok) {
          const h = await r.text();
          if (h.includes("board-prices")) {
            const $r = cheerio.load(h);
            const mF = h.match(/Pizarra del d[ií]a\s*(\d{2})\/(\d{2})\/(\d{4})/i);
            const fechaR = mF ? `${mF[3]}-${mF[2]}-${mF[1]}` : null;
            const ros = {};
            $r(".board-prices .board").each((_, b) => {
              const key = MAP[norm($r(b).find("h3").first().text())];
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
  if (cac) {
    for (const g of ["trigo", "maiz", "girasol", "soja"]) if (cac.ros[g]) precios.rosario[g] = cac.ros[g];
    if (cac.fecha) fecha = cac.fecha;
    console.log("cac.bcr OK — Rosario al día:", cac.fecha);
  } else {
    console.log("cac.bcr no respondió — Rosario queda de Buenos Aires");
  }

  fs.writeFileSync("pizarra.json", JSON.stringify({ fecha, fuente: FUENTE, automatica: true, precios }, null, 2));
  fs.writeFileSync("mercados.json", JSON.stringify({ fecha, flash, dolar: dolarCamara }, null, 2));

  let histP = [];
  try { histP = JSON.parse(fs.readFileSync("historial-pizarra.json", "utf-8")); } catch {}
  const hayDato = Object.values(precios).some((p) => Object.values(p).some((c) => c.pesos != null || c.usd != null));
  if (hayDato) {
    histP = histP.filter((d) => d.fecha !== fecha);
    histP.push({ fecha, precios });
    histP.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    histP = histP.slice(-90);
    fs.writeFileSync("historial-pizarra.json", JSON.stringify(histP, null, 2));
  }
  console.log("Cámara OK", fecha, "| historial", histP.length, "días");
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

const bna = await getBnaDolar();
if (bna) {
  fs.writeFileSync("dolar.json", JSON.stringify(bna, null, 2));
  console.log("Dólar BNA OK", bna.fecha, "|", bna.compra + "/" + bna.venta);
} else {
  console.log("Dólar BNA: no se pudo (se mantiene el previo)");
}
