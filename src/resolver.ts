/**
 * Bet Resolver
 *
 * Periodically scans all active bets and resolves any whose target/endBlock
 * has oracle data available. Triggers oracle backfill if data is missing.
 */

import { CONFIG } from './config.js';
import { upsertBet, markBetResolved, upsertBetOwner, getBetWithWallet, getConsecutiveWins } from './db.js';
import { notifyWin, notifyStreak } from './telegram.js';
import type { KeeperWallet, SimulationResult, UpsertBetParams } from './types.js';
import type { OracleFeeder } from './oracle.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OPNetContract = Record<string, (...args: unknown[]) => Promise<SimulationResult>>;

const STATUS_ACTIVE = 0n;

export class BetResolver {
    private readonly contract: OPNetContract;
    private readonly wallet: KeeperWallet;
    private readonly provider: unknown;
    private readonly network: unknown;

    private interval: ReturnType<typeof setInterval> | null = null;
    running = false;
    private scanning = false;
    private backfilling = false;

    readonly resolvedIds = new Set<number>();
    private readonly betCooldown = new Map<number, number>();

    oracle: OracleFeeder | null = null;

    constructor(contract: OPNetContract, wallet: KeeperWallet, provider: unknown, network: unknown) {
        this.contract = contract;
        this.wallet   = wallet;
        this.provider = provider;
        this.network  = network;
    }

    start(): void {
        this.running = true;
        console.log(`[Resolver] Starting bet scanner (every ${CONFIG.resolveScanInterval / 1000}s)...`);
        setTimeout(() => {
            this.scan().catch((err: Error) => console.error('[Resolver] Scan error:', err.message));
        }, 5000);
        this.interval = setInterval(() => {
            if (!this.running) return;
            this.scan().catch((err: Error) => console.error('[Resolver] Scan error:', err.message));
        }, CONFIG.resolveScanInterval);
    }

    stop(): void {
        this.running = false;
        if (this.interval) { clearInterval(this.interval); this.interval = null; }
    }

    async scan(): Promise<void> {
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

    private async _doScan(): Promise<void> {
        let maxBetId: number;
        try {
            const result = await this.contract['getNextBetId']!();
            if (result.revert) return;
            maxBetId = Number(result.properties?.['nextBetId']);
        } catch (err) {
            console.warn('[Resolver] Failed to get next bet ID:', (err as Error).message);
            return;
        }

        if (maxBetId <= 1) return;

        let resolved = 0, active = 0, noData = 0, backfilled = 0;

        for (let i = 1; i < maxBetId; i++) {
            if (!this.running) break;
            if (this.resolvedIds.has(i)) continue;

            const betId = BigInt(i);
            try {
                const info = await this.contract['getBetInfo']!(betId);
                if (info.revert) continue;

                const status = info.properties?.['status'];
                if (status !== STATUS_ACTIVE) {
                    this.resolvedIds.add(i);
                    continue;
                }

                active++;
                const endBlock = Number(info.properties?.['endBlock']);
                const betType  = info.properties?.['betType'] as bigint;
                const param1   = info.properties?.['param1'] as bigint;
                const param2   = info.properties?.['param2'] as bigint;
                const amount   = info.properties?.['amount'] as bigint;

                await upsertBet({ betId: i, betType, param1, param2, amount, endBlock, contractAddress: CONFIG.marketAddress } as UpsertBetParams)
                    .catch((err: Error) => console.warn('[DB] upsertBet failed:', err.message));

                try {
                    const ownerResult = await this.contract['getBetOwner']!(betId);
                    if (!ownerResult.revert && (BigInt(ownerResult.properties?.['owner'] ?? 0)) > 0n) {
                        const ownerHex = '0x' + (ownerResult.properties!['owner'] as bigint).toString(16).padStart(64, '0');
                        await upsertBetOwner({ betId: i, ownerHex })
                            .catch((err: Error) => console.warn('[DB] upsertBetOwner failed:', err.message));
                    }
                } catch { /* non-fatal */ }

                const endBlockData  = await this.contract['getBlockData']!(BigInt(endBlock));
                const hasEndData    = (BigInt(endBlockData.properties?.['dataSet'] ?? 0)) > 0n;
                const prevBlockData = await this.contract['getBlockData']!(BigInt(endBlock - 1));
                const hasPrevData   = (BigInt(prevBlockData.properties?.['dataSet'] ?? 0)) > 0n;

                if (!hasEndData || !hasPrevData) {
                    const lastAttempt = this.betCooldown.get(i);
                    if (lastAttempt && Date.now() - lastAttempt < 180_000) {
                        noData++; continue;
                    }
                    if (this.backfilling) { noData++; continue; }
                    if (this.oracle && this.oracle.latestBtcFee > 0) {
                        console.log(`[Resolver] Bet #${i} needs blocks for #${endBlock}`);
                        this.betCooldown.set(i, Date.now());
                        const filled = await this.backfillBlocks(endBlock);
                        if (filled) { backfilled++; } else { noData++; }
                        continue;
                    }
                    noData++; continue;
                }

                console.log(`[Resolver] Resolving bet #${i} (type: ${betType}, endBlock: ${endBlock})...`);
                const simulation = await this.contract['resolveBet']!(betId);
                if (simulation.revert) {
                    console.warn(`[Resolver] Bet #${i} simulation reverted: ${simulation.revert}`);
                    continue;
                }

                const challenge = await (this.provider as { getChallenge(): Promise<unknown> }).getChallenge();
                const receipt = await simulation.sendTransaction({
                    signer:                   this.wallet.keypair,
                    mldsaSigner:              this.wallet.mldsaKeypair,
                    refundTo:                 this.wallet.p2tr,
                    maximumAllowedSatToSpend: CONFIG.maxSatsPerTx,
                    network:                  this.network,
                    feeRate:                  CONFIG.feeRate,
                    challenge,
                });

                const won    = simulation.properties?.['won'];
                const payout = simulation.properties?.['payout'];
                console.log(`[Resolver] Bet #${i} — ${won ? 'WON' : 'LOST'}${won ? ` (payout: ${payout})` : ''} — TX: ${receipt.transactionId}`);

                await markBetResolved({ betId: i, won: Boolean(won), payout: payout != null ? BigInt(payout as bigint | string) : null, txId: receipt.transactionId })
                    .catch((err: Error) => console.warn('[DB] markBetResolved failed:', err.message));

                if (won) {
                    try {
                        const betInfo = await getBetWithWallet(i);
                        const wallet = betInfo?.wallet ?? null;
                        const direction = betInfo?.bet_type === 1 ? (betInfo.param1 === '1' ? 'over' : 'under') : null;
                        const threshold = (betInfo?.bet_type === 1 && betInfo?.param2)
                            ? (Number(betInfo.param2) / 100).toFixed(1) : null;
                        await notifyWin({ betId: i, wallet, payout: String(payout ?? '0'), direction, threshold, tokenSymbol: betInfo?.token_symbol ?? null });
                        if (wallet) {
                            const streak = await getConsecutiveWins(wallet);
                            if (streak >= 3) await notifyStreak({ wallet, streak });
                        }
                    } catch (err) {
                        console.warn('[Telegram] Notification error:', (err as Error).message);
                    }
                }

                this.resolvedIds.add(i);
                resolved++;
            } catch (err) {
                console.warn(`[Resolver] Bet #${i} error: ${(err as Error).message}`);
            }
        }

        const totalBets = maxBetId - 1;
        console.log(`[Resolver] Scan: ${totalBets} total, ${active} active, ${resolved} resolved, ${backfilled} backfilled, ${noData} no data`);
    }

    async backfillBlocks(targetBlock: number): Promise<boolean> {
        if (this.backfilling) { console.log('[Resolver] Backfill already in progress'); return false; }
        this.backfilling = true;
        try {
            return await this._doBackfill(targetBlock);
        } finally {
            this.backfilling = false;
        }
    }

    private async _doBackfill(targetBlock: number): Promise<boolean> {
        let firstMissing = targetBlock;
        for (let h = targetBlock; h > Math.max(targetBlock - 10, 0); h--) {
            const data = await this.contract['getBlockData']!(BigInt(h));
            if ((BigInt(data.properties?.['dataSet'] ?? 0)) > 0n) {
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
        if (blocksToFill > 50) {
            console.warn(`[Resolver] Too many blocks to backfill (${blocksToFill}), skipping`);
            return false;
        }

        const medianFeeScaled = Math.round((this.oracle?.latestBtcFee ?? 0) * 100);
        const mempoolCount    = this.oracle?.latestMempoolCount ?? 0;
        const timestamp       = Math.floor(Date.now() / 1000);

        console.log(`[Resolver] Backfilling blocks ${firstMissing} → ${targetBlock} (${blocksToFill} blocks)`);

        for (let h = firstMissing; h <= targetBlock; h++) {
            if (!this.running) break;
            try {
                const existing = await this.contract['getBlockData']!(BigInt(h));
                if ((BigInt(existing.properties?.['dataSet'] ?? 0)) > 0n) continue;
            } catch { /* try anyway */ }

            try {
                const simulation = await this.contract['setBlockData']!(
                    BigInt(h), BigInt(medianFeeScaled), BigInt(mempoolCount), BigInt(timestamp),
                );
                if (simulation.revert) {
                    console.error(`[Resolver] Backfill block #${h} reverted: ${simulation.revert}`);
                    return false;
                }
                const challenge = await (this.provider as { getChallenge(): Promise<unknown> }).getChallenge();
                const receipt = await simulation.sendTransaction({
                    signer:                   this.wallet.keypair,
                    mldsaSigner:              this.wallet.mldsaKeypair,
                    refundTo:                 this.wallet.p2tr,
                    maximumAllowedSatToSpend: CONFIG.maxSatsPerTx,
                    network:                  this.network,
                    feeRate:                  CONFIG.feeRate,
                    challenge,
                });
                console.log(`[Resolver] Backfill block #${h} — TX: ${receipt.transactionId}`);
                if (h < targetBlock) await new Promise<void>(r => setTimeout(r, 5000));
            } catch (err) {
                console.error(`[Resolver] Backfill block #${h} failed: ${(err as Error).message}`);
                return false;
            }
        }
        return true;
    }
}
