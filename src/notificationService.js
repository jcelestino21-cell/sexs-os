// Notificações — criadas no momento em que o evento acontece (não por um agendador
// varrendo o banco), o que evita duplicação por reprocessamento. A restrição UNIQUE
// no schema é a segunda linha de defesa: mesmo que este código seja chamado duas
// vezes para o mesmo evento, só uma notificação existe.
const db = require('../db');

function notify({ recipientRole = 'ceo', type, message, entityType, entityId }) {
  try {
    const info = db.prepare(
      'INSERT INTO notifications (recipient_role, type, message, entity_type, entity_id) VALUES (?,?,?,?,?)'
    ).run(recipientRole, type, message, entityType || null, entityId || null);
    return db.prepare('SELECT * FROM notifications WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return null; // já existia — não duplica, silenciosamente
    throw e;
  }
}

function listForRole(role, { unreadOnly = false } = {}) {
  const sql = unreadOnly
    ? 'SELECT * FROM notifications WHERE recipient_role = ? AND read_at IS NULL ORDER BY id DESC'
    : 'SELECT * FROM notifications WHERE recipient_role = ? ORDER BY id DESC LIMIT 50';
  return db.prepare(sql).all(role);
}

function markRead(id) {
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL`).run(id);
}

function markAllRead(role) {
  db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE recipient_role = ? AND read_at IS NULL`).run(role);
}

module.exports = { notify, listForRole, markRead, markAllRead };
