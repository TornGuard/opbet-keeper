/**
 * Price Submitter
 *
 * Reads the latest BTC/USD price from BlockFeed's REST API and submits it
 * to the on-chain PriceOracle contract when either:
 *   - Price deviates more than DEVIATION_THRESHOLD from the last submitted value
 *   - HEARTBEAT_INTERVAL has passed since the last on-chain update
 *
 * The on-chain contract stores:
 *   price      = price × 1e8 (e.g. $68_784.80 → 6_878_480_000_000n)
 *   confidence = spread/median × 1e6 (e.g. 0.05% → 500n)
 *   symbolId   = 0n for BTC/USD
 */

import { CONFIG } from './config.js';

const BTC_USD_SYMBOL_ID = 0n;
const DEVIATION_THRESHOLD = 0.005;  // 0.5%
const HEARTBEAT_MS        = 60 * 60 * 1000; // 1 hour
const POLL_INTERVAL_MS    = 60_000;          // 60 seconds
const FETCH_TIMEOUT_MS    = 8_000;

export class PriceSubmitter {
  constructor(oracleContract, wallet, provider, network) {
    this.oracleContract = oracleContract;
    this.wallet         = wallet;
    this.provider       = provider;
    this.network        = network;
    this.running        = false;
    this.pollTimer      = null;

    // Last price submitted on-chain (raw float USD)
    this.lastSubmittedPrice = 0;
    this.lastSubmittedAt    = 0; // ms timestamp
  }

  start() {
    this.running = true;
    console.log('[PriceSubmitter] Starting — deviation threshold: 0.5%, heartbeat: 1h');
    this.poll().catch(() => {});
    this.pollTimer = setInterval(() => {
      if (!this.running) return;
      this.poll().catch(err => console.warn('[PriceSubmitter] Poll error:', err.message));
    }, POLL_INTERVAL_MS);
  }

  stop() {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── Fetch latest price from BlockFeed REST API ──────────────────────────────
  async fetchLatestPrice() {
    const url = `${CONFIG.blockfeedApiUrl}/v1/oracle/btc`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Decide whether to submit ────────────────────────────────────────────────
  shouldSubmit(price) {
    // First-ever submission
    if (this.lastSubmittedPrice === 0) return true;

    // Heartbeat: submit at least once per hour
    if (Date.now() - this.lastSubmittedAt > HEARTBEAT_MS) return true;

    // Deviation check
    const deviation = Math.abs(price - this.lastSubmittedPrice) / this.lastSubmittedPrice;
    return deviation >= DEVIATION_THRESHOLD;
  }

  // ── Submit price on-chain via PriceOracle.updatePrice ──────────────────────
  async submitPrice(price, confidence) {
    const priceScaled      = BigInt(Math.round(price * 1e8));
    const confidenceScaled = BigInt(Math.round(confidence * 1e6));

    console.log(
      `[PriceSubmitter] Submitting BTC/USD $${price.toFixed(2)}` +
      `  confidence=${(confidence * 100).toFixed(3)}%` +
      `  (on-chain: price=${priceScaled}, conf=${confidenceScaled})`,
    );

    const simulation = await this.oracleContract.updatePrice(
      BTC_USD_SYMBOL_ID,
      priceScaled,
      confidenceScaled,
    );

    if (simulation.revert) {
      console.error('[PriceSubmitter] Simulation REVERTED:', simulation.revert);
      return;
    }

    const challenge = await this.provider.getChallenge();
    const receipt = await simulation.sendTransaction({
      signer:                    this.wallet.keypair,
      mldsaSigner:               this.wallet.mldsaKeypair,
      refundTo:                  this.wallet.p2tr,
      maximumAllowedSatToSpend:  CONFIG.maxSatsPerTx,
      network:                   this.network,
      feeRate:                   CONFIG.feeRate,
      challenge,
    });

    this.lastSubmittedPrice = price;
    this.lastSubmittedAt    = Date.now();
    console.log(`[PriceSubmitter] Submitted! TX: ${receipt.transactionId}`);
  }

  // ── Poll tick ───────────────────────────────────────────────────────────────
  async poll() {
    if (!this.running) return;

    let json;
    try {
      json = await this.fetchLatestPrice();
    } catch (err) {
      console.warn('[PriceSubmitter] Failed to fetch BlockFeed price:', err.message);
      return;
    }

    // BlockFeed wraps responses as { ok, data: {...} }
    const data       = json.data ?? json;
    const price      = parseFloat(data.price);
    const confidence = parseFloat(data.confidence);

    if (!Number.isFinite(price) || price <= 0) {
      console.warn('[PriceSubmitter] Invalid price from BlockFeed:', data);
      return;
    }

    const deviation = this.lastSubmittedPrice > 0
      ? ((Math.abs(price - this.lastSubmittedPrice) / this.lastSubmittedPrice) * 100).toFixed(3)
      : 'n/a';

    if (!this.shouldSubmit(price)) {
      console.log(`[PriceSubmitter] BTC/USD $${price.toFixed(2)}  deviation=${deviation}%  (no update needed)`);
      return;
    }

    await this.submitPrice(price, confidence);
  }
}
