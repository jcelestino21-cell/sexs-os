process.env.SEXSOS_DB_PATH = ':memory:';
process.env.PORT = 0;

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../db');
const { hashPassword } = require('../src/auth');
const catalog = require('../src/catalogService');

// A vitrine pública é o único canto do sistema sem login. O que este arquivo garante:
//  - o ar da vitrine acompanha o sistema sem F5 (ETag/304 no GET público);
//  - nada de preço/custo/comissão/margem sai no JSON (o pedido da CEO é explícito);
//  - "disponível" vem de kit ABERTO de revendedora ATIVA ou do estoque da empresa;
//  - desativar a revendedora tira ela e o estoque dela da vitrine;
//  - produto inativo não aparece; produto sem estoque aparece como "sob encomenda";
//  - o número de WhatsApp é normalizado para o formato do link wa.me e a saudação da
//    mensagem usa o nome da pessoa, não o rótulo do contato.
let n = 0;
function uid() { n += 1; return n; }

function makeCeo() {
  const { hash, salt } = hashPassword('demo');
  const id = db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)')
    .run('CEO', `ceo-cat-${uid()}`, 'ceo', hash, salt).lastInsertRowid;
  return { id, role: 'ceo' };
}

function reseller(name, { active = true, phone = '(16) 99111-2222' } = {}) {
  return db.prepare('INSERT INTO resellers (name, status, commission_pct, phone) VALUES (?, ?, 0.25, ?)')
    .run(name, active ? 'ativa' : 'inativa', phone).lastInsertRowid;
}

function product(name, { active = true, price = 2502, cost = 800, depot = 0, description = '', photo = '', category = 'Geral' } = {}) {
  const id = db.prepare('INSERT INTO products (name, category, description, photo_url, unit, ideal_price_cents, min_price_cents, last_purchase_cost_cents, active) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(name, category, description, photo, 'unidade', price, Math.round(price * 0.6), cost, active ? 1 : 0).lastInsertRowid;
  if (cost) db.prepare('INSERT INTO stock_lots (product_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,1)').run(id, 10, cost);
  if (depot) db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason) VALUES (?, 'entrada', ?, ?, 'compra')").run(id, depot, depot);
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

/** Kit entregue (aberto) com `inHand` unidades em mãos da revendedora. */
function deliveredKit(resellerId, productId, inHand, { status = 'entregue' } = {}) {
  const kitId = db.prepare('INSERT INTO kits (reseller_id, cycle_number, status, created_by, delivered_at) VALUES (?,?,?,?,datetime(\'now\'))')
    .run(resellerId, uid(), status, 1).lastInsertRowid;
  const delivered = inHand + 1;
  db.prepare(`INSERT INTO kit_items (kit_id, product_id, quantity_suggested, unit_sale_price_cents, quantity_delivered, quantity_available, quantity_confirmed_sold)
              VALUES (?,?,?,?,?,?,?)`)
    .run(kitId, productId, delivered, 2502, delivered, inHand, 1);
  db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason) VALUES (?, 'entrega_kit', ?, 0, 'entrega')")
    .run(productId, -delivered);
  return kitId;
}

/** Venda lançada no kit (é isso que alimenta o ranking "queridinhos do momento"). */
function sale(kitId, productId, qty, { status = 'confirmada', daysAgo = 1 } = {}) {
  const item = db.prepare('SELECT id FROM kit_items WHERE kit_id = ? AND product_id = ?').get(kitId, productId);
  assert.ok(item, 'o kit precisa ter o produto');
  db.prepare(`INSERT INTO kit_sales (kit_item_id, quantity, unit_price_cents, status, created_by, created_at)
              VALUES (?,?,?,?,1,datetime('now', ?))`)
    .run(item.id, qty, 2502, status, `-${daysAgo} day`);
}

function findProduct(payload, name) {
  return payload.products.find((p) => p.name === name);
}

/** Por id: o teste renomeia produto no meio, e é justamente isso que se quer olhar. */
function productById(payload, id) {
  return payload.products.find((p) => p.id === id);
}

test('catálogo traz só nome, categoria, descrição, foto e quem entrega — nunca preço', () => {
  const ceo = makeCeo();
  const rA = reseller('Ana Ativa');
  const prod = product('Bolinha de Teste', { depot: 4, description: 'Uma bolinha.', photo: 'https://exemplo.com/a.jpg' });
  deliveredKit(rA, prod.id, 2);

  const out = catalog.publicPayload();
  assert.equal(out.enabled, true);
  assert.equal(out.brand, 'SexS');
  const p = findProduct(out, 'Bolinha de Teste');
  assert.ok(p, 'produto ativo aparece na vitrine');
  assert.deepEqual(Object.keys(p).sort(), ['available', 'category', 'censored', 'description', 'holders', 'id', 'name', 'photo_url']);
  assert.equal(p.description, 'Uma bolinha.');
  assert.equal(p.photo_url, 'https://exemplo.com/a.jpg');
  assert.equal(p.available, true);
  assert.equal(p.holders[0].name, 'Ana Ativa');
  assert.equal(p.holders[0].whatsapp, '5516991112222');
  assert.equal(p.holders[1].kind, 'estoque');
  assert.equal(p.holders[1].name, out.contact.label);
  const raw = JSON.stringify(out);
  for (const forbidden of ['price', '_cents', 'cost', 'commission', 'margin', 'quantity', 'password', 'phone', 'profit']) {
    assert.ok(!raw.includes(forbidden), `o payload público não pode conter "${forbidden}"`);
  }
});

test('revendedora inativa some da vitrine e o estoque dela deixa de contar como disponível', () => {
  const ceo = makeCeo();
  const rA = reseller('Ana Para Desativar');
  const prod = product('Produto Da Ana', { price: 3000, cost: 900 });
  deliveredKit(rA, prod.id, 3);
  assert.equal(findProduct(catalog.publicPayload(), 'Produto Da Ana').available, true, 'com ela ativa, está disponível');

  db.prepare("UPDATE resellers SET status = 'inativa' WHERE id = ?").run(rA);
  const after = catalog.publicPayload();
  assert.ok(!after.resellers.some((r) => r.name === 'Ana Para Desativar'), 'revendedora inativa some da lista');
  const p = findProduct(after, 'Produto Da Ana');
  assert.equal(p.available, false, 'sem estoque na empresa, vira item de encomenda');
  assert.deepEqual(p.holders, [], 'e o que estava com ela não é oferecido para contato');
});

test('kit em aguardando_fechamento e produto inativo ficam fora do catálogo', () => {
  const ceo = makeCeo();
  const rA = reseller('Beta Ativa');
  const pending = product('Produto Em Conferencia');
  deliveredKit(rA, pending.id, 2, { status: 'aguardando_fechamento' });
  const off = product('Produto Desativado', { active: false, depot: 9 });

  const out = catalog.publicPayload();
  assert.equal(findProduct(out, 'Produto Em Conferencia').available, false, 'unidade em conferência de fechamento não é "pronta"');
  assert.ok(!out.products.some((p) => p.name === 'Produto Desativado'), 'produto inativo não aparece, nem com estoque');
});

test('contato do estoque: número normalizado, saudação sem o prefixo de cargo', () => {
  makeCeo();
  const saved = catalog.saveSettings({ contact_label: 'CEO-Jéssica', contact_whatsapp: '(16) 99999-0000' }, { id: 1, role: 'ceo' });
  assert.equal(saved.contact_whatsapp, '5516999990000');
  assert.equal(saved.contact_label, 'CEO-Jéssica');
  const out = catalog.publicPayload();
  assert.equal(out.contact.whatsapp, '5516999990000');
  assert.equal(out.contact.greeting, 'Jéssica', 'a cliente escreve "Oi Jéssica", não "Oi CEO-Jéssica"');
  assert.equal(catalog.normalizeWhatsapp('16994181014'), '5516994181014');
  assert.equal(catalog.normalizeWhatsapp('5516994181014'), '5516994181014');
  assert.equal(catalog.normalizeWhatsapp('123'), null, 'número incompleto não gera link quebrado');
  assert.equal(catalog.greetingName('Depósito SexS'), 'SexS', 'lugar vira marca, não vocativo');
  assert.equal(catalog.greetingName('Flávia Souza'), 'Flávia');
  assert.equal(catalog.greetingName('CEO Jéssica'), 'Jéssica');
  assert.equal(catalog.greetingName(''), 'tudo bem');
});

test('desligar o catálogo tira os dados da resposta, e o painel da CEO continua enxergando as contas', () => {
  const ceo = makeCeo();
  product('Produto Do Depósito', { depot: 5 });
  assert.ok(catalog.publicPayload().products.length > 0);

  catalog.saveSettings({ enabled: false }, { id: ceo.id, role: 'ceo' });
  const off = catalog.publicPayload();
  assert.equal(off.enabled, false);
  assert.equal(off.products, undefined, 'sem dados de produto quando está fora do ar');
  assert.equal(off.resellers, undefined);

  const preview = catalog.publicPayload({ ignoreDisabled: true });
  assert.ok(preview.products.some((p) => p.name === 'Produto Do Depósito'), 'a CEO vê o que estaria no ar');

  catalog.saveSettings({ enabled: true }, { id: ceo.id, role: 'ceo' });
  assert.equal(catalog.publicPayload().enabled, true);
});


/* ————————————————— tempo real —————————————————
 * A vitrine é aberta no celular da cliente e fica parada na tela enquanto o sistema
 * muda (venda lançada, unidade devolvida no fechamento, produto ativado). Recarregar o
 * JSON inteiro a cada poucos segundos custaria ~25 KB por cliente e bateria à toa, então:
 * a rota manda Cache-Control: no-store + ETag derivado de um resumo do que a vitrine
 * mostra, e a página re-pergunta com If-None-Match. Igual = 304 vazio (nada é
 * reprocessado); diferente = payload novo. Este bloco trava os dois lados do contrato. */

let server, baseUrl;
test.before(async () => {
  server = require('../server.js');
  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

function getCatalog(ifNoneMatch) {
  return new Promise((resolve, reject) => {
    const opts = ifNoneMatch ? { headers: { 'If-None-Match': ifNoneMatch } } : {};
    http.get(baseUrl + '/api/public/catalog', opts, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: raw ? JSON.parse(raw) : null,
        bytes: Buffer.byteLength(raw),
      }));
    }).on('error', reject);
  });
}

test('assinatura do catálogo: só muda com o que a cliente vê', () => {
  const ceo = makeCeo();
  const rA = reseller('Ana Assinatura');
  const prod = product('Produto Assinado', { price: 2502, cost: 800 });
  const v0 = catalog.catalogVersion();
  assert.ok(v0.length > 10);
  assert.equal(catalog.catalogVersion(), v0, 'duas leituras seguidas, sem mexer em nada, dão a mesma assinatura');

  // preço/custo são internos: mexer neles não pode obrigar toda cliente a baixar de novo
  db.prepare('UPDATE products SET ideal_price_cents = 4200, min_price_cents = 3000, last_purchase_cost_cents = 1500 WHERE id = ?').run(prod.id);
  assert.equal(catalog.catalogVersion(), v0, 'mudar preço não muda a vitrine');

  // produto inativo não aparece na vitrine: nem criar nem reabastecer um deve disparar
  const vInativo = catalog.catalogVersion();
  const off = product('Produto Fora Da Vitrine', { active: false, depot: 7 });
  assert.equal(catalog.catalogVersion(), vInativo, 'produto inativo (e o movimento dele) fica fora da conta');

  // o que ela vê: nome, categoria, descrição, foto
  const vRename = catalog.catalogVersion();
  db.prepare('UPDATE products SET name = ? WHERE id = ?').run('Produto Assinada', prod.id); // mesmo tanto de letras
  assert.notEqual(catalog.catalogVersion(), vRename, 'renomear o produto troca a vitrine mesmo com o mesmo número de caracteres');
  db.prepare('UPDATE products SET description = ? WHERE id = ?').run('Novo texto da descrição.', prod.id);
  const v1 = catalog.catalogVersion();
  assert.notEqual(v1, v0, 'descrição nova muda a vitrine');
  db.prepare('UPDATE products SET photo_url = ? WHERE id = ?').run('https://exemplo.com/foto.jpg', prod.id);
  assert.notEqual(catalog.catalogVersion(), v1, 'foto nova muda a vitrine');

  // disponibilidade: unidade que chega ao estoque da empresa
  const vBeforeStock = catalog.catalogVersion();
  assert.equal(productById(catalog.publicPayload(), prod.id).available, false, 'antes dele, sob encomenda');
  db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason) VALUES (?, 'entrada', 3, 3, 'devolucao')").run(prod.id);
  assert.notEqual(catalog.catalogVersion(), vBeforeStock, 'entrada de estoque muda a assinatura');
  assert.equal(productById(catalog.publicPayload(), prod.id).available, true, 'e o produto passa a ficar pronto na vitrine');

  // revendedora: telefone (o número do botão) e ativação
  const v2 = catalog.catalogVersion();
  db.prepare('UPDATE resellers SET phone = ? WHERE id = ?').run('(16) 99888-7766', rA);
  assert.notEqual(catalog.catalogVersion(), v2, 'telefone novo muda o botão de contato');
  const vAfterPhone = catalog.catalogVersion();
  db.prepare('UPDATE resellers SET address = ? WHERE id = ?').run('Rua Sem Interesse', rA);
  assert.equal(catalog.catalogVersion(), vAfterPhone, 'endereço da revendedora não está na vitrine');
  const v3 = catalog.catalogVersion();
  db.prepare("UPDATE resellers SET status = 'inativa' WHERE id = ?").run(rA);
  assert.notEqual(catalog.catalogVersion(), v3, 'revendedora desativada muda a vitrine');

  // configurações do painel: rótulo do contato, número, ligar/desligar
  const v4 = catalog.catalogVersion();
  // regravar o que já estava gravado não pode derrubar a cache de todas as clientes
  catalog.saveSettings({ contact_label: 'CEO-Jéssica', contact_whatsapp: '(16) 99999-0000' }, { id: ceo.id, role: 'ceo' });
  assert.equal(catalog.catalogVersion(), v4, 'salvar as mesmas configurações não muda a vitrine');
  catalog.saveSettings({ contact_label: 'Atendimento SexS' }, { id: ceo.id, role: 'ceo' });
  assert.notEqual(catalog.catalogVersion(), v4, 'trocar o rótulo do contato do estoque muda a vitrine');
  const vRotulo = catalog.catalogVersion();
  catalog.saveSettings({ work_with_us_message: 'Quero vender com vocês' }, { id: ceo.id, role: 'ceo' });
  assert.notEqual(catalog.catalogVersion(), vRotulo, 'a mensagem do "trabalhe conosco" também aparece na página');
  assert.notEqual(catalog.catalogVersion(), v4, 'trocar o rótulo do contato do estoque muda a vitrine');
  const v5 = catalog.catalogVersion();
  catalog.saveSettings({ enabled: false }, { id: ceo.id, role: 'ceo' });
  assert.notEqual(catalog.catalogVersion(), v5, 'desligar a vitrine tem que chegar na cliente');
  assert.equal(catalog.publicPayload().enabled, false);
  catalog.saveSettings({ enabled: true }, { id: ceo.id, role: 'ceo' });
  const vReligado = catalog.catalogVersion();
  db.prepare('UPDATE products SET active = 1 WHERE id = ?').run(off.id);
  assert.notEqual(catalog.catalogVersion(), vReligado, 'reativar um produto muda a vitrine na hora');
});

test('GET /api/public/catalog: no-store + ETag, e 304 quando nada mudou', async () => {
  makeCeo();
  product('Produto Cache', { depot: 2 });
  const a = await getCatalog();
  assert.equal(a.status, 200);
  assert.equal(a.headers['cache-control'], 'no-store', 'a vitrine nunca pode ser servida de um cache velho');
  assert.match(a.headers.etag || '', /^W\/"[0-9a-f]{32}"$/, 'ETag fraco, em ASCII, estável');
  assert.ok(/^[\x20-\x7e]*$/.test(a.headers.etag), 'cabeçalho sem byte fora do ASCII (proxy não corrompe)');
  assert.ok(a.bytes > 200, 'veio o corpo completo na primeira leitura');
  assert.ok(Array.isArray(a.body.products) && a.body.products.length > 0);

  const b = await getCatalog(a.headers.etag);
  assert.equal(b.status, 304, 'com o ETag anterior, a conferência não baixa nada');
  assert.equal(b.bytes, 0, '304 sem corpo');
  assert.equal(b.headers['cache-control'], 'no-store');
  assert.equal(b.headers.etag, a.headers.etag, 'e confirma o mesmo ETag');

  // o navegador manda o ETag com o W/ que recebeu; também tem que bater
  const bare = a.headers.etag.replace(/^W\//, '');
  assert.equal((await getCatalog(bare)).status, 304, 'If-None-Match sem o prefixo W/ bate igual');
  assert.equal((await getCatalog(`"nada-a-ver", ${bare}`)).status, 304, 'lista de ETags: um batendo basta');
  assert.equal((await getCatalog('W/"outro-valor"')).status, 200, 'ETag diferente volta o payload inteiro');

  // e a mudança no sistema chega: produto some do ar -> nova assinatura
  const c = await getCatalog(a.headers.etag);
  assert.equal(c.status, 304, 'antes de mexer, continua igual');
  const prod = db.prepare("SELECT id FROM products WHERE name = 'Produto Cache'").get();
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(prod.id);
  const d = await getCatalog(a.headers.etag);
  assert.equal(d.status, 200, 'produto desativado aparece para a cliente, então tem que vir o payload novo');
  assert.notEqual(d.headers.etag, a.headers.etag);
  db.prepare('UPDATE products SET active = 1 WHERE id = ?').run(prod.id);
});

test('catálogo desligado: a cliente vê o aviso e a assinatura não expõe nada', async () => {
  const ceo = makeCeo();
  product('Produto No Escuro', { depot: 3 });
  const on = await getCatalog();
  assert.ok(on.body.products.length > 0);
  catalog.saveSettings({ enabled: false }, { id: ceo.id, role: 'ceo' });
  const off = await getCatalog();
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(off.body.products, undefined, 'fora do ar não vaza produto nem contato');
  assert.match(off.headers.etag, /^W\/"[0-9a-f]{32}"$/, 'mesmo desligado o 304 funciona');
  const off2 = await getCatalog(off.headers.etag);
  assert.equal(off2.status, 304, 'e a página parada só recebe um aviso novo uma vez');
  catalog.saveSettings({ enabled: true }, { id: ceo.id, role: 'ceo' });
  assert.notEqual((await getCatalog(off.headers.etag)).status, 304, 'religar tem que chegar na hora');
});

test('censura da vitrine: foto de prótese/plug não sai do servidor; consumível da mesma categoria fica', () => {
  const ceo = makeCeo();
  const protese = product('Prótese Realista 15cm', { category: 'Próteses', photo: 'https://fornecedores.com/protese.jpg' });
  const cone = product('Cone fino 57g', { category: 'Próteses', photo: 'https://fornecedores.com/cone.jpg' });
  const plug = product('Plug Anal P - Azul', { category: 'Anal', photo: 'https://fornecedores.com/plug.jpg' });
  const gel = product('Fofa Toba Excitante 15ml', { category: 'Anal', photo: 'https://fornecedores.com/gel.jpg' });
  const anel = product('Anel Vibrador Bichinhos', { category: 'Anéis Penianos', photo: 'https://fornecedores.com/anel.jpg' });
  const arom = product('Pênis Aromático 14cm - Menta', { category: 'Próteses', photo: 'https://fornecedores.com/aroma.jpg' });

  const out = catalog.publicPayload();
  assert.equal(catalog.getSettings().censored_categories, 'Próteses', 'lista padrão vem da configuração');
  assert.equal(productById(out, protese.id).censored, true, 'prótese é censurada');
  assert.equal(productById(out, protese.id).photo_url, '', 'e o endereço da foto nem vai para o navegador');
  assert.equal(productById(out, cone.id).censored, true, 'categoria censurada vale mesmo com nome neutro');
  assert.equal(productById(out, plug.id).censored, true, 'plug solto na categoria Anal é pego pelo nome');
  assert.equal(productById(out, gel.id).censored, false, 'gel excitante cadastrado em Anal não é objeto: foto fica');
  assert.equal(productById(out, gel.id).photo_url, 'https://fornecedores.com/gel.jpg');
  assert.equal(productById(out, anel.id).censored, false, 'anel não entra na censura por padrão');
  assert.equal(productById(out, arom.id).censored, true, 'sabor no nome não livra o objeto da categoria censurada');
  // o card censurado continua inteiro: nome, categoria, descrição e contato seguem na resposta
  const card = productById(out, plug.id);
  assert.equal(card.name, 'Plug Anal P - Azul');
  assert.equal(card.category, 'Anal');
  assert.ok(Array.isArray(card.holders), 'e o contato continua disponível para a cliente');

  // mexer na lista muda a vitrine e a assinatura (senão o ETag deixaria a cliente na versão antiga)
  const antes = catalog.catalogVersion();
  catalog.saveSettings({ censored_categories: 'Próteses, Anal' }, ceo);
  assert.notEqual(catalog.catalogVersion(), antes, 'mudar a censura invalida o cache da vitrine');
  assert.equal(productById(catalog.publicPayload(), plug.id).photo_url, '', 'plug continua censurado');
  assert.equal(productById(catalog.publicPayload(), gel.id).censored, false, 'e o gel continua isento pela regra do nome');

  catalog.saveSettings({ censored_categories: 'Próteses' }, ceo);
  assert.equal(productById(catalog.publicPayload(), gel.id).photo_url, 'https://fornecedores.com/gel.jpg', 'settings voltam ao padrão');
});

test('queridinhos do momento: a vitrine ranqueia pelo que saiu nas vendas das revendedoras', () => {
  makeCeo();
  const rA = reseller('Queri Ana');
  const rB = reseller('Queri Beta');
  const hit = product('Queridinho Top');
  const meio = product('Meio Querido');
  const esquecido = product('Ninguém Comprou');
  const kitA = deliveredKit(rA, hit.id, 3);
  const kitA2 = deliveredKit(rA, meio.id, 3);
  const kitB = deliveredKit(rB, hit.id, 3);
  const kitC = deliveredKit(rB, esquecido.id, 3);

  sale(kitA, hit.id, 4);
  sale(kitB, hit.id, 2);            // 6 unidades, em duas revendedoras diferentes
  sale(kitA2, meio.id, 5);          // mais unidades, mas só numa revendedora
  sale(kitC, esquecido.id, 0, { status: 'rejeitada' });

  const out = catalog.publicPayload();
  const p = findProduct(out, 'Queridinho Top');
  assert.ok(p.hot, 'o mais vendido vem marcado');
  assert.equal(p.hot.rank, 1);
  assert.equal(p.hot.units, 6);
  assert.equal(p.hot.fans, 2, 'duas revendedoras venderam');
  assert.equal(findProduct(out, 'Meio Querido').hot.rank, 2, 'desempate: unidades primeiro');
  assert.ok(!findProduct(out, 'Ninguém Comprou').hot, 'venda rejeitada (estorno) não conta nada');
  assert.equal(out.trending.days, 60);

  // o desempate por número de revendedoras é o que está documentado no serviço
  const kitD = deliveredKit(rA, meio.id, 3);
  sale(kitD, meio.id, 1);
  const outro = product('Outro Com Duas');
  const kitE = deliveredKit(rB, outro.id, 2);
  const kitF = deliveredKit(rA, outro.id, 2);
  sale(kitE, outro.id, 3);
  sale(kitF, outro.id, 3);
  const after = catalog.publicPayload();
  assert.equal(after.products.find((x) => x.name === 'Outro Com Duas').hot.units, 6);
  assert.equal(after.products.find((x) => x.name === 'Queridinho Top').hot.units, 6);
  assert.ok(
    after.products.find((x) => x.name === 'Outro Com Duas').hot.rank < after.products.find((x) => x.name === 'Queridinho Top').hot.rank,
    'mesma quantidade: quem foi vendido por mais revendedoras fica na frente',
  );
});

test('queridinhos: janela de 60 dias, com reserva para o histórico quando a loja está parada', () => {
  makeCeo();
  const r = reseller('Janela Rev');
  const novo = product('Saiu Agora');
  const velho = product('Vendeu Antigamente');
  const k1 = deliveredKit(r, novo.id, 2);
  const k2 = deliveredKit(r, velho.id, 2);
  sale(k1, novo.id, 1, { daysAgo: 5 });
  sale(k2, velho.id, 9, { daysAgo: 400 });

  let out = catalog.publicPayload();
  const saiu = out.products.find((x) => x.name === 'Saiu Agora');
  assert.ok(saiu.hot && saiu.hot.units === 1, 'venda da janela conta, mesmo sendo 1 unidade só');
  assert.ok(!out.products.find((x) => x.name === 'Vendeu Antigamente').hot, 'venda de 400 dias atrás não entra na janela, nem com 9 unidades');

  db.prepare('DELETE FROM kit_sales').run();
  sale(k2, velho.id, 9, { daysAgo: 400 });
  out = catalog.publicPayload();
  assert.ok(out.products.find((x) => x.name === 'Vendeu Antigamente').hot, 'sem venda recente, o histórico todo assume a faixa');
  assert.equal(out.trending.days, null, 'e a vitrine diz que é histórico, não "últimos 60 dias"');

  db.prepare('DELETE FROM kit_sales').run();
  out = catalog.publicPayload();
  assert.ok(out.products.every((x) => !x.hot), 'sem venda nenhuma, a faixa não tem o que mostrar');
  assert.equal(out.trending.days, null);
});

test('queridinhos: no máximo 5 na vitrine, produto inativo fica fora e a assinatura acompanha a venda', () => {
  makeCeo();
  const r = reseller('Cinco Rev');
  const ids = [];
  for (let i = 1; i <= 7; i++) {
    const prod = product(`Muito Vendido ${i}`);
    ids.push(prod.id);
    const kit = deliveredKit(r, prod.id, 2);
    sale(kit, prod.id, 10 - i);
  }
  const out = catalog.publicPayload();
  const marcados = out.products.filter((x) => x.hot);
  assert.equal(marcados.length, 5, 'a faixa é de 5, não de 7');
  assert.deepEqual(marcados.map((x) => x.hot.rank), [1, 2, 3, 4, 5]);
  assert.ok(!marcados.some((x) => x.name === 'Muito Vendido 7'), 'o de menos unidade fica fora');

  const ver = catalog.catalogVersion();
  const kit = deliveredKit(r, ids[6], 2);
  sale(kit, ids[6], 3);
  assert.notEqual(catalog.catalogVersion(), ver, 'venda nova muda a assinatura, e a cliente atualiza sem F5');
});
