// ============================================================================
// SexS OS — Inteligência de Compra ao fornecedor
// ----------------------------------------------------------------------------
// O que esta tela responde, na ordem em que a CEO pensa:
//   1. o que pedir (quantidade),
//   2. em qual fornecedor cada linha está mais barata,
//   3. onde montar o carrinho (agrupado por fornecedor, com o link já pronto),
//   4. para qual revendedora vai cada unidade.
//
// Decisões que são do desenho, não do acaso:
//  · a quantidade vem do simulador de kit (kitPlanService) — mesma conta que já
//    decide "pendente + reposição do que vendeu − o que está parado na bolsa".
//    Não há segunda régua de compra escondida aqui; se o simulador mudar, a aba
//    muda junto;
//  · produto SEM vínculo com fornecedor não fica de fora: ele é precificado pelo
//    histórico de venda das revendedoras (o que a gente já vendeu dele, com quem,
//    e o último custo que a CEO pagou) e entra na lista com a marca
//    "sem preço do fornecedor", nunca como se tivesse comparação;
//  · preço de fornecedor é SEMPRE lido com carimbo de hora. Site de terceiros
//    muda, sai do ar, nos bloqueia — neste caso a linha conserva a última leitura
//    válida e avisa que é antiga; o carrinho jamais some por causa disso;
//  · nada aqui escreve em products.ideal_price_cents, estoque ou despesa. O
//    refresh só atualiza observed_* da tabela de vínculos, que é cache de leitura.
// ============================================================================
const db = require('../db');
const kitPlanService = require('./kitPlanService');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const PRAZO_FRESCO_MINUTOS = 24 * 60;     // o que foi lido hoje é confiável; o de ontem já merece aviso
const MESES_HISTORICO = 1;                // ela definiu: um pedido tem que cobrir 1 mês de venda

const brl = (s) => {
  const n = Number(String(s || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

/** Vínculos gravados, por produto e fornecedor. */
function linksPorProduto() {
  const rows = db.prepare(`
    SELECT psl.*, p.name AS product_name, p.internal_code, p.last_purchase_cost_cents, p.active
    FROM product_supplier_links psl JOIN products p ON p.id = psl.product_id
    ORDER BY psl.product_id, psl.supplier`).all();
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.product_id)) out.set(r.product_id, {});
    out.get(r.product_id)[r.supplier] = r;
  }
  return out;
}

/** Velocidade de saída por revendedora — é isso que cobre o que não tem vínculo.
 * Contamos vendas CONFIRMADAS com data, então dá para falar "unidades por mês"
 * em vez de um acumulado que não diz nada. */
function historicoVendas() {
  const rows = db.prepare(`
    SELECT k.reseller_id, r.name AS reseller, ki.product_id,
           SUM(ks.quantity) AS unidades,
           SUM(ks.quantity * ks.unit_price_cents) AS receita_cents,
           MIN(substr(ks.created_at,1,10)) AS de, MAX(substr(ks.created_at,1,10)) AS ate,
           COUNT(DISTINCT ks.kit_item_id) AS kits
    FROM kit_sales ks
    JOIN kit_items ki ON ki.id = ks.kit_item_id
    JOIN kits k ON k.id = ki.kit_id
    JOIN resellers r ON r.id = k.reseller_id
    WHERE ks.status = 'confirmada'
    GROUP BY k.reseller_id, ki.product_id`).all();
  const hoje = Date.now();
  const porProduto = new Map();
  for (const r of rows) {
    const dias = Math.max(1, Math.round((hoje - new Date(r.de + 'T00:00:00').getTime()) / 86400000));
    const meses = Math.max(1, +(dias / 30).toFixed(1));
    const por_mes = +(r.unidades / meses).toFixed(2);
    const linha = { reseller: r.reseller, reseller_id: r.reseller_id, unidades: r.unidades,
                    por_mes, kits: r.kits, desde: r.de, receita_cents: r.receita_cents };
    if (!porProduto.has(r.product_id)) porProduto.set(r.product_id, { linhas: [], unidades: 0, por_mes: 0, meses });
    const p = porProduto.get(r.product_id);
    p.linhas.push(linha);
    p.unidades += r.unidades;
    p.por_mes = +(p.por_mes + por_mes).toFixed(2);
    p.meses = Math.max(p.meses, meses);
  }
  for (const p of porProduto.values()) {
    p.linhas.sort((a, b) => b.por_mes - a.por_mes);   // "quem vende mais rápido esse item"
    p.cobertura_meses = MESES_HISTORICO;
    p.qtd_sugerida = Math.max(1, Math.round(p.por_mes * MESES_HISTORICO));
  }
  return porProduto;
}

/** Preço na VTEX do Atacadão a partir do link salvo (a busca por linkText é o único
 * caminho público que resolve por URL — o índice não aceita referência). */
async function lerAtacadao(url) {
  const slug = String(url || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/\/p\/?$/, '').replace(/\?.*$/, '');
  if (!slug) return { ok: false, erro: 'link salvo sem slug' };
  const alvo = 'https://www.sexshopatacadao.com.br/api/catalog_system/pub/products/search/' + encodeURIComponent(slug) + '/p?sc=1';
  const r = await fetchTimeout(alvo, { headers: { 'User-Agent': UA } });
  if (!r.ok) return { ok: false, erro: 'HTTP ' + r.status };
  let dados;
  try { dados = JSON.parse(r.texto); } catch (e) { return { ok: false, erro: 'resposta não é JSON' }; }
  if (!Array.isArray(dados) || !dados.length) return { ok: false, erro: 'produto fora do índice do fornecedor' };
  const p = dados[0];
  const itens = (p.items || []).map((it) => {
    const off = ((it.sellers || [{}])[0].commertialOffer) || {};
    return { sku_id: it.itemId,
             referencia: (it.referenceId || []).map((x) => x.Value).filter(Boolean)[0] || null,
             custo_cents: off.Price != null ? Math.round(Number(off.Price) * 100) : null,
             tabela_cents: off.ListPrice != null ? Math.round(Number(off.ListPrice) * 100) : null,
             estoque: off.AvailableQuantity, disponivel: off.IsAvailable };
  });
  // Vínculo de produto pai (sem SKU): vale o menor preço entre as variações — é o que
  // ela paga quando o sabor é indiferente, e nunca infla o custo comparado.
  const comPreco = itens.filter((i) => i.custo_cents != null);
  const melhor = comPreco.length ? comPreco.reduce((a, b) => (b.custo_cents < a.custo_cents ? b : a)) : (itens[0] || {});
  return { ok: true, titulo: p.productName, produto_id_site: p.productId, custo_cents: melhor.custo_cents ?? null,
           estoque: melhor.estoque ?? null, disponivel: melhor.disponivel !== false,
           variacoes: itens.length, mesma_price: new Set(comPreco.map((i) => i.custo_cents)).size === 1,
           referencia: melhor.referencia || null, sku_id: melhor.sku_id || null };
}

/** Preço na Gall. A busca não tem API, mas a página do produto publica o PIX no
 * bloco .prices — e é exatamente o que ela paga (conferido na página: R$ 22,99 no
 * pix = offers.price do JSON-LD). Sem quantity: a Gall só diz se está InStock. */
async function lerGall(url) {
  if (!url) return { ok: false, erro: 'link não salvo' };
  const r = await fetchTimeout(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!r.ok) return { ok: false, erro: 'HTTP ' + r.status + (r.status === 403 ? ' (bloqueio do site)' : '') };
  const h = r.texto;
  const pix = (h.match(/class="pix"[^>]*>\s*R\$\s?([\d.,]+)/) || [])[1];
  const boleto = (h.match(/prices__price[^>]*>\s*R\$\s?([\d.,]+)/) || [])[1];
  const de = (h.match(/prices__old-price[^>]*>\s*R\$\s?([\d.,]+)/) || [])[1];
  const indisponivel = /(esgotado|indispon[íi]vel|fora de estoque)/i.test(h.slice(0, 400000)) && !/InStock/.test(h);
  const titulo = ((h.match(/<title>(.*?)<\/title>/s) || [])[1] || '').replace(/\s*\|\s*Gall.*$/, '').trim();
  const custo = brl(pix);
  if (custo == null) return { ok: false, erro: 'não encontrei o preço de PIX na página', titulo: titulo.slice(0, 60) };
  return { ok: true, titulo: titulo.slice(0, 90), custo_cents: custo, boleto_cents: brl(boleto), lista_cents: brl(de),
           estoque: null, disponivel: !indisponivel };
}

async function fetchTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const texto = await res.text();
    return { ok: res.ok && res.status < 400, status: res.status, texto };
  } catch (e) {
    return { ok: false, status: 0, texto: '', erro: e.name === 'AbortError' ? 'tempo esgotado' : String(e.message || e) };
  } finally { clearTimeout(t); }
}

/** Lê os fornecedores dos produtos que pedem atenção e grava na tabela de vínculos.
 * Falhou um site? a linha conserva o valor anterior com a hora antiga (e avisa). */
async function atualizarPrecos({ only = null, limite = 60 } = {}) {
  const links = linksPorProduto();
  const alvos = [];
  for (const [pid, por] of links) {
    if (only && !only.includes(Number(pid))) continue;
    for (const sup of ['atacadao', 'gall', 'outro']) {
      const l = por[sup];
      if (!l || sup === 'outro' || !l.supplier_url) continue;
      alvos.push({ product_id: Number(pid), supplier: sup, link: l });
      if (alvos.length >= limite) break;
    }
    if (alvos.length >= limite) break;
  }
  const resultados = [];
  // 2 por vez: rajada maior já fez os dois sites recusarem antes.
  for (let i = 0; i < alvos.length; i += 2) {
    const lote = alvos.slice(i, i + 2);
    const lidos = await Promise.all(lote.map(async (a) => {
      const lido = a.supplier === 'atacadao' ? await lerAtacadao(a.link.supplier_url) : await lerGall(a.link.supplier_url);
      return { ...a, lido };
    }));
    for (const r of lidos) {
      if (r.lido.ok && r.lido.custo_cents != null) {
        db.prepare(`UPDATE product_supplier_links SET observed_cost_cents = ?, supplier_stock = COALESCE(?, supplier_stock),
                    supplier_ref = COALESCE(?, supplier_ref), sku_id = COALESCE(?, sku_id),
                    observed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
          .run(r.lido.custo_cents, r.lido.estoque, r.lido.referencia || null, r.lido.sku_id || null, r.link.id);
      }
      resultados.push({ product_id: r.product_id, fornecedor: r.supplier, ok: !!r.lido.ok,
                        custo_cents: r.lido.ok ? r.lido.custo_cents : null, estoque: r.lido.estoque ?? null,
                        erro: r.lido.erro || null,_guardado: !!(r.lido.ok && r.lido.custo_cents != null) });
    }
  }
  return { lidos: resultados.length, ok: resultados.filter((r) => r.ok).length, atualizados: resultados.filter((r) => r._guardado).length, resultados };
}

function linhaCusto(l) {
  if (!l) return null;
  const idade = l.observed_at ? Math.round((Date.now() - new Date(l.observed_at.replace(' ', 'T') + 'Z').getTime()) / 60000) : null;
  return { fornecedor: l.supplier, custo_cents: l.observed_cost_cents, estoque: l.supplier_stock,
           referencia: l.supplier_ref, url: l.supplier_url, lido_em: l.observed_at, idade_min: idade,
           velho: idade != null && idade > PRAZO_FRESCO_MINUTOS, nota: l.note };
}

function montarLista(plano, links, historico) {
  const linhas = [];
  const ja = new Set();
  const empurrar = (base, extra) => {
    const pid = base.product_id;
    const por = links.get(pid) || {};
    const custo = linhaCusto(por.atacadao);
    const gall = linhaCusto(por.gall);
    const outro = linhaCusto(por.outro);
    const opcoes = [
      custo && { ...custo, nome_fornecedor: 'Atacadão Sexy Shop' },
      gall && { ...gall, nome_fornecedor: 'Gall' },
      outro && { ...outro, nome_fornecedor: 'Mercado Livre / outro' },
    ].filter((o) => o && o.custo_cents != null);
    const hist = historico.get(pid) || null;
    let indicado = null, economia_cents = 0, custo_unit_cents = extra.custo_fallback_cents ?? null;
    if (opcoes.length) {
      opcoes.sort((a, b) => a.custo_cents - b.custo_cents);
      indicado = opcoes[0];
      custo_unit_cents = indicado.custo_cents;
      if (opcoes.length > 1) economia_cents = Math.max(0, opcoes[opcoes.length - 1].custo_cents - opcoes[0].custo_cents);
    }
    const qtdPlano = base.quantity || 0;
    const qtdHist = hist ? hist.qtd_sugerida : 0;
    // sem vínculo NENHUM, a régua que sobra é a saída real das revendedoras: cobrir 1 mês
    const qtd = opcoes.length ? (qtdPlano || qtdHist || 1) : Math.max(qtdPlano, qtdHist) || 1;
    const qtd_motivo = opcoes.length
      ? (qtdPlano ? 'simulador de kit' : 'histórico (1 mês)')
      : (qtdHist > qtdPlano ? 'histórico (1 mês) — sem vínculo com fornecedor' : 'simulador de kit');
    linhas.push({
      product_id: pid, name: base.name, quantity: qtd,
      para: base.para || (hist ? hist.linhas.map((l) => l.reseller) : []),
      custo_unit_cents, custo_total_cents: custo_unit_cents != null ? custo_unit_cents * qtd : null,
      fornecedor_indicado: indicado ? indicado.nome_fornecedor : null,
      fornecedor_ref: indicado ? indicado.referencia : null,
      fornecedor_url: indicado ? indicado.url : null,
      fornecedor_estoque: indicado ? indicado.estoque : null,
      lido_em: indicado ? indicado.lido_em : null, leitura_velha: indicado ? !!indicado.velho : false,
      economia_unit_cents: opcoes.length > 1 ? economia_cents : 0,
      economia_total_cents: opcoes.length > 1 ? economia_cents * qtd : 0,
      opcoes: opcoes.map((o) => ({ fornecedor: o.nome_fornecedor, custo_cents: o.custo_cents, estoque: o.estoque,
                                   url: o.url, lido_em: o.lido_em, velho: o.velho, nota: o.nota })),
      origem_preco: indicado ? 'fornecedor' : 'histórico',
      qtd_por_historico: qtdHist || null, qtd_motivo,
      comparavel: opcoes.length > 1,
      historico: hist ? { unidades: hist.unidades, por_mes: hist.por_mes, meses: hist.meses,
                          qtd_sugerida: hist.qtd_sugerida, por_revendedora: hist.linhas.map((l) => ({
                            revendedora: l.reseller, unidades: l.unidades, por_mes: l.por_mes, kits: l.kits, desde: l.desde })) } : null,
      custo_cadastro_cents: extra.custo_fallback_cents ?? null,
    });
    ja.add(pid);
  };

  // 1) o que o simulador de kit já decidiu comprar
  for (const b of plano.buy_list || []) {
    empurrar(b, { custo_fallback_cents: b.unit_cost_cents, internal_code: null });
  }
  return { linhas };
}

function buildPurchasePlan({ refresh = false } = {}) {
  const plano = kitPlanService.buildPlan({});
  const links = linksPorProduto();
  const historico = historicoVendas();
  const { linhas } = montarLista(plano, links, historico);

  // Fora do plano de hoje, mas com saída comprovada e sem unidade no armazém: é o
  // "vai faltar" que o simulador não lista porque nenhuma revendedora pediu ainda.
  const noPlano = new Set(linhas.map((l) => l.product_id));
  const saldos = kitPlanService.warehouseBalances();
  const giroAlto = [];
  for (const [pid, h] of historico) {
    if (noPlano.has(pid)) continue;
    const p = db.prepare('SELECT id, name, active, min_price_cents, last_purchase_cost_cents, low_stock_threshold, ideal_price_cents FROM products WHERE id = ?').get(pid);
    if (!p || !p.active) continue;
    const emMaos = saldos.get ? (saldos.get(pid) ?? 0) : (saldos[pid] ?? 0);
    if (h.por_mes < 0.5 || emMaos > Math.max(1, p.low_stock_threshold || 2)) continue;
    const por = links.get(pid) || {};
    const opc = [linhaCusto(por.atacadao), linhaCusto(por.gall), linhaCusto(por.outro)]
      .filter((o) => o && o.custo_cents != null).sort((a, b) => a.custo_cents - b.custo_cents);
    giroAlto.push({ product_id: pid, name: p.name, por_mes: h.por_mes, unidades_historico: h.unidades,
                    em_maos: emMaos, qtd_sugerida: Math.max(1, Math.round(h.por_mes * MESES_HISTORICO) - emMaos),
                    custo_unit_cents: opc.length ? opc[0].custo_cents : (p.last_purchase_cost_cents || null),
                    fornecedor_indicado: opc.length ? (opc[0].fornecedor === 'atacadao' ? 'Atacadão Sexy Shop' : opc[0].fornecedor === 'gall' ? 'Gall' : 'outro') : null,
                    url: opc.length ? opc[0].url : null, origem: opc.length ? 'fornecedor' : 'histórico',
                    por_revendedora: h.linhas.map((l) => ({ revendedora: l.reseller, unidades: l.unidades, por_mes: l.por_mes })) });
  }
  giroAlto.sort((a, b) => b.por_mes - a.por_mes);

  // Carrinho agrupado por fornecedor (o que ela pediu: "lista com o nome do fornecedor na frente")
  const porFornecedor = {};
  for (const l of linhas) {
    const chave = l.fornecedor_indicado || 'sem vínculo';
    const b = (porFornecedor[chave] ||= { fornecedor: chave, unidades: 0, custo_cents: 0, produtos: [], link: null });
    b.unidades += l.quantity;
    b.custo_cents += l.custo_total_cents || 0;
    b.produtos.push({ product_id: l.product_id, name: l.name, quantity: l.quantity, custo_unit_cents: l.custo_unit_cents,
                      para: l.para, url: l.fornecedor_url, ref: l.fornecedor_ref, estoque: l.fornecedor_estoque });
    if (l.fornecedor_url && !b.link) b.link = l.fornecedor_url;
  }
  const total_cents = linhas.reduce((s, l) => s + (l.custo_total_cents || 0), 0);
  // Economia real: se ela comprasse tudo no fornecedor mais caro daquele item.
  const tudo_no_caro_cents = linhas.reduce((s, l) => {
    const precos = (l.opcoes || []).map((o) => o.custo_cents).filter((c) => c != null);
    const pior = precos.length ? Math.max(...precos) : l.custo_unit_cents;
    return s + (pior != null ? pior * l.quantity : 0);
  }, 0);
  const economia_cents = Math.max(0, tudo_no_caro_cents - total_cents);
  const semVinculo = linhas.filter((l) => l.origem_preco === 'histórico');

  return {
    ok: true,
    gerado_em: new Date().toISOString(),
    regra: { cobertura_meses: MESES_HISTORICO, quantidade_vem_de: 'simulador de kit (pendente + reposição − bolsa)',
             sem_vinculo_usa: 'histórico de venda confirmada por revendedora', preco_fornecedor_max_minutos: PRAZO_FRESCO_MINUTOS },
    totais: { produtos: linhas.length, unidades: linhas.reduce((s, l) => s + l.quantity, 0),
              custo_cents: total_cents, comparaveis: linhas.filter((l) => l.comparavel).length,
              sem_vinculo: semVinculo.length, tudo_no_caro_cents, economia_cents },
    fornecedores: Object.values(porFornecedor).sort((a, b) => b.custo_cents - a.custo_cents),
    giro_alto_fora_do_plano: giroAlto.slice(0, 40),
    linhas,
    simulador: { totals: plano.totals, buy_totals: plano.buy_totals, rules: plano.rules, queue: plano.queue, alertas: plano.alertas },
  };
}

module.exports = { buildPurchasePlan, atualizarPrecos, lerAtacadao, lerGall, historicoVendas };
