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
    // Don't overwrite if it's "ללא שם" or something generic
    if (['ללא שם', 'לא נמצא', 'null', 'undefined'].includes(name)) return;

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

function logToUI(sessionId, msg) {
    const formattedMsg = `[${sessionId}] ${msg}`;
    console.log(formattedMsg);

    // Save to file
    try {
        const logsDir = path.join(__dirname, 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

        const logFile = path.join(logsDir, `session-${sessionId}.log`);
        const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
    } catch (err) {
        console.error('Error saving log:', err);
    }

    io.emit('log', { sessionId, message: msg });
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

    logToUI(sessionId, `🚀 מתחיל אתחול דפדפן עבור ${sessionId}...`);

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
        lastStatusChange: Date.now()
    };

    // Watchdog Timer: Protect against 99% Stuck Issues
    // If not ready/QR within 3 minutes, force restart
    setTimeout(async () => {
        const s = activeSessions[sessionId];
        if (s && (s.status.startsWith('LOADING') || s.status === 'INITIALIZING')) {
            logToUI(sessionId, '⚠️ זוהתה תקיעה בטעינה (Watchdog). מבצע אתחול אוטומטי...');
            try {
                await s.client.destroy();
            } catch (e) { }
            delete activeSessions[sessionId];
            startSession(sessionId); // Retry
        }
    }, 180000); // 3 Minutes

    io.emit('status', { sessionId, status: 'INITIALIZING' });

    client.on('qr', async (qr) => {
        logToUI(sessionId, '✓ קוד QR התקבל. סרוק מהדפדפן.');
        const qrDataURL = await QRCode.toDataURL(qr);
        updateSessionStatus(sessionId, 'QR_RECEIVED', qrDataURL);
    });

    client.on('ready', () => {
        logToUI(sessionId, '✓ וואטסאפ מוכן לפעולה!');
        // פאטץ' לתיקון שגיאות פנימיות של וואטסאפ (markedUnread)
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

        updateSessionStatus(sessionId, 'READY', '');
        initScheduler(client);
    });

    client.on('loading_screen', (percent, message) => {
        logToUI(sessionId, `טוען: ${percent}% - ${message}`);
        updateSessionStatus(sessionId, `LOADING (${percent}%)`);
    });

    client.on('authenticated', () => {
        logToUI(sessionId, '✓ התחברות בוצעה בהצלחה!');
        updateSessionStatus(sessionId, 'AUTHENTICATED');
    });

    client.on('auth_failure', (msg) => {
        logToUI(sessionId, `✗ שגיאת התחברות: ${msg}`);
        updateSessionStatus(sessionId, 'AUTH_FAILURE');
    });

    client.on('message_create', async (msg) => {
        try {
            // Safer way to get sender name without calling getContact() which is failing
            const senderNum = await resolveSenderNumberForLog(client, msg);
            let senderName = msg.fromMe ? 'אני' : (msg._data.notifyName || senderNum);
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
                    groupInfo = ` [קבוצה: ${chat.name} (${groupId})]`;
                }
            } catch (chatError) {
                // If getChat fails, we just don't show group info
            }

            const jidInfo = senderJid ? ` [jid: ${senderJid}]` : '';
            logToUI(sessionId, `📩 הודעה מ-${senderName}${groupInfo}${jidInfo}: ${msg.body}`);

            if (!msg.fromMe) updateStats(sessionId, 'received');

            const result = await handleMessage(msg, client, sessionId, (logMsg) => {
                logToUI(sessionId, logMsg);
            });

            if (result && result.replied) {
                updateStats(sessionId, 'replied', result.trigger);
            }
        } catch (err) {
            logToUI(sessionId, `✗ שגיאה בטיפול בהודעה: ${err.message}`);
        }
    });

    client.on('disconnected', (reason) => {
        logToUI(sessionId, `✗ וואטסאפ התנתק: ${reason}`);
        updateSessionStatus(sessionId, 'DISCONNECTED');

        // Auto-reconnect after 5 seconds
        logToUI(sessionId, '🔄 מנסה להתחבר מחדש בעוד 5 שניות...');
        setTimeout(async () => {
            try {
                await client.destroy();
            } catch (e) { }
            delete activeSessions[sessionId];
            startSession(sessionId);
        }, 5000);
    });

    client.initialize().catch(err => {
        logToUI(sessionId, `✗ שגיאת אתחול: ${err.message}`);
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
                logToUI(sessionId, '⚠️ סשן תקוע - מבצע ריסטרט אוטומטי...');
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
                logToUI(sessionId, `⚠️ סשן לא מגיב - מבצע ריסטרט: ${err.message}`);
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
        logToUI(oldId, `🔄 משנה שם לחשבון מ-${oldId} ל-${newId}...`);

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
        logToUI(oldId, `✗ שגיאה בשינוי שם: ${err.message}`);
        res.status(500).json({ error: err.message });
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

        const config = readJSON(configPath, { autoReplies: [], forwarding: [], scheduledMessages: [] });
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

        // Remove sessionId from body if present to avoid saving it
        const configData = { ...req.body };
        delete configData.sessionId;

        writeJSON(configPath, configData);
        logToUI('system', `⚙️ הגדרות עודכנו בהצלחה עבור ${sessionId}.`);
        res.json({ success: true });
    } catch (err) {
        logToUI('system', `✗ שגיאה בשליחת הגדרות: ${err.message}`);
        res.status(500).json({ error: err.message });
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

    logToUI(sid, `📂 בקשה למשיכת אנשי קשר עבור ${sid}...`);

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

            // Fetch chats to get group participant counts
            try {
                const chats = await session.client.getChats();
                chats.forEach(chat => {
                    if (chat.isGroup && chat.participants) {
                        // Store count by serialized ID
                        c.groupMetadata = c.groupMetadata || {}; // We can't attach to 'c' here, 'c' is not defined. We need an external map.
                    }
                });
            } catch (e) { }
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
        logToUI(sid, `✗ שגיאה במשיכת אנשי קשר: ${err.message}`);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/send-message', async (req, res) => {
    const { to, message, sessionId } = req.body;
    const sid = sessionId || 'default';

    if (!to || !message) {
        return res.status(400).json({ error: 'Missing "to" or "message" in request body' });
    }

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        let chatId = to.includes('@') ? to : `${to}@c.us`;
        await session.client.sendMessage(chatId, message);
        logToUI(sid, `📤 הודעה נשלחה חיצונית ל-${to}: ${message}`);
        updateStats(sid, 'replied');
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בשליחת הודעה חיצונית: ${err.message}`);
        res.status(500).json({ error: err.message });
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

        logToUI(sid, `🔒 הקבוצה "${chat.name}" ננעלה - רק מנהלים יכולים לשלוח הודעות`);
        res.json({
            success: true,
            message: 'Group locked successfully',
            groupName: chat.name,
            groupId: chatId
        });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בנעילת קבוצה: ${err.message}`);
        res.status(500).json({ error: err.message });
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

        logToUI(sid, `🔓 הקבוצה "${chat.name}" נפתחה - כל החברים יכולים לשלוח הודעות`);
        res.json({
            success: true,
            message: 'Group unlocked successfully',
            groupName: chat.name,
            groupId: chatId
        });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בפתיחת קבוצה: ${err.message}`);
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
                let name = isMe ? "אני (הבוט)" : await resolveBestName(session.client, p.id);

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
        logToUI(sid, `📝 שם הקבוצה ${groupId} שונה ל-"${newName}"`);
        res.json({ success: true, newName });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בשינוי שם קבוצה: ${err.message}`);
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
            resultMsg = `הוסר מהקבוצה`;
        } else if (action === 'promote') {
            await chat.promoteParticipants([participantId]);
            resultMsg = `התמנה למנהל`;
        } else if (action === 'demote') {
            await chat.demoteParticipants([participantId]);
            resultMsg = `הוסר מניהול`;
        } else {
            return res.status(400).json({ error: 'Invalid action' });
        }

        logToUI(sid, `👥 פעולה "${action}" בוצעה על ${participantId} בקבוצה "${chat.name}"`);
        res.json({ success: true, message: resultMsg });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בביצוע פעולה בקבוצה: ${err.message}`);
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
        logToUI(sid, `🚪 עזבתי את הקבוצה "${chat.name}" (${groupId})`);
        res.json({ success: true, message: 'עזבתי את הקבוצה בהצלחה' });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בעזיבת קבוצה: ${err.message}`);
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
                    isAdmin: participant ? participant.isAdmin : false,
                    isAnnouncementsOnly: chat.isReadOnly,
                    participantsCount: chat.participants ? chat.participants.length : 0
                };
            })
            .filter(group => group.isAdmin);

        res.json({ success: true, groups: managedGroups });
    } catch (err) {
        logToUI(sid, `✗ שגיאה במשיכת קבוצות: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
