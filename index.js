require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Initialize Discord Client
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Updated to 'clientReady' to eliminate the v15 deprecation warning
discordClient.once('clientReady', () => {
    console.log(`🤖 Discord Bot connected as: ${discordClient.user.tag}`);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', bot: discordClient.isReady() ? 'connected' : 'disconnected' });
});

// GET /api/discord/channels (Used by Android ChatsListScreen)
app.get('/api/discord/channels', async (req, res) => {
    try {
        const guildId = process.env.DISCORD_GUILD_ID;
        if (!guildId) {
            return res.status(500).json({ error: 'DISCORD_GUILD_ID is not configured in .env' });
        }

        const guild = await discordClient.guilds.fetch(guildId);
        const channels = await guild.channels.fetch();
        const activeThreads = await guild.channels.fetchActiveThreads();

        const result = [];

        // Parse Text Channels
        channels.forEach((ch) => {
            if (ch && ch.type === ChannelType.GuildText) {
                result.push({
                    id: ch.id,
                    name: ch.name,
                    isThread: false,
                    parentName: null,
                    lastMessage: 'Tap to view messages',
                    lastMessageTime: 'Active',
                    unreadCount: 0
                });
            }
        });

        // Parse Threads
        activeThreads.threads.forEach((th) => {
            result.push({
                id: th.id,
                name: th.name,
                isThread: true,
                parentName: th.parent ? th.parent.name : null,
                lastMessage: 'Active thread',
                lastMessageTime: 'Recent',
                unreadCount: 0
            });
        });

        res.json(result);
    } catch (error) {
        console.error('Error fetching channels:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET /api/chat/history/:channelId (Fetch live chat history directly from Discord)
app.get('/api/chat/history/:channelId', async (req, res) => {
    const { channelId } = req.params;

    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Fetch the 50 most recent messages directly from Discord
        const messages = await channel.messages.fetch({ limit: 50 });

        // Format for Jetpack Compose UI (reversed so oldest is top, newest is bottom)
        const formattedMessages = Array.from(messages.values()).reverse().map((msg) => ({
            id: msg.id,
            authorName: msg.author.username,
            authorAvatar: msg.author.displayAvatarURL() || '',
            content: msg.content,
            timestamp: msg.createdAt,
            isBot: msg.author.bot
        }));

        res.json(formattedMessages);
    } catch (error) {
        console.error('Error fetching chat history:', error);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/chat/send (Send message from Android to Discord)
app.post('/api/chat/send', async (req, res) => {
    const { channelId, message, senderName } = req.body;

    if (!channelId || !message) {
        return res.status(400).json({ error: 'channelId and message are required' });
    }

    try {
        const channel = await discordClient.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const sentMessage = await channel.send(`**${senderName || 'App User'}**: ${message}`);
        res.json({
            success: true,
            messageId: sentMessage.id,
            timestamp: sentMessage.createdAt
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start Express and log into Discord
app.listen(PORT, () => {
    console.log(`🚀 Express server running on port ${PORT}`);
    if (process.env.DISCORD_BOT_TOKEN) {
        discordClient.login(process.env.DISCORD_BOT_TOKEN);
    } else {
        console.warn('⚠️ DISCORD_BOT_TOKEN missing in .env file!');
    }
});