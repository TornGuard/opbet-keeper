/**
 * Bet Resolver
 *
 * Periodically scans all active bets and resolves any whose target/endBlock
 * has oracle data available. If oracle data is missing for a needed block,
 * triggers the oracle to backfill it.
 *
 * Uses a scan lock to prevent overlapping scans and a per-bet cooldown
 * to avoid spamming duplicate backfill transactions.
 */

import { CONFIG } from './config.js';
import { upsertBet, markBetResolved } from './db.js';

const STATUS_ACTIVE = 0n;

export class BetResolver {
  constructor(contract, wallet, provider, network) {
    this.contract = contract;
    this.wallet = wallet;
    this.provider = provider;
    this.network = network;
    this.interval = null;
    this.running = false;
    this.scanning = false; // prevents overlapping scans
    this.backfilling = false; // prevents concurrent backfills
    this.resolvedIds = new Set();
    this.betCooldown = new Map(); // betId → timestamp of last backfill attempt
    this.oracle = null; // Set by index.js after construction
  }

  start() {
    this.running = true;
    console.log(`[Resolver] Starting bet scanner (every ${CONFIG.resolveScanInterval / 1000}s)...`);

    // First scan after a short delay (let oracle fetch Bitcoin data first)
    setTimeout(() => {
      this.scan().catch((err) => console.error('[Resolver] Scan error:', err.message));
    }, 5000);

    this.interval = setInterval(() => {
      if (!this.running) return;
      this.scan().catch((err) => console.error('[Resolver] Scan error:', err.message));
    }, CONFIG.resolveScanInterval);
  }

  stop() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async scan() {
    // Prevent overlapping scans
    if (this.scanning) {
      console.log('[Resolver] Scan already in progress, skipping');
      return;
    }
    this.scanning = true;

    try {
      await this._doScan();
    } finally {
      this.scanning = false;
    }
  }

  async _doScan() {
    let maxBetId;
    try {
      const result = await this.contract.getNextBetId();
      if (result.revert) return;
      maxBetId = Number(result.properties.nextBetId);
    } catch (err) {
      console.warn('[Resolver] Failed to get next bet ID:', err.message);
      return;
    }

    if (maxBetId <= 1) return;

    const totalBets = maxBetId - 1;
    let resolved = 0;
    let active = 0;
    let noData = 0;
    let backfilled = 0;

    for (let i = 1; i < maxBetId; i++) {
      if (!this.running) break;
      if (this.resolvedIds.has(i)) continue;

      const betId = BigInt(i);

      try {
        const info = await this.contract.getBetInfo(betId);
        if (info.revert) continue;

        const status = info.properties.status;
        if (status !== STATUS_ACTIVE) {
          this.resolvedIds.add(i);
          continue;
        }

        active++;
        const endBlock = Number(info.properties.endBlock);
        const betType = info.properties.betType;
        const amount = info.properties.amount;

        // Persist the bet to the database (no-op if already stored)
        await upsertBet({ betId: i, betType, amount, endBlock })
          .catch((err) => console.warn('[DB] upsertBet failed:', err.message));

        // resolveBet needs data for BOTH endBlock AND endBlock-1
        const endBlockData = await this.contract.getBlockData(BigInt(endBlock));
        const hasEndData = endBlockData.properties && endBlockData.properties.dataSet && endBlockData.properties.dataSet > 0n;
        const prevBlockData = await this.contract.getBlockData(BigInt(endBlock - 1));
        const hasPrevData = prevBlockData.properties && prevBlockData.properties.dataSet && prevBlockData.properties.dataSet > 0n;

        if (!hasEndData || !hasPrevData) {
          // Check per-bet cooldown (3 minutes)
          const lastAttempt = this.betCooldown.get(i);
          if (lastAttempt && Date.now() - lastAttempt < 180_000) {
            const waitSec = Math.round((180_000 - (Date.now() - lastAttempt)) / 1000);
            console.log(`[Resolver] Bet #${i} backfill on cooldown (${waitSec}s), skipping`);
            noData++;
            continue;
          }

          // Don't backfill if another backfill is running
          if (this.backfilling) {
            console.log(`[Resolver] Bet #${i} needs data but backfill in progress, skipping`);
            noData++;
            continue;
          }

          if (this.oracle && this.oracle.latestBtcFee > 0) {
            console.log(`[Resolver] Bet #${i} needs blocks for #${endBlock} (prev: ${hasPrevData ? 'OK' : 'MISSING'}, end: ${hasEndData ? 'OK' : 'MISSING'})`);
            this.betCooldown.set(i, Date.now());

            // Single backfill call covering both prev and end
            const targetBlock = endBlock; // backfillBlocks searches backwards, so this covers endBlock-1 too
            const filled = await this.backfillBlocks(targetBlock);
            if (filled) {
              backfilled++;
              console.log(`[Resolver] Bet #${i} — backfill submitted, waiting for next scan to confirm`);
            } else {
              noData++;
            }
            continue; // Don't resolve this cycle — wait for txs to confirm
          } else {
            noData++;
            continue;
          }
        }

        // Oracle data available (confirmed on-chain) — try to resolve
        console.log(`[Resolver] Resolving bet #${i} (type: ${betType}, amount: ${amount}, endBlock: ${endBlock})...`);

        const simulation = await this.contract.resolveBet(betId);
        if (simulation.revert) {
          console.warn(`[Resolver] Bet #${i} simulation reverted: ${simulation.revert}`);
          continue;
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

        const won = simulation.properties.won;
        const payout = simulation.properties.payout;
        console.log(`[Resolver] Bet #${i} — ${won ? 'WON' : 'LOST'}${won ? ` (payout: ${payout})` : ''} — TX: ${receipt.transactionId}`);

        await markBetResolved({ betId: i, won, payout, txId: receipt.transactionId })
          .catch((err) => console.warn('[DB] markBetResolved failed:', err.message));

        this.resolvedIds.add(i);
        resolved++;
      } catch (err) {
        console.warn(`[Resolver] Bet #${i} error: ${err.message}`);
      }
    }

    console.log(`[Resolver] Scan: ${totalBets} total, ${active} active, ${resolved} resolved, ${backfilled} backfilled, ${noData} no data`);
  }

  /**
   * Backfill oracle data for a target block and any missing predecessors.
   * Searches backwards to find the first missing block, then fills forward.
   * Uses a lock to prevent concurrent backfill operations.
   */
  async backfillBlocks(targetBlock) {
    if (this.backfilling) {
      console.log('[Resolver] Backfill already in progress');
      return false;
    }
    this.backfilling = true;

    try {
      return await this._doBackfill(targetBlock);
    } finally {
      this.backfilling = false;
    }
  }

  async _doBackfill(targetBlock) {
    // Find how far back we need to go (max 50 blocks)
    let firstMissing = targetBlock;
    for (let h = targetBlock; h > Math.max(targetBlock - 50, 0); h--) {
      const data = await this.contract.getBlockData(BigInt(h));
      if (data.properties && data.properties.dataSet && data.properties.dataSet > 0n) {
        firstMissing = h + 1;
        break;
      }
      firstMissing = h;
    }

    if (firstMissing > targetBlock) {
      console.log(`[Resolver] All blocks up to #${targetBlock} already have data`);
      return true;
    }

    const blocksToFill = targetBlock - firstMissing + 1;
    console.log(`[Resolver] Backfilling blocks ${firstMissing} → ${targetBlock} (${blocksToFill} blocks)`);

    if (blocksToFill > 50) {
      console.warn(`[Resolver] Too many blocks to backfill (${blocksToFill}), skipping`);
      return false;
    }

    const medianFee = this.oracle.latestBtcFee;
    const mempoolCount = this.oracle.latestMempoolCount;
    const medianFeeScaled = Math.round(medianFee * 100);
    const timestamp = Math.floor(Date.now() / 1000);

    for (let h = firstMissing; h <= targetBlock; h++) {
      if (!this.running) break;

      // Skip blocks that already have data
      try {
        const existing = await this.contract.getBlockData(BigInt(h));
        if (existing.properties && existing.properties.dataSet && existing.properties.dataSet > 0n) {
          console.log(`[Resolver] Block #${h} already has data, skipping`);
          continue;
        }
      } catch {
        // If check fails, try to submit anyway
      }

      try {
        const simulation = await this.contract.setBlockData(
          BigInt(h),
          BigInt(medianFeeScaled),
          BigInt(mempoolCount),
          BigInt(timestamp),
        );

        if (simulation.revert) {
          console.error(`[Resolver] Backfill block #${h} reverted: ${simulation.revert}`);
          return false;
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

        console.log(`[Resolver] Backfill block #${h} — TX: ${receipt.transactionId}`);

        // Wait 5s between txs to let previous tx propagate
        if (h < targetBlock) {
          await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (err) {
        console.error(`[Resolver] Backfill block #${h} failed: ${err.message}`);
        return false;
      }
    }

    return true;
  }
}
