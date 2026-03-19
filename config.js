/**
 * Keeper Bot Configuration
 *
 * All secrets are loaded from environment variables (or a .env file).
 * NEVER hardcode MNEMONIC, DEPLOYER_WIF, or DATABASE_URL here.
 */

import 'dotenv/config';

export const CONFIG = {
  // OPNet testnet RPC
  rpcUrl: process.env.OPNET_RPC_URL || 'https://testnet.opnet.org',

  // Contract address (FeeBet_Market)
  marketAddress: process.env.MARKET_ADDRESS || 'opt1sqqrm9dvf353e9klcq3y8mggcvsqm4f4adgzv786c',

  // Deployer wallet — one of these is REQUIRED
  deployerWif: process.env.DEPLOYER_WIF || '',
  mnemonic: process.env.MNEMONIC || '',

  // Neon PostgreSQL connection string
  databaseUrl: process.env.DATABASE_URL || '',

  // mempool.space REST endpoints (tried in order)
  mempoolRestEndpoints: [
    'https://mempool.ninja/api',
    'https://mempool.bitcoin.nl/api',
    'https://mempool.space/api',
  ],

  // How often to scan for resolvable bets (ms)
  resolveScanInterval: 30_000,

  // How often to poll REST for blocks when WS is down (ms)
  restPollInterval: 15_000,

  // Fee rate for keeper transactions (sat/vB)
  feeRate: Number(process.env.FEE_RATE) || 10,

  // Max sats the keeper is willing to spend per transaction
  maxSatsPerTx: 100_000n,
};
