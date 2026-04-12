'use strict';

// ════════════════════════════════════════════════════════════════
//  SAHIL 804 BOT — launcher.js
//  Production-Grade · Multi-Device · Railway / VPS / Docker Ready
//  Built with 2026 Baileys Best Practices
//  Developer : Legend Sahil Hacker 804
// ════════════════════════════════════════════════════════════════

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  Browsers,
} = require('@whiskeysockets/baileys');

const path   = require('path');
const fs     = require('fs');
const config = require('../config/config');

const { logger, registerBot, removeBot, generateSessionId } = require('../utils/helpers');
const { handleMessage }                                      = require('../handlers/messageHandler');
const { createSession, getSession, updateSession }           = require('../firebase/config');

// ─── CONSTANTS ────────────────────────────────────────────────
const SESSIONS_DIR          = path.join(process.cwd(), 'auth_info_baileys');
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_QR_ATTEMPTS        = 5;   // after 5 QR refreshes, abort — phone is offline

// ─── IN-MEMORY TRACKERS ───────────────────────────────────────
const reconnectAttempts = new Map(); // sessionId → count
const pairCodeSent      = new Map(); // sessionId → boolean (send only once)
const qrAttempts        = new Map(); // sessionId → count

// ─── SILENT BAILEYS LOGGER ───────────────────────────────────
// Baileys floods stdout — silence it completely in production
const silentLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info:  () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => silentLogger,
};

// ════════════════════════════════════════════════════════════════
//  startBot()
//  ─────────────
//  sessionId    : unique bot identifier (SAHIL-XXXXXXXX)
//  userId       : Firebase UID of the owner
//  onQR         : callback(qrString)   — send to frontend WebSocket
//  onPairCode   : callback(code)       — send to frontend WebSocket
//  onConnected  : callback(sessionId, botNumber)
//  onDisconnected: callback(sessionId)
//  phoneNumber  : E.164 without "+" — triggers pair-code flow
// ════════════════════════════════════════════════════════════════
async function startBot(
  sessionId,
  userId,
  onQR,
  onPairCode,
  onConnected,
  onDisconnected,
  phoneNumber = null,
) {
  if (!sessionId) sessionId = generateSessionId();

  // ── Ensure auth directory exists ──────────────────────────
  const authDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  // ── Load persisted credentials (no QR re-scan on restart) ─
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // ── Fetch WA protocol version with safe fallback ──────────
  // NOTE: fetchLatestBaileysVersion() can hang on Railway (network
  // restrictions). We wrap it in a 5s timeout — if it fails we fall
  // back to Baileys' built-in default (always safe & compatible).
  let version;
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    version = result.version;
    logger.info(`[${sessionId}] WA version: ${version.join('.')} | latest: ${result.isLatest}`);
  } catch {
    version = undefined; // let Baileys use its own default — safest option
    logger.warn(`[${sessionId}] fetchLatestBaileysVersion failed — using Baileys default version`);
  }

  // ── Build socket ──────────────────────────────────────────
  // CRITICAL: When using pair code, browser MUST be a valid/logical
  // config like Browsers.macOS('Chrome') — custom strings cause
  // WhatsApp to REJECT the pair code. Per official 2026 Baileys docs.
  const browserConfig = phoneNumber
    ? Browsers.macOS('Chrome')           // pair code flow — required
    : Browsers.ubuntu('SAHIL 804 BOT');  // QR flow — can be custom

  const sock = makeWASocket({
    ...(version ? { version } : {}),     // only pass version if fetch succeeded
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
    },

    // ── Identity presented to WhatsApp servers ────────────
    browser: browserConfig,

    // ── Performance & stability ───────────────────────────
    printQRInTerminal:           false,  // we send QR via WebSocket
    logger:                      silentLogger,
    connectTimeoutMs:            60_000,
    defaultQueryTimeoutMs:       60_000,
    keepAliveIntervalMs:         25_000, // ping WA every 25 s
    retryRequestDelayMs:         2_000,

    // ── Notifications: set false so phone also gets notifs ─
    // Per 2026 Baileys docs: markOnlineOnConnect: true blocks
    // push notifications on the linked phone.
    markOnlineOnConnect:         false,

    // ── Memory optimisation ───────────────────────────────
    syncFullHistory:             false,
    fireInitQueries:             false,
    generateHighQualityLinkPreview: true,

    // ── Ignore broadcast/status messages (save CPU) ───────
    shouldIgnoreJid: jid => isJidBroadcast(jid),
  });

  // ── Persist credentials on every update ──────────────────
  sock.ev.on('creds.update', saveCreds);

  // ════════════════════════════════════════════════════════
  //  CONNECTION LIFECYCLE — The heart of reliability
  //  Official 2026 pattern: handle EVERYTHING inside
  //  connection.update, not outside it.
  // ════════════════════════════════════════════════════════
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR Code ─────────────────────────────────────────
    if (qr) {
      const qCount = (qrAttempts.get(sessionId) || 0) + 1;
      qrAttempts.set(sessionId, qCount);

      if (qCount > MAX_QR_ATTEMPTS) {
        // Phone is probably offline — stop wasting resources
        logger.warn(`[${sessionId}] QR limit reached (${MAX_QR_ATTEMPTS}). Aborting.`);
        _cleanup(sessionId, authDir);
        if (onDisconnected) onDisconnected(sessionId);
        return;
      }

      logger.info(`[${sessionId}] QR attempt ${qCount}/${MAX_QR_ATTEMPTS}`);
      if (onQR) onQR(qr);
    }

    // ── Pair Code ───────────────────────────────────────
    // CORRECT 2026 pattern per official Baileys docs:
    // Request INSIDE connection.update on "connecting" or qr event,
    // NOT before the event listener is registered.
    // Guard: send only once per session lifecycle.
    if (
      phoneNumber &&
      !sock.authState.creds.registered &&
      !pairCodeSent.get(sessionId) &&
      (connection === 'connecting' || !!qr)
    ) {
      pairCodeSent.set(sessionId, true); // prevent duplicate requests
      try {
        const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNum.length < 10) throw new Error('Phone number too short');

        const code = await sock.requestPairingCode(cleanNum);
        // Format as XXXX-XXXX for readability
        const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
        logger.info(`[${sessionId}] Pair code: ${formatted}`);
        if (onPairCode) onPairCode(formatted);
      } catch (err) {
        logger.error(`[${sessionId}] Pair code error: ${err.message}`);
        pairCodeSent.delete(sessionId); // allow retry on next event
      }
    }

    // ── Disconnected ─────────────────────────────────────
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // Per 2026 Baileys disconnect reason table:
      const reasons = {
        [DisconnectReason.loggedOut]:           'loggedOut',
        [DisconnectReason.badSession]:          'badSession',
        [DisconnectReason.connectionReplaced]:  'connectionReplaced',
        [DisconnectReason.forbidden]:           'forbidden',
        [DisconnectReason.multideviceMismatch]: 'multideviceMismatch',
      };
      const reasonLabel     = reasons[statusCode] || `code:${statusCode}`;
      const shouldReconnect = ![
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.forbidden,
        DisconnectReason.connectionReplaced,
      ].includes(statusCode);

      logger.warn(`[${sessionId}] Disconnected — reason: ${reasonLabel} | reconnect: ${shouldReconnect}`);

      removeBot(sessionId);
      pairCodeSent.delete(sessionId);
      qrAttempts.delete(sessionId);
      await updateSession(sessionId, { status: 'inactive' }).catch(() => {});

      if (!shouldReconnect) {
        // Permanent disconnect — wipe auth files to force fresh QR/pair
        logger.warn(`[${sessionId}] Permanent disconnect (${reasonLabel}). Wiping auth.`);
        reconnectAttempts.delete(sessionId);
        fs.rmSync(authDir, { recursive: true, force: true });
        if (onDisconnected) onDisconnected(sessionId);
        return;
      }

      // ── Exponential back-off reconnect ─────────────────
      const attempts = (reconnectAttempts.get(sessionId) || 0) + 1;
      reconnectAttempts.set(sessionId, attempts);

      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${sessionId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded. Giving up.`);
        _cleanup(sessionId, authDir);
        if (onDisconnected) onDisconnected(sessionId);
        return;
      }

      // Back-off: 5s, 10s, 20s … capped at 60s
      const delay = Math.min(5_000 * Math.pow(2, attempts - 1), 60_000);
      logger.info(`[${sessionId}] Reconnecting in ${delay / 1000}s (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})…`);

      setTimeout(
        () => startBot(sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, null),
        delay,
      );
    }

    // ── Connected ────────────────────────────────────────
    if (connection === 'open') {
      // Reset all counters on successful connection
      reconnectAttempts.delete(sessionId);
      pairCodeSent.delete(sessionId);
      qrAttempts.delete(sessionId);

      const botNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
      if (!botNumber) {
        logger.error(`[${sessionId}] Connected but could not read bot number.`);
        return;
      }

      logger.success(`[${sessionId}] ✅ Connected as +${botNumber}`);
      registerBot(sessionId, sock, 'public');

      // Sync session to Firebase
      try {
        const existing = await getSession(sessionId);
        if (!existing) {
          await createSession(sessionId, userId, botNumber);
        } else {
          await updateSession(sessionId, { status: 'active', whatsappNumber: botNumber });
        }
      } catch (err) {
        logger.error(`[${sessionId}] Firebase session sync error: ${err.message}`);
      }

      // Welcome message to the bot's own number
      const welcomeMsg =
        `╔═══════════════════════════════╗\n` +
        `║  🤖 𝑺𝑨𝑯𝑰𝑳 𝟖𝟎𝟒 𝑩𝑶𝑻 𝑹𝑬𝑨𝑫𝒀!     ║\n` +
        `╠═══════════════════════════════╣\n` +
        `║ ✅ 𝑪𝒐𝒏𝒏𝒆𝒄𝒕𝒆𝒅 𝒔𝒖𝒄𝒄𝒆𝒔𝒔𝒇𝒖𝒍𝒍𝒚!  ║\n` +
        `║                               ║\n` +
        `║ 📋 𝑻𝒚𝒑𝒆 .𝒎𝒆𝒏𝒖 𝒕𝒐 𝒔𝒕𝒂𝒓𝒕       ║\n` +
        `║ 🌐 𝑴𝒐𝒅𝒆: 𝑷𝑼𝑩𝑳𝑰𝑪               ║\n` +
        `║                               ║\n` +
        `║ 🔒 𝑭𝒐𝒓 𝒑𝒓𝒊𝒗𝒂𝒕𝒆 𝒎𝒐𝒅𝒆:         ║\n` +
        `║    𝑻𝒚𝒑𝒆 .𝒑𝒓𝒊𝒗𝒂𝒕𝒆             ║\n` +
        `║                               ║\n` +
        `║ 🔐 𝑺𝒆𝒔𝒔𝒊𝒐𝒏 𝑰𝑫:               ║\n` +
        `║ ${sessionId.padEnd(29)}║\n` +
        `║                               ║\n` +
        `║ 👑 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒  ║\n` +
        `╚═══════════════════════════════╝`;

      await sock
        .sendMessage(`${botNumber}@s.whatsapp.net`, { text: welcomeMsg })
        .catch(() => {});

      if (onConnected) onConnected(sessionId, botNumber);
    }
  });

  // ════════════════════════════════════════════════════════
  //  MESSAGE HANDLER
  // ════════════════════════════════════════════════════════
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      // Per 2026 best practice: never let one message crash the loop
      await handleMessage(sock, msg, sessionId).catch(err =>
        logger.error(`[${sessionId}] Message handler error: ${err.message}`),
      );
    }
  });

  // ════════════════════════════════════════════════════════
  //  GROUP PARTICIPANT EVENTS
  // ════════════════════════════════════════════════════════
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {

    // ── Welcome new members ──────────────────────────────
    if (action === 'add') {
      for (const participant of participants) {
        const num = participant.replace('@s.whatsapp.net', '');
        await sock.sendMessage(id, {
          text:
            `╔══════════════════════════╗\n` +
            `║ 👋 𝑾𝑬𝑳𝑪𝑶𝑴𝑬 𝑻𝑶 𝑻𝑯𝑬 𝑮𝑹𝑶𝑼𝑷! ║\n` +
            `╠══════════════════════════╣\n` +
            `║ 🎉 @${num} 𝒉𝒂𝒔 𝒋𝒐𝒊𝒏𝒆𝒅!\n` +
            `║ 🌟 𝑾𝒆 𝒂𝒓𝒆 𝒈𝒍𝒂𝒅 𝒕𝒐 𝒉𝒂𝒗𝒆 𝒚𝒐𝒖!\n` +
            `║ 👑 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒\n` +
            `╚══════════════════════════╝`,
          mentions: [participant],
        }).catch(() => {});
      }
    }

    // ── Goodbye message ──────────────────────────────────
    if (action === 'remove') {
      for (const participant of participants) {
        const num = participant.replace('@s.whatsapp.net', '');
        await sock.sendMessage(id, {
          text: `👋 @${num} has left the group. Goodbye!`,
          mentions: [participant],
        }).catch(() => {});
      }
    }
  });

  return sock;
}

// ════════════════════════════════════════════════════════════════
//  stopBot() — Clean shutdown, no memory leaks
// ════════════════════════════════════════════════════════════════
async function stopBot(sessionId) {
  _cleanup(sessionId);
  await updateSession(sessionId, { status: 'inactive' }).catch(() => {});
  logger.info(`[${sessionId}] Bot stopped.`);
}

// ── Internal cleanup helper ──────────────────────────────────
function _cleanup(sessionId) {
  removeBot(sessionId);
  reconnectAttempts.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);
}

module.exports = { startBot, stopBot };