const fs = require('fs');
const axios = require('axios');

async function handleMessage(message, client, logCallback) {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    const text = message.body.toLowerCase();
    const sender = message.from;

    for (const rule of config.autoReplies) {
        // 1. Check if source is allowed
        const allowedSources = rule.allowedSources || [];
        if (allowedSources.length > 0) {
            const isAllowed = allowedSources.some(source => sender.includes(source));
            if (!isAllowed) continue;
        }

        // 2. Check triggers
        const triggers = rule.triggers || [];
        const hasNoTriggers = triggers.length === 0;
        let isMatched = hasNoTriggers;

        if (!hasNoTriggers) {
            for (const trigger of triggers) {
                // Support both old string format and new object format
                const triggerValue = typeof trigger === 'object' ? trigger.value : trigger;
                const matchType = typeof trigger === 'object' ? trigger.type : (rule.matchType || 'contains');

                const t = triggerValue.toLowerCase();
                let match = false;

                switch (matchType) {
                    case 'equals':
                        if (text === t) match = true;
                        break;
                    case 'startsWith':
                        if (text.startsWith(t)) match = true;
                        break;
                    case 'endsWith':
                        if (text.endsWith(t)) match = true;
                        break;
                    case 'regex':
                        try {
                            const re = new RegExp(triggerValue, 'i');
                            if (re.test(message.body)) match = true;
                        } catch (e) {
                            if (logCallback) logCallback(`✗ Regex Error: ${e.message}`);
                        }
                        break;
                    case 'contains':
                    default:
                        if (text.includes(t)) match = true;
                        break;
                }

                if (match) {
                    isMatched = true;
                    if (logCallback) logCallback(`🎯 נמצאה התאמה (${matchType}): "${triggerValue}"`);
                    break;
                }
            }
        }

        if (isMatched) {
            const reason = hasNoTriggers ? 'כלל "תפוס הכל"' : 'התאמה של מילת מפתח';
            if (logCallback) logCallback(`🚀 שולח מענה אוטומטי (${reason})...`);

            if (rule.reply) {
                await client.sendMessage(sender, rule.reply);
                if (logCallback) logCallback(`✅ מענה נשלח בהצלחה ל-${sender}`);
            }

            if (rule.webhookUrl) {
                if (logCallback) logCallback(`🔗 שולח Webhook ל-${rule.webhookUrl}...`);
                try {
                    const contact = await message.getContact();
                    await axios.post(rule.webhookUrl, {
                        event: 'message_match',
                        trigger: isMatched,
                        message: message.body,
                        from: sender,
                        pushname: contact.pushname,
                        timestamp: Date.now()
                    });
                    if (logCallback) logCallback(`✅ Webhook נשלח בהצלחה.`);
                } catch (err) {
                    if (logCallback) logCallback(`✗ שגיאה בשליחת Webhook: ${err.message}`);
                }
            }
            return;
        }
    }

    // Forwarding logic
    for (const rule of config.forwarding) {
        if (text.includes(rule.trigger.toLowerCase())) {
            if (logCallback) logCallback(`⏩ מעביר הודעה ל-${rule.forwardTo}...`);
            const contact = await message.getContact();
            const forwardText = `Forwarded message from ${contact.number}: ${message.body}`;
            await client.sendMessage(`${rule.forwardTo}@c.us`, forwardText);
            return;
        }
    }
}

module.exports = { handleMessage };
