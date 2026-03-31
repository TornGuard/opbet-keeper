/**
 * Shared type definitions for the OP-BET Keeper Bot.
 */
/** Minimal interface for the OPNet wallet used by the keeper. */
export interface KeeperWallet {
    readonly p2tr: string;
    readonly address: unknown;
    readonly keypair: unknown;
    readonly mldsaKeypair: unknown;
}
/** Shape of a successful contract call result from the opnet SDK. */
export interface ContractCallResult {
    readonly revert?: string;
    readonly properties?: Record<string, bigint | boolean | string | null>;
}
/** Result of sendTransaction from opnet SDK. */
export interface SendTransactionResult {
    readonly transactionId: string;
}
/** Result with a sendTransaction method attached. */
export interface SimulationResult extends ContractCallResult {
    sendTransaction(opts: SendTransactionOptions): Promise<SendTransactionResult>;
}
/** Options passed to sendTransaction. */
export interface SendTransactionOptions {
    signer: unknown;
    mldsaSigner: unknown;
    refundTo: string;
    maximumAllowedSatToSpend: bigint;
    network: unknown;
    feeRate: number;
    challenge: unknown;
}
/** Bet info as returned by getBetInfo(betId). */
export interface BetInfoProperties {
    betType: bigint;
    param1: bigint;
    param2: bigint;
    amount: bigint;
    odds: bigint;
    targetBlock: bigint;
    endBlock: bigint;
    status: bigint;
    payout: bigint;
    token: bigint;
}
/** Block data as returned by getBlockData(height). */
export interface BlockDataProperties {
    medianFee: bigint;
    mempoolCount: bigint;
    blockTimestamp: bigint;
    dataSet: bigint;
}
/** Database row for the `bets` table. */
export interface DbBet {
    bet_id: number;
    bet_type: number;
    param1: string | null;
    param2: string | null;
    amount: string;
    end_block: number;
    status: number;
    won: boolean | null;
    payout: string | null;
    wallet: string | null;
    token_symbol: string | null;
    placed_at: Date;
    resolved_at: Date | null;
    resolve_tx: string | null;
    owner_hex: string | null;
    contract_address: string | null;
}
/** Database row for the `bettors` table. */
export interface DbBettor {
    owner_hex: string;
    wallet: string | null;
    first_bet: number;
    last_bet: number;
    bet_count: number;
    created_at: Date;
}
/** Database row for the `oracle_feeds` table. */
export interface DbOracleFeed {
    id: number;
    block_height: number;
    median_fee_scaled: number;
    mempool_count: number;
    tx_id: string | null;
    submitted_at: Date;
}
/** Parameters for upsertBet. */
export interface UpsertBetParams {
    betId: number;
    betType: bigint;
    param1: bigint | null;
    param2: bigint | null;
    amount: bigint;
    endBlock: number;
    contractAddress: string;
}
/** Parameters for upsertOracleFeed. */
export interface UpsertOracleFeedParams {
    blockHeight: number;
    medianFeeScaled: number;
    mempoolCount: number;
    txId: string | null;
}
/** Parameters for markBetResolved. */
export interface MarkBetResolvedParams {
    betId: number;
    won: boolean;
    payout: bigint | null;
    txId: string | null;
}
/** Parameters for registerBetOwner. */
export interface RegisterBetOwnerParams {
    betId: number;
    wallet: string;
    tokenSymbol: string | null;
    contractAddress: string | null;
}
/** Parameters for upsertBetOwner. */
export interface UpsertBetOwnerParams {
    betId: number;
    ownerHex: string;
}
/** Parameters for linkBettorWallet. */
export interface LinkBettorWalletParams {
    ownerHex: string;
    wallet: string;
}
/** Decoded human-readable bet description. */
export interface DecodedBet {
    type: string;
    label?: string;
    dir?: string;
    threshold?: string | null;
}
/** Parameters for Telegram notifyEntry. */
export interface NotifyEntryParams {
    betId: number;
    wallet: string | null;
    txId: string | null;
    betType: bigint | null;
    param1: bigint | null;
    param2: bigint | null;
    amount: bigint | null;
    endBlock: number | null;
    tokenSymbol: string | null;
}
/** Parameters for Telegram notifyWin. */
export interface NotifyWinParams {
    betId: number;
    wallet: string | null;
    payout: bigint;
    direction: string | null;
    threshold: string | null;
    tokenSymbol: string | null;
}
/** Parameters for Telegram notifyStreak. */
export interface NotifyStreakParams {
    wallet: string;
    streak: number;
}
/** ABI entry for a contract method. */
export interface AbiEntry {
    name: string;
    type: 'function';
    constant: boolean;
    inputs: AbiParam[];
    outputs: AbiParam[];
}
/** ABI parameter definition. */
export interface AbiParam {
    name: string;
    type: string;
}
/** Statistics snapshot for the health/status dashboard. */
export interface KeeperStats {
    totalBets: number;
    activeBets: number;
    totalFeeds: number;
    totalBettors: number;
    latestBtcFee: number;
    latestBtcBlockHeight: number;
    latestMempoolCount: number;
    uptimeSeconds: number;
    recentBets: DbBet[];
    recentFeeds: DbOracleFeed[];
    feeStats: FeeStats | null;
}
/** Aggregate fee statistics from oracle_feeds. */
export interface FeeStats {
    min_fee: number;
    max_fee: number;
    avg_fee: number;
    min_mempool: number;
    max_mempool: number;
    avg_mempool: number;
}
