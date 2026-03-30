/**
 * PostgreSQL database layer for OP-BET Keeper.
 *
 * Tables:
 *   bets         — every bet seen on-chain (active → resolved), with optional wallet owner
 *   bettors      — unique participant index for airdrop tracking
 *   oracle_feeds — every setBlockData submission
 */

import pg from 'pg';
import type {
    DbBet,
    DbBettor,
    DbOracleFeed,
    UpsertBetParams,
    UpsertOracleFeedParams,
    MarkBetResolvedParams,
    RegisterBetOwnerParams,
    UpsertBetOwnerParams,
    LinkBettorWalletParams,
} from './types.js';

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env['DATABASE_URL'],
    ssl: { rejectUnauthorized: false },
});

export async function initDb(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bets (
            bet_id            INTEGER PRIMARY KEY,
            bet_type          SMALLINT,
            param1            TEXT,
            param2            TEXT,
            amount            TEXT,
            end_block         INTEGER,
            status            SMALLINT    NOT NULL DEFAULT 0,
            won               BOOLEAN,
            payout            TEXT,
            wallet            TEXT,
            token_symbol      TEXT,
            owner_hex         TEXT,
            contract_address  TEXT,
            placed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at       TIMESTAMPTZ,
            resolve_tx        TEXT
        );

        CREATE TABLE IF NOT EXISTS bettors (
            owner_hex  TEXT        PRIMARY KEY,
            wallet     TEXT,
            first_bet  INTEGER,
            last_bet   INTEGER,
            bet_count  INTEGER     NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS oracle_feeds (
            id                SERIAL PRIMARY KEY,
            block_height      INTEGER     NOT NULL,
            median_fee_scaled INTEGER,
            mempool_count     INTEGER,
            tx_id             TEXT,
            submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (block_height)
        );
    `);

    // Idempotent column additions for schema upgrades
    const addCols = [
        `ALTER TABLE bets ADD COLUMN IF NOT EXISTS wallet TEXT`,
        `ALTER TABLE bets ADD COLUMN IF NOT EXISTS token_symbol TEXT`,
        `ALTER TABLE bets ADD COLUMN IF NOT EXISTS param1 TEXT`,
        `ALTER TABLE bets ADD COLUMN IF NOT EXISTS param2 TEXT`,
        `ALTER TABLE bets ADD COLUMN IF NOT EXISTS owner_hex TEXT`,
        `ALTER TABLE bets ADD COLUMN IF NOT EXISTS contract_address TEXT`,
    ];
    for (const sql of addCols) {
        await pool.query(sql).catch(() => undefined);
    }

    console.log('[DB] Tables ready');
}

/** Insert a newly discovered active bet; update param1/param2 if previously NULL. */
export async function upsertBet(params: UpsertBetParams): Promise<void> {
    const { betId, betType, param1, param2, amount, endBlock, contractAddress } = params;
    await pool.query(
        `INSERT INTO bets (bet_id, bet_type, param1, param2, amount, end_block, contract_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (bet_id) DO UPDATE
           SET param1           = COALESCE(EXCLUDED.param1, bets.param1),
               param2           = COALESCE(EXCLUDED.param2, bets.param2),
               contract_address = COALESCE(EXCLUDED.contract_address, bets.contract_address)`,
        [
            betId,
            Number(betType),
            param1 !== null ? param1.toString() : null,
            param2 !== null ? param2.toString() : null,
            amount.toString(),
            endBlock,
            contractAddress || null,
        ],
    );
}

/**
 * Register the p2tr wallet address that owns a bet.
 * Source of truth for wallet → bet association (contract does not store this).
 */
export async function registerBetOwner(params: RegisterBetOwnerParams): Promise<void> {
    const { betId, wallet, tokenSymbol, contractAddress } = params;
    await pool.query(
        `INSERT INTO bets (bet_id, wallet, token_symbol, contract_address)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bet_id) DO UPDATE
           SET wallet           = EXCLUDED.wallet,
               token_symbol     = COALESCE(EXCLUDED.token_symbol, bets.token_symbol),
               contract_address = COALESCE(EXCLUDED.contract_address, bets.contract_address)`,
        [betId, wallet.toLowerCase(), tokenSymbol ?? null, contractAddress ?? null],
    );
}

/** Return bets owned by a wallet address. */
export async function getBetsByWallet(wallet: string, contractAddress?: string): Promise<DbBet[]> {
    const params: (string | undefined)[] = [wallet.toLowerCase()];
    const contractFilter = contractAddress ? ` AND contract_address = $2` : '';
    if (contractAddress) params.push(contractAddress);
    const result = await pool.query<DbBet>(
        `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, token_symbol, placed_at, resolved_at, resolve_tx
         FROM bets
         WHERE wallet = $1${contractFilter}
         ORDER BY bet_id DESC`,
        params,
    );
    return result.rows;
}

/** Return bets for a list of specific IDs (frontend localStorage lookup). */
export async function getBetsByIds(ids: number[], contractAddress?: string): Promise<DbBet[]> {
    if (ids.length === 0) return [];
    const params: (number[] | string)[] = [ids.map(Number)];
    const contractFilter = contractAddress ? ` AND contract_address = $2` : '';
    if (contractAddress) params.push(contractAddress);
    const result = await pool.query<DbBet>(
        `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, token_symbol, placed_at, resolved_at, resolve_tx
         FROM bets
         WHERE bet_id = ANY($1)${contractFilter}
         ORDER BY bet_id DESC`,
        params,
    );
    return result.rows;
}

/** Return the most recent N bets across all wallets (live feed). */
export async function getRecentBets(contractAddress?: string, limit = 20): Promise<DbBet[]> {
    const contractFilter = contractAddress ? ' AND contract_address = $2' : '';
    const params: (number | string)[] = contractAddress ? [limit, contractAddress] : [limit];
    const result = await pool.query<DbBet>(
        `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, token_symbol, placed_at, resolved_at
         FROM bets
         WHERE TRUE${contractFilter}
         ORDER BY bet_id DESC
         LIMIT $1`,
        params,
    );
    return result.rows;
}

/** Get wallet + bet params for a single bet (used for Telegram notification). */
export async function getBetWithWallet(betId: number): Promise<Pick<DbBet, 'wallet' | 'param1' | 'param2' | 'bet_type' | 'token_symbol'> | null> {
    const result = await pool.query<Pick<DbBet, 'wallet' | 'param1' | 'param2' | 'bet_type' | 'token_symbol'>>(
        `SELECT wallet, param1, param2, bet_type, token_symbol FROM bets WHERE bet_id = $1`,
        [betId],
    );
    return result.rows[0] ?? null;
}

/** Count consecutive wins for a wallet (streak detection). */
export async function getConsecutiveWins(wallet: string): Promise<number> {
    const result = await pool.query<{ won: boolean }>(
        `SELECT won FROM bets
         WHERE wallet = $1 AND won IS NOT NULL
         ORDER BY bet_id DESC
         LIMIT 10`,
        [wallet.toLowerCase()],
    );
    let streak = 0;
    for (const row of result.rows) {
        if (row.won === true) streak++;
        else break;
    }
    return streak;
}

/** Return all bets (admin/debug use). */
export async function getAllBets(): Promise<DbBet[]> {
    const result = await pool.query<DbBet>(
        `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, placed_at, resolved_at, resolve_tx
         FROM bets ORDER BY bet_id DESC`,
    );
    return result.rows;
}

/** Mark a bet as resolved with its outcome. */
export async function markBetResolved(params: MarkBetResolvedParams): Promise<void> {
    const { betId, won, payout, txId } = params;
    await pool.query(
        `UPDATE bets
         SET status = 1, won = $2, payout = $3, resolved_at = NOW(), resolve_tx = $4
         WHERE bet_id = $1`,
        [betId, Boolean(won), payout !== null ? payout.toString() : null, txId ?? null],
    );
}

/**
 * Store the on-chain owner (hex bytes) for a bet and upsert into the bettors table.
 * Called by the keeper when it first scans a bet from chain.
 */
export async function upsertBetOwner(params: UpsertBetOwnerParams): Promise<void> {
    const { betId, ownerHex } = params;
    await pool.query(
        `UPDATE bets SET owner_hex = $1 WHERE bet_id = $2 AND owner_hex IS NULL`,
        [ownerHex, betId],
    );
    await pool.query(
        `INSERT INTO bettors (owner_hex, first_bet, last_bet, bet_count)
         VALUES ($1, $2, $2, 1)
         ON CONFLICT (owner_hex) DO UPDATE
           SET last_bet   = GREATEST(bettors.last_bet, EXCLUDED.last_bet),
               bet_count  = bettors.bet_count + 1,
               updated_at = NOW()`,
        [ownerHex, betId],
    );
}

/** Link a p2tr wallet address to an on-chain owner_hex. */
export async function linkBettorWallet(params: LinkBettorWalletParams): Promise<void> {
    const { ownerHex, wallet } = params;
    await pool.query(
        `INSERT INTO bettors (owner_hex, wallet, first_bet, last_bet, bet_count)
         VALUES ($1, $2, 0, 0, 0)
         ON CONFLICT (owner_hex) DO UPDATE
           SET wallet = COALESCE(EXCLUDED.wallet, bettors.wallet)`,
        [ownerHex, wallet.toLowerCase()],
    );
}

/** Return all bettors for airdrop snapshot. */
export async function getAllBettors(): Promise<DbBettor[]> {
    const result = await pool.query<DbBettor>(
        `SELECT owner_hex, wallet, first_bet, last_bet, bet_count, created_at
         FROM bettors
         ORDER BY first_bet ASC`,
    );
    return result.rows;
}

/** Record a successful oracle feed submission (skip if already stored). */
export async function upsertOracleFeed(params: UpsertOracleFeedParams): Promise<void> {
    const { blockHeight, medianFeeScaled, mempoolCount, txId } = params;
    await pool.query(
        `INSERT INTO oracle_feeds (block_height, median_fee_scaled, mempool_count, tx_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (block_height) DO NOTHING`,
        [blockHeight, medianFeeScaled, mempoolCount, txId ?? null],
    );
}

/** Return recent oracle feed rows (last N by block height). */
export async function getRecentFeeds(limit = 50): Promise<DbOracleFeed[]> {
    const result = await pool.query<DbOracleFeed>(
        `SELECT block_height, median_fee_scaled, mempool_count, tx_id, submitted_at
         FROM oracle_feeds ORDER BY block_height DESC LIMIT $1`,
        [limit],
    );
    return result.rows;
}
