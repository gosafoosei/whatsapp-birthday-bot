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
  const round = () => sendAll().catch((err) => console.error('Send round failed:', err.message));
  if (process.env.ONCE === '1') {
    round().then(() => {
      cleanupBrowserCaches();
      console.log('ONCE mode: round complete, exiting.');
      client.destroy().finally(() => process.exit(0));
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

async function sendAll() {
  const config = loadConfig();
  console.log(`\n--- Send round started at ${new Date().toLocaleTimeString()} ---`);
  for (const contact of config.contacts) {
    try {
      if (contact.group) {
        const chat = await resolveGroupChat(contact.group);
        await chat.sendMessage(config.message);
        console.log(`[sent]   ${contact.name} (${chat.id._serialized})`);
      } else {
        const chatId = chatIdFor(contact.number);
        await client.sendMessage(chatId, config.message);
        console.log(`[sent]   ${contact.name} (${chatId})`);
      }
    } catch (err) {
      console.error(`[failed] ${contact.name}: ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_SENDS_MS));
  }
}

// Groups are addressed by name; resolve against the chats WhatsApp knows about.
async function resolveGroupChat(groupName) {
  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);
  const chat =
    groups.find((c) => c.name === groupName) ||
    groups.find((c) => c.name.toLowerCase().trim() === groupName.toLowerCase().trim());
  if (!chat) {
    throw new Error(
      `group "${groupName}" not found; groups seen: ${groups.map((g) => g.name).join(' | ') || 'none'}`
    );
  }
  return chat;
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
