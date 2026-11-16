process.env.SEXSOS_DB_PATH = ':memory:';
process.env.PORT = 0;

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');
const kitPlan = require('../src/kitPlanService');
const kitService = require('../src/kitService');

// O que este arquivo garante do simulador de kit (src/kitPlanService.js):
//  · o plano é o pedido pendente + a reposição do que ela vendeu no kit em aberto,
//    e NÃO repete o que ela já tem sem venda na bolsa;
//  · linha sem estoque vira "comprar" e não entra no kit (approveKit trava o kit
//    inteiro por causa de uma linha);
//  · o estoque do armazém é dividido em ordem de fila — duas revendedoras nunca
//    somam mais do que existe;
//  · apply cria kit 'sugerido' sem tocar em estoque, e recusa quem tem kit em
//    aberto não conferido;
//  · a demanda presa em "separado" aparece como alerta (ela some da tela de
//    pendentes, e isso é justamente o buraco que a CEO não via).
let n = 0;
const uid = () => (n += 1);

function makeCeo() {
  const { hash, salt } = hashPassword('demo');
  return db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-plan-${uid()}`, 'ceo', hash, salt).lastInsertRowid;
}
const CEO = makeCeo();

function reseller(name, { active = true } = {}) {
  return db.prepare('INSERT INTO resellers (name, status, commission_pct, phone) VALUES (?, ?, 0.25, ?)')
    .run(name, active ? 'ativa' : 'inativa', '(16) 99000-0000').lastInsertRowid;
}

/** Produto com `estoque` unidades no armazém (movimento de entrada) e custo de R$ 8. */
function product(name, { price = 2500, cost = 800, estoque = 0, active = true } = {}) {
  const id = db.prepare(`INSERT INTO products (name, category, description, photo_url, unit, ideal_price_cents,
      min_price_cents, last_purchase_cost_cents, active) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(name, 'Geral', '', '', 'unidade', price, Math.round(price * 0.6), cost, active ? 1 : 0).lastInsertRowid;
  if (cost) db.prepare('INSERT INTO stock_lots (product_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?)')
    .run(id, estoque || 10, cost, CEO);
  if (estoque) {
    db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?, 'entrada', ?, ?, 'compra', ?)")
      .run(id, estoque, estoque, CEO);
  }
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function pedido(resellerId, productId, qtd, { status = 'pendente', diasAtras = 1, separated = 0, kitId = null, fulfilled = 0 } = {}) {
  return db.prepare(`INSERT INTO reseller_orders (reseller_id, product_id, quantity_requested, status, quantity_fulfilled,
      quantity_separated, kit_id, created_at) VALUES (?,?,?,?,?,?,?,datetime('now', ?))`)
    .run(resellerId, productId, qtd, status, fulfilled, separated, kitId, `-${diasAtras} day`).lastInsertRowid;
}

/** Kit em aberto da revendedora: `emMaos` sem venda + `vendidas` baixadas/na conferência. */
function openKit(resellerId, productId, { emMaos = 0, vendidas = 0, status = 'entregue', diasAtras = 5 } = {}) {
  const kitId = db.prepare("INSERT INTO kits (reseller_id, cycle_number, status, created_by, delivered_at, created_at) VALUES (?,?,?,?,datetime('now', ?), datetime('now', ?))")
    .run(resellerId, uid(), status, CEO, `-${diasAtras} day`, `-${diasAtras + 1} day`).lastInsertRowid;
  const entregue = emMaos + vendidas;
  db.prepare(`INSERT INTO kit_items (kit_id, product_id, quantity_suggested, unit_sale_price_cents, quantity_delivered,
      quantity_available, quantity_pending_closure, quantity_confirmed_sold) VALUES (?,?,?,?,?,?,?,?)`)
    .run(kitId, productId, entregue, 2500, entregue, emMaos, vendidas, 0);
  if (entregue) {
    db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?, 'entrega_kit', ?, ?, 'entrega', ?)")
      .run(productId, -entregue, 0, CEO);
  }
  return kitId;
}

// suggestKit() calcula preço pela regra ativa de precificação; sem regra o sistema
// inteiro reclama (é assim também na produção), então o teste planta uma.
db.prepare('INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by) VALUES (?,?,?, ?,1,1)')
  .run(1, 2.5, 0.25, 1.3);

/** Histórico de venda dela num kit já encerrado (não é kit aberto: só alimenta a sugestão). */
function historyKit(resellerId, productId, { vendidas = 1 } = {}) {
  const kitId = db.prepare("INSERT INTO kits (reseller_id, cycle_number, status, created_by) VALUES (?,?, 'encerrado', ?)").run(resellerId, uid(), CEO).lastInsertRowid;
  db.prepare(`INSERT INTO kit_items (kit_id, product_id, quantity_suggested, unit_sale_price_cents, quantity_delivered,
      quantity_available, quantity_pending_closure, quantity_confirmed_sold) VALUES (?,?,?,?,0,0,0,?)`)
    .run(kitId, productId, vendidas, 2500, vendidas);
  return kitId;
}

const planoDe = (rid, opts) => kitPlan.buildPlan(opts).plans.find((p) => p.reseller_id === rid);
const linha = (plano, pid) => (plano ? plano.lines.find((l) => l.product_id === pid) : undefined);

test('saldo do armazém do simulador é o mesmo cálculo do resto do sistema', () => {
  const p = product('Gel Doctest Saldo', { estoque: 7 });
  const map = kitPlan.warehouseBalances();
  assert.equal(map.get(p.id), 7, 'entrada simples aparece igual');
  assert.equal(map.get(p.id), kitService.companyAvailableBalance(p.id), 'sem divergência de sinal com kitService');
});

test('pedido pendente: o que tem sai do estoque, o que falta vira linha de compra', () => {
  const r = reseller('Doctest Pedido');
  const p = product('Gel Doctest Pedido', { estoque: 1, price: 2500, cost: 800 });
  pedido(r, p.id, 3);

  const plano = planoDe(r);
  const l = linha(plano, p.id);
  assert.equal(l.quantity, 3, 'as 3 unidades pedidas entram no plano');
  assert.equal(l.from_stock, 1, 'uma sai do armazém');
  assert.equal(l.to_buy, 2, 'duas precisam ser compradas');
  assert.match(l.motivo, /pediu 3/, 'a linha diz por que está ali');

  const out = kitPlan.buildPlan();
  const b = out.buy_list.find((x) => x.product_id === p.id);
  assert.equal(b.quantity, 2, 'a lista de compra traz o que falta');
  assert.equal(b.cost_cents, 1600, 'custo estimado = 2 × R$ 8,00');
  assert.deepEqual(b.para, ['Doctest Pedido'], 'e para quem é');
});

test('repõe o que ela vendeu no kit em aberto — e não repete o que está parado na bolsa', () => {
  const vendeu = reseller('Doctest Repoe');
  const p1 = product('Gel Doctest Repõe', { estoque: 9 });
  openKit(vendeu, p1.id, { emMaos: 0, vendidas: 2 });

  const l1 = linha(planoDe(vendeu), p1.id);
  assert.equal(l1.quantity, 2, 'as 2 vendidas voltam para o kit');
  assert.match(l1.motivo, /vendeu 2 no kit #/, 'com a origem marcada');

  const paraTudo = reseller('Doctest Parado');
  const p2 = product('Gel Doctest Parado', { estoque: 9 });
  openKit(paraTudo, p2.id, { emMaos: 3, vendidas: 2 });
  const plano2 = planoDe(paraTudo);
  assert.equal(linha(plano2, p2.id), undefined, 'vendidas 2 menos 3 paradas = nada a mandar');
  assert.equal(plano2.cobertas_pelo_que_ela_ja_tem[0].vendidas, 2, 'e o plano explica que foi coberto pelo que ela tem');
});

test('uma unidade não vai para duas mãos: quem espera mais escolhe primeiro', () => {
  const maisVelha = reseller('Doctest Velha');
  const maisNova = reseller('Doctest Nova');
  const p = product('Gel Doctest Disputa', { estoque: 1 });
  pedido(maisVelha, p.id, 1, { diasAtras: 40 });
  pedido(maisNova, p.id, 1, { diasAtras: 1 });

  const out = kitPlan.buildPlan();
  assert.deepEqual(out.queue.filter((q) => ['Doctest Velha', 'Doctest Nova'].includes(q.reseller_name)).map((q) => q.reseller_name),
    ['Doctest Velha', 'Doctest Nova'], 'a fila ordena por idade do pedido');
  const a = out.plans.find((x) => x.reseller_name === 'Doctest Velha');
  const b = out.plans.find((x) => x.reseller_name === 'Doctest Nova');
  assert.equal(linha(a, p.id).from_stock, 1, 'a primeira leva a unidade');
  assert.equal(linha(b, p.id).to_buy, 1, 'a segunda fica na lista de compra');
  assert.ok(out.estoque_sobra[p.id] === 0 || out.estoque_sobra[p.id] === undefined, 'e o saldo não fica negativo');
});

test('quantity_fulfilled guardada como texto não quebra a conta do pendente', () => {
  const r = reseller('Doctest Texto');
  const p = product('Gel Doctest Texto', { estoque: 0 });
  pedido(r, p.id, 3, { fulfilled: '2026-08-11 14:07:58' });
  assert.equal(linha(planoDe(r), p.id).quantity, 3, 'três pedidas, nenhuma baixada de verdade');
});

test('produto inativo fora do plano (e do estoque) — e o estoque dele não é prometido', () => {
  const r = reseller('Doctest Inativo');
  const p = product('Gel Doctest Inativo', { estoque: 4, active: false });
  pedido(r, p.id, 2);
  const plano = planoDe(r);
  assert.equal(plano.lines.length, 0, 'nenhuma linha para produto desativado');
  assert.equal(kitPlan.warehouseBalances().has(p.id), false, 'inativo nem entra no saldo');
});

test('apply cria kit sugerido só com o que tem, sem tocar no estoque; o que falta fica para comprar', () => {
  const r = reseller('Doctest Apply');
  const p = product('Gel Doctest Apply', { estoque: 2 });
  pedido(r, p.id, 3);
  const movimentosAntes = db.prepare('SELECT COUNT(*) c FROM stock_movements').get().c;

  const out = kitPlan.applyPlan({ resellerId: r, userId: CEO });
  assert.equal(out.kit.status, 'sugerido', 'nasce como sugestão, nada entregue');
  assert.equal(out.kit.itens, 1, 'uma linha');
  const itens = db.prepare('SELECT * FROM kit_items WHERE kit_id = ?').all(out.kit.id);
  assert.equal(itens[0].quantity_suggested, 2, 'só as 2 que existem no armazém');
  assert.equal(itens[0].quantity_delivered, 0, 'e nada saiu do estoque');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_movements').get().c, movimentosAntes, 'nenhum movimento novo');
  assert.deepEqual(out.left_to_buy, [{ product_id: p.id, name: p.name, quantity: 1 }], 'a terceira unidade fica na lista de compra');
});

test('apply recusa quem tem kit em aberto não conferido, e respeita o override', () => {
  const r = reseller('Doctest Travado');
  const p = product('Gel Doctest Travado', { estoque: 5 });
  openKit(r, p.id, { emMaos: 1, vendidas: 2 });
  assert.throws(() => kitPlan.applyPlan({ resellerId: r, userId: CEO }), /Confira o fechamento primeiro/);
  const forzado = kitPlan.applyPlan({ resellerId: r, userId: CEO, force: true });
  assert.equal(forzado.kit.status, 'sugerido', 'com force ela pode montar por conta e risco');
});

test('demanda presa em "separado" vira alerta, porque a tela de pendentes não a vê', () => {
  const r = reseller('Doctest Preso');
  const p = product('Gel Doctest Preso', { estoque: 0 });
  const kitId = db.prepare("INSERT INTO kits (reseller_id, cycle_number, status, created_by) VALUES (?,?,'encerrado',?)").run(r, uid(), CEO).lastInsertRowid;
  pedido(r, p.id, 4, { status: 'separado', separated: 4, kitId });

  const alertas = kitPlan.buildPlan().alertas.filter((a) => a.tipo === 'fila_presa');
  assert.equal(alertas.length, 1);
  assert.match(alertas[0].aviso.join(' '), /Doctest Preso: 1 pedido/);
});

test('kit parado há mais de três semanas sem venda lançada é avisado', () => {
  const r = reseller('Doctest Granada');
  const p = product('Gel Doctest Granada', { estoque: 3 });
  openKit(r, p.id, { emMaos: 3, vendidas: 0, diasAtras: 45 });
  const alerta = kitPlan.buildPlan().alertas.find((a) => a.tipo === 'kit_sem_baixa');
  assert.ok(alerta, 'existe alerta');
  assert.match(alerta.aviso.join(' '), /há 4[0-9] dias sem nenhuma venda lançada/);
});

test('sugestão de complementação nunca toma a unidade que outra revendedora pediu', () => {
  const velha = reseller('Doctest Sugestao');
  const pedindo = reseller('Doctest Pedido Real');
  const disputado = product('Gel Doctest Disputa2', { estoque: 1 });
  const outro = product('Gel Doctest Outro2', { estoque: 2 });
  historyKit(velha, disputado.id, { vendidas: 1 });     // ela já vendeu isso → entra na sugestão
  pedido(velha, outro.id, 1, { diasAtras: 90 });         // e tem pedido mais antigo (fila na frente)
  pedido(pedindo, disputado.id, 1, { diasAtras: 2 });   // a outra pediu a única unidade

  const out = kitPlan.buildPlan({});
  const a = out.plans.find((x) => x.reseller_name === 'Doctest Sugestao');
  const b = out.plans.find((x) => x.reseller_name === 'Doctest Pedido Real');
  assert.equal(linha(b, disputado.id).from_stock, 1, 'quem pediu leva a unidade do armazém');
  assert.equal(linha(b, disputado.id).to_buy, 0, 'e não vira compra');
  assert.equal(linha(a, disputado.id), undefined, 'a sugestão da primeira não passa na frente do pedido da segunda');
  assert.ok(a.sugestoes_sem_estoque.some((x) => x.product_id === disputado.id), 'a sugestão aparece como "sem estoque hoje"');
});

test('teto de valor do formulário corta linha e avisa o que ficou fora', () => {
  const r = reseller('Doctest Teto');
  const caro = product('Gel Doctest Caro', { estoque: 4, price: 20000 });
  const barato = product('Gel Doctest Barato', { estoque: 4, price: 1000 });
  pedido(r, caro.id, 3);   // 3 un. → pedido maior, entra primeiro na linha
  pedido(r, barato.id, 2);
  const plano = planoDe(r, { maxValueCents: 21000, fill: false });
  assert.equal(linha(plano, caro.id).quantity, 1, 'do pedido de 3 coube 1 × R$ 200 no teto de R$ 210');
  assert.equal(linha(plano, barato.id).quantity, 1, 'e 1 × R$ 10 com o resto');
  assert.deepEqual(plano.fora_do_teto.map((c) => [c.name, c.quantity]), [['Gel Doctest Caro', 2], ['Gel Doctest Barato', 1]],
    'o que não coube fica marcado, sem sumir');
  const semTeto = planoDe(r, { fill: false });
  assert.equal(semTeto.totals.over_form_cap, true, 'sem teto entra tudo, e o R$ 300 do formulário vira só aviso');
  assert.equal(linha(semTeto, caro.id).quantity, 3);
});
