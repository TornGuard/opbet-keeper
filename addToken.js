/**
 * One-time admin script — whitelist a new OP20 token in the FeeBet_Market contract.
 * Run: node keeper/addToken.js
 */

import { getContract, JSONRpcProvider } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { Mnemonic, MLDSASecurityLevel, AddressTypes, Wallet } from '@btc-vision/transaction';
import { CONFIG } from './config.js';

const MARKET_ADDRESS = CONFIG.marketAddress;
const TOKEN_ADDRESS  = 'opt1sqzkx6wm5acawl9m6nay2mjsm6wagv7gazcgtczds'; // MOTO

const ADD_TOKEN_ABI = [
  {
    name: 'addAcceptedToken',
    type: 'function',
    constant: false,
    inputs: [{ name: 'token', type: 'ADDRESS' }],
    outputs: [{ name: 'success', type: 'BOOL' }],
  },
  {
    name: 'isTokenAccepted',
    type: 'function',
    constant: true,
    inputs: [{ name: 'token', type: 'ADDRESS' }],
    outputs: [{ name: 'accepted', type: 'BOOL' }],
  },
];

async function main() {
  const network = networks.opnetTestnet;
  const provider = new JSONRpcProvider({ url: CONFIG.rpcUrl, network });

  // Load wallet — same pattern as keeper/index.js
  let wallet;
  if (CONFIG.mnemonic) {
    const mn = new Mnemonic(CONFIG.mnemonic, '', network, MLDSASecurityLevel.LEVEL2);
    wallet = mn.deriveOPWallet(AddressTypes.P2TR, 0);
  } else if (CONFIG.deployerWif) {
    wallet = Wallet.fromWif(CONFIG.deployerWif, network);
  } else {
    throw new Error('No MNEMONIC or DEPLOYER_WIF in config');
  }

  const senderAddress = wallet.address;
  console.log(`[addToken] Wallet:  ${wallet.p2tr}`);
  console.log(`[addToken] Market:  ${MARKET_ADDRESS}`);
  console.log(`[addToken] Token:   ${TOKEN_ADDRESS}`);

  // Resolve token address string → Address object (required by OPNet SDK)
  let tokenAddr;
  try {
    tokenAddr = await provider.getPublicKeyInfo(TOKEN_ADDRESS, true);
  } catch {
    tokenAddr = await provider.getPublicKeyInfo(TOKEN_ADDRESS, false);
  }
  if (!tokenAddr) throw new Error(`Could not resolve token address: ${TOKEN_ADDRESS}`);
  console.log(`[addToken] Token resolved: ${tokenAddr.toHex?.().slice(0, 20)}...`);

  // Read-only check first
  const readContract = getContract(MARKET_ADDRESS, ADD_TOKEN_ABI, provider, network);
  const checkResult = await readContract.isTokenAccepted(tokenAddr);
  if (checkResult.properties?.accepted) {
    console.log('[addToken] Token is already accepted. Nothing to do.');
    return;
  }

  console.log('[addToken] Token not yet whitelisted — calling addAcceptedToken...');

  // Write contract with sender
  const writeContract = getContract(MARKET_ADDRESS, ADD_TOKEN_ABI, provider, network, senderAddress);
  const simulation = await writeContract.addAcceptedToken(tokenAddr);
  if (simulation.revert) {
    console.error('[addToken] Simulation reverted:', simulation.revert);
    process.exit(1);
  }

  console.log('[addToken] Simulation OK — sending transaction...');
  const receipt = await simulation.sendTransaction({
    signer: wallet.keypair,
    mldsaSigner: wallet.mldsaKeypair,
    refundTo: wallet.p2tr,
    maximumAllowedSatToSpend: 50000n,
    network,
  });

  console.log(`[addToken] Done! TxID: ${receipt.transactionId}`);
  console.log('[addToken] MOTO token is now whitelisted in FeeBet_Market.');
}

main().catch(err => {
  console.error('[addToken] FAILED:', err.message);
  process.exit(1);
});
