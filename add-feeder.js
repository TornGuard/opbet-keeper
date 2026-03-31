/**
 * add-feeder.js
 *
 * Registers a wallet as an authorized feeder on the deployed PriceOracle.
 *
 * Usage:
 *   node add-feeder.js                        -- add the keeper wallet itself
 *   node add-feeder.js <opt1...feeder_addr>   -- add a different address
 */

import 'dotenv/config';
import http from 'http';
import https from 'https';
import dns from 'dns';

// ── Local IPv4 proxy (same pattern as deploy-oracle.js) ──────────────────────
async function startProxy(targetHost) {
  const resolvedIp = await new Promise((res, rej) =>
    dns.resolve4(targetHost, (err, addrs) => (err ? rej(err) : res(addrs[0])))
  );
  const server = http.createServer((req, proxyRes) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const ur = https.request({
        host: resolvedIp, port: 443, path: req.url, method: req.method,
        servername: targetHost,
        headers: { ...req.headers, host: targetHost, 'content-length': Buffer.byteLength(body), 'accept-encoding': 'identity' },
      }, (us) => {
        let data = ''; us.on('data', c => (data += c));
        us.on('end', () => { proxyRes.writeHead(us.statusCode, { 'content-type': 'application/json' }); proxyRes.end(data); });
      });
      ur.on('error', () => { proxyRes.writeHead(502); proxyRes.end('{}'); });
      if (body) ur.write(body);
      ur.end();
    });
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}

// ── Imports ──────────────────────────────────────────────────────────────────
const { Mnemonic, MLDSASecurityLevel, AddressTypes, Address } =
  await import('@btc-vision/transaction');
const { getContract, JSONRpcProvider } = await import('opnet');
const { networks } = await import('@btc-vision/bitcoin');

const NETWORK = networks.opnetTestnet;
const ORACLE  = process.env.PRICE_ORACLE_ADDRESS;
const REMOTE  = (process.env.OPNET_RPC_URL || 'https://testnet.opnet.org').replace(/^https?:\/\//, '');

if (!ORACLE) { console.error('PRICE_ORACLE_ADDRESS not set in .env'); process.exit(1); }

const { server, port } = await startProxy(REMOTE);
const provider = new JSONRpcProvider({ url: `http://127.0.0.1:${port}`, network: NETWORK });

const m = new Mnemonic(process.env.MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet = m.deriveOPWallet(AddressTypes.P2TR, 0);

// For now: always register the keeper wallet itself as feeder.
// The opnet Address requires ML-DSA public key context, so only the
// currently loaded wallet can be added without an extra lookup.
const feederAddress = wallet.address;
const feederStr = wallet.p2tr;

console.log(`\nOracle:  ${ORACLE}`);
console.log(`Signer:  ${wallet.p2tr}`);
console.log(`Feeder:  ${feederStr}\n`);

// ── ABI ───────────────────────────────────────────────────────────────────────
const ABI = [
  {
    name: 'addFeeder', type: 'function', constant: false,
    inputs:  [{ name: 'feeder', type: 'ADDRESS' }],
    outputs: [{ name: 'success', type: 'BOOL' }],
  },
];

const oracleContract = getContract(ORACLE, ABI, provider, NETWORK, wallet.address);

try {
  console.log('Simulating addFeeder...');
  const simulation = await oracleContract.addFeeder(feederAddress);

  if (!simulation || simulation.error) {
    console.error('Simulation failed:', simulation?.error ?? 'no result');
    process.exit(1);
  }
  if (simulation.revert) {
    console.error('Simulation reverted:', simulation.revert);
    process.exit(1);
  }
  console.log('Simulation OK — sending TX...');

  const challenge = await provider.getChallenge();
  const receipt = await simulation.sendTransaction({
    signer:                   wallet.keypair,
    mldsaSigner:              wallet.mldsaKeypair,
    refundTo:                 wallet.p2tr,
    maximumAllowedSatToSpend: 100_000n,
    network:                  NETWORK,
    feeRate:                  Number(process.env.FEE_RATE) || 10,
    challenge,
  });

  const txId = receipt?.transactionId ?? receipt?.txid ?? JSON.stringify(receipt).slice(0, 120);
  console.log(`\nFeeder added! TX: ${txId}`);
  console.log(`\nNext: restart the keeper to begin submitting prices.`);
} catch (e) {
  console.error('Error:', e.message || e);
} finally {
  server.close();
}
