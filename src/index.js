// Entry point. Creates the Discord client, loads every command in src/commands,
// registers the slash commands, and starts the YouTube watcher.
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, Status } = require('discord.js');
const config = require('./config');
const log = require('./logger');
const { startPoller } = require('./youtube/poller');

// --- Crash loudly ---------------------------------------------------------
// A bot that is alive but broken is worse than one that is down, because nothing restarts it.
// On any unexpected error we log it and exit with a failure code so the host restarts us.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err);
  process.exit(1);
});

// --- Client ---------------------------------------------------------------
// Guilds is the only intent needed: slash commands and posting messages need nothing more.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

// --- Load commands from src/commands --------------------------------------
// Each file exports { data, execute }. Drop a new file in the folder and restart to add a command.
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (!command.data || typeof command.execute !== 'function') {
    log.warn(`Skipping commands/${file}: it must export "data" and "execute".`);
    continue;
  }
  client.commands.set(command.data.name, command);
}

// Every distinct Discord channel the bot posts to, fetched once at startup.
async function fetchAnnounceChannels() {
  const ids = [...new Set(config.channels.map((c) => c.discordChannelId))];
  const channels = [];
  for (const id of ids) {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (!channel || !channel.guildId) {
      throw new Error(`Discord channel ${id} in channels.json is not a server channel the bot can see.`);
    }
    channels.push(channel);
  }
  return channels;
}

// --- Register slash commands ----------------------------------------------
// Registered in every server that has an announcement channel.
// Server-scoped commands show up instantly (global ones can take up to an hour).
async function registerCommands(announceChannels) {
  const guildIds = [...new Set(announceChannels.map((c) => c.guildId))];
  const payload = [...client.commands.values()].map((c) => c.data.toJSON());
  const names = payload.map((c) => `/${c.name}`).join(', ');
  for (const guildId of guildIds) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(payload);
    log.info(`Registered ${payload.length} slash command(s) in "${guild.name}": ${names}`);
  }
}

// --- Permission check -----------------------------------------------------
// Warn at startup if the bot cannot post (or ping) in an announcement channel, so the fix is
// obvious from the logs instead of every announcement failing with "Missing Access".
async function checkPermissions(announceChannels) {
  for (const channel of announceChannels) {
    const me = await channel.guild.members.fetchMe();
    const perms = channel.permissionsFor(me);
    const needed = [
      [PermissionFlagsBits.ViewChannel, 'View Channel'],
      [PermissionFlagsBits.SendMessages, 'Send Messages'],
      [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
    ];

    // Pinging @everyone/@here, or a role that is not set as mentionable, needs one more permission.
    const watches = config.channels.filter((c) => c.discordChannelId === channel.id && c.pingRole);
    for (const watch of watches) {
      if (watch.pingRole === 'everyone' || watch.pingRole === 'here') {
        needed.push([PermissionFlagsBits.MentionEveryone, 'Mention @everyone, @here and All Roles']);
        continue;
      }
      const role = await channel.guild.roles.fetch(watch.pingRole).catch(() => null);
      if (!role) {
        log.warn(`[${watch.name}] pingRole ${watch.pingRole} is not a role in "${channel.guild.name}", so the ping will not work.`);
      } else if (!role.mentionable) {
        needed.push([PermissionFlagsBits.MentionEveryone, `Mention @everyone, @here and All Roles (to ping @${role.name})`]);
      }
    }

    const missing = [...new Set(needed.filter(([flag]) => !perms?.has(flag)).map(([, label]) => label))];
    if (missing.length > 0) {
      log.warn(
        `In #${channel.name} the bot is missing: ${missing.join(', ')}. ` +
          'Open that channel settings > Permissions, add the bot, and allow them. No restart needed.'
      );
    } else {
      log.info(`Permissions look good in #${channel.name}.`);
    }
  }
}

// --- Watchdog -------------------------------------------------------------
// discord.js reconnects on its own. If it is still not connected after this long,
// exit so the host restarts the whole bot.
function startWatchdog() {
  const GIVE_UP_AFTER_MINUTES = 10;
  let minutesDisconnected = 0;
  setInterval(() => {
    if (client.ws.status === Status.Ready) {
      minutesDisconnected = 0;
      return;
    }
    minutesDisconnected += 1;
    log.warn(`Not connected to Discord for ${minutesDisconnected} minute(s).`);
    if (minutesDisconnected >= GIVE_UP_AFTER_MINUTES) {
      log.error('Still disconnected. Exiting so the host can restart the bot.');
      process.exit(1);
    }
  }, 60_000);
}

// --- Events ---------------------------------------------------------------
client.once(Events.ClientReady, async () => {
  log.info(`Logged in as ${client.user.tag}`);
  let announceChannels;
  try {
    announceChannels = await fetchAnnounceChannels();
    await registerCommands(announceChannels);
  } catch (err) {
    log.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
  await checkPermissions(announceChannels).catch((err) => log.warn(`Could not check channel permissions: ${err.message}`));
  startPoller(client);
  startWatchdog();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    log.error(`/${interaction.commandName} failed:`, err);
    const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
    // Use whichever way of answering is still valid for this interaction. Ignore failures here.
    let send;
    if (interaction.deferred) send = interaction.editReply(reply);
    else if (interaction.replied) send = interaction.followUp(reply);
    else send = interaction.reply(reply);
    await send.catch(() => {});
  }
});

// Connection diagnostics, useful when reading host logs.
client.on(Events.ShardDisconnect, (event) => log.warn(`Disconnected from Discord (code ${event.code}).`));
client.on(Events.ShardReconnecting, () => log.info('Reconnecting to Discord...'));
client.on(Events.ShardResume, () => log.info('Connection to Discord resumed.'));
client.on(Events.Error, (err) => log.error('Discord client error:', err));
client.on(Events.Warn, (message) => log.warn(message));

client.login(config.token).catch((err) => {
  log.error(`Could not log in: ${err.message}`);
  process.exit(1);
});
