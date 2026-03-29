/**
 * bot-listener.js — Telegram bot command handler
 *
 * Polls for updates and handles commands:
 *   /all  — mentions every tracked member (anyone who has chatted)
 *
 * Members are auto-tracked from all messages seen in the group.
 * Stored in bot-members.json so they persist across restarts.
 *
 * Usage:
 *   node keeper/bot-listener.js
 *   pm2 start bot-listener.js --name bot-listener
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const MEMBERS_FILE = path.join(__dirname, 'bot-members.json');

if (!TOKEN || !CHAT_ID) {
    console.error('[bot-listener] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

// ─── Member store ─────────────────────────────────────────────────────────────

function loadMembers() {
    try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); } catch { return {}; }
}

function saveMembers(members) {
    fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
}

function trackUser(user) {
    if (!user || user.is_bot) return;
    const members = loadMembers();
    members[user.id] = {
        id:         user.id,
        first_name: user.first_name ?? '',
        username:   user.username ?? null,
    };
    saveMembers(members);
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────

async function getUpdates(offset) {
    const res = await fetch(`${API}/getUpdates?timeout=30&offset=${offset ?? ''}`);
    if (!res.ok) return [];
    const j = await res.json();
    return j.ok ? j.result : [];
}

async function sendMessage(chatId, text, entities = []) {
    await fetch(`${API}/sendMessage`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, entities, disable_web_page_preview: true }),
    });
}

// ─── /all command ─────────────────────────────────────────────────────────────

async function handleAll(chatId) {
    const members = loadMembers();
    const list    = Object.values(members);

    if (list.length === 0) {
        await sendMessage(chatId, '👥 No members tracked yet — mention will grow as people chat.');
        return;
    }

    // Build a message that mentions everyone using text_mention entities
    let text     = '👥 ';
    const entities = [];

    for (const m of list) {
        if (m.username) {
            // @username mention
            const mention = `@${m.username}`;
            entities.push({ type: 'mention', offset: text.length, length: mention.length });
            text += mention + ' ';
        } else {
            // text_mention for users without a username
            const name = m.first_name || `User${m.id}`;
            entities.push({ type: 'text_mention', offset: text.length, length: name.length, user: { id: m.id } });
            text += name + ' ';
        }
    }

    await sendMessage(chatId, text.trimEnd(), entities);
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function main() {
    console.log('[bot-listener] 🟢 Started — polling for updates');
    console.log(`[bot-listener] Chat: ${CHAT_ID}`);

    let offset = undefined;

    process.on('SIGINT',  () => { console.log('\n[bot-listener] Stopped'); process.exit(0); });
    process.on('SIGTERM', () => { console.log('\n[bot-listener] Stopped'); process.exit(0); });

    while (true) {
        try {
            const updates = await getUpdates(offset);

            for (const update of updates) {
                offset = update.update_id + 1;
                const msg = update.message ?? update.channel_post;
                if (!msg) continue;

                // Track every user we see
                if (msg.from) trackUser(msg.from);
                if (msg.new_chat_members) msg.new_chat_members.forEach(trackUser);

                // Only handle commands in our chat
                if (String(msg.chat?.id) !== String(CHAT_ID)) continue;

                const text = msg.text ?? '';
                const cmd  = text.split(' ')[0].split('@')[0]; // strip bot name suffix

                if (cmd === '/all') {
                    console.log(`[bot-listener] /all triggered by ${msg.from?.username ?? msg.from?.first_name}`);
                    await handleAll(CHAT_ID);
                }
            }
        } catch (e) {
            console.warn('[bot-listener] Poll error:', e.message);
            await sleep(5000);
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main();
