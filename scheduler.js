const cron = require('node-cron');
const { readJSON, writeJSON } = require('./utils');

const sessionJobs = new Map();

function getConfigPath(sessionId) {
    return `./configs/session-${sessionId}.json`;
}

function getDefaultConfig() {
    return { autoReplies: [], forwarding: [], scheduledMessages: [], groupMessageRotations: [] };
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
        const messages = Array.isArray(rotation.messages)
            ? rotation.messages.map(m => String(m || '').trim()).filter(Boolean)
            : [];
        const days = normalizeDays(rotation.days);

        if (!time || !groupId || messages.length === 0) return;

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
                const currentMessages = Array.isArray(current.messages)
                    ? current.messages.map(m => String(m || '').trim()).filter(Boolean)
                    : [];
                if (!currentGroupId || currentMessages.length === 0) return;

                const todayKey = getJerusalemDateKey(new Date());
                if (current.lastSentDateKey === todayKey) return;

                const rawNextIndex = Number(current.nextIndex);
                const safeNextIndex = Number.isInteger(rawNextIndex)
                    ? ((rawNextIndex % currentMessages.length) + currentMessages.length) % currentMessages.length
                    : 0;

                const messageToSend = currentMessages[safeNextIndex];
                await client.sendMessage(currentGroupId, messageToSend, { sendSeen: false });

                current.nextIndex = (safeNextIndex + 1) % currentMessages.length;
                current.lastSentDateKey = todayKey;
                list[idx] = current;
                latestConfig.groupMessageRotations = list;
                writeJSON(configPath, latestConfig);

                if (logger) logger(sessionId, `Daily rotation sent to ${currentGroupId} [rule=${rotationId}, index=${safeNextIndex}].`);
            } catch (err) {
                if (logger) logger(sessionId, `Daily rotation failed [rule=${rotationId}]: ${err.message}`);
            }
        }, { timezone: 'Asia/Jerusalem' });

        jobs.push(job);
    });

    sessionJobs.set(sessionId, jobs);
    if (logger) logger(sessionId, `Scheduler loaded (${jobs.length} jobs).`);
}

module.exports = { initScheduler, stopSchedulerForSession };
