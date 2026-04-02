#!/usr/bin/env node
import { existsSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const ENV_TEMPLATE = `# BlockFeed Keeper — environment configuration
# Docs: https://www.blockfeed.online/docs#keeper-run

# ── Wallet (required) ────────────────────────────────────────────────
# BIP-39 mnemonic for your OPNet taproot wallet
MNEMONIC=

# ── Network ──────────────────────────────────────────────────────────
OPNET_RPC_URL=https://testnet.opnet.org
BLOCKFEED_API_URL=https://api.blockfeed.online
NETWORK=testnet

# ── Oracle contract ──────────────────────────────────────────────────
PRICE_ORACLE_ADDRESS=opt1sqr75dzhu58h5rchnppyteptgdpvkdpyc6qf64d4q

# ── Database (required) ──────────────────────────────────────────────
# Neon PostgreSQL connection string
DATABASE_URL=

# ── Optional ─────────────────────────────────────────────────────────
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
# FEE_RATE=2
`;

const [,, command] = process.argv;

if (command === 'init') {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    console.log('.env already exists — skipping.');
  } else {
    writeFileSync(envPath, ENV_TEMPLATE);
    console.log('.env created. Fill in your MNEMONIC and DATABASE_URL then run: blockfeed-keeper start');
  }
  process.exit(0);
}

if (command === 'start') {
  // Load .env from cwd so users can run from any directory
  const dotenvPath = resolve(process.cwd(), '.env');
  if (existsSync(dotenvPath)) {
    const { config } = await import('dotenv');
    config({ path: dotenvPath });
  }
  await import('../dist/index.js');
  process.exit(0);
}

console.log(`
blockfeed-keeper — OPNet oracle keeper

Usage:
  blockfeed-keeper init     Generate .env config template
  blockfeed-keeper start    Start the keeper (default)

Docs: https://www.blockfeed.online/docs#keeper-run
`);
process.exit(0);
