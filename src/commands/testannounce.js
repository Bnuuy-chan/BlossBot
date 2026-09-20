const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const config = require('../config');
const { fetchLatestVideos } = require('../youtube/feed');
const { announce } = require('../youtube/poller');

// One choice per watched channel, so the tester picks which one to fire. Discord allows up to 25.
const choices = config.channels.slice(0, 25).map((watch) => ({
  name: watch.name.slice(0, 100),
  value: watch.youtubeChannelId,
}));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testannounce')
    .setDescription('Post the latest video from a watched YouTube channel, to test the announcement')
    // Only people who can manage the server see and use this command.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName('channel')
        .setDescription('Which YouTube channel to test')
        .setRequired(true)
        .addChoices(...choices)
    )
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Which message to test (default: normal upload)')
        .addChoices({ name: 'Normal upload', value: 'video' }, { name: 'Going live', value: 'live' })
    ),

  async execute(interaction) {
    // Fetching the feed can take a moment, so acknowledge first. Only the user sees this reply.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const youtubeChannelId = interaction.options.getString('channel', true);
    const type = interaction.options.getString('type') || 'video';
    const watch = config.channels.find((c) => c.youtubeChannelId === youtubeChannelId);
    if (!watch) {
      await interaction.editReply('That channel is no longer in channels.json. Restart the bot to refresh the list.');
      return;
    }

    const { videos } = await fetchLatestVideos(watch.youtubeChannelId);
    if (videos.length === 0) {
      await interaction.editReply(`${watch.name} has no videos in its feed yet.`);
      return;
    }

    const template = type === 'live' ? watch.liveMessage || watch.message : watch.message;
    await announce(interaction.client, watch, videos[0], template);

    let note = '';
    if (type === 'live' && !watch.liveMessage) {
      note = ' This channel has no liveMessage in channels.json, so the normal message was used.';
    }
    await interaction.editReply(`Posted "${videos[0].title}" in <#${watch.discordChannelId}>.${note}`);
  },
};
