// ============================================================================
// SexS OS — Cadastro dos Produtos REAIS do Fornecedor (SexShop Atacadão/Eccosys)
// ============================================================================
const db = require('../db');
const { simulatePricing } = require('../src/pricing');

const RULE = db.prepare('SELECT * FROM pricing_rules WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
if (!RULE) { console.error('ERRO: Nenhuma regra de precificação ativa.'); process.exit(1); }

const CEO_ID = 1;

// Dados brutos do catálogo do fornecedor (parseados da planilha)
// Formato: EAN | IDinterno | Código | Nome | Variação | Qtd | CustoTotal | CustoUnit
const RAW_DATA = [
  { ean: '30402258', id_int: 'MA001SP', name: 'Anel Peniano Vibrador Bichinhos Vipmix', variant: 'TRANSPARENTE', qty: 3, cost_unit: 8.19 },
  { ean: '30602261', id_int: 'MA001SK', name: 'Egg Spider Easy One Cap Magical Kiss Sensual Love', variant: 'PADRAO', qty: 2, cost_unit: 7.74 },
  { ean: '30702260', id_int: 'MA001ST', name: 'Egg Stepper Easy One Cap Magical Kiss Sensual Love', variant: 'PADRAO', qty: 2, cost_unit: 7.74 },
  { ean: '141406439', id_int: 'LS', name: 'Lubes Sensation Lubrificante Fresh 30ml Garji', variant: 'TUTTI FRUTTI', qty: 2, cost_unit: 10.68 },
  { ean: '141406439', id_int: 'LS', name: 'Lubes Sensation Lubrificante Fresh 30ml Garji', variant: 'MORANGO', qty: 3, cost_unit: 16.02 },
  { ean: '141406439', id_int: 'LS', name: 'Lubes Sensation Lubrificante Fresh 30ml Garji', variant: 'MENTA', qty: 3, cost_unit: 16.02 },
  { ean: '344009405', id_int: 'KGA20', name: 'Gotas Afrodisíacas Estimulante Sexual Unissex 20ml K-lab', variant: 'PADRAO', qty: 3, cost_unit: 9.51 },
  { ean: '585420517926', id_int: '1', name: 'Gel Massageador Ptd Sebo De Carneiro 250g Apinil', variant: 'PADRAO', qty: 1, cost_unit: 4.57 },
  { ean: '617024893', id_int: 'FOFA', name: 'Fofa Toba Excitante Anal 15ml Segred Love', variant: 'PADRAO', qty: 3, cost_unit: 13.68 },
  { ean: '669925602', id_int: 'PAPERMINT', name: 'Papermint Lâminas Refrescantes 20 Unidades Danilla', variant: 'MORANGO', qty: 5, cost_unit: 9.05 },
  { ean: '669925602', id_int: 'PAPERMINT', name: 'Papermint Lâminas Refrescantes 20 Unidades Danilla', variant: 'EXTRA FORTE', qty: 5, cost_unit: 9.05 },
  { ean: '714326120', id_int: 'HC683', name: 'Kuloko Gel Excitante Anal 15g Hot Flowers', variant: 'PADRAO', qty: 2, cost_unit: 16.02 },
  { ean: '1134727556033', id_int: '3', name: 'Triple Shock Bolinhas Mágicas 03 Unidades For Sexy', variant: 'PADRAO', qty: 4, cost_unit: 12.72 },
  { ean: '1377330607', id_int: 'SS003', name: 'Vibrador Ponto G Golfinho Aveludado Sensual Love', variant: 'LILÁS', qty: 1, cost_unit: 5.76 },
  { ean: '1377330607', id_int: 'SS003', name: 'Vibrador Ponto G Golfinho Aveludado Sensual Love', variant: 'PINK', qty: 1, cost_unit: 5.76 },
  { ean: '1377330607', id_int: 'SS003', name: 'Vibrador Ponto G Golfinho Aveludado Sensual Love', variant: 'TIFFANY AZUL', qty: 1, cost_unit: 5.76 },
  { ean: '1377330607', id_int: 'SS003', name: 'Vibrador Ponto G Golfinho Aveludado Sensual Love', variant: 'VERDE', qty: 1, cost_unit: 5.76 },
  { ean: '1377330607', id_int: 'SS003', name: 'Vibrador Ponto G Golfinho Aveludado Sensual Love', variant: 'VERMELHO', qty: 1, cost_unit: 5.76 },
  { ean: '1497832147', id_int: 'GH15', name: 'Gel Hot Comestível 15ml Soft Love', variant: 'TUTTI FRUTTI', qty: 1, cost_unit: 5.48 },
  { ean: '1497832147', id_int: 'GH15', name: 'Gel Hot Comestível 15ml Soft Love', variant: 'UVA', qty: 2, cost_unit: 10.96 },
  { ean: '1497832147', id_int: 'GH15', name: 'Gel Hot Comestível 15ml Soft Love', variant: 'MORANGO COM CHAMPANHE', qty: 1, cost_unit: 5.48 },
  { ean: '1502832231', id_int: 'TORSVA', name: 'Pênis De Borracha Aromático 14 X 3,4cm Prazer E Cia', variant: 'TANGERINA', qty: 1, cost_unit: 10.23 },
  { ean: '1502832231', id_int: 'TORSVA', name: 'Pênis De Borracha Aromático 14 X 3,4cm Prazer E Cia', variant: 'MENTA', qty: 1, cost_unit: 10.23 },
  { ean: '1510132379', id_int: '1086', name: 'Six Ball Facilit Black Ice Bolinha 6 Unidades Soft Love', variant: 'PADRAO', qty: 2, cost_unit: 3.98 },
  { ean: '1511932403', id_int: '104', name: 'Power Kiss Jatos Aromáticos 15ml Soft Love', variant: 'CEREJA', qty: 2, cost_unit: 7.98 },
  { ean: '1511932403', id_int: '104', name: 'Power Kiss Jatos Aromáticos 15ml Soft Love', variant: 'BLACK ICE', qty: 2, cost_unit: 7.98 },
  { ean: '1526032627', id_int: 'SS012', name: 'Pop Lub Gel Corporal Neutro 60g Sensual Love', variant: 'NEUTRO', qty: 3, cost_unit: 10.08 },
  { ean: '1779035843', id_int: 'HC18', name: 'Pop Ball Bolinha Lubrificante Beijável Sensual Love', variant: 'MORANGO', qty: 2, cost_unit: 5.44 },
  { ean: '1779035843', id_int: 'HC18', name: 'Pop Ball Bolinha Lubrificante Beijável Sensual Love', variant: 'MENTA', qty: 2, cost_unit: 5.44 },
  { ean: '1779035843', id_int: 'HC18', name: 'Pop Ball Bolinha Lubrificante Beijável Sensual Love', variant: 'UVA', qty: 2, cost_unit: 5.44 },
  { ean: '1779035843', id_int: 'HC18', name: 'Pop Ball Bolinha Lubrificante Beijável Sensual Love', variant: 'FRUTAS VERMELHAS', qty: 2, cost_unit: 5.44 },
  { ean: '1779135844', id_int: 'HC192', name: 'Pop Ball Bolinha Lubrificante Ice Sensual Love', variant: 'PADRAO', qty: 2, cost_unit: 5.44 },
  { ean: '1779335846', id_int: 'HC193', name: 'Pop Ball Bolinha Lubrificante Hot Ice Sensual Love', variant: 'PADRAO', qty: 6, cost_unit: 16.32 },
  { ean: '1808236211', id_int: 'T002', name: 'Plug Anal Abs Rosa Coração Pedra Sensual Love', variant: 'ROXO', qty: 2, cost_unit: 6.40 },
  { ean: '1808236211', id_int: 'T002', name: 'Plug Anal Abs Rosa Coração Pedra Sensual Love', variant: 'ROSA', qty: 2, cost_unit: 6.40 },
];

function brl(val) { return Math.round(val * 100); }

// Determinar categoria baseado no nome do produto
function categorize(name) {
  const n = name.toLowerCase();
  if (n.includes('vibrador') || n.includes('ponto g') || n.includes('golfinho')) return 'Vibradores';
  if (n.includes('anel peniano') || n.includes('bichinhos')) return 'Anéis Penianos';
  if (n.includes('lubrificante') || n.includes('lubes') || n.includes('gel corpor') || n.includes('pop lub')) return 'Lubrificantes';
  if (n.includes('gel') && (n.includes('excitante') || n.includes('hot') || n.includes('comestível'))) return 'Géis Excitantes';
  if (n.includes('egg') || n.includes('easy one') || n.includes('cap magical')) return 'Estimuladores Masculinos';
  if (n.includes('pênis') || n.includes('penis') || n.includes('borracha')) return 'Próteses';
  if (n.includes('plug') || n.includes('anal')) return 'Anal';
  if (n.includes('bolinha') || n.includes('pop ball') || n.includes('six ball') || n.includes('triple shock')) return 'Bolinhas Funcionais';
  if (n.includes('papermint') || n.includes('lâminas') || n.includes('refrescante')) return 'Acessórios';
  if (n.includes('power kiss') || n.includes('jatos aromáticos')) return 'Aromáticos';
  if (n.includes('gotas') || n.includes('afrodisíac')) return 'Estimulantes Orais';
  if (n.includes('massageador') || n.includes('sebo de carneiro')) return 'Massageadores';
  if (n.includes('fofa') || n.includes('toba')) return 'Excitantes';
  return 'Diversos';
}

// Nome do fornecedor
const SUPPLIER_NAME = 'SexShop Atacadão (Eccosys)';

function run() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  SexS OS — Cadastro de Produtos REAIS');
  console.log('══════════════════════════════════════════════════\n');

  // 1. Limpar dados antigos (produtos fictícios)
  console.log('1. Limpando dados antigos...');
  db.exec('DELETE FROM kit_item_reconciliations');
  db.exec('DELETE FROM kit_closures');
  db.exec('DELETE FROM kit_sales');
  db.exec('DELETE FROM kit_items');
  db.exec('DELETE FROM stock_reservations');
  db.exec('DELETE FROM stock_movements');
  db.exec('DELETE FROM stock_lots');
  db.exec('DELETE FROM kits');
  db.exec('DELETE FROM products');
  db.exec('DELETE FROM suppliers');
  console.log('   ✅ Dados antigos removidos\n');

  // 2. Criar fornecedor
  console.log('2. Cadastrando fornecedor...');
  const supplierInfo = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(SUPPLIER_NAME);
  const supplierId = supplierInfo.lastInsertRowid;
  console.log(`   ✅ Fornecedor: ${SUPPLIER_NAME} (#${supplierId})\n`);

  // 3. Cadastrar produtos + estoque
  console.log('3. Cadastrando produtos com estoque...\n');

  db.exec('BEGIN');
  let totalCost = 0;
  let totalQty = 0;
  let count = 0;

  for (const item of RAW_DATA) {
    const variant = item.variant !== 'PADRAO' ? ` - ${item.variant}` : '';
    const fullName = `${item.name}${variant}`;
    const category = categorize(item.name);
    const costCents = brl(item.cost_unit);
    const internalCode = `${item.id_int}-${item.variant.replace(/\s+/g, '').substring(0, 10)}`;

    // Verificar se produto com mesmo nome já existe
    let product = db.prepare('SELECT * FROM products WHERE name = ?').get(fullName);
    let productId;

    if (product) {
      // Atualizar estoque existente
      productId = product.id;
    } else {
      // Calcular preços
      const pricing = simulatePricing(costCents, RULE);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);

      const info = db.prepare(`INSERT INTO products (
        name, category, brand, default_supplier_id, internal_code, barcode,
        description, unit, last_purchase_cost_cents,
        min_price_cents, ideal_price_cents, promo_price_cents, low_stock_threshold
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        fullName,
        category,
        item.name.split(' ').slice(-2).join(' '), // brand = últimas palavras
        supplierId,
        internalCode,
        item.ean,
        `${item.name}${variant !== 'PADRAO' ? variant : ''}`,
        'unidade',
        costCents,
        pricing.min_price_cents,
        pricing.recommended_price_cents,
        promoPrice,
        2
      );
      productId = info.lastInsertRowid;
    }

    // Lote de compra
    const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
      .run(productId, supplierId, item.qty, costCents, CEO_ID);

    // Movimentação de entrada
    const currentBal = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(productId).bal;
    const newBal = currentBal + item.qty;
    db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(productId, lotInfo.lastInsertRowid, 'entrada_compra', item.qty, newBal, 'Compra fornecedor SexShop Atacadão', CEO_ID);

    totalCost += item.cost_unit * item.qty;
    totalQty += item.qty;
    count++;

    const price = brl(item.cost_unit * 3); // preço ideal = custo x3
    console.log(`   ✅ ${fullName}`);
    console.log(`      ${item.qty} un × R$ ${item.cost_unit.toFixed(2)} = R$ ${(item.cost_unit * item.qty).toFixed(2)} | Venda: R$ ${(price/100).toFixed(2)}`);
  }

  db.exec('COMMIT');

  // Resumo
  console.log('\n══════════════════════════════════════════════════');
  console.log('  RESUMO');
  console.log('══════════════════════════════════════════════════');
  console.log(`  Produtos cadastrados: ${db.prepare('SELECT COUNT(DISTINCT id) as c FROM products').get().c}`);
  console.log(`  Itens (linhas): ${count}`);
  console.log(`  Total unidades: ${totalQty}`);
  console.log(`  Custo total: R$ ${totalCost.toFixed(2)}`);
  console.log(`  Fornecedores: ${db.prepare('SELECT COUNT(*) as c FROM suppliers').get().c}`);
  console.log(`  Lotes estoque: ${db.prepare('SELECT COUNT(*) as c FROM stock_lots').get().c}`);
  console.log(`  Movimentações: ${db.prepare('SELECT COUNT(*) as c FROM stock_movements').get().c}`);

  // Categorias
  console.log('\n  Por categoria:');
  const cats = db.prepare('SELECT category, COUNT(*) as c, COALESCE(SUM(last_purchase_cost_cents),0) as tc FROM products GROUP BY category ORDER BY c DESC').all();
  cats.forEach(c => console.log(`    ${c.category}: ${c.c} produtos (custo total: R$ ${(c.tc/100).toFixed(2)})`));

  console.log('\n  ✅ Cadastro completo!\n');
}

run();
