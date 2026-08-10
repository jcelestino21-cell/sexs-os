// Módulo de negócio: financeiro via Renata. Duas intenções na mesma conversa —
// despesa e proposta de nova política de preço — cada uma com seu próprio risco.
const db = require('../db');
const proposalService = require('./proposalService');
const { parseExpenseMessageSmart, parsePricingProposalMessageSmart } = require('./events');
const { brlToCents, centsToBRL, simulatePricing } = require('./pricing');
const { logAudit } = require('./audit');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function handleRenataMessage({ text, userId }) {
  const pricing = await parsePricingProposalMessageSmart(text, userId);
  if (pricing.recognized) return handlePricingProposal(pricing, text, userId);

  const expense = await parseExpenseMessageSmart(text, userId);
  if (expense.recognized) return handleExpense(expense, text, userId);

  return {
    reply: pick([
      'Hmm, não entendi bem o que você precisa. 🤔\n\nEu cuido do financeiro! Posso te ajudar com:\n\n• **Despesas:** "Paguei R$ [valor] de [descrição], categoria [categoria]"\n• **Política de preço:** "Proponha comissão de [X]% e multiplicador de [Y]"\n\nMe conta o que precisa!',
      'Não consegui identificar o que você quer registrar. 😊\n\nTenta assim:\n• "Paguei R$ 300 de embalagem, categoria despesas variáveis" — pra registrar despesa\n• "Proponha comissão de 25% e multiplicador de 3.5" — pra mudar a política de preço',
    ]),
    proposal: null,
  };
}

function handleExpense(parsed, text, userId) {
  if (parsed.missing.length > 0) {
    return { reply: `Beleza, tô vendo que é uma despesa! Mas preciso de mais uns dados:\n${parsed.missing.map(m => `• ${m}`).join('\n')}\n\nPode completar?`, proposal: null };
  }
  let amountCents;
  try { amountCents = brlToCents(parsed.entities.amount_raw); }
  catch (e) { return { reply: `Não consegui entender o valor "${parsed.entities.amount_raw}". Tenta assim: "18,50" ou "18.50" 😊`, proposal: null }; }

  const extracted = { amount_cents: amountCents, description: parsed.entities.description, category: parsed.entities.category };
  const proposal = proposalService.createProposal({
    rawText: text, intent: 'registrar_despesa', extracted,
    riskLevel: 'medio', targetDirector: 'renata', userId,
  });
  return {
    reply: `Anotado! 💰\n\nDespesa de **${centsToBRL(amountCents)}**\n• Descrição: "${extracted.description}"\n• Categoria: ${extracted.category}\n\nAprova o registro?`,
    proposal,
  };
}

function executeRegistrarDespesa(extracted, proposalId, ceoUser) {
  const info = db
    .prepare('INSERT INTO expenses (category, description, amount_cents, created_by, proposal_id) VALUES (?,?,?,?,?)')
    .run(extracted.category, extracted.description, extracted.amount_cents, ceoUser.id, proposalId);
  logAudit({
    actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'expense.registered', entityType: 'expense',
    entityId: info.lastInsertRowid, details: extracted,
  });
}

function handlePricingProposal(parsed, text, userId) {
  if (parsed.missing.length > 0) {
    return { reply: `Faltam dados na proposta de política: ${parsed.missing.join(', ')}.`, proposal: null };
  }
  const current = proposalService.getActivePricingRule();
  const { commission_pct: commissionPct, cost_multiplier: costMultiplier } = parsed.entities;

  let simulatedNew, simulatedCurrent;
  try {
    simulatedNew = simulatePricing(1000, { cost_multiplier: costMultiplier, commission_pct: commissionPct, premium_multiplier: current.premium_multiplier });
    simulatedCurrent = simulatePricing(1000, current);
  } catch (e) {
    return { reply: `Não posso propor essa política: ${e.message}`, proposal: null };
  }

  const extracted = { commission_pct: commissionPct, cost_multiplier: costMultiplier, premium_multiplier: current.premium_multiplier };
  const impact = { current: simulatedCurrent, proposed: simulatedNew };

  const proposal = proposalService.createProposal({
    rawText: text, intent: 'nova_regra_precificacao', extracted, impact,
    riskLevel: 'alto', targetDirector: 'renata', userId,
  });

  const reply =
    `Proposta de nova política (Renata): comissão ${(commissionPct*100).toFixed(1)}%, multiplicador de custo x${costMultiplier}.\n\n` +
    `Exemplo com um produto de custo R$10,00:\n` +
    `• Hoje: preço ${centsToBRL(simulatedCurrent.current_price_cents)}, comissão ${centsToBRL(simulatedCurrent.commission_on_current_sale_cents)}, lucro/un ${centsToBRL(simulatedCurrent.estimated_company_net_cents)}\n` +
    `• Proposto: preço ${centsToBRL(simulatedNew.current_price_cents)}, comissão ${centsToBRL(simulatedNew.commission_on_current_sale_cents)}, lucro/un ${centsToBRL(simulatedNew.estimated_company_net_cents)}\n\n` +
    `⚠️ Isso muda o preço de TODOS os produtos a partir de agora. Aprova, ajusta ou rejeita?`;

  return { reply, proposal };
}

function executeNovaRegraPrecificacao(extracted, proposalId, ceoUser) {
  const current = proposalService.getActivePricingRule();
  db.prepare('UPDATE pricing_rules SET active = 0 WHERE id = ?').run(current.id);
  const info = db
    .prepare(
      `INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, proposed_by_director, notes, created_by)
       VALUES (?,?,?,?,1,'renata','Proposta por Renata, aprovada pela CEO.',?)`
    )
    .run(current.version + 1, extracted.cost_multiplier, extracted.commission_pct, extracted.premium_multiplier, ceoUser.id);
  logAudit({
    actorUserId: ceoUser.id, actorLabel: 'CEO', action: 'pricing_rule.changed', entityType: 'pricing_rule',
    entityId: info.lastInsertRowid, details: { previous_version: current.version, ...extracted },
  });
}

function financialSummary() {
  // Faturamento CONFIRMADO: só kits encerrados. Vendas informadas/kits em andamento
  // NUNCA entram aqui (Correção Seção 3, regra 8).
  const closedTotals = db.prepare(`
    SELECT COALESCE(SUM(total_sold_confirmed_cents),0) as revenue,
           COALESCE(SUM(total_commission_cents),0) as commission_generated,
           COALESCE(SUM(total_due_to_sexs_cents),0) as due_from_resellers,
           COALESCE(SUM(cost_of_goods_sold_cents),0) as cogs,
           COALESCE(SUM(write_off_cost_cents),0) as write_off,
           COALESCE(SUM(gross_profit_cents),0) as gross_profit,
           COUNT(*) as closed_kits
    FROM kit_closures
  `).get();

  // Valor VENDIDO INFORMADO (ainda não confirmado) — só para visibilidade, nunca
  // somado ao faturamento confirmado.
  const informed = db.prepare(`
    SELECT COALESCE(SUM(quantity * unit_price_cents),0) as total FROM kit_sales WHERE status = 'informada'
  `).get();
  const rule = db.prepare('SELECT commission_pct FROM pricing_rules WHERE active = 1 ORDER BY version DESC LIMIT 1').get();
  const estimatedCommissionOnInformed = Math.round(informed.total * (rule ? rule.commission_pct : 0.30));

  const expenseTotals = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) as total, COUNT(*) as count FROM expenses`).get();
  const stockPurchases = db.prepare(`SELECT COALESCE(SUM(quantity_purchased * unit_cost_cents),0) as total FROM stock_lots`).get();

  const commissionPaid = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) as total FROM commission_payments`).get();
  const receivedFromResellers = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) as total FROM receivable_payments`).get();

  const grossProfitCents = closedTotals.gross_profit;
  const netProfitCents = grossProfitCents - expenseTotals.total;

  const cashIn = receivedFromResellers.total;
  const cashOut = expenseTotals.total + commissionPaid.total; // estoque é investimento, não sai do caixa
  const cashBalanceCents = cashIn - cashOut;

  return {
    // Vendido / faturado
    valor_vendido_informado_cents: informed.total,
    faturamento_confirmado_cents: closedTotals.revenue,
    // Comissão — três estágios distintos, nunca confundidos (regra 9)
    comissao_estimada_cents: estimatedCommissionOnInformed,
    comissao_gerada_cents: closedTotals.commission_generated,
    comissao_paga_cents: commissionPaid.total,
    comissao_a_pagar_cents: closedTotals.commission_generated - commissionPaid.total,
    // A receber das revendedoras — nunca tratado como recebido (regra 10)
    valor_a_receber_total_cents: closedTotals.due_from_resellers,
    valor_recebido_cents: receivedFromResellers.total,
    valor_a_receber_pendente_cents: closedTotals.due_from_resellers - receivedFromResellers.total,
    // Custos e despesas
    custo_mercadorias_vendidas_cents: closedTotals.cogs,
    perdas_danos_cents: closedTotals.write_off,
    estoque_comprado_cents: stockPurchases.total,
    despesas_operacionais_cents: expenseTotals.total,
    despesas_count: expenseTotals.count,
    // Resultado
    lucro_bruto_cents: grossProfitCents,
    lucro_liquido_cents: netProfitCents,
    // Caixa (só dinheiro que de fato entrou/saiu, nunca valores meramente calculados)
    entradas_caixa_cents: cashIn,
    saidas_caixa_cents: cashOut,
    saldo_caixa_cents: cashBalanceCents,
    closed_kits: closedTotals.closed_kits,

    // Campos preservados para não quebrar quem já lia o formato anterior — serão
    // removidos numa próxima limpeza. NÃO usar em telas novas.
    // Previsão baseada em vendas informadas (ainda não fechadas)
    previsao_vendas_cents: informed.total,
    previsao_comissao_cents: estimatedCommissionOnInformed,
    previsao_receita_liquida_cents: informed.total - estimatedCommissionOnInformed,
    // Investimento em estoque (não conta como saída de caixa)
    investimento_estoque_cents: stockPurchases.total,

    revenue_confirmed_cents: closedTotals.revenue,
    commissions_paid_cents: closedTotals.commission_generated,
    due_to_sexs_cents: closedTotals.due_from_resellers,
    expenses_cents: expenseTotals.total,
    expenses_count: expenseTotals.count,
    stock_purchases_cents: stockPurchases.total,
    estimated_net_cents: netProfitCents,
  };
}

function recordCommissionPayment({ resellerId, kitId, amountCents, actorUser, notes }) {
  if (!amountCents || amountCents <= 0) throw new Error('Valor do pagamento deve ser positivo.');
  const info = db.prepare('INSERT INTO commission_payments (reseller_id, kit_id, amount_cents, created_by, notes) VALUES (?,?,?,?,?)')
    .run(resellerId, kitId || null, amountCents, actorUser.id, notes || null);
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.role === 'ceo' ? 'CEO' : 'Renata', action: 'commission.paid', entityType: 'commission_payment', entityId: info.lastInsertRowid, details: { reseller_id: resellerId, amount_cents: amountCents } });
  return db.prepare('SELECT * FROM commission_payments WHERE id = ?').get(info.lastInsertRowid);
}

function recordReceivablePayment({ resellerId, kitId, amountCents, actorUser, notes }) {
  if (!amountCents || amountCents <= 0) throw new Error('Valor do recebimento deve ser positivo.');
  const info = db.prepare('INSERT INTO receivable_payments (reseller_id, kit_id, amount_cents, created_by, notes) VALUES (?,?,?,?,?)')
    .run(resellerId, kitId || null, amountCents, actorUser.id, notes || null);
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.role === 'ceo' ? 'CEO' : 'Renata', action: 'receivable.received', entityType: 'receivable_payment', entityId: info.lastInsertRowid, details: { reseller_id: resellerId, amount_cents: amountCents } });
  return db.prepare('SELECT * FROM receivable_payments WHERE id = ?').get(info.lastInsertRowid);
}

function listCommissionPayments() { return db.prepare('SELECT cp.*, r.name as reseller_name FROM commission_payments cp JOIN resellers r ON r.id = cp.reseller_id ORDER BY cp.id DESC').all(); }
function listReceivablePayments() { return db.prepare('SELECT rp.*, r.name as reseller_name FROM receivable_payments rp JOIN resellers r ON r.id = rp.reseller_id ORDER BY rp.id DESC').all(); }

function listExpenses() {
  return db.prepare('SELECT * FROM expenses ORDER BY id DESC').all();
}

proposalService.registerMessageHandler('renata', handleRenataMessage);
proposalService.registerExecutor('registrar_despesa', executeRegistrarDespesa);
proposalService.registerExecutor('nova_regra_precificacao', executeNovaRegraPrecificacao);

module.exports = {
  financialSummary, listExpenses, handleRenataMessage,
  recordCommissionPayment, recordReceivablePayment, listCommissionPayments, listReceivablePayments,
};
