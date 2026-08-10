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
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-live-${counter}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, role: 'ceo' };
}
function seedRule(userId) {
  db.prepare(`INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by) VALUES (1, 3.0, 0.30, 1.3, 1, ?)`).run(userId);
}
async function buyStock(ceo, name, qty, costCents) {
  const result = await proposalService.handleDirectorMessage({ thread: 'diego', text: `Comprei ${qty} unidades do ${name} por R$ ${(costCents/100).toFixed(2)} cada, do fornecedor F.`, userId: ceo.id });
  proposalService.approveAndExecute(result.proposal.id, ceo);
  return db.prepare('SELECT * FROM products WHERE name = ?').get(name);
}
async function hire(ceo, name) {
  const result = await resellerService.handleMarinaMessage({ text: `Contratamos ${name}, telefone 11900000000, endereço Rua X, 1.`, userId: ceo.id });
  const executed = proposalService.approveAndExecute(result.proposal.id, ceo);
  return executed.execution_result.resellerId;
}

test('dashboard mostra vendas informadas hoje (atividade do dia, não só confirmadas)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Vivo A', 10, 1000);
  const resellerId = await hire(ceo, 'RevVivoA');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const before = dashboardService.getDashboard().today.sales_today_count;

  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 2, resellerUser: { id: ceo.id, role: 'revendedora', reseller_id: resellerId } });

  const after = dashboardService.getDashboard().today.sales_today_count;
  assert.equal(after, before + 1);
});

test('dashboard identifica produto mais vendido entre os confirmados', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Vivo Top', 10, 1000);
  const resellerId = await hire(ceo, 'RevVivoTop');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 8 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 6, resellerUser });
  kitService.requestClosure(kit.id, ceo);
  kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: delivered.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 6, quantity_returned: 2, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0 },
  });
  kitService.approveClosure(kit.id, ceo);

  const dash = dashboardService.getDashboard();
  assert.ok(dash.top_products.some((p) => p.name === 'Produto Vivo Top' && p.units_sold === 6));
});

test('dashboard aponta revendedora destaque com base em venda confirmada', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Vivo Destaque', 10, 1000);
  const resellerId = await hire(ceo, 'RevDestaque');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 5, resellerUser });
  kitService.requestClosure(kit.id, ceo);
  kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: delivered.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 5, quantity_returned: 0, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0 },
  });
  kitService.approveClosure(kit.id, ceo);

  const dash = dashboardService.getDashboard();
  assert.ok(dash.standout_reseller);
  assert.ok(dash.standout_reseller.total_cents > 0);
});
