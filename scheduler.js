const cron = require('node-cron');
const config = require('./config.json');

function initScheduler(client) {
    config.scheduledMessages.forEach((task) => {
        cron.schedule(task.cron, async () => {
            try {
                console.log(`Sending scheduled message to ${task.to}: ${task.message}`);
                await client.sendMessage(`${task.to}@c.us`, task.message);
            } catch (err) {
                console.error(`Failed to send scheduled message:`, err);
            }
        });
    });
}

module.exports = { initScheduler };
