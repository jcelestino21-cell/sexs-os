process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
require('../src/stockIntents');
const proposalService = require('../src/proposalService');
const resellerService = require('../src/resellerService');
const kitService = require('../src/kitService');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-recon-${counter}`, 'ceo', hash, salt);
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
async function setupDeliveredKit(ceo, productName, qty, costCents, resellerName) {
  const product = await buyStock(ceo, productName, qty, costCents);
  const resellerId = await hire(ceo, resellerName);
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: qty }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  return { kit: delivered, product, resellerId };
}

test('não finaliza fechamento sem conferência física de todos os itens', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit } = await setupDeliveredKit(ceo, 'Produto Recon A', 10, 1000, 'RevA');
  kitService.requestClosure(kit.id, ceo);
  assert.throws(() => kitService.approveClosure(kit.id, ceo), /falta a conferência física/);
});

test('conferência rejeita soma que não bate com o total entregue', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit } = await setupDeliveredKit(ceo, 'Produto Recon B', 10, 1000, 'RevB');
  kitService.requestClosure(kit.id, ceo);
  assert.throws(() => kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 5, quantity_returned: 3, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0 }, // soma 8, entregue era 10
  }), /não bate com o total entregue/);
});

test('divergência exige observação — não fica sem tratamento', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit } = await setupDeliveredKit(ceo, 'Produto Recon C', 10, 1000, 'RevC');
  kitService.requestClosure(kit.id, ceo);
  assert.throws(() => kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 8, quantity_returned: 0, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 2 },
  }), /divergência.*explique|explique.*divergência/i);

  // com observação, funciona:
  const saved = kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 8, quantity_returned: 0, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 2, note: 'Duas unidades sumiram, motivo desconhecido — registrado para investigação.' },
  });
  assert.equal(saved.quantity_divergence, 2);
});

test('conferência encontra venda não informada e ela entra no faturamento', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit, resellerId } = await setupDeliveredKit(ceo, 'Produto Recon D', 10, 1000, 'RevD');
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: kit.items[0].id, quantity: 6, resellerUser }); // só 6 informadas

  kitService.requestClosure(kit.id, ceo);
  // na conferência física, a CEO encontra que na verdade foram vendidas 9 (3 não informadas)
  kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 9, quantity_returned: 1, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0 },
  });
  const { closure } = kitService.approveClosure(kit.id, ceo);
  assert.equal(closure.total_sold_confirmed_cents, 9 * kit.items[0].unit_sale_price_cents);

  const foundSale = db.prepare(`SELECT * FROM kit_sales WHERE kit_item_id = ? AND note LIKE '%não informada%'`).get(kit.items[0].id);
  assert.ok(foundSale);
  assert.equal(foundSale.quantity, 3);
});

test('quantidade mantida com a revendedora, danificada ou perdida não volta ao estoque nem vira faturamento', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit, product, resellerId } = await setupDeliveredKit(ceo, 'Produto Recon E', 10, 1000, 'RevE');
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: kit.items[0].id, quantity: 5, resellerUser });

  kitService.requestClosure(kit.id, ceo);
  // 5 vendidas, 2 devolvidas, 1 mantida com ela, 1 danificada, 1 perdida = 10
  kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 5, quantity_returned: 2, quantity_kept_authorized: 1, quantity_damaged: 1, quantity_lost: 1, quantity_divergence: 0 },
  });
  const { closure } = kitService.approveClosure(kit.id, ceo);

  assert.equal(closure.total_sold_confirmed_cents, 5 * kit.items[0].unit_sale_price_cents);
  assert.equal(closure.items_returned_to_stock, 2); // só as 2 devolvidas voltam

  const balance = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(product.id);
  assert.equal(balance.bal, 2); // 10 comprados - 10 entregues + 2 devolvidos

  const item = db.prepare('SELECT * FROM kit_items WHERE id = ?').get(kit.items[0].id);
  assert.equal(item.quantity_kept_by_reseller, 1);
  assert.equal(item.quantity_damaged, 1);
  assert.equal(item.quantity_lost, 1);
});

test('não permite reduzir a conferência abaixo de vendas já confirmadas individualmente', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit, resellerId } = await setupDeliveredKit(ceo, 'Produto Recon F', 10, 1000, 'RevF');
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  const sale = kitService.informSale({ kitItemId: kit.items[0].id, quantity: 5, resellerUser });
  kitService.decideSale(sale.id, 'confirmar', ceo); // confirma 5 individualmente, fora do fechamento

  kitService.requestClosure(kit.id, ceo);
  kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 3, quantity_returned: 7, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0 }, // tenta reduzir abaixo de 5
  });
  assert.throws(() => kitService.approveClosure(kit.id, ceo), /abaixo do que já foi confirmado/);
});

test('perda e dano geram movimentação de auditoria e impacto financeiro real (checklist item 15)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit, product } = await setupDeliveredKit(ceo, 'Produto Recon H', 10, 1000, 'RevH'); // custo R$10/un
  kitService.requestClosure(kit.id, ceo);
  kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 5, quantity_returned: 0, quantity_kept_authorized: 0, quantity_damaged: 3, quantity_lost: 2, quantity_divergence: 0 },
  });
  const { closure } = kitService.approveClosure(kit.id, ceo);

  assert.equal(closure.write_off_cost_cents, 5000); // custo médio R$10 × 5 danificadas/perdidas
  const soldRevenue = 5 * kit.items[0].unit_sale_price_cents;
  const cogsSold = 5 * 1000;
  const commission = Math.round(soldRevenue * 0.30);
  assert.equal(closure.gross_profit_cents, soldRevenue - cogsSold - commission - 5000);

  const auditMovement = db.prepare(`SELECT * FROM stock_movements WHERE product_id = ? AND type = 'ajuste'`).get(product.id);
  assert.ok(auditMovement);
  assert.match(auditMovement.reason, /danificada|perdida/);

  const summary = require('../src/financeService').financialSummary();
  assert.ok(summary.perdas_danos_cents >= 5000);
});

test('conferência gera um documento de fechamento rastreável', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { kit } = await setupDeliveredKit(ceo, 'Produto Recon G', 5, 1000, 'RevG');
  kitService.requestClosure(kit.id, ceo);
  kitService.saveReconciliationItem({
    kitId: kit.id, kitItemId: kit.items[0].id, ceoUser: ceo,
    values: { quantity_sold_confirmed: 5, quantity_returned: 0, quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0 },
  });
  kitService.approveClosure(kit.id, ceo);
  const closureDoc = db.prepare(`SELECT * FROM documents WHERE reference_id = ? AND type = 'fechamento'`).get(kit.id);
  assert.ok(closureDoc);
  assert.match(closureDoc.content, /Produto Recon G/);
});
