// Pedidos da revendedora (alimentam demanda futura, sem expor uma revendedora à
// outra) e dicas rápidas do portal (nunca cursos longos — decisão já consolidada).
const db = require('../db');
const { logAudit } = require('./audit');

function createOrder({ resellerId, productId, quantity, note }) {
  const info = db
    .prepare('INSERT INTO reseller_orders (reseller_id, product_id, quantity_requested, note) VALUES (?,?,?,?)')
    .run(resellerId, productId, quantity, note || null);
  logAudit({ actorLabel: 'Revendedora', action: 'order.created', entityType: 'reseller_order', entityId: info.lastInsertRowid, details: { reseller_id: resellerId, product_id: productId, quantity } });
  return db.prepare('SELECT * FROM reseller_orders WHERE id = ?').get(info.lastInsertRowid);
}

function listOrdersForReseller(resellerId) {
  return db.prepare(`
    SELECT o.*, p.name as product_name FROM reseller_orders o
    JOIN products p ON p.id = o.product_id
    WHERE o.reseller_id = ? ORDER BY o.id DESC
  `).all(resellerId);
}

function consolidatedDemand() {
  return db.prepare(`
    SELECT p.id as product_id, p.name as product_name, SUM(o.quantity_requested) as total_requested, COUNT(DISTINCT o.reseller_id) as resellers_count
    FROM reseller_orders o JOIN products p ON p.id = o.product_id
    WHERE o.status = 'pendente'
    GROUP BY p.id ORDER BY total_requested DESC
  `).all();
}

function markOrdersFulfilled(resellerId, productId) {
  db.prepare(`UPDATE reseller_orders SET status = 'atendido' WHERE reseller_id = ? AND product_id = ? AND status = 'pendente'`).run(resellerId, productId);
}

function listActiveTips() {
  return db.prepare('SELECT * FROM tips WHERE active = 1 ORDER BY id DESC').all();
}

function createTip(text, actorUser) {
  if (!text || text.trim().length === 0) throw new Error('A dica não pode ser vazia.');
  if (text.length > 280) throw new Error('Dica muito longa — mantenha leitura de até ~1 minuto (máx. 280 caracteres).');
  const info = db.prepare('INSERT INTO tips (text, created_by) VALUES (?,?)').run(text.trim(), actorUser.id);
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.name || 'Marina', action: 'tip.created', entityType: 'tip', entityId: info.lastInsertRowid });
  return db.prepare('SELECT * FROM tips WHERE id = ?').get(info.lastInsertRowid);
}

function deactivateTip(id, actorUser) {
  db.prepare('UPDATE tips SET active = 0 WHERE id = ?').run(id);
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.name || 'Marina', action: 'tip.deactivated', entityType: 'tip', entityId: id });
}

module.exports = {
  createOrder, listOrdersForReseller, consolidatedDemand, markOrdersFulfilled,
  listActiveTips, createTip, deactivateTip,
};
