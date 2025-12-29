const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { handleMessage } = require('./messageHandler');
const { initScheduler } = require('./scheduler');
const QRCode = require('qrcode');
const { readJSON, writeJSON } = require('./utils');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);
const port = 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

let clientStatus = 'INITIALIZING';
let lastQR = '';

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

function logToUI(msg) {
    console.log(msg);
    io.emit('log', msg);
}

let client = new Client({
    authStrategy: new LocalAuth(),
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

function initClient() {
    logToUI('🚀 מתחיל אתחול דפדפן...');

    client.on('qr', async (qr) => {
        logToUI('✓ קוד QR התקבל. סרוק מהדפדפן.');
        lastQR = await QRCode.toDataURL(qr);
        io.emit('qr', lastQR);
        clientStatus = 'QR_RECEIVED';
        io.emit('status', clientStatus);
    });

    client.on('ready', () => {
        logToUI('✓ וואטסאפ מוכן לפעולה!');
        clientStatus = 'READY';
        io.emit('status', clientStatus);
        initScheduler(client);
    });

    client.on('loading_screen', (percent, message) => {
        logToUI(`טוען: ${percent}% - ${message}`);
        clientStatus = `LOADING (${percent}%)`;
        io.emit('status', clientStatus);
    });

    client.on('authenticated', () => {
        logToUI('✓ התחברות בוצעה בהצלחה!');
        clientStatus = 'AUTHENTICATED';
        io.emit('status', clientStatus);
    });

    client.on('auth_failure', (msg) => {
        logToUI(`✗ שגיאת התחברות: ${msg}`);
        clientStatus = 'AUTH_FAILURE';
        io.emit('status', clientStatus);
    });

    client.on('message', async (msg) => {
        logToUI(`הודעה נכנסת מ-${msg.from}: ${msg.body}`);
        updateStats('received');
        try {
            await handleMessage(msg, client, (logMsg) => {
                logToUI(logMsg);
                if (logMsg.includes('✅ מענה נשלח')) {
                    updateStats('replied');
                }
            });
        } catch (err) {
            logToUI(`✗ שגיאה בטיפול בהודעה: ${err.message}`);
        }
    });

    client.on('disconnected', (reason) => {
        logToUI(`✗ וואטסאפ התנתק: ${reason}`);
        clientStatus = 'DISCONNECTED';
        io.emit('status', clientStatus);
    });

    client.initialize().catch(err => {
        logToUI(`✗ שגיאת אתחול: ${err.message}`);
    });
}

initClient();

// APIs
app.get('/api/config', (req, res) => {
    try {
        const config = readJSON('./config.json', { autoReplies: [], forwarding: [] });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read config' });
    }
});

app.post('/api/config', (req, res) => {
    try {
        writeJSON('./config.json', req.body);
        logToUI('⚙️ הגדרות עודכנו בהצלחה.');
        res.json({ success: true });
    } catch (err) {
        logToUI(`✗ שגיאה בשליחת הגדרות: ${err.message}`);
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

app.post('/api/logout', async (req, res) => {
    try {
        logToUI('🔄 מתנתק מהמערכת...');
        await client.logout();
        logToUI('✅ התנתקת בהצלחה.');
        res.json({ success: true });
    } catch (err) {
        logToUI(`✗ שגיאה בהתנתקות: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ status: clientStatus, qr: lastQR });
});

io.on('connection', (socket) => {
    socket.emit('status', clientStatus);
    if (lastQR) socket.emit('qr', lastQR);
    socket.emit('log', '--- מחובר לשרת הניהול ---');
    try {
        const stats = readJSON(STATS_FILE, { daily: {}, triggers: {} });
        socket.emit('stats_update', stats);
    } catch (e) { }
});

server.listen(port, () => {
    console.log(`UI running at http://localhost:${port}`);
});
