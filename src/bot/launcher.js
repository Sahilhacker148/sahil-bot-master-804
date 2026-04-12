'use strict';

// ════════════════════════════════════════════════════════════════
//  SAHIL 804 BOT — launcher.js
//  Developer : Legend Sahil Hacker 804
//  FIXES APPLIED:
//   1. defaultQueryTimeoutMs: undefined  (pair code "Connection Closed" on cloud fix)
//   2. browser: exact string array       (pair code 428 error fix)
//   3. pair code requested on qr event   (community confirmed working pattern)
// ════════════════════════════════════════════════════════════════

let makeWASocket, DisconnectReason, useMultiFileAuthState,
    fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
    isJidBroadcast, Browsers;

async function loadBaileys() {
  if (makeWASocket) return;
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket                = baileys.default;
  DisconnectReason            = baileys.DisconnectReason;
  useMultiFileAuthState       = baileys.useMultiFileAuthState;
  fetchLatestBaileysVersion   = baileys.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
  isJidBroadcast              = baileys.isJidBroadcast;
  Browsers                    = baileys.Browsers;
}

const path   = require('path');
const fs     = require('fs');
const config = require('../config/config');

const { logger, registerBot, removeBot, generateSessionId } = require('../utils/helpers');
const { handleMessage }                                      = require('../handlers/messageHandler');
const { createSession, getSession, updateSession }           = require('../firebase/config');

const SESSIONS_DIR           = path.join(process.cwd(), 'auth_info_baileys');
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_QR_ATTEMPTS        = 5;

const reconnectAttempts = new Map();
const pairCodeSent      = new Map();
const qrAttempts        = new Map();

const silentLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info:  () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => silentLogger,
};

async function startBot(
  sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, phoneNumber = null,
) {
  await loadBaileys();

  if (!sessionId) sessionId = generateSessionId();

  const authDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  let version;
  try {
    const result = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    version = result.version;
    logger.info(`[${sessionId}] WA version: ${version.join('.')}`);
  } catch {
    version = undefined;
    logger.warn(`[${sessionId}] fetchLatestBaileysVersion failed — using default`);
  }

  // FIX 1: Exact browser string array required for pair code on cloud servers
  // Browsers.macOS() helper generates wrong format that WhatsApp rejects with 428
  const browserConfig = phoneNumber
    ? ['Mac OS', 'Chrome', '114.0.5735.198']
    : Browsers.ubuntu('SAHIL 804 BOT');

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    browser:                        browserConfig,
    printQRInTerminal:              false,
    logger:                         silentLogger,
    connectTimeoutMs:               60_000,
    defaultQueryTimeoutMs:          undefined,   // FIX 2: undefined = no timeout, fixes "Connection Closed" on cloud
    keepAliveIntervalMs:            25_000,
    retryRequestDelayMs:            2_000,
    markOnlineOnConnect:            false,
    syncFullHistory:                false,
    fireInitQueries:                false,
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: jid => isJidBroadcast(jid),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR code flow
    if (qr) {
      const qCount = (qrAttempts.get(sessionId) || 0) + 1;
      qrAttempts.set(sessionId, qCount);
      if (qCount > MAX_QR_ATTEMPTS) {
        logger.warn(`[${sessionId}] QR limit reached. Aborting.`);
        _cleanup(sessionId);
        if (onDisconnected) onDisconnected(sessionId);
        return;
      }
      logger.info(`[${sessionId}] QR attempt ${qCount}/${MAX_QR_ATTEMPTS}`);
      if (onQR) onQR(qr);

      // FIX 3: Request pair code inside qr event — this is the confirmed working pattern
      // on cloud/Railway. The qr event fires when WA server is ready to accept pairing.
      // Requesting pair code here (not on 'connecting') works reliably on all platforms.
      if (phoneNumber && !sock.authState.creds.registered && !pairCodeSent.get(sessionId)) {
        pairCodeSent.set(sessionId, true);
        try {
          const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
          if (cleanNum.length < 10) throw new Error('Phone number too short');
          const code = await sock.requestPairingCode(cleanNum);
          const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
          logger.info(`[${sessionId}] Pair code: ${formatted}`);
          if (onPairCode) onPairCode(formatted);
        } catch (err) {
          logger.error(`[${sessionId}] Pair code error: ${err.message}`);
          pairCodeSent.delete(sessionId);
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = ![
        DisconnectReason.loggedOut,
        DisconnectReason.badSession,
        DisconnectReason.forbidden,
        DisconnectReason.connectionReplaced,
      ].includes(statusCode);

      logger.warn(`[${sessionId}] Disconnected — code: ${statusCode} | reconnect: ${shouldReconnect}`);
      removeBot(sessionId);
      pairCodeSent.delete(sessionId);
      qrAttempts.delete(sessionId);
      await updateSession(sessionId, { status: 'inactive' }).catch(() => {});

      if (!shouldReconnect) {
        reconnectAttempts.delete(sessionId);
        fs.rmSync(authDir, { recursive: true, force: true });
        if (onDisconnected) onDisconnected(sessionId);
        return;
      }

      const attempts = (reconnectAttempts.get(sessionId) || 0) + 1;
      reconnectAttempts.set(sessionId, attempts);
      if (attempts > MAX_RECONNECT_ATTEMPTS) {
        logger.error(`[${sessionId}] Max reconnect attempts exceeded.`);
        _cleanup(sessionId);
        if (onDisconnected) onDisconnected(sessionId);
        return;
      }

      const delay = Math.min(5_000 * Math.pow(2, attempts - 1), 60_000);
      logger.info(`[${sessionId}] Reconnecting in ${delay / 1000}s (attempt ${attempts})…`);
      setTimeout(() => startBot(sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, null), delay);
    }

    if (connection === 'open') {
      reconnectAttempts.delete(sessionId);
      pairCodeSent.delete(sessionId);
      qrAttempts.delete(sessionId);

      const botNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
      if (!botNumber) { logger.error(`[${sessionId}] Could not read bot number.`); return; }

      logger.success(`[${sessionId}] ✅ Connected as +${botNumber}`);
      registerBot(sessionId, sock, 'public');

      try {
        const existing = await getSession(sessionId);
        if (!existing) await createSession(sessionId, userId, botNumber);
        else await updateSession(sessionId, { status: 'active', whatsappNumber: botNumber });
      } catch (err) {
        logger.error(`[${sessionId}] Firebase sync error: ${err.message}`);
      }

      const welcomeMsg =
        `╔═══════════════════════════════╗\n` +
        `║  🤖 𝑺𝑨𝑯𝑰𝑳 𝟖𝟎𝟒 𝑩𝑶𝑻 𝑹𝑬𝑨𝑫𝒀!     ║\n` +
        `╠═══════════════════════════════╣\n` +
        `║ ✅ 𝑪𝒐𝒏𝒏𝒆𝒄𝒕𝒆𝒅 𝒔𝒖𝒄𝒄𝒆𝒔𝒔𝒇𝒖𝒍𝒍𝒚!  ║\n` +
        `║ 📋 𝑻𝒚𝒑𝒆 .𝒎𝒆𝒏𝒖 𝒕𝒐 𝒔𝒕𝒂𝒓𝒕       ║\n` +
        `║ 🔐 𝑺𝒆𝒔𝒔𝒊𝒐𝒏: ${sessionId.padEnd(17)}║\n` +
        `║ 👑 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒  ║\n` +
        `╚═══════════════════════════════╝`;

      await sock.sendMessage(`${botNumber}@s.whatsapp.net`, { text: welcomeMsg }).catch(() => {});
      if (onConnected) onConnected(sessionId, botNumber);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      await handleMessage(sock, msg, sessionId).catch(err =>
        logger.error(`[${sessionId}] Message handler error: ${err.message}`),
      );
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (action === 'add') {
      for (const participant of participants) {
        const num = participant.replace('@s.whatsapp.net', '');
        await sock.sendMessage(id, {
          text: `╔══════════════════════════╗\n║ 👋 𝑾𝑬𝑳𝑪𝑶𝑴𝑬 𝑻𝑶 𝑻𝑯𝑬 𝑮𝑹𝑶𝑼𝑷! ║\n╠══════════════════════════╣\n║ 🎉 @${num} 𝒉𝒂𝒔 𝒋𝒐𝒊𝒏𝒆𝒅!\n║ 👑 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒\n╚══════════════════════════╝`,
          mentions: [participant],
        }).catch(() => {});
      }
    }
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

async function stopBot(sessionId) {
  _cleanup(sessionId);
  await updateSession(sessionId, { status: 'inactive' }).catch(() => {});
  logger.info(`[${sessionId}] Bot stopped.`);
}

function _cleanup(sessionId) {
  removeBot(sessionId);
  reconnectAttempts.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);
}

module.exports = { startBot, stopBot };
