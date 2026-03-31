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
export declare const CONFIG: KeeperConfig;
