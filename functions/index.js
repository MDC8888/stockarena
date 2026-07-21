// ═══════════════════════════════════════════════════════════
// STONK ARENA — server-authoritative game engine
// Trades are validated and executed HERE. The browser can no
// longer invent prices, cash or returns.
// ═══════════════════════════════════════════════════════════
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

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
async function upsertPlayer(uid, name, state, prices, tradeIncrement) {
  const v = portfolioValue(state, prices);
  const doc = {
    name: String(name || "Player").slice(0, 20),
    value: Math.round(v * 100) / 100,
    ret: Math.round(((v - CASH0) / CASH0) * 10000) / 100,
    updated: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (tradeIncrement) doc.trades = admin.firestore.FieldValue.increment(1);
  else doc.trades = admin.firestore.FieldValue.increment(0);
  await db.doc(`players_${monthKey()}/${uid}`).set(doc, { merge: true });
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
  if (isWeekendET()) throw new HttpsError("failed-precondition", "Market closed — weekend");

  const prices = await getPrices();
  if (!prices || !prices.p[ticker]) throw new HttpsError("unavailable", "No live price for " + ticker);
  const price = prices.p[ticker].p;
  const mk = monthKey();
  const stateRef = db.doc(`states/${uid}`);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    let s = snap.exists ? snap.data() : { cash: CASH0, holdings: {}, month: mk };
    if (s.month !== mk) s = { cash: CASH0, holdings: {}, month: mk }; // monthly reset

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

  await upsertPlayer(uid, name, result, prices, true);
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
  let s = snap.exists ? snap.data() : { cash: CASH0, holdings: {}, month: mk };
  if (s.month !== mk) { s = { cash: CASH0, holdings: {}, month: mk }; await stateRef.set(s); }
  else if (!snap.exists) await stateRef.set(s);
  if (prices) await upsertPlayer(uid, req.data && req.data.name, s, prices, false);
  return { cash: s.cash, holdings: s.holdings, month: mk };
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
exports.revalue = onSchedule(
  { schedule: "*/15 9-16 * * 1-5", timeZone: "America/New_York" },
  async () => {
    const prices = await getPrices();
    if (!prices) return;
    const mk = monthKey();
    const states = await db.collection("states").get();
    const batch = db.batch();
    let i = 0;
    states.forEach((doc) => {
      const s = doc.data();
      if (s.month !== mk) return;
      const v = portfolioValue(s, prices);
      batch.set(db.doc(`players_${mk}/${doc.id}`), {
        value: Math.round(v * 100) / 100,
        ret: Math.round(((v - CASH0) / CASH0) * 10000) / 100,
        updated: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      i++;
    });
    if (i > 0) await batch.commit();
  }
);

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
