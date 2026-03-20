/**
 * Telegram notifier for OP-BET Keeper.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable.
 */

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_URL = 'https://op-bet.vercel.app/';

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

async function sendMessage({ text, entities }) {
  if (!TOKEN || !CHAT_ID) return;
  console.log('[Telegram] Sending:', text.slice(0, 80).replace(/\n/g, ' '));
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        entities,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.warn('[Telegram] Send failed:', await res.text());
    } else {
      console.log('[Telegram] ✅ Sent OK');
    }
  } catch (err) {
    console.warn('[Telegram] Failed:', err.message);
  }
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
 * New bet placed.
 */
export async function notifyEntry({ betId, wallet, txId, betType, param1, param2, amount, endBlock, tokenSymbol }) {
  console.log(`[Telegram] notifyEntry #${betId} wallet=${wallet || 'anon'} betType=${betType} param1=${param1}`);
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
    msg.emoji('🔥', EMOJI.fire).plain(' ').link('View Tx', txUrl).plain('  ·  ');
  }
  msg.emoji('🌐', EMOJI.globe).plain(' ').link('Place Your Bet', APP_URL);

  msg.nl(2).italic('🧪 OPNet Testnet — transactions are not real value');

  await sendMessage(msg.build());
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

  msg.emoji('🌐', EMOJI.globe).plain(' ').link('Place Your Bet', APP_URL);

  await sendMessage(msg.build());
}

/**
 * Win streak.
 */
export async function notifyStreak({ wallet, streak }) {
  const who = shortWallet(wallet);
  const fire = '🔥'.repeat(Math.min(streak, 5));
  const msg = new Msg()
    .plain(`${fire} `).bold(`${streak}-WIN STREAK!`)
    .nl()
    .code(who).plain(' is on fire!')
    .nl(2)
    .emoji('🌐', EMOJI.globe).plain(' ').link('Think you can beat them?', APP_URL)
    .build();
  await sendMessage(msg);
}
