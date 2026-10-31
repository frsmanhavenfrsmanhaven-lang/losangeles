'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ContainerBuilder,
  TextDisplayBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  MessageFlags
} = require('discord.js');

const ENV = process.env;

for (const key of ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']) {
  if (!ENV[key]) {
    throw new Error(`Missing ${key} in .env`);
  }
}

const API_BASE = (
  ENV.ERLC_BASE_URL || 'https://api.erlc.gg/v1'
).replace(/\/+$/, '');

const POLL_INTERVAL = Math.max(
  30000,
  Number(ENV.POLL_INTERVAL_MS) || 60000
);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =============================================
// DATABASE
// =============================================

const DATA_PATH = path.join(__dirname, 'data.json');
const RESPONSES_PATH = path.join(__dirname, 'responses.json');

function defaults() {
  return {
    linkedUsers: {},
    pendingLinks: {},
    tickets: {},
    session: {
      active: false,
      startedAt: null,
      hostId: null,
      messageId: null,
      channelId: null,
      infoMessageId: null
    },
    vote: null
  };
}

let db = defaults();

if (fs.existsSync(DATA_PATH)) {
  const stored = JSON.parse(
    fs.readFileSync(DATA_PATH, 'utf8')
  );

  db = {
    ...defaults(),
    ...stored,
    linkedUsers: stored.linkedUsers || {},
    pendingLinks: stored.pendingLinks || {},
    tickets: stored.tickets || {},
    session: {
      ...defaults().session,
      ...(stored.session || {})
    }
  };
}

let saveQueue = Promise.resolve();

function save() {
  const content = JSON.stringify(db, null, 2);

  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      const temporary = DATA_PATH + '.tmp';

      await fs.promises.writeFile(
        temporary,
        content,
        'utf8'
      );

      await fs.promises.rename(
        temporary,
        DATA_PATH
      );
    });

  return saveQueue;
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/@/g, '＠')
    .replace(/[`*_~|>]/g, '\\$&');
}

function timestamp(value) {
  return `<t:${Math.floor(value / 1000)}:R>`;
}

function errorMessage(error) {
  return String(error?.message || error);
}

// =============================================
// COMPONENTS V2
// ALL BANNERS APPEAR AT THE TOP
// =============================================

function createButton(
  id,
  label,
  style = ButtonStyle.Secondary,
  disabled = false
) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function createRow(...components) {
  return new ActionRowBuilder()
    .addComponents(...components);
}

function createPanel(
  title,
  content,
  bannerKey = null,
  actionRows = []
) {
  const container = new ContainerBuilder();

  // FIRST: Banner at the very top.
  const banner = bannerKey ? ENV[bannerKey] : null;

  if (banner && /^https?:\/\//i.test(banner)) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(banner)
      )
    );
  }

  // SECOND: Title and information below the banner.
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `# ${title}\n\n${content}`
    )
  );

  // THIRD: Buttons and menus at the bottom.
  for (const row of actionRows) {
    container.addActionRowComponents(row);
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] }
  };
}

async function replyPrivate(interaction, content) {
  if (interaction.deferred) {
    return interaction.editReply({
      content,
      allowedMentions: { parse: [] }
    });
  }

  if (interaction.replied) {
    return interaction.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    });
  }

  return interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] }
  });
}

// =============================================
// PERMISSIONS AND MELONLY VERIFICATION
// =============================================

function memberHasRole(member, roleId) {
  return Boolean(
    roleId &&
    member?.roles?.cache?.has(roleId)
  );
}

function hasAdmin(member) {
  return Boolean(
    member?.permissions?.has(
      PermissionFlagsBits.Administrator
    )
  );
}

function hasStaff(member) {
  return Boolean(
    hasAdmin(member) ||
    member?.permissions?.has(
      PermissionFlagsBits.ManageGuild
    ) ||
    memberHasRole(member, ENV.STAFF_ROLE_ID)
  );
}

async function staffOnly(interaction) {
  if (hasStaff(interaction.member)) return true;

  await replyPrivate(
    interaction,
    'You do not have permission to use this command.'
  );

  return false;
}

async function adminOnly(interaction) {
  if (hasAdmin(interaction.member)) return true;

  await replyPrivate(
    interaction,
    'Administrator permission required.'
  );

  return false;
}

function isMelonlyVerified(member) {
  return memberHasRole(member, ENV.VERIFIED_ROLE_ID);
}

async function fetchFreshMember(guild, userId) {
  return guild.members.fetch({
    user: userId,
    force: true
  });
}

async function checkMelonlyVerification(interaction) {
  const member = await fetchFreshMember(
    interaction.guild,
    interaction.user.id
  );

  console.log('\n========== MELONLY ROLE DEBUG ==========');
  console.log('Discord User:', interaction.user.tag);
  console.log('Discord User ID:', interaction.user.id);
  console.log(
    'Configured Verified Role ID:',
    ENV.VERIFIED_ROLE_ID || 'NOT SET'
  );
  console.log('Member Roles:');

  for (const role of member.roles.cache.values()) {
    console.log(`- ${role.name}: ${role.id}`);
  }

  const verified = isMelonlyVerified(member);

  console.log('Verified Role Detected:', verified);
  console.log('========================================\n');

  return {
    member,
    verified
  };
}

// =============================================
// LOGGING
// =============================================

async function sendLog(title, description) {
  if (!ENV.LOG_CHANNEL_ID) return;

  try {
    const channel = await client.channels.fetch(
      ENV.LOG_CHANNEL_ID
    );

    if (!channel?.isTextBased()) return;

    await channel.send(
      createPanel(
        `Los Angeles Roleplay | ${title}`,
        description +
          `\n\n**Logged At:** ${timestamp(Date.now())}`,
        'LOG_BANNER'
      )
    );
  } catch (error) {
    console.warn(
      'Logging error:',
      errorMessage(error)
    );
  }
}

// =============================================
// ER:LC API
// =============================================

async function erlc(endpoint) {
  if (!ENV.ERLC_API_KEY) {
    throw new Error(
      'ERLC_API_KEY is missing from .env'
    );
  }

  const response = await fetch(
    API_BASE + endpoint,
    {
      headers: {
        'Server-Key': ENV.ERLC_API_KEY,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `ER:LC API ${response.status}: ${details.slice(0, 350)}`
    );
  }

  return response.json();
}

function parsePlayer(value) {
  const match = String(value || '').match(
    /^(.*?)\s*:\s*(\d+)$/
  );

  if (!match) return null;

  return {
    username: match[1].trim(),
    robloxId: match[2]
  };
}

function getPlayerInfo(player) {
  if (!player || typeof player !== 'object') {
    return parsePlayer(player) || {
      username: '',
      robloxId: ''
    };
  }

  const parsed = parsePlayer(
    player.Player ||
    player.player ||
    player.Name ||
    player.name
  );

  return {
    username: String(
      parsed?.username ||
      player.Username ||
      player.username ||
      ''
    ),
    robloxId: String(
      parsed?.robloxId ||
      player.UserId ||
      player.userId ||
      player.id ||
      ''
    )
  };
}

function getQueueIds(queue) {
  return queue.map(item => {
    if (typeof item === 'string') {
      const parsed = parsePlayer(item);

      return parsed?.robloxId ||
        (/^\d+$/.test(item) ? item : '');
    }

    if (typeof item === 'number') {
      return String(item);
    }

    if (!item || typeof item !== 'object') {
      return '';
    }

    const parsed = parsePlayer(
      item.Player || item.player
    );

    return String(
      parsed?.robloxId ||
      item.UserId ||
      item.userId ||
      item.id ||
      ''
    );
  }).filter(Boolean);
}

async function getServerData() {
  const [players, queue] = await Promise.all([
    erlc('/server/players'),
    erlc('/server/queue')
  ]);

  if (!Array.isArray(players) || !Array.isArray(queue)) {
    throw new Error(
      'Unexpected ER:LC player or queue response.'
    );
  }

  return { players, queue };
}

// =============================================
// ROBLOX USERNAME LOOKUP
// =============================================

async function lookupRobloxUsername(username) {
  const response = await fetch(
    'https://users.roblox.com/v1/usernames/users',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usernames: [username],
        excludeBannedUsers: false
      }),
      signal: AbortSignal.timeout(12000)
    }
  );

  if (!response.ok) {
    throw new Error(
      `Roblox lookup failed: ${response.status}`
    );
  }

  const result = await response.json();
  const user = result.data?.[0];

  if (!user?.id || !user?.name) return null;

  return {
    robloxId: String(user.id),
    robloxUsername: user.name
  };
}

// =============================================
// ROBLOX ACCOUNT LINKING
// =============================================

async function requestRobloxLink(interaction) {
  if (!ENV.VERIFIED_ROLE_ID) {
    return replyPrivate(
      interaction,
      'VERIFIED_ROLE_ID is missing from your bot configuration.'
    );
  }

  const { verified } = await checkMelonlyVerification(
    interaction
  );

  if (!verified) {
    return replyPrivate(
      interaction,
      'Your Melonly Verified role was not detected. Ask management to check the configured role ID.'
    );
  }

  if (db.linkedUsers[interaction.user.id]) {
    const linked = db.linkedUsers[interaction.user.id];

    return replyPrivate(
      interaction,
      `You are already linked to ${escapeText(linked.robloxUsername)}. Contact staff if this is incorrect.`
    );
  }

  if (db.pendingLinks[interaction.user.id]) {
    return replyPrivate(
      interaction,
      'You already have a Roblox link request awaiting staff review.'
    );
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  const username = interaction.options.getString(
    'username',
    true
  );

  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return interaction.editReply(
      'Enter a valid Roblox username, not a display name.'
    );
  }

  const account = await lookupRobloxUsername(
    username
  );

  if (!account) {
    return interaction.editReply(
      'That Roblox username could not be found.'
    );
  }

  const duplicateApproved = Object.entries(
    db.linkedUsers
  ).some(
    ([discordId, record]) =>
      discordId !== interaction.user.id &&
      String(record.robloxId) === account.robloxId
  );

  const duplicatePending = Object.entries(
    db.pendingLinks
  ).some(
    ([discordId, record]) =>
      discordId !== interaction.user.id &&
      String(record.robloxId) === account.robloxId
  );

  if (duplicateApproved || duplicatePending) {
    return interaction.editReply(
      'This Roblox account is already linked or has a pending link request.'
    );
  }

  db.pendingLinks[interaction.user.id] = {
    ...account,
    requestedAt: Date.now()
  };

  await save();

  await sendLog(
    'Roblox Link Requested',
    `**Discord User:** <@${interaction.user.id}>\n` +
    `**Roblox Username:** ${escapeText(account.robloxUsername)}\n` +
    `**Roblox ID:** ${account.robloxId}\n` +
    '**Status:** Awaiting staff approval\n\n' +
    'Staff must independently confirm ownership of the Roblox account.'
  );

  return interaction.editReply(
    `Your request to link **${escapeText(account.robloxUsername)}** has been submitted.\n\n` +
    'Staff must confirm account ownership before approving it. Use /link-status to check your request.'
  );
}

async function linkStatus(interaction) {
  const linked = db.linkedUsers[interaction.user.id];
  const pending = db.pendingLinks[interaction.user.id];

  if (linked) {
    return replyPrivate(
      interaction,
      `**Status:** Approved\n` +
      `**Roblox Username:** ${escapeText(linked.robloxUsername)}\n` +
      `**Roblox ID:** ${linked.robloxId}`
    );
  }

  if (pending) {
    return replyPrivate(
      interaction,
      `**Status:** Awaiting staff approval\n` +
      `**Roblox Username:** ${escapeText(pending.robloxUsername)}\n` +
      `**Roblox ID:** ${pending.robloxId}`
    );
  }

  return replyPrivate(
    interaction,
    'You do not have a linked Roblox account. Use /link-roblox after verifying through Melonly.'
  );
}

async function approveRobloxLink(interaction) {
  if (!await staffOnly(interaction)) return;

  const user = interaction.options.getUser('user', true);
  const pending = db.pendingLinks[user.id];

  if (!pending) {
    return replyPrivate(
      interaction,
      'That member has no pending Roblox link request.'
    );
  }

  const member = await fetchFreshMember(
    interaction.guild,
    user.id
  ).catch(() => null);

  if (!member || !isMelonlyVerified(member)) {
    return replyPrivate(
      interaction,
      'The member must currently have the Melonly Verified role.'
    );
  }

  const duplicate = Object.entries(
    db.linkedUsers
  ).some(
    ([discordId, record]) =>
      discordId !== user.id &&
      String(record.robloxId) === pending.robloxId
  );

  if (duplicate) {
    return replyPrivate(
      interaction,
      'This Roblox account is already linked to another Discord member.'
    );
  }

  // Staff must independently confirm Roblox account
  // ownership before running this approval command.
  db.linkedUsers[user.id] = {
    robloxId: pending.robloxId,
    robloxUsername: pending.robloxUsername,
    linkedAt: Date.now(),
    approvedBy: interaction.user.id
  };

  delete db.pendingLinks[user.id];

  await save();

  await sendLog(
    'Roblox Link Approved',
    `**Discord User:** <@${user.id}>\n` +
    `**Roblox Username:** ${escapeText(pending.robloxUsername)}\n` +
    `**Roblox ID:** ${pending.robloxId}\n` +
    `**Approved By:** <@${interaction.user.id}>`
  );

  await user.send(
    `Your Roblox account **${pending.robloxUsername}** has been linked to Los Angeles Roleplay.`
  ).catch(() => {});

  return replyPrivate(
    interaction,
    `Approved ${escapeText(pending.robloxUsername)} for <@${user.id}>.`
  );
}

async function denyRobloxLink(interaction) {
  if (!await staffOnly(interaction)) return;

  const user = interaction.options.getUser('user', true);
  const pending = db.pendingLinks[user.id];

  if (!pending) {
    return replyPrivate(
      interaction,
      'That member has no pending Roblox link request.'
    );
  }

  delete db.pendingLinks[user.id];

  await save();

  await sendLog(
    'Roblox Link Denied',
    `**Discord User:** <@${user.id}>\n` +
    `**Roblox Username:** ${escapeText(pending.robloxUsername)}\n` +
    `**Denied By:** <@${interaction.user.id}>`
  );

  await user.send(
    'Your Roblox account link request was denied. Contact Los Angeles Roleplay staff for assistance.'
  ).catch(() => {});

  return replyPrivate(
    interaction,
    'Roblox link request denied.'
  );
}

async function unlinkRoblox(interaction) {
  if (!await staffOnly(interaction)) return;

  const user = interaction.options.getUser('user', true);
  const linked = db.linkedUsers[user.id];

  if (!linked) {
    return replyPrivate(
      interaction,
      'That member does not have an approved Roblox link.'
    );
  }

  delete db.linkedUsers[user.id];
  delete db.pendingLinks[user.id];

  await save();

  const member = await interaction.guild.members
    .fetch(user.id)
    .catch(() => null);

  if (member) {
    for (const roleId of [
      ENV.ROLEPLAYING_ROLE_ID,
      ENV.IN_QUEUE_ROLE_ID
    ]) {
      if (roleId && member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId)
          .catch(console.warn);
      }
    }
  }

  await sendLog(
    'Roblox Account Unlinked',
    `**Discord User:** <@${user.id}>\n` +
    `**Previous Roblox Account:** ${escapeText(linked.robloxUsername)}\n` +
    `**Unlinked By:** <@${interaction.user.id}>`
  );

  return replyPrivate(
    interaction,
    'Roblox account unlinked successfully.'
  );
}

// =============================================
// AUTOMATIC ER:LC ROLES
// =============================================

async function synchronizeRoles(data) {
  const guild = client.guilds.cache.get(
    ENV.GUILD_ID
  );

  if (!guild) return;

  const players = new Set(
    data.players
      .map(player => getPlayerInfo(player).robloxId)
      .filter(Boolean)
  );

  const queue = new Set(
    getQueueIds(data.queue)
  );

  await guild.members.fetch();

  const roleplayingRole = ENV.ROLEPLAYING_ROLE_ID;
  const queueRole = ENV.IN_QUEUE_ROLE_ID;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;

    const link = db.linkedUsers[member.id];
    const verified = isMelonlyVerified(member);

    const robloxId = (
      verified && link
        ? String(link.robloxId)
        : null
    );

    const shouldRoleplay = Boolean(
      robloxId && players.has(robloxId)
    );

    const shouldQueue = Boolean(
      robloxId && queue.has(robloxId)
    );

    const roles = [
      [roleplayingRole, shouldRoleplay, 'Roleplaying'],
      [queueRole, shouldQueue, 'In Queue']
    ];

    for (const [roleId, shouldHave, label] of roles) {
      if (!roleId) continue;

      const hasRole = member.roles.cache.has(roleId);

      if (hasRole === shouldHave) continue;

      try {
        if (shouldHave) {
          await member.roles.add(roleId);
        } else {
          await member.roles.remove(roleId);
        }

        await sendLog(
          'ER:LC Role Updated',
          `**Member:** <@${member.id}>\n` +
          `**Role:** ${label}\n` +
          `**Action:** ${shouldHave ? 'Added' : 'Removed'}\n` +
          `**Roblox Account:** ${escapeText(link?.robloxUsername || 'Not linked')}`
        );
      } catch (error) {
        console.warn(
          `Role synchronization for ${member.id}:`,
          errorMessage(error)
        );
      }
    }
  }
}

// =============================================
// SESSION INFORMATION
// =============================================

function sessionInfoPanel(data = null) {
  const active = db.session.active;

  const players = data
    ? data.players.length
    : 'Unavailable';

  const queue = data
    ? data.queue.length
    : 'Unavailable';

  const started = active && db.session.startedAt
    ? timestamp(db.session.startedAt)
    : 'No active session';

  const host = active && db.session.hostId
    ? `<@${db.session.hostId}>`
    : 'None';

  return createPanel(
    'Los Angeles Roleplay | Session Information',
    '### Session Status\n' +
    `**Current Status:** ${active ? 'Active' : 'Offline'}\n\n` +
    '### Server Information\n' +
    '**Server Name:** Los Angeles Roleplay\n' +
    `**Players In-Game:** ${players}\n` +
    `**Players In Queue:** ${queue}\n\n` +
    '### Session Details\n' +
    `**Session Host:** ${host}\n` +
    `**Session Started:** ${started}\n` +
    `**Last Updated:** ${timestamp(Date.now())}\n\n` +
    (
      active
        ? 'Our session is currently active. Join us in-game!'
        : 'There is currently no active session.'
    ),
    'SESSION_INFO_BANNER'
  );
}

async function updateSessionInfo(data = null) {
  if (!ENV.SESSION_INFO_CHANNEL_ID) return;

  const channel = await client.channels
    .fetch(ENV.SESSION_INFO_CHANNEL_ID)
    .catch(() => null);

  if (!channel?.isTextBased()) return;

  let info = data;

  if (!info && ENV.ERLC_API_KEY) {
    try {
      info = await getServerData();
    } catch (error) {
      console.warn(
        'Session information API:',
        errorMessage(error)
      );
    }
  }

  let message = null;

  if (db.session.infoMessageId) {
    message = await channel.messages
      .fetch(db.session.infoMessageId)
      .catch(() => null);
  }

  if (message) {
    await message.edit(
      sessionInfoPanel(info)
    );
  } else {
    message = await channel.send(
      sessionInfoPanel(info)
    );

    db.session.infoMessageId = message.id;
    await save();
  }

  if (!message.pinned) {
    await message.pin().catch(console.warn);
  }
}

function sessionAnnouncement(data) {
  return createPanel(
    'Los Angeles Roleplay | Session Started',
    '**The in-game server has officially started!**\n\n' +
    '### Server Information\n' +
    '**Server:** Los Angeles Roleplay\n' +
    `**Session Host:** <@${db.session.hostId}>\n` +
    `**Players In-Game:** ${data ? data.players.length : 'Unavailable'}\n` +
    `**Players In Queue:** ${data ? data.queue.length : 'Unavailable'}\n\n` +
    'Join us for an immersive roleplay experience.',
    'SESSION_START_BANNER'
  );
}

async function updateSessionAnnouncement(data) {
  if (
    !db.session.active ||
    !db.session.messageId ||
    !db.session.channelId
  ) {
    return;
  }

  try {
    const channel = await client.channels.fetch(
      db.session.channelId
    );

    if (!channel?.isTextBased()) return;

    const message = await channel.messages.fetch(
      db.session.messageId
    );

    await message.edit(
      sessionAnnouncement(data)
    );
  } catch (error) {
    console.warn(
      'Session announcement update:',
      errorMessage(error)
    );
  }
}

async function startSession(interaction) {
  if (!await staffOnly(interaction)) return;

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  if (db.session.active) {
    return interaction.editReply(
      'A session is already active.'
    );
  }

  let data = null;

  try {
    data = await getServerData();
  } catch (error) {
    console.warn(
      'Session start API:',
      errorMessage(error)
    );
  }

  db.session.active = true;
  db.session.startedAt = Date.now();
  db.session.hostId = interaction.user.id;
  db.session.channelId = interaction.channelId;
  db.session.messageId = null;
  db.vote = null;

  const message = await interaction.channel.send(
    sessionAnnouncement(data)
  );

  db.session.messageId = message.id;
  await save();

  await sendLog(
    'Session Started',
    `**Host:** <@${interaction.user.id}>\n` +
    `**Players:** ${data ? data.players.length : 'Unavailable'}\n` +
    `**Queue:** ${data ? data.queue.length : 'Unavailable'}`
  );

  await updateSessionInfo(data).catch(console.warn);

  return interaction.editReply(
    'Session started successfully.'
  );
}

async function shutdownSession(interaction) {
  if (!await staffOnly(interaction)) return;

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral
  });

  db.session.active = false;
  db.session.startedAt = null;
  db.session.hostId = null;
  db.session.messageId = null;
  db.session.channelId = null;
  db.vote = null;

  await save();

  await interaction.channel.send(
    createPanel(
      'Los Angeles Roleplay | Session Shutdown',
      '**The session has officially ended.**\n\n' +
      'Thank you for participating in Los Angeles Roleplay.\n\n' +
      'Watch our announcements for the next session.',
      'SESSION_SHUTDOWN_BANNER'
    )
  );

  await sendLog(
    'Session Shutdown',
    `**Ended By:** <@${interaction.user.id}>`
  );

  await updateSessionInfo().catch(console.warn);

  return interaction.editReply(
    'Session shut down successfully.'
  );
}

// =============================================
// SESSION VOTING
// =============================================

function sessionVotePanel() {
  const count = db.vote?.voters?.length || 0;
  const reached = count >= 4;

  return createPanel(
    'Los Angeles Roleplay | Session Vote',
    '**Would you like a session to start?**\n\n' +
    `**Current Votes:** ${count}/4\n` +
    '**Required Votes:** 4\n\n' +
    (
      reached
        ? 'The required votes have been reached.'
        : 'Press the button below to vote. Each member can vote once.'
    ),
    'SESSION_VOTE_BANNER',
    [
      createRow(
        createButton(
          `session_vote_${db.vote.id}`,
          `Vote (${count}/4)`,
          ButtonStyle.Primary,
          reached
        )
      )
    ]
  );
}

async function createSessionVote(interaction) {
  if (!await staffOnly(interaction)) return;

  if (db.session.active) {
    return replyPrivate(
      interaction,
      'A session is already active.'
    );
  }

  if (db.vote && db.vote.voters.length < 4) {
    return replyPrivate(
      interaction,
      'A session vote is already open.'
    );
  }

  db.vote = {
    id: crypto.randomBytes(4).toString('hex'),
    voters: [],
    createdAt: Date.now()
  };

  await save();

  await interaction.channel.send(
    sessionVotePanel()
  );

  return replyPrivate(
    interaction,
    'Session vote posted.'
  );
}

const voteLocks = new Set();

async function castSessionVote(interaction) {
  const voteId = interaction.customId.replace(
    'session_vote_',
    ''
  );

  if (!db.vote || db.vote.id !== voteId) {
    return replyPrivate(
      interaction,
      'This vote is no longer active.'
    );
  }

  if (voteLocks.has(voteId)) {
    return replyPrivate(
      interaction,
      'Another vote is being processed. Try again.'
    );
  }

  voteLocks.add(voteId);

  try {
    if (db.vote.voters.includes(interaction.user.id)) {
      return replyPrivate(
        interaction,
        'You have already voted.'
      );
    }

    if (db.vote.voters.length >= 4) {
      return replyPrivate(
        interaction,
        'The required votes have been reached.'
      );
    }

    db.vote.voters.push(interaction.user.id);
    await save();

    await interaction.update(
      sessionVotePanel()
    );

    if (db.vote.voters.length === 4) {
      await interaction.channel.send({
        content:
          'The session vote has reached 4/4 votes. ' +
          'A session host may now start the session.',
        allowedMentions: { parse: [] }
      });

      await sendLog(
        'Session Vote Completed',
        `**Votes:** 4/4\n` +
        `**Channel:** <#${interaction.channelId}>`
      );
    }
  } finally {
    voteLocks.delete(voteId);
  }
}

// =============================================
// TICKET SYSTEM
// =============================================

const ticketTypes = {
  directorship: {
    label: 'Directorship Tickets',
    category: 'DIRECTORSHIP_CATEGORY_ID',
    pingRole: 'DIRECTORSHIP_PING_ROLE_ID',
    prefix: 'directorship'
  },
  report: {
    label: 'Report Tickets',
    category: 'REPORT_CATEGORY_ID',
    pingRole: 'REPORT_PING_ROLE_ID',
    prefix: 'report'
  },
  support: {
    label: 'General Support Tickets',
    category: 'SUPPORT_CATEGORY_ID',
    pingRole: 'SUPPORT_PING_ROLE_ID',
    prefix: 'support'
  }
};

function canManageTicket(member, ticket) {
  if (hasStaff(member)) return true;

  const config = ticketTypes[ticket.type];

  return Boolean(
    config &&
    memberHasRole(
      member,
      ENV[config.pingRole]
    )
  );
}

function ticketPanel() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_type')
    .setPlaceholder('Select a ticket department');

  for (const [key, type] of Object.entries(ticketTypes)) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(type.label)
        .setValue(key)
        .setDescription(
          `Create a ${type.label.toLowerCase()} ticket`
        )
    );
  }

  return createPanel(
    'Los Angeles Roleplay | Support Center',
    '**Welcome to the Los Angeles Roleplay Support System.**\n\n' +
    'Select the department that best matches your inquiry.\n\n' +
    '**Directorship Tickets**\n' +
    'Leadership inquiries and management concerns.\n\n' +
    '**Report Tickets**\n' +
    'Player reports, staff reports, and rule violations.\n\n' +
    '**General Support Tickets**\n' +
    'Questions, technical support, and general assistance.',
    'TICKET_PANEL_BANNER',
    [createRow(menu)]
  );
}

async function showTicketModal(interaction) {
  const type = interaction.values[0];

  if (!ticketTypes[type]) {
    return replyPrivate(
      interaction,
      'Invalid ticket department.'
    );
  }

  const modal = new ModalBuilder()
    .setCustomId(`ticket_modal_${type}`)
    .setTitle('Los Angeles Roleplay Support');

  const subject = new TextInputBuilder()
    .setCustomId('ticket_subject')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Briefly describe your inquiry')
    .setMinLength(3)
    .setMaxLength(100)
    .setRequired(true);

  const description = new TextInputBuilder()
    .setCustomId('ticket_description')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Explain your request in detail')
    .setMinLength(10)
    .setMaxLength(1500)
    .setRequired(true);

  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('Inquiry Subject')
      .setTextInputComponent(subject),
    new LabelBuilder()
      .setLabel('Describe Your Inquiry')
      .setTextInputComponent(description)
  );

  return interaction.showModal(modal);
}

const creatingTickets = new Set();

async function submitTicketModal(interaction) {
  const type = interaction.customId.replace(
    'ticket_modal_',
    ''
  );

  const config = ticketTypes[type];

  if (!config) {
    return replyPrivate(
      interaction,
      'Invalid ticket type.'
    );
  }

  const subject = interaction.fields.getTextInputValue(
    'ticket_subject'
  );

  const description = interaction.fields.getTextInputValue(
    'ticket_description'
  );

  const lockKey = `${interaction.user.id}:${type}`;

  if (creatingTickets.has(lockKey)) {
    return replyPrivate(
      interaction,
      'Your ticket is already being created.'
    );
  }

  creatingTickets.add(lockKey);

  try {
    await interaction.deferReply({
      flags: MessageFlags.Ephemeral
    });

    const existing = Object.entries(db.tickets)
      .find(([, ticket]) =>
        ticket.owner === interaction.user.id &&
        ticket.type === type
      );

    if (existing) {
      const existingChannel = await interaction.guild.channels
        .fetch(existing[0])
        .catch(() => null);

      if (existingChannel) {
        return interaction.editReply(
          `You already have a ticket: <#${existing[0]}>`
        );
      }

      delete db.tickets[existing[0]];
      await save();
    }

    const categoryId = ENV[config.category];

    if (!categoryId) {
      return interaction.editReply(
        'This ticket category is not configured.'
      );
    }

    const departmentRoleId = ENV[config.pingRole];

    const uniqueRoles = [
      ...new Set([
        ENV.STAFF_ROLE_ID,
        departmentRoleId
      ].filter(Boolean))
    ];

    const overwrites = [
      {
        id: interaction.guild.id,
        deny: [
          PermissionFlagsBits.ViewChannel
        ]
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels
        ]
      },
      ...uniqueRoles.map(roleId => ({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }))
    ];

    const channel = await interaction.guild.channels.create({
      name: `${config.prefix}-${interaction.user.id}`,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: overwrites
    });

    db.tickets[channel.id] = {
      owner: interaction.user.id,
      type,
      subject,
      description,
      claimedBy: null,
      answered: [],
      createdAt: Date.now()
    };

    await save();

    const staffPing = departmentRoleId
      ? ` <@&${departmentRoleId}>`
      : '';

    await channel.send({
      content:
        `<@${interaction.user.id}>${staffPing}\n\n` +
        'Welcome to the Los Angeles Roleplay support system. ' +
        'This is an automated response. I will assist you ' +
        'until a staff member claims this ticket.',
      allowedMentions: {
        users: [interaction.user.id],
        roles: departmentRoleId
          ? [departmentRoleId]
          : []
      }
    });

    await channel.send(
      ticketInformationPanel(
        db.tickets[channel.id]
      )
    );

    await sendLog(
      'Ticket Created',
      `**User:** <@${interaction.user.id}>\n` +
      `**Department:** ${config.label}\n` +
      `**Channel:** <#${channel.id}>\n` +
      `**Subject:** ${escapeText(subject)}`
    );

    return interaction.editReply(
      `Your ticket has been created: <#${channel.id}>`
    );
  } finally {
    creatingTickets.delete(lockKey);
  }
}

function ticketInformationPanel(ticket) {
  const config = ticketTypes[ticket.type];
  const claimed = Boolean(ticket.claimedBy);

  return createPanel(
    'Los Angeles Roleplay | Ticket Information',
    `**Department:** ${config?.label || ticket.type}\n` +
    `**Opened By:** <@${ticket.owner}>\n` +
    `**Subject:** ${escapeText(ticket.subject)}\n\n` +
    '### Inquiry Description\n' +
    escapeText(ticket.description) +
    '\n\n' +
    `**Status:** ${claimed ? 'Claimed' : 'Awaiting Staff'}\n` +
    `**Assigned Staff:** ${
      claimed ? `<@${ticket.claimedBy}>` : 'None'
    }\n\n` +
    (
      claimed
        ? 'A staff member is now handling this ticket.'
        : 'Automated support may answer common questions while you wait.'
    ),
    'TICKET_WELCOME_BANNER',
    [
      createRow(
        createButton(
          'ticket_claim',
          claimed ? 'Ticket Claimed' : 'Claim Ticket',
          ButtonStyle.Success,
          claimed
        ),
        createButton(
          'ticket_close',
          'Close Ticket',
          ButtonStyle.Danger
        )
      )
    ]
  );
}

async function claimTicket(interaction) {
  const ticket = db.tickets[interaction.channelId];

  if (!ticket) {
    return replyPrivate(
      interaction,
      'This channel is not a ticket.'
    );
  }

  if (!canManageTicket(interaction.member, ticket)) {
    return replyPrivate(
      interaction,
      'You do not have permission to claim this ticket.'
    );
  }

  if (ticket.claimedBy) {
    return replyPrivate(
      interaction,
      `This ticket is already claimed by <@${ticket.claimedBy}>.`
    );
  }

  ticket.claimedBy = interaction.user.id;
  await save();

  if (interaction.isButton()) {
    await interaction.update(
      ticketInformationPanel(ticket)
    );
  } else {
    await replyPrivate(
      interaction,
      'Ticket claimed successfully.'
    );
  }

  await interaction.channel.send({
    content:
      `This ticket has been claimed by <@${interaction.user.id}>.\n\n` +
      'Automated responses have now been disabled.',
    allowedMentions: {
      users: [interaction.user.id]
    }
  });

  await sendLog(
    'Ticket Claimed',
    `**Staff:** <@${interaction.user.id}>\n` +
    `**Ticket:** <#${interaction.channelId}>\n` +
    `**Owner:** <@${ticket.owner}>`
  );
}

async function closeTicket(interaction) {
  const ticket = db.tickets[interaction.channelId];

  if (!ticket) {
    return replyPrivate(
      interaction,
      'This channel is not a ticket.'
    );
  }

  if (
    interaction.user.id !== ticket.owner &&
    !canManageTicket(interaction.member, ticket)
  ) {
    return replyPrivate(
      interaction,
      'Only the ticket owner or staff can close this ticket.'
    );
  }

  await interaction.reply({
    content: 'This ticket will close in 5 seconds.',
    allowedMentions: { parse: [] }
  });

  await sendLog(
    'Ticket Closed',
    `**Closed By:** <@${interaction.user.id}>\n` +
    `**Owner:** <@${ticket.owner}>\n` +
    `**Department:** ${ticketTypes[ticket.type]?.label || ticket.type}\n` +
    `**Subject:** ${escapeText(ticket.subject)}`
  );

  delete db.tickets[interaction.channelId];
  await save();

  setTimeout(async () => {
    await interaction.channel.delete(
      'Support ticket closed'
    ).catch(console.warn);
  }, 5000);
}

// =============================================
// AUTOMATED TICKET RESPONSES
// =============================================

function loadResponses() {
  try {
    const file = JSON.parse(
      fs.readFileSync(
        RESPONSES_PATH,
        'utf8'
      )
    );

    return Array.isArray(file.responses)
      ? file.responses
      : [];
  } catch {
    return [];
  }
}

async function automatedTicketReply(message, ticket) {
  if (message.author.bot || ticket.claimedBy) return;

  const content = message.content.toLowerCase();
  const responses = loadResponses();

  if (!Array.isArray(ticket.answered)) {
    ticket.answered = [];
  }

  for (const [index, response] of responses.entries()) {
    if (!Array.isArray(response.keywords)) continue;

    const key = JSON.stringify(response.keywords);

    if (
      ticket.answered.includes(key) ||
      ticket.answered.includes(index)
    ) {
      continue;
    }

    const matches = response.keywords.some(
      keyword =>
        typeof keyword === 'string' &&
        keyword.length > 2 &&
        content.includes(keyword.toLowerCase())
    );

    if (!matches) continue;

    const reply = String(
      response.reply || ''
    ).trim();

    if (!reply) continue;

    ticket.answered.push(key);
    await save();

    await message.channel.send({
      content: reply.slice(0, 2000),
      allowedMentions: { parse: [] }
    });

    break;
  }
}

// =============================================
// STAFF-ONLY USER INFORMATION
// COMMAND: !?user info
// =============================================

async function handleUserInfoCommand(message) {
  const match = message.content.trim().match(
    /^!\?user\s+info(?:\s+(.+))?$/i
  );

  if (!match) return false;

  if (!ENV.STAFF_ROLE_ID) {
    await message.reply({
      content: 'STAFF_ROLE_ID is not configured in .env.',
      allowedMentions: {
        repliedUser: false,
        parse: []
      }
    });

    return true;
  }

  const staffMember = await fetchFreshMember(
    message.guild,
    message.author.id
  );

  // Only the exact configured staff role is accepted.
  // Administrator permission alone is not enough.
  if (!memberHasRole(staffMember, ENV.STAFF_ROLE_ID)) {
    await message.reply({
      content:
        'You do not have permission to use this command. ' +
        'Only members with the configured staff role can use it.',
      allowedMentions: {
        repliedUser: false,
        parse: []
      }
    });

    return true;
  }

  const argument = match[1]?.trim();

  let targetId = message.author.id;

  if (argument) {
    const mention = argument.match(
      /^<@!?(\d{17,20})>$/
    );

    const numericId = argument.match(
      /^(\d{17,20})$/
    );

    targetId = mention?.[1] || numericId?.[1];

    if (!targetId) {
      await message.reply({
        content:
          'Invalid user. Use `!?user info @user`, ' +
          '`!?user info USER_ID`, or `!?user info`.',
        allowedMentions: {
          repliedUser: false,
          parse: []
        }
      });

      return true;
    }
  }

  const targetMember = await fetchFreshMember(
    message.guild,
    targetId
  ).catch(() => null);

  if (!targetMember) {
    await message.reply({
      content: 'That member could not be found in this server.',
      allowedMentions: {
        repliedUser: false,
        parse: []
      }
    });

    return true;
  }

  const user = targetMember.user;

  const linked = db.linkedUsers[user.id];
  const pending = db.pendingLinks[user.id];

  const verified = isMelonlyVerified(targetMember);

  const roleplaying = memberHasRole(
    targetMember,
    ENV.ROLEPLAYING_ROLE_ID
  );

  const inQueue = memberHasRole(
    targetMember,
    ENV.IN_QUEUE_ROLE_ID
  );

  let erlcStatus = 'Offline';

  if (roleplaying && inQueue) {
    erlcStatus = 'Roleplaying and In Queue';
  } else if (roleplaying) {
    erlcStatus = 'Roleplaying';
  } else if (inQueue) {
    erlcStatus = 'In Queue';
  }

  const linkStatusText = linked
    ? 'Approved'
    : pending
      ? 'Pending Staff Approval'
      : 'Not Linked';

  const robloxAccount = linked || pending;

  const robloxUsername = robloxAccount
    ? escapeText(robloxAccount.robloxUsername)
    : 'Not Linked';

  const robloxId = robloxAccount
    ? String(robloxAccount.robloxId)
    : 'Not Linked';

  const linkedAt = linked?.linkedAt
    ? timestamp(linked.linkedAt)
    : 'Not Available';

  const approvedBy = linked?.approvedBy
    ? `<@${linked.approvedBy}>`
    : 'Not Available';

  const joinedAt = targetMember.joinedTimestamp
    ? timestamp(targetMember.joinedTimestamp)
    : 'Unknown';

  const createdAt = user.createdTimestamp
    ? timestamp(user.createdTimestamp)
    : 'Unknown';

  const information =
    '### Discord Information\n' +
    `**User:** <@${user.id}>\n` +
    `**Username:** ${escapeText(user.username)}\n` +
    `**Display Name:** ${escapeText(targetMember.displayName)}\n` +
    `**Discord ID:** ${user.id}\n` +
    `**Account Created:** ${createdAt}\n` +
    `**Joined Server:** ${joinedAt}\n\n` +

    '### Roblox Information\n' +
    `**Roblox Username:** ${robloxUsername}\n` +
    `**Roblox User ID:** ${robloxId}\n` +
    `**Link Status:** ${linkStatusText}\n` +
    `**Linked At:** ${linkedAt}\n` +
    `**Approved By:** ${approvedBy}\n\n` +

    '### Verification Information\n' +
    `**Melonly Verified:** ${verified ? 'Yes' : 'No'}\n\n` +

    '### ER:LC Information\n' +
    `**Current Status:** ${erlcStatus}\n` +
    `**Roleplaying Role:** ${roleplaying ? 'Yes' : 'No'}\n` +
    `**In Queue Role:** ${inQueue ? 'Yes' : 'No'}\n\n` +

    '### Management Information\n' +
    `**Information Requested By:** <@${message.author.id}>\n` +
    `**Checked:** ${timestamp(Date.now())}`;

  await message.channel.send(
    createPanel(
      'Los Angeles Roleplay | User Information',
      information,
      'USER_INFO_BANNER'
    )
  );

  await sendLog(
    'User Information Viewed',
    `**Staff Member:** <@${message.author.id}>\n` +
    `**Target Member:** <@${user.id}>\n` +
    `**Channel:** <#${message.channelId}>`
  );

  return true;
}

// =============================================
// SLASH COMMANDS
// =============================================

const commands = [
  new SlashCommandBuilder()
    .setName('link-roblox')
    .setDescription('Request to link your verified Roblox account')
    .addStringOption(option =>
      option
        .setName('username')
        .setDescription('Your Roblox username')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('link-status')
    .setDescription('Check your Roblox account link status'),

  new SlashCommandBuilder()
    .setName('link-approve')
    .setDescription('Approve a Roblox account link')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Member to approve')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('link-deny')
    .setDescription('Deny a Roblox account link')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Member to deny')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('link-remove')
    .setDescription('Remove an approved Roblox account link')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('Member to unlink')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Post the ticket selection panel')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    ),

  new SlashCommandBuilder()
    .setName('ticket-claim')
    .setDescription('Claim the current ticket'),

  new SlashCommandBuilder()
    .setName('ticket-close')
    .setDescription('Close the current ticket'),

  new SlashCommandBuilder()
    .setName('session-start')
    .setDescription('Start an ER:LC session'),

  new SlashCommandBuilder()
    .setName('session-shutdown')
    .setDescription('Shut down the current session'),

  new SlashCommandBuilder()
    .setName('session-vote')
    .setDescription('Start a four-vote session poll'),

  new SlashCommandBuilder()
    .setName('session-status')
    .setDescription('Check the current session status'),

  new SlashCommandBuilder()
    .setName('session-info-setup')
    .setDescription('Create or refresh the permanent session information panel')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
];

// =============================================
// SLASH COMMAND HANDLER
// =============================================

async function handleSlash(interaction) {
  switch (interaction.commandName) {
    case 'link-roblox':
      return requestRobloxLink(interaction);

    case 'link-status':
      return linkStatus(interaction);

    case 'link-approve':
      return approveRobloxLink(interaction);

    case 'link-deny':
      return denyRobloxLink(interaction);

    case 'link-remove':
      return unlinkRoblox(interaction);

    case 'ticket-panel': {
      if (!await adminOnly(interaction)) return;

      await interaction.channel.send(
        ticketPanel()
      );

      return replyPrivate(
        interaction,
        'Ticket panel posted.'
      );
    }

    case 'ticket-claim':
      return claimTicket(interaction);

    case 'ticket-close':
      return closeTicket(interaction);

    case 'session-start':
      return startSession(interaction);

    case 'session-shutdown':
      return shutdownSession(interaction);

    case 'session-vote':
      return createSessionVote(interaction);

    case 'session-status': {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      let data = null;

      try {
        data = await getServerData();
      } catch (error) {
        console.warn(
          'Session status API:',
          errorMessage(error)
        );
      }

      return interaction.editReply(
        `**Session:** ${db.session.active ? 'Active' : 'Offline'}\n` +
        `**Players:** ${data ? data.players.length : 'Unavailable'}\n` +
        `**Queue:** ${data ? data.queue.length : 'Unavailable'}`
      );
    }

    case 'session-info-setup': {
      if (!await adminOnly(interaction)) return;

      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      if (!ENV.SESSION_INFO_CHANNEL_ID) {
        return interaction.editReply(
          'SESSION_INFO_CHANNEL_ID is not configured.'
        );
      }

      await updateSessionInfo();

      return interaction.editReply(
        'Permanent session information panel is ready.'
      );
    }
  }
}

// =============================================
// INTERACTION HANDLER
// =============================================

client.on(
  Events.InteractionCreate,
  async interaction => {
    if (interaction.guildId !== ENV.GUILD_ID) {
      return;
    }

    try {
      if (interaction.isChatInputCommand()) {
        return await handleSlash(interaction);
      }

      if (interaction.isButton()) {
        if (
          interaction.customId.startsWith(
            'session_vote_'
          )
        ) {
          return await castSessionVote(interaction);
        }

        if (interaction.customId === 'ticket_claim') {
          return await claimTicket(interaction);
        }

        if (interaction.customId === 'ticket_close') {
          return await closeTicket(interaction);
        }
      }

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === 'ticket_type'
      ) {
        return await showTicketModal(interaction);
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'ticket_modal_'
        )
      ) {
        return await submitTicketModal(interaction);
      }
    } catch (error) {
      console.error(
        'Interaction error:',
        error
      );

      try {
        await replyPrivate(
          interaction,
          'An error occurred while processing your request. Please try again.'
        );
      } catch (replyError) {
        console.warn(
          'Could not send error response:',
          errorMessage(replyError)
        );
      }
    }
  }
);

// =============================================
// MESSAGE HANDLER
// =============================================

client.on(
  Events.MessageCreate,
  async message => {
    if (
      message.guildId !== ENV.GUILD_ID ||
      message.author.bot
    ) {
      return;
    }

    try {
      // Check the staff-only user information command.
      const handled = await handleUserInfoCommand(
        message
      );

      if (handled) {
        return;
      }

      // Continue handling automated ticket responses.
      const ticket = db.tickets[
        message.channelId
      ];

      if (ticket) {
        await automatedTicketReply(
          message,
          ticket
        );
      }
    } catch (error) {
      console.error(
        'Message handler:',
        error
      );
    }
  }
);

// =============================================
// AUTOMATIC UPDATES
// =============================================

let polling = false;

async function poll() {
  if (polling) return;

  polling = true;

  try {
    let data = null;

    if (ENV.ERLC_API_KEY) {
      try {
        data = await getServerData();
      } catch (error) {
        console.warn(
          'ER:LC status polling:',
          errorMessage(error)
        );
      }
    }

    if (data) {
      try {
        await synchronizeRoles(data);
      } catch (error) {
        console.warn(
          'Role synchronization:',
          errorMessage(error)
        );
      }

      try {
        await updateSessionAnnouncement(data);
      } catch (error) {
        console.warn(
          'Session announcement:',
          errorMessage(error)
        );
      }
    }

    try {
      await updateSessionInfo(data);
    } catch (error) {
      console.warn(
        'Session information:',
        errorMessage(error)
      );
    }
  } finally {
    polling = false;
  }
}

// =============================================
// BOT STARTUP
// =============================================

client.once(
  Events.ClientReady,
  async ready => {
    console.log(
      `Online as ${ready.user.tag}`
    );

    try {
      const rest = new REST({
        version: '10'
      }).setToken(ENV.DISCORD_TOKEN);

      await rest.put(
        Routes.applicationGuildCommands(
          ENV.CLIENT_ID,
          ENV.GUILD_ID
        ),
        {
          body: commands.map(
            command => command.toJSON()
          )
        }
      );

      console.log(
        'Slash commands registered successfully.'
      );
    } catch (error) {
      console.error(
        'Command registration:',
        error
      );
    }

    try {
      await poll();
    } catch (error) {
      console.error(
        'Initial polling:',
        error
      );
    }

    setInterval(() => {
      poll().catch(console.error);
    }, POLL_INTERVAL);

    console.log(
      'Los Angeles Roleplay Management is ready.'
    );
  }
);

process.on(
  'unhandledRejection',
  error => {
    console.error(
      'Unhandled rejection:',
      error
    );
  }
);

client.login(ENV.DISCORD_TOKEN);