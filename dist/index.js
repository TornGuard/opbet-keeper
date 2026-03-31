/**
 * OP-BET Keeper Bot
 *
 * 1. Oracle feed: Watches Bitcoin blocks, submits setBlockData to OPNet contract.
 * 2. Bet resolution: Scans active bets and resolves those with oracle data.
 * 3. Price submitter: Reads BlockFeed BTC/USD, submits to PriceOracle contract.
 */
import 'dotenv/config';
import http from 'http';
import https from 'https';
import dns from 'dns';
import { CONFIG } from './config.js';
import { MARKET_ABI, PRICE_ORACLE_ABI } from './abi.js';
import { OracleFeeder } from './oracle.js';
import { BetResolver } from './resolver.js';
import { PriceSubmitter } from './price-submitter.js';
import { initDb } from './db.js';
import { startHealthServer } from './health.js';
import { notifyStartup } from './telegram.js';
// ── Local IPv4 proxy ──────────────────────────────────────────────────────────
// opnet uses worker threads for fetch; main-thread undici patches don't
// propagate into workers. This proxy ensures all JSON-RPC calls use native
// https (IPv4) regardless of the worker's DNS resolver behaviour.
async function startProxy(targetHost) {
    const resolvedIp = await new Promise((res, rej) => dns.resolve4(targetHost, (err, addrs) => (err ? rej(err) : res(addrs[0]))));
    const server = http.createServer((req, proxyRes) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            const ur = https.request({
                host: resolvedIp, port: 443, path: req.url, method: req.method,
                servername: targetHost,
                headers: { ...req.headers, host: targetHost, 'content-length': Buffer.byteLength(body), 'accept-encoding': 'identity' },
            }, (us) => {
                let data = '';
                us.on('data', (c) => (data += c));
                us.on('end', () => { proxyRes.writeHead(us.statusCode ?? 200, { 'content-type': 'application/json' }); proxyRes.end(data); });
            });
            ur.on('error', () => { proxyRes.writeHead(502); proxyRes.end('{}'); });
            if (body)
                ur.write(body);
            ur.end();
        });
    });
    return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}
async function main() {
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
    const { networks } = await import('@btc-vision/bitcoin');
    const { Mnemonic, MLDSASecurityLevel, AddressTypes, Wallet } = await import('@btc-vision/transaction');
    const network = networks.opnetTestnet;
    // Start local proxy to work around IPv6/worker-thread fetch issues on testnet
    const remoteHost = CONFIG.rpcUrl.replace(/^https?:\/\//, '');
    const { server: proxyServer, port: proxyPort } = await startProxy(remoteHost);
    const provider = new JSONRpcProvider({ url: `http://127.0.0.1:${proxyPort}`, network });
    // Reconstruct wallet from mnemonic or WIF
    let wallet;
    if (CONFIG.mnemonic) {
        const m = new Mnemonic(CONFIG.mnemonic, '', network, MLDSASecurityLevel.LEVEL2);
        wallet = m.deriveOPWallet(AddressTypes.P2TR, 0);
        console.log(`  Keeper:   ${wallet.p2tr} (from mnemonic)`);
    }
    else {
        wallet = Wallet.fromWif(CONFIG.deployerWif, network);
        console.log(`  Keeper:   ${wallet.p2tr} (from WIF)`);
    }
    // Verify wallet has funds
    try {
        const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
        const totalSats = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
        console.log(`  Balance:  ${totalSats} sats (${utxos.length} UTXOs)`);
    }
    catch {
        console.log('  Balance:  (could not fetch)');
    }
    console.log('');
    // Market contract
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = getContract(CONFIG.marketAddress, MARKET_ABI, provider, network, wallet.address);
    // Health check
    try {
        const nextIdResult = await contract.getNextBetId();
        if (nextIdResult.revert) {
            console.error('  Contract health check FAILED: getNextBetId reverted');
            process.exit(1);
        }
        console.log(`  Next bet ID: ${nextIdResult.properties.nextBetId}`);
        console.log('  Contract: OK');
    }
    catch (err) {
        console.error(`  Contract health check FAILED: ${err.message}`);
        process.exit(1);
    }
    console.log('');
    const oracle = new OracleFeeder(contract, wallet, provider, network);
    oracle.start();
    const resolver = new BetResolver(contract, wallet, provider, network);
    resolver.oracle = oracle;
    resolver.start();
    if (CONFIG.priceOracleAddress) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const oracleContract = getContract(CONFIG.priceOracleAddress, PRICE_ORACLE_ABI, provider, network, wallet.address);
        try {
            const check = await oracleContract.isFeeder(wallet.address);
            if (check.revert || !check.properties?.authorized) {
                console.warn('[PriceSubmitter] Keeper wallet is NOT an authorized feeder — skipping price submissions');
            }
            else {
                console.log('[PriceSubmitter] Keeper is authorized feeder — starting');
                const priceSubmitter = new PriceSubmitter(oracleContract, wallet, provider, network);
                priceSubmitter.start();
            }
        }
        catch (err) {
            console.warn('[PriceSubmitter] Could not verify feeder status:', err.message);
        }
    }
    else {
        console.log('[PriceSubmitter] PRICE_ORACLE_ADDRESS not set — price submissions disabled');
    }
    startHealthServer(oracle, resolver);
    notifyStartup().catch(() => { });
    const shutdown = () => {
        console.log('\n[Keeper] Shutting down...');
        oracle.stop();
        resolver.stop();
        proxyServer.close();
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
//# sourceMappingURL=index.js.map