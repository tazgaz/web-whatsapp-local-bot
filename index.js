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
const io = new Server(server);
const port = 3000;

app.use(express.json());
app.use(express.static('public'));

// Sessions management
const SESSIONS_FILE = './sessions.json';
if (!fs.existsSync(SESSIONS_FILE)) {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(['default'], null, 2));
}

const activeSessions = {}; // { id: { client, status, qr } }

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
            const senderNum = msg.fromMe ? 'Me' : (msg.author || msg.from).split('@')[0];
            let senderName = msg.fromMe ? 'אני' : (msg._data.notifyName || senderNum);

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

            logToUI(sessionId, `📩 הודעה מ-${senderName}${groupInfo}: ${msg.body}`);

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

app.get('/api/groups', async (req, res) => {
    const { sessionId } = req.query;
    const sid = sessionId || 'default';

    console.log(`[API] Fetching groups for session: ${sid}`);

    const session = activeSessions[sid];
    if (!session || session.status !== 'READY') {
        console.log(`[API] Session ${sid} is NOT ready (status: ${session ? session.status : 'N/A'})`);
        return res.status(503).json({ error: `WhatsApp client "${sid}" is not ready` });
    }

    try {
        console.log(`[API] Calling getChats() for ${sid}...`);
        const chats = await session.client.getChats();
        console.log(`[API] Got ${chats.length} chats`);

        const me = session.client.info.wid._serialized;
        console.log(`[API] My ID: ${me}`);

        const groups = chats
            .filter(chat => chat.isGroup)
            .filter(chat => {
                // Check if user is an admin
                const amIAdmin = chat.participants && chat.participants.some(p => p.id._serialized === me && p.isAdmin);
                return amIAdmin;
            })
            .map(chat => ({
                id: chat.id._serialized,
                name: chat.name,
                participantsCount: (chat.participants || []).length
            }));

        console.log(`[API] Found ${groups.length} managed groups`);
        res.json({ success: true, groups });
    } catch (err) {
        console.error(`[API] Error in /api/groups for ${sid}:`, err);
        logToUI(sid, `✗ שגיאה בקבלת רשימת קבוצות: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', async (req, res) => {
    const { sessionId } = req.body;
    const sid = sessionId || 'default';
    try {
        logToUI(sid, '🔄 מתנתק מהמערכת...');
        if (activeSessions[sid]) {
            await activeSessions[sid].client.logout();
            logToUI(sid, '✅ התנתקת בהצלחה.');
        }
        res.json({ success: true });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בהתנתקות: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'WhatsApp Bot is running',
        timestamp: new Date().toISOString(),
        sessions: Object.keys(activeSessions).length
    });
});

app.post('/api/restart', (req, res) => {
    logToUI('system', '🔄 בקשת ריסטרט התקבלה מה-API. מאתחל את הבוט...');
    res.json({ success: true, message: 'Restarting bot...' });
    setTimeout(() => {
        process.exit(1);
    }, 1500);
});

io.on('connection', (socket) => {
    // Send current status of all sessions
    const sessionData = Object.keys(activeSessions).map(id => ({
        id,
        status: activeSessions[id].status,
        qr: activeSessions[id].qr
    }));
    socket.emit('init_sessions', sessionData);

    try {
        const stats = getStats();
        socket.emit('stats_update', stats);
    } catch (e) { }

    socket.emit('log', { sessionId: 'system', message: '--- מחובר לשרת הניהול ---' });
});

server.listen(port, () => {
    console.log(`UI running at http://localhost:${port}`);
});

