const cron = require('node-cron');
const { readJSON } = require('./utils');

function initScheduler(client) {
    const sessionId = client.options.authStrategy.clientId || 'default';
    const configPath = `./configs/session-${sessionId}.json`;
    const config = readJSON(configPath, { scheduledMessages: [] });

    if (!config.scheduledMessages) return;

    config.scheduledMessages.forEach((task) => {
        cron.schedule(task.cron, async () => {
            try {
                console.log(`[${sessionId}] Sending scheduled message to ${task.to}: ${task.message}`);
                await client.sendMessage(`${task.to}@c.us`, task.message);
            } catch (err) {
                console.error(`[${sessionId}] Failed to send scheduled message:`, err);
            }
        });
    });
}

module.exports = { initScheduler };
