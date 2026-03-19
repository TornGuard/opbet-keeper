/**
 * Oracle Feeder
 *
 * Tracks OPNet block heights and fetches Bitcoin fee data from mempool.space.
 * Only submits setBlockData() on-chain when there are active bets that need
 * oracle data — saving gas when no bets are active.
 *
 * The resolver triggers on-demand backfills for specific blocks when needed.
 */

import { CONFIG } from './config.js';
import { upsertOracleFeed } from './db.js';

const STATUS_ACTIVE = 0n;

export class OracleFeeder {
  constructor(contract, wallet, provider, network) {
    this.contract = contract;
    this.wallet = wallet;
    this.provider = provider;
    this.network = network;
    this.running = false;
    this.pollTimer = null;
    this.btcTimer = null;
    this.lastSubmittedHeight = 0;
    this.lastKnownOPNetBlock = 0;
    this.latestBtcFee = 0;
    this.latestMempoolCount = 0;
    this.neededBlocks = new Set(); // blocks that active bets need
  }

  start() {
    this.running = true;
    console.log('[Oracle] Starting OPNet block poller + Bitcoin fee fetcher (on-demand mode)...');

    // Initial fetch
    this.fetchBitcoinData().catch(() => {});
    this.poll().catch(() => {});

    // Poll OPNet for new blocks every 10s
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      await this.poll().catch((err) => {
        console.warn('[Oracle] Poll error:', err.message);
      });
    }, 10_000);

    // Refresh Bitcoin fee data every 30s (was 15s — less aggressive)
    this.btcTimer = setInterval(async () => {
      if (!this.running) return;
      await this.fetchBitcoinData().catch(() => {});
    }, 30_000);
  }

  stop() {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.btcTimer) { clearInterval(this.btcTimer); this.btcTimer = null; }
  }

  // ── Fetch latest Bitcoin fee + mempool data ──
  async fetchBitcoinData() {
    const blocks = await this.fetchJSON('/v1/blocks');
    if (blocks && blocks.length > 0) {
      const fee = blocks[0].extras?.medianFee ?? 0;
      if (fee > 0) this.latestBtcFee = fee;
    }

    const mempool = await this.fetchJSON('/mempool');
    if (mempool && mempool.count) {
      this.latestMempoolCount = mempool.count;
    }
  }

  // ── Poll OPNet testnet for new blocks ──
  async poll() {
    if (!this.running) return;

    let rawHeight;
    try {
      rawHeight = await this.provider.getBlockNumber();
    } catch (err) {
      console.warn('[Oracle] Failed to get OPNet block number:', err.message);
      return;
    }

    const currentHeight = Number(rawHeight);

    if (currentHeight <= this.lastKnownOPNetBlock) return;

    console.log(`[Oracle] OPNet block: ${currentHeight} (prev: ${this.lastKnownOPNetBlock})`);
    this.lastKnownOPNetBlock = currentHeight;

    // Refresh needed blocks from active bets
    await this.refreshNeededBlocks();

    if (this.neededBlocks.size === 0) {
      console.log(`[Oracle] No active bets need oracle data — skipping submission`);
      return;
    }

    // Only submit blocks that active bets actually need
    const blocksToSubmit = [...this.neededBlocks].filter((h) => h <= currentHeight).sort((a, b) => a - b);
    if (blocksToSubmit.length > 0) {
      console.log(`[Oracle] Active bets need blocks: ${blocksToSubmit.join(', ')}`);
      for (const h of blocksToSubmit) {
        if (!this.running) break;
        await this.submitBlockData(h);
      }
    }
  }

  /**
   * Scan active bets to find which blocks the oracle needs to feed.
   * For each active bet, we need endBlock AND endBlock-1 (predecessor).
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
        if (info.properties.status !== STATUS_ACTIVE) continue;

        const endBlock = Number(info.properties.endBlock);
        this.neededBlocks.add(endBlock - 1); // predecessor
        this.neededBlocks.add(endBlock);
      }

      if (this.neededBlocks.size > 0) {
        console.log(`[Oracle] ${this.neededBlocks.size} blocks needed by active bets`);
      }
    } catch (err) {
      console.warn('[Oracle] Failed to scan active bets:', err.message);
    }
  }

  // ── Submit block data for a specific OPNet block height ──
  async submitBlockData(height) {
    if (height <= this.lastSubmittedHeight) return;

    const medianFee = this.latestBtcFee;
    const mempoolCount = this.latestMempoolCount;
    const timestamp = Math.floor(Date.now() / 1000);

    if (medianFee === 0) {
      console.log(`[Oracle] Block #${height} — skipping (no Bitcoin fee data yet)`);
      return;
    }

    const medianFeeScaled = Math.round(medianFee * 100);

    try {
      // Check if already submitted
      const existing = await this.contract.getBlockData(BigInt(height));
      if (existing.properties && existing.properties.dataSet > 0n) {
        this.lastSubmittedHeight = height;
        return;
      }

      console.log(`[Oracle] Block #${height} — fee: ${medianFee} sat/vB (${medianFeeScaled}), mempool: ${mempoolCount}`);

      const simulation = await this.contract.setBlockData(
        BigInt(height),
        BigInt(medianFeeScaled),
        BigInt(mempoolCount),
        BigInt(timestamp),
      );

      if (simulation.revert) {
        console.error(`[Oracle] Block #${height} reverted: ${simulation.revert}`);
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

      this.lastSubmittedHeight = height;
      console.log(`[Oracle] Block #${height} — submitted! TX: ${receipt.transactionId}`);

      await upsertOracleFeed({
        blockHeight: height,
        medianFeeScaled,
        mempoolCount,
        txId: receipt.transactionId,
      }).catch((err) => console.warn('[DB] oracle_feeds insert failed:', err.message));
    } catch (err) {
      console.error(`[Oracle] Block #${height} — failed: ${err.message}`);
    }
  }

  async fetchJSON(path) {
    for (const base of CONFIG.mempoolRestEndpoints) {
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
