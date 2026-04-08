/**
 * OP-BET Keeper Bot
 *
 * Automates two critical operations:
 * 1. Oracle feed: Watches OPNet blocks, fetches Bitcoin fees, submits setBlockData.
 * 2. Bet resolution: Scans active bets and resolves any whose endBlock has oracle data.
 *
 * All bets and oracle feeds are persisted to a Neon PostgreSQL database.
 *
 * Usage:
 *   cp .env.example .env   # fill in MNEMONIC (or DEPLOYER_WIF) and DATABASE_URL
 *   node index.js
 *
 * Deploy: run as a long-lived Node.js process on a VPS (see ecosystem.config.cjs for PM2).
 */

import { CONFIG } from './config.js';
import { MARKET_ABI, PRICE_ORACLE_ABI } from './abi.js';
import { OracleFeeder } from './oracle.js';
import { BetResolver } from './resolver.js';
import { PriceSubmitter } from './price-submitter.js';
import { initDb } from './db.js';
import { startHealthServer } from './health.js';
import { notifyStartup } from './telegram.js';
import { DailyDigest } from './daily-digest.js';
import { WinNotifier } from './win-notifier.js';
import { LeaderboardService } from './leaderboard-service.js';

async function main() {
  if (!CONFIG.mnemonic && !CONFIG.deployerWif) {
    console.error('ERROR: MNEMONIC or DEPLOYER_WIF environment variable is required.');
    console.error('');
    console.error('Usage:');
    console.error('  Copy .env.example to .env and fill in your credentials.');
    process.exit(1);
  }

  if (!CONFIG.databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    console.error('  Set it in your .env file.');
    process.exit(1);
  }

  console.log('');
  console.log('  ╔═══════════════════════════════════╗');
  console.log('  ║       OP-BET Keeper Bot            ║');
  console.log('  ║   Oracle Feed + Auto-Resolver      ║');
  console.log('  ╚═══════════════════════════════════╝');
  console.log('');
  console.log(`  Market:   ${CONFIG.marketAddress}`);
  console.log(`  RPC:      ${CONFIG.rpcUrl}`);
  console.log(`  Fee rate: ${CONFIG.feeRate} sat/vB`);
  console.log('');

  // Connect to Neon PostgreSQL
  await initDb();

  // Initialize OPNet provider and wallet
  const { getContract, JSONRpcProvider } = await import('opnet');
  const { networks } = await import('@btc-vision/bitcoin');
  const { Mnemonic, MLDSASecurityLevel, AddressTypes, Wallet } = await import('@btc-vision/transaction');

  const network = networks.opnetTestnet;
  const provider = new JSONRpcProvider({ url: CONFIG.rpcUrl, network });

  // Reconstruct wallet from mnemonic or WIF
  let wallet;
  if (CONFIG.mnemonic) {
    const m = new Mnemonic(CONFIG.mnemonic, '', network, MLDSASecurityLevel.LEVEL2);
    wallet = m.deriveOPWallet(AddressTypes.P2TR, 0);
    console.log(`  Keeper:   ${wallet.p2tr} (from mnemonic)`);
  } else {
    wallet = Wallet.fromWif(CONFIG.deployerWif, network);
    console.log(`  Keeper:   ${wallet.p2tr} (from WIF)`);
  }

  // Verify wallet has funds
  try {
    const utxos = await provider.fetchUTXOs({ address: wallet.p2tr });
    const totalSats = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
    console.log(`  Balance:  ${totalSats} sats (${utxos.length} UTXOs)`);
  } catch {
    console.log('  Balance:  (could not fetch)');
  }
  console.log('');

  // Get contract instance with wallet as sender (for write operations)
  const contract = getContract(
    CONFIG.marketAddress,
    MARKET_ABI,
    provider,
    network,
    wallet.address,
  );

  // Quick health check — read nextBetId
  try {
    const nextIdResult = await contract.getNextBetId();
    if (nextIdResult.revert) {
      console.error('  Contract health check FAILED: getNextBetId reverted');
      console.error('  Check the market address and ABI');
      process.exit(1);
    }
    console.log(`  Next bet ID: ${nextIdResult.properties.nextBetId}`);
    console.log('  Contract: OK');
  } catch (err) {
    console.error(`  Contract health check FAILED: ${err.message}`);
    process.exit(1);
  }
  console.log('');

  // Start oracle feeder (polls OPNet blocks, fetches Bitcoin fees, submits setBlockData)
  const oracle = new OracleFeeder(contract, wallet, provider, network);
  oracle.start();

  // Start bet resolver (scans active bets, calls resolveBet)
  const resolver = new BetResolver(contract, wallet, provider, network);
  resolver.oracle = oracle;
  resolver.start();

  // Start BTC/USD price submitter (reads BlockFeed, submits to PriceOracle contract)
  if (CONFIG.priceOracleAddress) {
    const oracleContract = getContract(
      CONFIG.priceOracleAddress,
      PRICE_ORACLE_ABI,
      provider,
      network,
      wallet.address,
    );

    // Verify keeper is authorized as a feeder
    try {
      const check = await oracleContract.isFeeder(wallet.address);
      if (check.revert || !check.properties?.authorized) {
        console.warn('[PriceSubmitter] Keeper wallet is NOT an authorized feeder — skipping price submissions');
        console.warn('[PriceSubmitter] Call addFeeder() with the keeper address to authorize it');
      } else {
        console.log('[PriceSubmitter] Keeper is authorized feeder — starting');
        const priceSubmitter = new PriceSubmitter(oracleContract, wallet, provider, network);
        priceSubmitter.start();
      }
    } catch (err) {
      console.warn('[PriceSubmitter] Could not verify feeder status:', err.message);
    }
  } else {
    console.log('[PriceSubmitter] PRICE_ORACLE_ADDRESS not set — price submissions disabled');
    console.log('[PriceSubmitter] Deploy contracts/oracle/build/PriceOracle.wasm and set PRICE_ORACLE_ADDRESS');
  }

  // Start daily digest (midnight UTC Telegram summary)
  const digest = new DailyDigest();
  digest.start();

  // Start win notifier (polls DB every 30s, alerts winners on Telegram)
  const winNotifier = new WinNotifier();
  await winNotifier.start();

  // Start weekly leaderboard (every Sunday midnight UTC)
  const leaderboard = new LeaderboardService();
  leaderboard.start();

  // Start health HTTP server
  startHealthServer(oracle, resolver);

  // Telegram startup ping (confirms bot token + chat ID are working)
  notifyStartup();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Keeper] Shutting down...');
    oracle.stop();
    resolver.stop();
    digest.stop();
    winNotifier.stop();
    leaderboard.stop();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('[Keeper] Running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
