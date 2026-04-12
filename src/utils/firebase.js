// ============================================
// Firebase Integration - Users, Subscriptions, Islamic Content
// Developer: Sahil Hacker
// ============================================
const admin  = require('firebase-admin');
const config = require('../config/config');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   config.firebase.projectId,
      privateKey:  config.firebase.privateKey,
      clientEmail: config.firebase.clientEmail,
    }),
    databaseURL: config.firebase.databaseURL,
  });
}

const db = admin.database();

// ─── User management ─────────────────────────────────────
async function createUser(userId, email, phone, passwordHash) {
  const userRef = db.ref(`users/${userId}`);
  await userRef.set({
    email,
    phone,
    passwordHash,
    approved:  false,
    createdAt: Date.now(),
    subscription: { plan: 'none', expiresAt: 0, botsUsed: 0 },
  });
  return true;
}

async function getUser(userId) {
  const snapshot = await db.ref(`users/${userId}`).once('value');
  return snapshot.val();
}

async function approveUser(userId) {
  await db.ref(`users/${userId}/approved`).set(true);
}

async function getAllUsers() {
  const snapshot = await db.ref('users').once('value');
  return snapshot.val() || {};
}

async function setSubscription(userId, plan, expiresAt) {
  await db.ref(`users/${userId}/subscription`).set({
    plan,
    expiresAt,
    botsUsed: 0,
  });
}

async function incrementBotCount(userId) {
  const ref      = db.ref(`users/${userId}/subscription/botsUsed`);
  const snapshot = await ref.once('value');
  const current  = snapshot.val() || 0;
  await ref.set(current + 1);
}

// ─── Islamic content ──────────────────────────────────────
async function getIslamicContent(type, id) {
  const snapshot = await db.ref(`islamic/${type}/${id}`).once('value');
  return snapshot.val();
}

async function getAllQuran() {
  const snapshot = await db.ref('islamic/quran').once('value');
  return snapshot.val() || {};
}

async function getDuas() {
  const snapshot = await db.ref('islamic/duas').once('value');
  return snapshot.val() || {};
}

// ─── User websites ────────────────────────────────────────
async function createWebsite(userId, data) {
  const websiteId = Date.now().toString();
  await db.ref(`websites/${websiteId}`).set({
    userId,
    ...data,
    createdAt: Date.now(),
  });
  return websiteId;
}

async function getUserWebsites(userId) {
  const snapshot = await db.ref('websites').orderByChild('userId').equalTo(userId).once('value');
  return snapshot.val() || {};
}

// ─── Admin settings (owner picture) ──────────────────────
async function getAdminSettings() {
  const snapshot = await db.ref('admin/settings').once('value');
  return snapshot.val() || { ownerImage: config.owner.image };
}

async function updateOwnerImage(imageUrl) {
  await db.ref('admin/settings/ownerImage').set(imageUrl);
  config.owner.image = imageUrl;
}

module.exports = {
  createUser,
  getUser,
  approveUser,
  getAllUsers,
  setSubscription,
  incrementBotCount,
  getIslamicContent,
  getAllQuran,
  getDuas,
  createWebsite,
  getUserWebsites,
  getAdminSettings,
  updateOwnerImage,
};
