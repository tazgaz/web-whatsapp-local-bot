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

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

let clientStatus = 'INITIALIZING';
let lastQR = '';

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
        try {
            await handleMessage(msg, client, logToUI);
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
        const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read config' });
    }
});

app.post('/api/config', (req, res) => {
    try {
        console.log('Updating config:', JSON.stringify(req.body, null, 2));
        fs.writeFileSync('./config.json', JSON.stringify(req.body, null, 2));
        logToUI('⚙️ הגדרות עודכנו בהצלחה.');
        res.json({ success: true });
    } catch (err) {
        logToUI(`✗ שגיאה בשמירת הגדרות: ${err.message}`);
        res.status(500).json({ error: err.message });
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
});

server.listen(port, () => {
    console.log(`UI running at http://localhost:${port}`);
});
