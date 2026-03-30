/**
 * Oracle Feeder
 *
 * Watches Bitcoin blocks via mempool.space and submits setBlockData() to the
 * OPNet contract keyed by BITCOIN block height.
 */

import { CONFIG } from './config.js';
import { upsertOracleFeed } from './db.js';
import type { KeeperWallet, SimulationResult } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OPNetContract = Record<string, (...args: unknown[]) => Promise<SimulationResult>>;

export class OracleFeeder {
    private readonly contract: OPNetContract;
    private readonly wallet: KeeperWallet;
    private readonly provider: unknown;
    private readonly network: unknown;

    running = false;
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    latestBtcFee = 0;
    latestBtcBlockHeight = 0;
    latestMempoolCount = 0;

    private readonly submittedBtcBlocks = new Set<number>();
    readonly neededBlocks = new Set<number>();

    constructor(contract: OPNetContract, wallet: KeeperWallet, provider: unknown, network: unknown) {
        this.contract = contract;
        this.wallet   = wallet;
        this.provider = provider;
        this.network  = network;
    }

    start(): void {
        this.running = true;
        console.log('[Oracle] Starting signet block watcher...');
        this.poll().catch(() => {});
        this.pollTimer = setInterval(() => {
            if (!this.running) return;
            this.poll().catch((err: Error) => console.warn('[Oracle] Poll error:', err.message));
        }, 60_000);
    }

    stop(): void {
        this.running = false;
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    }

    async fetchBitcoinData(): Promise<void> {
        const tip = await this.fetchJSON('/blocks/tip/height', CONFIG.mempoolRestEndpoints);
        if (typeof tip === 'number' && tip > 0 && tip > this.latestBtcBlockHeight) {
            this.latestBtcBlockHeight = tip;
            console.log(`[Oracle] Signet tip: #${tip} — fee: ${this.latestBtcFee} sat/vB`);
        }

        const blocks = await this.fetchJSON('/v1/blocks', CONFIG.mempoolMainnetEndpoints) as { extras?: { medianFee?: number } }[] | null;
        if (blocks && blocks.length > 0) {
            const fee = blocks[0].extras?.medianFee ?? 0;
            if (fee > 0) this.latestBtcFee = fee;
        }

        const mempool = await this.fetchJSON('/mempool', CONFIG.mempoolMainnetEndpoints) as { count?: number } | null;
        if (mempool?.count) {
            this.latestMempoolCount = mempool.count;
        }
    }

    async poll(): Promise<void> {
        if (!this.running) return;
        await this.fetchBitcoinData().catch(() => {});
        await this.refreshNeededBlocks();

        const betBlocks = [...this.neededBlocks]
            .filter(h => !this.submittedBtcBlocks.has(h))
            .sort((a, b) => a - b);

        const chainBlock = (this.latestBtcBlockHeight > 0 && !this.submittedBtcBlocks.has(this.latestBtcBlockHeight))
            ? [this.latestBtcBlockHeight] : [];

        const toSubmit = [...new Set([...betBlocks, ...chainBlock])].sort((a, b) => a - b);
        if (toSubmit.length === 0) return;

        console.log(`[Oracle] Submitting blocks: ${toSubmit.join(', ')}`);
        for (const h of toSubmit) {
            if (!this.running) break;
            await this.submitBlockData(h);
        }
    }

    async refreshNeededBlocks(): Promise<void> {
        this.neededBlocks.clear();
        try {
            const result = await this.contract['getNextBetId']!();
            if (result.revert) return;
            const maxBetId = Number(result.properties?.['nextBetId']);

            for (let i = 1; i < maxBetId; i++) {
                const info = await this.contract['getBetInfo']!(BigInt(i));
                if (info.revert) continue;
                if (info.properties?.['status'] !== 0n) continue;

                const endBlock    = Number(info.properties?.['endBlock']);
                const targetBlock = Number(info.properties?.['targetBlock']);

                if (targetBlock > 0) this.neededBlocks.add(targetBlock - 1);
                for (let h = targetBlock; h <= endBlock; h++) this.neededBlocks.add(h);
            }

            if (this.neededBlocks.size > 0) {
                console.log(`[Oracle] Active bets need blocks: ${[...this.neededBlocks].sort((a, b) => a - b).join(', ')}`);
            }
        } catch (err) {
            console.warn('[Oracle] Failed to scan active bets:', (err as Error).message);
        }
    }

    async submitBlockData(btcHeight: number): Promise<void> {
        if (this.submittedBtcBlocks.has(btcHeight)) return;
        const medianFee    = this.latestBtcFee;
        const mempoolCount = this.latestMempoolCount;
        const timestamp    = Math.floor(Date.now() / 1000);

        if (medianFee === 0) {
            console.log(`[Oracle] BTC block #${btcHeight} — skipping (no fee data yet)`);
            return;
        }

        const medianFeeScaled = Math.round(medianFee * 100);

        try {
            const existing = await this.contract['getBlockData']!(BigInt(btcHeight));
            if (existing.properties && (BigInt(existing.properties['dataSet'] ?? 0)) > 0n) {
                console.log(`[Oracle] BTC block #${btcHeight} already on-chain — skipping`);
                this.submittedBtcBlocks.add(btcHeight);
                return;
            }

            console.log(`[Oracle] Submitting BTC block #${btcHeight} — fee: ${medianFee} sat/vB (${medianFeeScaled}), mempool: ${mempoolCount}`);

            const simulation = await this.contract['setBlockData']!(
                BigInt(btcHeight), BigInt(medianFeeScaled), BigInt(mempoolCount), BigInt(timestamp),
            );

            if (simulation.revert) {
                console.error(`[Oracle] BTC block #${btcHeight} simulation REVERTED: "${simulation.revert}"`);
                return;
            }

            const challenge = await (this.provider as { getChallenge(): Promise<unknown> }).getChallenge();
            const receipt = await simulation.sendTransaction({
                signer:                  this.wallet.keypair,
                mldsaSigner:             this.wallet.mldsaKeypair,
                refundTo:                this.wallet.p2tr,
                maximumAllowedSatToSpend: CONFIG.maxSatsPerTx,
                network:                 this.network,
                feeRate:                 CONFIG.feeRate,
                challenge,
            });

            this.submittedBtcBlocks.add(btcHeight);
            console.log(`[Oracle] BTC block #${btcHeight} — submitted! TX: ${receipt.transactionId}`);

            await upsertOracleFeed({
                blockHeight: btcHeight, medianFeeScaled, mempoolCount, txId: receipt.transactionId,
            }).catch((err: Error) => console.warn('[DB] oracle_feeds insert failed:', err.message));
        } catch (err) {
            console.error(`[Oracle] BTC block #${btcHeight} — failed: ${(err as Error).message}`);
        }
    }

    async fetchJSON(path: string, endpoints: readonly string[] = CONFIG.mempoolRestEndpoints): Promise<unknown> {
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
