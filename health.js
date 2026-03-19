/**
 * OP-BET Keeper — Status Dashboard + Health API
 *
 * GET /        → HTML dashboard (auto-refreshes every 10s)
 * GET /health  → JSON status (for monitoring tools)
 */

import http from 'http';
import { pool } from './db.js';

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
  const [betsResult, feedsResult, recentBets, recentFeeds] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM bets'),
    pool.query('SELECT COUNT(*) FROM oracle_feeds'),
    pool.query(`
      SELECT bet_id, bet_type, amount, end_block, status, won, payout, placed_at, resolved_at, resolve_tx
      FROM bets ORDER BY bet_id DESC LIMIT 20
    `),
    pool.query(`
      SELECT block_height, median_fee_scaled, mempool_count, tx_id, submitted_at
      FROM oracle_feeds ORDER BY block_height DESC LIMIT 20
    `),
  ]);

  return {
    uptime: Math.floor(process.uptime()),
    lastOPNetBlock: oracle.lastKnownOPNetBlock,
    lastSubmittedBlock: oracle.lastSubmittedHeight,
    latestBtcFee: oracle.latestBtcFee,
    latestMempoolCount: oracle.latestMempoolCount,
    betsTotal: Number(betsResult.rows[0].count),
    oracleFeedsTotal: Number(feedsResult.rows[0].count),
    resolvedInMemory: resolver.resolvedIds.size,
    recentBets: recentBets.rows,
    recentFeeds: recentFeeds.rows,
  };
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
  const shortTx = (tx) => tx ? `<a href="https://testnet.opnet.org/tx/${tx}" target="_blank">${tx.slice(0, 10)}…</a>` : '—';
  const fmtDate = (d) => d ? new Date(d).toUTCString().replace(' GMT', '') : '—';
  const fmtSats = (v) => v ? `${Number(v).toLocaleString()} sats` : '—';

  const betsRows = stats.recentBets.map((b) => `
    <tr>
      <td>#${b.bet_id}</td>
      <td>${betTypeLabel(b.bet_type)}</td>
      <td>${fmtSats(b.amount)}</td>
      <td>${b.end_block}</td>
      <td>${statusLabel(b.status)}</td>
      <td>${wonLabel(b.won, b.status)}</td>
      <td>${fmtSats(b.payout)}</td>
      <td>${fmtDate(b.placed_at)}</td>
      <td>${fmtDate(b.resolved_at)}</td>
      <td>${shortTx(b.resolve_tx)}</td>
    </tr>`).join('');

  const feedRows = stats.recentFeeds.map((f) => `
    <tr>
      <td>${f.block_height}</td>
      <td>${(f.median_fee_scaled / 100).toFixed(2)} sat/vB</td>
      <td>${Number(f.mempool_count).toLocaleString()}</td>
      <td>${shortTx(f.tx_id)}</td>
      <td>${fmtDate(f.submitted_at)}</td>
    </tr>`).join('');

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
    .subtitle { color: #666; font-size: 12px; margin-bottom: 24px; }
    .subtitle span { color: #f7931a; }

    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
    .card { background: #13131f; border: 1px solid #1e1e2e; border-radius: 10px; padding: 16px; }
    .card .label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
    .card .value { font-size: 22px; font-weight: 700; color: #fff; }
    .card .value.green { color: #22c55e; }
    .card .value.orange { color: #f7931a; }
    .card .value.blue { color: #60a5fa; }

    h2 { font-size: 15px; font-weight: 600; color: #aaa; margin-bottom: 10px; border-left: 3px solid #f7931a; padding-left: 8px; }
    .section { margin-bottom: 32px; }

    .table-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid #1e1e2e; }
    table { width: 100%; border-collapse: collapse; }
    thead th { background: #13131f; color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 10px 12px; text-align: left; white-space: nowrap; }
    tbody tr { border-top: 1px solid #1a1a2a; }
    tbody tr:hover { background: #13131f; }
    tbody td { padding: 9px 12px; color: #ccc; white-space: nowrap; }
    tbody td a { color: #60a5fa; text-decoration: none; }
    tbody td a:hover { text-decoration: underline; }

    .badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
    .badge.active  { background: #1e3a5f; color: #60a5fa; }
    .badge.resolved{ background: #1a2e1a; color: #4ade80; }
    .badge.win     { background: #14532d; color: #4ade80; }
    .badge.loss    { background: #3b0a0a; color: #f87171; }

    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; margin-right: 6px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

    .refresh-note { font-size: 11px; color: #444; margin-top: 20px; }
  </style>
</head>
<body>

<h1><span class="dot"></span>OP-BET Keeper</h1>
<p class="subtitle">Auto-refreshes every 10s &nbsp;·&nbsp; <span>${new Date().toUTCString()}</span></p>

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
    <div class="label">BTC Median Fee</div>
    <div class="value green">${stats.latestBtcFee} <span style="font-size:13px;color:#666">sat/vB</span></div>
  </div>
  <div class="card">
    <div class="label">Mempool Txs</div>
    <div class="value">${stats.latestMempoolCount.toLocaleString()}</div>
  </div>
  <div class="card">
    <div class="label">Total Bets</div>
    <div class="value orange">${stats.betsTotal}</div>
  </div>
  <div class="card">
    <div class="label">Oracle Feeds</div>
    <div class="value blue">${stats.oracleFeedsTotal}</div>
  </div>
  <div class="card">
    <div class="label">Resolved (session)</div>
    <div class="value green">${stats.resolvedInMemory}</div>
  </div>
</div>

<div class="section">
  <h2>Recent Bets (last 20)</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Type</th><th>Amount</th><th>End Block</th>
          <th>Status</th><th>Result</th><th>Payout</th>
          <th>Placed At</th><th>Resolved At</th><th>TX</th>
        </tr>
      </thead>
      <tbody>${betsRows || '<tr><td colspan="10" style="text-align:center;color:#444;padding:20px">No bets yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<div class="section">
  <h2>Recent Oracle Feeds (last 20)</h2>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Block</th><th>Median Fee</th><th>Mempool Txs</th><th>TX</th><th>Submitted At</th>
        </tr>
      </thead>
      <tbody>${feedRows || '<tr><td colspan="5" style="text-align:center;color:#444;padding:20px">No feeds yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<p class="refresh-note">JSON API: <a href="/health" style="color:#444">/health</a></p>

</body>
</html>`;
}

export function startHealthServer(oracle, resolver) {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer(async (req, res) => {
    try {
      const stats = await getStats(oracle, resolver);

      if (req.url === '/health') {
        // JSON for monitoring tools
        const { recentBets, recentFeeds, ...summary } = stats;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(summary, null, 2));
      } else if (req.url === '/' || req.url === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(renderHTML(stats));
      } else {
        res.writeHead(302, { Location: '/' });
        res.end();
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
  });

  server.listen(port, () => {
    console.log(`[Health] Dashboard: http://0.0.0.0:${port}/`);
    console.log(`[Health] JSON API:  http://0.0.0.0:${port}/health`);
  });
}
