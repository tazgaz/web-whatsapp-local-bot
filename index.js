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
const stats = { daily: {}, triggers: {} };

// Stats management
const STATS_FILE = './stats.json';
if (!fs.existsSync(STATS_FILE)) {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ daily: {}, triggers: {} }, null, 2));
}

function updateStats(type, trigger = null) {
    try {
        const stats = readJSON(STATS_FILE, { daily: {}, triggers: {} });
        const today = new Date().toISOString().split('T')[0];

        if (!stats.daily[today]) stats.daily[today] = { received: 0, replied: 0 };

        if (type === 'received') stats.daily[today].received++;
        if (type === 'replied') stats.daily[today].replied++;

        if (trigger) {
            stats.triggers[trigger] = (stats.triggers[trigger] || 0) + 1;
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
    io.emit('log', { sessionId, message: msg });
}

function createClient(sessionId) {
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
        }
    });

    activeSessions[sessionId] = {
        client,
        status: 'INITIALIZING',
        qr: ''
    };

    io.emit('status', { sessionId, status: 'INITIALIZING' });

    client.on('qr', async (qr) => {
        logToUI(sessionId, '✓ קוד QR התקבל. סרוק מהדפדפן.');
        const qrDataURL = await QRCode.toDataURL(qr);
        activeSessions[sessionId].qr = qrDataURL;
        activeSessions[sessionId].status = 'QR_RECEIVED';
        io.emit('status', { sessionId, status: 'QR_RECEIVED', qr: qrDataURL });
    });

    client.on('ready', () => {
        logToUI(sessionId, '✓ וואטסאפ מוכן לפעולה!');
        activeSessions[sessionId].status = 'READY';
        activeSessions[sessionId].qr = '';
        io.emit('status', { sessionId, status: 'READY' });
        initScheduler(client);
    });

    client.on('loading_screen', (percent, message) => {
        logToUI(sessionId, `טוען: ${percent}% - ${message}`);
        activeSessions[sessionId].status = `LOADING (${percent}%)`;
        io.emit('status', { sessionId, status: activeSessions[sessionId].status });
    });

    client.on('authenticated', () => {
        logToUI(sessionId, '✓ התחברות בוצעה בהצלחה!');
        activeSessions[sessionId].status = 'AUTHENTICATED';
        io.emit('status', { sessionId, status: 'AUTHENTICATED' });
    });

    client.on('auth_failure', (msg) => {
        logToUI(sessionId, `✗ שגיאת התחברות: ${msg}`);
        activeSessions[sessionId].status = 'AUTH_FAILURE';
        io.emit('status', { sessionId, status: 'AUTH_FAILURE' });
    });

    client.on('message', async (msg) => {
        logToUI(sessionId, `הודעה נכנסת מ-${msg.from}: ${msg.body}`);
        updateStats('received');
        try {
            await handleMessage(msg, client, sessionId, (logMsg) => {
                logToUI(sessionId, logMsg);
                if (logMsg.includes('✅ מענה נשלח')) {
                    updateStats('replied');
                }
            });
        } catch (err) {
            logToUI(sessionId, `✗ שגיאה בטיפול בהודעה: ${err.message}`);
        }
    });

    client.on('disconnected', (reason) => {
        logToUI(sessionId, `✗ וואטסאפ התנתק: ${reason}`);
        activeSessions[sessionId].status = 'DISCONNECTED';
        io.emit('status', { sessionId, status: 'DISCONNECTED' });
    });

    client.initialize().catch(err => {
        logToUI(sessionId, `✗ שגיאת אתחול: ${err.message}`);
    });

    return activeSessions[sessionId];
}

// Initialize saved sessions
const savedSessions = readJSON(SESSIONS_FILE, ['default']);
savedSessions.forEach(id => createClient(id));

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

    createClient(sanitizedId);

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
        const stats = readJSON(STATS_FILE, { daily: {}, triggers: {} });
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read stats' });
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
        updateStats('replied');
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (err) {
        logToUI(sid, `✗ שגיאה בשליחת הודעה חיצונית: ${err.message}`);
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
        const stats = readJSON(STATS_FILE, { daily: {}, triggers: {} });
        socket.emit('stats_update', stats);
    } catch (e) { }

    socket.emit('log', { sessionId: 'system', message: '--- מחובר לשרת הניהול ---' });
});

server.listen(port, () => {
    console.log(`UI running at http://localhost:${port}`);
});

