// lib/redis.js
// Redis connection helper
// Uses ioredis — more reliable than node-redis for Railway deployments

const Redis = require("ioredis");

let client = null;

function getRedis() {
  if (client) return client;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL not set in environment");

  client = new Redis(url, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      // Retry with exponential backoff, max 10 seconds
      const delay = Math.min(times * 200, 10_000);
      console.warn(`[redis] Retry attempt ${times}, waiting ${delay}ms`);
      return delay;
    },
    reconnectOnError(err) {
      // Reconnect on connection errors
      console.error("[redis] Connection error:", err.message);
      return true;
    },
  });

  client.on("connect", () => console.log("[redis] Connected"));
  client.on("error", (err) => console.error("[redis] Error:", err.message));
  client.on("close", () => console.warn("[redis] Connection closed"));

  return client;
}

// ── Trade helpers ─────────────────────────────────────────────

async function getTrade(tradeId) {
  const redis = getRedis();
  const raw = await redis.get(`trade:${tradeId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function updateTrade(tradeId, updates) {
  const redis = getRedis();
  const trade = await getTrade(tradeId);
  if (!trade) throw new Error(`Trade ${tradeId} not found`);

  const updated = { ...trade, ...updates };
  const ttl = await redis.ttl(`trade:${tradeId}`);

  await redis.set(
    `trade:${tradeId}`,
    JSON.stringify(updated),
    { EX: ttl > 0 ? ttl : 3600 }  // keep existing TTL or default 1hr
  );

  return updated;
}

async function getTradeIdByAddress(address) {
  const redis = getRedis();
  return await redis.get(`address:${address}`);
}

async function closeRedis() {
  if (client) {
    await client.quit();
    client = null;
    console.log("[redis] Connection closed gracefully");
  }
}

module.exports = { getRedis, getTrade, updateTrade, getTradeIdByAddress, closeRedis };
