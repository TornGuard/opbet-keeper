/**
 * PostgreSQL database layer for OP-BET Keeper.
 *
 * Tables:
 *   bets         — every bet seen on-chain (active → resolved), with optional wallet owner
 *   bettors      — unique participant index for airdrop tracking
 *   oracle_feeds — every setBlockData submission
 */
import type { DbBet, DbBettor, DbOracleFeed, UpsertBetParams, UpsertOracleFeedParams, MarkBetResolvedParams, RegisterBetOwnerParams, UpsertBetOwnerParams, LinkBettorWalletParams } from './types.js';
export declare const pool: import("pg").Pool;
export declare function initDb(): Promise<void>;
/** Insert a newly discovered active bet; update param1/param2 if previously NULL. */
export declare function upsertBet(params: UpsertBetParams): Promise<void>;
/**
 * Register the p2tr wallet address that owns a bet.
 * Source of truth for wallet → bet association (contract does not store this).
 */
export declare function registerBetOwner(params: RegisterBetOwnerParams): Promise<void>;
/** Return bets owned by a wallet address. */
export declare function getBetsByWallet(wallet: string, contractAddress?: string): Promise<DbBet[]>;
/** Return bets for a list of specific IDs (frontend localStorage lookup). */
export declare function getBetsByIds(ids: number[], contractAddress?: string): Promise<DbBet[]>;
/** Return the most recent N bets across all wallets (live feed). */
export declare function getRecentBets(contractAddress?: string, limit?: number): Promise<DbBet[]>;
/** Get wallet + bet params for a single bet (used for Telegram notification). */
export declare function getBetWithWallet(betId: number): Promise<Pick<DbBet, 'wallet' | 'param1' | 'param2' | 'bet_type' | 'token_symbol'> | null>;
/** Count consecutive wins for a wallet (streak detection). */
export declare function getConsecutiveWins(wallet: string): Promise<number>;
/** Return all bets (admin/debug use). */
export declare function getAllBets(): Promise<DbBet[]>;
/** Mark a bet as resolved with its outcome. */
export declare function markBetResolved(params: MarkBetResolvedParams): Promise<void>;
/**
 * Store the on-chain owner (hex bytes) for a bet and upsert into the bettors table.
 * Called by the keeper when it first scans a bet from chain.
 */
export declare function upsertBetOwner(params: UpsertBetOwnerParams): Promise<void>;
/** Link a p2tr wallet address to an on-chain owner_hex. */
export declare function linkBettorWallet(params: LinkBettorWalletParams): Promise<void>;
/** Return all bettors for airdrop snapshot. */
export declare function getAllBettors(): Promise<DbBettor[]>;
/** Record a successful oracle feed submission (skip if already stored). */
export declare function upsertOracleFeed(params: UpsertOracleFeedParams): Promise<void>;
/** Return recent oracle feed rows (last N by block height). */
export declare function getRecentFeeds(limit?: number): Promise<DbOracleFeed[]>;
