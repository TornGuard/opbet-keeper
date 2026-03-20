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
export async function notifyEntry({ betId, wallet, txId, direction, threshold, amount, endBlock }) {
  console.log(`[Telegram] notifyEntry #${betId} wallet=${wallet || 'anon'} dir=${direction} threshold=${threshold}`);
  const who      = shortWallet(wallet);
  const dirEmoji = direction === 'over' ? '📈' : direction === 'under' ? '📉' : '🎯';
  const amtNum   = amount ? (Number(amount) / 1e18).toFixed(2) : null;
  const txUrl    = txId ? `https://testnet.opnet.org/tx/${txId}` : null;

  const msg = new Msg()
    .plain('🟢 ').bold('New Bet Placed!')
    .plain('  Bet ').bold(`#${betId}`)
    .nl(2)
    .plain('👤 ').code(who)
    .nl();

  if (direction && threshold) {
    msg.plain(`${dirEmoji} `).bold(`${direction.toUpperCase()} ${threshold} sat/vB`).nl();
  }

  if (amtNum) {
    msg.emoji('💰', EMOJI.money).plain(' ').bold(`${amtNum} MOTO`).nl();
  }

  if (endBlock) {
    msg.plain('⏳ Resolves at block ').bold(`#${endBlock}`).nl();
  }

  msg.nl();

  if (txUrl) {
    msg.emoji('🔥', EMOJI.fire).plain(' ').link('View Tx', txUrl).plain('  ·  ');
  }
  msg.plain('🎰 ').link('Place Your Bet', APP_URL);

  await sendMessage(msg.build());
}

/**
 * Bet won.
 */
export async function notifyWin({ betId, wallet, payout, direction, threshold }) {
  const payoutNum = Number(payout) / 1e18;
  if (payoutNum < 1) return;

  const payoutStr = payoutNum >= 1000
    ? `${(payoutNum / 1000).toFixed(1)}k MOTO`
    : `${payoutNum.toFixed(2)} MOTO`;

  const who    = shortWallet(wallet);
  const isBig  = payoutNum >= 500;
  const explorerUrl = wallet ? `https://testnet.opnet.org/address/${wallet}` : null;

  const msg = new Msg();

  if (isBig) {
    msg.emoji('💰', EMOJI.money).plain(' ').bold('BIG WIN!').plain(' 🚀  Bet ').bold(`#${betId}`);
  } else {
    msg.plain('🎉 ').bold('Winner!').plain('  Bet ').bold(`#${betId}`);
  }

  msg.nl(2).plain('👤 ').code(who).nl();

  if (direction && threshold) {
    const dirEmoji = direction === 'over' ? '📈' : '📉';
    msg.plain(`${dirEmoji} `).bold(`${direction.toUpperCase()} ${threshold} sat/vB`).nl();
  }

  msg.plain('💵 Payout: ').bold(payoutStr).nl(2);

  if (explorerUrl) {
    msg.plain('🔍 ').link('View Wallet', explorerUrl).plain('  ·  ');
  }
  msg.plain('🎰 ').link('Place Your Bet', APP_URL);

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
    .plain('🎰 ').link('Think you can beat them?', APP_URL)
    .build();
  await sendMessage(msg);
}
