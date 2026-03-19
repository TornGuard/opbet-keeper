/**
 * Neon PostgreSQL database layer for OP-BET Keeper.
 *
 * Tables:
 *   bets         — every bet seen on-chain (active → resolved)
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
