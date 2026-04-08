/**
 * Telegram notifier for OP-BET Keeper.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable.
 */

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_URL  = 'https://www.op-bet.xyz/';
const MINT_URL = 'https://mint.op-bet.xyz/';

// Custom emoji IDs (Telegram Premium)
const EMOJI = {
  money:  '5280862672131204613', // 💰
  fire:   '6048796704327606386', // 🔥
  over:   '5461022613029526739', // 🔼
  under:  '5461074294370999997', // 🔽
  globe:  '5280658777148760247', // 🌐
  coin:   '5197368799954738967', // 🪙
  moto:   '6190296832845814946', // 🔥 (MOTO token)
};

if (TOKEN && CHAT_ID) {
  console.log(`[Telegram] ✅ Bot configured — chat ${CHAT_ID}`);
} else {
  console.warn('[Telegram] ⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notifications disabled');
}

// Returns UTF-16 length (Telegram uses UTF-16 offsets)
function u16len(s) {
  let len = 0;
  for (const c of s) len += c.codePointAt(0) > 0xFFFF ? 2 : 1;
  return len;
}

// Fluent message builder — produces { text, entities } for Telegram API
class Msg {
  constructor() { this.text = ''; this.entities = []; }

  get _off() { return u16len(this.text); }

  plain(s)  { this.text += s; return this; }
  nl(n = 1) { this.text += '\n'.repeat(n); return this; }

  bold(s) {
    const o = this._off;
    this.text += s;
    this.entities.push({ type: 'bold', offset: o, length: u16len(s) });
    return this;
  }

  italic(s) {
    const o = this._off;
    this.text += s;
    this.entities.push({ type: 'italic', offset: o, length: u16len(s) });
    return this;
  }

  code(s) {
    const o = this._off;
    this.text += s;
    this.entities.push({ type: 'code', offset: o, length: u16len(s) });
    return this;
  }

  link(label, url) {
    const o = this._off;
    this.text += label;
    this.entities.push({ type: 'text_link', offset: o, length: u16len(label), url });
    return this;
  }

  emoji(base, id) {
    const o = this._off;
    this.text += base;
    this.entities.push({ type: 'custom_emoji', offset: o, length: u16len(base), custom_emoji_id: id });
    return this;
  }

  build() { return { text: this.text, entities: this.entities }; }
}

// ── Rate limiter: max 1 message per 1.5s to stay under Telegram's 30/min cap ─
let _lastSendTime = 0;
const _sendQueue  = [];
let   _sendBusy   = false;

async function _drainQueue() {
  if (_sendBusy) return;
  _sendBusy = true;
  while (_sendQueue.length > 0) {
    const now  = Date.now();
    const wait = Math.max(0, _lastSendTime + 1500 - now);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const job = _sendQueue.shift();
    _lastSendTime = Date.now();
    try {
      const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text:    job.text,
          entities: job.entities,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) console.warn('[Telegram] Send failed:', await res.text());
      else         console.log('[Telegram] ✅ Sent OK');
    } catch (err) {
      console.warn('[Telegram] Failed:', err.message);
    }
  }
  _sendBusy = false;
}

async function sendMessage({ text, entities }) {
  if (!TOKEN || !CHAT_ID) return;
  console.log('[Telegram] Queuing:', text.slice(0, 80).replace(/\n/g, ' '));
  _sendQueue.push({ text, entities });
  _drainQueue();
}

// ── Entry-notification batcher: collects bets for 8s then sends once ─────────
let _entryBatch   = [];
let _entryTimer   = null;
const ENTRY_BATCH_MS = 8_000;

async function _flushEntryBatch() {
  _entryTimer = null;
  const batch = _entryBatch.splice(0);
  if (batch.length === 0) return;

  if (batch.length === 1) {
    // Single bet — send the full rich notification
    await _sendEntryFull(batch[0]);
    return;
  }

  // Multiple bets in quick succession — compact summary to avoid spam
  const total  = batch.reduce((s, b) => s + (Number(b.amount || 0) / 1e18), 0);
  const sym    = batch[0].tokenSymbol ? `$${batch[0].tokenSymbol}` : '$MOTO';
  const msg    = new Msg()
    .plain('🟢 ').bold(`${batch.length} new bets placed`)
    .nl(2);

  for (const b of batch) {
    const who  = shortWallet(b.wallet);
    const amt  = b.amount ? (Number(b.amount) / 1e18).toFixed(0) : '?';
    const bet  = b.betType ? decodeBet(b.betType, b.param1, b.param2) : null;
    const desc = bet ? (bet.threshold ? `${bet.dir?.toUpperCase()} ${bet.threshold} sat/vB` : bet.label || bet.type) : '—';
    msg.plain(`  · `).code(who).plain(`  ${desc}  `).bold(`${amt} ${sym}`).nl();
  }

  msg.nl()
    .italic(`Total volume: ${total.toFixed(0)} ${sym}`)
    .nl(2)
    .plain('🌐 ').link('Bet Now', APP_URL);

  await sendMessage(msg.build());
}

// The full rich single-entry message (extracted from notifyEntry)
async function _sendEntryFull({ betId, wallet, txId, betType, param1, param2, amount, endBlock, tokenSymbol }) {
  const who       = shortWallet(wallet);
  const symbol    = tokenSymbol ? `$${tokenSymbol}` : '$MOTO';
  const coinEmoji = (symbol === '$MOTO') ? { base: '🔥', id: EMOJI.moto } : { base: '🪙', id: EMOJI.coin };
  const amtNum    = amount ? (Number(amount) / 1e18).toFixed(2) : null;
  const txUrl     = txId ? `https://opscan.org/transactions/${txId}?network=op_testnet` : null;
  const bet       = betType ? decodeBet(betType, param1, param2) : null;

  const msg = new Msg()
    .plain('🟢 ').bold('New Bet Placed!')
    .plain('  Bet ').bold(`#${betId}`)
    .nl(2)
    .plain('👤 ').code(who)
    .nl();

  if (bet) {
    if (bet.type === 'OVER/UNDER' && bet.dir && bet.threshold) {
      const dirKey  = bet.dir === 'over' ? 'over' : 'under';
      const dirBase = bet.dir === 'over' ? '🔼' : '🔽';
      msg.emoji(dirBase, EMOJI[dirKey]).plain(' ').bold(`${bet.dir.toUpperCase()} ${bet.threshold} sat/vB`).nl();
    } else if (bet.type === 'TREND' && bet.dir) {
      const dirKey  = bet.dir === 'over' ? 'over' : 'under';
      const dirBase = bet.dir === 'over' ? '🔼' : '🔽';
      msg.emoji(dirBase, EMOJI[dirKey]).plain(' ').bold(bet.label).nl();
    } else if (bet.label) {
      msg.plain(`📊 `).bold(`${bet.type}: `).plain(bet.label).nl();
    }
  }

  if (amtNum) {
    msg.emoji(coinEmoji.base, coinEmoji.id).plain(' ').bold(`${amtNum} ${symbol}`).nl();
  }

  if (endBlock) {
    msg.plain('⏳ Resolves at block ').bold(`#${endBlock}`).nl();
  }

  msg.nl();
  if (txUrl) {
    msg.plain('🔥 ').link('View Tx', txUrl).plain('  ·  ');
  }
  msg.plain('🌐 ').link('Place Your Bet', APP_URL);

  await sendMessage(msg.build());
}

function shortWallet(wallet) {
  if (!wallet) return 'anon';
  return `${wallet.slice(0, 10)}...${wallet.slice(-4)}`;
}

// Decode human-readable bet description from betType + params
function decodeBet(betType, param1, param2) {
  const bt = Number(betType);
  const p1 = Number(param1);
  const p2 = Number(param2);
  switch (bt) {
    case 1: { // OVER_UNDER
      const dir  = p1 === 1 ? 'over' : 'under';
      const thr  = p2 ? (p2 / 100).toFixed(1) : null;
      return { type: 'OVER/UNDER', dir, threshold: thr };
    }
    case 2: { // EXACT
      const fee = (p1 / 100).toFixed(2);
      return { type: 'EXACT', label: `Exact ${fee} sat/vB` };
    }
    case 3: { // TREND
      const dir = p1 === 1 ? 'UP' : 'DOWN';
      return { type: 'TREND', label: `Fees ${dir}`, dir: p1 === 1 ? 'over' : 'under' };
    }
    case 4: { // MEMPOOL
      const opts = { 1: 'Over 15K (+6 blocks)', 2: 'Under 10K (+6 blocks)', 3: 'Over 20K (+12 blocks)', 4: 'Under 5K (+12 blocks)' };
      return { type: 'MEMPOOL', label: opts[p1] || `Option ${p1}` };
    }
    case 5: { // BLOCKTIME
      const opts = { 1: '< 5 min', 2: '5–10 min', 3: '10–20 min', 4: '20+ min' };
      return { type: 'BLOCKTIME', label: `Block in ${opts[p1] || p1}` };
    }
    case 6: { // SPIKE
      const opts = { 1: '50+ sat/vB', 2: '100+ sat/vB', 3: '200+ sat/vB', 4: '500+ sat/vB' };
      return { type: 'SPIKE', label: `Fee spike ${opts[p1] || p1}` };
    }
    default:
      return { type: `Type ${bt}`, label: `Param ${p1}` };
  }
}

/**
 * Startup ping — confirms bot is reachable.
 */
export async function notifyStartup() {
  if (!TOKEN || !CHAT_ID) return;
  console.log('[Telegram] Sending startup ping...');
  const msg = new Msg()
    .plain('🟢 ').bold('OP-BET Keeper started')
    .nl()
    .italic('Notifications active.')
    .build();
  await sendMessage(msg);
}

/**
 * New bet placed — batched to prevent spam when multiple bets arrive at once.
 */
export async function notifyEntry(params) {
  console.log(`[Telegram] notifyEntry #${params.betId} wallet=${params.wallet || 'anon'}`);
  _entryBatch.push(params);
  if (!_entryTimer) {
    _entryTimer = setTimeout(_flushEntryBatch, ENTRY_BATCH_MS);
  }
}

/**
 * Bet won.
 */
export async function notifyWin({ betId, wallet, payout, direction, threshold, tokenSymbol }) {
  const payoutNum = Number(payout) / 1e18;
  if (payoutNum < 1) return;

  const symbol     = tokenSymbol ? `$${tokenSymbol}` : '$MOTO';
  const coinEmoji  = (symbol === '$MOTO') ? { base: '🔥', id: EMOJI.moto } : { base: '🪙', id: EMOJI.coin };
  const payoutStr  = payoutNum >= 1000
    ? `${(payoutNum / 1000).toFixed(1)}k ${symbol}`
    : `${payoutNum.toFixed(2)} ${symbol}`;

  const who   = shortWallet(wallet);
  const isBig = payoutNum >= 500;

  const msg = new Msg();

  if (isBig) {
    msg.emoji('💰', EMOJI.money).plain(' ').bold('BIG WIN!').plain(' 🚀  Bet ').bold(`#${betId}`);
  } else {
    msg.plain('🎉 ').bold('Winner!').plain('  Bet ').bold(`#${betId}`);
  }

  msg.nl(2).plain('👤 ').code(who).nl();

  if (direction && threshold) {
    const dirKey  = direction === 'over' ? 'over' : 'under';
    const dirBase = direction === 'over' ? '🔼' : '🔽';
    msg.emoji(dirBase, EMOJI[dirKey]).plain(' ').bold(`${direction.toUpperCase()} ${threshold} sat/vB`).nl();
  }

  msg.emoji(coinEmoji.base, coinEmoji.id).plain(' Payout: ').bold(payoutStr).nl(2);

  msg.plain('🌐 ').link('Place Your Bet', APP_URL);
  msg.nl(2).italic('🧪 OPNet Testnet — transactions are not real value');

  await sendMessage(msg.build());
}

/**
 * Presale mint recorded on-chain (RaisePurchase event).
 * @param {object} p
 * @param {string} p.txid        - Bitcoin TXID
 * @param {string} p.buyer       - buyer address (hex or p2tr)
 * @param {bigint} p.satsPaid    - sats the buyer sent
 * @param {bigint} p.opbetOwed   - OPBET allocated (18-decimal)
 * @param {boolean} [p.isMainnet]
 */
export async function notifyMint({ txid, buyer, satsPaid, opbetOwed, blockHeight, isMainnet = false }) {
  const who    = buyer    ? `${buyer.slice(0, 10)}...${buyer.slice(-4)}` : 'anon';
  const opbet  = opbetOwed ? (Number(opbetOwed) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '?';
  const btc    = satsPaid  ? (Number(satsPaid)  / 1e8 ).toFixed(6) : '?';
  const txUrl = txid
    ? isMainnet
      ? `https://opscan.org/transactions/${txid}`
      : `https://opscan.org/transactions/${txid}?network=op_testnet`
    : null;

  const msg = new Msg()
    .plain('🟢 ').bold('New Mint!')
    .nl(2)
    .plain('👤 ').code(who).nl()
    .emoji('💰', EMOJI.money).plain(' ').bold(`${btc} BTC`).plain(' paid').nl()
    .emoji('🪙', EMOJI.coin).plain(' ').bold(`${opbet} $OPBET`).plain(' owed').nl(2);

  if (txUrl) {
    msg.plain('🔥 ').link('View on OPScan', txUrl).nl();
  }
  msg.plain('🌐 ').link('mint.op-bet.xyz', MINT_URL);

  await sendMessage(msg.build());
}

/**
 * Airdrop claim registered on-chain (AirdropRegistered event).
 * @param {object} p
 * @param {string} p.txid        - Bitcoin TXID
 * @param {string} p.claimant    - claimant address
 * @param {bigint} p.amount      - OPBET amount (18-decimal)
 * @param {boolean} [p.isMainnet]
 */
export async function notifyClaim({ txid, claimant, amount, blockHeight, isMainnet = false }) {
  const who    = claimant ? `${claimant.slice(0, 10)}...${claimant.slice(-4)}` : 'anon';
  const opbet  = amount   ? (Number(amount) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '?';
  const txUrl = txid
    ? isMainnet
      ? `https://opscan.org/transactions/${txid}`
      : `https://opscan.org/transactions/${txid}?network=op_testnet`
    : null;

  const msg = new Msg()
    .emoji('🔥', EMOJI.fire).plain(' ').bold('Airdrop Claim!')
    .nl(2)
    .plain('👤 ').code(who).nl()
    .emoji('🪙', EMOJI.coin).plain(' ').bold(`${opbet} $OPBET`).nl(2);

  if (txUrl) {
    msg.plain('🔥 ').link('View on OPScan', txUrl).nl();
  }
  msg.plain('🌐 ').link('mint.op-bet.xyz', MINT_URL);

  await sendMessage(msg.build());
}

/**
 * Win streak — only fires at milestone counts (3, 5, 10, 20, 50) to avoid spam.
 */
const STREAK_MILESTONES = new Set([3, 5, 10, 20, 50]);

export async function notifyStreak({ wallet, streak }) {
  if (!STREAK_MILESTONES.has(streak)) return; // skip non-milestones
  const who  = shortWallet(wallet);
  const fire = '🔥'.repeat(Math.min(streak, 5));
  const msg  = new Msg()
    .plain(`${fire} `).bold(`${streak}-WIN STREAK!`)
    .nl()
    .code(who).plain(' is on fire!')
    .nl(2)
    .plain('🌐 ').link('Think you can beat them?', APP_URL)
    .build();
  await sendMessage(msg);
}

/**
 * Big win alert — payout > 1,000 tokens.
 */
export async function notifyBigWin({ betId, wallet, payout, betType, param1, param2, tokenSymbol }) {
  const payoutNum = Number(payout) / 1e18;
  const symbol    = tokenSymbol ? `$${tokenSymbol}` : '$OPBET';
  const coinEmoji = symbol === '$MOTO' ? { base: '🔥', id: EMOJI.moto } : { base: '🪙', id: EMOJI.coin };
  const payoutStr = payoutNum >= 1000
    ? `${(payoutNum / 1000).toFixed(1)}k ${symbol}`
    : `${payoutNum.toFixed(2)} ${symbol}`;
  const who = shortWallet(wallet);
  const bet = betType ? decodeBet(betType, Number(param1 || 0), Number(param2 || 0)) : null;

  const msg = new Msg()
    .emoji('💰', EMOJI.money).plain(' ').bold('MEGA WIN!').plain(' 🚀🎰  Bet ').bold(`#${betId}`)
    .nl(2)
    .plain('👤 ').code(who).nl();

  if (bet?.label) {
    msg.plain('📊 ').bold(`${bet.type}: `).plain(bet.label).nl();
  }

  msg
    .emoji(coinEmoji.base, coinEmoji.id).plain(' Payout: ').bold(payoutStr).nl(2)
    .plain('🚀 ').italic('This is a top-tier win!').nl(2)
    .plain('🌐 ').link('Can you beat this?', APP_URL);

  await sendMessage(msg.build());
}

/**
 * Daily digest — sent every day at midnight UTC.
 */
export async function notifyDailyDigest({ totalBets, totalVolume, winnerCount, winRate, totalPaid, currentFee }) {
  const feeStr    = currentFee != null ? `${currentFee} sat/vB` : 'N/A';
  const volumeStr = totalVolume >= 1000
    ? `${(totalVolume / 1000).toFixed(1)}k`
    : totalVolume.toLocaleString();
  const paidStr   = totalPaid >= 1000
    ? `${(totalPaid / 1000).toFixed(1)}k`
    : totalPaid.toLocaleString();

  const msg = new Msg()
    .plain('🌅 ').bold('Good morning! OP-BET daily recap')
    .nl(2)
    .bold('📊 Last 24 hours:').nl()
    .plain(`  Bets placed: `).bold(`${totalBets}`).nl()
    .plain(`  Volume: `).bold(`${volumeStr} $OPBET`).nl()
    .plain(`  Winners: `).bold(`${winnerCount} of ${totalBets}`).plain(totalBets > 0 ? ` (${winRate}%)` : '').nl()
    .plain(`  Total paid out: `).bold(`${paidStr} $OPBET`).nl(2)
    .plain('⚡ Current fee: ').bold(feeStr).nl(2)
    .bold('🎯 Today\'s markets are LIVE:').nl()
    .plain('  • Over/Under (next block) — ').italic('1.15x–10x').nl()
    .plain('  • Fee Trend (3 blocks) — ').italic('2x').nl()
    .plain('  • Mempool Size — ').italic('2.4x–8x').nl()
    .plain('  • Block Time — ').italic('1.8x–6x').nl()
    .plain('  • Fee Spike — ').italic('5x–100x').nl()
    .plain('  • Exact Prediction — ').italic('50x').nl(2)
    .plain('🔥 ').link('Place your bets', APP_URL);

  await sendMessage(msg.build());
}

/**
 * Weekly leaderboard — sent every Sunday midnight UTC.
 */
export async function notifyWeeklyLeaderboard({ top3 }) {
  const medals = ['🥇', '🥈', '🥉'];
  const msg = new Msg()
    .plain('🏆 ').bold('Weekly Leaderboard')
    .nl(2);

  if (top3.length === 0) {
    msg.italic('No ranked bettors this week yet.').nl();
  } else {
    for (let i = 0; i < top3.length; i++) {
      const p        = top3[i];
      const who      = shortWallet(p.wallet);
      // Support both `profit` (weekly service) and `totalPayout` (leaderboard API)
      const rawNum   = p.profit != null ? p.profit : (Number(p.total_payout || p.totalPayout || 0) / 1e18);
      const payStr   = rawNum >= 1000
        ? `${(rawNum / 1000).toFixed(1)}k`
        : rawNum.toFixed(0);
      const total    = (p.wins || 0) + (p.losses || 0);
      msg
        .plain(`${medals[i]} `).code(who)
        .plain('  ').bold(`${payStr} $OPBET`)
        .plain(`  (${p.wins}W / ${p.losses ?? (total - (p.wins || 0))}L)`).nl();
    }
  }

  msg
    .nl()
    .italic('New week starts now — go claim your spot!').nl(2)
    .plain('🌐 ').link('Start betting', APP_URL);

  await sendMessage(msg.build());
}

/**
 * Market round resolved (channel notification).
 */
export async function notifyMarketResolved({ betType, result, totalPayout, winnerCount, roundBlock }) {
  const payoutNum = Number(totalPayout || 0) / 1e18;
  const payoutStr = payoutNum >= 1000
    ? `${(payoutNum / 1000).toFixed(1)}k $OPBET`
    : `${payoutNum.toFixed(0)} $OPBET`;

  const typeLabels = { 1: 'Over/Under', 2: 'Exact', 3: 'Trend', 4: 'Mempool', 5: 'Block Time', 6: 'Spike' };
  const typeName = typeLabels[betType] || `Type ${betType}`;

  const msg = new Msg()
    .plain('⚡ ').bold(`${typeName} Round Resolved`)
    .plain(`  Block `).bold(`#${roundBlock}`)
    .nl(2)
    .plain('Result: ').bold(String(result)).nl()
    .plain('Winners: ').bold(`${winnerCount}`).nl()
    .plain('Total paid: ').bold(payoutStr).nl(2)
    .plain('🌐 ').link('Place your bet', APP_URL);

  await sendMessage(msg.build());
}
