/**
 * OP-BET Keeper — Status Dashboard + Health API
 *
 * GET /        → HTML dashboard (auto-refreshes every 10s)
 * GET /health  → JSON status (for monitoring tools)
 */

import http from 'http';
import { pool, registerBetOwner, getBetsByWallet, getBetsByIds, getAllBettors, getRecentBets } from './db.js';
import { notifyEntry } from './telegram.js';

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
    activeBetsResult,
    recentBets,
    recentFeeds,
    feeStats,
  ] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM bets'),
    pool.query('SELECT COUNT(*) FROM oracle_feeds'),
    pool.query('SELECT COUNT(*) FROM bettors'),
    pool.query('SELECT COUNT(*) FROM bets WHERE status = 0'),
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
  ]);

  return {
    uptime: Math.floor(process.uptime()),
    lastOPNetBlock: oracle.latestBtcBlockHeight,
    lastSubmittedBlock: oracle.latestBtcBlockHeight,
    latestBtcFee: oracle.latestBtcFee,
    latestMempoolCount: oracle.latestMempoolCount,
    neededBlocks: [...oracle.neededBlocks],
    betsTotal: Number(betsResult.rows[0].count),
    betsActive: Number(activeBetsResult.rows[0].count),
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
  const fix2 = (v) => v != null ? Number(v).toFixed(2) : '—';
  const shortTx = (tx) => tx
    ? `<a href="https://testnet.opnet.org/tx/${tx}" target="_blank" title="${tx}">${tx.slice(0, 8)}…${tx.slice(-6)}</a>`
    : '—';
  const fmtTime = (d) => d ? new Date(d).toLocaleTimeString('en-GB', { hour12: false }) : '—';
  const fmtDate = (d) => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—';
  const shortWallet = (w) => w ? `<span title="${w}">${w.slice(0, 6)}…${w.slice(-4)}</span>` : '<span style="color:#333">?</span>';

  const fs = stats.feeStats;
  const behind = stats.lastOPNetBlock - stats.lastSubmittedBlock;
  const behindColor = behind > 5 ? 'orange' : 'green';

  const neededHtml = stats.neededBlocks.length
    ? stats.neededBlocks.sort((a, b) => a - b).map((b) => `<span class="pill">${b}</span>`).join(' ')
    : '<span class="dim">none</span>';

  // Unified TX log: merge oracle feeds + resolve TXs, sort by time desc
  const txLog = [];
  for (const f of stats.recentFeeds) {
    if (f.tx_id) txLog.push({ time: f.submitted_at, type: 'oracle', label: `Block #${f.block_height}`, detail: `${(f.median_fee_scaled / 100).toFixed(1)} sat/vB`, tx: f.tx_id });
  }
  for (const b of stats.recentBets) {
    if (b.resolve_tx) txLog.push({ time: b.resolved_at, type: b.won ? 'win' : 'loss', label: `Bet #${b.bet_id}`, detail: b.won ? 'WON' : 'LOST', tx: b.resolve_tx });
  }
  txLog.sort((a, b) => new Date(b.time) - new Date(a.time));

  const txRows = txLog.slice(0, 20).map((t) => `
    <tr>
      <td class="dim">${fmtTime(t.time)}</td>
      <td><span class="badge ${t.type}">${t.type === 'oracle' ? 'ORACLE' : t.type === 'win' ? 'RESOLVE WIN' : 'RESOLVE LOST'}</span></td>
      <td>${t.label}</td>
      <td class="${t.type === 'oracle' ? 'dim' : t.type === 'win' ? 'green' : 'red'}">${t.detail}</td>
      <td>${shortTx(t.tx)}</td>
    </tr>`).join('');

  const betsRows = stats.recentBets.slice(0, 10).map((b) => {
    const statusBadge = Number(b.status) === 0
      ? '<span class="badge active">ACTIVE</span>'
      : (b.won ? '<span class="badge win">WON</span>' : '<span class="badge loss">LOST</span>');
    const amtMOTO = b.amount ? (Number(b.amount) / 1e18).toFixed(2) : '—';
    const payMOTO = b.payout ? (Number(b.payout) / 1e18).toFixed(2) : '—';
    return `<tr>
      <td>#${b.bet_id}</td>
      <td>${statusBadge}</td>
      <td>${amtMOTO}</td>
      <td>${payMOTO !== '—' ? `<span class="green">${payMOTO}</span>` : '—'}</td>
      <td class="dim">#${b.end_block}</td>
      <td>${shortWallet(b.wallet)}</td>
      <td class="dim">${fmtDate(b.placed_at)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta http-equiv="refresh" content="10"/>
  <title>OP-BET Keeper</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#09090e;color:#d0d0d8;font-family:'Segoe UI',system-ui,sans-serif;font-size:12px;padding:14px 18px}
    a{color:#60a5fa;text-decoration:none} a:hover{text-decoration:underline}
    .dim{color:#444} .green{color:#22c55e} .orange{color:#f7931a} .red{color:#f87171} .blue{color:#60a5fa}

    /* Header */
    .hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
    .hdr h1{font-size:16px;font-weight:700;color:#f7931a;display:flex;align-items:center;gap:8px}
    .hdr .ts{font-size:11px;color:#444}
    .dot{width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block;animation:pulse 2s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

    /* Stat strip */
    .stats{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;margin-bottom:12px}
    @media(max-width:900px){.stats{grid-template-columns:repeat(4,1fr)}}
    .stat{background:#11111c;border:1px solid #1c1c2e;border-radius:7px;padding:9px 10px}
    .stat .lbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.04em;margin-bottom:3px}
    .stat .val{font-size:18px;font-weight:700;color:#fff;line-height:1}
    .stat .val.g{color:#22c55e}.stat .val.o{color:#f7931a}.stat .val.b{color:#60a5fa}
    .stat .sub{font-size:10px;color:#333;margin-top:2px}

    /* Main grid */
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
    @media(max-width:750px){.grid{grid-template-columns:1fr}}
    .panel{background:#11111c;border:1px solid #1c1c2e;border-radius:8px;overflow:hidden}
    .panel-hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #1c1c2e;font-size:10px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.06em}
    .panel-body{padding:10px 12px}

    /* Oracle rows */
    .orow{display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #141420;font-size:11px}
    .orow:last-child{border-bottom:none}
    .orow .k{color:#555}
    .orow .v{font-weight:600}

    /* Sparkline */
    .spark{background:#11111c;border:1px solid #1c1c2e;border-radius:8px;padding:10px 12px;margin-bottom:12px}
    .spark h3{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
    .spark-labels{display:flex;justify-content:space-between;font-size:9px;color:#333;margin-top:3px}

    /* Pills */
    .pill{display:inline-block;background:#0e1829;color:#60a5fa;border:1px solid #1e3a5f;border-radius:3px;padding:1px 5px;font-size:10px;margin:1px}

    /* Tables */
    .tbl-wrap{overflow-x:auto}
    table{width:100%;border-collapse:collapse}
    thead th{color:#444;font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:6px 8px;text-align:left;white-space:nowrap;border-bottom:1px solid #1c1c2e}
    tbody tr{border-top:1px solid #131320}
    tbody tr:hover{background:#0f0f1e}
    tbody td{padding:5px 8px;white-space:nowrap;font-size:11px}

    /* Badges */
    .badge{display:inline-block;padding:1px 6px;border-radius:99px;font-size:10px;font-weight:700;letter-spacing:.03em}
    .badge.active{background:#0e2040;color:#60a5fa}
    .badge.win   {background:#0a2e14;color:#4ade80}
    .badge.loss  {background:#2e0a0a;color:#f87171}
    .badge.oracle{background:#1a1a0a;color:#facc15}
    .badge.resolve{background:#0a2e14;color:#4ade80}

    .footer{font-size:10px;color:#333;margin-top:10px}
    .footer a{color:#222}
  </style>
</head>
<body>

<div class="hdr">
  <h1><span class="dot"></span>OP-BET Keeper</h1>
  <span class="ts">auto-refresh 10s &nbsp;·&nbsp; ${new Date().toUTCString()}</span>
</div>

<!-- Stat strip -->
<div class="stats">
  <div class="stat"><div class="lbl">Uptime</div><div class="val b" style="font-size:14px">${formatUptime(stats.uptime)}</div></div>
  <div class="stat"><div class="lbl">OPNet Block</div><div class="val o">${stats.lastOPNetBlock.toLocaleString()}</div></div>
  <div class="stat"><div class="lbl">Last Feed</div><div class="val">${stats.lastSubmittedBlock.toLocaleString()}</div><div class="sub ${behindColor}">${behind} behind</div></div>
  <div class="stat"><div class="lbl">BTC Fee</div><div class="val g">${stats.latestBtcFee}</div><div class="sub">sat/vB</div></div>
  <div class="stat"><div class="lbl">Mempool</div><div class="val" style="font-size:14px">${stats.latestMempoolCount.toLocaleString()}</div><div class="sub">txs</div></div>
  <div class="stat"><div class="lbl">Bets</div><div class="val o">${stats.betsTotal}</div><div class="sub">${stats.betsActive} active</div></div>
  <div class="stat"><div class="lbl">Feeds</div><div class="val b">${stats.oracleFeedsTotal}</div></div>
  <div class="stat"><div class="lbl">Resolved</div><div class="val g">${stats.resolvedInMemory}</div><div class="sub">this session</div></div>
</div>

<!-- Middle grid: oracle state + bets -->
<div class="grid">
  <!-- Oracle live state -->
  <div class="panel">
    <div class="panel-hdr">
      <span>Oracle State</span>
      <span class="dim">fee stats: avg ${fix2(fs.avg_fee)} · min ${fix2(fs.min_fee)} · max ${fix2(fs.max_fee)} sat/vB</span>
    </div>
    <div class="panel-body">
      <div class="orow"><span class="k">Blocks needed</span><span class="v">${neededHtml}</span></div>
      <div class="orow"><span class="k">Blocks behind</span><span class="v ${behindColor}">${behind}</span></div>
      <div class="orow"><span class="k">Avg mempool</span><span class="v">${fs.avg_mempool != null ? Number(fs.avg_mempool).toLocaleString() : '—'} txs</span></div>
    </div>
  </div>

  <!-- Active bets -->
  <div class="panel">
    <div class="panel-hdr"><span>Recent Bets</span></div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>#</th><th>Status</th><th>Amount</th><th>Payout</th><th>End</th><th>Wallet</th><th>Placed</th></tr></thead>
        <tbody>${betsRows || '<tr><td colspan="7" style="text-align:center;color:#333;padding:12px">No bets</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</div>

<!-- Fee sparkline -->
<div class="spark">
  <h3>BTC Median Fee — last ${stats.recentFeeds.length} submissions</h3>
  ${sparkline(stats.recentFeeds)}
  <div class="spark-labels"><span>oldest</span><span>sat/vB</span><span>latest</span></div>
</div>

<!-- Unified TX log -->
<div class="panel">
  <div class="panel-hdr"><span>Transaction Log</span><span class="dim">oracle feeds + resolves · last 20</span></div>
  <div class="tbl-wrap">
    <table>
      <thead><tr><th>Time</th><th>Type</th><th>Target</th><th>Detail</th><th>TX</th></tr></thead>
      <tbody>${txRows || '<tr><td colspan="5" style="text-align:center;color:#333;padding:12px">No transactions yet</td></tr>'}</tbody>
    </table>
  </div>
</div>

<p class="footer">JSON: <a href="/health">/health</a> &nbsp;·&nbsp; Bets: <a href="/api/bets?wallet=">/api/bets</a></p>
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
        const { betId, wallet, txId, tokenSymbol, contractAddress, betType, param1, param2, amount, endBlock } = body;
        if (!betId || !wallet) {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'betId and wallet are required' }));
          return;
        }
        await registerBetOwner({ betId: Number(betId), wallet, tokenSymbol, contractAddress });

        // Notify Telegram immediately on bet placement (tx just confirmed)
        if (betType !== undefined) {
          const bt = Number(betType);
          const direction = bt === 1 ? (String(param1) === '1' ? 'over' : 'under') : null;
          const threshold = bt === 1 && param2 ? (Number(param2) / 100).toFixed(1) : null;
          notifyEntry({ betId: Number(betId), wallet, txId, direction, threshold, amount, endBlock })
            .catch(err => console.warn('[Telegram] Entry notify error:', err.message));
        }

        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── GET /api/bets?wallet=xxx — fetch bets registered to a wallet ──
      // ── GET /api/bets?ids=1,2,3  — fetch bets by specific IDs (localStorage lookup) ──
      if (req.method === 'GET' && url.pathname === '/api/bets') {
        const wallet = url.searchParams.get('wallet');
        const idsParam = url.searchParams.get('ids');
        const contractAddress = url.searchParams.get('contract') || null;

        let bets;
        if (idsParam) {
          const ids = idsParam.split(',').map(Number).filter(n => !isNaN(n) && n > 0);
          bets = await getBetsByIds(ids, contractAddress);
        } else if (wallet) {
          bets = await getBetsByWallet(wallet, contractAddress);
        } else {
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'wallet or ids query param required' }));
          return;
        }

        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bets));
        return;
      }

      // ── GET /api/bets/recent — latest bets across all wallets (live feed) ──
      if (req.method === 'GET' && url.pathname === '/api/bets/recent') {
        const contract = url.searchParams.get('contract') || null;
        const limit = Math.min(Number(url.searchParams.get('limit') || 20), 50);
        const bets = await getRecentBets(contract, limit);
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bets));
        return;
      }

      // ── GET /api/leaderboard — top 10 wallets by payout ──
      if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
        const contractAddress = url.searchParams.get('contract') || null;
        const contractFilter = contractAddress ? ' AND contract_address = $1' : '';
        const params = contractAddress ? [contractAddress] : [];
        const result = await pool.query(
          `SELECT wallet,
             COUNT(*) FILTER (WHERE won = true)::int  AS wins,
             COUNT(*) FILTER (WHERE won = false)::int AS losses,
             COALESCE(SUM(payout::numeric) FILTER (WHERE won = true), 0)::text AS total_payout
           FROM bets
           WHERE wallet IS NOT NULL${contractFilter}
           GROUP BY wallet
           ORDER BY total_payout::numeric DESC
           LIMIT 10`,
          params,
        );
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.rows));
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
