const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check that the bot is online and how quickly it responds'),

  async execute(interaction) {
    await interaction.reply('Pinging...');
    const sent = await interaction.fetchReply();

    const roundTrip = sent.createdTimestamp - interaction.createdTimestamp;
    const heartbeat = interaction.client.ws.ping;
    const heartbeatText = heartbeat >= 0 ? `${Math.round(heartbeat)} ms` : 'not measured yet';

    await interaction.editReply(`🏓 Pong! Round trip: ${roundTrip} ms · Discord heartbeat: ${heartbeatText}`);
  },
};
