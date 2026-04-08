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
  marketAddress: process.env.MARKET_ADDRESS || 'opt1sqqht90a38syqu7l7rcaf2ttveulsn9l57q3kyng7',

  // Deployer wallet — one of these is REQUIRED
  deployerWif: process.env.DEPLOYER_WIF || '',
  mnemonic: process.env.MNEMONIC || '',

  // Neon PostgreSQL connection string
  databaseUrl: process.env.DATABASE_URL || '',

  // Signet endpoints — for block height only (OPNet testnet timing)
  mempoolRestEndpoints: [
    'https://mempool.space/signet/api',
  ],

  // Mainnet endpoints — for fee + mempool data (real market volatility for bet resolution)
  mempoolMainnetEndpoints: [
    'https://mempool.space/api',
    'https://mempool.ninja/api',
  ],

  // How often to scan for resolvable bets (ms)
  resolveScanInterval: 30_000,

  // How often to poll REST for blocks when WS is down (ms)
  restPollInterval: 15_000,

  // Fee rate for keeper transactions (sat/vB)
  feeRate: Number(process.env.FEE_RATE) || 10,

  // Max sats the keeper is willing to spend per transaction
  maxSatsPerTx: 100_000n,

  // BlockFeed Price Oracle (on-chain)
  // Set PRICE_ORACLE_ADDRESS after deploying contracts/oracle/build/PriceOracle.wasm
  priceOracleAddress: process.env.PRICE_ORACLE_ADDRESS || '',

  // BlockFeed API base URL — used to read the latest BTC/USD price
  blockfeedApiUrl: process.env.BLOCKFEED_API_URL || 'http://localhost:3001',

  // OPBET_Staking contract address (set after deployment)
  stakingAddress: process.env.STAKING_ADDRESS || '',

  // Accepted betting tokens — keeper flushes staking fees for each after resolving bets
  acceptedTokens: [
    process.env.OPBET_TOKEN_ADDRESS || 'opt1sqz7zu9777w66x3t5gqy8j6m62ege0af60yjlyrkm',
    process.env.MOTO_TOKEN_ADDRESS  || 'opt1sqzkx6wm5acawl9m6nay2mjsm6wagv7gazcgtczds',
  ],
};
