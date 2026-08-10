// Custo das mercadorias vendidas (CMV) — método adotado: CUSTO MÉDIO PONDERADO
// (Correção Seção 3, regra "Defina e documente o método adotado"). Calculado a
// partir de TODOS os lotes de compra (stock_lots) de um produto até o momento do
// cálculo. Alternativa não implementada: FIFO por lote individual — exigiria
// rastrear qual lote específico abasteceu qual kit, o que este MVP não faz (os
// kits debitam do saldo agregado do produto, não de um lote específico).
const db = require('../db');

function weightedAverageCostCents(productId) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(quantity_purchased * unit_cost_cents),0) as total_cost, COALESCE(SUM(quantity_purchased),0) as total_qty FROM stock_lots WHERE product_id = ?'
  ).get(productId);
  if (!row.total_qty) return 0;
  return row.total_cost / row.total_qty; // mantém casas decimais (centavos fracionários) até o arredondamento final
}

module.exports = { weightedAverageCostCents };
