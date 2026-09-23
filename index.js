require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Optional: Comma-separated channel IDs in .env (e.g. WHITELISTED_CHANNELS=123,456)
const WHITELISTED_CHANNELS = process.env.WHITELISTED_CHANNELS
    ? process.env.WHITELISTED_CHANNELS.split(',').map(id => id.trim())
    : null;

// Initialize Discord Client
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Create HTTP & WebSocket Server
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Map of active sockets -> subscribed channelId
const activeSockets = new Map();

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const channelId = url.searchParams.get('channelId');

    if (channelId) {
        activeSockets.set(ws, channelId);
        console.log(`🔌 Client connected to channel: ${channelId}`);
    }

    // Handle incoming messages from Android app over socket
    ws.on('message', async (rawMessage) => {
        try {
            const data = JSON.parse(rawMessage.toString());
            // Expects: { channelId, senderName, content, localTempId }
            if (data.channelId && data.content) {
                const channel = await discordClient.channels.fetch(data.channelId);
                if (channel) {
                    const sentMsg = await channel.send(`**${data.senderName || 'App User'}**: ${data.content}`);

                    // Return confirmation ACK frame back to sender
                    const ackPayload = {
                        id: sentMsg.id,
                        channelId: sentMsg.channelId,
                        senderName: data.senderName || 'App User',
                        senderAvatarUrl: null,
                        content: data.content,
                        timestamp: sentMsg.createdTimestamp,
                        localTempId: data.localTempId
                    };
                    ws.send(JSON.stringify(ackPayload));
                }
            }
        } catch (err) {
            console.error('Error handling WebSocket message:', err);
        }
    });

    ws.on('close', () => {
        activeSockets.delete(ws);
        console.log('🔌 Client disconnected');
    });
});

// Broadcast live Discord events to connected mobile clients
function broadcastMessage(networkMsg) {
    activeSockets.forEach((subscribedChannelId, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            if (!subscribedChannelId || subscribedChannelId === networkMsg.channelId) {
                ws.send(JSON.stringify(networkMsg));
            }
        }
    });
}

// Discord Listener: Stream live messages
discordClient.on('messageCreate', (msg) => {
    if (WHITELISTED_CHANNELS && !WHITELISTED_CHANNELS.includes(msg.channelId)) {
        return;
    }

    const networkMsg = {
        id: msg.id,
        channelId: msg.channelId,
        senderName: msg.author.username,
        senderAvatarUrl: msg.author.displayAvatarURL() || null,
        content: msg.content,
        timestamp: msg.createdTimestamp // Unix epoch milliseconds
    };

    broadcastMessage(networkMsg);
});

discordClient.once('clientReady', () => {
    console.log(`🤖 Discord Bot connected as: ${discordClient.user.tag}`);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: discordClient.isReady() ? 'connected' : 'disconnected' });
});

// GET /api/discord/channels (Used by Android Channel Selection Screen)
app.get('/api/discord/channels', async (req, res) => {
    try {
        const guildId = process.env.DISCORD_GUILD_ID;
        if (!guildId) {
            return res.status(500).json({ error: 'DISCORD_GUILD_ID is not configured' });
        }

        const guild = await discordClient.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const activeThreads = await guild.channels.fetchActiveThreads();

        const result = [];

        channels.forEach((ch) => {
            if (ch && ch.type === ChannelType.GuildText) {
                if (!WHITELISTED_CHANNELS || WHITELISTED_CHANNELS.includes(ch.id)) {
                    result.push({
                        id: ch.id,
                        name: ch.name,
                        isThread: false,
                        parentName: null,
                        lastMessage: 'Tap to open chat',
                        lastMessageTime: 'Active',
                        unreadCount: 0
                    });
                }
            }
        });

        activeThreads.threads.forEach((th) => {
            if (!WHITELISTED_CHANNELS || WHITELISTED_CHANNELS.includes(th.id)) {
                result.push({
                    id: th.id,
                    name: th.name,
                    isThread: true,
                    parentName: th.parent ? th.parent.name : null,
                    lastMessage: 'Active thread',
                    lastMessageTime: 'Recent',
                    unreadCount: 0
                });
            }
        });

        res.json(result);
    } catch (error) {
        console.error('Error fetching channels:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/messages?channelId=123&after=456 (WhatsApp Catch-Up REST Endpoint)
app.get('/api/messages', async (req, res) => {
    const { channelId, after, limit } = req.query;

    if (!channelId) {
        return res.status(400).json({ error: 'channelId query param is required' });
    }

    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const fetchOptions = { limit: parseInt(limit) || 50 };
        if (after) {
            fetchOptions.after = after;
        }

        const messages = await channel.messages.fetch(fetchOptions);

        const formattedMessages = Array.from(messages.values())
            .reverse()
            .map((msg) => ({
                id: msg.id,
                channelId: msg.channelId,
                senderName: msg.author.username,
                senderAvatarUrl: msg.author.displayAvatarURL() || null,
                content: msg.content,
                timestamp: msg.createdTimestamp
            }));

        res.json(formattedMessages);
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
server.listen(PORT, () => {
    console.log(`🚀 Express + WebSockets running on port ${PORT}`);
    if (process.env.DISCORD_BOT_TOKEN) {
        discordClient.login(process.env.DISCORD_BOT_TOKEN);
    } else {
        console.warn('⚠️ DISCORD_BOT_TOKEN missing in .env');
    }
});