process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
require('../src/stockIntents');
const resellerService = require('../src/resellerService');
const proposalService = require('../src/proposalService');
const kitService = require('../src/kitService');

function reconcileSimple(kitId, ceo) {
  const kit = kitService.getKit(kitId);
  for (const item of kit.items) {
    kitService.saveReconciliationItem({
      kitId, kitItemId: item.id, ceoUser: ceo,
      values: {
        quantity_sold_confirmed: item.quantity_confirmed_sold + item.quantity_pending_closure,
        quantity_returned: item.quantity_available,
        quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0,
      },
    });
  }
}

let counter = 0;
function makeUser(role, extra = {}) {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db
    .prepare('INSERT INTO users (name, username, role, password_hash, password_salt, reseller_id, director_key) VALUES (?,?,?,?,?,?,?)')
    .run(extra.name || `User${counter}`, `user-${counter}`, role, hash, salt, extra.reseller_id || null, extra.director_key || null);
  return { id: info.lastInsertRowid, role, reseller_id: extra.reseller_id || null };
}

function seedRule(userId) {
  db.prepare(
    `INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by)
     VALUES (1, 3.0, 0.30, 1.3, 1, ?)`
  ).run(userId);
}

function buyStock(ceo, productName, quantity, unitCostCents) {
  db.prepare('INSERT INTO products (name) VALUES (?)').run(productName);
  const product = db.prepare('SELECT * FROM products WHERE name = ?').get(productName);
  const supplierName = `Fornecedor ${productName}`;
  db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(supplierName);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE name = ?').get(supplierName);
  db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
    .run(product.id, supplier.id, quantity, unitCostCents, ceo.id);
  db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?, 'entrada', ?, ?, 'seed', ?)`)
    .run(product.id, quantity, quantity, ceo.id);
  return product;
}

async function hireReseller(ceo, name) {
  const result = await resellerService.handleMarinaMessage({
    text: `Contratamos ${name}, telefone 11900000000, endereço Rua Teste, 1.`,
    userId: ceo.id,
  });
  const executed = proposalService.approveAndExecute(result.proposal.id, ceo);
  const { resellerId, username } = executed.execution_result;
  const resellerUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return { resellerId, resellerUser: { id: resellerUser.id, role: 'revendedora', reseller_id: resellerId } };
}

test('fluxo completo de kit consignado: sugestão -> aprovação -> entrega -> venda -> fechamento', async () => {
  const ceo = makeUser('ceo');
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Kit A', 20, 3000); // custo R$30

  const { resellerId, resellerUser } = await hireReseller(ceo, 'Fulana');

  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 10 }], userId: ceo.id });
  assert.equal(kit.status, 'sugerido');
  assert.equal(kit.items[0].unit_sale_price_cents, 9000); // custo x3

  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  assert.equal(delivered.status, 'entregue');

  const balanceAfterDelivery = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(product.id);
  assert.equal(balanceAfterDelivery.bal, 10); // 20 - 10 entregues

  const sale = kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 4, resellerUser });
  assert.equal(sale.status, 'informada');

  kitService.requestClosure(kit.id, ceo);
  reconcileSimple(kit.id, ceo);
  const { kit: closedKit, closure } = kitService.approveClosure(kit.id, ceo);

  assert.equal(closedKit.status, 'encerrado');
  assert.equal(closure.total_sold_confirmed_cents, 4 * 9000);
  assert.equal(closure.total_commission_cents, Math.round(4 * 9000 * 0.3));
  assert.equal(closure.items_returned_to_stock, 6); // 10 entregues - 4 vendidas

  const finalBalance = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(product.id);
  assert.equal(finalBalance.bal, 16); // 10 restantes + 6 devolvidos
});

test('kit com múltiplos produtos (checklist item 12): cada item reserva e entrega independentemente', async () => {
  const ceo = makeUser('ceo');
  seedRule(ceo.id);
  const productA = await buyStock(ceo, 'Multi A', 20, 500);
  const productB = await buyStock(ceo, 'Multi B', 15, 800);
  const { resellerId } = await hireReseller(ceo, 'MultiRevTeste');

  const kit = kitService.suggestKit({
    resellerId,
    items: [{ product_id: productA.id, quantity: 5 }, { product_id: productB.id, quantity: 7 }],
    userId: ceo.id,
  });
  assert.equal(kit.items.length, 2);

  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  assert.equal(delivered.items.find((i) => i.product_id === productA.id).quantity_available, 5);
  assert.equal(delivered.items.find((i) => i.product_id === productB.id).quantity_available, 7);

  const balanceA = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(productA.id);
  const balanceB = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(productB.id);
  assert.equal(balanceA.bal, 15); // 20 - 5
  assert.equal(balanceB.bal, 8);  // 15 - 7
});

test('não deixa vender além do saldo disponível do kit', async () => {
  const ceo = makeUser('ceo');
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Kit B', 5, 1000);
  const { resellerId, resellerUser } = await hireReseller(ceo, 'Beltrana');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  assert.throws(
    () => kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 6, resellerUser }),
    /só há 5 disponíveis/
  );
});

test('rejeitar uma venda informada devolve o saldo sem duplicar', async () => {
  const ceo = makeUser('ceo');
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Kit C', 10, 1000);
  const { resellerId, resellerUser } = await hireReseller(ceo, 'Cicrana');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 10 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const sale = kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 3, resellerUser });

  kitService.decideSale(sale.id, 'rejeitar', ceo, 'engano');

  const item = db.prepare('SELECT * FROM kit_items WHERE id = ?').get(delivered.items[0].id);
  assert.equal(item.quantity_available, 10);
  assert.equal(item.quantity_pending_closure, 0);
});

test('fechamento não pode ser executado duas vezes para o mesmo kit', async () => {
  const ceo = makeUser('ceo');
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Kit D', 5, 1000);
  const { resellerId } = await hireReseller(ceo, 'Deltrana');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  kitService.confirmDelivery(kit.id, ceo);
  kitService.requestClosure(kit.id, ceo);
  reconcileSimple(kit.id, ceo);
  kitService.approveClosure(kit.id, ceo);
  assert.throws(() => kitService.approveClosure(kit.id, ceo), /uma única vez|em status/);
});

test('ranking da revendedora nunca expõe nome ou valor de outra revendedora', async () => {
  const ceo = makeUser('ceo');
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Kit E', 20, 1000);
  const a = await hireReseller(ceo, 'Revendedora A');
  const b = await hireReseller(ceo, 'Revendedora B');

  const kitA = kitService.suggestKit({ resellerId: a.resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kitA.id, ceo);
  const deliveredA = kitService.confirmDelivery(kitA.id, ceo);
  kitService.informSale({ kitItemId: deliveredA.items[0].id, quantity: 5, resellerUser: a.resellerUser });
  kitService.requestClosure(kitA.id, ceo);
  reconcileSimple(kitA.id, ceo);
  kitService.approveClosure(kitA.id, ceo);

  const rankingForA = kitService.rankingForReseller(a.resellerId);
  assert.ok(!('name' in rankingForA));
  assert.equal(Object.keys(rankingForA).sort().join(','), 'my_total_cents,position,total_resellers');
  assert.ok(rankingForA.total_resellers >= 2);
});

test('contratar a mesma revendedora duas vezes não duplica cadastro', async () => {
  const ceo = makeUser('ceo');
  seedRule(ceo.id);
  await hireReseller(ceo, 'Repetida');
  const result = await resellerService.handleMarinaMessage({ text: 'Contratamos Repetida, telefone 11900000000, endereço Rua Teste, 1.', userId: ceo.id });
  assert.equal(result.proposal, null);
  const count = db.prepare('SELECT COUNT(*) as c FROM resellers WHERE name = ?').get('Repetida');
  assert.equal(count.c, 1);
});
