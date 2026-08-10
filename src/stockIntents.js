// Módulo de negócio: compra de estoque via Diego. Registra-se no motor genérico de
// propostas (src/proposalService.js) em vez de o motor conhecer estes detalhes.
const db = require('../db');
const proposalService = require('./proposalService');
const { parsePurchaseMessageSmart } = require('./events');
const { simulatePricing, brlToCents, centsToBRL } = require('./pricing');
const { logAudit } = require('./audit');
const productService = require('./productService');
const draftService = require('./productDraftService');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function findOrPreviewProduct(name) {
  return db.prepare('SELECT * FROM products WHERE name = ? COLLATE NOCASE').get(name);
}
function findOrPreviewSupplier(name) {
  return db.prepare('SELECT * FROM suppliers WHERE name = ? COLLATE NOCASE').get(name);
}

function finalizeProductDraft(draft, userId) {
  draftService.finalizeDraft(draft.id);

  let purchaseCostCents;
  try {
    purchaseCostCents = brlToCents(draft.data.purchase_cost_raw);
  } catch (e) {
    return { reply: `Não consegui entender o valor de compra ("${draft.data.purchase_cost_raw}"). Me diz de novo, só o número — ex.: 18,50.`, proposal: null };
  }
  const quantity = parseInt(String(draft.data.quantity).replace(/\D/g, ''), 10);
  if (!quantity || quantity <= 0) {
    return { reply: `Não entendi a quantidade ("${draft.data.quantity}"). Quantas unidades chegaram, só o número?`, proposal: null };
  }

  const rule = proposalService.getActivePricingRule();
  let pricing;
  try {
    pricing = productService.computePricing(purchaseCostCents, { activeRule: rule });
  } catch (e) {
    return { reply: `Não posso cadastrar com esse custo: ${e.message}`, proposal: null };
  }

  const existingProduct = findOrPreviewProduct(draft.data.name);
  const existingSupplier = findOrPreviewSupplier(draft.data.supplier_name);

  const extracted = {
    name: draft.data.name,
    category: draft.data.category,
    brand: draft.data.brand,
    supplier_name: draft.data.supplier_name,
    purchase_cost_cents: purchaseCostCents,
    quantity,
    photo_url: draft.data.photo_url,
    product_exists: !!existingProduct,
    supplier_exists: !!existingSupplier,
  };

  const proposal = proposalService.createProposal({
    rawText: `[cadastro de produto] ${JSON.stringify(draft.data)}`, intent: 'cadastrar_produto', extracted, impact: pricing,
    riskLevel: 'baixo', targetDirector: 'diego', userId,
  });

  const lossWarning = pricing.estimated_company_net_cents <= 0
    ? `\n\n⚠️ Renata alerta: nesse custo, o preço atual (${centsToBRL(pricing.current_price_cents)}) dá lucro líquido ${pricing.estimated_company_net_cents < 0 ? 'NEGATIVO' : 'ZERO'} por unidade depois da comissão. Reveja o custo ou a política antes de aprovar.`
    : '';

  const reply =
    `Cadastro pronto — "${extracted.name}"${extracted.brand ? ` (${extracted.brand})` : ''}, categoria ${extracted.category}, ` +
    `${quantity} unidade(s) de ${extracted.supplier_name}, custo ${centsToBRL(purchaseCostCents)}/un.\n\n` +
    `Renata calculou:\n` +
    `• Preço mínimo (ponto de equilíbrio): ${centsToBRL(pricing.min_price_cents)}\n` +
    `• Preço ideal: ${centsToBRL(pricing.recommended_price_cents)}\n` +
    `• Preço promocional seguro: ${centsToBRL(pricing.promo_price_cents)}\n` +
    `• Comissão da revendedora (30% do preço ideal): ${centsToBRL(pricing.commission_on_current_sale_cents)}\n` +
    `• Lucro líquido por unidade: ${centsToBRL(pricing.estimated_company_net_cents)}` +
    lossWarning +
    `\n\nAprova o cadastro?`;

  return { reply, proposal };
}

function executeCadastrarProduto(extracted, proposalId, ceoUser) {
  const rule = proposalService.getActivePricingRule();
  const { product } = productService.upsertProduct({
    name: extracted.name, category: extracted.category, brand: extracted.brand,
    supplier_name: extracted.supplier_name, purchase_cost_cents: extracted.purchase_cost_cents,
    photo_url: extracted.photo_url && extracted.photo_url !== '(sem foto)' ? extracted.photo_url : null,
  }, ceoUser, rule);

  const supplier = productService.findSupplierByName(extracted.supplier_name);
  const lotInfo = db.prepare(
    `INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by, proposal_id) VALUES (?,?,?,?,?,?)`
  ).run(product.id, supplier.id, extracted.quantity, extracted.purchase_cost_cents, ceoUser.id, proposalId);

  const currentBalanceRow = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(product.id);
  const newBalance = currentBalanceRow.bal + extracted.quantity;
  const movInfo = db.prepare(
    `INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by, proposal_id) VALUES (?,?,'entrada',?,?,?,?,?)`
  ).run(product.id, lotInfo.lastInsertRowid, extracted.quantity, newBalance, `Cadastro de novo produto (proposta #${proposalId})`, ceoUser.id, proposalId);

  logAudit({
    actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'stock.entrada', entityType: 'stock_movement',
    entityId: movInfo.lastInsertRowid, details: { product_id: product.id, quantity: extracted.quantity, new_balance: newBalance },
  });
}

async function handleDiegoMessage({ text, userId }) {
  // ---------------------------------------------------------------------------
  // Cadastro Mestre de Produtos — fluxo conversacional (uma pergunta por vez).
  // Verificado ANTES do parser de compra normal: se há um cadastro em andamento,
  // a mensagem atual é a resposta à última pergunta feita, não uma nova compra.
  // ---------------------------------------------------------------------------
  const activeDraft = draftService.getActiveDraft(userId);
  if (activeDraft) {
    if (draftService.isCancelTrigger(text)) {
      draftService.cancelDraft(activeDraft.id);
      return { reply: 'Combinado, cancelei o cadastro desse produto.', proposal: null };
    }
    const pendingField = draftService.nextMissingField(activeDraft);
    const updated = draftService.answerField(activeDraft, pendingField, text);
    const next = draftService.nextMissingField(updated);
    if (next) {
      return { reply: draftService.FIELD_QUESTIONS[next], proposal: null };
    }
    return finalizeProductDraft(updated, userId);
  }
  if (draftService.isStartTrigger(text)) {
    const draft = draftService.startDraft(userId);
    const firstField = draftService.nextMissingField(draft);
    return { reply: `Perfeito. Vamos cadastrá-lo. ${draftService.FIELD_QUESTIONS[firstField]}`, proposal: null };
  }

  const parsed = await parsePurchaseMessageSmart(text, userId);

  if (!parsed.recognized) {
    return {
      reply: pick([
        'Hmm, não entendi bem o que você quis dizer. 🤔\n\nPra comprar estoque, tenta assim:\n"Comprei 50 unidades do [produto] por R$ [preço] cada, do fornecedor [nome]."\n\nOu se for cadastrar um produto novo, diz "produto novo" que eu te guio!',
        'Não peguei essa, me desculpa! 😅\n\nEu entendo compra de estoque assim:\n"Comprei [quantidade] do [produto] por R$ [preço] cada, do fornecedor [nome]."\n\nOu fala "produto novo" pra cadastrar um item novo no catálogo.',
      ]),
      proposal: null,
    };
  }

  if (parsed.missing.length > 0) {
    return {
      reply: `Beleza, tô vendo que é uma compra de estoque! Mas preciso de mais alguns dados:\n\n${parsed.missing.map(m => `• ${m}`).join('\n')}\n\nPode completar? 😊`,
      proposal: null,
    };
  }

  let unitCostCents;
  try {
    unitCostCents = brlToCents(parsed.entities.unit_price_raw);
  } catch (e) {
    return { reply: `Não consegui interpretar o valor informado: ${e.message}`, proposal: null };
  }

  const rule = proposalService.getActivePricingRule();
  const policyNote = rule.proposed_by_director === 'renata'
    ? `(política aprovada por Renata, v${rule.version})`
    : '(Renata ainda não tem política própria aprovada — usando a política padrão identificada)';
  let pricing;
  try {
    pricing = simulatePricing(unitCostCents, rule);
  } catch (e) {
    return { reply: `Não posso propor essa compra: ${e.message}`, proposal: null };
  }

  const existingProduct = findOrPreviewProduct(parsed.entities.product_name);
  const existingSupplier = findOrPreviewSupplier(parsed.entities.supplier_name);

  const extracted = {
    quantity: parsed.entities.quantity,
    product_name: parsed.entities.product_name,
    supplier_name: parsed.entities.supplier_name,
    unit_cost_cents: unitCostCents,
    product_exists: !!existingProduct,
    supplier_exists: !!existingSupplier,
  };

  const proposal = proposalService.createProposal({
    rawText: text, intent: 'compra_estoque', extracted, impact: pricing,
    riskLevel: 'medio', targetDirector: 'diego', userId,
  });

  const productNote = existingProduct ? '(produto já cadastrado)' : '(novo produto será criado)';
  const supplierNote = existingSupplier ? '(fornecedor já cadastrado)' : '(novo fornecedor será criado)';

  const reply =
    `Show, anotei tudo! 📦\n\n` +
    `Entrada de **${extracted.quantity} unidades** de "${extracted.product_name}" ${productNote},\n` +
    `custo ${centsToBRL(unitCostCents)}/un, fornecedor "${extracted.supplier_name}" ${supplierNote}.\n\n` +
    `A Renata já calculou os preços pela política atual (custo x${rule.cost_multiplier}, comissão ${(rule.commission_pct * 100).toFixed(0)}%):\n\n` +
    `• 💰 Preço de venda: ${centsToBRL(pricing.current_price_cents)}\n` +
    `• 🛡️ Preço mínimo (ponto de equilíbrio): ${centsToBRL(pricing.min_price_cents)}\n` +
    `• ⭐ Preço premium: ${centsToBRL(pricing.premium_price_cents)}\n` +
    `• 👩‍💼 Comissão da revendedora: ${centsToBRL(pricing.commission_on_current_sale_cents)}/un\n` +
    `• 📈 Lucro da empresa por unidade: ${centsToBRL(pricing.estimated_company_net_cents)}\n\n` +
    `Isso é só uma proposta — nada foi gravado ainda. Aprova, quer ajustar algo, ou rejeita?`;

  return { reply, proposal };
}

function executeCompraEstoque(extracted, proposalId, ceoUser) {
  let product = findOrPreviewProduct(extracted.product_name);
  if (!product) {
    db.prepare('INSERT INTO products (name) VALUES (?)').run(extracted.product_name);
    product = findOrPreviewProduct(extracted.product_name);
    logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO (via proposta)', action: 'product.created', entityType: 'product', entityId: product.id, details: { name: product.name } });
  }

  let supplier = findOrPreviewSupplier(extracted.supplier_name);
  if (!supplier) {
    db.prepare('INSERT INTO suppliers (name) VALUES (?)').run(extracted.supplier_name);
    supplier = findOrPreviewSupplier(extracted.supplier_name);
    logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO (via proposta)', action: 'supplier.created', entityType: 'supplier', entityId: supplier.id, details: { name: supplier.name } });
  }

  const lotInfo = db
    .prepare(
      `INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by, proposal_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(product.id, supplier.id, extracted.quantity, extracted.unit_cost_cents, ceoUser.id, proposalId);
  const lotId = lotInfo.lastInsertRowid;

  const currentBalanceRow = db
    .prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?')
    .get(product.id);
  const newBalance = currentBalanceRow.bal + extracted.quantity;

  const movInfo = db
    .prepare(
      `INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by, proposal_id)
       VALUES (?, ?, 'entrada', ?, ?, ?, ?, ?)`
    )
    .run(product.id, lotId, extracted.quantity, newBalance, `Compra aprovada (proposta #${proposalId})`, ceoUser.id, proposalId);

  // FASE 10.5 — Atualizar custo e preços no cadastro do produto
  const rule = proposalService.getActivePricingRule();
  const pricing = simulatePricing(extracted.unit_cost_cents, rule);
  db.prepare(`UPDATE products SET last_purchase_cost_cents = ?, default_supplier_id = ?, min_price_cents = ?, ideal_price_cents = ?, promo_price_cents = ? WHERE id = ?`)
    .run(extracted.unit_cost_cents, supplier.id, pricing.min_price_cents, pricing.current_price_cents, pricing.premium_price_cents, product.id);

  logAudit({
    actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'stock.entrada', entityType: 'stock_movement',
    entityId: movInfo.lastInsertRowid, details: { product_id: product.id, quantity: extracted.quantity, new_balance: newBalance, lot_id: lotId },
  });
}

proposalService.registerMessageHandler('diego', handleDiegoMessage);
proposalService.registerExecutor('compra_estoque', executeCompraEstoque);
proposalService.registerExecutor('cadastrar_produto', executeCadastrarProduto);

module.exports = {};
