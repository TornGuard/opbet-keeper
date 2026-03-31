/**
 * OP-BET Keeper Bot
 *
 * 1. Oracle feed: Watches Bitcoin blocks, submits setBlockData to OPNet contract.
 * 2. Bet resolution: Scans active bets and resolves those with oracle data.
 * 3. Price submitter: Reads BlockFeed BTC/USD, submits to PriceOracle contract.
 */
import 'dotenv/config';
