process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
require('../src/stockIntents');
const proposalService = require('../src/proposalService');
const resellerService = require('../src/resellerService');
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
const financeService = require('../src/financeService');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-fin2-${counter}`, 'ceo', hash, salt);
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

test('CRÍTICO: lucro bruto desconta CMV, não só comissão — cenário exato do documento de correção', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id); // custo x3, comissão 30%
  const product = await buyStock(ceo, 'Produto Critico', 1, 3000); // custo R$30 -> preço R$90 (custo x3)
  const resellerId = await hire(ceo, 'RevendedoraCritica');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 1 }], userId: ceo.id });
  assert.equal(kit.items[0].unit_sale_price_cents, 9000); // R$90

  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId }; // simula a revendedora só p/ o teste
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 1, resellerUser });
  kitService.requestClosure(kit.id, ceo);
  reconcileSimple(kit.id, ceo);
  const { closure } = kitService.approveClosure(kit.id, ceo);

  assert.equal(closure.total_sold_confirmed_cents, 9000);       // faturamento R$90
  assert.equal(closure.total_commission_cents, 2700);            // comissão R$27 (30% de 90)
  assert.equal(closure.cost_of_goods_sold_cents, 3000);           // CMV R$30
  // lucro bruto = 90 - 30 - 27 = 33, NUNCA 63 (que seria só faturamento - comissão, o bug original)
  assert.equal(closure.gross_profit_cents, 3300);

  const summary = financeService.financialSummary();
  assert.equal(summary.lucro_bruto_cents, 3300);
  assert.notEqual(summary.lucro_bruto_cents, 6300, 'não pode confundir "valor a receber" com "lucro"');
});

test('comissão só é "paga" quando existe um registro real de pagamento', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Comissao Paga', 5, 1000);
  const resellerId = await hire(ceo, 'RevendedoraPagamento');
  const before = financeService.financialSummary();

  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 5, resellerUser });
  kitService.requestClosure(kit.id, ceo);
  reconcileSimple(kit.id, ceo);
  const { closure } = kitService.approveClosure(kit.id, ceo);

  let after = financeService.financialSummary();
  assert.equal(after.comissao_gerada_cents - before.comissao_gerada_cents, closure.total_commission_cents);
  assert.equal(after.comissao_paga_cents, before.comissao_paga_cents); // ainda ninguém pagou nada
  assert.equal(after.comissao_a_pagar_cents - before.comissao_a_pagar_cents, closure.total_commission_cents);

  financeService.recordCommissionPayment({ resellerId, kitId: kit.id, amountCents: closure.total_commission_cents, actorUser: ceo });
  const afterPayment = financeService.financialSummary();
  assert.equal(afterPayment.comissao_paga_cents - after.comissao_paga_cents, closure.total_commission_cents);
  assert.equal(afterPayment.comissao_a_pagar_cents, after.comissao_a_pagar_cents - closure.total_commission_cents);
});

test('valor a receber só vira "recebido" com um registro real de recebimento', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Recebido', 5, 1000);
  const resellerId = await hire(ceo, 'RevendedoraRecebimento');
  const before = financeService.financialSummary();

  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 5, resellerUser });
  kitService.requestClosure(kit.id, ceo);
  reconcileSimple(kit.id, ceo);
  const { closure } = kitService.approveClosure(kit.id, ceo);

  let after = financeService.financialSummary();
  assert.equal(after.valor_a_receber_total_cents - before.valor_a_receber_total_cents, closure.total_due_to_sexs_cents);
  assert.equal(after.valor_recebido_cents, before.valor_recebido_cents);
  assert.equal(after.valor_a_receber_pendente_cents - before.valor_a_receber_pendente_cents, closure.total_due_to_sexs_cents);

  financeService.recordReceivablePayment({ resellerId, kitId: kit.id, amountCents: closure.total_due_to_sexs_cents, actorUser: ceo });
  const afterPayment = financeService.financialSummary();
  assert.equal(afterPayment.valor_recebido_cents - after.valor_recebido_cents, closure.total_due_to_sexs_cents);
  assert.equal(afterPayment.valor_a_receber_pendente_cents, after.valor_a_receber_pendente_cents - closure.total_due_to_sexs_cents);
});

test('venda informada (kit ainda em andamento) NUNCA entra no faturamento confirmado', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Informado', 5, 1000);
  const resellerId = await hire(ceo, 'RevendedoraInformada');
  const before = financeService.financialSummary();

  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  const resellerUser = { id: ceo.id, role: 'revendedora', reseller_id: resellerId };
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 3, resellerUser }); // informada, kit NÃO fechado

  const after = financeService.financialSummary();
  assert.equal(after.faturamento_confirmado_cents, before.faturamento_confirmado_cents); // nada mudou — kit não fechou
  assert.ok(after.valor_vendido_informado_cents - before.valor_vendido_informado_cents > 0); // mas aparece como "informado"
});

test('pagamento de comissão rejeita valor zero ou negativo', async () => {
  const ceo = makeCeo();
  assert.throws(() => financeService.recordCommissionPayment({ resellerId: 1, amountCents: 0, actorUser: ceo }));
  assert.throws(() => financeService.recordCommissionPayment({ resellerId: 1, amountCents: -100, actorUser: ceo }));
});
