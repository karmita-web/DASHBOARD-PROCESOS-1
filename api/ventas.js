/**
 * Función serverless (Vercel) que actúa como capa de acceso a datos.
 * - Lee el CSV publicado de Google Sheets desde la variable de entorno SHEET_CSV_URL
 *   (la URL no queda expuesta en el código del navegador ni en el repositorio).
 * - Cachea en el CDN de Vercel 15 min y sirve contenido anterior mientras revalida.
 */
module.exports = async (req, res) => {
  const url = process.env.SHEET_CSV_URL;
  if (!url) {
    res.status(500).json({ error: 'Falta configurar la variable de entorno SHEET_CSV_URL' });
    return;
  }
  try {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error('Google Sheets respondió con estado ' + r.status);
    const text = await r.text();
    if (!/fecha/i.test(text.slice(0, 200))) throw new Error('La respuesta no parece el CSV esperado (¿hoja no publicada?)');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    res.setHeader('X-Fetched-At', new Date().toISOString());
    res.status(200).send(text);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
};
