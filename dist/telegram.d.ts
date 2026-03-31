/**
 * Telegram notifier for OP-BET Keeper.
 * Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars to enable.
 */
export declare function notifyStartup(): Promise<void>;
export declare function notifyEntry(opts: {
    betId: number;
    wallet: string | null;
    txId: string | null;
    betType: number | bigint;
    param1: number | bigint;
    param2: number | bigint;
    amount: number | bigint | null;
    endBlock: number | null;
    tokenSymbol: string | null;
}): Promise<void>;
export declare function notifyWin(opts: {
    betId: number;
    wallet: string | null;
    payout: string;
    direction: string | null;
    threshold: string | null;
    tokenSymbol: string | null;
}): Promise<void>;
export declare function notifyStreak(opts: {
    wallet: string;
    streak: number;
}): Promise<void>;
