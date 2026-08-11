// Kits consignados (Seção 5, "Kits, pedidos e ciclo de reposição"). Fluxo próprio,
// fora do motor genérico de propostas, porque um kit tem itens estruturados (produto +
// quantidade + preço) que não cabem bem numa mensagem de texto livre — aqui a CEO
// monta/ajusta o kit por uma tela, não por chat, o que é mais seguro e determinístico.
//
// SIMPLIFICAÇÃO DOCUMENTADA (ver RELATORIO_FINAL.md): os estados "em preparação" e
// "aguardando aprovação" existem, mas "em andamento" foi fundido com "entregue" e
// "conferido" foi fundido com o próprio ato de aprovar o fechamento.
const db = require('../db');
const { logAudit } = require('./audit');
const { getActivePricingRule } = require('./proposalService');
const { simulatePricing } = require('./pricing');
const documentService = require('./documentService');
const { weightedAverageCostCents } = require('./costCalc');
const notificationService = require('./notificationService');

function getKit(id) {
  const kit = db.prepare('SELECT * FROM kits WHERE id = ?').get(id);
  if (!kit) return null;
  const items = db
    .prepare(`SELECT ki.*, p.name as product_name FROM kit_items ki JOIN products p ON p.id = ki.product_id WHERE ki.kit_id = ?`)
    .all(id);
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(kit.reseller_id);
  return { ...kit, items, reseller };
}

function listKits({ resellerId, status } = {}) {
  let sql = 'SELECT k.*, r.name as reseller_name FROM kits k JOIN resellers r ON r.id = k.reseller_id WHERE 1=1';
  const params = [];
  if (resellerId) { sql += ' AND k.reseller_id = ?'; params.push(resellerId); }
  if (status) { sql += ' AND k.status = ?'; params.push(status); }
  sql += ' ORDER BY k.id DESC';
  return db.prepare(sql).all(...params);
}

function companyAvailableBalance(productId) {
  const row = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(productId);
  return row.bal;
}

function companyReservedBalance(productId) {
  const row = db.prepare(`SELECT COALESCE(SUM(quantity),0) as r FROM stock_reservations WHERE product_id = ? AND status = 'ativa'`).get(productId);
  return row.r;
}

/** Saldo realmente livre para reservar em um NOVO kit: físico menos o que já está
 * reservado por outros kits aprovados/em preparação ainda não entregues (Correção
 * Seção 6 — evita que dois kits sejam aprovados contra o mesmo saldo físico). */
function companyFreeForReservation(productId) {
  return companyAvailableBalance(productId) - companyReservedBalance(productId);
}

function lastKnownUnitCost(productId) {
  const row = db.prepare('SELECT unit_cost_cents FROM stock_lots WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(productId);
  return row ? row.unit_cost_cents : null;
}

/** Diego sugere um kit: lista de {product_id, quantity}. Preço de venda é calculado pela
 * política de preço vigente a partir do último custo conhecido do produto, a menos que
 * a CEO ajuste manualmente na aprovação. */
function suggestKit({ resellerId, items, userId }) {
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
  if (!reseller) throw new Error('Revendedora não encontrada.');
  if (!items || items.length === 0) throw new Error('O kit precisa ter pelo menos um item.');

  const rule = getActivePricingRule();
  const cycleRow = db.prepare('SELECT COALESCE(MAX(cycle_number),0) as m FROM kits WHERE reseller_id = ?').get(resellerId);
  const cycleNumber = cycleRow.m + 1;

  const preparedItems = items.map((it) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
    if (!product) throw new Error(`Produto #${it.product_id} não encontrado.`);
    if (!it.quantity || it.quantity <= 0) throw new Error(`Quantidade inválida para "${product.name}".`);
    const cost = lastKnownUnitCost(it.product_id);
    if (!cost) throw new Error(`"${product.name}" ainda não tem custo registrado (nenhuma compra de estoque). Registre uma compra antes de sugerir este item.`);
    
    // Se unit_sale_price_cents foi fornecido, usar ele; senão calcular
    let unit_sale_price_cents;
    if (it.unit_sale_price_cents) {
      unit_sale_price_cents = it.unit_sale_price_cents;
    } else {
      const pricing = simulatePricing(cost, rule);
      unit_sale_price_cents = pricing.current_price_cents;
    }
    
    const free = companyFreeForReservation(it.product_id);
    return {
      product_id: it.product_id, product_name: product.name, quantity: it.quantity,
      unit_sale_price_cents: unit_sale_price_cents, available_now: free,
      sufficient_stock: free >= it.quantity,
    };
  });

  db.exec('BEGIN');
  try {
    const kitInfo = db
      .prepare('INSERT INTO kits (reseller_id, cycle_number, status, created_by) VALUES (?,?,?,?)')
      .run(resellerId, cycleNumber, 'sugerido', userId);
    const kitId = kitInfo.lastInsertRowid;
    for (const it of preparedItems) {
      db.prepare(
        `INSERT INTO kit_items (kit_id, product_id, quantity_suggested, unit_sale_price_cents) VALUES (?,?,?,?)`
      ).run(kitId, it.product_id, it.quantity, it.unit_sale_price_cents);
    }
    logAudit({ actorUserId: userId, actorLabel: 'Diego (sugestão)', action: 'kit.suggested', entityType: 'kit', entityId: kitId, details: { reseller_id: resellerId, items: preparedItems } });
    db.exec('COMMIT');
    return getKit(kitId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function approveKit(kitId, ceoUser) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (kit.status !== 'sugerido') throw new Error(`Kit já está em status "${kit.status}".`);

  db.exec('BEGIN');
  try {
    for (const item of kit.items) {
      const free = companyFreeForReservation(item.product_id);
      if (free < item.quantity_suggested) {
        throw new Error(`Estoque insuficiente de "${item.product_name}": livre para reserva ${free} (já há reserva de outros kits), sugerido ${item.quantity_suggested}.`);
      }
    }
    for (const item of kit.items) {
      db.prepare('INSERT INTO stock_reservations (product_id, kit_id, quantity, status) VALUES (?,?,?,\'ativa\')')
        .run(item.product_id, kitId, item.quantity_suggested);
    }
    db.prepare(`UPDATE kits SET status = 'aprovado', approved_by = ?, approved_at = datetime('now') WHERE id = ?`).run(ceoUser.id, kitId);
    
    // Dar baixa automática nos pedidos pendentes da revendedora
    for (const item of kit.items) {
      let kitQuantity = item.quantity_suggested;
      
      const pendingOrders = db.prepare(`
        SELECT id, quantity_requested 
        FROM reseller_orders 
        WHERE reseller_id = ? 
          AND product_id = ? 
          AND status = 'pendente'
        ORDER BY created_at ASC
      `).all(kit.reseller_id, item.product_id);
      
      for (const order of pendingOrders) {
        if (kitQuantity <= 0) break;
        
        const quantityToFulfill = Math.min(kitQuantity, order.quantity_requested);
        const remainingQuantity = order.quantity_requested - quantityToFulfill;
        
        if (remainingQuantity === 0) {
          db.prepare(`
            UPDATE reseller_orders 
            SET status = 'atendido', 
                quantity_fulfilled = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(quantityToFulfill, order.id);
        } else {
          db.prepare(`
            UPDATE reseller_orders 
            SET quantity_requested = ?,
                quantity_fulfilled = COALESCE(quantity_fulfilled, 0) + ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(remainingQuantity, quantityToFulfill, order.id);
        }
        
        kitQuantity -= quantityToFulfill;
      }
    }
    
    logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit.approved', entityType: 'kit', entityId: kitId, details: { reserved: kit.items.map(i => ({ product_id: i.product_id, quantity: i.quantity_suggested })) } });
    db.exec('COMMIT');
    return getKit(kitId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function releaseReservations(kitId, ceoUser, reason) {
  db.prepare(`UPDATE stock_reservations SET status = 'liberada', released_at = datetime('now') WHERE kit_id = ? AND status = 'ativa'`).run(kitId);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit.reservation_released', entityType: 'kit', entityId: kitId, details: { reason } });
}

function rejectKit(kitId, ceoUser, reason) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (kit.status !== 'sugerido') throw new Error(`Kit já está em status "${kit.status}".`);
  db.prepare(`UPDATE kits SET status = 'rejeitado' WHERE id = ?`).run(kitId);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit.rejected', entityType: 'kit', entityId: kitId, details: { reason } });
  return getKit(kitId);
}

/** Cancela um kit já aprovado (mas ainda não entregue), liberando a reserva de
 * estoque corretamente — sem isso, o estoque ficaria "preso" para sempre. */
function cancelApprovedKit(kitId, ceoUser, reason) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (!['aprovado', 'em_preparacao'].includes(kit.status)) throw new Error(`Só é possível cancelar um kit aprovado ainda não entregue (status atual: "${kit.status}").`);
  db.exec('BEGIN');
  try {
    releaseReservations(kitId, ceoUser, reason || 'Kit cancelado antes da entrega.');
    db.prepare(`UPDATE kits SET status = 'rejeitado' WHERE id = ?`).run(kitId);
    db.exec('COMMIT');
    return getKit(kitId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function startPreparation(kitId, ceoUser) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (kit.status !== 'aprovado') throw new Error(`Kit já está em status "${kit.status}".`);
  db.prepare(`UPDATE kits SET status = 'em_preparacao' WHERE id = ?`).run(kitId);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit.preparation_started', entityType: 'kit', entityId: kitId });
  return getKit(kitId);
}

/** Confirma a entrega física: converte a reserva em saída real de estoque (a
 * reserva já garantia que este saldo não seria usado por outro kit) e credita o
 * saldo consignado no kit, tudo em uma transação. */
function confirmDelivery(kitId, ceoUser) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (!['aprovado', 'em_preparacao'].includes(kit.status)) throw new Error(`Kit já está em status "${kit.status}".`);

  db.exec('BEGIN');
  try {
    for (const item of kit.items) {
      const reserved = db.prepare(`SELECT COALESCE(SUM(quantity),0) as r FROM stock_reservations WHERE kit_id = ? AND product_id = ? AND status = 'ativa'`).get(kitId, item.product_id);
      if (reserved.r < item.quantity_suggested) {
        throw new Error(`Reserva de estoque de "${item.product_name}" inconsistente — entre em contato com o suporte antes de prosseguir.`);
      }
      const available = companyAvailableBalance(item.product_id);
      const newBalance = available - item.quantity_suggested;
      db.prepare(
        `INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by)
         VALUES (?, 'entrega_kit', ?, ?, ?, ?)`
      ).run(item.product_id, -item.quantity_suggested, newBalance, `Entrega do kit #${kitId}`, ceoUser.id);

      db.prepare(
        `UPDATE kit_items SET quantity_delivered = ?, quantity_available = ? WHERE id = ?`
      ).run(item.quantity_suggested, item.quantity_suggested, item.id);
    }
    db.prepare(`UPDATE stock_reservations SET status = 'convertida', released_at = datetime('now') WHERE kit_id = ? AND status = 'ativa'`).run(kitId);
    db.prepare(`UPDATE kits SET status = 'entregue', delivered_at = datetime('now') WHERE id = ?`).run(kitId);
    logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit.delivered', entityType: 'kit', entityId: kitId });

    const productNames = {};
    for (const item of kit.items) productNames[item.product_id] = item.product_name;
    documentService.generateDeliveryDocument(kit, kit.reseller, kit.items, productNames, ceoUser.id);

    db.exec('COMMIT');
    return getKit(kitId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Revendedora informa uma venda de um item do kit. Nunca deixa vender além do saldo. */
function informSale({ kitItemId, quantity, resellerUser }) {
  const item = db.prepare('SELECT * FROM kit_items WHERE id = ?').get(kitItemId);
  if (!item) throw new Error('Item de kit não encontrado.');
  const kit = getKit(item.kit_id);
  if (kit.reseller_id !== resellerUser.reseller_id) throw new Error('Este kit não pertence a você.');
  if (kit.status !== 'entregue') throw new Error(`Este kit está em status "${kit.status}" e não aceita novas vendas informadas.`);
  if (!quantity || quantity <= 0) throw new Error('Quantidade inválida.');
  if (quantity > item.quantity_available) {
    throw new Error(`Você não pode informar a venda de ${quantity} unidades: só há ${item.quantity_available} disponíveis neste item.`);
  }

  db.exec('BEGIN');
  try {
    const saleInfo = db
      .prepare('INSERT INTO kit_sales (kit_item_id, quantity, unit_price_cents, created_by) VALUES (?,?,?,?)')
      .run(kitItemId, quantity, item.unit_sale_price_cents, resellerUser.id);
    db.prepare(
      'UPDATE kit_items SET quantity_available = quantity_available - ?, quantity_pending_closure = quantity_pending_closure + ? WHERE id = ?'
    ).run(quantity, quantity, kitItemId);
    logAudit({ actorUserId: resellerUser.id, actorLabel: 'Revendedora', action: 'kit_sale.informed', entityType: 'kit_sale', entityId: saleInfo.lastInsertRowid, details: { kit_item_id: kitItemId, quantity } });
    notificationService.notify({
      recipientRole: 'ceo', type: 'kit_sale.informed', entityType: 'kit_sale', entityId: saleInfo.lastInsertRowid,
      message: `${kit.reseller.name} informou venda de ${quantity}x ${(kit.items.find(i => i.id === kitItemId) || {}).product_name || 'produto'} no kit #${kit.id}.`,
    });
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM kit_sales WHERE id = ?').get(saleInfo.lastInsertRowid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** CEO rejeita/corrige uma venda informada: devolve o saldo ao item sem duplicar nada. */
function decideSale(kitSaleId, action, ceoUser, note) {
  const sale = db.prepare('SELECT * FROM kit_sales WHERE id = ?').get(kitSaleId);
  if (!sale) throw new Error('Venda informada não encontrada.');
  if (sale.status !== 'informada') throw new Error(`Esta venda já está em status "${sale.status}".`);

  db.exec('BEGIN');
  try {
    if (action === 'rejeitar') {
      db.prepare('UPDATE kit_items SET quantity_pending_closure = quantity_pending_closure - ?, quantity_available = quantity_available + ? WHERE id = ?')
        .run(sale.quantity, sale.quantity, sale.kit_item_id);
      db.prepare(`UPDATE kit_sales SET status = 'rejeitada', decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ?`).run(ceoUser.id, note || null, kitSaleId);
      logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit_sale.rejected', entityType: 'kit_sale', entityId: kitSaleId, details: { note } });
    } else if (action === 'confirmar') {
      db.prepare('UPDATE kit_items SET quantity_pending_closure = quantity_pending_closure - ?, quantity_confirmed_sold = quantity_confirmed_sold + ? WHERE id = ?')
        .run(sale.quantity, sale.quantity, sale.kit_item_id);
      db.prepare(`UPDATE kit_sales SET status = 'confirmada', decided_by = ?, decided_at = datetime('now') WHERE id = ?`).run(ceoUser.id, kitSaleId);
      logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit_sale.confirmed', entityType: 'kit_sale', entityId: kitSaleId });
    } else {
      throw new Error('Ação inválida.');
    }
    db.exec('COMMIT');
    return db.prepare('SELECT * FROM kit_sales WHERE id = ?').get(kitSaleId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Sugestão inicial de conferência: pré-preenche com o que já está informado no
 * sistema (ponto de partida, não decisão automática — a CEO confere fisicamente e
 * pode mudar qualquer número antes de salvar). */
function getReconciliationDraft(kitId) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  return kit.items.map((item) => {
    const existing = db.prepare('SELECT * FROM kit_item_reconciliations WHERE kit_item_id = ?').get(item.id);
    if (existing) return { ...existing, product_name: item.product_name, quantity_delivered: item.quantity_delivered };
    const alreadyAccounted = item.quantity_confirmed_sold + item.quantity_pending_closure; // confirmada + informada
    return {
      kit_item_id: item.id, product_name: item.product_name, quantity_delivered: item.quantity_delivered,
      quantity_sold_confirmed: alreadyAccounted,
      quantity_returned: item.quantity_available, // sugestão: o que sobrou no saldo informado
      quantity_kept_authorized: 0, quantity_damaged: 0, quantity_lost: 0, quantity_divergence: 0,
      note: null, finalized: 0,
    };
  });
}

/** Salva (ou atualiza) a conferência física de um item — pode ser chamada várias
 * vezes antes de finalizar. Valida a equação de fechamento (Correção Seção 5):
 * entregue = vendido + devolvido + mantido + danificado + perdido + divergência.
 * Divergência exige observação — não pode ficar "sem tratamento". */
function saveReconciliationItem({ kitId, kitItemId, values, ceoUser }) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (kit.status !== 'aguardando_fechamento') throw new Error(`Kit está em status "${kit.status}" — só é possível conferir um kit aguardando fechamento.`);
  const item = kit.items.find((i) => i.id === kitItemId);
  if (!item) throw new Error('Item não pertence a este kit.');

  const v = {
    sold: Number(values.quantity_sold_confirmed) || 0,
    returned: Number(values.quantity_returned) || 0,
    kept: Number(values.quantity_kept_authorized) || 0,
    damaged: Number(values.quantity_damaged) || 0,
    lost: Number(values.quantity_lost) || 0,
    divergence: Number(values.quantity_divergence) || 0,
  };
  const sum = v.sold + v.returned + v.kept + v.damaged + v.lost + v.divergence;
  if (sum !== item.quantity_delivered) {
    throw new Error(`A soma (${sum}) não bate com o total entregue (${item.quantity_delivered}) de "${item.product_name}". Diferença: ${item.quantity_delivered - sum}.`);
  }
  if (v.divergence > 0 && !values.note) {
    throw new Error(`Há ${v.divergence} unidade(s) em divergência de "${item.product_name}" — explique na observação antes de salvar (a divergência não pode ficar sem tratamento).`);
  }

  const existing = db.prepare('SELECT id FROM kit_item_reconciliations WHERE kit_item_id = ?').get(kitItemId);
  if (existing) {
    db.prepare(`UPDATE kit_item_reconciliations SET quantity_sold_confirmed=?, quantity_returned=?, quantity_kept_authorized=?, quantity_damaged=?, quantity_lost=?, quantity_divergence=?, note=?, updated_at=datetime('now') WHERE id=?`)
      .run(v.sold, v.returned, v.kept, v.damaged, v.lost, v.divergence, values.note || null, existing.id);
  } else {
    db.prepare(`INSERT INTO kit_item_reconciliations (kit_id, kit_item_id, quantity_sold_confirmed, quantity_returned, quantity_kept_authorized, quantity_damaged, quantity_lost, quantity_divergence, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(kitId, kitItemId, v.sold, v.returned, v.kept, v.damaged, v.lost, v.divergence, values.note || null, ceoUser.id);
  }
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit.reconciliation_saved', entityType: 'kit_item', entityId: kitItemId, details: v });
  return getReconciliationDraft(kitId).find((r) => r.kit_item_id === kitItemId);
}

function requestClosure(kitId, actorUser) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (kit.status !== 'entregue') throw new Error(`Kit já está em status "${kit.status}".`);
  db.prepare(`UPDATE kits SET status = 'aguardando_fechamento', closure_requested_at = datetime('now') WHERE id = ?`).run(kitId);
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.role === 'ceo' ? 'CEO' : 'Revendedora', action: 'kit.closure_requested', entityType: 'kit', entityId: kitId });
  notificationService.notify({ recipientRole: 'ceo', type: 'kit.closure_requested', entityType: 'kit', entityId: kitId, message: `Kit #${kitId} (${kit.reseller.name}) está aguardando conferência e fechamento.` });
  return getKit(kitId);
}

/** Fechamento mensal: SÓ finaliza depois que TODO item tem uma conferência física
 * salva e balanceada (Correção Seção 5) — nunca presume que "não vendido" significa
 * "devolvido". Confirma vendas pelo número conferido fisicamente (reconciliando com
 * o que já estava informado — inclusive achando venda não informada), devolve ao
 * estoque só o que foi realmente devolvido, calcula CMV/comissão/valor devido e
 * consolida exatamente uma vez. */
function approveClosure(kitId, ceoUser) {
  const kit = getKit(kitId);
  if (!kit) throw new Error('Kit não encontrado.');
  if (kit.status !== 'aguardando_fechamento') throw new Error(`Kit já está em status "${kit.status}".`);
  const already = db.prepare('SELECT id FROM kit_closures WHERE kit_id = ?').get(kitId);
  if (already) throw new Error('Este kit já foi fechado — o fechamento só pode ocorrer uma vez.');

  const reconciliations = db.prepare('SELECT * FROM kit_item_reconciliations WHERE kit_id = ?').all(kitId);
  const missing = kit.items.filter((item) => !reconciliations.some((r) => r.kit_item_id === item.id));
  if (missing.length > 0) {
    throw new Error(`Ainda falta a conferência física de: ${missing.map((i) => i.product_name).join(', ')}. Salve a conferência de cada item antes de fechar.`);
  }
  for (const item of kit.items) {
    const r = reconciliations.find((x) => x.kit_item_id === item.id);
    const sum = r.quantity_sold_confirmed + r.quantity_returned + r.quantity_kept_authorized + r.quantity_damaged + r.quantity_lost + r.quantity_divergence;
    if (sum !== item.quantity_delivered) {
      throw new Error(`Conferência de "${item.product_name}" não bate mais com o total entregue — refaça antes de fechar.`);
    }
  }

  const rule = getActivePricingRule();
  const commissionPct = kit.reseller.commission_pct != null ? kit.reseller.commission_pct : rule.commission_pct;

  db.exec('BEGIN');
  try {
    let itemsReturned = 0;
    const cogsPerItem = {};
    const writeOffPerItem = {};
    for (const item of kit.items) {
      const r = reconciliations.find((x) => x.kit_item_id === item.id);
      const alreadyAccounted = item.quantity_confirmed_sold + item.quantity_pending_closure; // confirmada + informada

      if (r.quantity_sold_confirmed < item.quantity_confirmed_sold) {
        // A CEO está reduzindo abaixo do que já foi CONFIRMADO individualmente — isso
        // exige desfazer uma confirmação específica antes, não é ajustável aqui.
        throw new Error(`Conferência de "${item.product_name}" está abaixo do que já foi confirmado (${item.quantity_confirmed_sold}). Rejeite a venda específica antes, pelo painel de vendas pendentes.`);
      }
      // Confirma todas as vendas ainda "informada" deste item.
      const pendingSales = db.prepare(`SELECT * FROM kit_sales WHERE kit_item_id = ? AND status = 'informada'`).all(item.id);
      let confirmedFromInformed = 0;
      for (const sale of pendingSales) {
        db.prepare(`UPDATE kit_sales SET status = 'confirmada', decided_by = ?, decided_at = datetime('now'), note = 'Confirmada na conferência física do fechamento.' WHERE id = ?`)
          .run(ceoUser.id, sale.id);
        confirmedFromInformed += sale.quantity;
      }
      const newConfirmedTotal = item.quantity_confirmed_sold + confirmedFromInformed;
      const extraFound = r.quantity_sold_confirmed - newConfirmedTotal; // venda encontrada na conferência, não informada antes
      if (extraFound > 0) {
        db.prepare(`INSERT INTO kit_sales (kit_item_id, quantity, unit_price_cents, status, created_by, decided_by, decided_at, note) VALUES (?,?,?,'confirmada',?,?,datetime('now'),'Venda não informada, encontrada na conferência física.')`)
          .run(item.id, extraFound, item.unit_sale_price_cents, ceoUser.id, ceoUser.id);
      }

      db.prepare(`UPDATE kit_items SET quantity_confirmed_sold = ?, quantity_pending_closure = 0, quantity_available = 0, quantity_returned = ?, quantity_kept_by_reseller = ?, quantity_damaged = ?, quantity_lost = ? WHERE id = ?`)
        .run(r.quantity_sold_confirmed, r.quantity_returned, r.quantity_kept_authorized, r.quantity_damaged, r.quantity_lost, item.id);

      if (r.quantity_returned > 0) {
        const available = companyAvailableBalance(item.product_id);
        const newBalance = available + r.quantity_returned;
        db.prepare(
          `INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by)
           VALUES (?, 'devolucao', ?, ?, ?, ?)`
        ).run(item.product_id, r.quantity_returned, newBalance, `Devolução conferida fisicamente no fechamento do kit #${kitId}`, ceoUser.id);
        itemsReturned += r.quantity_returned;
      }

      const writeOffQty = r.quantity_damaged + r.quantity_lost;
      if (writeOffQty > 0) {
        // Danificado/perdido não volta ao saldo disponível (já saiu fisicamente na
        // entrega e não retorna), mas precisa ficar auditável e pesar no resultado
        // financeiro — sem isso, o custo desaparece sem rastro (Correção, checklist 15).
        const currentBalance = companyAvailableBalance(item.product_id);
        db.prepare(
          `INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by)
           VALUES (?, 'ajuste', 0, ?, ?, ?)`
        ).run(item.product_id, currentBalance, `${r.quantity_damaged} danificada(s) + ${r.quantity_lost} perdida(s) — baixa definitiva no fechamento do kit #${kitId}`, ceoUser.id);
        writeOffPerItem[item.id] = Math.round(writeOffQty * weightedAverageCostCents(item.product_id));
      }

      cogsPerItem[item.id] = Math.round(r.quantity_sold_confirmed * weightedAverageCostCents(item.product_id));
      db.prepare('UPDATE kit_item_reconciliations SET finalized = 1 WHERE id = ?').run(r.id);
    }

    const confirmedSales = db.prepare(
      `SELECT ks.* FROM kit_sales ks JOIN kit_items ki ON ki.id = ks.kit_item_id WHERE ki.kit_id = ? AND ks.status = 'confirmada'`
    ).all(kitId);
    const totalSoldCents = confirmedSales.reduce((sum, s) => sum + s.quantity * s.unit_price_cents, 0);
    const totalCommissionCents = Math.round(totalSoldCents * commissionPct);
    const totalDueCents = totalSoldCents - totalCommissionCents;
    const totalCogsCents = Object.values(cogsPerItem).reduce((s, c) => s + c, 0);
    const totalWriteOffCents = Object.values(writeOffPerItem).reduce((s, c) => s + c, 0);
    const grossProfitCents = totalSoldCents - totalCogsCents - totalCommissionCents - totalWriteOffCents;

    db.prepare(
      `INSERT INTO kit_closures (kit_id, total_sold_confirmed_cents, total_commission_cents, total_due_to_sexs_cents, cost_of_goods_sold_cents, gross_profit_cents, write_off_cost_cents, items_returned_to_stock, approved_by)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(kitId, totalSoldCents, totalCommissionCents, totalDueCents, totalCogsCents, grossProfitCents, totalWriteOffCents, itemsReturned, ceoUser.id);

    db.prepare(`UPDATE kits SET status = 'encerrado', closed_at = datetime('now') WHERE id = ?`).run(kitId);

    documentService.createDocument({
      resellerId: kit.reseller_id, type: 'fechamento', referenceId: kitId, userId: ceoUser.id,
      content: renderClosureDocument(kit, reconciliations, { totalSoldCents, totalCommissionCents, totalDueCents, totalCogsCents, grossProfitCents }),
    });

    logAudit({
      actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'kit.closed', entityType: 'kit', entityId: kitId,
      details: { total_sold_cents: totalSoldCents, total_commission_cents: totalCommissionCents, total_due_cents: totalDueCents, cogs_cents: totalCogsCents, gross_profit_cents: grossProfitCents, items_returned: itemsReturned },
    });

    db.exec('COMMIT');
    return { kit: getKit(kitId), closure: db.prepare('SELECT * FROM kit_closures WHERE kit_id = ?').get(kitId) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function renderClosureDocument(kit, reconciliations, totals) {
  const fmt = (c) => 'R$ ' + (c/100).toFixed(2);
  const lines = [
    `DOCUMENTO DE FECHAMENTO — KIT #${kit.id} (ciclo ${kit.cycle_number})`, ``,
    `Revendedora: ${kit.reseller.name}`,
    `Data do fechamento: ${new Date().toLocaleString('pt-BR')}`, ``,
    `Conferência física por item:`,
  ];
  for (const item of kit.items) {
    const r = reconciliations.find((x) => x.kit_item_id === item.id);
    lines.push(`- ${item.product_name}: entregue ${item.quantity_delivered} = vendido ${r.quantity_sold_confirmed} + devolvido ${r.quantity_returned} + mantido ${r.quantity_kept_authorized} + danificado ${r.quantity_damaged} + perdido ${r.quantity_lost} + divergência ${r.quantity_divergence}${r.note ? ` (obs: ${r.note})` : ''}`);
  }
  lines.push('', `Faturamento confirmado: ${fmt(totals.totalSoldCents)}`, `Custo das mercadorias vendidas: ${fmt(totals.totalCogsCents)}`,
    `Comissão gerada: ${fmt(totals.totalCommissionCents)}`, `Valor a receber da revendedora: ${fmt(totals.totalDueCents)}`,
    `Lucro bruto: ${fmt(totals.grossProfitCents)}`);
  return lines.join('\n');
}

function pendingSalesForReview({ kitId } = {}) {
  let sql = `SELECT ks.*, ki.kit_id, p.name as product_name FROM kit_sales ks
             JOIN kit_items ki ON ki.id = ks.kit_item_id JOIN products p ON p.id = ki.product_id
             WHERE ks.status = 'informada'`;
  const params = [];
  if (kitId) { sql += ' AND ki.kit_id = ?'; params.push(kitId); }
  sql += ' ORDER BY ks.id';
  return db.prepare(sql).all(...params);
}

/** CEO/Marina veem o ranking completo (todos os nomes e valores).
 * FASE 10.5 — CORREÇÃO: filtra revendedoras inativas. Antes incluía desativadas
 * no ranking, o que era inconsistente com o status "inativa" setado por Marina. */
function rankingFull() {
  return db.prepare(`
    SELECT r.id as reseller_id, r.name, COALESCE(SUM(ks.quantity * ks.unit_price_cents), 0) as total_cents
    FROM resellers r
    LEFT JOIN kits k ON k.reseller_id = r.id
    LEFT JOIN kit_items ki ON ki.kit_id = k.id
    LEFT JOIN kit_sales ks ON ks.kit_item_id = ki.id AND ks.status = 'confirmada'
    WHERE r.status = 'ativa'
    GROUP BY r.id ORDER BY total_cents DESC
  `).all();
}

/** Revendedora só enxerga a própria posição, nunca os nomes/valores das outras
 * (privacidade exigida na Seção 5). */
function rankingForReseller(resellerId) {
  const full = rankingFull();
  const idx = full.findIndex((r) => r.reseller_id === resellerId);
  if (idx === -1) return null;
  return { position: idx + 1, total_resellers: full.length, my_total_cents: full[idx].total_cents };
}

module.exports = {
  getKit, listKits, suggestKit, approveKit, rejectKit, cancelApprovedKit, startPreparation, confirmDelivery,
  informSale, decideSale, requestClosure, approveClosure, pendingSalesForReview,
  getReconciliationDraft, saveReconciliationItem,
  rankingFull, rankingForReseller,
};
