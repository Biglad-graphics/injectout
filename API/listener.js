// lib/injective.js
// Injective RPC connection + deposit listener

const { getRedis, getTradeIdByAddress, updateTrade } = require("./redis");
const { disburse } = require("../api/disburse");

const INJECTIVE_RPC = process.env.INJECTIVE_RPC_URL;
const POLL_INTERVAL_MS = 3000;   // check every 3 seconds
const CONFIRMATIONS = 2;         // blocks to wait before acting

let isRunning = false;
let lastCheckedHeight = 0;

// ── Fetch latest block height ────────────────────────────────
async function getLatestHeight() {
  const res = await fetch(`${INJECTIVE_RPC}/block`, {
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();
  return parseInt(data.result.block.header.height);
}

// ── Fetch transactions in a block ────────────────────────────
async function getBlockTxs(height) {
  const res = await fetch(
    `${INJECTIVE_RPC}/tx_search?query="tx.height=${height}"&per_page=100`,
    { headers: { "Content-Type": "application/json" } }
  );
  const data = await res.json();
  return data.result?.txs || [];
}

// ── Parse INJ transfers from a transaction ───────────────────
function parseInjTransfer(tx) {
  try {
    const events = tx.tx_result?.events || [];

    for (const event of events) {
      if (event.type !== "coin_received") continue;

      const attrs = Object.fromEntries(
        event.attributes.map((a) => [
          Buffer.from(a.key, "base64").toString(),
          Buffer.from(a.value, "base64").toString(),
        ])
      );

      // e.g. attrs.receiver = "inj1abc...", attrs.amount = "5000000000000000000inj"
      if (attrs.receiver && attrs.amount?.includes("inj")) {
        const amountWei = attrs.amount.replace("inj", "");
        const amountInj = parseFloat(amountWei) / 1e18;

        return {
          receiver: attrs.receiver,
          amountInj: parseFloat(amountInj.toFixed(4)),
          amountWei,
          txHash: tx.hash,
        };
      }
    }
  } catch (err) {
    console.error("[listener] Failed to parse tx:", err.message);
  }
  return null;
}

// ── Handle a detected deposit ────────────────────────────────
async function handleDeposit(transfer) {
  const { receiver, amountInj, amountWei, txHash } = transfer;

  // Look up trade by deposit address
  const tradeId = await getTradeIdByAddress(receiver);
  if (!tradeId) return; // not our address, ignore

  const trade = await updateTrade(tradeId, {
    status: "DETECTED",
    txHash,
    detectedAt: Date.now(),
  });

  console.log(`[listener] Deposit detected | trade: ${tradeId} | ${amountInj} INJ | tx: ${txHash}`);

  // Verify amount matches (allow 0.0001 INJ tolerance for rounding)
  const expectedAmount = trade.injAmount;
  const diff = Math.abs(amountInj - expectedAmount);

  if (diff > 0.0001) {
    console.warn(`[listener] Amount mismatch | expected: ${expectedAmount} | got: ${amountInj}`);
    await updateTrade(tradeId, { status: "AMOUNT_MISMATCH" });
    return;
  }

  // Trigger naira disbursement
  await disburse(tradeId, amountWei);
}

// ── Main polling loop ─────────────────────────────────────────
async function startListener() {
  if (isRunning) {
    console.warn("[listener] Already running");
    return;
  }

  isRunning = true;
  console.log("[listener] Starting Injective deposit watcher...");

  // Start from current block
  lastCheckedHeight = await getLatestHeight();
  console.log(`[listener] Starting at block ${lastCheckedHeight}`);

  while (isRunning) {
    try {
      const latestHeight = await getLatestHeight();
      const targetHeight = latestHeight - CONFIRMATIONS;

      // Process any new confirmed blocks
      for (let h = lastCheckedHeight + 1; h <= targetHeight; h++) {
        const txs = await getBlockTxs(h);

        for (const tx of txs) {
          const transfer = parseInjTransfer(tx);
          if (transfer) await handleDeposit(transfer);
        }

        lastCheckedHeight = h;
      }
    } catch (err) {
      console.error("[listener] Poll error:", err.message);
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function stopListener() {
  isRunning = false;
  console.log("[listener] Stopped");
}

module.exports = { startListener, stopListener };
