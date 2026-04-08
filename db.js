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
      param1        TEXT,
      param2        TEXT,
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

    CREATE TABLE IF NOT EXISTS bettors (
      owner_hex  TEXT        PRIMARY KEY,  -- raw on-chain address bytes as 0x hex
      wallet     TEXT,                     -- p2tr address if registered via frontend
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

  // Add columns if upgrading from an older schema
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS wallet TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS token_symbol TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS param1 TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS param2 TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS owner_hex TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS contract_address TEXT;`).catch(() => {});
  await pool.query(`ALTER TABLE bets ADD COLUMN IF NOT EXISTS referrer TEXT;`).catch(() => {});

  console.log('[DB] Tables ready');
}

/**
 * Insert a newly discovered active bet (ignore if already known).
 */
export async function upsertBet({ betId, betType, param1, param2, amount, endBlock, contractAddress }) {
  await pool.query(
    `INSERT INTO bets (bet_id, bet_type, param1, param2, amount, end_block, contract_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (bet_id) DO UPDATE
       SET param1            = COALESCE(EXCLUDED.param1, bets.param1),
           param2            = COALESCE(EXCLUDED.param2, bets.param2),
           contract_address  = COALESCE(EXCLUDED.contract_address, bets.contract_address)`,
    [betId, Number(betType), param1 != null ? param1.toString() : null, param2 != null ? param2.toString() : null, amount.toString(), endBlock, contractAddress || null],
  );
}

/**
 * Set the wallet address that owns a bet.
 * Called by the frontend after placing a bet — this is the source of truth
 * for "which bets belong to which wallet" since the contract doesn't store bettor address.
 */
export async function registerBetOwner({ betId, wallet, tokenSymbol, contractAddress, referrer }) {
  await pool.query(
    `INSERT INTO bets (bet_id, wallet, token_symbol, contract_address, referrer)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bet_id) DO UPDATE
       SET wallet           = EXCLUDED.wallet,
           token_symbol     = COALESCE(EXCLUDED.token_symbol, bets.token_symbol),
           contract_address = COALESCE(EXCLUDED.contract_address, bets.contract_address),
           referrer         = COALESCE(bets.referrer, EXCLUDED.referrer)`,
    [betId, wallet.toLowerCase(), tokenSymbol || null, contractAddress || null, referrer || null],
  );
}

/**
 * Return referral stats for a wallet: who they invited and how many bets those referrals placed.
 */
export async function getReferralStats(wallet) {
  const result = await pool.query(
    `SELECT
       COUNT(DISTINCT b.wallet)::int                                  AS referral_count,
       COUNT(*)::int                                                  AS referred_bets,
       COUNT(*) FILTER (WHERE b.won = true)::int                     AS referred_wins,
       COALESCE(SUM(b.payout::numeric) FILTER (WHERE b.won = true), 0)::text AS referred_volume
     FROM bets b
     WHERE b.referrer = $1`,
    [wallet.toLowerCase()],
  );
  return result.rows[0] || { referral_count: 0, referred_bets: 0, referred_wins: 0, referred_volume: '0' };
}

/**
 * Return bets owned by a wallet address (registered via registerBetOwner).
 */
export async function getBetsByWallet(wallet, contractAddress) {
  const params = [wallet.toLowerCase()];
  const contractFilter = contractAddress ? ` AND contract_address = $2` : '';
  if (contractAddress) params.push(contractAddress);
  const result = await pool.query(
    `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, token_symbol, placed_at, resolved_at, resolve_tx
     FROM bets
     WHERE wallet = $1${contractFilter}
     ORDER BY bet_id DESC`,
    params,
  );
  return result.rows;
}

/**
 * Return bets for a list of specific IDs (used by frontend to look up its localStorage IDs).
 */
export async function getBetsByIds(ids, contractAddress) {
  if (!ids || ids.length === 0) return [];
  const params = [ids.map(Number)];
  const contractFilter = contractAddress ? ` AND contract_address = $2` : '';
  if (contractAddress) params.push(contractAddress);
  const result = await pool.query(
    `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, token_symbol, placed_at, resolved_at, resolve_tx
     FROM bets
     WHERE bet_id = ANY($1)${contractFilter}
     ORDER BY bet_id DESC`,
    params,
  );
  return result.rows;
}

/**
 * Return the most recent N bets across all wallets (for live feed).
 */
export async function getRecentBets(contractAddress, limit = 20) {
  const contractFilter = contractAddress ? ' AND contract_address = $2' : '';
  const params = contractAddress ? [limit, contractAddress] : [limit];
  const result = await pool.query(
    `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, token_symbol, placed_at, resolved_at
     FROM bets
     WHERE TRUE${contractFilter}
     ORDER BY bet_id DESC
     LIMIT $1`,
    params,
  );
  return result.rows;
}

/**
 * Get wallet + bet params for a single bet (used for Telegram notification).
 */
export async function getBetWithWallet(betId) {
  const result = await pool.query(
    `SELECT wallet, param1, param2, bet_type FROM bets WHERE bet_id = $1`,
    [betId],
  );
  return result.rows[0] || null;
}

/**
 * Count consecutive wins for a wallet (streak detection).
 */
export async function getConsecutiveWins(wallet) {
  const result = await pool.query(
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

/**
 * Return all bets (admin/debug use).
 */
export async function getAllBets() {
  const result = await pool.query(
    `SELECT bet_id, bet_type, param1, param2, amount, end_block, status, won, payout, wallet, placed_at, resolved_at, resolve_tx
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
 * Store the on-chain owner (hex bytes) for a bet and upsert into the bettors table.
 * Called by the keeper when it first scans a bet from chain.
 */
export async function upsertBetOwner({ betId, ownerHex }) {
  // Store owner_hex on the bet row
  await pool.query(
    `UPDATE bets SET owner_hex = $1 WHERE bet_id = $2 AND owner_hex IS NULL`,
    [ownerHex, betId],
  );

  // Upsert into bettors table — tracks every unique participant for airdrop
  await pool.query(
    `INSERT INTO bettors (owner_hex, first_bet, last_bet, bet_count)
     VALUES ($1, $2, $2, 1)
     ON CONFLICT (owner_hex) DO UPDATE
       SET last_bet  = GREATEST(bettors.last_bet, EXCLUDED.last_bet),
           bet_count = bettors.bet_count + 1,
           updated_at = NOW()`,
    [ownerHex, betId],
  );
}

/**
 * Link a p2tr wallet address to an on-chain owner_hex (when user registers via frontend).
 */
export async function linkBettorWallet({ ownerHex, wallet }) {
  await pool.query(
    `INSERT INTO bettors (owner_hex, wallet, first_bet, last_bet, bet_count)
     VALUES ($1, $2, 0, 0, 0)
     ON CONFLICT (owner_hex) DO UPDATE
       SET wallet = COALESCE(EXCLUDED.wallet, bettors.wallet)`,
    [ownerHex, wallet.toLowerCase()],
  );
}

/**
 * Return all bettors for airdrop — includes both on-chain hex and p2tr wallet if available.
 */
export async function getAllBettors() {
  const result = await pool.query(
    `SELECT owner_hex, wallet, first_bet, last_bet, bet_count, created_at
     FROM bettors
     ORDER BY first_bet ASC`,
  );
  return result.rows;
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
