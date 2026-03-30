/**
 * Price Submitter
 *
 * Reads the latest BTC/USD price from BlockFeed's REST API and submits it
 * to the on-chain PriceOracle contract when price deviates or heartbeat expires.
 */

import { CONFIG } from './config.js';
import type { KeeperWallet, SimulationResult } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OPNetContract = Record<string, (...args: unknown[]) => Promise<SimulationResult>>;

const BTC_USD_SYMBOL_ID    = 0n;
const DEVIATION_THRESHOLD  = 0.005;
const HEARTBEAT_MS         = 60 * 60 * 1000;
const POLL_INTERVAL_MS     = 60_000;
const FETCH_TIMEOUT_MS     = 8_000;

export class PriceSubmitter {
    private readonly oracleContract: OPNetContract;
    private readonly wallet: KeeperWallet;
    private readonly provider: unknown;
    private readonly network: unknown;

    private running = false;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private lastSubmittedPrice = 0;
    private lastSubmittedAt    = 0;

    constructor(oracleContract: OPNetContract, wallet: KeeperWallet, provider: unknown, network: unknown) {
        this.oracleContract = oracleContract;
        this.wallet   = wallet;
        this.provider = provider;
        this.network  = network;
    }

    start(): void {
        this.running = true;
        console.log('[PriceSubmitter] Starting — deviation threshold: 0.5%, heartbeat: 1h');
        this.poll().catch(() => {});
        this.pollTimer = setInterval(() => {
            if (!this.running) return;
            this.poll().catch((err: Error) => console.warn('[PriceSubmitter] Poll error:', err.message));
        }, POLL_INTERVAL_MS);
    }

    stop(): void {
        this.running = false;
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    }

    private async fetchLatestPrice(): Promise<unknown> {
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

    private shouldSubmit(price: number): boolean {
        if (this.lastSubmittedPrice === 0) return true;
        if (Date.now() - this.lastSubmittedAt > HEARTBEAT_MS) return true;
        return Math.abs(price - this.lastSubmittedPrice) / this.lastSubmittedPrice >= DEVIATION_THRESHOLD;
    }

    private async submitPrice(price: number, confidence: number): Promise<void> {
        const priceScaled      = BigInt(Math.round(price * 1e8));
        const confidenceScaled = BigInt(Math.round(confidence * 1e6));

        console.log(
            `[PriceSubmitter] Submitting BTC/USD $${price.toFixed(2)}` +
            `  confidence=${(confidence * 100).toFixed(3)}%` +
            `  (on-chain: price=${priceScaled}, conf=${confidenceScaled})`,
        );

        const simulation = await this.oracleContract['updatePrice']!(
            BTC_USD_SYMBOL_ID, priceScaled, confidenceScaled,
        );

        if (simulation.revert) {
            console.error('[PriceSubmitter] Simulation REVERTED:', simulation.revert);
            return;
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

        this.lastSubmittedPrice = price;
        this.lastSubmittedAt    = Date.now();
        console.log(`[PriceSubmitter] Submitted! TX: ${receipt.transactionId}`);
    }

    async poll(): Promise<void> {
        if (!this.running) return;

        let json: unknown;
        try {
            json = await this.fetchLatestPrice();
        } catch (err) {
            console.warn('[PriceSubmitter] Failed to fetch BlockFeed price:', (err as Error).message);
            return;
        }

        const data       = (json as { data?: Record<string, string> }).data ?? json as Record<string, string>;
        const price      = parseFloat(data['price'] ?? '0');
        const confidence = parseFloat(data['confidence'] ?? '0');

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
