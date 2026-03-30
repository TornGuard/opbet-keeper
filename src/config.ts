/**
 * Keeper Bot Configuration
 *
 * All secrets are loaded from environment variables (or a .env file).
 * NEVER hardcode MNEMONIC, DEPLOYER_WIF, or DATABASE_URL here.
 */

import 'dotenv/config';

export interface KeeperConfig {
    readonly rpcUrl: string;
    readonly marketAddress: string;
    readonly deployerWif: string;
    readonly mnemonic: string;
    readonly databaseUrl: string;
    readonly mempoolRestEndpoints: readonly string[];
    readonly mempoolMainnetEndpoints: readonly string[];
    readonly resolveScanInterval: number;
    readonly restPollInterval: number;
    readonly feeRate: number;
    readonly maxSatsPerTx: bigint;
    readonly priceOracleAddress: string;
    readonly blockfeedApiUrl: string;
    readonly port: number;
    readonly telegramBotToken: string;
    readonly telegramChatId: string;
}

export const CONFIG: KeeperConfig = {
    rpcUrl: process.env['OPNET_RPC_URL'] ?? 'https://testnet.opnet.org',
    marketAddress: process.env['MARKET_ADDRESS'] ?? 'opt1sqqht90a38syqu7l7rcaf2ttveulsn9l57q3kyng7',
    deployerWif: process.env['DEPLOYER_WIF'] ?? '',
    mnemonic: process.env['MNEMONIC'] ?? '',
    databaseUrl: process.env['DATABASE_URL'] ?? '',
    mempoolRestEndpoints: ['https://mempool.space/signet/api'],
    mempoolMainnetEndpoints: [
        'https://mempool.space/api',
        'https://mempool.ninja/api',
    ],
    resolveScanInterval: 30_000,
    restPollInterval: 15_000,
    feeRate: Number(process.env['FEE_RATE'] ?? 10),
    maxSatsPerTx: 100_000n,
    priceOracleAddress: process.env['PRICE_ORACLE_ADDRESS'] ?? '',
    blockfeedApiUrl: process.env['BLOCKFEED_API_URL'] ?? 'http://localhost:3001',
    port: Number(process.env['PORT'] ?? 3000),
    telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'] ?? '',
    telegramChatId: process.env['TELEGRAM_CHAT_ID'] ?? '',
};
