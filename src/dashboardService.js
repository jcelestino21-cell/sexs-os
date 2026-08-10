// Painel consolidado — não é uma nova fonte de dados, só agrega o que os outros módulos
// já calculam corretamente (financeService, kitService, resellerService, produtos,
// propostas, auditoria). Isso evita duplicar regras de negócio no dashboard.
const db = require('../db');
const financeService = require('./financeService');
const resellerService = require('./resellerService');
const proposalService = require('./proposalService');
const kitService = require('./kitService');
const commercialService = require('./commercialService');

function todayActivity() {
  const row = db.prepare(`
    SELECT COUNT(*) as sales_count, COALESCE(SUM(quantity * unit_price_cents),0) as revenue_informed_cents
    FROM kit_sales WHERE date(created_at) = date('now') AND status = 'confirmada' AND status = 'confirmada'
  `).get();
  return { sales_today_count: row.sales_count, revenue_informed_today_cents: row.revenue_informed_cents };
}

function topProducts(limit = 3) {
  return db.prepare(`
    SELECT p.name, SUM(ks.quantity) as units_sold
    FROM kit_sales ks
    JOIN kit_items ki ON ki.id = ks.kit_item_id
    JOIN products p ON p.id = ki.product_id
    WHERE ks.status = 'confirmada'
    GROUP BY p.id ORDER BY units_sold DESC LIMIT ?
  `).all(limit);
}

function standoutReseller() {
  const ranking = kitService.rankingFull();
  const top = ranking.find((r) => r.total_cents > 0);
  return top ? { name: top.name, total_cents: top.total_cents } : null;
}

// FASE 10.5 — CORREÇÃO: lowStockProducts agora subtrai reservas ativas do saldo,
// consistente com /api/products que calcula available_balance = physical - reserved.
// Antes ignorava reservas, fazendo um produto com tudo reservado parecer "OK" no painel.
function lowStockProducts() {
  return db.prepare(`
    SELECT * FROM (
      SELECT p.id, p.name, p.low_stock_threshold,
             COALESCE((SELECT SUM(quantity) FROM stock_movements m WHERE m.product_id = p.id), 0)
             - COALESCE((SELECT SUM(quantity) FROM stock_reservations WHERE product_id = p.id AND status = 'ativa'), 0) as available_balance
      FROM products p
      WHERE p.active = 1
    ) t
    WHERE t.available_balance <= t.low_stock_threshold
    ORDER BY t.available_balance ASC
  `).all();
}

function kitsByStatus() {
  const rows = db.prepare('SELECT status, COUNT(*) as count FROM kits GROUP BY status').all();
  const map = {};
  for (const r of rows) map[r.status] = r.count;
  return map;
}

function recentAudit(limit = 8) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

function getDashboard() {
  const pendingProposals = proposalService.listProposals({ status: 'pendente' });
  const resellers = resellerService.listResellers();
  const financial = financeService.financialSummary();
  const perf = commercialService.performanceSnapshot();

  return {
    pending_proposals_count: pendingProposals.length,
    pending_proposals: pendingProposals.slice(0, 5),
    low_stock_products: lowStockProducts(),
    kits_by_status: kitsByStatus(),
    active_resellers: resellers.filter((r) => r.status === 'ativa').length,
    total_resellers: resellers.length,
    financial,
    recent_audit: recentAudit(),
    today: todayActivity(),
    top_products: topProducts(),
    standout_reseller: standoutReseller(),
    current_goal: perf.goal,
  };
}

module.exports = { getDashboard };
