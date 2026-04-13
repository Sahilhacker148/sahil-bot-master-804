'use strict';

// ════════════════════════════════════════════════════════════════
//  SAHIL 804 BOT — launcher.js
//  Developer : Legend Sahil Hacker 804
//  METHOD: Exact fix from GitHub Issue #19907 (Ron at FlyTech)
//  - browser: ['Mac OS', 'Chrome', '14.4.1']  (exact string)
//  - defaultQueryTimeoutMs: undefined
//  - Pair code requested on 'qr' event (confirmed working)
// ════════════════════════════════════════════════════════════════

let makeWASocket, DisconnectReason, useMultiFileAuthState,
    makeCacheableSignalKeyStore, isJidBroadcast, Browsers;

async function loadBaileys() {
  if (makeWASocket) return;
  const B = await import('@whiskeysockets/baileys');
  makeWASocket                = B.default ?? B.makeWASocket;
  DisconnectReason            = B.DisconnectReason;
  useMultiFileAuthState       = B.useMultiFileAuthState;
  makeCacheableSignalKeyStore = B.makeCacheableSignalKeyStore;
  isJidBroadcast              = B.isJidBroadcast;
  Browsers                    = B.Browsers;
}

const path = require('path');
const fs   = require('fs');

const { logger, registerBot, removeBot, generateSessionId } = require('../utils/helpers');
const { handleMessage }                                      = require('../handlers/messageHandler');
const { createSession, getSession, updateSession }           = require('../firebase/config');

const SESSIONS_DIR           = path.join(process.cwd(), 'auth_info_baileys');
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_QR_ATTEMPTS        = 5;
const PAIR_CODE_DELAY_MS     = 2000;
const RECONNECT_BASE_MS      = 5_000;
const RECONNECT_CAP_MS       = 60_000;

const reconnectAttempts = new Map();
const pairCodeSent      = new Map();
const qrAttempts        = new Map();
const activeSockets     = new Map();

const silentLogger = {
  level: 'silent',
  trace: () => {}, debug: () => {}, info:  () => {},
  warn:  () => {}, error: () => {}, fatal: () => {},
  child: () => silentLogger,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function cleanPhone(raw) {
  const num = String(raw).replace(/[^0-9]/g, '');
  if (num.length < 7 || num.length > 15) throw new Error(`Invalid phone number: "${raw}"`);
  return num;
}

function formatPairCode(raw) {
  return (raw || '').replace(/\W/g, '').match(/.{1,4}/g)?.join('-') || raw;
}

async function startBot(
  sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, phoneNumber = null,
) {
  await loadBaileys();

  if (!sessionId) sessionId = generateSessionId();

  const authDir = path.join(SESSIONS_DIR, sessionId);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // ── EXACT FIX from GitHub Issue #19907 (Ron at FlyTech) ──
  // Browser must be EXACTLY ['Mac OS', 'Chrome', '14.4.1'] for pairing
  // Browsers.macOS('Chrome') helper generates wrong format
  const browser = phoneNumber
    ? ['Mac OS', 'Chrome', '14.4.1']
    : Browsers.ubuntu('SAHIL 804 BOT');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    browser,
    printQRInTerminal:              false,
    logger:                         silentLogger,
    connectTimeoutMs:               60_000,
    defaultQueryTimeoutMs:          undefined,  // MUST be undefined — prevents premature timeout
    keepAliveIntervalMs:            25_000,
    retryRequestDelayMs:            3_000,
    markOnlineOnConnect:            false,
    syncFullHistory:                false,
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid:                jid => isJidBroadcast(jid),
  });

  activeSockets.set(sessionId, sock);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ── QR EVENT ─────────────────────────────────────────────
    // EXACT METHOD from Issue #19907:
    // "Request pairing code when QR is available" — inside qr event
    if (qr) {
      // QR mode — show QR to user
      if (!phoneNumber) {
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

      // Pair code mode — request inside qr event (Issue #19907 exact method)
      if (phoneNumber && !sock.authState?.creds?.registered && !pairCodeSent.get(sessionId)) {
        pairCodeSent.set(sessionId, true);
        await _requestPairCode(sessionId, sock, phoneNumber, onPairCode);
      }
    }

    // ── DISCONNECTED ──────────────────────────────────────────
    if (connection === 'close') {
      await _handleDisconnect(
        sessionId, userId, authDir, lastDisconnect,
        onQR, onPairCode, onConnected, onDisconnected,
      );
    }

    // ── CONNECTED ─────────────────────────────────────────────
    if (connection === 'open') {
      await _handleConnected(sessionId, userId, sock, onConnected);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message) continue;
      await handleMessage(sock, msg, sessionId).catch(err =>
        logger.error(`[${sessionId}] msgHandler: ${err.message}`),
      );
    }
  });

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
      } catch (_) {}
    }
  });

  return sock;
}

async function _requestPairCode(sessionId, sock, rawPhone, onPairCode, attempt = 1) {
  const MAX_PAIR_ATTEMPTS = 3;
  try {
    await sleep(PAIR_CODE_DELAY_MS * attempt);

    const num = cleanPhone(rawPhone);

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
      pairCodeSent.delete(sessionId);
      pairCodeSent.set(sessionId, true);
      await _requestPairCode(sessionId, sock, rawPhone, onPairCode, attempt + 1);
    } else {
      logger.error(`[${sessionId}] Pair code failed after ${MAX_PAIR_ATTEMPTS} attempts.`);
      pairCodeSent.delete(sessionId);
      if (onPairCode) onPairCode(null, new Error('Pair code generation failed. Try again.'));
    }
  }
}

async function _handleConnected(sessionId, userId, sock, onConnected) {
  reconnectAttempts.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);

  const rawId     = sock.user?.id ?? '';
  const botNumber = rawId.split(':')[0].split('@')[0];

  if (!botNumber) {
    logger.error(`[${sessionId}] Connected but could not read bot number.`);
    return;
  }

  logger.info(`[${sessionId}] ✅ Connected as +${botNumber}`);
  registerBot(sessionId, sock, 'public');

  try {
    const existing = await getSession(sessionId);
    if (!existing) await createSession(sessionId, userId, botNumber);
    else           await updateSession(sessionId, { status: 'active', whatsappNumber: botNumber });
  } catch (err) {
    logger.error(`[${sessionId}] Firebase: ${err.message}`);
  }

  const selfJid   = `${botNumber}@s.whatsapp.net`;
  const linkedMsg =
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
  } catch (err) {
    logger.warn(`[${sessionId}] Could not send link notification: ${err.message}`);
  }

  if (onConnected) onConnected(sessionId, botNumber);
}

async function _handleDisconnect(
  sessionId, userId, authDir, lastDisconnect,
  onQR, onPairCode, onConnected, onDisconnected,
) {
  const statusCode = lastDisconnect?.error?.output?.statusCode;

  const FATAL_CODES = [
    DisconnectReason.loggedOut,
    DisconnectReason.badSession,
    DisconnectReason.forbidden,
    DisconnectReason.connectionReplaced,
  ];

  const shouldReconnect = !FATAL_CODES.includes(statusCode);

  logger.warn(`[${sessionId}] Disconnected — code: ${statusCode} | reconnect: ${shouldReconnect}`);

  removeBot(sessionId);
  activeSockets.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);

  await updateSession(sessionId, { status: 'inactive' }).catch(() => {});

  if (!shouldReconnect) {
    reconnectAttempts.delete(sessionId);
    try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
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

  const waitMs = Math.min(RECONNECT_BASE_MS * Math.pow(1.8, attempts - 1), RECONNECT_CAP_MS);
  logger.info(`[${sessionId}] Reconnecting in ${(waitMs/1000).toFixed(1)}s (attempt ${attempts}/${MAX_RECONNECT_ATTEMPTS})…`);

  setTimeout(
    () => startBot(sessionId, userId, onQR, onPairCode, onConnected, onDisconnected, null),
    waitMs,
  );
}

async function stopBot(sessionId) {
  const sock = activeSockets.get(sessionId);
  if (sock) {
    try { sock.end(undefined); } catch (_) {}
  }
  _cleanup(sessionId);
  await updateSession(sessionId, { status: 'inactive' }).catch(() => {});
  logger.info(`[${sessionId}] Bot stopped gracefully.`);
}

function _cleanup(sessionId) {
  removeBot(sessionId);
  activeSockets.delete(sessionId);
  reconnectAttempts.delete(sessionId);
  pairCodeSent.delete(sessionId);
  qrAttempts.delete(sessionId);
}

module.exports = { startBot, stopBot };
