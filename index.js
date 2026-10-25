// Sends the message from contacts.json to every contact in the list,
// once right after startup, then once every 30 minutes.
//
// Run:  double-click "Start Bot.bat"   (or: npm start)
// First run shows a QR code — scan it with WhatsApp > Settings > Linked
// devices > Link a device. The session is saved in .wwebjs_auth, so later
// runs connect without the QR.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const SEND_INTERVAL_MS = 30 * 60 * 1000; // send every 30 minutes
const SEND_IMMEDIATELY = true;           // false = only send on each half-hour mark
const PAUSE_BETWEEN_SENDS_MS = 3000;     // gentle pacing between contacts

// contacts.json ships with this placeholder so nothing sends until you
// replace it with a real number (country code + number, digits only).
const PLACEHOLDER_NUMBER = '15551234567';
const CONFIG_PATH = path.join(__dirname, 'contacts.json');

function loadConfig() {
  // Cloud mode reads config from environment variables; local mode from contacts.json
  const config = process.env.CONTACTS_JSON
    ? { message: process.env.MESSAGE || 'test', contacts: JSON.parse(process.env.CONTACTS_JSON) }
    : JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!config.message || !config.message.trim()) {
    throw new Error('Set "message" in contacts.json');
  }
  if (!Array.isArray(config.contacts) || config.contacts.length === 0) {
    throw new Error('Add at least one contact to contacts.json');
  }
  return config;
}

function chatIdFor(number) {
  const digits = String(number).replace(/\D/g, '');
  if (!digits) throw new Error(`Invalid number: ${number}`);
  if (digits === PLACEHOLDER_NUMBER) {
    throw new Error('contacts.json still contains the placeholder number 15551234567 — edit it first');
  }
  return `${digits}@c.us`;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '.wwebjs_auth') }),
  puppeteer: { headless: true, args: ['--no-sandbox'] },
});

client.on('qr', async (qr) => {
  console.log('\nScan this QR code with WhatsApp > Settings > Linked devices > Link a device:\n');
  qrcode.generate(qr, { small: true });
  try {
    await QRCode.toFile(path.join(__dirname, 'qr.png'), qr, { width: 512, margin: 2 });
    console.log('Saved a scannable copy as qr.png in this folder — open it and scan with your phone.');
  } catch (err) {
    console.error('Could not save qr.png:', err.message);
  }
});

client.on('ready', () => {
  console.log(`Connected as ${client.info.pushname}.`);
  const round = () => {
    const cfg = loadConfig();
    return sendAll(cfg.contacts, cfg.message).catch((err) => console.error('Send round failed:', err.message));
  };
  if (process.env.ONCE === '1') {
    (async () => {
      // GitHub's cron can skip slots, so the workflow fires every 5 minutes and
      // this gate enforces the real cadences: contacts without a "schedule" go
      // out once per ~30 minutes; contacts with a "schedule" of "H:MM" (UTC)
      // go out once per day, any run after their time if the exact slot was
      // skipped. Timestamps live in repo variables (updated via API) because
      // the actions cache never overwrites an existing entry.
      const config = loadConfig();
      const regular = config.contacts.filter((c) => !c.schedule);
      const daily = config.contacts.filter((c) => c.schedule);
      const lastSendPath = path.join(__dirname, '.wwebjs_auth', 'last-send.txt');
      const minGapMs = 25 * 60 * 1000;

      let lastSend = parseInt(process.env.LAST_SEND || '0', 10) || 0;
      if (!lastSend) {
        try {
          lastSend = parseInt(fs.readFileSync(lastSendPath, 'utf8'), 10) || 0;
        } catch (e) { /* no marker yet */ }
      }
      const regularDue = regular.length > 0 && (!lastSend || Date.now() - lastSend >= minGapMs);

      const nowDate = new Date();
      const todayKey = nowDate.toISOString().slice(0, 10);
      const minutesNow = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
      const dailyDue = daily.some((c) => {
        const parts = String(c.schedule).split(':');
        const dueMinutes = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
        return minutesNow >= dueMinutes && process.env.LAST_DAILY !== todayKey;
      });

      if (!regularDue && !dailyDue) {
        const list = config.contacts
          .map((c) => (c.schedule ? `${c.name}@${c.schedule}` : `${c.name}@regular`))
          .join(', ');
        console.log(
          `Skipping: nothing due (contacts: [${list}] now=${minutesNow}min UTC, lastDaily=${process.env.LAST_DAILY || '-'})`
        );
        client.destroy().finally(() => process.exit(0));
        return;
      }

      if (regularDue) {
        await sendAll(regular, config.message);
        const now = Date.now();
        try {
          fs.writeFileSync(lastSendPath, String(now));
        } catch (e) { /* marker is best-effort */ }
        await updateVariable('LAST_SEND', String(now));
      }
      if (dailyDue) {
        await sendAll(daily, config.message);
        await updateVariable('LAST_DAILY', todayKey);
      }
      cleanupBrowserCaches();
      console.log('ONCE mode: round complete, exiting.');
      client.destroy().finally(() => process.exit(0));
    })().catch((err) => {
      console.error('ONCE mode failed:', (err && err.stack) || err);
      client.destroy().finally(() => process.exit(1));
    });
    return;
  }
  if (SEND_IMMEDIATELY) {
    round();
    setInterval(round, SEND_INTERVAL_MS);
    console.log('Sending now, then every 30 minutes. Press Ctrl+C to stop.');
  } else {
    scheduleNextRound(round);
  }
});

client.on('auth_failure', (msg) => console.error('Authentication failed:', msg));

client.on('disconnected', (reason) => {
  console.error('Disconnected from WhatsApp:', reason);
  process.exit(1);
});

async function sendAll(contacts, message) {
  console.log(`\n--- Send round started at ${new Date().toLocaleTimeString()} ---`);
  let pending = contacts;
  for (let pass = 1; pass <= 2; pass++) {
    const failed = [];
    for (const contact of pending) {
      try {
        if (contact.group) {
          const groupId = await resolveGroupChatId(contact.group);
          let sent = false;
          const attempts = [];
          try {
            const chat = await client.getChatById(groupId);
            await chat.sendMessage(message);
            sent = true;
          } catch (e1) {
            attempts.push(`chat.sendMessage: ${(e1 && e1.message) || e1}`);
            try {
              await client.sendMessage(groupId, message);
              sent = true;
            } catch (e2) {
              attempts.push(`client.sendMessage: ${(e2 && e2.message) || e2}`);
            }
          }
          if (!sent) throw new Error(attempts.join(' | '));
          console.log(`[sent]   ${contact.name} (${groupId})`);
        } else {
          const chatId = chatIdFor(contact.number);
          await client.sendMessage(chatId, message);
          console.log(`[sent]   ${contact.name} (${chatId})`);
        }
      } catch (err) {
        failed.push(contact);
        console.error(`[failed] ${contact.name}: ${(err && err.stack) || (err && err.message) || String(err)}`.split('\n').slice(0, 4).join(' | '));
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_SENDS_MS));
    }
    if (!failed.length || pass === 2) return;
    console.log(`Retrying ${failed.length} contact(s) after 30s...`);
    await new Promise((resolve) => setTimeout(resolve, 30000));
    pending = failed;
  }
}

// Groups are addressed by name; resolve to the chat ID by reading WhatsApp's
// chat store directly. The store fills in over the first seconds after
// connect, and client.getChats() throws on any unreadable chat, so poll the
// store defensively until the target group appears.
async function resolveGroupChatId(groupName) {
  const norm = (s) => (s || '').toLowerCase().trim();
  let groups = [];
  for (let attempt = 1; attempt <= 25; attempt++) {
    try {
      const result = await client.pupPage.evaluate((wantName) => {
        const norm = (s) => (s || '').toLowerCase().trim();
        const out = [];
        try {
          const chats = window.require('WAWebCollections').Chat.getModelsArray();
          for (const c of chats) {
            try {
              const serialized = c && c.id && c.id._serialized;
              if (serialized && String(serialized).endsWith('@g.us')) {
                out.push({ id: serialized, name: c.name || c.formattedTitle || '' });
              }
            } catch (e) { /* skip unreadable chat */ }
          }
          const exact = out.filter((g) => norm(g.name) === norm(wantName));
          let match = exact[0] || null;
          if (!match) {
            const loose = out.filter((g) => {
              const a = norm(g.name);
              const b = norm(wantName);
              return b && (a.startsWith(b) || b.startsWith(a));
            });
            if (loose.length === 1) match = loose[0];
          }
          return {
            groups: out,
            matchId: match ? match.id : null,
            matchedName: match ? match.name : null,
            count: chats.length,
          };
        } catch (e) {
          return { groups: [], matchId: null, count: 0, error: String((e && e.message) || e) };
        }
      }, groupName);
      if (result.error) {
        console.error(`Group listing attempt ${attempt} error: ${result.error}`);
      }
      if (result.matchId) {
        if (result.matchedName && result.matchedName !== groupName) {
          console.log(`[group-match] "${groupName}" matched "${result.matchedName}"`);
        }
        return result.matchId;
      }
    groups = result.groups;
    if (attempt === 1) {
      console.log(`[groups] ${groups.map((g) => g.name).join(' | ') || '(none yet)'} (chats loaded: ${result.count})`);
    }
    } catch (err) {
      console.error(`Group listing attempt ${attempt} failed: ${err.message}`);
    }
    if (groups.some((g) => norm(g.name) === norm(groupName))) break;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  const chat =
    groups.find((g) => g.name === groupName) ||
    groups.find((g) => norm(g.name) === norm(groupName));
  if (!chat) {
    throw new Error(
      `group "${groupName}" not found after waiting; groups seen: ${groups.map((g) => g.name).join(' | ') || 'none'}`
    );
  }
  return chat.id;
}

// Records a timestamp/marker as a repo variable (created on first use) so the
// next runs can dedup. Used for the 30-minute cadence and the daily schedule.
async function updateVariable(name, value) {
  const token = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return;
  try {
    const headers = {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
    let res = await fetch(`https://api.github.com/repos/${repo}/actions/variables/${name}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name, value }),
    });
    if (res.status === 404) {
      res = await fetch(`https://api.github.com/repos/${repo}/actions/variables`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, value }),
      });
    }
    console.log(`${name} ${res.ok ? 'updated' : 'update failed (HTTP ' + res.status + ')'}.`);
  } catch (e) {
    console.error(`Could not update ${name}: ${e.message}`);
  }
}

// Removes regenerable Chromium cache dirs so the cloud cache stays small.
function cleanupBrowserCaches() {
  const def = path.join(__dirname, '.wwebjs_auth', 'session', 'Default');
  const targets = [
    'Cache',
    'Code Cache',
    'GPUCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    path.join('Service Worker', 'CacheStorage'),
    path.join('Service Worker', 'ScriptCache'),
  ];
  for (const target of targets) {
    try {
      fs.rmSync(path.join(def, target), { recursive: true, force: true });
    } catch {}
  }
}

function scheduleNextRound(round) {
  const now = Date.now();
  const next = Math.ceil(now / SEND_INTERVAL_MS) * SEND_INTERVAL_MS;
  console.log(`Next send at ${new Date(next).toLocaleTimeString()}.`);
  setTimeout(() => {
    round();
    setInterval(round, SEND_INTERVAL_MS);
  }, next - now);
}

client.initialize().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
