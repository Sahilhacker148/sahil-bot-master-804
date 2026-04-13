require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const helmet   = require('helmet');
const rateLimit = require('express-rate-limit');
const path     = require('path');
const { WebSocketServer } = require('ws');
const http     = require('http');
const QRCode   = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const config = require('../src/config/config');
const { logger, generateSessionId, validateSessionId, getAllActiveBots } = require('../src/utils/helpers');
const {
  hashPassword, comparePassword,
  isAuth, isAdmin, isPaid,
  isStrongPassword, isValidEmail, isValidWhatsApp,
} = require('../src/middleware/auth');
const {
  createUser, getUserByEmail, getUserById, getAllUsers,
  updateUser, deleteUser, approveUser, rejectUser,
  assignSubscription, revokeSubscription, getSubscription,
  getAllSubscriptions, isSubscriptionActive,
  createSession, getSession, getSessionsByUser, getAllSessions,
  updateSession, deleteSession, setSessionMode,
  getPaymentSettings, updatePaymentSettings,
  getActiveAnnouncement, createAnnouncement, deactivateAnnouncement,
} = require('../src/firebase/config');
const { startBot, stopBot } = require('../src/bot/launcher');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── SECURITY MIDDLEWARE ──────────────────────────────────
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret:           config.sessionSecret,
  resave:           config.session.resave,
  saveUninitialized: config.session.saveUninitialized,
  cookie:           config.session.cookie,
}));

// ─── RATE LIMITERS ────────────────────────────────────────
const generalLimiter = rateLimit(config.rateLimit.general);
const pairLimiter    = rateLimit(config.rateLimit.pairing);
const authLimiter    = rateLimit(config.rateLimit.auth);

app.use('/api/', generalLimiter);
app.use('/api/bot/start-qr',   pairLimiter);
app.use('/api/bot/start-pair', pairLimiter);
app.use('/api/auth/login',     authLimiter);
app.use('/api/auth/register',  authLimiter);

// ─── REQUEST LOGGER ───────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    logger.debug(`${req.method} ${req.path} — ip: ${req.ip}`);
  }
  next();
});

// ─── QR WEBSOCKET ──────────────────────────────────────────
const qrClients      = new Map();
const pendingWsMsgs  = new Map();

wss.on('connection', (ws, req) => {
  const sid = new URL(req.url, 'http://x').searchParams.get('sessionId');
  if (sid) {
    qrClients.set(sid, ws);
    const buffered = pendingWsMsgs.get(sid) || [];
    buffered.forEach(msg => {
      try { ws.send(JSON.stringify(msg)); } catch (_) {}
    });
    pendingWsMsgs.delete(sid);
  }
  ws.on('close', () => { if (sid) qrClients.delete(sid); });
  ws.on('error', () => { if (sid) qrClients.delete(sid); });
});

function wsSend(sessionId, data) {
  const ws = qrClients.get(sessionId);
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  } else {
    if (!pendingWsMsgs.has(sessionId)) pendingWsMsgs.set(sessionId, []);
    pendingWsMsgs.get(sessionId).push(data);
    setTimeout(() => pendingWsMsgs.delete(sessionId), 120_000);
  }
}

// ─── AUTH ROUTES ──────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, whatsapp, password } = req.body;
    if (!name || !email || !whatsapp || !password)
      return res.status(400).json({ error: 'All fields are required.' });
    if (name.trim().length < 2)
      return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    if (!isValidEmail(email))
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!isValidWhatsApp(whatsapp))
      return res.status(400).json({ error: 'Please enter a valid WhatsApp number (10-15 digits).' });
    if (!isStrongPassword(password))
      return res.status(400).json({ error: 'Password must be at least 8 characters and contain letters and numbers.' });

    const normalizedEmail = email.toLowerCase().trim();
    const existing        = await getUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: 'This email is already registered.' });

    const hashed = await hashPassword(password);
    const uid    = uuidv4();
    await createUser(uid, { name: name.trim(), email: normalizedEmail, whatsapp, password: hashed, ip: req.ip });
    res.json({ success: true, message: 'Account created! Waiting for admin approval.' });
  } catch (err) {
    logger.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const user = await getUserByEmail(email.toLowerCase().trim());
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.status === 'pending')  return res.status(403).json({ error: 'Your account is pending admin approval.' });
    if (user.status === 'rejected') return res.status(403).json({ error: 'Your account has been rejected. Contact support.' });

    const valid = await comparePassword(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password.' });

    await updateUser(user.id, { lastLogin: new Date().toISOString() });
    req.session.userId    = user.id;
    req.session.userEmail = user.email;
    res.json({ success: true, redirect: '/dashboard.html' });
  } catch (err) {
    logger.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    if (email === config.admin.email && password === config.admin.password) {
      req.session.isAdmin = true;
      req.session.userId  = 'admin';
      return res.json({ success: true, redirect: '/admin.html' });
    }
    res.status(401).json({ error: 'Invalid admin credentials.' });
  } catch (err) {
    logger.error('Admin login error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/me', isAuth, async (req, res) => {
  try {
    if (req.session.isAdmin) return res.json({ isAdmin: true, email: config.admin.email });
    const user = await getUserById(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user.' });
  }
});

// ─── USER ROUTES ──────────────────────────────────────────
app.get('/api/user/subscription', isAuth, async (req, res) => {
  try {
    const sub    = await getSubscription(req.session.userId);
    const active = sub ? await isSubscriptionActive(req.session.userId) : false;
    res.json({ subscription: sub, active });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch subscription.' });
  }
});

app.get("/api/user/status", async (req, res) => {
  if (!req.session.userId) return res.json({ success: false, error: "Not logged in." });
  try {
    const user = await getUserById(req.session.userId);
    if (!user) return res.json({ success: false, error: "User not found." });
    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error." });
  }
});

app.get('/api/user/bots', isAuth, async (req, res) => {
  try {
    const sessions  = await getSessionsByUser(req.session.userId);
    const liveBots  = getAllActiveBots();
    const enriched  = sessions.map(s => ({
      ...s,
      isLive: liveBots.some(b => b.sessionId === s.sessionId),
    }));
    res.json({ bots: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bots.' });
  }
});

app.get('/api/announcement', async (req, res) => {
  try {
    const ann = await getActiveAnnouncement();
    res.json({ announcement: ann });
  } catch (err) {
    res.json({ announcement: null });
  }
});

// ─── BOT ROUTES ───────────────────────────────────────────────
// Helper: Initialize Session in DB then Start Bot
async function initAndStartBot(sessionId, userId, phoneNumber = null) {
  // BUG FIX: createSession(sessionId, userId, whatsappNumber) — 3rd arg must be
  // a string (whatsappNumber), NOT an object. Passing an object crashed Firestore
  // batch silently, causing startBot() to never be called → no QR/pair code ever.
  // We pass null here (number not known yet), launcher updates it on connect.
  await createSession(sessionId, userId, phoneNumber || null);

  // 2. Start Bot
  startBot(
    sessionId, 
    userId,
    async (qr) => {
      const qrImage = await QRCode.toDataURL(qr);
      wsSend(sessionId, { type: 'qr', qr: qrImage, sessionId });
    },
    (code) => {
      wsSend(sessionId, { type: 'pairCode', code, sessionId });
    },
    async (sid, number) => {
      wsSend(sid, { type: 'connected', sessionId: sid, number });
      await updateSession(sid, { status: 'active', number: number });
    },
    async (sid) => {
      wsSend(sid, { type: 'disconnected', sessionId: sid });
      await updateSession(sid, { status: 'inactive' });
    },
    phoneNumber
  ).catch(err => logger.error('Bot start error:', err.message));
}

app.post('/api/bot/start-qr', isAuth, isPaid, async (req, res) => {
  try {
    const sessionId = generateSessionId();
    // BUG FIX: same as start-pair — send response before fire-and-forget
    res.json({ success: true, sessionId });

    initAndStartBot(sessionId, req.session.userId).catch(err => {
      logger.error('start-qr initAndStartBot error:', err.message);
      wsSend(sessionId, { type: 'error', message: 'Failed to initialize bot. Please try again.' });
    });

  } catch (err) {
    logger.error('start-qr error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start bot.' });
    }
  }
});

app.post('/api/bot/start-pair', isAuth, isPaid, async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });
    
    const cleanNum = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanNum.length < 10) return res.status(400).json({ error: 'Invalid phone number.' });

    const sessionId = generateSessionId();
    
    // BUG FIX: Send response FIRST, then start bot fire-and-forget
    // Previously: res.json() + await initAndStartBot() in same try block
    // Problem: if initAndStartBot threw, catch block tried to res.status(500) on already-sent headers
    res.json({ success: true, sessionId });

    // Fire-and-forget: errors sent to client via WebSocket, not HTTP
    initAndStartBot(sessionId, req.session.userId, cleanNum).catch(err => {
      logger.error('start-pair initAndStartBot error:', err.message);
      wsSend(sessionId, { type: 'error', message: 'Failed to initialize bot. Please try again.' });
    });

  } catch (err) {
    logger.error('start-pair error:', err.message);
    // Only send HTTP error if response not yet sent
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start pairing.' });
    }
  }
});

app.post('/api/bot/deploy', isAuth, isPaid, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!validateSessionId(sessionId)) return res.status(400).json({ error: 'Invalid Session ID format.' });
    
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found. Please generate QR or pair code first.' });
    if (sess.userId !== req.session.userId) return res.status(403).json({ error: 'Unauthorized.' });
    
    res.json({ success: true, message: 'Bot is deploying!', sessionId });
  } catch (err) {
    logger.error('deploy error:', err.message);
    res.status(500).json({ error: 'Deployment failed.' });
  }
});

app.post('/api/bot/stop', isAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    
    await stopBot(sessionId);
    await updateSession(sessionId, { status: 'inactive' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to stop bot.' });
  }
});

app.delete('/api/bot/:sessionId', isAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    
    await stopBot(sessionId);
    await deleteSession(sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete bot.' });
  }
});

// ─── BOT MODE TOGGLE ──────────────────────────────────────
app.post('/api/bot/mode', isAuth, async (req, res) => {
  try {
    const { sessionId, mode } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    if (!['public', 'private'].includes(mode))
      return res.status(400).json({ error: 'Mode must be "public" or "private".' });
    
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    
    await setSessionMode(sessionId, mode);
    res.json({ success: true, mode });
  } catch (err) {
    logger.error('bot/mode error:', err.message);
    res.status(500).json({ error: 'Failed to update bot mode.' });
  }
});

// ─── BOT RESTART ──────────────────────────────────────────
app.post('/api/bot/restart', isAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    
    const sess = await getSession(sessionId);
    if (!sess) return res.status(404).json({ error: 'Session not found.' });
    if (sess.userId !== req.session.userId && !req.session.isAdmin)
      return res.status(403).json({ error: 'Unauthorized.' });
    
    await stopBot(sessionId);
    res.json({ success: true, message: 'Bot is restarting...' });

    // BUG FIX: fire-and-forget — response already sent above
    setTimeout(async () => {
      initAndStartBot(sessionId, sess.userId, sess.phoneNumber).catch(err => {
        logger.error(`restart initAndStartBot [${sessionId}]:`, err.message);
      });
    }, 2000);

  } catch (err) {
    logger.error('bot/restart error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to restart bot.' });
    }
  }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────
app.get('/api/admin/stats', isAdmin, async (req, res) => {
  try {
    const [users, sessions, subs] = await Promise.all([getAllUsers(), getAllSessions(), getAllSubscriptions()]);
    const liveBots = getAllActiveBots();
    res.json({
      totalUsers:         users.length,
      approvedUsers:      users.filter(u => u.status === 'approved').length,
      pendingApprovals:   users.filter(u => u.status === 'pending').length,
      rejectedUsers:      users.filter(u => u.status === 'rejected').length,
      totalSessions:      sessions.length,
      activeSessions:     sessions.filter(s => s.status === 'active').length,
      liveBots:           liveBots.length,
      monthlySubscribers: subs.filter(s => s.plan === 'monthly').length,
      yearlySubscribers:  subs.filter(s => s.plan === 'yearly').length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users: users.map(({ password: _, ...u }) => u) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

app.post('/api/admin/users/:uid/approve', isAdmin, async (req, res) => {
  try { await approveUser(req.params.uid); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed to approve user.' }); }
});

app.post('/api/admin/users/:uid/reject', isAdmin, async (req, res) => {
  try { await rejectUser(req.params.uid); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed to reject user.' }); }
});

app.delete('/api/admin/users/:uid', isAdmin, async (req, res) => {
  try { await deleteUser(req.params.uid); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed to delete user.' }); }
});

app.post('/api/admin/subscriptions/:uid', isAdmin, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!['monthly', 'yearly'].includes(plan))
      return res.status(400).json({ error: 'Invalid plan. Use: monthly or yearly' });
    await assignSubscription(req.params.uid, plan);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to assign subscription.' }); }
});

app.delete('/api/admin/subscriptions/:uid', isAdmin, async (req, res) => {
  try { await revokeSubscription(req.params.uid); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed to revoke subscription.' }); }
});

app.get('/api/admin/sessions', isAdmin, async (req, res) => {
  try {
    const sessions = await getAllSessions();
    const liveBots = getAllActiveBots();
    const enriched = sessions.map(s => ({
      ...s,
      isLive: liveBots.some(b => b.sessionId === s.sessionId),
    }));
    res.json({ sessions: enriched });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch sessions.' }); }
});

app.delete('/api/admin/sessions/:sessionId', isAdmin, async (req, res) => {
  try {
    await stopBot(req.params.sessionId);
    await deleteSession(req.params.sessionId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Failed to delete session.' }); }
});

app.get('/api/admin/payment-settings', isAdmin, async (req, res) => {
  try { res.json(await getPaymentSettings()); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch payment settings.' }); }
});

app.post('/api/admin/payment-settings', isAdmin, async (req, res) => {
  try { await updatePaymentSettings(req.body); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: 'Failed to update payment settings.' }); }
});

app.get('/api/admin/live-bots', isAdmin, (req, res) => {
  res.json({ bots: getAllActiveBots() });
});

app.post('/api/admin/announcements', isAdmin, async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
    const id = await createAnnouncement(title, message, config.admin.email);
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create announcement.' });
  }
});

app.delete('/api/admin/announcements/:id', isAdmin, async (req, res) => {
  try {
    await deactivateAnnouncement(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate announcement.' });
  }
});

// ─── PUBLIC ROUTES ────────────────────────────────────────
app.get('/api/payment-info', async (req, res) => {
  try {
    const s = await getPaymentSettings();
    res.json({
      jazzcash:     s.jazzcash,
      easypaisa:    s.easypaisa,
      monthlyPrice: s.monthlyPrice,
      yearlyPrice:  s.yearlyPrice,
      currency:     s.currency,
      instructions: s.instructions,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch payment info.' }); }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status:    'ok',
  bot:       config.bot.name,
  version:   config.bot.version,
  uptime:    process.uptime(),
  memory:    process.memoryUsage(),
  liveBots:  getAllActiveBots().length,
  timestamp: new Date().toISOString(),
}));

// ─── 404 HANDLER ──────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Express error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── START SERVER (FIXED FOR RAILWAY/RENDER) ───────────────────
// FIX: Use process.env.PORT first to fix "Service Unavailable" error
const PORT = process.env.PORT || config.port || 3000;

server.listen(PORT, '0.0.0.0', () => {
  logger.success(`╔══════════════════════════════╗`);
  logger.success(`║  🤖 SAHIL 804 BOT SERVER     ║`);
  logger.success(`║  🌐 Port: ${PORT}               ║`);
  logger.success(`║  👑 Sahil Hacker 804          ║`);
  logger.success(`╚══════════════════════════════╝`);
});

// ─── GRACEFUL SHUTDOWN ────────────────────────────────────
process.on('SIGTERM', () => {
  logger.warn('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    logger.info('HTTP server closed.');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection:', reason);
});

module.exports = app;
