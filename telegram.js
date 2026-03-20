/**
 * Telegram notifier for OP-BET Keeper.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable.
 */

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_URL = 'https://op-bet.vercel.app/';

async function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) console.warn('[Telegram] Error:', await res.text());
  } catch (err) {
    console.warn('[Telegram] Failed to send:', err.message);
  }
}

function shortWallet(wallet) {
  if (!wallet) return 'anon';
  return `${wallet.slice(0, 10)}…${wallet.slice(-4)}`;
}

/**
 * Notify when a new bet entry is placed.
 */
export async function notifyEntry({ betId, wallet, direction, threshold, amount, endBlock }) {
  const who    = shortWallet(wallet);
  const dirStr = direction && threshold
    ? `<b>${direction.toUpperCase()} ${threshold} sat/vB</b>`
    : '<b>a bet</b>';
  const amtStr   = amount   ? ` · ${(Number(amount) / 1e18).toFixed(0)} MOTO` : '';
  const blockStr = endBlock ? ` · ends block #${endBlock}` : '';

  const text = `🎰 New entry!\n<code>${who}</code> bet ${dirStr}${amtStr}${blockStr}\n\n👉 <a href="${APP_URL}">Place your bet on OP_BET</a>`;
  await sendMessage(text);
}

/**
 * Notify when a bet is won.
 * @param {object} opts
 * @param {number}  opts.betId
 * @param {string}  opts.wallet   - p2tr address or null
 * @param {bigint}  opts.payout   - raw token amount (18 decimals)
 * @param {string}  opts.direction - 'over' | 'under' | null
 * @param {string}  opts.threshold - e.g. '5.0'
 */
export async function notifyWin({ betId, wallet, payout, direction, threshold }) {
  const payoutNum = Number(payout) / 1e18;
  if (payoutNum < 1) return; // skip dust wins

  const payoutStr = payoutNum >= 1000
    ? `${(payoutNum / 1000).toFixed(1)}k MOTO`
    : `${Math.round(payoutNum)} MOTO`;

  const who   = shortWallet(wallet);
  const dirStr = direction && threshold
    ? ` betting <b>${direction.toUpperCase()} ${threshold} sat/vB</b>`
    : '';

  const isBig = payoutNum >= 500;

  const text = isBig
    ? `💰 <b>BIG WIN!</b>\n<code>${who}</code> just raked <b>${payoutStr}</b>${dirStr}!\n\n🎰 <a href="${APP_URL}">Can you beat them? OP_BET</a>`
    : `🎉 <code>${who}</code> won <b>${payoutStr}</b>${dirStr}!\n\n🎰 <a href="${APP_URL}">OP_BET — bet on the mempool</a>`;

  await sendMessage(text);
}

/**
 * Notify when a wallet is on a win streak.
 */
export async function notifyStreak({ wallet, streak }) {
  const who = shortWallet(wallet);
  const fire = '🔥'.repeat(Math.min(streak, 5));
  const text = `${fire} <b>${streak}-WIN STREAK!</b>\n<code>${who}</code> is on fire!\n\n🎰 <a href="${APP_URL}">Think you can do better? OP_BET</a>`;
  await sendMessage(text);
}
