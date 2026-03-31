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
import type { KeeperWallet, SimulationResult } from './types.js';
type OPNetContract = Record<string, (...args: unknown[]) => Promise<SimulationResult>>;
export declare class PriceSubmitter {
    private readonly oracleContract;
    private readonly wallet;
    private readonly provider;
    private readonly network;
    private running;
    private pollTimer;
    private lastSubmittedPrice;
    private lastSubmittedAt;
    constructor(oracleContract: OPNetContract, wallet: KeeperWallet, provider: unknown, network: unknown);
    start(): void;
    stop(): void;
    private fetchLatestPrice;
    private shouldSubmit;
    /**
     * Try to finalize a stale round before submitting.
     * The contract handles this inside submitPrice too, but calling it
     * explicitly first avoids a wasted simulation if the round is stale.
     */
    private tryFinalizeStaleRound;
    private submitPrice;
    poll(): Promise<void>;
}
export {};
