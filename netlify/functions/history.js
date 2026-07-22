// 10y history + company profile — FMP primary (paid key), Tiingo fallback. CDN-cached 24h.
const FMP = "DH5Ok3sQuOf99czXACqQk0h4ftJpKaDj";
const TIINGO = "9be0e7ac6c2a6a337b292855cfc5b872c3fd8348";

function weeklySample(rows) {
  // rows ascending [{date, price}] daily → keep last trading day per ISO week
  const byWeek = new Map();
  for (const r of rows) {
    const d = new Date(r.date + "T00:00:00Z");
    const y = d.getUTCFullYear();
    const onejan = new Date(Date.UTC(y, 0, 1));
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getUTCDay() + 1) / 7);
    byWeek.set(y + "-" + week, [r.date, Math.round(r.price * 100) / 100]);
  }
  return [...byWeek.values()];
}

exports.handler = async function (event) {
  const t = String((event.queryStringParameters || {}).ticker || "")
    .toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
  if (!t) return { statusCode: 400, body: JSON.stringify({ error: "ticker required" }) };
  const start = new Date();
  start.setFullYear(start.getFullYear() - 10);
  const s = start.toISOString().slice(0, 10);

  let series = [], meta = {};

  // ── Primary: FMP (paid) ──
  try {
    const [pr, mr] = await Promise.all([
      fetch(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${t}&from=${s}&apikey=${FMP}`),
      fetch(`https://financialmodelingprep.com/stable/profile?symbol=${t}&apikey=${FMP}`),
    ]);
    if (pr.ok) {
      let rows = await pr.json();
      if (Array.isArray(rows) && rows.length > 1) {
        rows = rows
          .filter((r) => r && r.date && r.price > 0)
          .sort((a, b) => (a.date < b.date ? -1 : 1));
        series = weeklySample(rows);
      }
    }
    if (mr.ok) {
      const p = await mr.json();
      const m = Array.isArray(p) ? p[0] : p;
      if (m) meta = {
        name: m.companyName || t,
        exchange: m.exchange || m.exchangeShortName || "",
        since: m.ipoDate ? String(m.ipoDate).slice(0, 4) : "",
        description: String(m.description || "").slice(0, 1500),
      };
    }
  } catch (e) {}

  // ── Fallback: Tiingo ──
  if (series.length < 2) {
    try {
      const hdr = { headers: { Authorization: `Token ${TIINGO}` } };
      const [pr2, mr2] = await Promise.all([
        fetch(`https://api.tiingo.com/tiingo/daily/${t}/prices?startDate=${s}&resampleFreq=weekly&token=${TIINGO}`, hdr),
        fetch(`https://api.tiingo.com/tiingo/daily/${t}?token=${TIINGO}`, hdr),
      ]);
      if (pr2.ok) {
        const rows = await pr2.json();
        series = (Array.isArray(rows) ? rows : [])
          .map((p) => [String(p.date).slice(0, 10), Math.round((p.adjClose || p.close || 0) * 100) / 100])
          .filter((x) => x[1] > 0);
      }
      if (!meta.name && mr2.ok) {
        const m2 = await mr2.json();
        meta = {
          name: m2.name || t,
          exchange: m2.exchangeCode || "",
          since: m2.startDate ? String(m2.startDate).slice(0, 4) : "",
          description: String(m2.description || "").slice(0, 1500),
        };
      }
    } catch (e) {}
  }

  const ok = series.length > 1;
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": ok ? "public, max-age=86400" : "public, max-age=300",
      "Netlify-CDN-Cache-Control": ok ? "public, durable, max-age=86400" : "public, max-age=300",
    },
    body: JSON.stringify({ meta, series }),
  };
};
