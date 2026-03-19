/**
 * OP-BET Keeper — Status Dashboard + Health API
 *
 * GET /        → HTML dashboard (auto-refreshes every 10s)
 * GET /health  → JSON status (for monitoring tools)
 */

import http from 'http';
import { pool, registerBetOwner, getBetsByWallet, getBetsByIds, getAllBettors } from './db.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

async function getStats(oracle, resolver) {
  const [
    betsResult,
    feedsResult,
    bettorsResult,
    recentBets,
    recentFeeds,
    feeStats,
    activeBets,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM bets'),
    pool.query('SELECT COUNT(*) FROM oracle_feeds'),
    pool.query('SELECT COUNT(*) FROM bettors'),
    pool.query('SELECT COUNT(*) FROM bettors'),
    pool.query(`
      SELECT bet_id, bet_type, amount, end_block, status, won, payout, wallet, placed_at, resolved_at, resolve_tx
      FROM bets ORDER BY bet_id DESC LIMIT 20
    `),
    pool.query(`
      SELECT block_height, median_fee_scaled, mempool_count, tx_id, submitted_at
      FROM oracle_feeds ORDER BY block_height DESC LIMIT 50
    `),
    pool.query(`
      SELECT
        MIN(median_fee_scaled)::float / 100  AS min_fee,
        MAX(median_fee_scaled)::float / 100  AS max_fee,
        AVG(median_fee_scaled)::float / 100  AS avg_fee,
        MIN(mempool_count)                   AS min_mempool,
        MAX(mempool_count)                   AS max_mempool,
        AVG(mempool_count)::int              AS avg_mempool
      FROM oracle_feeds
    `),
    pool.query(`SELECT COUNT(*) FROM bets WHERE status = 0`),
  ]);

  return {
    uptime: Math.floor(process.uptime()),
    lastOPNetBlock: oracle.lastKnownOPNetBlock,
    lastSubmittedBlock: oracle.lastSubmittedHeight,
    latestBtcFee: oracle.latestBtcFee,
    latestMempoolCount: oracle.latestMempoolCount,
    neededBlocks: [...oracle.neededBlocks],
    betsTotal: Number(betsResult.rows[0].count),
    betsActive: Number(activeBets.rows[0].count),
    bettorsTotal: Number(bettorsResult.rows[0].count),
    oracleFeedsTotal: Number(feedsResult.rows[0].count),
    resolvedInMemory: resolver.resolvedIds.size,
    feeStats: feeStats.rows[0],
    recentBets: recentBets.rows,
    recentFeeds: recentFeeds.rows,
  };
}

function sparkline(feeds) {
  // Build a simple SVG sparkline from the last 50 fee values (oldest→newest)
  const values = [...feeds].reverse().map((f) => f.median_fee_scaled / 100);
  if (values.length < 2) return '';
  const w = 300, h = 48, pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <polyline points="${pts}" fill="none" stroke="#f7931a" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
}

function renderHTML(stats) {
  const betTypeLabel = (t) => (Number(t) === 0 ? '⬆ UP' : '⬇ DOWN');
  const statusLabel = (s) => (Number(s) === 0
    ? '<span class="badge active">Active</span>'
    : '<span class="badge resolved">Resolved</span>');
  const wonLabel = (won, status) => {
    if (Number(status) === 0) return '—';
    return won ? '<span class="badge win">WON</span>' : '<span class="badge loss">LOST</span>';
  };
  const shortTx = (tx) => tx
    ? `<a href="https://testnet.opnet.org/tx/${tx}" target="_blank">${tx.slice(0, 10)}…</a>`
    : '—';
  const fmtDate = (d) => d ? new Date(d).toUTCString().replace(' GMT', '') : '—';
  const fmtSats = (v) => v ? `${Number(v).toLocaleString()} sats` : '—';
  const fix2 = (v) => v != null ? Number(v).toFixed(2) : '—';

  const shortWallet = (w) => w ? `<span title="${w}">${w.slice(0, 8)}…${w.slice(-6)}</span>` : '<span style="color:#333">unknown</span>';

  const betsRows = stats.recentBets.map((b) => `
    <tr>
      <td>#${b.bet_id}</td>
      <td>${betTypeLabel(b.bet_type)}</td>
      <td>${fmtSats(b.amount)}</td>
      <td>${b.end_block}</td>
      <td>${statusLabel(b.status)}</td>
      <td>${wonLabel(b.won, b.status)}</td>
      <td>${fmtSats(b.payout)}</td>
      <td>${shortWallet(b.wallet)}</td>
      <td>${fmtDate(b.placed_at)}</td>
      <td>${fmtDate(b.resolved_at)}</td>
      <td>${shortTx(b.resolve_tx)}</td>
    </tr>`).join('');

  const feedRows = stats.recentFeeds.slice(0, 20).map((f) => `
    <tr>
      <td>${f.block_height}</td>
      <td>${(f.median_fee_scaled / 100).toFixed(2)} sat/vB</td>
      <td>${Number(f.mempool_count).toLocaleString()}</td>
      <td>${shortTx(f.tx_id)}</td>
      <td>${fmtDate(f.submitted_at)}</td>
    </tr>`).join('');

  const fs = stats.feeStats;
  const neededHtml = stats.neededBlocks.length
    ? stats.neededBlocks.sort((a, b) => a - b).map((b) => `<span class="pill">${b}</span>`).join(' ')
    : '<span style="color:#444">none — no active bets</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta http-equiv="refresh" content="10"/>
  <title>OP-BET Keeper</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; padding: 24px; }
    h1 { font-size: 22px; font-weight: 700; color: #f7931a; margin-bottom: 4px; }
    .subtitle { color: #555; font-size: 12px; margin-bottom: 28px; }
    .subtitle span { color: #888; }

    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .card { background: #13131f; border: 1px solid #1e1e2e; border-radius: 10px; padding: 16px; }
    .card .label { font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .card .value { font-size: 22px; font-weight: 700; color: #fff; }
    .card .value.green  { color: #22c55e; }
    .card .value.orange { color: #f7931a; }
    .card .value.blue   { color: #60a5fa; }
    .card .value.yellow { color: #facc15; }
    .card .sub { font-size: 11px; color: #444; margin-top: 4px; }

    h2 { font-size: 14px; font-weight: 600; color: #888; margin-bottom: 12px; border-left: 3px solid #f7931a; padding-left: 8px; text-transform: uppercase; letter-spacing: 0.06em; }
    .section { margin-bottom: 32px; }

    /* Oracle panel */
    .oracle-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }
    @media(max-width:700px){ .oracle-grid { grid-template-columns: 1fr; } }
    .oracle-panel { background: #13131f; border: 1px solid #1e1e2e; border-radius: 10px; padding: 18px; }
    .oracle-panel h3 { font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px; }
    .stat-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 0; border-bottom: 1px solid #1a1a2a; }
    .stat-row:last-child { border-bottom: none; }
    .stat-row .k { color: #666; font-size: 12px; }
    .stat-row .v { font-weight: 600; color: #e0e0e0; }
    .stat-row .v.orange { color: #f7931a; }
    .stat-row .v.green  { color: #22c55e; }
    .stat-row .v.blue   { color: #60a5fa; }

    .pill { display: inline-block; background: #1a2035; color: #60a5fa; border: 1px solid #1e3a5f; border-radius: 4px; padding: 2px 7px; font-size: 11px; margin: 2px; }
    .needed-wrap { background: #13131f; border: 1px solid #1e1e2e; border-radius: 10px; padding: 16px; margin-bottom: 28px; }
    .needed-wrap h3 { font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 10px; }

    .sparkline-wrap { background: #13131f; border: 1px solid #1e1e2e; border-radius: 10px; padding: 18px; margin-bottom: 28px; }
    .sparkline-wrap h3 { font-size: 12px; color: #555; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }
    .sparkline-wrap svg { display: block; }
    .spark-labels { display: flex; justify-content: space-between; font-size: 10px; color: #444; margin-top: 4px; }

    .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid #1e1e2e; }
    table { width: 100%; border-collapse: collapse; }
    thead th { background: #13131f; color: #555; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 10px 12px; text-align: left; white-space: nowrap; }
    tbody tr { border-top: 1px solid #1a1a2a; }
    tbody tr:hover { background: #13131f; }
    tbody td { padding: 9px 12px; color: #ccc; white-space: nowrap; }
    tbody td a { color: #60a5fa; text-decoration: none; }
    tbody td a:hover { text-decoration: underline; }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
    .badge.active   { background: #1e3a5f; color: #60a5fa; }
    .badge.resolved { background: #1a2e1a; color: #4ade80; }
    .badge.win      { background: #14532d; color: #4ade80; }
    .badge.loss     { background: #3b0a0a; color: #f87171; }

    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .refresh-note { font-size: 11px; color: #333; margin-top: 20px; }
    .refresh-note a { color: #333; }
  </style>
</head>
<body>

<h1><span class="dot"></span>OP-BET Keeper</h1>
<p class="subtitle">Auto-refreshes every 10s &nbsp;·&nbsp; <span>${new Date().toUTCString()}</span></p>

<!-- Top stat cards -->
<div class="cards">
  <div class="card">
    <div class="label">Uptime</div>
    <div class="value blue">${formatUptime(stats.uptime)}</div>
  </div>
  <div class="card">
    <div class="label">OPNet Block</div>
    <div class="value orange">${stats.lastOPNetBlock.toLocaleString()}</div>
  </div>
  <div class="card">
    <div class="label">Last Feed Block</div>
    <div class="value">${stats.lastSubmittedBlock.toLocaleString()}</div>
  </div>
  <div class="card">
    <div class="label">BTC Fee (live)</div>
    <div class="value green">${stats.latestBtcFee} <span style="font-size:12px;color:#555">sat/vB</span></div>
    <div class="sub">mempool: ${stats.latestMempoolCount.toLocaleString()} txs</div>
  </div>
  <div class="card">
    <div class="label">Total Bets</div>
    <div class="value orange">${stats.betsTotal}</div>
    <div class="sub">${stats.betsActive} active</div>
  </div>
  <div class="card">
    <div class="label">Oracle Feeds</div>
    <div class="value blue">${stats.oracleFeedsTotal}</div>
    <div class="sub">blocks submitted</div>
  </div>
  <div class="card">
    <div class="label">Resolved</div>
    <div class="value green">${stats.resolvedInMemory}</div>
    <div class="sub">this session</div>
  </div>
</div>

<!-- Oracle detail panels -->
<div class="section">
  <h2>Oracle Detail</h2>
  <div class="oracle-grid">

    <div class="oracle-panel">
      <h3>Live State</h3>
      <div class="stat-row"><span class="k">OPNet block height</span><span class="v orange">${stats.lastOPNetBlock.toLocaleString()}</span></div>
      <div class="stat-row"><span class="k">Last block submitted</span><span class="v">${stats.lastSubmittedBlock.toLocaleString()}</span></div>
      <div class="stat-row"><span class="k">Blocks behind</span><span class="v ${stats.lastOPNetBlock - stats.lastSubmittedBlock > 5 ? 'orange' : 'green'}">${stats.lastOPNetBlock - stats.lastSubmittedBlock}</span></div>
      <div class="stat-row"><span class="k">Current BTC fee</span><span class="v green">${stats.latestBtcFee} sat/vB</span></div>
      <div class="stat-row"><span class="k">Mempool tx count</span><span class="v">${stats.latestMempoolCount.toLocaleString()}</span></div>
      <div class="stat-row"><span class="k">Blocks needed (active bets)</span><span class="v blue">${stats.neededBlocks.length}</span></div>
    </div>

    <div class="oracle-panel">
      <h3>All-time Fee Stats</h3>
      <div class="stat-row"><span class="k">Min fee submitted</span><span class="v">${fix2(fs.min_fee)} sat/vB</span></div>
      <div class="stat-row"><span class="k">Max fee submitted</span><span class="v orange">${fix2(fs.max_fee)} sat/vB</span></div>
      <div class="stat-row"><span class="k">Avg fee submitted</span><span class="v">${fix2(fs.avg_fee)} sat/vB</span></div>
      <div class="stat-row"><span class="k">Min mempool count</span><span class="v">${fs.min_mempool != null ? Number(fs.min_mempool).toLocaleString() : '—'}</span></div>
      <div class="stat-row"><span class="k">Max mempool count</span><span class="v">${fs.max_mempool != null ? Number(fs.max_mempool).toLocaleString() : '—'}</span></div>
      <div class="stat-row"><span class="k">Avg mempool count</span><span class="v">${fs.avg_mempool != null ? Number(fs.avg_mempool).toLocaleString() : '—'}</span></div>
    </div>

  </div>

  <!-- Blocks needed by active bets -->
  <div class="needed-wrap">
    <h3>Blocks Needed by Active Bets</h3>
    ${neededHtml}
  </div>

  <!-- Fee sparkline -->
  <div class="sparkline-wrap">
    <h3>BTC Median Fee — Last ${stats.recentFeeds.length} Submissions</h3>
    ${sparkline(stats.recentFeeds)}
    <div class="spark-labels">
      <span>oldest</span>
      <span>sat/vB</span>
      <span>latest</span>
    </div>
  </div>
</div>

<!-- Oracle feeds table -->
<div class="section">
  <h2>Recent Oracle Feeds (last 20)</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Block Height</th>
          <th>Median Fee</th>
          <th>Mempool Txs</th>
          <th>TX</th>
          <th>Submitted At</th>
        </tr>
      </thead>
      <tbody>${feedRows || '<tr><td colspan="5" style="text-align:center;color:#333;padding:20px">No feeds yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<!-- Bets table -->
<div class="section">
  <h2>Recent Bets (last 20)</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Type</th><th>Amount</th><th>End Block</th>
          <th>Status</th><th>Result</th><th>Payout</th><th>Wallet</th>
          <th>Placed At</th><th>Resolved At</th><th>TX</th>
        </tr>
      </thead>
      <tbody>${betsRows || '<tr><td colspan="11" style="text-align:center;color:#333;padding:20px">No bets yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<p class="refresh-note">JSON API: <a href="/health">/health</a></p>

</body>
</html>`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export function startHealthServer(oracle, resolver) {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    try {
      // ── POST /api/bets — frontend registers bet ownership ──
      if (req.method === 'POST' && url.pathname === '/api/bets') {
        const body = await readBody(req);
        const { betId, wallet, tokenSymbol } = body;
        if (!betId || !wallet) {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'betId and wallet are required' }));
          return;
        }
        await registerBetOwner({ betId: Number(betId), wallet, tokenSymbol });
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── GET /api/bets?wallet=xxx — fetch bets registered to a wallet ──
      // ── GET /api/bets?ids=1,2,3  — fetch bets by specific IDs (localStorage lookup) ──
      if (req.method === 'GET' && url.pathname === '/api/bets') {
        const wallet = url.searchParams.get('wallet');
        const idsParam = url.searchParams.get('ids');

        let bets;
        if (idsParam) {
          const ids = idsParam.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
          bets = await getBetsByIds(ids);
        } else if (wallet) {
          bets = await getBetsByWallet(wallet);
        } else {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'wallet or ids query param required' }));
          return;
        }

        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bets));
        return;
      }

      // ── GET /api/bettors — all unique bettors (for airdrop) ──
      if (req.method === 'GET' && url.pathname === '/api/bettors') {
        const format = url.searchParams.get('format');
        const bettors = await getAllBettors();

        if (format === 'csv') {
          const rows = ['owner_hex,wallet,first_bet,last_bet,bet_count'];
          for (const b of bettors) {
            rows.push(`${b.owner_hex},${b.wallet || ''},${b.first_bet},${b.last_bet},${b.bet_count}`);
          }
          res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/csv' });
          res.end(rows.join('\n'));
          return;
        }

        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bettors));
        return;
      }

      // ── GET /health — JSON summary for monitoring ──
      if (req.method === 'GET' && url.pathname === '/health') {
        const stats = await getStats(oracle, resolver);
        const { recentBets, recentFeeds, ...summary } = stats;
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary, null, 2));
        return;
      }

      // ── GET / — HTML dashboard ──
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        const stats = await getStats(oracle, resolver);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderHTML(stats));
        return;
      }

      res.writeHead(302, { Location: '/' });
      res.end();

    } catch (err) {
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
  });

  server.listen(port, () => {
    console.log(`[Health] Dashboard:  http://0.0.0.0:${port}/`);
    console.log(`[Health] JSON API:   http://0.0.0.0:${port}/health`);
    console.log(`[Health] Bets API:   http://0.0.0.0:${port}/api/bets?wallet=<address>`);
    console.log(`[Health] Bettors:    http://0.0.0.0:${port}/api/bettors`);
  });
}
