// ============================================================================
// SexS OS — Simulador de kit (montanha-russa de "o que eu mando para cada uma?")
// ----------------------------------------------------------------------------
// Regra única, a mesma que a CEO usa de cabeça quando dá certo:
//   kit novo = o que ela AINDA NÃO TEM (pedido pendente)
//            + o que ela VENDEU no kit em aberto (reposição)
//            - o que já está parado na bolsa dela, sem venda
//            + (opcional) os campeões de venda DELA, enquanto houver estoque
// e cada linha ganha uma origem: sai do armazém hoje, ou precisa comprar.
//
// Deliberado, porque é isso que evita a próxima bagunça:
//  · nada é reservado nem baixado aqui. O saldo do sistema não tem reserva de
//    verdade (kitService.companyReservedBalance devolve 0), então dividir o
//    estoque é conta nossa, feita em ordem de fila — a primeira a escolher não
//    deixa a segunda levar a mesma unidade;
//  · linha "comprar" NÃO entra no kit: approveKit() trava o kit inteiro se
//    faltar estoque de um item, e a CEO descobriria isso com a revendedora na
//    frente. O que falta vira lista de compra; quando a compra entrar, o item
//    entra no kit pelo caminho que já existe (addDeliveredItem);
//  · revendedora com kit em aberto não recebe kit novo pelo apply: antes tem
//    que conferir o fechamento, senão a reposição é calculada em cima de um
//    número que ainda não bate.
// ============================================================================
const db = require('../db');
const kitService = require('./kitService');

const OPEN_KITS = ['sugerido', 'aprovado', 'em_preparacao', 'entregue', 'aguardando_fechamento'];
// O formulário de kit avisa em R$ 300 (KIT_LIMIT_REAIS no index.html). Não é trava:
// é régua para a CEO saber se o plano ficou gordo.
const KIT_FORM_CAP_CENTS = 30000;
const FILL_MAX_LINES = 6;
const FILL_MAX_PER_PRODUCT = 2;

const inList = (values) => values.map(() => '?').join(',');

/** Saldo do armazém por produto — mesma contagem de kitService.companyAvailableBalance
 * (os tipos de movimento têm sinal, e o histórico antigo guarda valor absoluto),
 * feita numa consulta só em vez de uma por produto. */
function warehouseBalances() {
  const rows = db.prepare(`
    SELECT p.id,
           COALESCE(SUM(
             CASE WHEN m.type IN ('entrada','entrada_compra','devolucao','entrada_devolucao','retorno_kit','ajuste_positivo') THEN ABS(m.quantity)
                  WHEN m.type IN ('saida','entrega_kit','ajuste_negativo') THEN -ABS(m.quantity)
                  ELSE m.quantity END
           ), 0) AS free
    FROM products p
    LEFT JOIN stock_movements m ON m.product_id = p.id
    WHERE p.active = 1
    GROUP BY p.id
  `).all();
  const out = new Map();
  for (const r of rows) out.set(r.id, r.free);
  return out;
}

function activeProducts() {
  return db.prepare(`
    SELECT id, name, category, ideal_price_cents, min_price_cents, last_purchase_cost_cents, default_supplier_id
    FROM products WHERE active = 1
  `).all().reduce((acc, p) => { acc.set(p.id, p); return acc; }, new Map());
}

/** O que cada uma tem em mãos agora (kit em aberto), linha por linha. */
function openKitLines() {
  const kits = db.prepare(`
    SELECT k.id, k.reseller_id, k.status, k.cycle_number, k.delivered_at, k.closure_requested_at
    FROM kits k JOIN resellers r ON r.id = k.reseller_id
    WHERE k.status IN (${inList(OPEN_KITS)}) AND r.status = 'ativa'
    ORDER BY k.id DESC
  `).all(...OPEN_KITS);
  const porRev = new Map();
  for (const k of kits) {
    if (porRev.has(k.reseller_id)) continue; // só o kit mais recente dela interessa para o próximo
    const linhas = db.prepare(`
      SELECT product_id,
             SUM(quantity_available) AS em_maos,
             SUM(quantity_pending_closure + quantity_confirmed_sold) AS vendidas
      FROM kit_items WHERE kit_id = ? GROUP BY product_id
    `).all(k.id);
    porRev.set(k.reseller_id, {
      kit_id: k.id, status: k.status, cycle_number: k.cycle_number, delivered_at: k.delivered_at,
      em_maos: new Map(linhas.map((l) => [l.product_id, l.em_maos || 0])),
      vendidas: new Map(linhas.map((l) => [l.product_id, l.vendidas || 0])),
      total_em_maos: linhas.reduce((s, l) => s + (l.em_maos || 0), 0),
      total_vendidas: linhas.reduce((s, l) => s + (l.vendidas || 0), 0),
    });
  }
  return porRev;
}

/** Pedidos pendentes somados por produto (o saldo "quanto ainda falta"). */
function pendingByReseller() {
  const rows = db.prepare(`
    SELECT ro.reseller_id, ro.product_id,
           SUM(MAX(0, ro.quantity_requested -
                   CASE WHEN typeof(ro.quantity_fulfilled) = 'integer' THEN ro.quantity_fulfilled ELSE 0 END)) AS falta,
           MIN(ro.created_at) AS desde, COUNT(*) AS linhas
    FROM reseller_orders ro
    JOIN products p ON p.id = ro.product_id AND p.active = 1
    WHERE ro.status = 'pendente'
    GROUP BY ro.reseller_id, ro.product_id
  `).all();
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.reseller_id)) out.set(r.reseller_id, new Map());
    if (r.falta > 0) out.get(r.reseller_id).set(r.product_id, r);
  }
  return out;
}

/** Histórico de venda dela (todos os kits, menos os rejeitados) — é o que decide
 * "completar o kit" e desempatar, e é por revendedora de propósito: as cinco não
 * vendem o mesmo produto. */
function soldHistoryByReseller() {
  const rows = db.prepare(`
    SELECT k.reseller_id, ki.product_id,
           SUM(ki.quantity_confirmed_sold + ki.quantity_pending_closure) AS vendidas
    FROM kits k JOIN kit_items ki ON ki.kit_id = k.id
    WHERE k.status <> 'rejeitado'
    GROUP BY k.reseller_id, ki.product_id
    HAVING vendidas > 0
    ORDER BY k.reseller_id, vendidas DESC
  `).all();
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.reseller_id)) out.set(r.reseller_id, []);
    out.get(r.reseller_id).push(r);
  }
  return out;
}

/** Pedidos "separado" que não pertencem a nenhum kit em aberto: demanda invisível
 * (a tela de pendentes e o /api/orders/consolidated só contam 'pendente'). */
function stuckSeparated() {
  const rows = db.prepare(`
    SELECT ro.reseller_id, r.name AS reseller_name, COUNT(*) AS linhas,
           SUM(MAX(0, COALESCE(ro.quantity_separated, 0))) AS unidades,
           GROUP_CONCAT(DISTINCT k.status) AS status_kit
    FROM reseller_orders ro
    JOIN resellers r ON r.id = ro.reseller_id
    LEFT JOIN kits k ON k.id = ro.kit_id
    WHERE ro.status = 'separado'
      AND (ro.kit_id IS NULL OR k.id IS NULL OR k.status NOT IN (${inList(OPEN_KITS)}))
    GROUP BY ro.reseller_id
    ORDER BY unidades DESC
  `).all(...OPEN_KITS);
  return rows;
}

function daysSince(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T') + (/[z+]/i.test(iso) ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function priceOf(p) {
  return (p.ideal_price_cents || p.min_price_cents || 0);
}

/** O plano. `options.fill` (padrão true) completa com os campeões dela;
 * `options.maxValueCents` corta o kit num teto de valor de venda (0 = sem teto). */
function buildPlan(options = {}) {
  const fill = options.fill !== false;
  const cap = Number(options.maxValueCents || 0);
  const free = warehouseBalances();
  const prods = activeProducts();
  const abertos = openKitLines();
  const pedidos = pendingByReseller();
  const historico = soldHistoryByReseller();

  const revs = db.prepare(`SELECT id, name, status FROM resellers WHERE status = 'ativa' ORDER BY name`).all();
  const bruto = revs.map((r) => {
    const delinha = pedidos.get(r.id) || new Map();
    const idadeDias = Math.max(0, ...[...delinha.values()].map((x) => daysSince(x.desde) || 0));
    return { r, delinha, idadeDias, unidades: [...delinha.values()].reduce((s, x) => s + x.falta, 0) };
  });
  // quem espera mais escolhe primeiro; sem pedido vai para o fim da fila
  const ordem = bruto.sort((a, b) => (b.idadeDias - a.idadeDias) || (b.unidades - a.unidades) || a.r.name.localeCompare(b.r.name));

  const pool = new Map(free);
  const plans = [];
  const buy = new Map();

  for (const { r, delinha } of ordem) {
    const kit = abertos.get(r.id);
    const necessidade = new Map();
    const cobertas = [];
    for (const [pid, x] of delinha) {
      necessidade.set(pid, { q: x.falta, pedido: x.falta, reposicao: 0, desde: x.desde });
    }
    if (kit) {
      for (const [pid, vendidas] of kit.vendidas) {
        // o que ela ainda tem sem venda do mesmo produto abate a reposição
        const preciso = Math.max(0, vendidas - (kit.em_maos.get(pid) || 0));
        if (!preciso) {
          // só é "coberta" se ela de fato vendeu algo (vendidas > 0); sem isso a lista
          // enche de produto que ela só tem parado na bolsa
          if (vendidas > 0) {
            cobertas.push({ product_id: pid, name: (prods.get(pid) || {}).name, vendidas, em_maos: kit.em_maos.get(pid) || 0 });
          }
          continue;
        }
        const atual = necessidade.get(pid) || { q: 0, pedido: 0, reposicao: 0, desde: null };
        atual.q += preciso;
        atual.reposicao += preciso;
        necessidade.set(pid, atual);
      }
    }

    const linhas = [];
    let valorAcumulado = 0;
    let cortadas = [];
    const empurrar = (pid, q, motivo, opcional) => {
      const p = prods.get(pid);
      if (!p || q <= 0) return;
      const preco = priceOf(p);
      if (cap > 0 && valorAcumulado + q * preco > cap) {
        const queCabe = Math.max(0, Math.floor((cap - valorAcumulado) / (preco || 1)));
        if (queCabe < q) cortadas.push({ product_id: pid, name: p.name, quantity: q - queCabe, motivo });
        if (queCabe <= 0) return;
        q = queCabe;
      }
      const disponivel = Math.max(0, pool.get(pid) || 0);
      const doEstoque = Math.min(q, disponivel);
      pool.set(pid, disponivel - doEstoque);
      const comprar = q - doEstoque;
      valorAcumulado += q * preco;
      linhas.push({
        product_id: pid,
        name: p.name,
        category: p.category,
        quantity: q,
        from_stock: doEstoque,
        to_buy: comprar,
        motivo,
        opcional: !!opcional,
        unit_sale_price_cents: preco,
        sale_value_cents: q * preco,
        unit_cost_cents: p.last_purchase_cost_cents || 0,
        purchase_cost_cents: comprar * (p.last_purchase_cost_cents || 0),
        supplier_id: p.default_supplier_id || null,
        sem_preco: preco <= 0,
      });
      if (comprar > 0) {
        const b = buy.get(pid) || { product_id: pid, name: p.name, quantity: 0, cost_cents: 0, supplier_id: p.default_supplier_id || null, para: [] };
        b.quantity += comprar;
        b.cost_cents += comprar * (p.last_purchase_cost_cents || 0);
        b.para.push(r.name);
        buy.set(pid, b);
      }
    };

    // 1. o que ela pediu (ordem: quem pediu mais primeiro, depois nome)
    [...necessidade.entries()]
      .sort((a, b) => (b[1].q - a[1].q) || (prods.get(a[0]) || { name: '' }).name.localeCompare((prods.get(b[0]) || { name: '' }).name))
      .forEach(([pid, x]) => {
        const motivos = [];
        if (x.pedido) motivos.push(`pediu ${x.pedido}`);
        if (x.reposicao) motivos.push(`vendeu ${x.reposicao} no kit #${kit.kit_id}`);
        empurrar(pid, x.q, motivos.join(' · ') || 'demanda');
      });

    // 2. completar com o que ela mais vende na vida, se houver estoque
    let sugestoes = [];
    if (fill) {
      const jaNoPlano = new Set(linhas.map((l) => l.product_id));
      const emMaos = kit ? kit.em_maos : new Map();
      for (const h of historico.get(r.id) || []) {
        if (jaNoPlano.has(h.product_id) || (emMaos.get(h.product_id) || 0) > 0) continue;
        const p = prods.get(h.product_id);
        if (!p) continue;
        const quero = Math.min(FILL_MAX_PER_PRODUCT, Math.max(1, Math.floor((pool.get(h.product_id) || 0) / 2)));
        if ((pool.get(h.product_id) || 0) < 1) {
          sugestoes.push({ product_id: h.product_id, name: p.name, vendidas_total: h.vendidas, sem_estoque: true, quantity: 0 });
          continue;
        }
        empurrar(h.product_id, quero, `campeã de venda dela (${h.vendidas} no total)`, true);
        if (linhas.filter((l) => l.opcional).length >= FILL_MAX_LINES) break;
      }
    }

    const soma = (key) => linhas.reduce((s, l) => s + l[key], 0);
    plans.push({
      reseller_id: r.id,
      reseller_name: r.name,
      open_kit: kit ? {
        kit_id: kit.kit_id, status: kit.status, cycle_number: kit.cycle_number, delivered_at: kit.delivered_at,
        days_since_delivery: daysSince(kit.delivered_at), em_maos: kit.total_em_maos, vendidas: kit.total_vendidas,
      } : null,
      lines: linhas,
      cobertas_pelo_que_ela_ja_tem: cobertas,
      sugestoes_sem_estoque: sugestoes.filter((s) => s.sem_estoque),
      fora_do_teto: cortadas,
      totals: {
        lines: linhas.length,
        units: soma('quantity'),
        from_stock: soma('from_stock'),
        to_buy: soma('to_buy'),
        sale_value_cents: soma('sale_value_cents'),
        purchase_cost_cents: soma('purchase_cost_cents'),
        over_form_cap: cap === 0 && soma('sale_value_cents') > KIT_FORM_CAP_CENTS,
      },
    });
  }

  const alertas = [];
  const presos = stuckSeparated();
  if (presos.length) {
    alertas.push({
      tipo: 'fila_presa',
      aviso: presos.map((p) => `${p.reseller_name}: ${p.linhas} pedido(s) “separado” pres${p.linhas > 1 ? 'os' : 'o'} em kit ${p.status_kit || 'inexistente'} (${p.unidades} un.)`),
      porque: 'a tela de pedidos pendentes e o /api/orders/consolidated só contam status “pendente” — essa demanda não aparece para ninguém.',
    });
  }
  for (const pl of plans) {
    if (!pl.open_kit) continue;
    if (pl.open_kit.days_since_delivery !== null && pl.open_kit.days_since_delivery > 21 && pl.open_kit.vendidas === 0) {
      alertas.push({
        tipo: 'kit_sem_baixa',
        aviso: [`${pl.reseller_name} está com o kit #${pl.open_kit.kit_id} há ${pl.open_kit.days_since_delivery} dias sem nenhuma venda lançada.`],
        porque: 'sem a conferência do fechamento, a reposição é chute: o estoque dela não volta e o kit novo pode sair duplicado.',
      });
    }
  }
  const semNada = plans.filter((p) => !p.lines.length);
  if (semNada.length) {
    alertas.push({
      tipo: 'sem_demanda',
      aviso: semNada.map((p) => `${p.reseller_name} (nenhum pedido pendente${p.open_kit ? '' : ' e sem kit aberto'})`),
      porque: 'para essas o simulador não tem como decidir — vale perguntar o que ela quer antes de montar.',
    });
  }
  const semFornecedor = [...buy.values()].filter((b) => !b.supplier_id);
  if (semFornecedor.length) {
    alertas.push({
      tipo: 'sem_fornecedor',
      aviso: semFornecedor.map((b) => `${b.name} (${b.quantity} un.)`),
      porque: 'o cadastro não liga fornecedor a esses produtos, então a lista de compra não diz com quem comprar.',
    });
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    rules: {
      reposicao: 'o que ela vendeu no kit em aberto, descontado do que ainda tem sem venda na bolsa',
      estoque_primeiro: true,
      linha_de_compra_nao_vai_no_kit: true,
      ordem_de_escolha_do_estoque: 'mais tempo na fila primeiro',
      fill,
      max_value_cents: cap,
      kit_form_cap_cents: KIT_FORM_CAP_CENTS,
    },
    queue: ordem.map((x, i) => ({ reseller_id: x.r.id, reseller_name: x.r.name, posicao: i + 1, espera_dias: x.idadeDias, unidades_pedidas: x.unidades })),
    estoque_inicial: Object.fromEntries([...free.entries()].filter(([, v]) => v > 0)),
    estoque_sobra: Object.fromEntries([...pool.entries()].filter(([k]) => free.get(k) > 0)),
    plans,
    buy_list: [...buy.values()].sort((a, b) => (b.quantity - a.quantity) || a.name.localeCompare(b.name)).map((b) => ({
      ...b,
      para: [...new Set(b.para)],
      unit_cost_cents: b.quantity ? Math.round(b.cost_cents / b.quantity) : 0,
    })),
    buy_totals: {
      units: [...buy.values()].reduce((s, b) => s + b.quantity, 0),
      cost_cents: [...buy.values()].reduce((s, b) => s + b.cost_cents, 0),
      products: buy.size,
    },
    totals: {
      units: plans.reduce((s, p) => s + p.totals.units, 0),
      from_stock: plans.reduce((s, p) => s + p.totals.from_stock, 0),
      to_buy: plans.reduce((s, p) => s + p.totals.to_buy, 0),
      sale_value_cents: plans.reduce((s, p) => s + p.totals.sale_value_cents, 0),
    },
    alertas,
  };
}

/** Aplica o plano de UMA revendedora: cria kit 'sugerido' só com as linhas que têm
 * estoque hoje. Não entrega, não baixa, não reserva — quem aprova é a CEO. */
function applyPlan({ resellerId, userId, includeFill = true, force = false, maxValueCents = 0 } = {}) {
  const plano = buildPlan({ fill: includeFill, maxValueCents }).plans.find((p) => p.reseller_id === Number(resellerId));
  if (!plano) throw new Error('Revendedora ativa sem plano — não há o que montar.');
  if (plano.open_kit && !force) {
    throw new Error(`Ela já tem o kit #${plano.open_kit.kit_id} em aberto (${plano.open_kit.status}, ${plano.open_kit.em_maos} un. na mão). `
      + 'Confira o fechamento primeiro ou marque "ignorar o kit em aberto".');
  }
  const itens = plano.lines
    .filter((l) => (includeFill ? true : !l.opcional) && l.from_stock > 0)
    // o preço vai junto de propósito: o que ela viu no plano é o que entra no kit,
    // em vez de deixar a regra de precificação recalcular por trás
    .map((l) => ({ product_id: l.product_id, quantity: l.from_stock, unit_sale_price_cents: l.unit_sale_price_cents }));
  if (!itens.length) return { ok: true, kit: null, message: 'Nenhuma linha sai do estoque hoje — nada para criar.', plano };
  const kit = kitService.suggestKit({ resellerId: Number(resellerId), items: itens, userId });
  return {
    ok: true,
    kit: { id: kit.id, status: kit.status, reseller: plano.reseller_name, itens: itens.length },
    left_to_buy: plano.lines.filter((l) => l.to_buy > 0).map((l) => ({ product_id: l.product_id, name: l.name, quantity: l.to_buy })),
    message: `Kit #${kit.id} criado como "sugerido" com ${itens.length} linha(s) do estoque. `
      + 'Aprove, confira o armazém e entregue. O que precisa comprar entra depois, como acréscimo.',
  };
}

module.exports = { buildPlan, applyPlan, warehouseBalances, stuckSeparated, KIT_FORM_CAP_CENTS };
