/**
 * Oracle Feeder
 *
 * Watches Bitcoin blocks via mempool.space and submits setBlockData() to the
 * OPNet contract keyed by BITCOIN block height.
 */
import type { KeeperWallet, SimulationResult } from './types.js';
type OPNetContract = Record<string, (...args: unknown[]) => Promise<SimulationResult>>;
export declare class OracleFeeder {
    private readonly contract;
    private readonly wallet;
    private readonly provider;
    private readonly network;
    running: boolean;
    private pollTimer;
    latestBtcFee: number;
    latestBtcBlockHeight: number;
    latestMempoolCount: number;
    private readonly submittedBtcBlocks;
    readonly neededBlocks: Set<number>;
    constructor(contract: OPNetContract, wallet: KeeperWallet, provider: unknown, network: unknown);
    start(): void;
    stop(): void;
    fetchBitcoinData(): Promise<void>;
    poll(): Promise<void>;
    refreshNeededBlocks(): Promise<void>;
    submitBlockData(btcHeight: number): Promise<void>;
    fetchJSON(path: string, endpoints?: readonly string[]): Promise<unknown>;
}
export {};
