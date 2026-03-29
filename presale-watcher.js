/**
 * presale-watcher.js — OPBETRaise on-chain event monitor
 *
 * Polls OPBETRaise block-by-block for:
 *   - RaisePurchase  → notifyMint()
 *   - AirdropRegistered → notifyClaim()
 *
 * Saves last processed block to presale-watcher-state.json to survive restarts.
 *
 * Usage:
 *   node keeper/presale-watcher.js              # testnet
 *   IS_MAINNET=1 node keeper/presale-watcher.js # mainnet
 *
 * Env vars (same .env as keeper):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSONRpcProvider } from 'opnet';
import { networks } from '@btc-vision/bitcoin';
import { notifyMint, notifyClaim } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const IS_MAINNET = process.env.IS_MAINNET === '1' || process.env.IS_MAINNET === 'true';

const CHAIN = IS_MAINNET
    ? {
          network:    networks.bitcoin,
          rpcUrl:     'https://api.opnet.org',
          raiseAddr:  'op1sqqm984mvw0449h5lds2wyena0879gnf5nse0e2d5',
      }
    : {
          network:    networks.opnetTestnet,
          rpcUrl:     'https://testnet.opnet.org',
          raiseAddr:  'opt1sqzqgqfeym66fswr0hdm5ek9dgwlcw34yg5adgx0f',
      };

const POLL_INTERVAL_MS = 15_000;   // 15 s — roughly one OPNet block
const STATE_FILE       = path.join(__dirname, 'presale-watcher-state.json');

// ─── State persistence ────────────────────────────────────────────────────────

function loadState() {
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Event decoders ───────────────────────────────────────────────────────────

/**
 * Decode RaisePurchase event data.
 * Layout: buyer(32) | satsPaid(32) | opbetOwed(32)  → 96 bytes total
 */
function decodeRaisePurchase(data) {
    let buf;
    if (Buffer.isBuffer(data))          buf = data;
    else if (data instanceof Uint8Array) buf = Buffer.from(data);
    else if (typeof data === 'object' && '0' in data) buf = Buffer.from(Object.values(data));
    else if (typeof data === 'string')  buf = Buffer.from(data, 'base64');
    else return null;

    if (buf.length < 96) return null;

    return {
        buyer:     '0x' + buf.slice(0,  32).toString('hex'),
        satsPaid:  BigInt('0x' + buf.slice(32, 64).toString('hex')),
        opbetOwed: BigInt('0x' + buf.slice(64, 96).toString('hex')),
    };
}

/**
 * Decode AirdropRegistered event data.
 * Layout: claimant(32) | amount(32)  → 64 bytes total
 */
function decodeAirdropRegistered(data) {
    let buf;
    if (Buffer.isBuffer(data))          buf = data;
    else if (data instanceof Uint8Array) buf = Buffer.from(data);
    else if (typeof data === 'object' && '0' in data) buf = Buffer.from(Object.values(data));
    else if (typeof data === 'string')  buf = Buffer.from(data, 'base64');
    else return null;

    if (buf.length < 64) return null;

    return {
        claimant: '0x' + buf.slice(0,  32).toString('hex'),
        amount:   BigInt('0x' + buf.slice(32, 64).toString('hex')),
    };
}

// ─── Block scanner ────────────────────────────────────────────────────────────

async function scanBlock(provider, blockHeight) {
    let block;
    try {
        block = await provider.getBlock(blockHeight, true);
    } catch (e) {
        console.warn(`  [watcher] getBlock(${blockHeight}) error: ${e.message}`);
        return false;
    }

    if (!block) return false; // not yet indexed

    const txs = block.transactions ?? [];
    let found = 0;

    for (const tx of txs) {
        // Events are keyed by contract address
        const raiseEvents = tx.events?.[CHAIN.raiseAddr] ?? [];

        for (const ev of raiseEvents) {
            if (ev.type === 'RaisePurchase') {
                const decoded = decodeRaisePurchase(ev.data);
                if (decoded) {
                    console.log(`  [watcher] RaisePurchase  block=${blockHeight} txid=${tx.id?.slice(0,16)}…`);
                    await notifyMint({
                        txid:        tx.id,
                        buyer:       decoded.buyer,
                        satsPaid:    decoded.satsPaid,
                        opbetOwed:   decoded.opbetOwed,
                        blockHeight,
                        isMainnet:   IS_MAINNET,
                    }).catch(e => console.warn('  [watcher] notifyMint error:', e.message));
                    found++;
                }
            } else if (ev.type === 'AirdropRegistered') {
                const decoded = decodeAirdropRegistered(ev.data);
                if (decoded) {
                    console.log(`  [watcher] AirdropRegistered block=${blockHeight} txid=${tx.id?.slice(0,16)}…`);
                    await notifyClaim({
                        txid:        tx.id,
                        claimant:    decoded.claimant,
                        amount:      decoded.amount,
                        blockHeight,
                        isMainnet:   IS_MAINNET,
                    }).catch(e => console.warn('  [watcher] notifyClaim error:', e.message));
                    found++;
                }
            }
        }
    }

    return true; // block was found and processed
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main() {
    const net = IS_MAINNET ? 'MAINNET' : 'TESTNET';
    console.log('══════════════════════════════════════════════════════');
    console.log(` OPBETRaise Presale Watcher — ${net}`);
    console.log(` Contract: ${CHAIN.raiseAddr}`);
    console.log('══════════════════════════════════════════════════════');

    const provider = new JSONRpcProvider({ url: CHAIN.rpcUrl, network: CHAIN.network });
    const stateKey = IS_MAINNET ? 'mainnet' : 'testnet';
    const state    = loadState();

    // Determine starting block
    let nextBlock = state[stateKey]?.nextBlock ?? null;

    if (nextBlock === null) {
        // First run: start from current tip
        try {
            const info = await provider.getBlockNumber();
            nextBlock  = Number(info);
            console.log(`First run — starting from current tip: block ${nextBlock}`);
        } catch (e) {
            console.error('Could not fetch block number:', e.message);
            process.exit(1);
        }
    } else {
        console.log(`Resuming from block ${nextBlock}`);
    }

    // Persist start block immediately
    if (!state[stateKey]) state[stateKey] = {};
    state[stateKey].nextBlock = nextBlock;
    saveState(state);

    process.on('SIGINT',  () => { console.log('\nStopping watcher…'); process.exit(0); });
    process.on('SIGTERM', () => { console.log('\nStopping watcher…'); process.exit(0); });

    while (true) {
        // Fetch current tip
        let tip;
        try {
            tip = Number(await provider.getBlockNumber());
        } catch (e) {
            console.warn(`[watcher] getBlockNumber error: ${e.message} — retrying in ${POLL_INTERVAL_MS / 1000}s`);
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        if (nextBlock > tip) {
            process.stdout.write(`[watcher] At tip (block ${tip}) — waiting…\r`);
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        // Catch up block by block (up to 20 at once to avoid hammering RPC)
        const batch = Math.min(tip - nextBlock + 1, 20);
        for (let i = 0; i < batch; i++) {
            const height = nextBlock + i;
            process.stdout.write(`[watcher] Scanning block ${height} / ${tip}…\r`);

            const ok = await scanBlock(provider, height);
            if (!ok) {
                // Block not yet indexed — stop and retry next poll
                console.log(`\n[watcher] Block ${height} not yet indexed — retrying`);
                break;
            }

            state[stateKey].nextBlock = height + 1;
            nextBlock = height + 1;
        }

        saveState(state);

        if (nextBlock <= tip) {
            // Still catching up — no wait
        } else {
            await sleep(POLL_INTERVAL_MS);
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    console.error('\nFatal:', err.message || err);
    process.exit(1);
});
