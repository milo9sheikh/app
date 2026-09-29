'use strict';
const crypto = require('node:crypto');

const SESSION_MS = 1000 * 60 * 60 * 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_MS);
  return token;
}

function getSessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.name, u.email, u.role, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1`).get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

module.exports = { hashPassword, verifyPassword, createSession, getSessionUser, SESSION_MS };
