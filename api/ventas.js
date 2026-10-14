// API serverless (Vercel) - GET /api/ventas
// Lee el CSV publicado de Google Sheets, lo valida/normaliza y lo entrega como JSON.
// Variable de entorno opcional: SHEET_CSV_URL (para cambiar la fuente sin tocar el código).

const DEFAULT_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRZhG16c6gNzf_76m8fnRuDOnFbYdnDDvr-9PnoEiQOVQLL30TvE44RYisrBVXTUeuZFXvD6Mtqt7ht/pub?output=csv";

// ---------- Utilidades ----------

// Parser CSV (RFC 4180): soporta comillas, comas y saltos de línea dentro de campos.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}

const norm = s => String(s || "").trim().toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "");

// "$1,250.00" -> 1250 | "1.250,50" -> 1250.5 | "" -> NaN
function parseMonto(v) {
  let s = String(v || "").replace(/[^\d.,-]/g, "");
  if (!s) return NaN;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot > -1 && lastComma > -1) {
    // El último separador es el decimal
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    // Solo comas: decimal si hay 1-2 dígitos tras la última coma
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

// Detecta si la columna de fechas es D/M/Y o M/D/Y mirando todo el conjunto.
function detectDateOrder(values) {
  let dm = 0, md = 0;
  for (const v of values) {
    const m = String(v).trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (!m) continue;
    if (+m[1] > 12) dm++;
    else if (+m[2] > 12) md++;
  }
  return md > dm ? "MDY" : "DMY"; // por defecto D/M/Y (formato regional)
}

function parseFecha(v, order) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
    if (!m) return null;
    if (order === "MDY") { mo = +m[1]; d = +m[2]; } else { d = +m[1]; mo = +m[2]; }
    y = +m[3]; if (y < 100) y += 2000;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// Sinónimos de encabezados -> campo canónico
const FIELD_ALIASES = {
  fecha: ["fecha", "date"],
  vendedor: ["vendedor", "asesor", "seller"],
  producto: ["producto", "product", "articulo"],
  monto: ["monto", "venta", "ventas", "importe", "total", "amount"],
  region: ["region", "ciudad", "zona", "sucursal"],
};

function mapHeaders(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const k = norm(h);
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (idx[field] === undefined && aliases.includes(k)) idx[field] = i;
    }
  });
  return idx;
}

// ---------- Handler ----------

module.exports = async function handler(req, res) {
  if (req.method && req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido" });
  }
  const url = process.env.SHEET_CSV_URL || DEFAULT_CSV_URL;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`La fuente respondió HTTP ${r.status}`);
    const rows = parseCSV(await r.text());
    if (rows.length < 2) throw new Error("La hoja no contiene datos");

    const idx = mapHeaders(rows[0]);
    const faltantes = Object.keys(FIELD_ALIASES).filter(f => idx[f] === undefined);
    if (faltantes.length) throw new Error("Columnas no encontradas: " + faltantes.join(", "));

    const body = rows.slice(1);
    const order = detectDateOrder(body.map(r => r[idx.fecha]));

    const registros = [];
    let descartados = 0;
    for (const r of body) {
      const fecha = parseFecha(r[idx.fecha], order);
      const monto = parseMonto(r[idx.monto]);
      const vendedor = (r[idx.vendedor] || "").trim();
      const producto = (r[idx.producto] || "").trim();
      const region = (r[idx.region] || "").trim();
      if (!fecha || !Number.isFinite(monto) || !vendedor || !producto || !region) {
        descartados++;
        continue;
      }
      registros.push({ fecha, vendedor, producto, region, monto });
    }
    registros.sort((a, b) => a.fecha.localeCompare(b.fecha));

    // Caché en el borde de Vercel: 5 min fresco, 10 min sirviendo versión previa mientras revalida
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      actualizado: new Date().toISOString(),
      total: registros.length,
      descartados,
      registros,
    });
  } catch (e) {
    return res.status(502).json({ error: "No fue posible leer la fuente de datos", detalle: String(e.message || e) });
  }
};

// Exportados para pruebas
module.exports.parseCSV = parseCSV;
module.exports.parseMonto = parseMonto;
module.exports.parseFecha = parseFecha;
