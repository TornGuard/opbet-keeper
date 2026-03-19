/**
 * Oracle Feeder
 *
 * Watches Bitcoin blocks via mempool.space and submits setBlockData() to the
 * OPNet contract keyed by BITCOIN block height (not OPNet block height).
 *
 * A new setBlockData tx is sent only when a genuinely new Bitcoin block is mined,
 * ensuring each on-chain entry represents real Bitcoin block data.
 *
 * Also handles on-demand backfills when the resolver needs data for a specific
 * Bitcoin block height that hasn't been submitted yet.
 */

import { CONFIG } from './config.js';
import { upsertOracleFeed } from './db.js';

export class OracleFeeder {
  constructor(contract, wallet, provider, network) {
    this.contract = contract;
    this.wallet = wallet;
    this.provider = provider;
    this.network = network;
    this.running = false;
    this.pollTimer = null;

    // Latest Bitcoin data
    this.latestBtcFee = 0;
    this.latestBtcBlockHeight = 0;
    this.latestMempoolCount = 0;

    // Track which Bitcoin block heights have been submitted on-chain
    this.submittedBtcBlocks = new Set();

    // Bitcoin block heights that active bets need oracle data for
    this.neededBlocks = new Set();
  }

  start() {
    this.running = true;
    console.log('[Oracle] Starting signet block watcher...');

    // Initial poll (includes fetchBitcoinData)
    this.poll().catch(() => {});

    // Poll signet tip + active bet state every 60s
    // Signet blocks average ~10 min, so 60s is more than frequent enough
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      await this.poll().catch((err) => {
        console.warn('[Oracle] Poll error:', err.message);
      });
    }, 60_000);
  }

  stop() {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── Fetch Bitcoin data ──
  // Block height: signet (matches OPNet testnet, gives ~10 min bet windows)
  // Fee + mempool: mainnet (real volatility so OVER/UNDER bets are meaningful)
  async fetchBitcoinData() {
    // Signet tip height — block timing
    const tip = await this.fetchJSON('/blocks/tip/height', CONFIG.mempoolRestEndpoints);
    if (typeof tip === 'number' && tip > 0 && tip > this.latestBtcBlockHeight) {
      this.latestBtcBlockHeight = tip;
      console.log(`[Oracle] Signet tip: #${tip} — fee: ${this.latestBtcFee} sat/vB`);
    }

    // Mainnet fee + mempool — real market data for bet resolution
    const blocks = await this.fetchJSON('/v1/blocks', CONFIG.mempoolMainnetEndpoints);
    if (blocks && blocks.length > 0) {
      const fee = blocks[0].extras?.medianFee ?? 0;
      if (fee > 0) this.latestBtcFee = fee;
    }

    const mempool = await this.fetchJSON('/mempool', CONFIG.mempoolMainnetEndpoints);
    if (mempool && mempool.count) {
      this.latestMempoolCount = mempool.count;
    }
  }

  // ── Poll: refresh needed blocks from active bets + current signet tip, then submit ──
  async poll() {
    if (!this.running) return;

    await this.fetchBitcoinData().catch(() => {});
    await this.refreshNeededBlocks();

    // Bet-required blocks: always submit if we have fee data
    const betBlocks = [...this.neededBlocks]
      .filter((h) => !this.submittedBtcBlocks.has(h))
      .sort((a, b) => a - b);

    // Current OPNet chain block: submit if new
    const chainBlock = this.latestBtcBlockHeight > 0 && !this.submittedBtcBlocks.has(this.latestBtcBlockHeight)
      ? [this.latestBtcBlockHeight] : [];

    const toSubmit = [...new Set([...betBlocks, ...chainBlock])].sort((a, b) => a - b);

    if (toSubmit.length === 0) return;

    console.log(`[Oracle] Submitting blocks: ${toSubmit.join(', ')}`);
    for (const h of toSubmit) {
      if (!this.running) break;
      await this.submitBlockData(h);
    }
  }

  /**
   * Scan active bets to find which Bitcoin block heights the oracle needs to feed.
   * For each active bet, we need endBlock AND endBlock-1 (predecessor for block time calc).
   */
  async refreshNeededBlocks() {
    this.neededBlocks.clear();
    try {
      const result = await this.contract.getNextBetId();
      if (result.revert) return;
      const maxBetId = Number(result.properties.nextBetId);

      for (let i = 1; i < maxBetId; i++) {
        const info = await this.contract.getBetInfo(BigInt(i));
        if (info.revert) continue;
        if (info.properties.status !== 0n) continue; // skip resolved bets

        const endBlock = Number(info.properties.endBlock);
        const targetBlock = Number(info.properties.targetBlock);

        // Need predecessor for block time resolution
        if (targetBlock > 0) this.neededBlocks.add(targetBlock - 1);
        // Need all blocks from targetBlock to endBlock
        for (let h = targetBlock; h <= endBlock; h++) {
          this.neededBlocks.add(h);
        }
      }

      if (this.neededBlocks.size > 0) {
        console.log(`[Oracle] Active bets need blocks: ${[...this.neededBlocks].sort((a,b)=>a-b).join(', ')}`);
      }
    } catch (err) {
      console.warn('[Oracle] Failed to scan active bets:', err.message);
    }
  }

  // ── Submit Bitcoin block data on-chain ──
  async submitBlockData(btcHeight) {
    if (this.submittedBtcBlocks.has(btcHeight)) return;

    const medianFee = this.latestBtcFee;
    const mempoolCount = this.latestMempoolCount;
    // Use the actual Bitcoin block timestamp if we have it, else current time
    const timestamp = Math.floor(Date.now() / 1000);

    if (medianFee === 0) {
      console.log(`[Oracle] BTC block #${btcHeight} — skipping (no fee data yet)`);
      return;
    }

    const medianFeeScaled = Math.round(medianFee * 100);

    try {
      // Check if already on-chain
      const existing = await this.contract.getBlockData(BigInt(btcHeight));
      if (existing.properties && existing.properties.dataSet > 0n) {
        console.log(`[Oracle] BTC block #${btcHeight} already on-chain — skipping`);
        this.submittedBtcBlocks.add(btcHeight);
        return;
      }

      console.log(`[Oracle] Submitting BTC block #${btcHeight} — fee: ${medianFee} sat/vB (${medianFeeScaled}), mempool: ${mempoolCount}`);

      const simulation = await this.contract.setBlockData(
        BigInt(btcHeight),
        BigInt(medianFeeScaled),
        BigInt(mempoolCount),
        BigInt(timestamp),
      );

      if (simulation.revert) {
        console.error(`[Oracle] BTC block #${btcHeight} simulation REVERTED: "${simulation.revert}"`);
        return;
      }

      const challenge = await this.provider.getChallenge();
      const receipt = await simulation.sendTransaction({
        signer: this.wallet.keypair,
        mldsaSigner: this.wallet.mldsaKeypair,
        refundTo: this.wallet.p2tr,
        maximumAllowedSatToSpend: CONFIG.maxSatsPerTx,
        network: this.network,
        feeRate: CONFIG.feeRate,
        challenge,
      });

      this.submittedBtcBlocks.add(btcHeight);
      console.log(`[Oracle] BTC block #${btcHeight} — submitted! TX: ${receipt.transactionId}`);

      await upsertOracleFeed({
        blockHeight: btcHeight,
        medianFeeScaled,
        mempoolCount,
        txId: receipt.transactionId,
      }).catch((err) => console.warn('[DB] oracle_feeds insert failed:', err.message));
    } catch (err) {
      console.error(`[Oracle] BTC block #${btcHeight} — failed: ${err.message}`);
    }
  }

  async fetchJSON(path, endpoints = CONFIG.mempoolRestEndpoints) {
    for (const base of endpoints) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(`${base}${path}`, { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) return await res.json();
      } catch {
        continue;
      }
    }
    return null;
  }
}
