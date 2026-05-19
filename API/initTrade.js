// api/initTrade.js
const { v4: uuidv4 } = require("uuid");
const { getLiveRate } = require("./rates");
const { getRedis } = require("../lib/redis");
const { getTradeWallet } = require("../lib/wallet");

const FEE_PCT = 0.01;
const TRADE_TTL_SEC = 120;
const MIN_INJ = 0.1;
const MAX_INJ = 500;

async function initTradeHandler(req, res) {
  try {
    const { injAmount, bankName, accountNumber } = req.body;

    const errors = validate({ injAmount, bankName, accountNumber });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const amount = parseFloat(injAmount);
    const rateData = await getLiveRate();
    const lockedRate = rateData.rate;

    const grossNgn = amount * lockedRate;
    const feeNgn = grossNgn * FEE_PCT;
    const netNgn = Math.round((grossNgn - feeNgn) * 100) / 100;

    // ── Get next trade index → derive unique wallet ──────
    const redis = getRedis();
    const tradeIndex = await redis.incr("trade:counter");
    const wallet = getTradeWallet(tradeIndex);

    const tradeId = uuidv4();
    const expiresAt = Date.now() + TRADE_TTL_SEC * 1000;

    const trade = {
      tradeId,
      status: "PENDING",
      injAmount: amount,
      lockedRate,
      grossNgn,
      feeNgn,
      netNgn,
      bankName,
      accountNumber,
      depositAddress: wallet.injAddress,   // unique per trade
      walletIndex: tradeIndex,
      walletPrivateKey: wallet.privateKey, // for sweep after disbursement
      createdAt: Date.now(),
      expiresAt,
      txHash: null,
      paystackRef: null,
    };

    // Store trade session
    await redis.set(
      `trade:${tradeId}`,
      JSON.stringify(trade),
      { EX: TRADE_TTL_SEC + 60 }
    );

    // Index address → tradeId for listener lookup
    await redis.set(
      `address:${wallet.injAddress}`,
      tradeId,
      { EX: TRADE_TTL_SEC + 60 }
    );

    console.log(`[initTrade] ${tradeId} | ${amount} INJ → ₦${netNgn} | address: ${wallet.injAddress}`);

    res.status(201).json({
      success: true,
      tradeId,
      depositAddress: wallet.injAddress,
      injAmount: amount,
      lockedRate,
      netNgn,
      feeNgn,
      expiresAt,
      expiresInSeconds: TRADE_TTL_SEC,
    });

  } catch (err) {
    console.error("[initTrade] Error:", err.message);
    res.status(500).json({
      success: false,
      error: "Failed to create trade. Please try again.",
    });
  }
}

function validate({ injAmount, bankName, accountNumber }) {
  const errors = [];
  const amount = parseFloat(injAmount);
  if (!injAmount || isNaN(amount)) errors.push("Invalid INJ amount");
  else if (amount < MIN_INJ) errors.push(`Minimum trade is ${MIN_INJ} INJ`);
  else if (amount > MAX_INJ) errors.push(`Maximum trade is ${MAX_INJ} INJ`);
  if (!bankName || bankName.trim().length < 2) errors.push("Bank name is required");
  if (!accountNumber || !/^\d{10}$/.test(accountNumber)) errors.push("Account number must be exactly 10 digits");
  return errors;
}

module.exports = { initTradeHandler };
