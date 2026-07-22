// ═══════════════════════════════════════════════════════════
// STONK ARENA — CI deploy v2 — server-authoritative game engine
// Trades are validated and executed HERE. The browser can no
// longer invent prices, cash or returns.
// ═══════════════════════════════════════════════════════════
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const STOCKS = require("./stocks.json");

setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

const TIINGO = "9be0e7ac6c2a6a337b292855cfc5b872c3fd8348";
const CASH0 = 10000;

// ── helpers ────────────────────────────────────────────────
function monthKey(d = new Date()) {
  return d.getUTCFullYear() + "_" + String(d.getUTCMonth() + 1).padStart(2, "0");
}
function prevMonthKey() {
  const d = new Date();
  d.setUTCDate(1); d.setUTCDate(0); // last day of previous month
  return monthKey(d);
}
function marketStatusET() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const d = et.getDay();
  if (d === 0 || d === 6) return "weekend";
  const m = et.getHours() * 60 + et.getMinutes();
  return m >= 570 && m < 960 ? "open" : "closed";
}
function isWeekendET() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  return day === 0 || day === 6;
}
async function fetchAllPrices() {
  const tickers = Object.keys(STOCKS);
  const out = {};
  for (let i = 0; i < tickers.length; i += 120) {
    const chunk = tickers.slice(i, i + 120).join(",");
    const res = await fetch(`https://api.tiingo.com/iex?tickers=${chunk}&token=${TIINGO}`, {
      headers: { Authorization: `Token ${TIINGO}` },
    });
    if (!res.ok) continue;
    const data = await res.json();
    for (const q of data) {
      const p = q.tngoLast || q.last || q.prevClose;
      if (p && q.ticker) {
        out[q.ticker.toUpperCase()] = {
          p: Math.round(p * 100) / 100,
          c: q.prevClose ? Math.round(((p - q.prevClose) / q.prevClose) * 10000) / 100 : 0,
        };
      }
    }
  }
  return out;
}
async function getPrices(forceFresh = false) {
  const ref = db.doc("market/prices");
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;
  const stale = !data || Date.now() - data.t > 10 * 60 * 1000;
  if (forceFresh || stale) {
    const p = await fetchAllPrices();
    if (Object.keys(p).length > 100) {
      const fresh = { t: Date.now(), p };
      await ref.set(fresh);
      return fresh;
    }
  }
  return data;
}
function portfolioValue(state, prices) {
  let v = state.cash;
  for (const [tk, q] of Object.entries(state.holdings || {})) {
    v += q * (prices.p[tk] ? prices.p[tk].p : 0);
  }
  return v;
}
async function upsertPlayer(uid, approvedName, state, prices, tradeIncrement) {
  const v = portfolioValue(state, prices);
  const doc = {
    value: Math.round(v * 100) / 100,
    ret: Math.round(((v - CASH0) / CASH0) * 10000) / 100,
    updated: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (approvedName) doc.name = approvedName;
  if (tradeIncrement) doc.trades = admin.firestore.FieldValue.increment(1);
  else doc.trades = admin.firestore.FieldValue.increment(0);
  await db.doc(`players_${monthKey()}/${uid}`).set(doc, { merge: true });
}

function emailKey(email) {
  if (!email) return null;
  let [l, d] = String(email).toLowerCase().split("@");
  if (!d) return null;
  l = l.split("+")[0];
  if (d === "googlemail.com") d = "gmail.com";
  if (d === "gmail.com") l = l.replace(/\./g, "");
  return crypto.createHash("sha256").update(l + "@" + d).digest("hex").slice(0, 40);
}
function nameKeyOf(n) {
  return String(n).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "_").slice(0, 30);
}
// Resolve a requested display name to a guaranteed-unique one (or null = keep existing)
async function resolveName(uid, wanted) {
  let name = String(wanted || "").trim().slice(0, 20);
  if (!name) return null;
  const ref = db.doc(`usernames/${nameKeyOf(name)}`);
  try {
    const snap = await ref.get();
    if (!snap.exists) { await ref.set({ uid, name }); return name; } // auto-claim (covers legacy accounts)
    if (snap.data().uid === uid) return name;
    return null; // taken by someone else — refuse
  } catch (e) { return null; }
}
async function restoredState(email, mk) {
  const k = emailKey(email);
  if (!k) return null;
  const r = await db.doc(`retired/${k}`).get();
  if (r.exists && r.data().month === mk) return r.data();
  return null;
}

// ── callable: execute a trade (THE anti-cheat core) ────────
exports.trade = onCall(async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const { ticker, qty, side, name } = req.data || {};
  const n = Math.floor(Number(qty));
  if (!STOCKS[ticker]) throw new HttpsError("invalid-argument", "Unknown ticker");
  if (!Number.isFinite(n) || n < 1 || n > 100000) throw new HttpsError("invalid-argument", "Bad quantity");
  if (side !== "BUY" && side !== "SELL") throw new HttpsError("invalid-argument", "Bad side");
  const ms = marketStatusET();
  if (ms !== "open") throw new HttpsError("failed-precondition", ms === "weekend" ? "Market closed — weekend" : "Market closed — outside trading hours (15:30–22:00 CET)");

  const prices = await getPrices();
  if (!prices || !prices.p[ticker]) throw new HttpsError("unavailable", "No live price for " + ticker);
  const price = prices.p[ticker].p;
  const mk = monthKey();
  const stateRef = db.doc(`states/${uid}`);
  const preSnap = await stateRef.get();
  let seed = null;
  if (!preSnap.exists || preSnap.data().month !== mk) {
    const r = await restoredState(req.auth.token.email, mk);
    if (r) seed = { cash: r.cash, holdings: r.holdings || {}, month: mk };
  }

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    let s = snap.exists ? snap.data() : (seed || { cash: CASH0, holdings: {}, month: mk });
    if (s.month !== mk) s = seed || { cash: CASH0, holdings: {}, month: mk }; // monthly reset

    if (side === "BUY") {
      const cost = price * n;
      if (cost > s.cash + 0.001) throw new HttpsError("failed-precondition", "Insufficient cash");
      const v = portfolioValue(s, prices);
      const posAfter = (s.holdings[ticker] || 0) * price + cost;
      if (posAfter > v * 0.30 + 0.001) throw new HttpsError("failed-precondition", "Max 30% per stock");
      s.cash = Math.round((s.cash - cost) * 100) / 100;
      s.holdings[ticker] = (s.holdings[ticker] || 0) + n;
    } else {
      if ((s.holdings[ticker] || 0) < n) throw new HttpsError("failed-precondition", "Not enough shares");
      s.cash = Math.round((s.cash + price * n) * 100) / 100;
      s.holdings[ticker] -= n;
      if (!s.holdings[ticker]) delete s.holdings[ticker];
    }
    tx.set(stateRef, s);
    tx.set(db.collection("trades").doc(uid).collection("log").doc(), {
      ticker, qty: n, side, price, month: mk,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
    return s;
  });

  // trades never rename: keep the current leaderboard name if one exists and differs
  let rn = null;
  try {
    const pSnapT = await db.doc(`players_${mk}/${uid}`).get();
    const curT = pSnapT.exists ? pSnapT.data().name : null;
    if (curT && name && nameKeyOf(curT) !== nameKeyOf(String(name))) rn = curT;
    else rn = await resolveName(uid, name);
  } catch (e) {}
  await upsertPlayer(uid, rn, result, prices, true);
  return { ok: true, cash: result.cash, holdings: result.holdings, price };
});

// ── callable: register presence + get state (login/app open) ──
exports.hello = onCall(async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const prices = await getPrices();
  const mk = monthKey();
  const stateRef = db.doc(`states/${uid}`);
  const snap = await stateRef.get();
  let s = snap.exists ? snap.data() : null;
  let restoredTrades = 0;
  if (!s || s.month !== mk) {
    const r = await restoredState(req.auth.token.email, mk);
    if (r) { s = { cash: r.cash, holdings: r.holdings || {}, month: mk }; restoredTrades = r.trades || 0; }
    else s = { cash: CASH0, holdings: {}, month: mk };
    await stateRef.set(s);
  }
  const wanted = String((req.data && req.data.name) || "").trim().slice(0, 20);
  const pRef = db.doc(`players_${mk}/${uid}`);
  const pSnap = await pRef.get();
  const curName = pSnap.exists ? pSnap.data().name : null;
  let rn = null, renameBlocked = false;
  // changing an existing (non auto-assigned) name is allowed once per month
  const isRename = wanted && curName && !/^Player-/.test(curName) && nameKeyOf(curName) !== nameKeyOf(wanted);
  if (isRename) {
    const rref = db.doc(`renames/${uid}`);
    const rSnap = await rref.get();
    if (rSnap.exists && rSnap.data().m === mk) { renameBlocked = true; }
    else {
      rn = await resolveName(uid, wanted);
      if (rn) {
        await rref.set({ m: mk, ts: admin.firestore.FieldValue.serverTimestamp() });
        // release this user's old name claims so others can use them
        try {
          const un = await db.collection("usernames").where("uid", "==", uid).get();
          const b = db.batch(); let ch = false;
          un.forEach((u) => { if (u.id !== nameKeyOf(rn)) { b.delete(u.ref); ch = true; } });
          if (ch) await b.commit();
        } catch (e) {}
      }
    }
  } else if (wanted) {
    rn = await resolveName(uid, wanted);
  }
  if (!rn && !curName) rn = "Player-" + uid.slice(0, 5);
  if (prices) await upsertPlayer(uid, rn, s, prices, false);
  if (restoredTrades > 0) await pRef.set({ trades: restoredTrades }, { merge: true });
  const finalName = rn || curName;
  // opportunistic ghost/dupe cleanup on app open (same 5-min throttle as cleanupNow)
  try {
    const meta = db.doc("system/janitor");
    const js = await meta.get();
    if (!js.exists || Date.now() - (js.data().t || 0) > 5 * 60 * 1000) {
      await meta.set({ t: Date.now() });
      await janitorSweep(prices);
    }
  } catch (e) {}
  return { cash: s.cash, holdings: s.holdings, month: mk, name: finalName, renameBlocked };
});

// ── callable: bind this month's result to the email before account deletion ──
exports.retire = onCall(async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Login required");
  const mk = monthKey();
  const k = emailKey(req.auth.token.email);
  const sSnap = await db.doc(`states/${uid}`).get();
  const pSnap = await db.doc(`players_${mk}/${uid}`).get();
  const s = sSnap.exists ? sSnap.data() : null;
  if (k && s && s.month === mk) {
    await db.doc(`retired/${k}`).set({
      month: mk, cash: s.cash, holdings: s.holdings || {},
      trades: (pSnap.exists && pSnap.data().trades) || 0,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  try { await db.doc(`states/${uid}`).delete(); } catch (e) {}
  try { await db.doc(`players_${mk}/${uid}`).delete(); } catch (e) {}
  try {
    const un = await db.collection("usernames").where("uid", "==", uid).get();
    const b = db.batch();
    un.forEach((u) => b.delete(u.ref));
    await b.commit();
  } catch (e) {}
  try { await janitorSweep(null); } catch (e) {}
  return { ok: true };
});

// ── callable: force a price refresh (first visitor of the day) ──
exports.refreshNow = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required");
  const prices = await getPrices(true);
  return { ok: !!prices, count: prices ? Object.keys(prices.p).length : 0 };
});

// ── schedule: refresh price cache every 5 min during market hours ──
exports.refreshPrices = onSchedule(
  { schedule: "*/5 9-16 * * 1-5", timeZone: "America/New_York" },
  async () => { await getPrices(true); }
);

// ── schedule: recompute everyone's value every 15 min (market hours) ──
async function janitorSweep(prices) {
  const mk = monthKey();
  const [statesSnap, playersSnap] = await Promise.all([
    db.collection("states").get(),
    db.collection(`players_${mk}`).get(),
  ]);
  const stateMap = {};
  statesSnap.forEach((d) => (stateMap[d.id] = d.data()));
  const ids = playersSnap.docs.map((d) => ({ uid: d.id }));
  const notFound = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const res = await admin.auth().getUsers(ids.slice(i, i + 100));
      res.notFound.forEach((u) => notFound.add(u.uid));
    } catch (e) {}
  }
  const batch = db.batch();
  const alive = [];
  for (const doc of playersSnap.docs) {
    if (notFound.has(doc.id)) {
      batch.delete(doc.ref);
      batch.delete(db.doc(`states/${doc.id}`));
      try {
        const un = await db.collection("usernames").where("uid", "==", doc.id).get();
        un.forEach((u) => batch.delete(u.ref));
      } catch (e) {}
    } else alive.push(doc);
  }
  const byKey = {};
  for (const doc of alive) {
    const nm = doc.data().name;
    if (!nm) continue;
    const k = nameKeyOf(nm);
    (byKey[k] = byKey[k] || []).push(doc);
  }
  for (const [k, docs] of Object.entries(byKey)) {
    if (docs.length < 2) continue;
    let owner = docs[0].id;
    try {
      const claim = await db.doc(`usernames/${k}`).get();
      if (claim.exists) owner = claim.data().uid;
      else batch.set(db.doc(`usernames/${k}`), { uid: owner, name: docs[0].data().name });
    } catch (e) {}
    for (const d of docs) {
      if (d.id !== owner) batch.set(d.ref, { name: "Player-" + d.id.slice(0, 5) }, { merge: true });
    }
  }
  if (prices) {
    for (const doc of alive) {
      const s = stateMap[doc.id];
      if (!s || s.month !== mk) continue;
      const v = portfolioValue(s, prices);
      batch.set(doc.ref, {
        value: Math.round(v * 100) / 100,
        ret: Math.round(((v - CASH0) / CASH0) * 10000) / 100,
        updated: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
  await batch.commit();
}

exports.revalue = onSchedule(
  { schedule: "*/15 9-16 * * 1-5", timeZone: "America/New_York" },
  async () => {
    const prices = await getPrices();
    await janitorSweep(prices);
  }
);

// ── callable: on-demand cleanup (throttled to once per 5 min) ──
exports.cleanupNow = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Login required");
  const meta = db.doc("system/janitor");
  const snap = await meta.get();
  if (snap.exists && Date.now() - (snap.data().t || 0) < 5 * 60 * 1000) return { ok: true, skipped: true };
  await meta.set({ t: Date.now() });
  let prices = null;
  try { prices = await getPrices(); } catch (e) {}
  await janitorSweep(prices);
  return { ok: true };
});

// ── schedule: month rollover — crown winner, hall of fame, release history ──
exports.monthly = onSchedule(
  { schedule: "10 0 1 * *", timeZone: "America/New_York" },
  async () => {
    const prev = prevMonthKey();
    const snap = await db.collection(`players_${prev}`)
      .orderBy("ret", "desc").limit(20).get();
    let winner = null;
    snap.forEach((d) => {
      const p = d.data();
      if (!winner && (p.trades || 0) >= 5 && !p.flagged) winner = { uid: d.id, ...p };
    });
    if (winner) {
      await db.doc(`winners/${prev}`).set({
        uid: winner.uid, name: winner.name, ret: winner.ret,
        value: winner.value, month: prev,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      });
      await db.doc(`halloffame/${winner.uid}`).set({
        name: winner.name,
        wins: admin.firestore.FieldValue.increment(1),
        lastWin: prev,
      }, { merge: true });
    }
    // release last month's private trade history for everyone
    await db.doc(`releases/${prev}`).set({ open: true, ts: admin.firestore.FieldValue.serverTimestamp() });
  }
);


// ── HTTP: 10y history + profile (FMP primary, Tiingo fallback) served via Hosting CDN ──
const { onRequest } = require("firebase-functions/v2/https");
const FMPKEY = "DH5Ok3sQuOf99czXACqQk0h4ftJpKaDj";
function weeklySample(rows) {
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
exports.history = onRequest({ cors: true }, async (req, res) => {
  const t = String(req.query.ticker || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
  if (!t) { res.status(400).json({ error: "ticker required" }); return; }
  const start = new Date(); start.setFullYear(start.getFullYear() - 10);
  const s = start.toISOString().slice(0, 10);
  let series = [], meta = {};
  try {
    const [pr, mr] = await Promise.all([
      fetch(`https://financialmodelingprep.com/stable/historical-price-eod/light?symbol=${t}&from=${s}&apikey=${FMPKEY}`),
      fetch(`https://financialmodelingprep.com/stable/profile?symbol=${t}&apikey=${FMPKEY}`),
    ]);
    if (pr.ok) {
      let rows = await pr.json();
      if (Array.isArray(rows) && rows.length > 1) {
        rows = rows.filter((r) => r && r.date && r.price > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
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
  if (series.length < 2) {
    try {
      const hdr = { headers: { Authorization: `Token ${TIINGO}` } };
      const pr2 = await fetch(`https://api.tiingo.com/tiingo/daily/${t}/prices?startDate=${s}&resampleFreq=weekly&token=${TIINGO}`, hdr);
      if (pr2.ok) {
        const rows = await pr2.json();
        series = (Array.isArray(rows) ? rows : [])
          .map((p) => [String(p.date).slice(0, 10), Math.round((p.adjClose || p.close || 0) * 100) / 100])
          .filter((x) => x[1] > 0);
      }
    } catch (e) {}
  }
  const ok = series.length > 1;
  res.set("Cache-Control", ok ? "public, max-age=3600, s-maxage=86400" : "public, max-age=120, s-maxage=300");
  res.json({ meta, series });
});
