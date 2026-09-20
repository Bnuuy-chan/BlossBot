# Upload Announcer Bot

A Discord bot that watches one or more YouTube channels and posts a custom message in Discord whenever a new video is uploaded. Built with Node.js and discord.js.

## How it works

- Every few minutes the bot reads each YouTube channel's public RSS feed (no API key needed).
- The first time it sees a channel it remembers the videos that already exist and announces nothing. After that, anything new gets posted.
- Announced video IDs are saved in `data/state.json`, so restarts never re-announce old videos.
- Each watched channel has its own Discord channel, optional role ping, and message template.
- Shorts and live streams are skipped unless you switch them on per channel. A channel can have its own "going live" message, posted the moment a stream starts. Scheduled premieres are announced once they start.
- Discord turns the posted link into a preview with the thumbnail automatically.

## Commands

| Command | What it does |
|---|---|
| `/ping` | Checks the bot is online and shows response times. |
| `/testannounce` | Posts the latest video from a watched channel right now, to test the announcement. The optional `type` previews the "going live" message. Only visible to people with Manage Server. |

## Running it locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env` and put your bot token in it.
3. Copy `channels.example.json` to `channels.json` and fill in your channels (see below).
4. Install dependencies and start:

```
npm install
npm start
```

You should see `Logged in as ...`, the registered commands, a permissions check for each Discord channel, and the list of YouTube channels being watched.

## Configuring channels (`channels.json`)

`channels.json` is a list. Each entry is one YouTube channel to watch:

```json
{
  "name": "Blossom",
  "youtubeChannelId": "UCxxxxxxxxxxxxxxxxxxxxxx",
  "discordChannelId": "123456789012345678",
  "pingRole": "123456789012345678",
  "message": [
    "Hey {role},",
    "{channel} just posted a video! Go check it out.",
    "",
    "{link}"
  ],
  "liveMessage": [
    "{role} {channel} is **LIVE**!",
    "{link}"
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | no | Label shown in logs and in the `/testannounce` picker. Defaults to the channel ID. |
| `youtubeChannelId` | yes | YouTube channel ID (starts with `UC`). See below for how to find it. |
| `discordChannelId` | yes | Discord channel that receives the announcements. |
| `pingRole` | no | Role ID to ping, or `everyone` / `here`. Leave out for no ping. |
| `message` | yes | The message to post, either one string or a list of lines. |
| `announceShorts` | no | `true` to announce Shorts too. Default `false`. |
| `liveMessage` | no | Message to post the moment the channel goes live, as one string or a list of lines. Setting it switches live announcements on. |
| `announceLives` | no | `true` announces live streams with the normal `message` when there is no `liveMessage`. `false` switches live announcements off even if a `liveMessage` is set. |

Placeholders you can use in `message` and `liveMessage`. Markdown you type yourself, like `**bold**`, is kept:

| Placeholder | Becomes |
|---|---|
| `{role}` | The role ping (blank if `pingRole` is not set) |
| `{channel}` | The YouTube channel's name |
| `{title}` | The video title |
| `{link}` | The video URL (Discord shows a preview for it) |

To find a YouTube channel ID: open the channel page, click **About** (or the "more" link in the description), then **Share channel** > **Copy channel ID**. To find Discord channel and role IDs, turn on Developer Mode in Discord's Advanced settings, then right-click the channel or role and choose **Copy ID**.

The bot reads `channels.json` at startup, so restart it after changing the file.

## What gets announced

YouTube's feed lists everything a channel publishes, so before posting the bot looks up each new video:

- Normal uploads are announced. A scheduled premiere is announced once it starts.
- Shorts are skipped unless the entry has `"announceShorts": true`.
- Live streams are skipped unless the entry has a `liveMessage` (or `"announceLives": true`). When switched on, a stream is announced once, at the moment it goes live. A scheduled stream waits until it starts, and a stream that has already ended is never announced.
- A live alert can lag by up to one check interval, and a little longer for unscheduled streams because YouTube's own feed takes a few minutes to list them. Lower `POLL_INTERVAL_MINUTES` in `.env` for faster alerts.
- If YouTube cannot be read to tell what a video is, the bot retries on the next two checks and then announces it anyway, so a broken check can never silently mute the bot.

## Channel permissions

The bot needs **View Channel**, **Send Messages** and **Embed Links** in every announcement channel. If a channel is private, add the bot (or its role) in the channel's settings under Permissions and allow those. To ping `everyone` / `here`, or a role that is not set to "allow anyone to mention", it also needs **Mention @everyone, @here and All Roles**.

The bot checks all of this every time it starts and logs a warning naming anything that is missing.

## Hosting on PebbleHost (or any panel host)

1. Upload everything except `node_modules/` and `data/`. Include your filled-in `.env` and `channels.json`.
2. Set the startup file to `index.js` and pick Node.js 18 or newer.
3. Make sure the panel installs packages (`npm install`) on first start. If it does not, run it once from the panel console.
4. Turn on the panel's crash detection / auto restart. The bot exits with a failure code on any unrecoverable error on purpose, so the host restarts it.

## Adding a command

Create a new file in `src/commands/`, for example `src/commands/hello.js`:

```js
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder().setName('hello').setDescription('Says hello'),
  async execute(interaction) {
    await interaction.reply('Hello!');
  },
};
```

Restart the bot. Commands are registered automatically on startup, and server-scoped commands appear in Discord right away.

## Project layout

```
src/
  index.js            starts the bot, loads and registers commands, checks permissions, starts the watcher
  config.js           reads and checks .env and channels.json
  logger.js           timestamped console logging
  storage.js          remembers announced videos per channel in data/state.json
  commands/           one file per slash command
  youtube/feed.js     fetches and parses a YouTube RSS feed
  youtube/classify.js tells normal uploads apart from Shorts and live streams
  youtube/poller.js   checks every watched channel on a timer and posts new videos
index.js              start file the host runs; it just loads src/index.js
channels.example.json example watch list (copy to channels.json)
.env.example          example secrets file (copy to .env)
```
