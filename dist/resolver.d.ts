/**
 * Bet Resolver
 *
 * Periodically scans all active bets and resolves any whose target/endBlock
 * has oracle data available. Triggers oracle backfill if data is missing.
 */
import type { KeeperWallet, SimulationResult } from './types.js';
import type { OracleFeeder } from './oracle.js';
type OPNetContract = Record<string, (...args: unknown[]) => Promise<SimulationResult>>;
export declare class BetResolver {
    private readonly contract;
    private readonly wallet;
    private readonly provider;
    private readonly network;
    private interval;
    running: boolean;
    private scanning;
    private backfilling;
    readonly resolvedIds: Set<number>;
    private readonly betCooldown;
    oracle: OracleFeeder | null;
    constructor(contract: OPNetContract, wallet: KeeperWallet, provider: unknown, network: unknown);
    start(): void;
    stop(): void;
    scan(): Promise<void>;
    private _doScan;
    backfillBlocks(targetBlock: number): Promise<boolean>;
    private _doBackfill;
}
export {};
