// Sobe um banco de teste com o tripé que a CEO pediu (pedido + histórico − estoque)
// e exercita carrinhoSugerido via require direto — sem servidor, sem sites.
process.env.SEXSOS_DB_PATH = ':memory:';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { hashPassword } = require('../src/auth');

function seed() {
  db.exec(`CREATE TABLE IF NOT EXISTS product_supplier_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    supplier TEXT NOT NULL, supplier_ref TEXT, supplier_url TEXT, sku_id TEXT,
    observed_cost_cents INTEGER, supplier_stock INTEGER, note TEXT,
    linked_by INTEGER REFERENCES users(id), observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(product_id, supplier))`);

  db.prepare(`INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active) VALUES (1,3.0,0.30,1.3,1)`).run();
  const { hash, salt } = hashPassword('x');
  const uid = db.prepare('INSERT INTO users (name, username, role, active, password_hash, password_salt) VALUES (?,?,?,?,?,?)')
    .run('CEO', 'ceo-carr', 'ceo', 1, hash, salt).lastInsertRowid;
  const r1 = db.prepare(`INSERT INTO resellers (name, phone, status) VALUES ('Gizelle','1','ativa')`).run().lastInsertRowid;
  const r2 = db.prepare(`INSERT INTO resellers (name, phone, status) VALUES ('Yasmin','2','ativa')`).run().lastInsertRowid;

  // produto A: pedido 4 (Giz 2 + Yas 2), saída 6/mês, livre 3  → comprar 4+6−3 = 7
  const pa = db.prepare(`INSERT INTO products (name, unit, active, last_purchase_cost_cents) VALUES ('Gel A','un',1,990)`).run().lastInsertRowid;
  // produto B: sem pedido, saída 2/mês, livre 5 → comprar 0 (some da lista)
  const pb = db.prepare(`INSERT INTO products (name, unit, active, last_purchase_cost_cents) VALUES ('Creme B','un',1,500)`).run().lastInsertRowid;
  // produto C: pedido 10, sem histórico, livre 0, SEM vínculo → custo do cadastro, 'site não lido'
  const pc = db.prepare(`INSERT INTO products (name, unit, active, last_purchase_cost_cents) VALUES ('Chaveiro C','un',1,528)`).run().lastInsertRowid;

  const insMov = db.prepare('INSERT INTO stock_movements (product_id, type, quantity, balance_after, created_by) VALUES (?,?,?,?,?)');
  const bal = (pid, n) => { if (n) insMov.run(pid, 'entrada', n, n, uid); };
  bal(pa, 3); bal(pb, 5); bal(pc, 0 + 0); // C fica zerado

  const insOrd = db.prepare(`INSERT INTO reseller_orders (reseller_id, product_id, quantity_requested, quantity_fulfilled, status) VALUES (?,?,?,?,?)`);
  insOrd.run(r1, pa, 2, 0, 'pendente');
  insOrd.run(r2, pa, 3, 1, 'pendente');           // falta 2
  insOrd.run(r2, pc, 10, 0, 'pendente');
  insOrd.run(r1, pc, 4, 4, 'atendido');           // não conta
  insOrd.run(r1, pc, 6, 0, 'separado');            // não conta (armazém já guarda essas)
  // histórico de venda do produto A nas duas: 6 un em ~30 dias = ~6/mês
  const kit = db.prepare(`INSERT INTO kits (reseller_id, cycle_number, status, created_by) VALUES (?,1,'encerrado',?)`).run(r1, uid).lastInsertRowid;
  const ki = db.prepare(`INSERT INTO kit_items (kit_id, product_id, quantity_suggested, unit_sale_price_cents, quantity_delivered, quantity_available, quantity_confirmed_sold, quantity_pending_closure) VALUES (?,?,5,3000,5,0,5,0)`).run(kit, pa).lastInsertRowid;
  db.prepare(`INSERT INTO kit_sales (kit_item_id, quantity, unit_price_cents, status, created_at) VALUES (?,?,?,?,datetime('now','-29 days'))`).run(ki, 4, 3000, 'confirmada');
  db.prepare(`INSERT INTO kit_sales (kit_item_id, quantity, unit_price_cents, status, created_at) VALUES (?,?,?,?,datetime('now','-29 days'))`).run(ki, 2, 3000, 'confirmada');
  // produto A tem vínculo nos dois sites — o mais barato vence
  db.prepare(`INSERT INTO product_supplier_links (product_id, supplier, supplier_url, sku_id, observed_cost_cents, supplier_stock, observed_at)
              VALUES (?,'gall','https://gall/x','13',1050,80,datetime('now','-10 minutes'))`).run(pa);
  db.prepare(`INSERT INTO product_supplier_links (product_id, supplier, supplier_url, sku_id, observed_cost_cents, supplier_stock, observed_at)
              VALUES (?,'atacadao','https://ata/SkuA/p','9001',890,200,datetime('now','-10 minutes'))`).run(pa);
  return { pa, pb, pc };
}

test('carrinho = pedido + 1 mês − estoque livre; custo pela leitura mais barata dos sites', async () => {
  const ids = seed();
  const { buildPurchasePlan } = require('../src/purchasePlanService');
  const d = await Promise.resolve(buildPurchasePlan({}));
  const c = d.carrinho;
  assert.ok(c, 'payload traz o bloco carrinho');

  const a = c.linhas.find((l) => l.product_id === ids.pa);
  const b = c.linhas.find((l) => l.product_id === ids.pb);
  const cc = c.linhas.find((l) => l.product_id === ids.pc);
  assert.ok(a, 'produto com pedido+histórico entra');
  assert.ok(!b, 'produto coberto pelo estoque Some (2/mês − 5 livres = 0)');
  assert.ok(cc, 'produto só com pedido entra');

  assert.equal(a.pedido_total, 4, 'pedido soma as duas (2 + 3−1 atendido parcial)');
  assert.deepEqual(a.pedido_por.map((p) => p.revendedora).sort(), ['Gizelle', 'Yasmin']);
  assert.equal(a.estoque_livre, 3);
  assert.ok(a.venda_mes >= 5 && a.venda_mes <= 8, 'velocidade ≈6/mês (veio ' + a.venda_mes + ')');
  assert.equal(a.quantity, 4 + Math.round(a.venda_mes) - 3, 'quantidade bate com a fórmula declarada');
  assert.equal(a.custo_unit_cents, 890, 'previsão usa o Atacadão (mais barato que Gall 1050)');
  assert.equal(a.custo_origem, 'Atacadão Sexy Shop');
  assert.equal(a.opcoes.length, 2, 'compara os dois sites');
  assert.equal(a.custo_total_cents, 890 * a.quantity);

  assert.equal(cc.quantity, 10, 'só pedido, estoque zero');
  assert.equal(cc.custo_unit_cents, 528, 'sem vínculo → custo do cadastro');
  assert.match(cc.custo_origem, /site não lido/, 'origem etiquetada com honestidade');

  const at = c.por_fornecedor.find((f) => f.fornecedor === 'Atacadão Sexy Shop');
  assert.ok(at && at.link_carrinho.includes('/9001/' + a.quantity + '/'), 'link de carrinho do Atacadão com SKU e qtd');
  const def = c.por_fornecedor.find((f) => f.fornecedor === 'definir fornecedor');
  assert.ok(def && def.custo_cents == null && def.custo_incompleto === 10, 'linhas sem preço site não somam no total');
  assert.equal(c.totais.custo_previsto_cents, a.custo_total_cents + 528 * 10, 'previsão total cobre todos os itens (site + cadastro etiquetado)');
  assert.equal(at.custo_cents, a.custo_total_cents, 'no fornecedor só entra o que tem leitura dele');
  assert.match(a.por_que, /pedido 4 un \(Gizelle 2, Yasmin 2\)/, 'o por-quê explica a conta');
});
