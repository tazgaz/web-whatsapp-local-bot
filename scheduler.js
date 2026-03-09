const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const { readJSON, writeJSON } = require('./utils');

const sessionJobs = new Map();

function getConfigPath(sessionId) {
    return `./configs/session-${sessionId}.json`;
}

function getDefaultConfig() {
    return { autoReplies: [], forwarding: [], scheduledMessages: [], groupMessageRotations: [] };
}

function getRotationLogPath(sessionId) {
    return path.join(__dirname, 'data', 'rotation_logs', `session-${sessionId}.jsonl`);
}

function ensureDirForFile(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendRotationLog(sessionId, entry) {
    try {
        const filePath = getRotationLogPath(sessionId);
        ensureDirForFile(filePath);
        fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (e) { }
}

function restoreRotationProgressFromLog(sessionId, configPath) {
    try {
        const logPath = getRotationLogPath(sessionId);
        if (!fs.existsSync(logPath)) return;

        const config = readJSON(configPath, getDefaultConfig());
        const list = Array.isArray(config.groupMessageRotations) ? config.groupMessageRotations : [];
        if (!list.length) return;

        const byId = new Map();
        list.forEach((rotation, idx) => byId.set(String(rotation?.id || ''), idx));

        let changed = false;
        const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            let parsed = null;
            try { parsed = JSON.parse(lines[i]); } catch (e) { continue; }
            if (!parsed || parsed.status !== 'success') continue;

            const rotationId = String(parsed.rotationId || '');
            if (!byId.has(rotationId)) continue;

            const idx = byId.get(rotationId);
            const rotation = list[idx];
            const currentLastSent = String(rotation?.lastSentDateKey || '');
            const parsedDateKey = String(parsed.dateKey || '');
            if (parsedDateKey && (!currentLastSent || parsedDateKey > currentLastSent)) {
                rotation.lastSentDateKey = parsedDateKey;
                if (Number.isInteger(Number(parsed.nextIndex))) {
                    rotation.nextIndex = Number(parsed.nextIndex);
                }
                changed = true;
            } else if (
                parsedDateKey &&
                currentLastSent === parsedDateKey &&
                Number.isInteger(Number(parsed.nextIndex)) &&
                Number(rotation?.nextIndex) !== Number(parsed.nextIndex)
            ) {
                rotation.nextIndex = Number(parsed.nextIndex);
                changed = true;
            }
            byId.delete(rotationId);
            if (byId.size === 0) break;
        }

        if (changed) {
            config.groupMessageRotations = list;
            writeJSON(configPath, config);
        }
    } catch (e) { }
}

function getJerusalemDateKey(date) {
    return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
}

function normalizeGroupId(groupId) {
    if (typeof groupId !== 'string') return '';
    const trimmed = groupId.trim();
    if (!trimmed) return '';
    return trimmed.includes('@') ? trimmed : `${trimmed}@g.us`;
}

function parseTimeToHourMinute(time) {
    const match = String(time || '').trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) return null;
    return {
        hour: Number(match[1]),
        minute: Number(match[2])
    };
}

function normalizeDays(days) {
    if (!Array.isArray(days)) return [0, 1, 2, 3, 4, 5, 6];
    const unique = [...new Set(days
        .map(d => Number(d))
        .filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
    if (unique.length === 0) return [0, 1, 2, 3, 4, 5, 6];
    return unique.sort((a, b) => a - b);
}

function normalizeRotationItems(items, messages) {
    const fromItems = Array.isArray(items)
        ? items
            .map(item => {
                const text = String(item && item.text ? item.text : '').trim();
                const media = item && item.media && typeof item.media === 'object'
                    ? {
                        mimeType: String(item.media.mimeType || '').trim(),
                        data: String(item.media.data || '').trim(),
                        filename: String(item.media.filename || 'media').trim()
                    }
                    : null;
                const hasValidMedia = !!(media && media.mimeType && media.data);
                if (!text && !hasValidMedia) return null;
                return { text, media: hasValidMedia ? media : null };
            })
            .filter(Boolean)
        : [];

    if (fromItems.length > 0) return fromItems;

    const fromMessages = Array.isArray(messages)
        ? messages.map(m => String(m || '').trim()).filter(Boolean)
        : [];
    return fromMessages.map(text => ({ text, media: null }));
}

async function sendRotationItem(client, destination, item) {
    const text = String(item && item.text ? item.text : '').trim();
    const media = item && item.media ? item.media : null;
    if (media && media.mimeType && media.data) {
        const payload = new MessageMedia(media.mimeType, media.data, media.filename || 'media');
        await client.sendMessage(destination, payload, {
            caption: text || undefined,
            sendSeen: false
        });
        return;
    }
    if (text) {
        await client.sendMessage(destination, text, { sendSeen: false });
    }
}

function stopSchedulerForSession(sessionId) {
    const jobs = sessionJobs.get(sessionId) || [];
    jobs.forEach(job => {
        try { job.stop(); } catch (e) { }
        try { job.destroy(); } catch (e) { }
    });
    sessionJobs.delete(sessionId);
}

function initScheduler(client, logger = null) {
    const sessionId = client.options.authStrategy.clientId || 'default';
    const configPath = getConfigPath(sessionId);
    restoreRotationProgressFromLog(sessionId, configPath);
    const config = readJSON(configPath, getDefaultConfig());

    stopSchedulerForSession(sessionId);
    const jobs = [];

    // Backward-compatible legacy scheduled messages.
    (config.scheduledMessages || []).forEach((task) => {
        if (!task || !task.cron || !task.to || !task.message) return;
        const job = cron.schedule(task.cron, async () => {
            try {
                const destination = String(task.to).includes('@') ? String(task.to) : `${task.to}@c.us`;
                await client.sendMessage(destination, task.message, { sendSeen: false });
                if (logger) logger(sessionId, `Scheduled message sent to ${destination}.`);
            } catch (err) {
                if (logger) logger(sessionId, `Scheduled message failed: ${err.message}`);
            }
        }, { timezone: 'Asia/Jerusalem' });
        jobs.push(job);
    });

    // New: group daily rotation messages.
    (config.groupMessageRotations || []).forEach((rotation) => {
        if (!rotation || rotation.enabled === false) return;

        const time = parseTimeToHourMinute(rotation.time);
        const groupId = normalizeGroupId(rotation.groupId);
        const items = normalizeRotationItems(rotation.items, rotation.messages);
        const days = normalizeDays(rotation.days);

        if (!time || !groupId || items.length === 0) return;

        const cronExpr = `${time.minute} ${time.hour} * * ${days.join(',')}`;
        const rotationId = String(rotation.id || '');

        const job = cron.schedule(cronExpr, async () => {
            try {
                const latestConfig = readJSON(configPath, getDefaultConfig());
                const list = Array.isArray(latestConfig.groupMessageRotations) ? latestConfig.groupMessageRotations : [];
                const idx = list.findIndex(item => String(item && item.id) === rotationId);
                if (idx === -1) return;

                const current = list[idx];
                if (current.enabled === false) return;

                const currentGroupId = normalizeGroupId(current.groupId);
                const currentItems = normalizeRotationItems(current.items, current.messages);
                if (!currentGroupId || currentItems.length === 0) return;

                const todayKey = getJerusalemDateKey(new Date());
                if (current.lastSentDateKey === todayKey) return;

                const rawNextIndex = Number(current.nextIndex);
                const safeNextIndex = Number.isInteger(rawNextIndex)
                    ? ((rawNextIndex % currentItems.length) + currentItems.length) % currentItems.length
                    : 0;

                const itemToSend = currentItems[safeNextIndex];
                await sendRotationItem(client, currentGroupId, itemToSend);

                current.items = currentItems;
                current.nextIndex = (safeNextIndex + 1) % currentItems.length;
                current.lastSentDateKey = todayKey;
                list[idx] = current;
                latestConfig.groupMessageRotations = list;
                writeJSON(configPath, latestConfig);

                appendRotationLog(sessionId, {
                    ts: new Date().toISOString(),
                    source: 'scheduled',
                    status: 'success',
                    rotationId,
                    groupId: currentGroupId,
                    sentIndex: safeNextIndex,
                    nextIndex: current.nextIndex,
                    dateKey: todayKey,
                    hasMedia: !!(itemToSend && itemToSend.media)
                });

                if (logger) logger(sessionId, `Daily rotation sent to ${currentGroupId} [rule=${rotationId}, index=${safeNextIndex}].`);
            } catch (err) {
                appendRotationLog(sessionId, {
                    ts: new Date().toISOString(),
                    source: 'scheduled',
                    status: 'failed',
                    rotationId,
                    error: err && err.message ? err.message : String(err || 'Unknown error')
                });
                if (logger) logger(sessionId, `Daily rotation failed [rule=${rotationId}]: ${err.message}`);
            }
        }, { timezone: 'Asia/Jerusalem' });

        jobs.push(job);
    });

    sessionJobs.set(sessionId, jobs);
    if (logger) logger(sessionId, `Scheduler loaded (${jobs.length} jobs).`);
}

module.exports = { initScheduler, stopSchedulerForSession };
