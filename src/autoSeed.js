// ============================================================================
// SexS OS — Auto-Seed: popula dados REAIS do fornecedor SexShop Atacadão (Eccosys)
// ============================================================================
const db = require('../db');

function needsSeeding() {
  const productCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  const resellerCount = db.prepare('SELECT COUNT(*) as c FROM resellers').get().c;
  return productCount === 0 && resellerCount === 0;
}

function autoSeed() {
  if (!needsSeeding()) {
    console.log('[AutoSeed] Banco já possui dados. Pulando seed.');
    return;
  }
  runSeed();
}

function forceSeed() {
  console.log('[AutoSeed] Force-seed: limpando e repopulando...');
  // Limpar dados de negócio
  db.exec('DELETE FROM kit_item_reconciliations');
  db.exec('DELETE FROM kit_closures');
  db.exec('DELETE FROM kit_sales');
  db.exec('DELETE FROM kit_items');
  db.exec('DELETE FROM kits');
  db.exec('DELETE FROM stock_reservations');
  db.exec('DELETE FROM stock_movements');
  db.exec('DELETE FROM stock_lots');
  db.exec('DELETE FROM products');
  db.exec('DELETE FROM suppliers');
  db.exec("DELETE FROM users WHERE role = 'revendedora'");
  db.exec('DELETE FROM resellers');
  db.exec('DELETE FROM expenses');
  db.exec('DELETE FROM proposals');
  db.exec('DELETE FROM conversation_messages');
  db.exec('DELETE FROM notifications');
  runSeed();
}

function runSeed() {
  console.log('[AutoSeed] Populando cadastros reais...');

  const ceo = db.prepare("SELECT id FROM users WHERE role = 'ceo' ORDER BY id LIMIT 1").get();
  if (!ceo) { console.log('[AutoSeed] CEO não encontrada.'); return; }

  const rule = db.prepare('SELECT * FROM pricing_rules WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
  if (!rule) { console.log('[AutoSeed] Regra de precificação não encontrada.'); return; }

  try {
    const { simulatePricing } = require('./pricing');
    const { hashPassword } = require('./auth');
    const CEO_ID = ceo.id;
    function brl(val) { return Math.round(val * 100); }

    // === EMPRESA ===
    if (!db.prepare('SELECT id FROM company_settings WHERE id = 1').get()) {
      db.prepare(`INSERT INTO company_settings (id, legal_name, trade_name, document_id, owner_name,
        owner_document_id, opening_date, registration_status, tax_regime, main_cnae,
        main_cnae_description, address_city, address_state, updated_by, updated_at
      ) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
        'SexS LTDA', 'SexS', '52.841.367/0001-29', 'Jessica Celestino',
        '485.291.838-70', '2024-03-15', 'ATIVA', 'MEI', '4772-5/00',
        'Comércio varejista de cosméticos e produtos eróticos',
        'Barretos', 'SP', CEO_ID
      );
      console.log('[AutoSeed] ✅ Empresa');
    }

    // === FORNECEDOR ===
    let supplierId;
    const existingSup = db.prepare('SELECT id FROM suppliers WHERE name LIKE ?').get('%Eccosys%');
    if (existingSup) { supplierId = existingSup.id; }
    else {
      const info = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('SexShop Atacadão (Eccosys)');
      supplierId = info.lastInsertRowid;
    }
    console.log('[AutoSeed] ✅ Fornecedor');

    // === PRODUTOS REAIS (nomes curtos, custo unitário correto da nota fiscal) ===
    const products = [
      { name: 'Anel Vibrador Bichinhos', cat: 'Anéis Penianos', code: 'MA001SP', ean: '30402258', qty: 3, cost: 2.73 },
      { name: 'Egg Spider Sensual Love', cat: 'Estimuladores Masculinos', code: 'MA001SK', ean: '30602261', qty: 2, cost: 7.74 },
      { name: 'Egg Stepper Sensual Love', cat: 'Estimuladores Masculinos', code: 'MA001ST', ean: '30702260', qty: 2, cost: 7.74 },
      { name: 'Lubrificante Fresh 30ml - Tutti Frutti', cat: 'Lubrificantes', code: 'LS-TUTTI', ean: '141406439', qty: 2, cost: 5.34 },
      { name: 'Lubrificante Fresh 30ml - Morango', cat: 'Lubrificantes', code: 'LS-MORANGO', ean: '141406439', qty: 3, cost: 5.34 },
      { name: 'Lubrificante Fresh 30ml - Menta', cat: 'Lubrificantes', code: 'LS-MENTA', ean: '141406439', qty: 3, cost: 5.34 },
      { name: 'Gotas Afrodisíacas 20ml', cat: 'Estimulantes Orais', code: 'KGA20', ean: '344009405', qty: 3, cost: 9.51 },
      { name: 'Gel Massageador 250g', cat: 'Massageadores', code: 'GMS', ean: '585420517926', qty: 1, cost: 4.57 },
      { name: 'Fofa Toba Excitante 15ml', cat: 'Anal', code: 'FOFA', ean: '617024893', qty: 3, cost: 4.56 },
      { name: 'Papermint Lâminas - Morango', cat: 'Acessórios', code: 'PAPER-MOR', ean: '669925602', qty: 5, cost: 1.81 },
      { name: 'Papermint Lâminas - Extra Forte', cat: 'Acessórios', code: 'PAPER-EXT', ean: '669925602', qty: 5, cost: 1.81 },
      { name: 'Kuloko Gel Excitante 15g', cat: 'Géis Excitantes', code: 'HC683', ean: '714326120', qty: 2, cost: 8.01 },
      { name: 'Triple Shock Bolinhas 3un', cat: 'Bolinhas Funcionais', code: 'TS-BOL', ean: '1134727556033', qty: 4, cost: 3.18 },
      { name: 'Vibrador Golfinho - Lilás', cat: 'Vibradores', code: 'SS003-LIL', ean: '1377330607', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Pink', cat: 'Vibradores', code: 'SS003-PNK', ean: '1377330607', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Tiffany', cat: 'Vibradores', code: 'SS003-TIF', ean: '1377330607', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Verde', cat: 'Vibradores', code: 'SS003-VRD', ean: '1377330607', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Vermelho', cat: 'Vibradores', code: 'SS003-VRM', ean: '1377330607', qty: 1, cost: 5.76 },
      { name: 'Gel Hot Comestível - Tutti Frutti', cat: 'Géis Excitantes', code: 'GH15-TUT', ean: '1497832147', qty: 1, cost: 5.48 },
      { name: 'Gel Hot Comestível - Uva', cat: 'Géis Excitantes', code: 'GH15-UVA', ean: '1497832147', qty: 2, cost: 5.48 },
      { name: 'Gel Hot Comestível - Morango Champagne', cat: 'Géis Excitantes', code: 'GH15-MOR', ean: '1497832147', qty: 1, cost: 5.48 },
      { name: 'Pênis Aromático 14cm - Tangerina', cat: 'Próteses', code: 'TORSVA-TAN', ean: '1502832231', qty: 1, cost: 10.23 },
      { name: 'Pênis Aromático 14cm - Menta', cat: 'Próteses', code: 'TORSVA-MEN', ean: '1502832231', qty: 1, cost: 10.23 },
      { name: 'Six Ball Black Ice 6un', cat: 'Bolinhas Funcionais', code: '1086', ean: '1510132379', qty: 2, cost: 1.99 },
      { name: 'Power Kiss Jatos - Cereja', cat: 'Aromáticos', code: '104-CER', ean: '1511932403', qty: 2, cost: 3.99 },
      { name: 'Power Kiss Jatos - Black Ice', cat: 'Aromáticos', code: '104-BLK', ean: '1511932403', qty: 2, cost: 3.99 },
      { name: 'Pop Lub Gel Corporal 60g', cat: 'Lubrificantes', code: 'SS012', ean: '1526032627', qty: 3, cost: 3.36 },
      { name: 'Pop Ball Beijável - Morango', cat: 'Lubrificantes', code: 'HC18-MOR', ean: '1779035843', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Beijável - Menta', cat: 'Lubrificantes', code: 'HC18-MEN', ean: '1779035843', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Beijável - Uva', cat: 'Lubrificantes', code: 'HC18-UVA', ean: '1779035843', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Beijável - Frutas Vermelhas', cat: 'Lubrificantes', code: 'HC18-FRV', ean: '1779035843', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Ice', cat: 'Lubrificantes', code: 'HC192', ean: '1779135844', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Hot Ice', cat: 'Lubrificantes', code: 'HC193', ean: '1779335846', qty: 6, cost: 2.72 },
      { name: 'Plug Anal Coração - Roxo', cat: 'Anal', code: 'T002-ROX', ean: '1808236211', qty: 2, cost: 3.20 },
      { name: 'Plug Anal Coração - Rosa', cat: 'Anal', code: 'T002-ROS', ean: '1808236211', qty: 2, cost: 3.20 },
      // === NF 016046 - Novos produtos ===
      { name: 'Anel Vibrador Bichinho - Rosa', cat: 'Anéis Penianos', code: '03138-ROSA', qty: 5, cost: 2.70 },
      { name: 'Vibrador Golfinho - Roxo', cat: 'Vibradores', code: '76175-ROXO', qty: 8, cost: 5.99 },
      { name: 'Gotas Afrodisíacas 20ml Klab', cat: 'Estimulantes Orais', code: '4310', qty: 4, cost: 3.90 },
      { name: 'Papermint Lâminas - Extra Forte 2', cat: 'Acessórios', code: '4284-EXT2', qty: 4, cost: 2.50 },
      { name: 'Papermint Lâminas - Menta 2', cat: 'Acessórios', code: '4284-MEN2', qty: 3, cost: 2.50 },
      { name: 'Papermint Lâminas - Morango 2', cat: 'Acessórios', code: '4284-MOR2', qty: 3, cost: 2.50 },
      { name: 'Calcinha Tailandesa - Preta', cat: 'Lingeries', code: '56794-PRETO', qty: 4, cost: 11.24 },
      { name: 'Calcinha Tailandesa - Vermelha', cat: 'Lingeries', code: '56794-VERM', qty: 4, cost: 11.24 },
      { name: 'Egg Clicker Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-CLICK', qty: 1, cost: 4.99 },
      { name: 'Egg Silky Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-SILKY', qty: 1, cost: 4.99 },
      { name: 'Egg Spider Sensual Love 2', cat: 'Estimuladores Masculinos', code: '02535-SPIDER2', qty: 1, cost: 4.99 },
      { name: 'Egg Stepper Sensual Love 2', cat: 'Estimuladores Masculinos', code: '02535-STEP2', qty: 1, cost: 4.99 },
      { name: 'Egg Twister Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-TWIST', qty: 1, cost: 4.99 },
      { name: 'Egg Wavy Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-WAVY', qty: 1, cost: 4.99 },
      { name: 'Sabonete Íntimo Babaloob 150ml', cat: 'Higiene Íntima', code: '11746', qty: 1, cost: 4.55 },
      { name: 'Perfume de Calcinha Beijável 40ml', cat: 'Aromáticos', code: '15742', qty: 4, cost: 6.12 },
      { name: 'Bolinha Satisfaction Duo 2un', cat: 'Bolinhas Funcionais', code: '70526', qty: 4, cost: 3.55 },
      { name: 'Bolinha Beijável Yummy - Morango Hot', cat: 'Bolinhas Funcionais', code: '95171-MOR', qty: 3, cost: 4.45 },
      { name: 'Bolinha Kiss Me Hot - Uva 3un', cat: 'Bolinhas Funcionais', code: '72288-UVA', qty: 2, cost: 3.52 },
      { name: 'Bolinha Kiss Me Hot - Morango 3un', cat: 'Bolinhas Funcionais', code: '72288-MOR', qty: 2, cost: 3.52 },
      { name: 'Bolinha Satisfaction Segredos 2un', cat: 'Bolinhas Funcionais', code: '85695', qty: 3, cost: 3.55 },
      { name: 'Plug Anal P - Azul', cat: 'Anal', code: '03124-AZUL', qty: 4, cost: 9.40 },
      { name: 'Gel Glow Virilha 250ml - Tutti Frutti', cat: 'Géis Excitantes', code: '58135-TUT', qty: 1, cost: 5.99 },
      { name: 'Creme Gel Virilha 240ml - Menta Ice', cat: 'Géis Excitantes', code: '33666-MEN', qty: 1, cost: 12.90 },
    ];

    db.exec('BEGIN');
    for (const p of products) {
      const costCents = brl(p.cost);
      const pricing = simulatePricing(costCents, rule);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);
      const info = db.prepare(`INSERT INTO products (
        name, category, default_supplier_id, internal_code, barcode, unit,
        last_purchase_cost_cents, min_price_cents, ideal_price_cents, promo_price_cents, low_stock_threshold
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        p.name, p.cat, supplierId, p.code, p.ean || null, 'unidade',
        costCents, pricing.min_price_cents, pricing.recommended_price_cents, promoPrice, 2
      );
      const productId = info.lastInsertRowid;
      const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
        .run(productId, supplierId, p.qty, costCents, CEO_ID);
      db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
        .run(productId, lotInfo.lastInsertRowid, 'entrada_compra', p.qty, p.qty, 'Compra SexShop Atacadão', CEO_ID);
    }
    db.exec('COMMIT');
    console.log('[AutoSeed] ✅ ' + products.length + ' produtos');

    // === REVENDEDORAS ===
    const resellers = [
      { name: 'Yasmin', phone: '(16) 99443-6541', commission: 0.30 },
      { name: 'Flavia', phone: '(16) 99418-1014', commission: 0.30 },
      { name: 'Larissa', phone: '(16) 99401-9877', commission: 0.25 },
      { name: 'Taina', phone: '(16) 99398-0297', commission: 0.25 },
      { name: 'Luana', phone: '(16) 99355-6560', commission: 0.25 },
      { name: 'Gizelle', phone: '(16) 99293-9887', commission: 0.25 },
    ];

    db.exec('BEGIN');
    for (const r of resellers) {
      const rInfo = db.prepare('INSERT INTO resellers (name, phone, status, commission_pct, created_by) VALUES (?,?,?,?,?)')
        .run(r.name, r.phone, 'ativa', r.commission, CEO_ID);
      const username = r.name.toLowerCase();
      let uname = username; let n = 1;
      while (db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) { n++; uname = username + n; }
      const { hash, salt } = hashPassword('@Sexs2026');
      db.prepare('INSERT INTO users (name, username, role, reseller_id, password_hash, password_salt) VALUES (?,?,?,?,?,?)')
        .run(r.name, uname, 'revendedora', rInfo.lastInsertRowid, hash, salt);
    }
    db.exec('COMMIT');
    console.log('[AutoSeed] ✅ ' + resellers.length + ' revendedoras');

    // === DESPESAS ===
    const expenses = [
      { category: 'Aluguel', description: 'Espaço comercial - Agosto/2026', amount: brl(1200) },
      { category: 'Embalagens', description: 'Sacolas e caixas', amount: brl(185.50) },
      { category: 'Transporte', description: 'Frete fornecedor', amount: brl(180) },
    ];
    for (const e of expenses) {
      db.prepare('INSERT INTO expenses (category, description, amount_cents, created_by) VALUES (?,?,?,?)').run(e.category, e.description, e.amount, CEO_ID);
    }
    console.log('[AutoSeed] ✅ Despesas');

    // === DICAS ===
    const tips = [
      'Guarde os produtos em local seco e longe de luz direta.',
      'Informe a venda assim que acontecer para não esquecer.',
      'Divulgue no WhatsApp com fotos dos produtos.',
    ];
    for (const t of tips) {
      if (!db.prepare('SELECT id FROM tips WHERE text = ?').get(t)) {
        db.prepare('INSERT INTO tips (text, created_by) VALUES (?,?)').run(t, CEO_ID);
      }
    }
    console.log('[AutoSeed] ✅ Dicas');
    console.log('[AutoSeed] ✅ Todos os cadastros concluídos!');
  } catch (e) {
    console.error('[AutoSeed] ERRO:', e.message);
  }
}

module.exports = { autoSeed, forceSeed, needsSeeding };
