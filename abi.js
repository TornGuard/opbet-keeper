/**
 * Contract ABIs used by keeper bot.
 * Only includes methods the keeper calls + reads.
 */

export const PRICE_ORACLE_ABI = [
  {
    name: 'updatePrice',
    type: 'function',
    constant: false,
    inputs: [
      { name: 'symbolId', type: 'UINT256' },
      { name: 'price', type: 'UINT256' },
      { name: 'confidence', type: 'UINT256' },
    ],
    outputs: [{ name: 'success', type: 'BOOL' }],
  },
  {
    name: 'getPrice',
    type: 'function',
    constant: true,
    inputs: [{ name: 'symbolId', type: 'UINT256' }],
    outputs: [
      { name: 'price', type: 'UINT256' },
      { name: 'updateBlock', type: 'UINT256' },
      { name: 'confidence', type: 'UINT256' },
      { name: 'isFresh', type: 'BOOL' },
    ],
  },
  {
    name: 'latestPrice',
    type: 'function',
    constant: true,
    inputs: [{ name: 'symbolId', type: 'UINT256' }],
    outputs: [{ name: 'price', type: 'UINT256' }],
  },
  {
    name: 'isFeeder',
    type: 'function',
    constant: true,
    inputs: [{ name: 'feeder', type: 'ADDRESS' }],
    outputs: [{ name: 'authorized', type: 'BOOL' }],
  },
];



export const MARKET_ABI = [
  {
    name: 'setBlockData',
    type: 'function',
    constant: false,
    inputs: [
      { name: 'blockHeight', type: 'UINT256' },
      { name: 'medianFee', type: 'UINT256' },
      { name: 'mempoolCount', type: 'UINT256' },
      { name: 'blockTimestamp', type: 'UINT256' },
    ],
    outputs: [{ name: 'success', type: 'BOOL' }],
  },
  {
    name: 'resolveBet',
    type: 'function',
    constant: false,
    inputs: [{ name: 'betId', type: 'UINT256' }],
    outputs: [
      { name: 'won', type: 'BOOL' },
      { name: 'payout', type: 'UINT256' },
    ],
  },
  {
    name: 'getBetInfo',
    type: 'function',
    constant: true,
    inputs: [{ name: 'betId', type: 'UINT256' }],
    outputs: [
      { name: 'betType', type: 'UINT256' },
      { name: 'param1', type: 'UINT256' },
      { name: 'param2', type: 'UINT256' },
      { name: 'amount', type: 'UINT256' },
      { name: 'odds', type: 'UINT256' },
      { name: 'targetBlock', type: 'UINT256' },
      { name: 'endBlock', type: 'UINT256' },
      { name: 'status', type: 'UINT256' },
      { name: 'payout', type: 'UINT256' },
      { name: 'token', type: 'UINT256' },
    ],
  },
  {
    name: 'getBlockData',
    type: 'function',
    constant: true,
    inputs: [{ name: 'blockHeight', type: 'UINT256' }],
    outputs: [
      { name: 'medianFee', type: 'UINT256' },
      { name: 'mempoolCount', type: 'UINT256' },
      { name: 'blockTimestamp', type: 'UINT256' },
      { name: 'dataSet', type: 'UINT256' },
    ],
  },
  {
    name: 'getNextBetId',
    type: 'function',
    constant: true,
    inputs: [],
    outputs: [{ name: 'nextBetId', type: 'UINT256' }],
  },
  {
    name: 'getCurrentBtcBlock',
    type: 'function',
    constant: true,
    inputs: [],
    outputs: [{ name: 'currentBtcBlock', type: 'UINT256' }],
  },
  {
    name: 'getBetOwner',
    type: 'function',
    constant: true,
    inputs: [{ name: 'betId', type: 'UINT256' }],
    outputs: [{ name: 'owner', type: 'UINT256' }],
  },
  {
    name: 'getPoolInfo',
    type: 'function',
    constant: true,
    inputs: [{ name: 'token', type: 'ADDRESS' }],
    outputs: [
      { name: 'totalPool', type: 'UINT256' },
      { name: 'pendingExposure', type: 'UINT256' },
      { name: 'latestOracleFee', type: 'UINT256' },
    ],
  },
];
