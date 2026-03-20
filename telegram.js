/**
 * Telegram notifier for OP-BET Keeper.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable.
 */

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_URL = 'https://op-bet.vercel.app/';

if (TOKEN && CHAT_ID) {
  console.log(`[Telegram] ✅ Bot configured — chat ${CHAT_ID}`);
} else {
  console.warn('[Telegram] ⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — notifications disabled');
}

async function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  console.log('[Telegram] Sending message:', text.replace(/<[^>]+>/g, '').slice(0, 80));
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
    if (!res.ok) {
      console.warn('[Telegram] Send failed:', await res.text());
    } else {
      console.log('[Telegram] ✅ Message sent OK');
    }
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
  console.log(`[Telegram] notifyEntry bet #${betId} wallet=${wallet || 'anon'} dir=${direction} threshold=${threshold} amount=${amount} endBlock=${endBlock}`);
  const who    = shortWallet(wallet);
  const dirEmoji = direction === 'over' ? '📈' : direction === 'under' ? '📉' : '🎯';
  const dirStr = direction && threshold
    ? `${dirEmoji} <b>${direction.toUpperCase()} ${threshold} sat/vB</b>`
    : '🎯 <b>a bet</b>';
  const amtStr   = amount ? `💰 <b>${(Number(amount) / 1e18).toFixed(2)} MOTO</b>` : '';
  const blockStr = endBlock ? `⏳ Resolves at block <b>#${endBlock}</b>` : '';
  const explorerUrl = wallet ? `https://testnet.opnet.org/address/${wallet}` : null;
  const explorerLink = explorerUrl
    ? `🔍 <a href="${explorerUrl}">View Wallet</a>  ·  🎰 <a href="${APP_URL}">Place Your Bet</a>`
    : `🎰 <a href="${APP_URL}">Place Your Bet</a>`;

  const text = [
    `🟢 <b>New Bet Placed!</b>  💰 Bet <b>#${betId}</b>`,
    ``,
    `👤 <code>${who}</code>`,
    dirStr,
    amtStr,
    blockStr,
    ``,
    explorerLink,
  ].filter(Boolean).join('\n');

  await sendMessage(text);
}

/**
 * Startup ping — call once when keeper boots to verify bot is reachable.
 */
export async function notifyStartup() {
  if (!TOKEN || !CHAT_ID) return;
  console.log('[Telegram] Sending startup ping...');
  await sendMessage(`🟢 <b>OP-BET Keeper started</b>\nNotifications are active.`);
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
    : `${payoutNum.toFixed(2)} MOTO`;

  const who    = shortWallet(wallet);
  const isBig  = payoutNum >= 500;
  const dirStr = direction && threshold
    ? `📊 <b>${direction.toUpperCase()} ${threshold} sat/vB</b>`
    : '';
  const explorerUrl = wallet ? `https://testnet.opnet.org/address/${wallet}` : null;
  const explorerLink = explorerUrl
    ? `🔍 <a href="${explorerUrl}">View Wallet</a>  ·  🎰 <a href="${APP_URL}">Place Your Bet</a>`
    : `🎰 <a href="${APP_URL}">Place Your Bet</a>`;

  const text = [
    isBig ? `💰 <b>BIG WIN!</b> 🚀  Bet <b>#${betId}</b>` : `🎉 <b>Winner!</b>  Bet <b>#${betId}</b>`,
    ``,
    `👤 <code>${who}</code>`,
    dirStr,
    `💵 Payout: <b>${payoutStr}</b>`,
    ``,
    explorerLink,
  ].filter(Boolean).join('\n');

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
