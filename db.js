/**
 * Neon PostgreSQL database layer for OP-BET Keeper.
 *
 * Tables:
 *   bets         — every bet seen on-chain (active → resolved), with optional wallet owner
 *   oracle_feeds — every setBlockData submission
 */

import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bets (
      bet_id        INTEGER PRIMARY KEY,
      bet_type      SMALLINT,
      amount        TEXT,
      end_block     INTEGER,
      status        SMALLINT    NOT NULL DEFAULT 0,
      won           BOOLEAN,
      payout        TEXT,
      wallet        TEXT,
      placed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at   TIMESTAMPTZ,
      resolve_tx    TEXT
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

  // Add wallet column if upgrading from an older schema
  await pool.query(`
    ALTER TABLE bets ADD COLUMN IF NOT EXISTS wallet TEXT;
  `).catch(() => {});

  console.log('[DB] Tables ready');
}

/**
 * Insert a newly discovered active bet (ignore if already known).
 */
export async function upsertBet({ betId, betType, amount, endBlock }) {
  await pool.query(
    `INSERT INTO bets (bet_id, bet_type, amount, end_block)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (bet_id) DO NOTHING`,
    [betId, Number(betType), amount.toString(), endBlock],
  );
}

/**
 * Set the wallet address that owns a bet.
 * Called by the frontend after placing a bet — this is the source of truth
 * for "which bets belong to which wallet" since the contract doesn't store bettor address.
 */
export async function registerBetOwner({ betId, wallet }) {
  await pool.query(
    `INSERT INTO bets (bet_id, wallet)
     VALUES ($1, $2)
     ON CONFLICT (bet_id) DO UPDATE SET wallet = EXCLUDED.wallet`,
    [betId, wallet.toLowerCase()],
  );
}

/**
 * Return bets owned by a wallet address (registered via registerBetOwner).
 */
export async function getBetsByWallet(wallet) {
  const result = await pool.query(
    `SELECT bet_id, bet_type, amount, end_block, status, won, payout, wallet, placed_at, resolved_at, resolve_tx
     FROM bets
     WHERE wallet = $1
     ORDER BY bet_id DESC`,
    [wallet.toLowerCase()],
  );
  return result.rows;
}

/**
 * Return bets for a list of specific IDs (used by frontend to look up its localStorage IDs).
 */
export async function getBetsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const result = await pool.query(
    `SELECT bet_id, bet_type, amount, end_block, status, won, payout, wallet, placed_at, resolved_at, resolve_tx
     FROM bets
     WHERE bet_id = ANY($1)
     ORDER BY bet_id DESC`,
    [ids.map(Number)],
  );
  return result.rows;
}

/**
 * Return all bets (admin/debug use).
 */
export async function getAllBets() {
  const result = await pool.query(
    `SELECT bet_id, bet_type, amount, end_block, status, won, payout, wallet, placed_at, resolved_at, resolve_tx
     FROM bets ORDER BY bet_id DESC`,
  );
  return result.rows;
}

/**
 * Mark a bet as resolved with its outcome.
 */
export async function markBetResolved({ betId, won, payout, txId }) {
  await pool.query(
    `UPDATE bets
     SET status = 1, won = $2, payout = $3, resolved_at = NOW(), resolve_tx = $4
     WHERE bet_id = $1`,
    [betId, Boolean(won), payout != null ? payout.toString() : null, txId ?? null],
  );
}

/**
 * Record a successful oracle feed submission (ignore if block already stored).
 */
export async function upsertOracleFeed({ blockHeight, medianFeeScaled, mempoolCount, txId }) {
  await pool.query(
    `INSERT INTO oracle_feeds (block_height, median_fee_scaled, mempool_count, tx_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (block_height) DO NOTHING`,
    [blockHeight, medianFeeScaled, mempoolCount, txId ?? null],
  );
}
