// ============================================================================
// SexS OS — Seed Completo de Cadastros
// Popula TODOS os módulos: Empresa, Fornecedores, Produtos, Estoque,
// Revendedoras, Kits, Despesas, Campanhas, Metas, Dicas e Conselho.
//
// Rode com: node scripts/seed-full.js
// ============================================================================
const db = require('../db');
const { hashPassword } = require('../src/auth');
const { simulatePricing } = require('../src/pricing');

// Regra de precificação ativa
const RULE = db.prepare('SELECT * FROM pricing_rules WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
if (!RULE) { console.error('ERRO: Nenhuma regra de precificação ativa. Rode scripts/seed.js primeiro.'); process.exit(1); }

const CEO_ID = 1; // CEO sempre ID 1

function brl(val) { return Math.round(val * 100); } // reais para centavos

// ============================================================================
// 1. DADOS DA EMPRESA
// ============================================================================
function seedCompany() {
  const existing = db.prepare('SELECT id FROM company_settings WHERE id = 1').get();
  if (existing) { console.log('  ✅ Empresa já cadastrada, mantendo.'); return; }

  db.prepare(`INSERT INTO company_settings (
    id, legal_name, trade_name, document_id, owner_name, owner_document_id,
    opening_date, registration_status, tax_regime, main_cnae, main_cnae_description,
    secondary_cnaes_json, address_zip, address_street, address_number,
    address_district, address_city, address_state, updated_by, updated_at
  ) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`).run(
    'SexS Cosméticos LTDA',
    'SexS',
    '52.841.367/0001-29',
    'Jessica Celestino',
    '485.291.838-70',
    '2024-03-15',
    'ATIVA',
    'MEI',
    '4772-5/00',
    'Comércio varejista de cosméticos, produtos de perfumaria e de higiene pessoal',
    JSON.stringify(['4773-3/00 - Comércio varejista de medicamentos']),
    '14780-120',
    'Rua 20',
    '1234',
    'Centro',
    'Barretos',
    'SP',
    CEO_ID
  );
  console.log('  ✅ Empresa cadastrada: SexS Cosméticos LTDA');
}

// ============================================================================
// 2. FORNECEDORES
// ============================================================================
function seedSuppliers() {
  const suppliers = [
    { name: 'Natura Cosméticos S.A.' },
    { name: 'Avon Brasil Ltda.' },
    { name: 'Jequiti Cosméticos' },
    { name: 'Biotipo Dermocosméticos' },
    { name: 'Essência Pura Fragrâncias' },
    { name: 'Phyto Derma Laboratórios' },
  ];

  const ids = {};
  for (const s of suppliers) {
    const existing = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(s.name);
    if (existing) {
      ids[s.name] = existing.id;
      console.log(`  ✅ Fornecedor "${s.name}" já existe (#${existing.id})`);
    } else {
      const info = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(s.name);
      ids[s.name] = info.lastInsertRowid;
      console.log(`  ✅ Fornecedor criado: ${s.name} (#${info.lastInsertRowid})`);
    }
  }
  return ids;
}

// ============================================================================
// 3. PRODUTOS + ESTOQUE (compra + movimentação)
// ============================================================================
function seedProductsAndStock(supplierIds) {
  const products = [
    // PERFUMES
    { name: 'SexS Noir Eau de Parfum 100ml', category: 'Perfumaria', brand: 'SexS',
      supplier: 'Essência Pura Fragrâncias', cost: brl(28.50), qty: 40,
      barcode: '7891000001001', internal_code: 'PERF-001',
      description: 'Perfume feminino sofisticado com notas de baunilha e jasmim.' },
    { name: 'SexS Homme Eau de Toilette 100ml', category: 'Perfumaria', brand: 'SexS',
      supplier: 'Essência Pura Fragrâncias', cost: brl(25.00), qty: 35,
      barcode: '7891000001002', internal_code: 'PERF-002',
      description: 'Perfume masculino amadeirado com toque cítrico.' },
    { name: 'SexS Flower Body Splash 200ml', category: 'Perfumaria', brand: 'SexS',
      supplier: 'Essência Pura Fragrâncias', cost: brl(15.00), qty: 50,
      barcode: '7891000001003', internal_code: 'PERF-003',
      description: 'Body splash floral leve para o dia a dia.' },
    { name: 'Colônia Acqua Fresca 150ml', category: 'Perfumaria', brand: 'Natura',
      supplier: 'Natura Cosméticos S.A.', cost: brl(32.00), qty: 30,
      barcode: '7891000001004', internal_code: 'PERF-004',
      description: 'Colônia refrescante unissex com notas aquáticas.' },

    // SKINCARE
    { name: 'Creme Hidratante Facial FPS 30 50g', category: 'Skincare', brand: 'SexS',
      supplier: 'Biotipo Dermocosméticos', cost: brl(18.00), qty: 60,
      barcode: '7891000002001', internal_code: 'SKIN-001',
      description: 'Hidratante facial com proteção solar diária.' },
    { name: 'Sérum Vitamina C 30ml', category: 'Skincare', brand: 'SexS',
      supplier: 'Phyto Derma Laboratórios', cost: brl(22.50), qty: 45,
      barcode: '7891000002002', internal_code: 'SKIN-002',
      description: 'Sérum antioxidante com vitamina C pura a 20%.' },
    { name: 'Creme Anti-Idade Noturno 50g', category: 'Skincare', brand: 'SexS',
      supplier: 'Biotipo Dermocosméticos', cost: brl(25.00), qty: 35,
      barcode: '7891000002003', internal_code: 'SKIN-003',
      description: 'Creme noturno com ácido hialurônico e retinol.' },
    { name: 'Protetor Solar Corporal FPS 50 200ml', category: 'Skincare', brand: 'Natura',
      supplier: 'Natura Cosméticos S.A.', cost: brl(20.00), qty: 55,
      barcode: '7891000002004', internal_code: 'SKIN-004',
      description: 'Proteção solar corporal de alta performance.' },

    // MAQUIAGEM
    { name: 'Batom Líquido Matte (Vermelho Paixão)', category: 'Maquiagem', brand: 'SexS',
      supplier: 'Avon Brasil Ltda.', cost: brl(8.50), qty: 80,
      barcode: '7891000003001', internal_code: 'MAQ-001',
      description: 'Batom líquido de longa duração, cor intensa.' },
    { name: 'Base Líquida Cobertura Natural 30ml', category: 'Maquiagem', brand: 'SexS',
      supplier: 'Avon Brasil Ltda.', cost: brl(14.00), qty: 50,
      barcode: '7891000003002', internal_code: 'MAQ-002',
      description: 'Base leve para uso diário, acabamento natural.' },
    { name: 'Máscara de Cílios Volume Extra', category: 'Maquiagem', brand: 'SexS',
      supplier: 'Jequiti Cosméticos', cost: brl(9.00), qty: 70,
      barcode: '7891000003003', internal_code: 'MAQ-003',
      description: 'Máscara que dá volume e alongamento.' },
    { name: 'Paleta de Sombras 12 Cores', category: 'Maquiagem', brand: 'SexS',
      supplier: 'Jequiti Cosméticos', cost: brl(16.00), qty: 40,
      barcode: '7891000003004', internal_code: 'MAQ-004',
      description: 'Paleta com tons neutros e vibrantes.' },
    { name: 'Delineador Líquido Preto', category: 'Maquiagem', brand: 'Avon',
      supplier: 'Avon Brasil Ltda.', cost: brl(6.50), qty: 90,
      barcode: '7891000003005', internal_code: 'MAQ-005',
      description: 'Delineador de ponta fina, à prova d\'água.' },

    // CABELOS
    { name: 'Shampoo Reparador 300ml', category: 'Cabelos', brand: 'SexS',
      supplier: 'Natura Cosméticos S.A.', cost: brl(10.00), qty: 65,
      barcode: '7891000004001', internal_code: 'CAB-001',
      description: 'Shampoo para cabelos danificados com queratina.' },
    { name: 'Condicionador Nutritivo 300ml', category: 'Cabelos', brand: 'SexS',
      supplier: 'Natura Cosméticos S.A.', cost: brl(11.00), qty: 60,
      barcode: '7891000004002', internal_code: 'CAB-002',
      description: 'Condicionador com óleo de argan.' },
    { name: 'Máscara Capilar Hidratante 250g', category: 'Cabelos', brand: 'SexS',
      supplier: 'Phyto Derma Laboratórios', cost: brl(13.50), qty: 45,
      barcode: '7891000004003', internal_code: 'CAB-003',
      description: 'Máscara de tratamento intensivo semanal.' },

    // CORPO
    { name: 'Hidratante Corporal Karité 400ml', category: 'Corpo', brand: 'SexS',
      supplier: 'Biotipo Dermocosméticos', cost: brl(12.00), qty: 55,
      barcode: '7891000005001', internal_code: 'CORP-001',
      description: 'Hidratante corporal com manteiga de karité.' },
    { name: 'Desodorante Roll-on 50ml', category: 'Corpo', brand: 'SexS',
      supplier: 'Jequiti Cosméticos', cost: brl(5.50), qty: 100,
      barcode: '7891000005002', internal_code: 'CORP-002',
      description: 'Desodorante 48h sem álcool.' },
    { name: 'Sabonete Líquido Corporal 250ml', category: 'Corpo', brand: 'SexS',
      supplier: 'Natura Cosméticos S.A.', cost: brl(7.00), qty: 75,
      barcode: '7891000005003', internal_code: 'CORP-003',
      description: 'Sabonete líquido com extrato de lavanda.' },

    // KITS ESPECIAIS
    { name: 'Kit Presente SexS Noir (Perfume + Hidratante)', category: 'Kits Presente', brand: 'SexS',
      supplier: 'Essência Pura Fragrâncias', cost: brl(35.00), qty: 25,
      barcode: '7891000006001', internal_code: 'KIT-001',
      description: 'Kit presente com perfume Noir 100ml + hidratante corporal 200ml.' },
    { name: 'Kit Skincare Completo (Sérum + Creme FPS + Noturno)', category: 'Kits Presente', brand: 'SexS',
      supplier: 'Phyto Derma Laboratórios', cost: brl(48.00), qty: 20,
      barcode: '7891000006002', internal_code: 'KIT-002',
      description: 'Kit skincare com 3 produtos para rotina completa.' },
  ];

  const productIds = {};
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  if (existingCount > 0) {
    console.log(`  ⚠️ Já existem ${existingCount} produtos. Pulando cadastro de produtos.`);
    const all = db.prepare('SELECT * FROM products').all();
    for (const p of all) productIds[p.name] = p.id;
    return productIds;
  }

  db.exec('BEGIN');
  try {
    for (const p of products) {
      const supplierId = supplierIds[p.supplier] || null;
      const pricing = simulatePricing(p.cost, RULE);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);

      const info = db.prepare(`INSERT INTO products (
        name, category, brand, default_supplier_id, internal_code, barcode,
        description, unit, last_purchase_cost_cents,
        min_price_cents, ideal_price_cents, promo_price_cents,
        low_stock_threshold, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        p.name, p.category, p.brand, supplierId, p.internal_code, p.barcode,
        p.description, 'unidade', p.cost,
        pricing.min_price_cents, pricing.recommended_price_cents, promoPrice,
        5, null
      );
      productIds[p.name] = info.lastInsertRowid;

      // Lote de compra
      const lotInfo = db.prepare(`INSERT INTO stock_lots (
        product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by
      ) VALUES (?,?,?,?,?)`).run(info.lastInsertRowid, supplierId, p.qty, p.cost, CEO_ID);

      // Movimentação de entrada
      db.prepare(`INSERT INTO stock_movements (
        product_id, lot_id, type, quantity, balance_after, reason, created_by
      ) VALUES (?,?,?,?,?,?,?)`).run(
        info.lastInsertRowid, lotInfo.lastInsertRowid, 'entrada_compra',
        p.qty, p.qty, 'Estoque inicial — seed completo', CEO_ID
      );
    }
    db.exec('COMMIT');
    console.log(`  ✅ ${products.length} produtos cadastrados com estoque inicial`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return productIds;
}

// ============================================================================
// 4. REVENDEDORAS (com usuário de acesso)
// ============================================================================
function seedResellers() {
  const resellers = [
    { name: 'Maria Aparecida Santos', phone: '(17) 99123-4501', address: 'Rua 14, 456 - Centro, Barretos/SP', commission: 0.30 },
    { name: 'Ana Paula Ferreira', phone: '(17) 99234-5602', address: 'Av. 31, 789 - Jockey Clube, Barretos/SP', commission: 0.30 },
    { name: 'Carla Cristina Lima', phone: '(17) 99345-6703', address: 'Rua 22, 1012 - Ibirapuera, Barretos/SP', commission: 0.30 },
    { name: 'Daiane Oliveira Silva', phone: '(17) 99456-7804', address: 'Av. 43, 234 - América, Barretos/SP', commission: 0.28 },
    { name: 'Elaine Rodrigues Costa', phone: '(17) 99567-8905', address: 'Rua 8, 567 - Aeroporto, Barretos/SP', commission: 0.30 },
    { name: 'Fernanda Souza Mendes', phone: '(17) 99678-9006', address: 'Rua 36, 890 - Marins, Barretos/SP', commission: 0.32 },
    { name: 'Gabriela Nunes Pinto', phone: '(17) 99789-0107', address: 'Av. 19, 123 - Derby, Barretos/SP', commission: 0.30 },
    { name: 'Helena Barbosa Araújo', phone: '(17) 99890-1208', address: 'Rua 28, 345 - São Francisco, Barretos/SP', commission: 0.28 },
  ];

  const resellerIds = {};
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM resellers').get().c;
  if (existingCount > 0) {
    console.log(`  ⚠️ Já existem ${existingCount} revendedoras. Pulando.`);
    const all = db.prepare('SELECT * FROM resellers').all();
    for (const r of all) resellerIds[r.name] = r.id;
    return resellerIds;
  }

  db.exec('BEGIN');
  try {
    for (const r of resellers) {
      // Criar revendedora
      const rInfo = db.prepare(`INSERT INTO resellers (
        name, phone, address, status, commission_pct, created_by
      ) VALUES (?,?,?,?,?,?)`).run(r.name, r.phone, r.address, 'ativa', r.commission, CEO_ID);
      const resellerId = rInfo.lastInsertRowid;
      resellerIds[r.name] = resellerId;

      // Criar usuário de acesso
      const firstName = r.name.split(' ')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      let username = firstName;
      let n = 1;
      while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
        n++;
        username = `${firstName}${n}`;
      }
      const password = '@Sexs2026';
      const { hash, salt } = hashPassword(password);
      db.prepare(`INSERT INTO users (name, username, role, reseller_id, password_hash, password_salt) VALUES (?,?,?,?,?,?)`)
        .run(r.name, username, 'revendedora', resellerId, hash, salt);
    }
    db.exec('COMMIT');
    console.log(`  ✅ ${resellers.length} revendedoras cadastradas com login`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return resellerIds;
}

// ============================================================================
// 5. KITS CONSIGNADOS (em vários estágios)
// ============================================================================
function seedKits(resellerIds, productIds) {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM kits').get().c;
  if (existingCount > 0) { console.log(`  ⚠️ Já existem ${existingCount} kits. Pulando.`); return; }

  const productList = Object.keys(productIds);
  const resellerList = Object.keys(resellerIds);

  // Kit 1: Entregue para Maria Aparecida (ciclo 1)
  // Kit 2: Entregue para Ana Paula (ciclo 1)
  // Kit 3: Aprovado para Carla Cristina (ciclo 1)
  // Kit 4: Sugerido para Daiane (ciclo 1)
  // Kit 5: Encerrado para Elaine (ciclo 1, já fechado)

  const kits = [
    {
      reseller: 'Maria Aparecida Santos', status: 'entregue', cycle: 1,
      items: [
        { product: 'SexS Noir Eau de Parfum 100ml', qty: 5 },
        { product: 'Creme Hidratante Facial FPS 30 50g', qty: 8 },
        { product: 'Batom Líquido Matte (Vermelho Paixão)', qty: 10 },
        { product: 'Shampoo Reparador 300ml', qty: 6 },
        { product: 'Hidratante Corporal Karité 400ml', qty: 8 },
      ]
    },
    {
      reseller: 'Ana Paula Ferreira', status: 'entregue', cycle: 1,
      items: [
        { product: 'SexS Homme Eau de Toilette 100ml', qty: 4 },
        { product: 'Sérum Vitamina C 30ml', qty: 6 },
        { product: 'Base Líquida Cobertura Natural 30ml', qty: 8 },
        { product: 'Máscara de Cílios Volume Extra', qty: 12 },
        { product: 'Desodorante Roll-on 50ml', qty: 15 },
      ]
    },
    {
      reseller: 'Carla Cristina Lima', status: 'aprovado', cycle: 1,
      items: [
        { product: 'SexS Flower Body Splash 200ml', qty: 8 },
        { product: 'Creme Anti-Idade Noturno 50g', qty: 5 },
        { product: 'Paleta de Sombras 12 Cores', qty: 6 },
        { product: 'Condicionador Nutritivo 300ml', qty: 7 },
        { product: 'Sabonete Líquido Corporal 250ml', qty: 10 },
      ]
    },
    {
      reseller: 'Daiane Oliveira Silva', status: 'sugerido', cycle: 1,
      items: [
        { product: 'Colônia Acqua Fresca 150ml', qty: 3 },
        { product: 'Protetor Solar Corporal FPS 50 200ml', qty: 6 },
        { product: 'Delineador Líquido Preto', qty: 15 },
        { product: 'Máscara Capilar Hidratante 250g', qty: 5 },
        { product: 'Kit Presente SexS Noir (Perfume + Hidratante)', qty: 3 },
      ]
    },
    {
      reseller: 'Elaine Rodrigues Costa', status: 'encerrado', cycle: 1,
      items: [
        { product: 'SexS Noir Eau de Parfum 100ml', qty: 4 },
        { product: 'Sérum Vitamina C 30ml', qty: 5 },
        { product: 'Batom Líquido Matte (Vermelho Paixão)', qty: 8 },
        { product: 'Shampoo Reparador 300ml', qty: 5 },
      ]
    },
    {
      reseller: 'Fernanda Souza Mendes', status: 'aguardando_fechamento', cycle: 1,
      items: [
        { product: 'SexS Homme Eau de Toilette 100ml', qty: 3 },
        { product: 'Creme Hidratante Facial FPS 30 50g', qty: 6 },
        { product: 'Máscara de Cílios Volume Extra', qty: 8 },
        { product: 'Condicionador Nutritivo 300ml', qty: 5 },
        { product: 'Hidratante Corporal Karité 400ml', qty: 6 },
      ]
    },
  ];

  db.exec('BEGIN');
  try {
    for (const k of kits) {
      const resellerId = resellerIds[k.reseller];
      if (!resellerId) { console.log(`  ⚠️ Revendedora "${k.reseller}" não encontrada, pulando kit.`); continue; }

      // Criar kit
      const kitInfo = db.prepare(`INSERT INTO kits (
        reseller_id, cycle_number, status, created_by, approved_by, approved_at, delivered_at, closed_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        resellerId, k.cycle, k.status, CEO_ID,
        (k.status !== 'sugerido') ? CEO_ID : null,
        (k.status !== 'sugerido') ? new Date(Date.now() - 7 * 86400000).toISOString() : null,
        (['entregue','aguardando_fechamento','encerrado'].includes(k.status)) ? new Date(Date.now() - 5 * 86400000).toISOString() : null,
        (k.status === 'encerrado') ? new Date(Date.now() - 1 * 86400000).toISOString() : null
      );
      const kitId = kitInfo.lastInsertRowid;

      for (const item of k.items) {
        const productId = productIds[item.product];
        if (!productId) { console.log(`    ⚠️ Produto "${item.product}" não encontrado, pulando item.`); continue; }

        const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
        const salePrice = product.ideal_price_cents || product.min_price_cents || brl(50);

        // Kit item
        const itemInfo = db.prepare(`INSERT INTO kit_items (
          kit_id, product_id, quantity_suggested, unit_sale_price_cents,
          quantity_delivered, quantity_available, quantity_confirmed_sold, quantity_returned
        ) VALUES (?,?,?,?,?,?,?,?)`).run(
          kitId, productId, item.qty, salePrice,
          (['entregue','aguardando_fechamento','encerrado'].includes(k.status)) ? item.qty : 0,
          (['entregue','aguardando_fechamento','encerrado'].includes(k.status)) ? item.qty : 0,
          (k.status === 'encerrado') ? Math.max(1, Math.floor(item.qty * 0.7)) : 0,
          (k.status === 'encerrado') ? Math.max(0, item.qty - Math.max(1, Math.floor(item.qty * 0.7))) : 0
        );

        // Reserva de estoque (para kits aprovados ou além)
        if (k.status !== 'sugerido') {
          db.prepare(`INSERT INTO stock_reservations (product_id, kit_id, quantity, status) VALUES (?,?,?,?)`).run(
            productId, kitId, item.qty,
            (k.status === 'encerrado') ? 'convertida' : 'ativa'
          );
        }

        // Movimentação de saída (para kits entregues ou além)
        if (['entregue','aguardando_fechamento','encerrado'].includes(k.status)) {
          const currentBal = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(productId).bal;
          const newBal = currentBal - item.qty;
          db.prepare(`INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by, proposal_id) VALUES (?,?,?,?,?,?,?)`).run(
            productId, 'saida_kit', -item.qty, newBal,
            `Kit #${kitId} entregue para ${k.reseller}`, CEO_ID, null
          );
        }

        // Vendas confirmadas (para kit encerrado)
        if (k.status === 'encerrado') {
          const soldQty = Math.max(1, Math.floor(item.qty * 0.7));
          db.prepare(`INSERT INTO kit_sales (kit_item_id, quantity, unit_price_cents, status, created_by) VALUES (?,?,?,?,?)`).run(
            itemInfo.lastInsertRowid, soldQty, salePrice, 'confirmada', CEO_ID
          );
        }
      }

      // Fechamento do kit encerrado
      if (k.status === 'encerrado') {
        const totalSold = db.prepare(`
          SELECT COALESCE(SUM(ks.quantity * ks.unit_price_cents), 0) as total
          FROM kit_sales ks JOIN kit_items ki ON ki.id = ks.kit_item_id
          WHERE ki.kit_id = ? AND ks.status = 'confirmada'
        `).get(kitId).total;
        const commission = Math.round(totalSold * 0.30);
        const due = totalSold - commission;
        // Custo estimado dos itens vendidos
        const cogs = Math.round(totalSold * 0.33); // ~1/3 do preço de venda é custo
        const grossProfit = totalSold - commission - cogs;

        db.prepare(`INSERT INTO kit_closures (
          kit_id, total_sold_confirmed_cents, total_commission_cents, total_due_to_sexs_cents,
          cost_of_goods_sold_cents, gross_profit_cents, approved_by
        ) VALUES (?,?,?,?,?,?,?)`).run(kitId, totalSold, commission, due, cogs, grossProfit, CEO_ID);
      }
    }
    db.exec('COMMIT');
    console.log(`  ✅ ${kits.length} kits consignados criados em vários estágios`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ============================================================================
// 6. DESPESAS
// ============================================================================
function seedExpenses() {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM expenses').get().c;
  if (existingCount > 0) { console.log(`  ⚠️ Já existem ${existingCount} despesas. Pulando.`); return; }

  const expenses = [
    { category: 'Aluguel', description: 'Aluguel do espaço comercial - Agosto/2026', amount: brl(1200.00) },
    { category: 'Embalagens', description: 'Compra de sacolas e caixas para kits', amount: brl(185.50) },
    { category: 'Transporte', description: 'Combustível para entregas de kits', amount: brl(320.00) },
    { category: 'Marketing', description: 'Panfletos e cartões de visita', amount: brl(250.00) },
    { category: 'Despesas Variáveis', description: 'Material de escritório e etiquetas', amount: brl(95.80) },
    { category: 'Telefone/Internet', description: 'Plano de celular empresarial', amount: brl(89.90) },
    { category: 'Embalagens', description: 'Embalagens personalizadas SexS (lote 2)', amount: brl(420.00) },
    { category: 'Transporte', description: 'Frete de compra de fornecedores', amount: brl(180.00) },
    { category: 'Contabilidade', description: 'Honorários contábeis MEI - Julho/2026', amount: brl(150.00) },
    { category: 'Despesas Variáveis', description: 'Coffee break para treinamento de revendedoras', amount: brl(165.00) },
  ];

  db.exec('BEGIN');
  try {
    for (const e of expenses) {
      db.prepare(`INSERT INTO expenses (category, description, amount_cents, created_by) VALUES (?,?,?,?)`)
        .run(e.category, e.description, e.amount, CEO_ID);
    }
    db.exec('COMMIT');
    console.log(`  ✅ ${expenses.length} despesas registradas`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ============================================================================
// 7. CAMPANHAS DE MARKETING
// ============================================================================
function seedCampaigns() {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM marketing_campaigns').get().c;
  if (existingCount > 0) { console.log(`  ⚠️ Já existem ${existingCount} campanhas. Pulando.`); return; }

  const campaigns = [
    { title: 'Agosto Dourado — Skincare com 20% OFF', start: '2026-08-01', end: '2026-08-31', status: 'ativa' },
    { title: 'Dia dos Pais SexS — Kits Masculinos', start: '2026-08-01', end: '2026-08-10', status: 'ativa' },
    { title: 'Primavera Bella — Lançamentos', start: '2026-09-15', end: '2026-10-15', status: 'planejada' },
    { title: 'Natal SexS — Presenteie com Amor', start: '2026-12-01', end: '2026-12-25', status: 'planejada' },
    { title: 'Mês da Mulher — Revendedora em Destaque', start: '2026-03-01', end: '2026-03-31', status: 'encerrada' },
  ];

  for (const c of campaigns) {
    db.prepare(`INSERT INTO marketing_campaigns (title, start_date, end_date, status, created_by) VALUES (?,?,?,?,?)`)
      .run(c.title, c.start, c.end, c.status, CEO_ID);
  }
  console.log(`  ✅ ${campaigns.length} campanhas de marketing cadastradas`);
}

// ============================================================================
// 8. METAS DE VENDAS
// ============================================================================
function seedGoals() {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM sales_goals').get().c;
  if (existingCount > 0) { console.log(`  ⚠️ Já existem ${existingCount} metas. Pulando.`); return; }

  const goals = [
    { period: '2026-08', target: brl(15000.00) },
    { period: '2026-09', target: brl(18000.00) },
    { period: '2026-10', target: brl(20000.00) },
    { period: '2026-11', target: brl(22000.00) },
    { period: '2026-12', target: brl(30000.00) },
  ];

  for (const g of goals) {
    db.prepare(`INSERT INTO sales_goals (period_label, target_cents, created_by) VALUES (?,?,?)`)
      .run(g.period, g.target, CEO_ID);
  }
  console.log(`  ✅ ${goals.length} metas de vendas definidas`);
}

// ============================================================================
// 9. DICAS PARA REVENDEDORAS
// ============================================================================
function seedExtraTips() {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM tips').get().c;
  if (existingCount >= 8) { console.log(`  ⚠️ Já existem ${existingCount} dicas suficientes. Pulando.`); return; }

  const tips = [
    'Ofereça teste dos produtos! Clientes que experimentam compram 3x mais.',
    'Mantenha um catálogo atualizado — cliente gosta de ver novidades.',
    'Anote tudo: quem comprou, quanto e quando. Isso te ajuda a lembrar de oferecer reposição.',
    'Divulgue no WhatsApp! Crie uma lista de transmissão com suas clientes.',
    'Foque nos kits presente — vendem mais e têm margem maior.',
    'No verão, protetor solar e body splash são campeões de venda!',
    'Organize seu estoque pessoal: produto parado é dinheiro parado.',
    'Peça depoimentos das suas clientes e compartilhe no Instagram.',
  ];

  // Verificar se já existem para não duplicar
  for (const t of tips) {
    const exists = db.prepare('SELECT id FROM tips WHERE text = ?').get(t);
    if (!exists) {
      db.prepare('INSERT INTO tips (text, created_by) VALUES (?,?)').run(t, CEO_ID);
    }
  }
  const newCount = db.prepare('SELECT COUNT(*) as c FROM tips').get().c;
  console.log(`  ✅ Dicas: total agora é ${newCount}`);
}

// ============================================================================
// 10. DECISÕES DO CONSELHO EXECUTIVO
// ============================================================================
function seedCouncil() {
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM council_decisions').get().c;
  if (existingCount > 0) { console.log(`  ⚠️ Já existem ${existingCount} decisões. Pulando.`); return; }

  const decisions = [
    {
      topic: 'Expansão para cidades vizinhas',
      description: 'Avaliar viabilidade de expandir atuação para Colina, Bebedouro e Jaboticabal no Q4/2026.',
      assigned_to: 'Ricardo',
      due_date: '2026-09-15',
      status: 'aberta',
    },
    {
      topic: 'Revisão da política de comissões',
      description: 'Estudar aumento de comissão para revendedoras com vendas acima de R$ 3.000/mês.',
      assigned_to: 'Renata',
      due_date: '2026-08-30',
      status: 'aberta',
    },
    {
      topic: 'Treinamento de novas revendedoras',
      description: 'Criar material de onboarding e agendar treinamento presencial para setembro.',
      assigned_to: 'Marina',
      due_date: '2026-09-01',
      status: 'aberta',
    },
    {
      topic: 'Diversificação de fornecedores',
      description: 'Cotar 3 novos fornecedores de maquiagem para reduzir dependência da Avon.',
      assigned_to: 'Diego',
      due_date: '2026-08-20',
      status: 'aberta',
    },
    {
      topic: 'Campanha de Natal antecipada',
      description: 'Planejar kits de Natal com embalagem especial e preço competitivo. Iniciar produção em outubro.',
      assigned_to: 'Theo',
      due_date: '2026-10-01',
      status: 'aberta',
    },
  ];

  for (const d of decisions) {
    db.prepare(`INSERT INTO council_decisions (topic, description, assigned_to, due_date, status, created_by) VALUES (?,?,?,?,?,?)`)
      .run(d.topic, d.description, d.assigned_to, d.due_date, d.status, CEO_ID);
  }
  console.log(`  ✅ ${decisions.length} decisões do conselho executivo criadas`);
}

// ============================================================================
// EXECUÇÃO
// ============================================================================
console.log('\n══════════════════════════════════════════════════');
console.log('  SexS OS — Seed Completo de Cadastros');
console.log('══════════════════════════════════════════════════\n');

console.log('1. 📋 Empresa');
seedCompany();

console.log('\n2. 🏭 Fornecedores');
const supplierIds = seedSuppliers();

console.log('\n3. 📦 Produtos + Estoque Inicial');
const productIds = seedProductsAndStock(supplierIds);

console.log('\n4. 👩‍💼 Revendedoras');
const resellerIds = seedResellers();

console.log('\n5. 📦 Kits Consignados');
seedKits(resellerIds, productIds);

console.log('\n6. 💸 Despesas');
seedExpenses();

console.log('\n7. 📢 Campanhas de Marketing');
seedCampaigns();

console.log('\n8. 🎯 Metas de Vendas');
seedGoals();

console.log('\n9. 💡 Dicas para Revendedoras');
seedExtraTips();

console.log('\n10. 🏛️ Conselho Executivo');
seedCouncil();

// Resumo final
console.log('\n══════════════════════════════════════════════════');
console.log('  RESUMO FINAL');
console.log('══════════════════════════════════════════════════');
console.log(`  Empresa:        ${db.prepare('SELECT COUNT(*) as c FROM company_settings').get().c}`);
console.log(`  Fornecedores:   ${db.prepare('SELECT COUNT(*) as c FROM suppliers').get().c}`);
console.log(`  Produtos:       ${db.prepare('SELECT COUNT(*) as c FROM products').get().c}`);
console.log(`  Lotes Estoque:  ${db.prepare('SELECT COUNT(*) as c FROM stock_lots').get().c}`);
console.log(`  Movimentações:  ${db.prepare('SELECT COUNT(*) as c FROM stock_movements').get().c}`);
console.log(`  Revendedoras:   ${db.prepare('SELECT COUNT(*) as c FROM resellers').get().c}`);
console.log(`  Kits:           ${db.prepare('SELECT COUNT(*) as c FROM kits').get().c}`);
console.log(`  Kit Items:      ${db.prepare('SELECT COUNT(*) as c FROM kit_items').get().c}`);
console.log(`  Despesas:       ${db.prepare('SELECT COUNT(*) as c FROM expenses').get().c}`);
console.log(`  Campanhas:      ${db.prepare('SELECT COUNT(*) as c FROM marketing_campaigns').get().c}`);
console.log(`  Metas:          ${db.prepare('SELECT COUNT(*) as c FROM sales_goals').get().c}`);
console.log(`  Dicas:          ${db.prepare('SELECT COUNT(*) as c FROM tips').get().c}`);
console.log(`  Decisões:       ${db.prepare('SELECT COUNT(*) as c FROM council_decisions').get().c}`);
console.log(`  Usuários Total: ${db.prepare('SELECT COUNT(*) as c FROM users').get().c}`);
console.log('\n  ✅ Seed completo concluído com sucesso!\n');
