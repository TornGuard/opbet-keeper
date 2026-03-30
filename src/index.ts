/**
 * OP-BET Keeper Bot
 *
 * 1. Oracle feed: Watches Bitcoin blocks, submits setBlockData to OPNet contract.
 * 2. Bet resolution: Scans active bets and resolves those with oracle data.
 * 3. Price submitter: Reads BlockFeed BTC/USD, submits to PriceOracle contract.
 */

import 'dotenv/config';
import { CONFIG } from './config.js';
import { MARKET_ABI, PRICE_ORACLE_ABI } from './abi.js';
import { OracleFeeder } from './oracle.js';
import { BetResolver } from './resolver.js';
import { PriceSubmitter } from './price-submitter.js';
import { initDb } from './db.js';
import { startHealthServer } from './health.js';
import { notifyStartup } from './telegram.js';

async function main(): Promise<void> {
    if (!CONFIG.mnemonic && !CONFIG.deployerWif) {
        console.error('ERROR: MNEMONIC or DEPLOYER_WIF environment variable is required.');
        process.exit(1);
    }

    if (!CONFIG.databaseUrl) {
        console.error('ERROR: DATABASE_URL environment variable is required.');
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

    await initDb();

    // Dynamic imports — opnet/bitcoin packages are ESM
    const { getContract, JSONRpcProvider } = await import('opnet');
    const { networks }                     = await import('@btc-vision/bitcoin');
    const { Mnemonic, MLDSASecurityLevel, AddressTypes, Wallet } =
        await import('@btc-vision/transaction');

    const network  = networks.opnetTestnet;
    const provider = new JSONRpcProvider({ url: CONFIG.rpcUrl, network });

    // Reconstruct wallet from mnemonic or WIF
    let wallet: { p2tr: string; address: unknown; keypair: unknown; mldsaKeypair: unknown };
    if (CONFIG.mnemonic) {
        const m = new Mnemonic(CONFIG.mnemonic, '', network, MLDSASecurityLevel.LEVEL2);
        wallet  = m.deriveOPWallet(AddressTypes.P2TR, 0) as typeof wallet;
        console.log(`  Keeper:   ${wallet.p2tr} (from mnemonic)`);
    } else {
        wallet = Wallet.fromWif(CONFIG.deployerWif, network as unknown as string) as typeof wallet;
        console.log(`  Keeper:   ${wallet.p2tr} (from WIF)`);
    }

    // Verify wallet has funds
    try {
        const utxos     = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
        const totalSats = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
        console.log(`  Balance:  ${totalSats} sats (${utxos.length} UTXOs)`);
    } catch {
        console.log('  Balance:  (could not fetch)');
    }
    console.log('');

    // Market contract
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = getContract(CONFIG.marketAddress, MARKET_ABI as any, provider, network, wallet.address as any) as any;

    // Health check
    try {
        const nextIdResult = await contract.getNextBetId();
        if (nextIdResult.revert) {
            console.error('  Contract health check FAILED: getNextBetId reverted');
            process.exit(1);
        }
        console.log(`  Next bet ID: ${nextIdResult.properties.nextBetId}`);
        console.log('  Contract: OK');
    } catch (err) {
        console.error(`  Contract health check FAILED: ${(err as Error).message}`);
        process.exit(1);
    }
    console.log('');

    const oracle   = new OracleFeeder(contract, wallet, provider, network);
    oracle.start();

    const resolver  = new BetResolver(contract, wallet, provider, network);
    resolver.oracle = oracle;
    resolver.start();

    if (CONFIG.priceOracleAddress) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const oracleContract = getContract(CONFIG.priceOracleAddress, PRICE_ORACLE_ABI as any, provider, network, wallet.address as any) as any;
        try {
            const check = await oracleContract.isFeeder(wallet.address);
            if (check.revert || !check.properties?.authorized) {
                console.warn('[PriceSubmitter] Keeper wallet is NOT an authorized feeder — skipping price submissions');
            } else {
                console.log('[PriceSubmitter] Keeper is authorized feeder — starting');
                const priceSubmitter = new PriceSubmitter(oracleContract, wallet, provider, network);
                priceSubmitter.start();
            }
        } catch (err) {
            console.warn('[PriceSubmitter] Could not verify feeder status:', (err as Error).message);
        }
    } else {
        console.log('[PriceSubmitter] PRICE_ORACLE_ADDRESS not set — price submissions disabled');
    }

    startHealthServer(oracle, resolver);
    notifyStartup().catch(() => {});

    const shutdown = () => {
        console.log('\n[Keeper] Shutting down...');
        oracle.stop();
        resolver.stop();
        setTimeout(() => process.exit(0), 1000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    console.log('[Keeper] Running. Press Ctrl+C to stop.');
}

main().catch((err: Error) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
