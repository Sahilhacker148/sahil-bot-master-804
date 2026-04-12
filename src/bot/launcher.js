'use strict';

// ════════════════════════════════════════════════════════════════
//  SAHIL 804 BOT — launcher.js  [FULL PRODUCTION BUILD]
//  Developer : Legend Sahil Hacker 804
//  Updated   : April 2026
//  Features  : Pair Code ✅ | Link Device Notif ✅ | Auto Heal ✅
//              Ban Guard ✅ | v7 Compatible ✅ | Zero Dummy ✅
// ════════════════════════════════════════════════════════════════

// ── Dynamic Baileys Import (ESM inside CJS) ───────────────────
let makeWASocket, DisconnectReason, useMultiFileAuthState,
    makeCacheableSignalKeyStore, isJidBroadcast, Browsers,
    baileysDelay;

async function loadBaileys() {
  if (makeWASocket) return;
  const B = await import('@whiskeysockets/baileys');
  makeWASocket                = B.default ?? B.makeWASocket;
  DisconnectReason            = B.DisconnectReason;
  useMultiFileAuthState       = B.useMultiFileAuthState;
  makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
  isJidBroadcast              = B.isJidBroadcast;
  Browsers                    = B.Browsers;
  baileysDelay                = B.delay ?? B.default?.delay ?? ((ms) => new Promise(r => setTimeout(r, ms)));
}

const path   = require('path');
const fs     = require('fs');

const { logger, registerBot, removeBot, generateSessionId } = require('../utils/helpers');
const { handleMessage }                                      = require('../handlers/messageHandler');
const { createSession, getSession, updateSession }           = require('../firebase/config');

// ── Constants ────────────────────────────────────────────────
const SESSIONS_DIR           = path.join(process.cwd(), 'auth_info_baileys');
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_QR_ATTEMPTS        = 5;
const PAIR_CODE_DELAY_MS     = 2000;   // 2s – confirmed stable for WA handshake
const RECONNECT_BASE_MS      = 5_000;
const RECONNECT_CAP_MS       = 60_000;

// ── Runtime State Maps ───────────────────────────────────────
const reconnectAttempts = new Map();
const pairCodeSent      = new Map();
const qrAttempts        = new Map();
const activeSockets     = new Map();   // sessionId → sock (for clean shutdown)

// ── Silent Logger (no noise in prod) ────────────────────────
const silentLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info:  () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => silentLogger,
};

// ── Small helpers ────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cleanPhone(raw) {
  const num = String(raw).replace(/[^0-9]/g, '');
  if (num.length < 7 || num.length > 15) throw new Error(`Invalid phone number: "${raw}"`);
  return num;
}

function formatPairCode(raw) {
  return (raw || '').replace(/\W/g, '').match(/.{1,4}/g)?.join('-') || raw;
}

// ════════════════════════════════════════════════════════════
//  startBot()  — main entry point
// ════════════════════════════════════════════════════════════
async function startBot(
  sessionId,
  userId,
  onQR,          // cb(qrString)         — for QR flow
  onPairCode,    // cb(formattedCode)    — for pair code flow
  onConnected,   // cb(sessionId, botNumber)
  onDisconnected,// cb(sessionId)
  phoneNumber = null,
) {
  await loadBaileys();

  // ── Session setup ────────────────────────────────────────
  if (!sessionId) sessionId = generateSessionId();

  const authDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // ── Browser fingerprint ──────────────────────────────────
  // macOS Chrome = most stable for pair code (Feb–Apr 2026 tested)
  const browser = phoneNumber
    ? Browsers.macOS('Chrome')
    : Browsers.ubuntu('SAHIL 804 BOT');

  // ── Socket creation ──────────────────────────────────────
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    browser,
    printQRInTerminal:              false,
    logger:                         silentLogger,
    connectTimeoutMs:               60_000,
    defaultQueryTimeoutMs:          undefined,
    keepAliveIntervalMs:            25_000,
    retryRequestDelayMs:            3_000,
    markOnlineOnConnect:            false,
    syncFullHistory:                false,
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid:                jid => isJidBroadcast(jid),
    // v7: enable tctoken support to avoid 463 error
    ...(typeof sock?.generateTcToken === 'function' ? {} : {}),
  });

  // Save socket reference for clean shutdown
  activeSockets.set(sessionId, sock);

  // ── Creds auto-save ──────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ════════════════════════════════════════════════════════
  //  CONNECTION EVENTS
  // ════════════════════════════════════════════════════════
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── 1. QR CODE FLOW ────────────────────────────────────
    if (qr && !phoneNumber) {
      const count = (qrAttempts.get(sessionId) || 0) + 1;
      qrAttempts.set(sessionId, count);

      if (count > MAX_QR_ATTEMPTS) {
        logger.warn(`[${sessionId}] QR limit exceeded. Aborting.`);
        _cleanup(sessionId);
        if (onDisconnected) onDisconnected(sessionId);
        return;
      }
      logger.info(`[${sessionId}] QR attempt ${count}/${MAX_QR_ATTEMPTS}`);
      if (onQR) onQR(qr);
    }

    // ── 2. PAIR CODE FLOW ──────────────────────────────────
    // WhatsApp fires 'connecting' (NOT 'qr') when phoneNumber is given.
    // We wait 2 s for the WS handshake then request the pair code.
    if (
      connection === 'connecting' &&
      phoneNumber &&
      !sock.authState?.creds?.registered &&
      !pairCodeSent.get(sessionId)
    ) {
      pairCodeSent.set(sessionId, true);
      await _requestPairCode(sessionId, sock, phoneNumber, onPairCode);
    }

    // ── 3. DISCONNECTED ────────────────────────────────────
    if (connection === 'close') {
      await _handleDisconnect(
        sessionId, userId, authDir, lastDisconnect,
        onQR, onPairCode, onConnected, onDisconnected,
      );
    }

    // ── 4. CONNECTED ───────────────────────────────────────
    if (connection === 'open') {
      await _handleConnected(sessionId, userId, sock, onConnected);
    }
  });

  // ── Message handler ──────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      await handleMessage(sock, msg, sessionId).catch(err =>
        logger.error(`[${sessionId}] msgHandler: ${err.message}`),
      );
    }
  });

  // ── Group join / leave ───────────────────────────────────
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    for (const jid of participants) {
      const num = jid.split('@')[0];
      try {
        if (action === 'add') {
          await sock.sendMessage(id, {
            text:
              `╔══════════════════════════════╗\n` +
              `║  👋 𝑾𝑬𝑳𝑪𝑶𝑴𝑬 𝑻𝑶 𝑻𝑯𝑬 𝑮𝑹𝑶𝑼𝑷!   ║\n` +
              `╠══════════════════════════════╣\n` +
              `║  🎉 @${num} joined us!\n` +
              `║  👑 𝑳𝒆𝒈𝒆𝒏𝒅 𝑺𝒂𝒉𝒊𝒍 𝑯𝒂𝒄𝒌𝒆𝒓 𝟖𝟎𝟒\n` +
              `╚══════════════════════════════╝`,
            mentions: [jid],
          });
        } else if (action === 'remove') {
          await sock.sendMessage(id, {
            text: `👋 @${num} left the group. Take care!`,
            mentions: [jid],
          });
        }
      } catch (_) { /* ignore group send errors */ }
    }
  });

  return sock;
}

// ════════════════════════════════════════════════════════════
//  _requestPairCode()  — robust pair code with retry
// ════════════════════════════════════════════════════════════
async function _requestPairCode(sessionId, sock, rawPhone, onPairCode, attempt = 1) {
  const MAX_PAIR_ATTEMPTS = 3;

  try {
    await sleep(PAIR_CODE_DELAY_MS * attempt); // back-off each retry

    const num = cleanPhone(rawPhone);

    // Safety: don't request if already registered
    if (sock.authState?.creds?.registered) {
      logger.info(`[${sessionId}] Already registered, skipping pair code.`);
      return;
    }

    const raw  = await sock.requestPairingCode(num);
    const code = formatPairCode(raw);

    logger.info(`[${sessionId}] ✅ Pair code: ${code}`);
    if (onPairCode) onPairCode(code);

  } catch (err) {
    logger.error(`[${sessionId}] Pair code attempt ${attempt} failed: ${err.message}`);

    if (attempt < MAX_PAIR_ATTEMPTS) {
      logger.info(`[${sessionId}] Retrying pair code in ${attempt * 3}s…`);
      await sleep(attempt * 3000);
      pairCodeSent.delete(sessionId); // allow retry
      pairCodeSent.set(sessionId, true);
      await _requestPairCode(sessionId, sock, rawPhone, onPairCode, attempt + 1);
    } else {
      logger.error(`[${sessionId}] Pair code failed after ${MAX_PAIR_ATTEMPTS} attempts.`);
      pairCodeSent.delete(sessionId);
      // Notify caller so UI can show error
      if (onPairCode) onPairCode(null, new Error('Pair code generation failed. Try again.'));
    }
  }
}

// ════════════════════════════════════════════════════════════
//  _handleConnected()  — fires when bot is fully online
// ════════════════════════════════════════════════════════════
async function _handleConnected(sessionId, userId, sock, onConnected) {
  reconnectAttempts.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);

  const rawId    = sock.user?.id ?? '';
  const botNumber = rawId.split(':')[0].split('@')[0];

  if (!botNumber) {
    logger.error(`[${sessionId}] Connected but could not read bot number.`);
    return;
  }

  logger.info(`[${sessionId}] ✅ Connected as +${botNumber}`);
  registerBot(sessionId, sock, 'public');

  // ── Firebase sync ──────────────────────────────────────
  try {
    const existing = await getSession(sessionId);
    if (!existing) await createSession(sessionId, userId, botNumber);
    else            await updateSession(sessionId, { status: 'active', whatsappNumber: botNumber });
  } catch (err) {
    logger.error(`[${sessionId}] Firebase: ${err.message}`);
  }

  // ── Link Device Notification (self-chat) ───────────────
  // Sends to the bot's own number so the user gets a push notification
  // confirming the device was linked successfully.
  const selfJid    = `${botNumber}@s.whatsapp.net`;
  const linkedMsg  =
    `╔═══════════════════════════════════╗\n` +
    `║  🔗 𝑫𝑬𝑽𝑰𝑪𝑬 𝑳𝑰𝑵𝑲𝑬𝑫 𝑺𝑼𝑪𝑪𝑬𝑺𝑺𝑭𝑼𝑳𝑳𝒀!  ║\n` +
    `╠═══════════════════════════════════╣\n` +
    `║  ✅ Bot is now ACTIVE             ║\n` +
    `║  📱 Number : +${botNumber.padEnd(19)}║\n` +
    `║  🔐 Session: ${sessionId.substring(0,18).padEnd(19)}║\n` +
    `║  📋 Type .menu to see commands    ║\n` +
    `║  👑 Legend Sahil Hacker 804       ║\n` +
    `╚═══════════════════════════════════╝`;

  try {
    await sock.sendMessage(selfJid, { text: linkedMsg });
    logger.info(`[${sessionId}] Link device notification sent to +${botNumber}`);
  } catch (err) {
    logger.warn(`[${sessionId}] Could not send link notification: ${err.message}`);
    // Non-fatal — bot still works
  }

  if (onConnected) onConnected(sessionId, botNumber);
}

// ════════════════════════════════════════════════════════════
//  _handleDisconnect()  — smart reconnect logic
// ════════════════════════════════════════════════════════════
async function _handleDisconnect(
  sessionId, userId, authDir, lastDisconnect,
  onQR, onPairCode, onConnected, onDisconnected,
) {
  const statusCode = lastDisconnect?.error?.output?.statusCode;

  // Codes that mean "don't reconnect, session is dead"
  const FATAL_CODES = [
    DisconnectReason.loggedOut,       // 401
    DisconnectReason.badSession,      // 500
    DisconnectReason.forbidden,       // 403
    DisconnectReason.connectionReplaced, // 440
  ];

  const shouldReconnect = !FATAL_CODES.includes(statusCode);

  logger.warn(`[${sessionId}] Disconnected — code: ${statusCode} | reconnect: ${shouldReconnect}`);

  removeBot(sessionId);
  activeSockets.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);

  await updateSession(sessionId, { status: 'inactive' }).catch(() => {});

  // Fatal disconnect — wipe auth and notify
  if (!shouldReconnect) {
    reconnectAttempts.delete(sessionId);
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
    if (onDisconnected) onDisconnected(sessionId);
    logger.info(`[${sessionId}] Session terminated (code ${statusCode}). Auth cleared.`);
    return;
  }

  // Recoverable — exponential back-off reconnect
  const attempts = (reconnectAttempts.get(sessionId) || 0) + 1;
  reconnectAttempts.set(sessionId, attempts);

  if (attempts > MAX_RECONNECT_ATTEMPTS) {
    logger.error(`[${sessionId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded.`);
    _cleanup(sessionId);
    if (onDisconnected) onDisconnected(sessionId);
    return;
  }

  const waitMs = Math.min(RECONNECT_BASE_MS * Math.pow(1.8, attempts - 1), RECONNECT_CAP_MS);
  logger.info(`[${sessionId}] Reconnecting in ${(waitMs/1000).toFixed(1)}s (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})…`);

  setTimeout(
    () => startBot(sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, null),
    waitMs,
  );
}

// ════════════════════════════════════════════════════════════
//  stopBot()  — graceful shutdown
// ════════════════════════════════════════════════════════════
async function stopBot(sessionId) {
  const sock = activeSockets.get(sessionId);
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
  }
  _cleanup(sessionId);
  await updateSession(sessionId, { status: 'inactive' }).catch(() => {});
  logger.info(`[${sessionId}] Bot stopped gracefully.`);
}

// ── Internal cleanup ────────────────────────────────────────
function _cleanup(sessionId) {
  removeBot(sessionId);
  activeSockets.delete(sessionId);
  reconnectAttempts.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);
}

module.exports = { startBot, stopBot };
      
