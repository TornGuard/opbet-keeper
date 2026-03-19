/**
 * Health HTTP server for OP-BET Keeper.
 * Exposes GET /health on PORT (default 3000).
 */

import http from 'http';
import { pool } from './db.js';

export function startHealthServer(oracle, resolver) {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    try {
      const [betsResult, feedsResult] = await Promise.all([
        pool.query('SELECT COUNT(*) FROM bets'),
        pool.query('SELECT COUNT(*) FROM oracle_feeds'),
      ]);

      const payload = {
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        lastOPNetBlock: oracle.lastKnownOPNetBlock,
        lastSubmittedBlock: oracle.lastSubmittedHeight,
        latestBtcFee: oracle.latestBtcFee,
        latestMempoolCount: oracle.latestMempoolCount,
        betsTotal: Number(betsResult.rows[0].count),
        oracleFeedsTotal: Number(feedsResult.rows[0].count),
        resolvedIds: resolver.resolvedIds.size,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: err.message }));
    }
  });

  server.listen(port, () => {
    console.log(`[Health] Listening on http://0.0.0.0:${port}/health`);
  });
}
