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
const anaService = require('../src/anaService');
const commercialService = require('../src/commercialService');
const marketingService = require('../src/marketingService');
const advisorService = require('../src/advisorService');
const councilService = require('../src/councilService');
const documentService = require('../src/documentService');
const ordersService = require('../src/ordersService');

let counter = 0;
function makeCeo() {
  counter += 1;
  const { hash, salt } = hashPassword('demo');
  const info = db
    .prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-exp-${counter}`, 'ceo', hash, salt);
  return { id: info.lastInsertRowid, role: 'ceo' };
}
function seedRule(userId) {
  db.prepare(
    `INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by)
     VALUES (1, 3.0, 0.30, 1.3, 1, ?)`
  ).run(userId);
}
async function buyStock(ceo, name, qty, costCents) {
  const result = await proposalService.handleDirectorMessage({ thread: 'diego', text: `Comprei ${qty} unidades do ${name} por R$ ${(costCents/100).toFixed(2)} cada, do fornecedor F.`, userId: ceo.id });
  proposalService.approveAndExecute(result.proposal.id, ceo);
  return db.prepare('SELECT * FROM products WHERE name = ?').get(name);
}
async function hire(ceo, name) {
  const result = await resellerService.handleMarinaMessage({ text: `Contratamos ${name}, telefone 11900000000, endereço Rua X, 1.`, userId: ceo.id });
  const executed = proposalService.approveAndExecute(result.proposal.id, ceo);
  const { resellerId, username } = executed.execution_result;
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return { resellerId, resellerUser: { id: u.id, role: 'revendedora', reseller_id: resellerId } };
}

// ---- Ana ----
test('Ana responde resumo diário baseado em dados reais', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const result = await anaService.handleAnaMessage({ text: 'resumo', userId: ceo.id });
  assert.match(result.reply, /proposta|Nenhuma proposta/);
  assert.equal(result.proposal, null); // Ana nunca cria proposta, só informa
});

test('Ana encaminha para o diretor certo em vez de executar por conta própria', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const result = await anaService.handleAnaMessage({ text: 'Comprei 10 unidades do X por R$ 5 cada, do fornecedor Y.', userId: ceo.id });
  assert.match(result.reply, /Diego/);
  assert.equal(result.proposal, null);
});

// ---- Ricardo ----
test('Ricardo define meta de vendas via proposta e depois reporta contra ela', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const goalMsg = commercialService && await require('../src/proposalService').handleDirectorMessage({ thread: 'ricardo', text: 'Defina a meta do mês em R$ 1000', userId: ceo.id });
  assert.ok(goalMsg.proposal);
  proposalService.approveAndExecute(goalMsg.proposal.id, ceo);
  const snap = commercialService.performanceSnapshot();
  assert.ok(snap.goal);
  assert.equal(snap.goal.target_cents, 100000);
});

test('Ricardo identifica revendedoras sem venda confirmada', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Ricardo', 10, 1000);
  const { resellerId } = await hire(ceo, 'Vendedora Parada');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 5 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  kitService.confirmDelivery(kit.id, ceo);
  const snap = commercialService.performanceSnapshot();
  assert.ok(snap.inactiveResellers.includes('Vendedora Parada'));
});

// ---- Theo ----
test('Theo cria campanha via proposta e nunca inventa pesquisa de tendência', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const trendResult = await proposalService.handleDirectorMessage({ thread: 'theo', text: 'O que está em alta agora?', userId: ceo.id });
  assert.match(trendResult.reply, /não tenho acesso|fontes externas/i);

  const camp = await proposalService.handleDirectorMessage({ thread: 'theo', text: 'Crie uma campanha de Dia dos Namorados de 01/02 a 14/02', userId: ceo.id });
  assert.ok(camp.proposal);
  proposalService.approveAndExecute(camp.proposal.id, ceo);
  const campaigns = marketingService.listCampaigns();
  assert.ok(campaigns.some((c) => c.title.includes('Dia dos Namorados')));
});

// ---- Arthur ----
test('Arthur identifica gargalo de estoque baixo sem decidir pela CEO', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  db.prepare('INSERT INTO products (name, low_stock_threshold) VALUES (?, ?)').run('Produto Arthur', 100);
  const product = db.prepare('SELECT * FROM products WHERE name = ?').get('Produto Arthur');
  db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?, 'entrada', 1, 1, 'seed', ?)`).run(product.id, ceo.id);
  const s = advisorService.synthesize();
  assert.match(s.summary, /estoque baixo|Estoque baixo/i);
});

// ---- Conselho ----
test('Conselho convocado retorna uma contribuição por área, sem repetição genérica', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const briefing = councilService.convene('Planejamento do trimestre');
  assert.equal(briefing.sections.length, 6);
  const uniqueSummaries = new Set(briefing.sections.map((s) => s.summary));
  assert.equal(uniqueSummaries.size, briefing.sections.length); // nenhuma seção repete a outra
});

test('Conselho inclui Marina na pauta quando o tema é contratação (checklist item 19)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const briefing = councilService.convene('Contratação de novas revendedoras para o próximo ciclo');
  const marinaSection = briefing.sections.find((s) => s.director.startsWith('Marina'));
  assert.ok(marinaSection);
  assert.match(marinaSection.summary, /contratação/i);
});

test('Decisão do conselho registra responsável e prazo (checklist item 20)', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const decision = councilService.createDecision({
    description: 'Fechar contrato com novo fornecedor', assignedTo: 'diego', dueDate: '2026-08-15', ceoUser: ceo,
  });
  assert.equal(decision.assigned_to, 'diego');
  assert.equal(decision.due_date, '2026-08-15');
});

test('Decisão do conselho é rastreável: criada aberta, concluída uma vez', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const d = councilService.createDecision({ description: 'Revisar política de frete', assignedTo: 'diego', ceoUser: ceo });
  assert.equal(d.status, 'aberta');
  const completed = councilService.completeDecision(d.id, ceo);
  assert.equal(completed.status, 'concluida');
  assert.throws(() => councilService.completeDecision(d.id, ceo), /aberta|status/i);
});

// ---- Documentos ----
test('Contratar revendedora gera automaticamente ficha cadastral, termo de ciência e contrato', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { resellerId } = await hire(ceo, 'Documentada');
  const docs = documentService.listDocumentsForReseller(resellerId);
  const types = docs.map((d) => d.type).sort();
  assert.deepEqual(types, ['contrato', 'ficha_cadastral', 'termo_ciencia']);
  assert.ok(docs.every((d) => d.status === 'rascunho'));
});

test('Entrega de kit gera termo de entrega com os itens corretos', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Doc', 10, 1000);
  const { resellerId } = await hire(ceo, 'Entregada');
  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 4 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  kitService.confirmDelivery(kit.id, ceo);
  const docs = documentService.listDocumentsForReseller(resellerId);
  const termo = docs.find((d) => d.type === 'termo_entrega');
  assert.ok(termo);
  assert.match(termo.content, /Produto Doc/);
  assert.match(termo.content, /4 unidades/);
});

test('Status de documento muda de rascunho para assinado, com auditoria', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const { resellerId } = await hire(ceo, 'Assinante');
  const doc = documentService.listDocumentsForReseller(resellerId)[0];
  const updated = documentService.updateDocumentStatus(doc.id, 'assinado', ceo);
  assert.equal(updated.status, 'assinado');
  assert.throws(() => documentService.updateDocumentStatus(doc.id, 'status_invalido', ceo));
});

// ---- Pedidos ----
test('Pedido da revendedora aparece na demanda consolidada, sem expor quem pediu', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id);
  const product = await buyStock(ceo, 'Produto Pedido', 10, 1000);
  const { resellerId } = await hire(ceo, 'Pedinte');
  ordersService.createOrder({ resellerId, productId: product.id, quantity: 7, note: 'quero mais' });
  const consolidated = ordersService.consolidatedDemand();
  const row = consolidated.find((c) => c.product_id === product.id);
  assert.ok(row);
  assert.equal(row.total_requested, 7);
  assert.equal(row.resellers_count, 1);
  // a view consolidada não deve conter o nome da revendedora em lugar nenhum
  assert.ok(!('reseller_name' in row) && !('name' in row));
});

// ---- Dicas ----
test('Dica rejeita texto vazio e texto longo demais', async () => {
  const ceo = makeCeo();
  assert.throws(() => ordersService.createTip('', ceo));
  assert.throws(() => ordersService.createTip('x'.repeat(300), ceo));
  const tip = ordersService.createTip('Guarde em local seco.', ceo);
  assert.ok(ordersService.listActiveTips().some((t) => t.id === tip.id));
});

// ---- Comissão individual ----
test('Comissão individual da revendedora é usada no fechamento em vez da comissão padrão', async () => {
  const ceo = makeCeo();
  seedRule(ceo.id); // comissão padrão 30%
  const product = await buyStock(ceo, 'Produto Comissao', 20, 1000);
  const { resellerId, resellerUser } = await hire(ceo, 'ComissaoEspecial');
  resellerService.setCommission(resellerId, 0.10, ceo); // 10% em vez de 30%

  const kit = kitService.suggestKit({ resellerId, items: [{ product_id: product.id, quantity: 10 }], userId: ceo.id });
  kitService.approveKit(kit.id, ceo);
  const delivered = kitService.confirmDelivery(kit.id, ceo);
  kitService.informSale({ kitItemId: delivered.items[0].id, quantity: 10, resellerUser });
  kitService.requestClosure(kit.id, ceo);
  reconcileSimple(kit.id, ceo);
  const { closure } = kitService.approveClosure(kit.id, ceo);

  const expectedCommission = Math.round(closure.total_sold_confirmed_cents * 0.10);
  assert.equal(closure.total_commission_cents, expectedCommission);
});
