/**
 * OP-BET Keeper — Status Dashboard + Health API
 *
 * GET /        → HTML dashboard (auto-refreshes every 10s)
 * GET /health  → JSON status
 * POST /api/bets → register bet ownership from frontend
 * GET  /api/bets → query bets by wallet or IDs
 */
import type { OracleFeeder } from './oracle.js';
import type { BetResolver } from './resolver.js';
export declare function startHealthServer(oracle: OracleFeeder, resolver: BetResolver): void;
