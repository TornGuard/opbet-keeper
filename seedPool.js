/**
 * Seed the FeeBet_Market pool with tokens (bankroll).
 * Deployer must run this to fund the pool before bets can be placed.
 *
 * Flow:
 *   1. increaseAllowance(market, amount)  — approve market to spend tokens
 *   2. seedPool(token, amount)            — deposit into pool
 *
 * Run:
 *   node keeper/seedPool.js                  — full flow (approve + seed)
 *   node keeper/seedPool.js --skip-approve   — skip approve, go straight to seedPool
 *   node keeper/seedPool.js --status         — just print balances/allowances, don't transact
 *
 * Env: SEED_TOKEN=opt1sq...  SEED_AMOUNT=500
 */

import { getContract, JSONRpcProvider, OP_20_ABI } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { Mnemonic, MLDSASecurityLevel, AddressTypes, Wallet } from '@btc-vision/transaction';
import { CONFIG } from './config.js';

const TOKEN_ADDRESS  = process.env.SEED_TOKEN  || 'opt1sqzkx6wm5acawl9m6nay2mjsm6wagv7gazcgtczds'; // MOTO
const DISPLAY_AMOUNT = parseFloat(process.env.SEED_AMOUNT || '500');
const DECIMALS = 18;

const SKIP_APPROVE = process.argv.includes('--skip-approve');
const STATUS_ONLY  = process.argv.includes('--status');

const SEED_POOL_ABI = [
  {
    name: 'seedPool',
    type: 'function',
    constant: false,
    inputs: [
      { name: 'token',  type: 'ADDRESS' },
      { name: 'amount', type: 'UINT256' },
    ],
    outputs: [{ name: 'success', type: 'BOOL' }],
  },
  {
    name: 'getPoolInfo',
    type: 'function',
    constant: true,
    inputs: [{ name: 'token', type: 'ADDRESS' }],
    outputs: [
      { name: 'totalPool',       type: 'UINT256' },
      { name: 'pendingExposure', type: 'UINT256' },
      { name: 'latestOracleFee', type: 'UINT256' },
    ],
  },
];

async function resolveAddr(provider, addrStr) {
  let resolved;
  try { resolved = await provider.getPublicKeyInfo(addrStr, true); } catch {}
  if (!resolved) {
    try { resolved = await provider.getPublicKeyInfo(addrStr, false); } catch {}
  }
  if (!resolved) throw new Error(`Cannot resolve address: ${addrStr}`);
  return resolved;
}

function toDisplay(units, dec = DECIMALS) {
  return (Number(units) / 10 ** dec).toFixed(4);
}

async function main() {
  const network = networks.opnetTestnet;
  const provider = new JSONRpcProvider({ url: CONFIG.rpcUrl, network });

  let wallet;
  if (CONFIG.mnemonic) {
    const mn = new Mnemonic(CONFIG.mnemonic, '', network, MLDSASecurityLevel.LEVEL2);
    wallet = mn.deriveOPWallet(AddressTypes.P2TR, 0);
  } else if (CONFIG.deployerWif) {
    wallet = Wallet.fromWif(CONFIG.deployerWif, network);
  } else {
    throw new Error('No MNEMONIC or DEPLOYER_WIF in config');
  }

  const amountUnits = BigInt(Math.round(DISPLAY_AMOUNT * 10 ** DECIMALS));

  console.log(`[seedPool] Wallet:  ${wallet.p2tr}`);
  console.log(`[seedPool] Market:  ${CONFIG.marketAddress}`);
  console.log(`[seedPool] Token:   ${TOKEN_ADDRESS}`);
  console.log('');

  const tokenAddr  = await resolveAddr(provider, TOKEN_ADDRESS);
  const marketAddr = await resolveAddr(provider, CONFIG.marketAddress);

  // ── Check BTC balance, MOTO balance, allowance, pool size ────────────────
  const tokenRead = getContract(TOKEN_ADDRESS, OP_20_ABI, provider, network);
  const marketRead = getContract(CONFIG.marketAddress, SEED_POOL_ABI, provider, network);

  const [balResult, allowResult, poolResult] = await Promise.all([
    tokenRead.balanceOf(wallet.address).catch(() => null),
    tokenRead.allowance(wallet.address, marketAddr).catch(() => null),
    marketRead.getPoolInfo(tokenAddr).catch(() => null),
  ]);

  const motoBalance   = balResult?.properties?.balance    ?? 0n;
  const motoAllowance = allowResult?.properties?.remaining ?? 0n;
  const poolTotal     = poolResult?.properties?.totalPool  ?? 0n;

  console.log(`[status] MOTO balance:    ${toDisplay(motoBalance)} MOTO`);
  console.log(`[status] MOTO allowance:  ${toDisplay(motoAllowance)} MOTO (approved to market)`);
  console.log(`[status] Pool (contract): ${toDisplay(poolTotal)} MOTO`);
  console.log('');

  if (STATUS_ONLY) return;

  if (motoBalance < amountUnits) {
    throw new Error(`Wallet has ${toDisplay(motoBalance)} MOTO but trying to seed ${DISPLAY_AMOUNT}. Lower SEED_AMOUNT.`);
  }

  console.log(`[seedPool] Seeding ${DISPLAY_AMOUNT} MOTO into pool...`);

  // ── Step 1: increaseAllowance (skip if already sufficient) ───────────────
  if (SKIP_APPROVE) {
    if (motoAllowance < amountUnits) {
      throw new Error(`--skip-approve used but allowance is only ${toDisplay(motoAllowance)} MOTO. Remove --skip-approve.`);
    }
    console.log('[seedPool] Skipping approval (existing allowance is sufficient).');
  } else {
    console.log('[seedPool] Step 1: approving market to spend tokens...');
    const tokenWrite = getContract(TOKEN_ADDRESS, OP_20_ABI, provider, network, wallet.address);
    const approveSim = await tokenWrite.increaseAllowance(marketAddr, amountUnits);
    if (approveSim.revert) throw new Error(`Approve simulation reverted: ${approveSim.revert}`);

    const approveReceipt = await approveSim.sendTransaction({
      signer: wallet.keypair,
      mldsaSigner: wallet.mldsaKeypair,
      refundTo: wallet.p2tr,
      maximumAllowedSatToSpend: 50000n,
      network,
    });
    console.log(`[seedPool] Approve TxID: ${approveReceipt.transactionId}`);
    console.log('[seedPool] Waiting for approval to confirm on-chain...');

    let confirmed = false;
    for (let i = 0; i < 72; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const receipt = await provider.getTransaction(approveReceipt.transactionId);
        if (receipt && (receipt.blockNumber || receipt.height)) {
          console.log(`[seedPool] Approval confirmed in block ${receipt.blockNumber || receipt.height}`);
          confirmed = true;
          break;
        }
      } catch {}
      if ((i + 1) % 6 === 0) console.log(`[seedPool] Still waiting... (${(i + 1) * 5}s)`);
    }
    if (!confirmed) throw new Error('Approval not confirmed after 6 minutes. Re-run with --skip-approve once tx confirms.');
  }

  // ── Step 2: seedPool ─────────────────────────────────────────────────────
  console.log('[seedPool] Step 2: seeding pool...');
  const marketWrite = getContract(CONFIG.marketAddress, SEED_POOL_ABI, provider, network, wallet.address);
  const seedSim = await marketWrite.seedPool(tokenAddr, amountUnits);
  if (seedSim.revert) throw new Error(`seedPool simulation reverted: ${seedSim.revert}`);

  const seedReceipt = await seedSim.sendTransaction({
    signer: wallet.keypair,
    mldsaSigner: wallet.mldsaKeypair,
    refundTo: wallet.p2tr,
    maximumAllowedSatToSpend: 50000n,
    network,
  });
  console.log(`[seedPool] Seed TxID: ${seedReceipt.transactionId}`);
  console.log(`[seedPool] Done! Pool seeded with ${DISPLAY_AMOUNT} MOTO.`);
  console.log(`[seedPool] New pool size will reflect after the tx confirms.`);
}

main().catch(err => {
  console.error('[seedPool] FAILED:', err.message);
  process.exit(1);
});
