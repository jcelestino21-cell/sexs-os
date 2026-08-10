// Autenticação sem dependências externas: hash de senha com scrypt (nativo do Node,
// não é texto puro, não é reversível) e tokens de sessão opacos, gerados por
// crypto.randomBytes e guardados (com hash) na tabela `sessions`.
// Nenhum administrador consegue ler a senha pessoal: só o hash+salt são armazenados.
const crypto = require('node:crypto');
const db = require('../db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(attempt, 'hex'), Buffer.from(hash, 'hex'));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(tokenHash, userId, expiresAt);
  return token;
}

function getUserBySessionToken(token) {
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(session.user_id);
}

/** Logout real: apaga a sessão no servidor, não só o token no navegador (Correção
 * Seção 14) — sem isto, um token roubado continuaria válido até expirar (12h). */
function invalidateSession(token) {
  if (!token) return;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user) return null;
  if (!user.password_hash) return { pendingFirstAccess: true }; // ainda não definiu senha própria
  if (!verifyPassword(password, user.password_hash, user.password_salt)) return null;
  const token = createSession(user.id);
  return { token, user: publicUser(user) };
}

function publicUser(user) {
  return { id: user.id, name: user.name, username: user.username, role: user.role, director_key: user.director_key, reseller_id: user.reseller_id };
}

const TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72h para primeiro acesso / recuperação

function issueAccessToken(userId, purpose) {
  const token = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  db.prepare('INSERT INTO access_tokens (token_hash, user_id, purpose, expires_at) VALUES (?,?,?,?)').run(
    tokenHash, userId, purpose, expiresAt
  );
  return token; // Em produção real isto seria enviado por e-mail/SMS; aqui só retornamos
  // o token puro no momento da criação — nenhum outro lugar do sistema volta a exibi-lo.
}

function consumeAccessToken(token, purpose) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare('SELECT * FROM access_tokens WHERE token_hash = ? AND purpose = ?').get(tokenHash, purpose);
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

function setPasswordViaToken(token, purpose, newPassword) {
  const row = consumeAccessToken(token, purpose);
  if (!row) throw new Error('Link inválido, já usado ou expirado. Peça um novo.');
  if (!newPassword || newPassword.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  const { hash, salt } = hashPassword(newPassword);
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, row.user_id);
    db.prepare(`UPDATE access_tokens SET used_at = datetime('now') WHERE token_hash = ?`).run(
      crypto.createHash('sha256').update(token).digest('hex')
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
}

module.exports = {
  hashPassword, verifyPassword, createSession, getUserBySessionToken, invalidateSession, login, publicUser,
  issueAccessToken, consumeAccessToken, setPasswordViaToken,
};
