process.env.SEXSOS_DB_PATH = ':memory:';
process.env.PORT = 0;

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

// O que este arquivo garante do carrinho por fornecedor (src/purchasePlanService.js):
//  · o SKU do fornecedor sai na opção, porque é ele que permite montar o link do carrinho;
//  · o grupo do Atacadão ganha `link_carrinho` no padrão VTEX (SKUList=/<sku>/<qtd>/), o da
//    Gall não ganha nada — a Gall só aceita escrita pela API autenticada da conta;
//  · produto sem vínculo aparece em `sem_vinculo_com_link` com o link do produto, porque é
//    ali que a CEO ainda tem que colar o endereço do fornecedor (a tela não tem campo para isso).
const kitPlanService = require('../src/kitPlanService');
const purchasePlan = require('../src/purchasePlanService'); // carrega antes do seed: é ele que garante a tabela de vínculos

const { hashPassword } = require('../src/auth');
const ceo = (() => { const { hash, salt } = hashPassword('demo');
  return db.prepare("INSERT INTO users (name, username, role, password_hash, password_salt) VALUES ('CEO','ceo-pp','ceo',?,?)")
          .run(hash, salt).lastInsertRowid; })();

function produto(name, lastCost) {
  return db.prepare(`INSERT INTO products (name, last_purchase_cost_cents, low_stock_threshold, active)
                     VALUES (?, ?, 2, 1)`).run(name, lastCost).lastInsertRowid;
}
function vinculo(productId, supplier, ref, sku, costCents, stock, url) {
  db.prepare(`INSERT INTO product_supplier_links (product_id, supplier, supplier_ref, sku_id, observed_cost_cents,
                  supplier_stock, supplier_url, linked_by, observed_at)
              VALUES (?,?,?,?,?,?,?,1,datetime('now'))`)
    .run(productId, supplier, ref, sku, costCents, stock, url);
}

test('carrinho por fornecedor: SKU na opção, link do Atacadão, e o que está solto vira lista visível', () => {
  const barato = produto('Gel Teste Gall Mais Barata', 900);      // Gall 499 < Atacadão 799
  const soAtacadao = produto('Perfume Teste So Atacadao', 1200);  // só Atacadão
  const solto = produto('Calcinha Teste Sem Vinculo', 500);       // nenhum fornecedor

  vinculo(barato, 'atacadao', '8826', '555001', 799, 120, 'https://www.sexshopatacadao.com.br/gel-teste/p');
  vinculo(barato, 'gall', '5279', null, 499, null, 'https://www.gall.com.br/produto/5279-gel-teste');
  vinculo(soAtacadao, 'atacadao', '50542', '555002', 1069, 0, 'https://www.sexshopatacadao.com.br/perfume-teste/p');

  const plano = {
    ok: true,
    buy_list: [
      { product_id: barato, name: 'Gel Teste Gall Mais Barata', quantity: 3, para: ['Yasmin'], unit_cost_cents: 799, cost_cents: 2397 },
      { product_id: soAtacadao, name: 'Perfume Teste So Atacadao', quantity: 2, para: ['Gizelle'], unit_cost_cents: 1069, cost_cents: 2138 },
      { product_id: solto, name: 'Calcinha Teste Sem Vinculo', quantity: 1, para: ['Maira'], unit_cost_cents: 500, cost_cents: 500 },
    ],
    plans: [], totals: {}, buy_totals: {}, rules: {}, queue: [], alertas: [],
  };
  const real = kitPlanService.buildPlan;
  const realSaldos = kitPlanService.warehouseBalances;
  kitPlanService.buildPlan = () => plano;
  kitPlanService.warehouseBalances = () => new Map([[barato, 5], [soAtacadao, 5], [solto, 5]]);
  let r;
  try {
    r = purchasePlan.buildPurchasePlan({});
  } finally {
    kitPlanService.buildPlan = real;
    kitPlanService.warehouseBalances = realSaldos;
  }

  const linhas = Object.fromEntries(r.linhas.map((l) => [l.name, l]));

  // 1) a escolha cai no mais barato e o SKU do fornecedor sai na opção
  const g = linhas['Gel Teste Gall Mais Barata'];
  assert.equal(g.fornecedor_indicado, 'Gall');
  assert.equal(g.custo_unit_cents, 499);
  assert.equal(g.economia_unit_cents, 300, '3,00/un de economia vs Atacadão');
  assert.equal(g.opcoes[0].fornecedor, 'Gall');
  assert.equal(g.opcoes[1].fornecedor, 'Atacadão Sexy Shop');
  assert.equal(g.opcoes[1].sku_id, '555001', 'o SKU lido da página do fornecedor tem que aparecer na opção');

  // 2) só entra no link do carrinho do Atacadão quem tem SKU E estoque lá
  const atac = r.fornecedores.find((f) => f.fornecedor === 'Atacadão Sexy Shop');
  assert.ok(atac, 'o Atacadão tem que aparecer como grupo (mesmo perdendo a disputa do gel)');
  assert.equal(atac.link_carrinho,
    'https://www.sexshopatacadao.com.br/cart?SKUList=/555002/2/&sc=1',
    'o Phero sem estoque (0) não pode entrar; o do gel foi para a Gall');
  const gall = r.fornecedores.find((f) => f.fornecedor === 'Gall');
  assert.equal(gall.link_carrinho, null, 'a Gall não tem deep link de carrinho — só API autenticada');

  // 3) o que está sem vínculo fica visível com o link do produto, não desaparece
  assert.equal(r.totais.sem_vinculo, 1);
  assert.equal(r.sem_vinculo_com_link.length, 1);
  assert.equal(r.sem_vinculo_com_link[0].name, 'Calcinha Teste Sem Vinculo');
  assert.equal(r.sem_vinculo_com_link[0].qtd, 1);
  assert.equal(r.sem_vinculo_com_link[0].custo_unit_cents, 500, 'sem vínculo → o último custo pago, não zero');
  assert.ok(r.sem_vinculo_com_link[0].link_produto.startsWith('https://www.'));
  assert.equal(r.linhas.find((l) => l.name === 'Calcinha Teste Sem Vinculo').origem_preco, 'histórico');
});
