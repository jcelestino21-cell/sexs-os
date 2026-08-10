// Motor de precificação — cálculo determinístico, NUNCA feito "livremente" pela IA.
// Todos os valores monetários trafegam em centavos inteiros (evita erro de ponto flutuante).
//
// Política atual da SexS (regra padrão identificada, não uma verdade permanente):
//   preço-base = custo x3 (custo + 200%)
//   comissão da revendedora = 30% do valor efetivamente vendido
//   preço mínimo = ponto de equilíbrio: menor preço em que, mesmo pagando a comissão
//                   sobre o valor vendido, a empresa ainda cobre o custo do produto.
//   preço premium = preço-base x multiplicador configurável (padrão 1.3)

function round(cents) {
  return Math.round(cents);
}

/**
 * Simula os preços de referência para um produto a partir do custo e da regra ativa.
 * @param {number} unitCostCents - custo de aquisição unitário, em centavos.
 * @param {{cost_multiplier:number, commission_pct:number, premium_multiplier:number}} rule
 */
function simulatePricing(unitCostCents, rule) {
  if (!Number.isInteger(unitCostCents) || unitCostCents <= 0) {
    throw new Error('unitCostCents deve ser um inteiro positivo (centavos).');
  }
  const { cost_multiplier: mult, commission_pct: commissionPct, premium_multiplier: premiumMult } = rule;

  const currentPriceCents = round(unitCostCents * mult);
  // Ponto de equilíbrio: price - commissionPct*price = cost  =>  price = cost / (1 - commissionPct)
  const minPriceCents = round(unitCostCents / (1 - commissionPct));
  const recommendedPriceCents = currentPriceCents; // MVP: Renata ainda não tem política aprovada distinta
  const premiumPriceCents = round(currentPriceCents * premiumMult);

  const commissionOnCurrent = round(currentPriceCents * commissionPct);
  const companyNetOnCurrent = currentPriceCents - commissionOnCurrent - unitCostCents;

  if (currentPriceCents < minPriceCents) {
    throw new Error(
      `Configuração matematicamente inviável: preço atual (${currentPriceCents}) ` +
      `é menor que o ponto de equilíbrio (${minPriceCents}). Aumente o multiplicador de custo ` +
      `ou reduza a comissão antes de prosseguir.`
    );
  }

  return {
    unit_cost_cents: unitCostCents,
    current_price_cents: currentPriceCents,
    min_price_cents: minPriceCents,
    recommended_price_cents: recommendedPriceCents,
    premium_price_cents: premiumPriceCents,
    commission_pct: commissionPct,
    commission_on_current_sale_cents: commissionOnCurrent,
    estimated_company_net_cents: companyNetOnCurrent,
  };
}

function centsToBRL(cents) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function brlToCents(value) {
  // aceita número (18.5) ou texto em formato BR/US: "18", "18.50", "18,50", "R$ 18,00"
  if (typeof value === 'number') return round(value * 100);
  let s = String(value).trim().replace(/[^\d,.-]/g, '');
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.'); // "1.234,56" -> "1234.56"
  }
  const n = parseFloat(s);
  if (Number.isNaN(n)) throw new Error(`Valor monetário inválido: "${value}"`);
  return round(n * 100);
}

module.exports = { simulatePricing, centsToBRL, brlToCents };
