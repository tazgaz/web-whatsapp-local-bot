const fs = require('fs');
const axios = require('axios');

const STATES_FILE = './user_states.json';

// Load states from file or init
let userStates = {};
if (fs.existsSync(STATES_FILE)) {
    try {
        userStates = JSON.parse(fs.readFileSync(STATES_FILE, 'utf8'));
    } catch (e) {
        userStates = {};
    }
}

function saveStates() {
    fs.writeFileSync(STATES_FILE, JSON.stringify(userStates, null, 2));
}

async function handleMessage(message, client, logCallback) {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    const text = message.body.toLowerCase();
    const sender = message.from;

    // Get current user state
    const currentState = userStates[sender] || '';

    for (const rule of config.autoReplies) {
        // 1. Check sources
        const allowedSources = rule.allowedSources || [];
        if (allowedSources.length > 0) {
            const isAllowed = allowedSources.some(source => sender.includes(source));
            if (!isAllowed) continue;
        }

        // 2. State Check (Context)
        const ruleContext = rule.context || '';
        // If rule has a context, user MUST be in that state.
        // If rule has no context, anyone can trigger it.
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
                    userStates[sender] = rule.nextState;
                    saveStates();
                    if (logCallback) logCallback(`🔄 המשתמש עבר לשלב: ${rule.nextState}`);
                }
            }

            // Webhook
            if (rule.webhookUrl) {
                try {
                    const contact = await message.getContact();
                    await axios.post(rule.webhookUrl, {
                        event: 'message_match',
                        message: message.body,
                        from: sender,
                        pushname: contact.pushname,
                        currentState: currentState,
                        nextState: rule.nextState || currentState
                    });
                } catch (err) { }
            }
            return;
        }
    }

    // Forwarding
    for (const rule of config.forwarding) {
        if (text.includes(rule.trigger.toLowerCase())) {
            const contact = await message.getContact();
            await client.sendMessage(`${rule.forwardTo}@c.us`, `הודעה מ-${contact.number}: ${message.body}`);
            return;
        }
    }
}

module.exports = { handleMessage };
