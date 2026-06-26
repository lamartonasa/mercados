// Robot diario: lee la pizarra de cereales y el dólar BNA Divisas de la
// Cámara Arbitral (Bolsa de Cereales de Bs. As.) y guarda los datos en JSON.
// Corre en GitHub Actions (1 vez por día), donde la fuente no bloquea.
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

const res = await fetch(URL, { headers: { "User-Agent": UA, Accept: "text/html" } });
if (!res.ok) {
  console.log("Fuente respondió", res.status, "- se mantienen los datos previos.");
  process.exit(0); // no pisar los datos buenos
}
const html = await res.text();
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

// --- Dólar BNA Divisas ---
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

// --- Guardar archivos ---
fs.writeFileSync("pizarra.json", JSON.stringify({ fecha, fuente: FUENTE, automatica: true, precios }, null, 2));
fs.writeFileSync("mercados.json", JSON.stringify({ fecha, flash, dolar }, null, 2));

// --- Historial (para la evolución) ---
let hist = [];
try {
  hist = JSON.parse(fs.readFileSync("historial.json", "utf-8"));
} catch {}
const snap = {
  fecha,
  dolar,
  pizarra: {
    rosario: { trigo: precios.rosario.trigo.pesos, maiz: precios.rosario.maiz.pesos, soja: precios.rosario.soja.pesos },
  },
};
hist = hist.filter((h) => h.fecha !== fecha);
hist.push(snap);
hist.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
hist = hist.slice(-40); // últimos ~40 días
fs.writeFileSync("historial.json", JSON.stringify(hist, null, 2));

console.log("OK", fecha, "| dólar", JSON.stringify(dolar), "| historial", hist.length, "días");
