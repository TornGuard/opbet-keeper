/**
 * Price Submitter
 *
 * Reads the latest BTC/USD price from BlockFeed's REST API and submits it
 * to the on-chain PriceOracle contract (multi-feeder aggregator).
 *
 * Works in solo mode (minFeeders=1) and multi-feeder mode without any
 * code changes. Before each submission, checks if the current round is
 * stale and finalizes it first so no manual intervention is needed.
 */
import { CONFIG } from './config.js';
const BTC_USD_SYMBOL_ID = 0n;
const DEVIATION_THRESHOLD = 0.005; // 0.5% — submit if price moved more than this
const HEARTBEAT_MS = 60 * 60 * 1000; // 1h  — always submit even if no deviation
const POLL_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
export class PriceSubmitter {
    oracleContract;
    wallet;
    provider;
    network;
    running = false;
    pollTimer = null;
    lastSubmittedPrice = 0;
    lastSubmittedAt = 0;
    constructor(oracleContract, wallet, provider, network) {
        this.oracleContract = oracleContract;
        this.wallet = wallet;
        this.provider = provider;
        this.network = network;
    }
    start() {
        this.running = true;
        console.log('[PriceSubmitter] Starting — deviation: 0.5%, heartbeat: 1h');
        this.poll().catch(() => { });
        this.pollTimer = setInterval(() => {
            if (!this.running)
                return;
            this.poll().catch((err) => console.warn('[PriceSubmitter] Poll error:', err.message));
        }, POLL_INTERVAL_MS);
    }
    stop() {
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    async fetchLatestPrice() {
        const url = `${CONFIG.blockfeedApiUrl}/v1/oracle/btc`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            return await res.json();
        }
        finally {
            clearTimeout(timer);
        }
    }
    shouldSubmit(price) {
        if (this.lastSubmittedPrice === 0)
            return true;
        if (Date.now() - this.lastSubmittedAt > HEARTBEAT_MS)
            return true;
        return Math.abs(price - this.lastSubmittedPrice) / this.lastSubmittedPrice >= DEVIATION_THRESHOLD;
    }
    /**
     * Try to finalize a stale round before submitting.
     * The contract handles this inside submitPrice too, but calling it
     * explicitly first avoids a wasted simulation if the round is stale.
     */
    async tryFinalizeStaleRound() {
        try {
            const sim = await this.oracleContract['finalizeRound'](BTC_USD_SYMBOL_ID);
            if (sim.revert)
                return; // Not stale yet — expected, not an error
            const challenge = await this.provider.getChallenge();
            const receipt = await sim.sendTransaction({
                signer: this.wallet.keypair,
                mldsaSigner: this.wallet.mldsaKeypair,
                refundTo: this.wallet.p2tr,
                maximumAllowedSatToSpend: CONFIG.maxSatsPerTx,
                network: this.network,
                feeRate: CONFIG.feeRate,
                challenge,
            });
            console.log(`[PriceSubmitter] Stale round finalized. TX: ${receipt.transactionId}`);
        }
        catch {
            // Non-critical — submitPrice will handle it internally
        }
    }
    async submitPrice(price, confidence) {
        const priceScaled = BigInt(Math.round(price * 1e8));
        const confidenceScaled = BigInt(Math.round(confidence * 1e6));
        console.log(`[PriceSubmitter] Submitting BTC/USD $${price.toFixed(2)}` +
            `  confidence=${(confidence * 100).toFixed(3)}%`);
        const simulation = await this.oracleContract['submitPrice'](BTC_USD_SYMBOL_ID, priceScaled, confidenceScaled);
        if (simulation.revert) {
            console.error('[PriceSubmitter] Simulation REVERTED:', simulation.revert);
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
        this.lastSubmittedPrice = price;
        this.lastSubmittedAt = Date.now();
        const published = simulation.properties?.['published'];
        console.log(`[PriceSubmitter] Submitted! TX: ${receipt.transactionId}` +
            (published ? '  ✓ price published (threshold met)' : '  ⏳ waiting for other feeders'));
    }
    // ── Main loop ─────────────────────────────────────────────────────────────
    async poll() {
        if (!this.running)
            return;
        let json;
        try {
            json = await this.fetchLatestPrice();
        }
        catch (err) {
            console.warn('[PriceSubmitter] Failed to fetch BlockFeed price:', err.message);
            return;
        }
        const data = json.data ?? json;
        const price = parseFloat(data['price'] ?? '0');
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
        // Finalize any stale round before submitting — keeps rounds clean
        // even if some feeders were offline during the previous round.
        await this.tryFinalizeStaleRound();
        await this.submitPrice(price, confidence);
    }
}
//# sourceMappingURL=price-submitter.js.map