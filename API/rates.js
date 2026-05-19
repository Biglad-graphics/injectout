// api/rates.js
const axios = require("axios");

const CACHE_TTL_MS = 30_000;
const SPREAD = 0.97;
const FALLBACK_RATE = 2841;

let cache = {
  rate: null,
  timestamp: 0,
};

async function fetchInjNgn() {
  const res = await axios.get(
    "https://api.binance.com/api/v3/ticker/price?symbol=INJNGN",
    { timeout: 5000 }
  );
  return parseFloat(res.data.price);
}

async function getLiveRate() {
  const now = Date.now();

  if (cache.rate && now - cache.timestamp < CACHE_TTL_MS) {
    return cache;
  }

  let marketRate = FALLBACK_RATE;
  let source = "fallback";

  try {
    marketRate = await fetchInjNgn();
    source = "binance";
  } catch (err) {
    console.error("[rates] Binance fetch failed:", err.message);
  }

  const offerRate = Math.round(marketRate * SPREAD * 100) / 100;

  cache = {
    rate: offerRate,
    rawRate: Math.round(marketRate * 100) / 100,
    spread: `${((1 - SPREAD) * 100).toFixed(0)}%`,
    source,
    timestamp: now,
    expiresIn: CACHE_TTL_MS / 1000,
  };

  return cache;
}

async function ratesHandler(req, res) {
  try {
    const data = await getLiveRate();
    res.json({
      success: true,
      rate: data.rate,
      rawRate: data.rawRate,
      spread: data.spread,
      source: data.source,
      cachedAt: new Date(data.timestamp).toISOString(),
      expiresIn: data.expiresIn,
    });
  } catch (err) {
    console.error("[rates] Handler error:", err.message);
    res.status(500).json({
      success: false,
      rate: FALLBACK_RATE,
      source: "fallback",
      error: "Live rate unavailable, using fallback",
    });
  }
}

module.exports = { ratesHandler, getLiveRate };
