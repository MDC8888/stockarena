// 10-year monthly history + company profile (Tiingo, server-side, cached 24h)
const TOKEN = "9be0e7ac6c2a6a337b292855cfc5b872c3fd8348";
exports.handler = async function (event) {
  const t = String((event.queryStringParameters || {}).ticker || "")
    .toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
  if (!t) return { statusCode: 400, body: JSON.stringify({ error: "ticker required" }) };
  const start = new Date();
  start.setFullYear(start.getFullYear() - 10);
  const s = start.toISOString().slice(0, 10);
  const hdr = { headers: { Authorization: `Token ${TOKEN}` } };
  try {
    const [pr, mr] = await Promise.all([
      fetch(`https://api.tiingo.com/tiingo/daily/${t}/prices?startDate=${s}&resampleFreq=weekly&token=${TOKEN}`, hdr),
      fetch(`https://api.tiingo.com/tiingo/daily/${t}?token=${TOKEN}`, hdr),
    ]);
    const prices = pr.ok ? await pr.json() : [];
    const meta = mr.ok ? await mr.json() : {};
    const series = (Array.isArray(prices) ? prices : []).map((p) => [
      String(p.date).slice(0, 10),
      Math.round((p.adjClose || p.close || 0) * 100) / 100,
    ]).filter((x) => x[1] > 0);
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      },
      body: JSON.stringify({
        meta: {
          name: meta.name || t,
          exchange: meta.exchangeCode || "",
          since: meta.startDate ? String(meta.startDate).slice(0, 4) : "",
          description: String(meta.description || "").slice(0, 600),
        },
        series,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: e.message }) };
  }
};
