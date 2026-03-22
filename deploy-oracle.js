/**
 * PriceOracle Deployment Script
 *
 * Deploys contracts/oracle/build/PriceOracle.wasm to OPNet testnet.
 * The deployer wallet is automatically registered as the first authorized feeder.
 *
 * Usage:
 *   node deploy-oracle.js            -- deploy and print contract address
 *   node deploy-oracle.js balance    -- check wallet balance only
 *
 * After deployment:
 *   1. Copy the printed contract address
 *   2. Set PRICE_ORACLE_ADDRESS=<address> in the keeper .env
 *   3. Restart the keeper — it will begin submitting prices automatically
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { Mnemonic, MLDSASecurityLevel, AddressTypes, TransactionFactory, BinaryWriter } =
  await import('@btc-vision/transaction');
const { JSONRpcProvider } = await import('opnet');
const { networks } = await import('@btc-vision/bitcoin');

// ── Config ──────────────────────────────────────────────────────────────────
const NETWORK    = networks.opnetTestnet;
const RPC_URL    = process.env.OPNET_RPC_URL || 'https://testnet.opnet.org';
const FEE_RATE   = Number(process.env.FEE_RATE) || 5;
const GAS_SAT_FEE = 10_000n;

const WASM_PATH = resolve(__dirname, '../contracts/oracle/build/PriceOracle.wasm');

// ── Wallet ───────────────────────────────────────────────────────────────────
function getWallet() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) throw new Error('MNEMONIC not set in .env');
  const m = new Mnemonic(mnemonic, '', NETWORK, MLDSASecurityLevel.LEVEL2);
  return m.deriveOPWallet(AddressTypes.P2TR, 0);
}

// ── Provider ─────────────────────────────────────────────────────────────────
function getProvider() {
  return new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
}

// ── Balance check ─────────────────────────────────────────────────────────────
async function checkBalance(wallet, provider) {
  const utxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
  let total = 0n;
  for (const u of utxos) total += BigInt(u.value);
  console.log(`Address : ${wallet.p2tr}`);
  console.log(`UTXOs   : ${utxos.length}`);
  console.log(`Balance : ${total} sats (${(Number(total) / 1e8).toFixed(8)} tBTC)`);
  return { utxos, total };
}

// ── Deploy ────────────────────────────────────────────────────────────────────
async function deploy() {
  if (!existsSync(WASM_PATH)) {
    console.error(`WASM not found: ${WASM_PATH}`);
    console.error('Run:  cd contracts/oracle && npm run build');
    process.exit(1);
  }

  const wallet   = getWallet();
  const provider = getProvider();

  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║    PriceOracle Deployment             ║');
  console.log('  ║    OPNet Testnet                      ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');

  const { utxos, total } = await checkBalance(wallet, provider);
  console.log('');

  if (total < 50_000n) {
    console.error('Insufficient balance — need at least 50 000 sats (0.0005 tBTC)');
    console.error('Fund your wallet at the OPNet testnet faucet and try again.');
    process.exit(1);
  }

  const bytecode = new Uint8Array(readFileSync(WASM_PATH));
  console.log(`WASM    : ${WASM_PATH}`);
  console.log(`Size    : ${bytecode.length} bytes`);
  console.log(`Fee rate: ${FEE_RATE} sat/vB`);
  console.log('');

  // PriceOracle.onDeployment() reads Blockchain.tx.sender — no calldata needed
  const calldata = new BinaryWriter().getBuffer();

  const challenge = await provider.getChallenge();
  console.log('Challenge obtained');

  const factory = new TransactionFactory();
  const params = {
    from:                       wallet.p2tr,
    utxos,
    signer:                     wallet.keypair,
    mldsaSigner:                wallet.mldsaKeypair,
    network:                    NETWORK,
    feeRate:                    FEE_RATE,
    priorityFee:                0n,
    gasSatFee:                  GAS_SAT_FEE,
    bytecode,
    calldata,
    challenge,
    linkMLDSAPublicKeyToAddress: true,
    revealMLDSAPublicKey:        true,
  };

  console.log('Signing deployment...');
  const deployment = await factory.signDeployment(params);

  console.log('');
  console.log(`Contract address: ${deployment.contractAddress}`);
  console.log('');

  // Broadcast funding TX
  console.log('Broadcasting funding TX...');
  const fundingResult = await provider.sendRawTransaction(deployment.transaction[0]);
  console.log('Funding TX:', fundingResult.txid || JSON.stringify(fundingResult).slice(0, 100));

  // Broadcast reveal TX
  console.log('Broadcasting reveal TX...');
  const revealResult = await provider.sendRawTransaction(deployment.transaction[1]);
  console.log('Reveal TX:', revealResult.txid || JSON.stringify(revealResult).slice(0, 100));

  console.log('');
  console.log('Waiting for confirmation (15s)...');
  await sleep(15_000);

  // Verify
  try {
    const revealTxId = revealResult.txid || '';
    if (revealTxId) {
      const tx = await provider.getTransaction(revealTxId);
      if (tx && !tx.failed) {
        console.log('Verification: confirmed on chain');
      } else {
        console.log('Verification: pending (may take a few blocks)');
      }
    }
  } catch {
    console.log('Verification: pending (may take a few blocks)');
  }

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log('  Deployment complete!');
  console.log('');
  console.log(`  Contract: ${deployment.contractAddress}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`  1. Add to keeper .env:`);
  console.log(`       PRICE_ORACLE_ADDRESS=${deployment.contractAddress}`);
  console.log(`       BLOCKFEED_API_URL=https://your-blockfeed-host`);
  console.log('  2. Restart the keeper');
  console.log('══════════════════════════════════════════════');
  console.log('');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Entry point ───────────────────────────────────────────────────────────────
const command = process.argv[2];

if (command === 'balance') {
  const wallet   = getWallet();
  const provider = getProvider();
  checkBalance(wallet, provider).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
} else {
  deploy().catch(err => {
    console.error('Deployment failed:', err.message || err);
    process.exit(1);
  });
}
