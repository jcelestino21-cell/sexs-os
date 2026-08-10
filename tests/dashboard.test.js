process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
require('../src/stockIntents');
const proposalService = require('../src/proposalService');
const resellerService = require('../src/resellerService');
const kitService = require('../src/kitService');
const dashboardService = require('../src/dashboardService');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db
    .prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-dash-${counter}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, role: 'ceo' };
}

function seedRule(userId) {
  db.prepare(
    `INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by)
     VALUES (1, 3.0, 0.30, 1.3, 1, ?)`
  ).run(userId);
}

test('dashboard alerta produto com estoque baixo', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  db.prepare('INSERT INTO products (name, low_stock_threshold) VALUES (?, ?)').run('Produto Baixo', 10);
  const product = db.prepare('SELECT * FROM products WHERE name = ?').get('Produto Baixo');
  db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?, 'entrada', 3, 3, 'seed', ?)`)
    .run(product.id, ceo.id);

  const dash = dashboardService.getDashboard();
  assert.ok(dash.low_stock_products.some((p) => p.name === 'Produto Baixo'));
});

test('dashboard não alerta produto com estoque suficiente', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  db.prepare('INSERT INTO products (name, low_stock_threshold) VALUES (?, ?)').run('Produto Alto', 5);
  const product = db.prepare('SELECT * FROM products WHERE name = ?').get('Produto Alto');
  db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?, 'entrada', 50, 50, 'seed', ?)`)
    .run(product.id, ceo.id);

  const dash = dashboardService.getDashboard();
  assert.ok(!dash.low_stock_products.some((p) => p.name === 'Produto Alto'));
});

test('dashboard conta propostas pendentes corretamente', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  await proposalService.handleDirectorMessage({ thread: 'diego', text: 'Comprei 5 unidades do Item Dash por R$ 2 cada, do fornecedor D.', userId: ceo.id });
  const dash = dashboardService.getDashboard();
  assert.ok(dash.pending_proposals_count >= 1);
});

test('dashboard agrega kits por status', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  db.prepare('INSERT INTO products (name) VALUES (?)').run('Produto Kit Dash');
  const product = db.prepare('SELECT * FROM products WHERE name = ?').get('Produto Kit Dash');
  db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('Fornecedor Dash');
  const supplier = db.prepare('SELECT * FROM suppliers WHERE name = ?').get('Fornecedor Dash');
  db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
    .run(product.id, supplier.id, 20, 1000, ceo.id);
  db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?, 'entrada', 20, 20, 'seed', ?)`)
    .run(product.id, ceo.id);

  const hire = await resellerService.handleMarinaMessage({ text: 'Contratamos Dashboarda, telefone 11900000000, endereço Rua D, 1.', userId: ceo.id });
  const executed = proposalService.approveAndExecute(hire.proposal.id, ceo);

  kitService.suggestKit({ resellerId: executed.execution_result.resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });

  const dash = dashboardService.getDashboard();
  assert.ok(dash.kits_by_status.sugerido >= 1);
  assert.ok(dash.total_resellers >= 1);
});
