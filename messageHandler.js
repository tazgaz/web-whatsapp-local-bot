const fs = require('fs');
const axios = require('axios');

const { readJSON, writeJSON } = require('./utils');

const STATES_FILE = './user_states.json';

// In-memory cache
let userStates = readJSON(STATES_FILE);

function saveStates() {
    writeJSON(STATES_FILE, userStates);
}

async function handleMessage(message, client, sessionId, logCallback) {
    const configPath = `./configs/session-${sessionId}.json`;
    const config = readJSON(configPath, { autoReplies: [], forwarding: [], scheduledMessages: [] });
    const text = message.body.toLowerCase();
    const sender = message.from;

    // Get current user state - specific to this session
    // If outgoing, context is typically 'self' or target, but we'll use 'to' for state tracking if it's an outgoing message to keep conversation state
    // But for simplicity, we keep tracking based on the "other party" (from if incoming, to if outgoing)
    const otherParty = message.fromMe ? message.to : message.from;
    const stateKey = `${sessionId}_${otherParty}`;
    const currentState = userStates[stateKey] || '';

    for (const rule of config.autoReplies) {
        // 0. Check Trigger Direction (Incoming/Outgoing)
        // Values: 'incoming' (default), 'outgoing', 'both'
        const triggerOn = rule.triggerOn || 'incoming';
        const isFromMe = message.fromMe;

        if (triggerOn === 'incoming' && isFromMe) continue;
        if (triggerOn === 'outgoing' && !isFromMe) continue;

        // 1. Check sources (Group/Private/Specific IDs)
        // Use otherParty to identify the source/destination context
        const isGroupMsg = otherParty.endsWith('@g.us');

        // Filter by type if specified
        if (rule.isGroupOnly && !isGroupMsg) continue;
        if (rule.isPrivateOnly && isGroupMsg) continue;

        const allowedSources = rule.allowedSources || [];
        if (allowedSources.length > 0) {
            const isAllowed = allowedSources.some(source => otherParty.includes(source));
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
                // If I triggered it (outgoing), reply to the chat (otherParty). If incoming, reply to sender (which is otherParty).
                await client.sendMessage(otherParty, rule.reply);
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
                    let mediaData = null;
                    if (message.hasMedia) {
                        try {
                            const media = await message.downloadMedia();
                            if (media) {
                                mediaData = {
                                    mimetype: media.mimetype,
                                    data: media.data, // Base64 string
                                    filename: media.filename
                                };
                            }
                        } catch (e) {
                            if (logCallback) logCallback(`⚠️ שגיאה בהורדת מדיה: ${e.message}`);
                        }
                    }

                    const response = await axios.post(rule.webhookUrl, {
                        event: 'message_match',
                        sessionId: sessionId,
                        message: message.body,
                        media: mediaData,
                        from: sender, // This is 'otherParty' logic if we want consistency, but sender is original source for webhook info usually. Let's keep strict sender.
                        // Actually, if I trigger it (outgoing), sender is ME. Webhook consumer might get confused.
                        // Ideally we send both sender and 'direction' or similar.
                        // For now keeping 'from: sender' is technically correct (who sent the msg).
                        originalSender: message.from,
                        isFromMe: message.fromMe,
                        pushname: message._data.notifyName || 'Unknown',
                        currentState: currentState,
                        nextState: rule.nextState || currentState,
                        timestamp: Date.now()
                    });
                    if (logCallback) logCallback(`✅ Webhook נשלח בהצלחה (קוד: ${response.status})`);
                } catch (err) {
                    if (logCallback) logCallback(`✗ שגיאה בשליחת Webhook: ${err.message}`);
                }
            }
            return { replied: !!rule.reply, trigger: rule.description || (triggers[0]?.value || 'כללי') };
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
            return { replied: false };
        }
    }
    return { replied: false };
}

module.exports = { handleMessage };
