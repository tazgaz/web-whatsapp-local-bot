const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { handleMessage } = require('./messageHandler');
const { initScheduler } = require('./scheduler');
const QRCode = require('qrcode');
const { readJSON, writeJSON } = require('./utils');

const app = express();
const server = http.createServer(app);
const activeSessions = {}; // { id: { client, status, qr } }
const io = new Server(server);
const port = 3000;

io.on('connection', (socket) => {
    console.log('[Socket] New client connected');
    const sessionData = Object.keys(activeSessions).map(id => ({
        id,
        status: activeSessions[id].status,
        qr: activeSessions[id].qr
    }));
    socket.emit('init_sessions', sessionData);
});

app.use(express.json());
app.use(express.static('public'));

// Sessions management
const SESSIONS_FILE = './sessions.json';
if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(['default'], null, 2));
}

// Contacts Cache for learning names
let contactsCache = {};
const CONTACTS_CACHE_PATH = path.join(__dirname, 'contacts_cache.json');

function loadContactsCache() {
    try {
        if (fs.existsSync(CONTACTS_CACHE_PATH)) {
            contactsCache = JSON.parse(fs.readFileSync(CONTACTS_CACHE_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading contacts cache:', e);
    }
}

function saveContactsCache() {
    try {
        fs.writeFileSync(CONTACTS_CACHE_PATH, JSON.stringify(contactsCache, null, 2));
    } catch (e) {
        console.error('Error saving contacts cache:', e);
    }
}

function updateContactCache(number, name) {
    if (!number || !name || name === number) return;
    // Don't overwrite if it's "׳׳׳ ׳©׳" or something generic
    if (['׳׳׳ ׳©׳', '׳׳ ׳ ׳׳¦׳', 'null', 'undefined'].includes(name)) return;

    if (contactsCache[number] !== name) {
        contactsCache[number] = name;
        saveContactsCache();
    }
}

loadContactsCache();

// Helper to get name from cache or contact object
async function resolveBestName(client, id) {
    const number = id.user;

    // 1. Check local cache first
    if (contactsCache[number]) return contactsCache[number];

    try {
        const contact = await client.getContactById(id._serialized);
        const name = contact.name || contact.pushname || contact.shortName;

        if (name) {
            updateContactCache(number, name);
            return name;
        }
    } catch (e) { }

    return "";
}

async function resolveSenderNumberForLog(client, msg) {
    if (msg.fromMe) return 'Me';
    const jid = msg.author || msg.from || '';
    if (!jid) return '';

    try {
        const contact = await msg.getContact();
        if (contact && contact.number) return contact.number;
        if (contact && contact.id && contact.id.user) return contact.id.user;
    } catch (e) { }

    try {
        const contact = await client.getContactById(jid);
        if (contact && contact.number) return contact.number;
        if (contact && contact.id && contact.id.user) return contact.id.user;
    } catch (e) { }

    const rawFallback =
        (msg._data && msg._data.id && msg._data.id.participant) ||
        (msg._data && msg._data.participant && msg._data.participant.user) ||
        (msg._data && msg._data.from && msg._data.from.user) ||
        jid;

    return String(rawFallback).split('@')[0];
}



// Stats management
const STATS_FILE = './stats.json';
if (!fs.existsSync(STATS_FILE)) {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ sessions: {} }, null, 2));
}
const GROUP_WELCOME_MESSAGES_FILE = path.join(__dirname, 'configs', 'group_welcome_messages.json');
if (!fs.existsSync('./configs')) {
    fs.mkdirSync('./configs');
}
if (!fs.existsSync(GROUP_WELCOME_MESSAGES_FILE)) {
    fs.writeFileSync(GROUP_WELCOME_MESSAGES_FILE, JSON.stringify({ sessions: {} }, null, 2));
}
const MISSILE_ALERTS_FILE = './missile_alerts.json';
if (!fs.existsSync(MISSILE_ALERTS_FILE)) {
    fs.writeFileSync(MISSILE_ALERTS_FILE, JSON.stringify({ sessions: {} }, null, 2));
}

// Migration helper
function getStats() {
    const stats = readJSON(STATS_FILE, { sessions: {} });
    if (!stats.sessions) stats.sessions = {};

    // Migrate old format if exists
    if (stats.daily) {
        if (!stats.sessions.default) stats.sessions.default = { daily: stats.daily, triggers: stats.triggers || {} };
        delete stats.daily;
        delete stats.triggers;
        writeJSON(STATS_FILE, stats);
    }
    return stats;
}

function updateStats(sessionId, type, trigger = null) {
    try {
        const stats = getStats();
        if (!stats.sessions[sessionId]) stats.sessions[sessionId] = { daily: {}, triggers: {} };

        const sessionStats = stats.sessions[sessionId];
        const today = new Date().toISOString().split('T')[0];

        if (!sessionStats.daily[today]) sessionStats.daily[today] = { received: 0, replied: 0 };

        if (type === 'received') sessionStats.daily[today].received++;
        if (type === 'replied') sessionStats.daily[today].replied++;

        if (trigger) {
            sessionStats.triggers[trigger] = (sessionStats.triggers[trigger] || 0) + 1;
        }

        writeJSON(STATS_FILE, stats);
        io.emit('stats_update', stats);
    } catch (err) {
        console.error('Error updating stats:', err);
    }
}

function getMissileAlertsStore() {
    const store = readJSON(MISSILE_ALERTS_FILE, { sessions: {} });
    if (!store.sessions) store.sessions = {};

    // Migration helper for legacy flat format
    if (Array.isArray(store.alerts)) {
        if (!store.sessions.default) store.sessions.default = { alerts: [] };
        store.sessions.default.alerts = store.sessions.default.alerts.concat(store.alerts);
        delete store.alerts;
        writeJSON(MISSILE_ALERTS_FILE, store);
    }

    return store;
}

function getJerusalemDateKey(date) {
    return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
}

function normalizeAlertCity(city) {
    if (typeof city !== 'string') return '';
    return city.trim().replace(/\s+/g, ' ');
}

function parseAlertTimestamp(timestamp) {
    if (!timestamp) return new Date();
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function normalizeGroupId(groupId) {
    if (typeof groupId !== 'string') return '';
    const trimmed = groupId.trim();
    if (!trimmed) return '';
    return trimmed.includes('@') ? trimmed : `${trimmed}@g.us`;
}

function getGroupWelcomeMessagesStore() {
    const store = readJSON(GROUP_WELCOME_MESSAGES_FILE, { sessions: {} });
    if (!store.sessions) store.sessions = {};
    return store;
}

function getGroupWelcomeMessage(sessionId, groupId) {
    const sid = sessionId || 'default';
    const normalizedGroupId = normalizeGroupId(groupId);
    if (!normalizedGroupId) return { enabled: false, message: '' };

    const store = getGroupWelcomeMessagesStore();
    const sessionData = store.sessions[sid] || {};
    const groups = sessionData.groups || {};
    const settings = groups[normalizedGroupId] || {};

    return {
        enabled: !!settings.enabled,
        message: typeof settings.message === 'string' ? settings.message : ''
    };
}

function setGroupWelcomeMessage(sessionId, groupId, payload = {}) {
    const sid = sessionId || 'default';
    const normalizedGroupId = normalizeGroupId(groupId);
    if (!normalizedGroupId) return false;

    const store = getGroupWelcomeMessagesStore();
    if (!store.sessions[sid]) store.sessions[sid] = {};
    if (!store.sessions[sid].groups) store.sessions[sid].groups = {};

    store.sessions[sid].groups[normalizedGroupId] = {
        enabled: !!payload.enabled,
        message: typeof payload.message === 'string' ? payload.message : '',
        updatedAt: new Date().toISOString()
    };

    writeJSON(GROUP_WELCOME_MESSAGES_FILE, store);
    return true;
}

function recordMissileAlert(sessionId, city, timestamp, extra = {}) {
    const store = getMissileAlertsStore();
    if (!store.sessions[sessionId]) store.sessions[sessionId] = { alerts: [] };
    if (!Array.isArray(store.sessions[sessionId].alerts)) store.sessions[sessionId].alerts = [];

    const alertEntry = {
        city,
        timestamp: timestamp.toISOString(),
        createdAt: new Date().toISOString(),
        ...extra
    };

    store.sessions[sessionId].alerts.push(alertEntry);
    writeJSON(MISSILE_ALERTS_FILE, store);
    return alertEntry;
}

function getMissileAlertStats(sessionId, windowMinutes = 10) {
    const store = getMissileAlertsStore();
    const sessionData = store.sessions[sessionId] || { alerts: [] };
    const alerts = Array.isArray(sessionData.alerts) ? sessionData.alerts : [];
    const windowMs = Math.max(1, Number(windowMinutes) || 10) * 60 * 1000;

    const grouped = new Map();
    let totalRawAlerts = 0;

    for (const alert of alerts) {
        const city = normalizeAlertCity(alert.city);
        const parsedTime = parseAlertTimestamp(alert.timestamp);
        if (!city || !parsedTime) continue;

        totalRawAlerts++;
        const dayKey = getJerusalemDateKey(parsedTime);
        const key = `${dayKey}__${city}`;

        if (!grouped.has(key)) {
            grouped.set(key, { date: dayKey, city, timestamps: [], rawAlerts: 0 });
        }

        const bucket = grouped.get(key);
        bucket.timestamps.push(parsedTime.getTime());
        bucket.rawAlerts++;
    }

    const rows = [];
    let totalGroupedEvents = 0;

    for (const bucket of grouped.values()) {
        bucket.timestamps.sort((a, b) => a - b);

        let eventCount = 0;
        let lastCountedAt = null;
        for (const ts of bucket.timestamps) {
            if (lastCountedAt === null || ts - lastCountedAt > windowMs) {
                eventCount++;
                lastCountedAt = ts;
            }
        }

        totalGroupedEvents += eventCount;
        rows.push({
            date: bucket.date,
            city: bucket.city,
            rawAlerts: bucket.rawAlerts,
            eventCount
        });
    }

    rows.sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        if (a.city !== b.city) return a.city.localeCompare(b.city, 'he');
        return b.eventCount - a.eventCount;
    });

    return {
        sessionId,
        windowMinutes: Math.max(1, Number(windowMinutes) || 10),
        totalRawAlerts,
        totalGroupedEvents,
        rows
    };
}

function countHebrewChars(text) {
    if (!text) return 0;
    const m = text.match(/[\u0590-\u05FF]/g);
    return m ? m.length : 0;
}

function maybeFixMojibake(text) {
    if (typeof text !== 'string' || !text) return text;
    const suspicious = /[\u0080-\u009F]/.test(text) || text.includes('׳') || text.includes('Ã') || text.includes('Â');
    let out = text;
    if (!suspicious) return out;
    try {
        const fixed = Buffer.from(out, 'latin1').toString('utf8');
        if (countHebrewChars(fixed) >= countHebrewChars(out)) {
            out = fixed;
        }
    } catch (e) { }

    // Remove common mojibake artifacts that remain after decoding attempts.
    out = out
        .replace(/[\u0080-\u009F\uFFFD]/g, '')
        .replace(/[©™]/g, '')
        .replace(/\u05F3/g, '') // Hebrew geresh artifacts repeated between letters
        .replace(/^[\u0590-\u05FF]\s+(?=[\u0590-\u05FF])/u, '') // drop broken leading char from emoji bytes
        .replace(/\s{2,}/g, ' ')
        .trim();

    return out || text;
}

function logToUI(sessionId, msg) {
    const safeMsg = maybeFixMojibake(String(msg));
    const formattedMsg = `[${sessionId}] ${safeMsg}`;
    console.log(formattedMsg);

    // Save to file
    try {
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

        const logFile = path.join(logsDir, `session-${sessionId}.log`);
        const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        fs.appendFileSync(logFile, `[${timestamp}] ${safeMsg}\n`, 'utf8');
    } catch (err) {
        console.error('Error saving log:', err);
    }

    io.emit('log', { sessionId, message: safeMsg });
}

function isTransientBrowserError(err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    return msg.includes('Protocol error') ||
        msg.includes('Session closed') ||
        msg.includes('Target closed') ||
        msg.includes('Execution context was destroyed');
}

// Keep the API process alive when Chromium/puppeteer throws transient errors.
process.on('unhandledRejection', (reason) => {
    if (isTransientBrowserError(reason)) {
        console.warn('[Process] Ignored transient browser rejection:', reason?.message || reason);
        return;
    }
    console.error('[Process] Unhandled rejection:', reason);
});

if (typeof process.setUncaughtExceptionCaptureCallback === 'function') {
    process.setUncaughtExceptionCaptureCallback((err) => {
        if (isTransientBrowserError(err)) {
            console.warn('[Process] Ignored transient browser exception:', err?.message || err);
            return;
        }
        console.error('[Process] Fatal uncaught exception:', err);
        process.exit(1);
    });
} else {
    process.on('uncaughtException', (err) => {
        if (isTransientBrowserError(err)) {
            console.warn('[Process] Ignored transient browser exception:', err?.message || err);
            return;
        }
        console.error('[Process] Fatal uncaught exception:', err);
        process.exit(1);
    });
}

function updateSessionStatus(sessionId, status, qr = null) {
    if (activeSessions[sessionId]) {
        activeSessions[sessionId].status = status;
        activeSessions[sessionId].lastStatusChange = Date.now();
        if (qr !== null) {
            activeSessions[sessionId].qr = qr;
        }
        io.emit('status', { sessionId, status, qr: activeSessions[sessionId].qr });
    }
}

function startSession(sessionId) {
    if (activeSessions[sessionId]) return activeSessions[sessionId];

    logToUI(sessionId, `נ€ ׳׳×׳—׳™׳ ׳׳×׳—׳•׳ ׳“׳₪׳“׳₪׳ ׳¢׳‘׳•׳¨ ${sessionId}...`);

    // Clean stale locks that prevent Chromium from starting
    try {
        const sessionPath = path.resolve(__dirname, '.wwebjs_auth', `session-${sessionId}`);
        if (fs.existsSync(sessionPath)) {
            const files = fs.readdirSync(sessionPath);
            for (const file of files) {
                if (file.includes('Singleton') || file === 'DevToolsActivePort') {
                    try { fs.unlinkSync(path.join(sessionPath, file)); } catch (e) { }
                }
            }
        }
    } catch (e) { }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-extensions',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote'
            ]
        },
        // Prevent marking messages as read
        defaultReadReceiptsDisabled: true
    });

    activeSessions[sessionId] = {
        client,
        status: 'INITIALIZING',
        qr: '',
        lastStatusChange: Date.now(),
        schedulerInitialized: false
    };

    const markReady = () => {
        const s = activeSessions[sessionId];
        if (!s) return;
        if (!s.schedulerInitialized) {
            s.schedulerInitialized = true;
            initScheduler(client);
        }
        updateSessionStatus(sessionId, 'READY', '');
    };

    // Watchdog Timer: Protect against 99% Stuck Issues
    // If not ready/QR within 3 minutes, force restart
    setTimeout(async () => {
        const s = activeSessions[sessionId];
        if (s && (s.status.startsWith('LOADING') || s.status === 'INITIALIZING')) {
            logToUI(sessionId, 'ג ן¸ ׳–׳•׳”׳×׳” ׳×׳§׳™׳¢׳” ׳‘׳˜׳¢׳™׳ ׳” (Watchdog). ׳׳‘׳¦׳¢ ׳׳×׳—׳•׳ ׳׳•׳˜׳•׳׳˜׳™...');
            try {
                await s.client.destroy();
            } catch (e) { }
            delete activeSessions[sessionId];
            startSession(sessionId); // Retry
        }
    }, 180000); // 3 Minutes

    io.emit('status', { sessionId, status: 'INITIALIZING' });

    client.on('qr', async (qr) => {
        logToUI(sessionId, 'ג“ ׳§׳•׳“ QR ׳”׳×׳§׳‘׳. ׳¡׳¨׳•׳§ ׳׳”׳“׳₪׳“׳₪׳.');
        const qrDataURL = await QRCode.toDataURL(qr);
        updateSessionStatus(sessionId, 'QR_RECEIVED', qrDataURL);
    });

    client.on('ready', () => {
        logToUI(sessionId, 'ג“ ׳•׳•׳׳˜׳¡׳׳₪ ׳׳•׳›׳ ׳׳₪׳¢׳•׳׳”!');
        // ׳₪׳׳˜׳¥' ׳׳×׳™׳§׳•׳ ׳©׳’׳™׳׳•׳× ׳₪׳ ׳™׳׳™׳•׳× ׳©׳ ׳•׳•׳׳˜׳¡׳׳₪ (markedUnread)
        client.pupPage.evaluate(() => {
            if (window.WWebJS) {
                const originalSendSeen = window.WWebJS.sendSeen;
                window.WWebJS.sendSeen = async (chatId) => {
                    try {
                        if (originalSendSeen) return await originalSendSeen(chatId);
                    } catch (e) { }
                    return true;
                };
            }
        }).catch(() => { });

        markReady();
    });

    client.on('loading_screen', (percent, message) => {
        logToUI(sessionId, `׳˜׳•׳¢׳: ${percent}% - ${message}`);
        updateSessionStatus(sessionId, `LOADING (${percent}%)`);
    });

    client.on('change_state', (state) => {
        logToUI(sessionId, `State changed: ${state}`);
        if (state === 'CONNECTED') {
            markReady();
        }
    });

    client.on('authenticated', () => {
        logToUI(sessionId, 'ג“ ׳”׳×׳—׳‘׳¨׳•׳× ׳‘׳•׳¦׳¢׳” ׳‘׳”׳¦׳׳—׳”!');
        updateSessionStatus(sessionId, 'AUTHENTICATED');

        // Fallback: some environments authenticate but delay/miss the "ready" event.
        setTimeout(async () => {
            const s = activeSessions[sessionId];
            if (!s || s.status === 'READY') return;
            try {
                const state = await client.getState();
                logToUI(sessionId, `Post-auth state check: ${state}`);
                if (state === 'CONNECTED') {
                    markReady();
                }
            } catch (err) {
                logToUI(sessionId, `Post-auth state check failed: ${err.message}`);
            }
        }, 10000);
    });

    client.on('auth_failure', (msg) => {
        logToUI(sessionId, `ג— ׳©׳’׳™׳׳× ׳”׳×׳—׳‘׳¨׳•׳×: ${msg}`);
        updateSessionStatus(sessionId, 'AUTH_FAILURE');
    });

    client.on('group_join', async (notification) => {
        try {
            const joinType = notification && notification.type ? String(notification.type) : '';
            const groupId = normalizeGroupId(notification && notification.chatId ? notification.chatId : '');
            const recipients = Array.isArray(notification.recipientIds) ? notification.recipientIds : [];
            logToUI(sessionId, `נ‘¥ group_join event: type=${joinType || 'unknown'} group=${groupId || 'unknown'} recipients=${recipients.length}`);

            const isInviteJoin = joinType === 'invite' || joinType === 'linked_group_join' || joinType === 'add';
            if (!isInviteJoin) return;

            if (!groupId) return;

            const welcome = getGroupWelcomeMessage(sessionId, groupId);
            if (!welcome.enabled || !welcome.message.trim()) return;

            if (recipients.length === 0) return;

            const botId = client.info && client.info.wid ? client.info.wid._serialized : '';
            const uniqueRecipients = [...new Set(recipients)]
                .filter(rid => typeof rid === 'string' && !rid.endsWith('@g.us') && rid !== botId);

            if (uniqueRecipients.length === 0) return;

            for (const recipientId of uniqueRecipients) {
                try {
                    await client.sendMessage(recipientId, welcome.message, { sendSeen: false });
                    logToUI(sessionId, `נ‘‹ Welcome DM sent to ${recipientId} for group ${groupId} (join via link).`);
                } catch (sendErr) {
                    logToUI(sessionId, `ג ן¸ Failed sending welcome DM to ${recipientId}: ${sendErr.message}`);
                }
            }
        } catch (err) {
            logToUI(sessionId, `ג ן¸ group_join handler error: ${err.message}`);
        }
    });

    client.on('message_create', async (msg) => {
        try {
            // Safer way to get sender name without calling getContact() which is failing
            const senderNum = await resolveSenderNumberForLog(client, msg);
            let senderName = msg.fromMe ? '׳׳ ׳™' : (msg._data.notifyName || senderNum);
            const senderJid = msg.author || msg.from || '';

            // Learn name from message metadata
            if (!msg.fromMe && msg._data.notifyName) {
                const actualSenderNum = senderNum;
                updateContactCache(actualSenderNum, msg._data.notifyName);
            }

            if (senderName !== senderNum && senderNum !== 'Me') {
                senderName += ` (${senderNum})`;
            }

            let groupInfo = '';

            try {
                const chat = await msg.getChat();
                if (chat && chat.isGroup) {
                    const groupId = chat.id.user || chat.id._serialized.split('@')[0];
                    groupInfo = ` [׳§׳‘׳•׳¦׳”: ${chat.name} (${groupId})]`;
                }
            } catch (chatError) {
                // If getChat fails, we just don't show group info
            }

            const jidInfo = senderJid ? ` [jid: ${senderJid}]` : '';
            logToUI(sessionId, `נ“© ׳”׳•׳“׳¢׳” ׳-${senderName}${groupInfo}${jidInfo}: ${msg.body}`);

            if (!msg.fromMe) updateStats(sessionId, 'received');

            const result = await handleMessage(msg, client, sessionId, (logMsg) => {
                logToUI(sessionId, logMsg);
            });

            if (result && result.replied) {
                updateStats(sessionId, 'replied', result.trigger);
            }
        } catch (err) {
            logToUI(sessionId, `ג— ׳©׳’׳™׳׳” ׳‘׳˜׳™׳₪׳•׳ ׳‘׳”׳•׳“׳¢׳”: ${err.message}`);
        }
    });

    client.on('disconnected', (reason) => {
        logToUI(sessionId, `ג— ׳•׳•׳׳˜׳¡׳׳₪ ׳”׳×׳ ׳×׳§: ${reason}`);
        updateSessionStatus(sessionId, 'DISCONNECTED');

        // Auto-reconnect after 5 seconds
        logToUI(sessionId, 'נ”„ ׳׳ ׳¡׳” ׳׳”׳×׳—׳‘׳¨ ׳׳—׳“׳© ׳‘׳¢׳•׳“ 5 ׳©׳ ׳™׳•׳×...');
        setTimeout(async () => {
            try {
                await client.destroy();
            } catch (e) { }
            delete activeSessions[sessionId];
            startSession(sessionId);
        }, 5000);
    });

    client.initialize().catch(err => {
        logToUI(sessionId, `ג— ׳©׳’׳™׳׳× ׳׳×׳—׳•׳: ${err.message}`);
    });

    return activeSessions[sessionId];
}

// Initialize saved sessions
const savedSessions = readJSON(SESSIONS_FILE, ['default']);
savedSessions.forEach(id => startSession(id));

// Periodic Health Check - runs every 5 minutes
setInterval(async () => {
    for (const sessionId in activeSessions) {
        const session = activeSessions[sessionId];

        // Check if session is stuck or not ready for too long
        if (session.status !== 'READY' && session.status !== 'QR_RECEIVED') {
            const statusAge = Date.now() - (session.lastStatusChange || 0);

            // If stuck for more than 10 minutes, restart
            if (statusAge > 10 * 60 * 1000) {
                logToUI(sessionId, 'ג ן¸ ׳¡׳©׳ ׳×׳§׳•׳¢ - ׳׳‘׳¦׳¢ ׳¨׳™׳¡׳˜׳¨׳˜ ׳׳•׳˜׳•׳׳˜׳™...');
                try {
                    await session.client.destroy();
                } catch (e) { }
                delete activeSessions[sessionId];
                startSession(sessionId);
            }
        }

        // Ping the client to keep it alive
        if (session.status === 'READY') {
            try {
                await session.client.getState();
            } catch (err) {
                logToUI(sessionId, `ג ן¸ ׳¡׳©׳ ׳׳ ׳׳’׳™׳‘ - ׳׳‘׳¦׳¢ ׳¨׳™׳¡׳˜׳¨׳˜: ${err.message}`);
                try {
                    await session.client.destroy();
                } catch (e) { }
                delete activeSessions[sessionId];
                startSession(sessionId);
            }
        }
    }
}, 5 * 60 * 1000); // Every 5 minutes


// APIs
app.get('/api/sessions', (req, res) => {
    const sessionData = Object.keys(activeSessions).map(id => ({
        id,
        status: activeSessions[id].status,
        qr: activeSessions[id].qr
    }));
    res.json(sessionData);
});

app.post('/api/sessions', (req, res) => {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'Session ID is required' });

    // Sanitize the session ID - only allow alphanumeric, underscores, and hyphens
    const sanitizedId = id.replace(/[^a-zA-Z0-9_-]/g, '_');

    if (!sanitizedId) {
        return res.status(400).json({ error: 'Invalid session ID. Please use English letters, numbers, underscores, or hyphens only.' });
    }

    if (activeSessions[sanitizedId]) {
        return res.status(400).json({ error: 'Session already exists' });
    }

    startSession(sanitizedId);

    // Save to file
    const sessions = readJSON(SESSIONS_FILE, []);
    if (!sessions.includes(sanitizedId)) {
        sessions.push(sanitizedId);
        writeJSON(SESSIONS_FILE, sessions);
    }

    res.json({ success: true, id: sanitizedId });
});

app.delete('/api/sessions/:id', async (req, res) => {
    const { id } = req.params;
    if (!activeSessions[id]) return res.status(404).json({ error: 'Session not found' });

    try {
        await activeSessions[id].client.logout();
    } catch (e) { }

    delete activeSessions[id];

    const sessions = readJSON(SESSIONS_FILE, []);
    const updated = sessions.filter(s => s !== id);
    writeJSON(SESSIONS_FILE, updated);

    res.json({ success: true });
});

app.post('/api/sessions/rename', async (req, res) => {
    const { oldId, newId } = req.body;

    if (!oldId || !newId) return res.status(400).json({ error: 'Missing oldId or newId' });
    if (!activeSessions[oldId]) return res.status(404).json({ error: 'Session not found' });
    if (activeSessions[newId]) return res.status(409).json({ error: 'New session ID already exists' });

    try {
        logToUI(oldId, `נ”„ ׳׳©׳ ׳” ׳©׳ ׳׳—׳©׳‘׳•׳ ׳-${oldId} ׳-${newId}...`);

        // 1. Destroy old client
        try {
            await activeSessions[oldId].client.destroy();
        } catch (e) {
            console.error('Error destroying client:', e);
        }
        delete activeSessions[oldId];

        // 2. Rename Auth Folder
        const oldAuthPath = path.join(__dirname, '.wwebjs_auth', `session-${oldId}`);
        const newAuthPath = path.join(__dirname, '.wwebjs_auth', `session-${newId}`);
        if (fs.existsSync(oldAuthPath)) {
            fs.renameSync(oldAuthPath, newAuthPath);
        }

        // 3. Rename Config File
        const oldConfigPath = path.join(__dirname, 'configs', `session-${oldId}.json`);
        const newConfigPath = path.join(__dirname, 'configs', `session-${newId}.json`);
        if (fs.existsSync(oldConfigPath)) {
            fs.renameSync(oldConfigPath, newConfigPath);
        }

        // 3.5 Rename Log File
        const oldLogFile = path.join(__dirname, 'logs', `session-${oldId}.log`);
        const newLogFile = path.join(__dirname, 'logs', `session-${newId}.log`);
        if (fs.existsSync(oldLogFile)) {
            fs.renameSync(oldLogFile, newLogFile);
        }

        // 4. Update Sessions List
        const sessions = readJSON(SESSIONS_FILE, []);
        const updatedSessions = sessions.map(s => s === oldId ? newId : s);
        writeJSON(SESSIONS_FILE, updatedSessions);

        // 5. Update User States (Optional but good practice)
        const STATES_FILE = './user_states.json';
        const userStates = readJSON(STATES_FILE, {});
        const newUserStates = {};
        Object.keys(userStates).forEach(key => {
            if (key.startsWith(`${oldId}_`)) {
                const newKey = key.replace(`${oldId}_`, `${newId}_`);
                newUserStates[newKey] = userStates[key];
            } else {
                newUserStates[key] = userStates[key];
            }
        });
        writeJSON(STATES_FILE, newUserStates);

        // 6. Initialize New Session
        startSession(newId);

        res.json({ success: true });
    } catch (err) {
        logToUI(oldId, `ג— ׳©׳’׳™׳׳” ׳‘׳©׳™׳ ׳•׳™ ׳©׳: ${err.message}`);
        res.json({
            success: true,
            groups: [],
            degraded: true,
            warning: err.message
        });
    }
});

app.get('/api/config', (req, res) => {
    try {
        const sessionId = req.query.sessionId || 'default';
        const configPath = `./configs/session-${sessionId}.json`;

        // Create configs directory if it doesn't exist
        if (!fs.existsSync('./configs')) {
            fs.mkdirSync('./configs');
        }

        const config = readJSON(configPath, { autoReplies: [], forwarding: [], scheduledMessages: [], groupMessageRotations: [] });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read config' });
    }
});

app.post('/api/config', (req, res) => {
    try {
        const sessionId = req.query.sessionId || req.body.sessionId || 'default';
        const configPath = `./configs/session-${sessionId}.json`;

        // Create configs directory if it doesn't exist
        if (!fs.existsSync('./configs')) {
            fs.mkdirSync('./configs');
        }

        const existingConfig = readJSON(configPath, { autoReplies: [], forwarding: [], scheduledMessages: [], groupMessageRotations: [] });

        // Remove sessionId from body if present to avoid saving it
        const configData = { ...req.body };
        delete configData.sessionId;

        const mergedConfig = { ...existingConfig, ...configData };
        writeJSON(configPath, mergedConfig);
        logToUI('system', `ג™ן¸ ׳”׳’׳“׳¨׳•׳× ׳¢׳•׳“׳›׳ ׳• ׳‘׳”׳¦׳׳—׳” ׳¢׳‘׳•׳¨ ${sessionId}.`);

        const session = activeSessions[sessionId];
        if (session && session.status === 'READY') {
            initScheduler(session.client, logToUI);
        }
        res.json({ success: true });
    } catch (err) {
        logToUI('system', `ג— ׳©׳’׳™׳׳” ׳‘׳©׳׳™׳—׳× ׳”׳’׳“׳¨׳•׳×: ${err.message}`);
        res.json({
            success: true,
            groups: [],
            degraded: true,
            warning: err.message
        });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        const stats = getStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read stats' });
    }
});

app.post('/api/missile-alerts', (req, res) => {
    try {
        const { sessionId, city, cities, timestamp, source } = req.body || {};
        const sid = sessionId || 'default';
        const parsedTimestamp = parseAlertTimestamp(timestamp);

        if (!parsedTimestamp) {
            return res.status(400).json({ error: 'Invalid timestamp format' });
        }

        const incomingCities = Array.isArray(cities) ? cities : [city];
        const normalizedCities = incomingCities
            .map(normalizeAlertCity)
            .filter(Boolean);

        if (normalizedCities.length === 0) {
            return res.status(400).json({ error: 'city or cities[] is required' });
        }

        const extra = typeof source === 'string' && source.trim()
            ? { source: source.trim() }
            : {};

        const entries = normalizedCities.map(cityName =>
            recordMissileAlert(sid, cityName, parsedTimestamp, extra)
        );

        const stats = getMissileAlertStats(sid, 10);
        io.emit('missile_alerts_update', { sessionId: sid, stats });

        res.json({
            success: true,
            sessionId: sid,
            recorded: entries.length,
            entries,
            stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message || 'Failed to record missile alert' });
    }
});

app.get('/api/missile-alert-stats', (req, res) => {
    try {
        const sid = req.query.sessionId || 'default';
        const requestedWindow = Number(req.query.windowMinutes);
        const windowMinutes = Number.isFinite(requestedWindow) && requestedWindow > 0
            ? Math.floor(requestedWindow)
            : 10;

        res.json(getMissileAlertStats(sid, windowMinutes));
    } catch (err) {
        res.status(500).json({ error: 'Failed to read missile alert stats' });
    }
});

app.get('/api/logs', (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const logFile = path.join(__dirname, 'logs', `session-${sessionId}.log`);
    if (!fs.existsSync(logFile)) {
        return res.json({ logs: [] });
    }

    try {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.trim().split('\n').slice(-100); // Send last 100 lines
        res.json({ logs: lines });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

app.get('/api/session-health/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const session = activeSessions[sessionId];

    if (!session) {
        return res.status(404).json({
            healthy: false,
            error: 'Session not found',
            sessionId
        });
    }

    const isReady = session.status === 'READY';

    // Try to ping the client if it claims to be ready
    if (isReady) {
        try {
            await session.client.getState();
            return res.json({
                healthy: true,
                status: session.status,
                sessionId,
                uptime: Date.now() - session.lastStatusChange
            });
        } catch (err) {
            return res.status(503).json({
                healthy: false,
                status: session.status,
                error: 'Session not responsive',
                sessionId
            });
        }
    }

    res.json({
        healthy: false,
        status: session.status,
        sessionId
    });
});

// Health check for Docker
app.get('/api/health', (req, res) => {
    res.status(200).send('OK');
});

app.get('/api/contacts', async (req, res) => {
    const { sessionId } = req.query;
    const sid = sessionId || 'default';

    logToUI(sid, `נ“‚ ׳‘׳§׳©׳” ׳׳׳©׳™׳›׳× ׳׳ ׳©׳™ ׳§׳©׳¨ ׳¢׳‘׳•׳¨ ${sid}...`);

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        console.log(`[API] Fetching contacts/chats for session: ${sid}`);
        let contacts = [];
        let source = 'contacts';

        try {
            contacts = await session.client.getContacts();
            console.log(`[API] Got ${contacts.length} from getContacts for ${sid}`);

            // Keep flow simple here; group counts are collected later via getChats() when available.
        } catch (e) {
            console.warn(`[API] getContacts failed for ${sid}, falling back to getChats: ${e.message}`);
            source = 'chats';
            // Fallback to getChats
            const chats = await session.client.getChats();
            console.log(`[API] Got ${chats.length} chats for fallback for ${sid}`);
            contacts = chats.map(chat => {
                const contact = chat.contact || {
                    id: chat.id,
                    name: chat.name,
                    isGroup: chat.isGroup
                };
                // Attach metadata directly to the contact object for later use
                contact._participantCount = chat.participants ? chat.participants.length : 0;
                return contact;
            });
        }

        // Auxiliary map for participant counts if we used getContacts
        let groupCounts = {};
        if (source === 'contacts') {
            try {
                const chats = await session.client.getChats();
                chats.forEach(chat => {
                    if (chat.isGroup) {
                        groupCounts[chat.id._serialized] = chat.participants ? chat.participants.length : 0;
                    }
                });
            } catch (e) { console.warn('Failed to fetch auxiliary chat data', e); }
        }

        const simplifiedContacts = [];
        const seenIds = new Set();

        for (const c of contacts) {
            if (!c || !c.id) continue;
            const serializedId = c.id._serialized || c.id;
            if (seenIds.has(serializedId)) continue;
            seenIds.add(serializedId);

            const isGroup = !!c.isGroup;
            let participantCount = 0;

            if (isGroup) {
                // Check if we have it from fallback or auxiliary map
                participantCount = c._participantCount || groupCounts[serializedId] || 0;
            }

            simplifiedContacts.push({
                id: serializedId,
                number: c.number || (c.id.user ? c.id.user : ''),
                name: c.name || c.pushname || c.shortName || "",
                isGroup: isGroup,
                participantCount: participantCount,
                isMyContact: !!c.isMyContact,
                isWAContact: !!c.isWAContact
            });
        }

        res.json({ success: true, contacts: simplifiedContacts, source });
    } catch (err) {
        console.error(`[API] Critical error fetching contacts for ${sid}:`, err);
        logToUI(sid, `ג— ׳©׳’׳™׳׳” ׳‘׳׳©׳™׳›׳× ׳׳ ׳©׳™ ׳§׳©׳¨: ${err.message}`);
        res.json({
            success: true,
            contacts: [],
            source: 'fallback-empty',
            degraded: true,
            warning: err.message
        });
    }
});

app.post('/api/send-message', async (req, res) => {
    const { to, message, sessionId } = req.body;
    const requestedSid = typeof sessionId === 'string' ? sessionId.trim() : '';
    let sid = requestedSid || 'default';

    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" in request body' });
    }

    let session = activeSessions[sid];
    if ((!session || session.status !== 'READY') && !requestedSid) {
        const readyEntry = Object.entries(activeSessions).find(([, s]) => s && s.status === 'READY');
        if (readyEntry) {
            sid = readyEntry[0];
            session = readyEntry[1];
        }
    }

    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        let chatId = to.includes('@') ? to : `${to}@c.us`;
        // Workaround for upstream WA Web regression around sendSeen/markedUnread.
        const disableSendSeen = async () => {
            try {
                await session.client.pupPage.evaluate(() => {
                    if (window.WWebJS) {
                        window.WWebJS.sendSeen = async () => true;
                    }
                });
            } catch (e) { }
        };

        await disableSendSeen();
        try {
            await session.client.sendMessage(chatId, message, { sendSeen: false });
        } catch (sendErr) {
            const msg = String(sendErr && sendErr.message ? sendErr.message : sendErr);
            if (msg.includes('markedUnread')) {
                await disableSendSeen();
                await session.client.sendMessage(chatId, message, { sendSeen: false });
            } else {
                throw sendErr;
            }
        }
        logToUI(sid, `נ“₪ ׳”׳•׳“׳¢׳” ׳ ׳©׳׳—׳” ׳—׳™׳¦׳•׳ ׳™׳× ׳-${to}: ${message}`);
        updateStats(sid, 'replied');
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (err) {
        logToUI(sid, `ג— ׳©׳’׳™׳׳” ׳‘׳©׳׳™׳—׳× ׳”׳•׳“׳¢׳” ׳—׳™׳¦׳•׳ ׳™׳×: ${err.message}`);
        res.json({
            success: true,
            groups: [],
            degraded: true,
            warning: err.message
        });
    }
});

app.post('/api/group/lock', async (req, res) => {
    const { groupId, sessionId } = req.body;
    const sid = sessionId || 'default';

    if (!groupId) {
        return res.status(400).json({ error: 'Missing groupId in request body' });
    }

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);

        if (!chat.isGroup) {
            return res.status(400).json({ error: 'The provided ID is not a group' });
        }

        // Set group settings to only admins can send messages
        await chat.setMessagesAdminsOnly(true);

        logToUI(sid, `נ”’ ׳”׳§׳‘׳•׳¦׳” "${chat.name}" ׳ ׳ ׳¢׳׳” - ׳¨׳§ ׳׳ ׳”׳׳™׳ ׳™׳›׳•׳׳™׳ ׳׳©׳׳•׳— ׳”׳•׳“׳¢׳•׳×`);
        res.json({
            success: true,
            message: 'Group locked successfully',
            groupName: chat.name,
            groupId: chatId
        });
    } catch (err) {
        logToUI(sid, `ג— ׳©׳’׳™׳׳” ׳‘׳ ׳¢׳™׳׳× ׳§׳‘׳•׳¦׳”: ${err.message}`);
        res.json({
            success: true,
            groups: [],
            degraded: true,
            warning: err.message
        });
    }
});

app.post('/api/group/unlock', async (req, res) => {
    const { groupId, sessionId } = req.body;
    const sid = sessionId || 'default';

    if (!groupId) {
        return res.status(400).json({ error: 'Missing groupId in request body' });
    }

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);

        if (!chat.isGroup) {
            return res.status(400).json({ error: 'The provided ID is not a group' });
        }

        // Set group settings to allow all members to send messages
        await chat.setMessagesAdminsOnly(false);

        logToUI(sid, `נ”“ ׳”׳§׳‘׳•׳¦׳” "${chat.name}" ׳ ׳₪׳×׳—׳” - ׳›׳ ׳”׳—׳‘׳¨׳™׳ ׳™׳›׳•׳׳™׳ ׳׳©׳׳•׳— ׳”׳•׳“׳¢׳•׳×`);
        res.json({
            success: true,
            message: 'Group unlocked successfully',
            groupName: chat.name,
            groupId: chatId
        });
    } catch (err) {
        logToUI(sid, `ג— ׳©׳’׳™׳׳” ׳‘׳₪׳×׳™׳—׳× ׳§׳‘׳•׳¦׳”: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/group/daily-rotations', (req, res) => {
    try {
        const sessionId = req.query.sessionId || 'default';
        const configPath = `./configs/session-${sessionId}.json`;
        const config = readJSON(configPath, { autoReplies: [], forwarding: [], scheduledMessages: [], groupMessageRotations: [] });
        res.json({
            success: true,
            rotations: Array.isArray(config.groupMessageRotations) ? config.groupMessageRotations : []
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read daily rotations' });
    }
});

app.post('/api/group/daily-rotations', (req, res) => {
    try {
        const sessionId = req.body.sessionId || 'default';
        const incoming = Array.isArray(req.body.rotations) ? req.body.rotations : [];
        const configPath = `./configs/session-${sessionId}.json`;
        const config = readJSON(configPath, { autoReplies: [], forwarding: [], scheduledMessages: [], groupMessageRotations: [] });

        const sanitizeTime = (value) => {
            const text = String(value || '').trim();
            return /^([01]\d|2[0-3]):([0-5]\d)$/.test(text) ? text : '09:00';
        };

        const sanitizeDays = (days) => {
            if (!Array.isArray(days)) return [0, 1, 2, 3, 4, 5, 6];
            const normalized = [...new Set(days
                .map(d => Number(d))
                .filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
            return normalized.length > 0 ? normalized.sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6];
        };

        const rotations = incoming
            .map((row, idx) => {
                const groupId = normalizeGroupId(row.groupId);
                const messages = Array.isArray(row.messages)
                    ? row.messages.map(m => String(m || '').trim()).filter(Boolean)
                    : [];
                if (!groupId || messages.length === 0) return null;

                const nextIndexRaw = Number(row.nextIndex);
                const nextIndex = Number.isInteger(nextIndexRaw) ? nextIndexRaw : 0;
                return {
                    id: row.id ? String(row.id) : `rotation_${Date.now()}_${idx}`,
                    name: String(row.name || '').trim(),
                    enabled: row.enabled !== false,
                    groupId,
                    time: sanitizeTime(row.time),
                    days: sanitizeDays(row.days),
                    messages,
                    nextIndex,
                    lastSentDateKey: typeof row.lastSentDateKey === 'string' ? row.lastSentDateKey : ''
                };
            })
            .filter(Boolean);

        config.groupMessageRotations = rotations;
        writeJSON(configPath, config);

        const session = activeSessions[sessionId];
        if (session && session.status === 'READY') {
            initScheduler(session.client, logToUI);
        }

        logToUI(sessionId, `נ“… Daily message rotations updated (${rotations.length} rules).`);
        res.json({ success: true, rotations });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/group/welcome-message', (req, res) => {
    try {
        const { groupId, sessionId } = req.query;
        const sid = sessionId || 'default';

        if (!groupId) {
            return res.status(400).json({ error: 'Missing groupId' });
        }

        const normalizedGroupId = normalizeGroupId(groupId);
        const settings = getGroupWelcomeMessage(sid, normalizedGroupId);
        res.json({
            success: true,
            groupId: normalizedGroupId,
            enabled: settings.enabled,
            message: settings.message
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/group/welcome-message', async (req, res) => {
    const { groupId, message, enabled, sessionId } = req.body || {};
    const sid = sessionId || 'default';

    if (!groupId) {
        return res.status(400).json({ error: 'Missing groupId' });
    }

    const normalizedGroupId = normalizeGroupId(groupId);
    if (!normalizedGroupId) {
        return res.status(400).json({ error: 'Invalid groupId' });
    }

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        const chat = await session.client.getChatById(normalizedGroupId);
        if (!chat.isGroup) {
            return res.status(400).json({ error: 'The provided ID is not a group' });
        }

        const botId = session.client.info.wid._serialized;
        const participant = chat.participants.find(p => p.id._serialized === botId);
        const hasAdminAccess = !!(participant && (participant.isAdmin || participant.isSuperAdmin));
        if (!hasAdminAccess) {
            return res.status(403).json({ error: 'Bot is not admin in this group' });
        }

        const normalizedMessage = typeof message === 'string' ? message.trim() : '';
        const isEnabled = !!enabled && normalizedMessage.length > 0;
        setGroupWelcomeMessage(sid, normalizedGroupId, {
            enabled: isEnabled,
            message: normalizedMessage
        });

        logToUI(sid, `נ›  Group welcome message updated for ${chat.name} (${normalizedGroupId}) [enabled=${isEnabled}]`);
        res.json({
            success: true,
            groupId: normalizedGroupId,
            enabled: isEnabled,
            message: normalizedMessage
        });
    } catch (err) {
        logToUI(sid, `ג— Error updating group welcome message: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/group/members', async (req, res) => {
    const { groupId, sessionId } = req.query;
    const sid = sessionId || 'default';

    if (!groupId) return res.status(400).json({ error: 'Missing groupId' });

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ error: 'Not a group' });

        const botId = session.client.info.wid._serialized;
        const members = [];
        for (const p of chat.participants) {
            try {
                const isMe = p.id._serialized === botId;
                let name = isMe ? "׳׳ ׳™ (׳”׳‘׳•׳˜)" : await resolveBestName(session.client, p.id);

                // If still no name, try the "poke" method
                if (!name && !isMe) {
                    try {
                        const contact = await session.client.getContactById(p.id._serialized);
                        await Promise.race([
                            contact.getAbout(),
                            new Promise(resolve => setTimeout(resolve, 500))
                        ]);
                        name = (await session.client.getContactById(p.id._serialized)).pushname || "";
                        if (name) updateContactCache(p.id.user, name);
                    } catch (pokeErr) { }
                }

                members.push({
                    id: p.id._serialized,
                    name: name || "",
                    number: p.id.user,
                    isAdmin: p.isAdmin,
                    isSuperAdmin: p.isSuperAdmin,
                    isMe: isMe
                });
            } catch (e) {
                members.push({
                    id: p.id._serialized,
                    name: contactsCache[p.id.user] || "",
                    number: p.id.user,
                    isAdmin: p.isAdmin,
                    isMe: p.id._serialized === botId
                });
            }
        }

        res.json({ success: true, members });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/group/rename', async (req, res) => {
    const { groupId, newName, sessionId } = req.body;
    const sid = sessionId || 'default';

    if (!groupId || !newName) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: 'Session not ready' });
    }

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ error: 'Not a group' });

        await chat.setSubject(newName);
        logToUI(sid, `נ“ ׳©׳ ׳”׳§׳‘׳•׳¦׳” ${groupId} ׳©׳•׳ ׳” ׳-"${newName}"`);
        res.json({ success: true, newName });
    } catch (err) {
        logToUI(sid, `ג— ׳©׳’׳™׳׳” ׳‘׳©׳™׳ ׳•׳™ ׳©׳ ׳§׳‘׳•׳¦׳”: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/group/member-action', async (req, res) => {
    const { groupId, participantId, action, sessionId } = req.body;
    const sid = sessionId || 'default';

    if (!groupId || !participantId || !action) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: 'Session not ready' });
    }

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ error: 'Not a group' });

        let resultMsg = '';
        if (action === 'remove') {
            await chat.removeParticipants([participantId]);
            resultMsg = `׳”׳•׳¡׳¨ ׳׳”׳§׳‘׳•׳¦׳”`;
        } else if (action === 'promote') {
            await chat.promoteParticipants([participantId]);
            resultMsg = `׳”׳×׳׳ ׳” ׳׳׳ ׳”׳`;
        } else if (action === 'demote') {
            await chat.demoteParticipants([participantId]);
            resultMsg = `׳”׳•׳¡׳¨ ׳׳ ׳™׳”׳•׳`;
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }

        logToUI(sid, `נ‘¥ ׳₪׳¢׳•׳׳” "${action}" ׳‘׳•׳¦׳¢׳” ׳¢׳ ${participantId} ׳‘׳§׳‘׳•׳¦׳” "${chat.name}"`);
        res.json({ success: true, message: resultMsg });
    } catch (err) {
        logToUI(sid, `ג— ׳©׳’׳™׳׳” ׳‘׳‘׳™׳¦׳•׳¢ ׳₪׳¢׳•׳׳” ׳‘׳§׳‘׳•׳¦׳”: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/group/leave', async (req, res) => {
    const { groupId, sessionId } = req.body;
    const sid = sessionId || 'default';

    if (!groupId) return res.status(400).json({ error: 'Missing groupId' });

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        const chat = await session.client.getChatById(groupId);
        if (!chat.isGroup) return res.status(400).json({ error: 'Not a group' });

        await chat.leave();
        logToUI(sid, `נ× ׳¢׳–׳‘׳×׳™ ׳׳× ׳”׳§׳‘׳•׳¦׳” "${chat.name}" (${groupId})`);
        res.json({ success: true, message: '׳¢׳–׳‘׳×׳™ ׳׳× ׳”׳§׳‘׳•׳¦׳” ׳‘׳”׳¦׳׳—׳”' });
    } catch (err) {
        logToUI(sid, `ג— ׳©׳’׳™׳׳” ׳‘׳¢׳–׳™׳‘׳× ׳§׳‘׳•׳¦׳”: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/groups', async (req, res) => {
    const { sessionId } = req.query;
    const sid = sessionId || 'default';

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        const chats = await session.client.getChats();
        const botId = session.client.info.wid._serialized;

        const managedGroups = chats
            .filter(chat => chat.isGroup)
            .map(chat => {
                const participant = chat.participants.find(p => p.id._serialized === botId);
                return {
                    id: chat.id._serialized,
                    name: chat.name,
                    isAdmin: participant ? (participant.isAdmin || participant.isSuperAdmin) : false,
                    isAnnouncementsOnly: chat.isReadOnly,
                    participantsCount: chat.participants ? chat.participants.length : 0
                };
            })
            .filter(group => group.isAdmin);

        res.json({ success: true, groups: managedGroups });
    } catch (err) {
        logToUI(sid, `Error fetching groups: ${err.message}`);
        res.json({
            success: true,
            groups: [],
            degraded: true,
            warning: err.message
        });
    }
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

