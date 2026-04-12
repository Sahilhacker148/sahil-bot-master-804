const admin = require('firebase-admin');
const config = require('../config/config');

// ─── FIREBASE INIT ────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey:  config.firebase.privateKey,
    }),
    databaseURL: config.firebase.databaseURL,
  });
}

const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

// ─── USERS ───────────────────────────────────────────────
async function createUser(uid, data) {
  await db.collection('users').doc(uid).set({
    name:        data.name,
    email:       data.email,
    whatsapp:    data.whatsapp,
    password:    data.password,
    status:      'pending',
    plan:        'free',
    planExpiry:  null,
    botsCreated: 0,
    botsAllowed: 0,
    createdAt:   Timestamp.now(),
    lastLogin:   null,
    ip:          data.ip || null,
  });
}

async function getUserById(uid) {
  const doc = await db.collection('users').doc(uid).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function getUserByEmail(email) {
  const snap = await db.collection('users')
    .where('email', '==', email.toLowerCase().trim())
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getAllUsers() {
  const snap = await db.collection('users').orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function updateUser(uid, data) {
  await db.collection('users').doc(uid).update({ ...data, updatedAt: Timestamp.now() });
}

async function deleteUser(uid) {
  // BUG FIX: delete in parallel to be faster; catch each independently
  await Promise.allSettled([
    db.collection('subscriptions').doc(uid).delete(),
    db.collection('users').doc(uid).delete(),
  ]);
}

async function approveUser(uid) {
  await db.collection('users').doc(uid).update({
    status:     'approved',
    approvedAt: Timestamp.now(),
  });
}

async function rejectUser(uid) {
  await db.collection('users').doc(uid).update({
    status:     'rejected',
    rejectedAt: Timestamp.now(),
  });
}

// ─── SUBSCRIPTIONS ───────────────────────────────────────
async function assignSubscription(uid, plan) {
  const days        = plan === 'yearly' ? 365 : 30;
  const botsAllowed = plan === 'yearly' ? 999 : 10;
  const expiry      = new Date();
  expiry.setDate(expiry.getDate() + days);

  const subData = {
    uid,
    plan,
    startDate:     Timestamp.now(),
    expiry:        Timestamp.fromDate(expiry),
    botsAllowed,
    botsUsed:      0,
    paymentStatus: 'confirmed',
    activatedBy:   'admin',
    activatedAt:   Timestamp.now(),
  };

  const batch = db.batch();
  batch.set(db.collection('subscriptions').doc(uid), subData);
  batch.update(db.collection('users').doc(uid), {
    plan,
    planExpiry:  Timestamp.fromDate(expiry),
    botsAllowed,
    status:      'approved',
    updatedAt:   Timestamp.now(),
  });
  await batch.commit();
}

async function revokeSubscription(uid) {
  const batch = db.batch();
  batch.delete(db.collection('subscriptions').doc(uid));
  batch.update(db.collection('users').doc(uid), {
    plan:        'free',
    planExpiry:  null,
    botsAllowed: 0,
    updatedAt:   Timestamp.now(),
  });
  await batch.commit();
}

async function getSubscription(uid) {
  const doc = await db.collection('subscriptions').doc(uid).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function getAllSubscriptions() {
  const snap = await db.collection('subscriptions').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function isSubscriptionActive(uid) {
  const sub = await getSubscription(uid);
  if (!sub) return false;
  const expiry = sub.expiry?.toDate?.() || new Date(0);
  return expiry > new Date();
}

// ─── SESSIONS ────────────────────────────────────────────
async function createSession(sessionId, userId, whatsappNumber) {
  const batch = db.batch();
  batch.set(db.collection('sessions').doc(sessionId), {
    userId,
    sessionId,
    whatsappNumber,
    status:       'active',
    mode:         'public',
    createdAt:    Timestamp.now(),
    lastActive:   Timestamp.now(),
    plan:         'free',
    messageCount: 0,
  });
  batch.update(db.collection('users').doc(userId), {
    botsCreated: FieldValue.increment(1),
  });
  await batch.commit();
}

async function getSession(sessionId) {
  const doc = await db.collection('sessions').doc(sessionId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function getSessionsByUser(userId) {
  const snap = await db.collection('sessions')
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getAllSessions() {
  const snap = await db.collection('sessions').orderBy('createdAt', 'desc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function updateSession(sessionId, data) {
  await db.collection('sessions').doc(sessionId).update({ ...data, lastActive: Timestamp.now() });
}

async function deleteSession(sessionId) {
  const session = await getSession(sessionId);
  const batch   = db.batch();
  // BUG FIX: guard against negative botsCreated counter
  if (session && session.userId) {
    const userRef = db.collection('users').doc(session.userId);
    const userDoc = await userRef.get();
    if (userDoc.exists && (userDoc.data().botsCreated || 0) > 0) {
      batch.update(userRef, { botsCreated: FieldValue.increment(-1) });
    }
  }
  batch.delete(db.collection('sessions').doc(sessionId));
  await batch.commit();
}

async function setSessionMode(sessionId, mode) {
  await db.collection('sessions').doc(sessionId).update({ mode, lastActive: Timestamp.now() });
}

// ─── SETTINGS ────────────────────────────────────────────
async function getPaymentSettings() {
  const doc = await db.collection('settings').doc('payment').get();
  return doc.exists ? doc.data() : {
    jazzcash:     '03496049312',
    easypaisa:    '03496049312',
    monthlyPrice: '500',
    yearlyPrice:  '4000',
    currency:     'PKR',
    instructions: 'Send payment screenshot to WhatsApp after paying.',
  };
}

async function updatePaymentSettings(data) {
  await db.collection('settings').doc('payment').set(data, { merge: true });
}

// ─── ANNOUNCEMENTS ────────────────────────────────────────
async function createAnnouncement(title, message, adminEmail) {
  const ref = db.collection('announcements').doc();
  await ref.set({
    id:        ref.id,
    title,
    message,
    createdBy: adminEmail,
    createdAt: Timestamp.now(),
    active:    true,
  });
  return ref.id;
}

async function getActiveAnnouncement() {
  const snap = await db.collection('announcements')
    .where('active', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

// BUG FIX: added deactivateAnnouncement — previously missing, needed by admin panel
async function deactivateAnnouncement(id) {
  await db.collection('announcements').doc(id).update({ active: false });
}

module.exports = {
  db, admin, FieldValue, Timestamp,
  createUser, getUserById, getUserByEmail, getAllUsers, updateUser, deleteUser, approveUser, rejectUser,
  assignSubscription, revokeSubscription, getSubscription, getAllSubscriptions, isSubscriptionActive,
  createSession, getSession, getSessionsByUser, getAllSessions, updateSession, deleteSession, setSessionMode,
  getPaymentSettings, updatePaymentSettings,
  createAnnouncement, getActiveAnnouncement, deactivateAnnouncement,
};
