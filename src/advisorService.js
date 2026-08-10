// Arthur — Conselheiro Estratégico (Seção 3): cruza as análises dos outros
// departamentos e aponta o gargalo real. NÃO decide pela CEO — só sintetiza.
//
// LIMITAÇÃO DECLARADA: esta síntese é baseada em regras determinísticas sobre os
// números já calculados pelos outros módulos, não em raciocínio livre de IA (que
// exigiria uma chamada real ao modelo, indisponível neste ambiente sem internet).
const proposalService = require('./proposalService');
const dashboardService = require('./dashboardService');
const commercialService = require('./commercialService');

function fmt(cents) { return (cents/100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }

function synthesize() {
  const d = dashboardService.getDashboard();
  const perf = commercialService.performanceSnapshot();
  const findings = [];

  if (d.low_stock_products.length > 0) {
    findings.push({ severity: 3, text: `Estoque baixo em ${d.low_stock_products.length} produto(s) (${d.low_stock_products.map(p=>p.name).join(', ')}) — risco de faltar produto para os próximos kits.` });
  }
  if (d.financial.lucro_liquido_cents < 0) {
    findings.push({ severity: 3, text: `Lucro líquido confirmado está negativo (${fmt(d.financial.lucro_liquido_cents)}) — custo das mercadorias, comissão e despesas juntos superam a receita confirmada até agora.` });
  }
  if (perf.inactiveResellers.length > 0) {
    findings.push({ severity: 2, text: `${perf.inactiveResellers.length} revendedora(s) com kit entregue e nenhuma venda confirmada ainda (${perf.inactiveResellers.join(', ')}) — pode valer a pena o Ricardo dar um retorno com elas.` });
  }
  if (d.pending_proposals_count > 5) {
    findings.push({ severity: 2, text: `${d.pending_proposals_count} propostas acumuladas sem decisão — isso trava o ritmo dos diretores.` });
  }
  const kitsStuck = d.kits_by_status.aguardando_fechamento || 0;
  if (kitsStuck > 0) {
    findings.push({ severity: 1, text: `${kitsStuck} kit(s) aguardando fechamento — vale revisar antes que o ciclo seguinte comece.` });
  }

  if (findings.length === 0) {
    return { bottleneck: null, summary: 'Não identifico um gargalo crítico agora, pelos dados disponíveis. Os números estão dentro do esperado.', findings: [] };
  }

  findings.sort((a, b) => b.severity - a.severity);
  return { bottleneck: findings[0].text, summary: findings[0].text, findings };
}

function handleArthurMessage() {
  const s = synthesize();
  const lines = [s.summary];
  if (s.findings.length > 1) {
    lines.push('', 'Outros pontos que cruzei nos dados:');
    for (const f of s.findings.slice(1)) lines.push(`• ${f.text}`);
  }
  lines.push('', 'Isso é a leitura dos números — a decisão é sua.');
  return { reply: lines.join('\n'), proposal: null };
}

proposalService.registerMessageHandler('arthur', handleArthurMessage);

module.exports = { synthesize };
