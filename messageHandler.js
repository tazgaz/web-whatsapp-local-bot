const fs = require('fs');
const axios = require('axios');

const { readJSON, writeJSON } = require('./utils');

const STATES_FILE = './user_states.json';

// In-memory cache
let userStates = readJSON(STATES_FILE);

function saveStates() {
    writeJSON(STATES_FILE, userStates);
}

async function handleMessage(message, client, logCallback) {
    const sessionId = client.options.authStrategy.clientId || 'default';
    const configPath = `./configs/session-${sessionId}.json`;
    const config = readJSON(configPath, { autoReplies: [], forwarding: [], scheduledMessages: [] });
    const text = message.body.toLowerCase();
    const sender = message.from;

    // Get current user state - specific to this session
    const stateKey = `${sessionId}_${sender}`;
    const currentState = userStates[stateKey] || '';

    for (const rule of config.autoReplies) {
        // 1. Check sources (Group/Private/Specific IDs)
        const isGroupMsg = sender.endsWith('@g.us');

        // Filter by type if specified
        if (rule.isGroupOnly && !isGroupMsg) continue;
        if (rule.isPrivateOnly && isGroupMsg) continue;

        const allowedSources = rule.allowedSources || [];
        if (allowedSources.length > 0) {
            const isAllowed = allowedSources.some(source => sender.includes(source));
            if (!isAllowed) continue;
        }

        // 2. State Check (Context)
        const ruleContext = rule.context || '';
        if (ruleContext !== '' && ruleContext !== currentState) {
            continue;
        }

        // 3. Check triggers
        const triggers = rule.triggers || [];
        const hasNoTriggers = triggers.length === 0;
        let isMatched = hasNoTriggers;

        if (!hasNoTriggers) {
            for (const trigger of triggers) {
                const triggerValue = typeof trigger === 'object' ? trigger.value : trigger;
                const matchType = typeof trigger === 'object' ? trigger.type : (rule.matchType || 'contains');

                const t = triggerValue.toLowerCase();
                let match = false;

                switch (matchType) {
                    case 'equals': if (text === t) match = true; break;
                    case 'startsWith': if (text.startsWith(t)) match = true; break;
                    case 'endsWith': if (text.endsWith(t)) match = true; break;
                    case 'regex':
                        try {
                            const re = new RegExp(triggerValue, 'i');
                            if (re.test(message.body)) match = true;
                        } catch (e) { }
                        break;
                    case 'contains':
                    default: if (text.includes(t)) match = true; break;
                }

                if (match) {
                    isMatched = true;
                    break;
                }
            }
        }

        if (isMatched) {
            // Reply
            if (rule.reply) {
                await client.sendMessage(sender, rule.reply);
                if (logCallback) logCallback(`✅ מענה נשלח בהצלחה: "${rule.reply}" (מצב נוכחי: ${currentState || 'התחלה'})`);

                // Update State for next time
                if (rule.nextState) {
                    userStates[stateKey] = rule.nextState;
                    saveStates();
                    if (logCallback) logCallback(`🔄 המשתמש עבר לשלב: ${rule.nextState}`);
                }
            }

            // Webhook
            if (rule.webhookUrl) {
                if (logCallback) logCallback(`🔗 שולח Webhook לכתובת: ${rule.webhookUrl}`);
                try {
                    const response = await axios.post(rule.webhookUrl, {
                        event: 'message_match',
                        sessionId: sessionId,
                        message: message.body,
                        from: sender,
                        pushname: 'Unknown',
                        currentState: currentState,
                        nextState: rule.nextState || currentState,
                        timestamp: Date.now()
                    });
                    if (logCallback) logCallback(`✅ Webhook נשלח בהצלחה (קוד: ${response.status})`);
                } catch (err) {
                    if (logCallback) logCallback(`✗ שגיאה בשליחת Webhook: ${err.message}`);
                }
            }
            return;
        }
    }

    // Forwarding
    for (const rule of config.forwarding || []) {
        if (text.includes(rule.trigger.toLowerCase())) {
            try {
                const contact = await message.getContact();
                await client.sendMessage(`${rule.forwardTo}@c.us`, `[${sessionId}] הודעה מ-${contact.number}: ${message.body}`);
            } catch (err) {
                await client.sendMessage(`${rule.forwardTo}@c.us`, `[${sessionId}] הודעה מ-${sender}: ${message.body}`);
            }
            return;
        }
    }
}

module.exports = { handleMessage };
