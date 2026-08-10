// SexS OS — servidor (fundação do projeto, Seção 12 item 1).
// Sem dependências externas (ambiente sem acesso à rede para `npm install`).
// Usa apenas módulos nativos do Node 22: http, node:sqlite, node:crypto.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

loadEnv();

// FASE 10.5 — Backup automático: restaurar banco antes de qualquer coisa
const backupService = require('./src/backupService');

const db = require('./db');
const Router = require('./src/router');
const auth = require('./src/auth');
const { logAudit } = require('./src/audit');
const proposalService = require('./src/proposalService');
require('./src/stockIntents');       // registra o fluxo de compra de estoque (Diego)
const resellerService = require('./src/resellerService');
const kitService = require('./src/kitService');
const financeService = require('./src/financeService');
const dashboardService = require('./src/dashboardService');
const commercialService = require('./src/commercialService');
const marketingService = require('./src/marketingService');
const advisorService = require('./src/advisorService');
require('./src/anaService');          // registra resumo e roteamento (Ana)
const councilService = require('./src/councilService');
const conversationalBrain = require('./src/conversationalBrain');
const documentService = require('./src/documentService');
const companyService = require('./src/companyService');
const docxGenerator = require('./src/docxGenerator');
const ordersService = require('./src/ordersService');
const { hasCapability, capabilitiesFor } = require('./src/authorization');
const notificationService = require('./src/notificationService');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// -----------------------------------------------------------------------------
// FASE 10.5 — CORREÇÃO: loadEnv() trata valores com aspas corretamente
// Antes: KEY="value" salvava "value" com aspas incluídas.
// Agora: remove aspas simples e duplas ao redor do valor.
// -----------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      let value = m[2].trim();
      // Remove aspas ao redor do valor: "value" ou 'value'
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  }
}

// -----------------------------------------------------------------------------
// FASE 10.5 — CORREÇÃO: IS_DEMO_MODE agora é fail-safe (opt-in, não opt-out).
//
// Antes: qualquer ambiente que não tivesse NODE_ENV=production explicitamente
// setado devolvia tokens de recuperação de senha na resposta HTTP. Isso é
// fail-open: esquecer de setar a variável = vazar credenciais.
//
// Agora: o token de demonstração SÓ é devolvido se SEXSOS_ENABLE_DEMO_TOKEN
// estiver explicitamente setado como "true". Esquecer de setar qualquer variável
// resulta no comportamento seguro (sem token na resposta).
// -----------------------------------------------------------------------------
const IS_DEMO_MODE = process.env.SEXSOS_ENABLE_DEMO_TOKEN === 'true';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  // FASE 10.5 — JSONP: se res._jsonpCallback existe, responde como JavaScript
  if (res._jsonpCallback) {
    const safe = res._jsonpCallback.replace(/[^a-zA-Z0-9_$]/g, '');
    const jsonpBody = safe + '(' + body + ')';
    const buf = Buffer.from(jsonpBody, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return;
  }

  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

// -----------------------------------------------------------------------------
// FASE 10.5 — CORREÇÃO: readJsonBody trata req.destroy() corretamente.
// Antes: quando data.length > 1e6, chamava req.destroy() mas não rejeitava a
// Promise, causando hang da requisição.
// Agora: rejeita com erro 413 (Payload Too Large).
// -----------------------------------------------------------------------------
function readJsonBody(req, maxLength = 1e6) {
  // FASE 10.5 — Se o body foi simulado a partir de query params (GET fallback para POST),
  // retorna diretamente sem tentar ler o stream do request.
  if (req._simulatedBody) {
    try { return Promise.resolve(JSON.parse(req._simulatedBody)); }
    catch(e) { return Promise.resolve({}); }
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let destroyed = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > maxLength && !destroyed) {
        destroyed = true;
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (destroyed) return;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON inválido no corpo da requisição.')); }
    });
    req.on('error', (err) => { if (!destroyed) reject(err); });
  });
}

function getAuthUser(req) {
  // FASE 10.5 — Suporta token tanto no header Authorization quanto na query string ?token=
  // O proxy do Arena bloqueia POST e headers customizados (405), então o token
  // pode vir como query parameter para funcionar como GET "simple request".
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) return auth.getUserBySessionToken(token);
  // Fallback: token na query string (para contornar proxy restritivo)
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const queryToken = urlObj.searchParams.get('token');
    if (queryToken) return auth.getUserBySessionToken(queryToken);
  } catch(e) {}
  return null;
}

function requireAuth(handler, { roles } = {}) {
  return async (req, res, params) => {
    const user = getAuthUser(req);
    if (!user) return sendJson(res, 401, { error: 'Não autenticado. Faça login novamente.' });
    if (roles && !roles.includes(user.role)) return sendJson(res, 403, { error: 'Sem permissão para esta ação.' });
    req.user = user;
    return handler(req, res, params);
  };
}

function requireCapability(capability, handler) {
  return requireAuth((req, res, params) => {
    if (!hasCapability(req.user, capability)) {
      return sendJson(res, 403, { error: 'Sem permissão para esta ação — fora da sua área.' });
    }
    return handler(req, res, params);
  });
}

const router = new Router();

// =============================================================================
// FASE 10.5 — CORREÇÃO: Rate limiting geral (não só login)
// =============================================================================
const rateLimitMap = new Map(); // key -> { count, windowStart }
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minuto
const RATE_LIMIT_MAX = 120; // 120 requisições por minuto por IP

function checkGeneralRateLimit(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const key = `rl:${ip}`;
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return null;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    return Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000);
  }
  return null;
}

// Limpeza periódica do rate limit map (evita vazamento de memória)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) rateLimitMap.delete(key);
  }
}, 60000).unref();

// FASE 10.5 — Login via form GET nativo (funciona com qualquer proxy)
// O form faz GET para /login?username=xxx&password=xxx
// O servidor valida e redireciona para /#token=xxx
router.get('/login', async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const username = (urlObj.searchParams.get('username') || '').trim();
    const password = urlObj.searchParams.get('password') || '';

    const blockedSeconds = checkLoginRateLimit(username);
    if (blockedSeconds) {
      res.writeHead(302, { Location: '/#error=Muitas tentativas. Tente em ' + blockedSeconds + 's.' });
      return res.end();
    }

    const result = auth.login(username, password);
    if (!result) {
      registerLoginFailure(username);
      res.writeHead(302, { Location: '/#error=Usuário ou senha inválidos.' });
      return res.end();
    }
    if (result.pendingFirstAccess) {
      res.writeHead(302, { Location: '/#error=Primeiro acesso pendente.' });
      return res.end();
    }
    clearLoginFailures(username);
    logAudit({ actorUserId: result.user.id, actorLabel: result.user.name, action: 'auth.login' });
    
    // SSR: Renderizar o app completo com os dados do usuário embutidos
    const fs = require('fs');
    const path = require('path');
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    
    // Injetar dados do usuário
    const token = result.token;
    const user = result.user;
    const capabilities = capabilitiesFor(user);
    
    const injectScript = `<script>window.SEXS_TOKEN='${token}';window.SEXS_USER=${JSON.stringify(user)};window.SEXS_CAPS=${JSON.stringify(capabilities)};</script>`;
    
    // Inserir antes do </head>
    html = html.replace('</head>', injectScript + '</head>');
    
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch(e) {
    res.writeHead(302, { Location: '/#error=Erro interno.' });
    res.end();
  }
});

// Logout via navegação
router.get('/logout', async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = urlObj.searchParams.get('token') || '';
    if (token) auth.invalidateSession(token);
  } catch(e) {}
  res.writeHead(302, { Location: '/' });
  res.end();
});

// ---- Auth ----
router.post('/api/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  const username = (body.username || '').trim();

  const blockedSeconds = checkLoginRateLimit(username);
  if (blockedSeconds) {
    return sendJson(res, 429, { error: `Muitas tentativas com este usuário. Tente novamente em ${blockedSeconds}s.` });
  }

  const result = auth.login(username, body.password);
  if (!result) {
    registerLoginFailure(username);
    return sendJson(res, 401, { error: 'Usuário ou senha inválidos.' });
  }
  if (result.pendingFirstAccess) {
    return sendJson(res, 403, { error: 'Esta conta ainda não concluiu o primeiro acesso. Use o link que a CEO/Marina te enviou para criar sua senha.' });
  }
  clearLoginFailures(username);
  logAudit({ actorUserId: result.user.id, actorLabel: result.user.name, action: 'auth.login' });
  sendJson(res, 200, { ...result, capabilities: capabilitiesFor(result.user) });
});

router.post('/api/auth/logout', requireAuth(async (req, res) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) auth.invalidateSession(token);
  logAudit({ actorUserId: req.user.id, actorLabel: req.user.name, action: 'auth.logout' });
  sendJson(res, 200, { ok: true });
}));

// ---- Primeiro acesso e recuperação de senha ----
router.post('/api/first-access/:token/set-password', async (req, res, params) => {
  const body = await readJsonBody(req);
  try {
    const user = auth.setPasswordViaToken(params.token, 'primeiro_acesso', body.password);
    logAudit({ actorUserId: user.id, actorLabel: user.name, action: 'auth.first_access_completed' });
    // Retornar username para mostrar na tela de sucesso
    sendJson(res, 200, { ok: true, username: user.username, name: user.name });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

router.get('/api/config', async (req, res) => {
  sendJson(res, 200, { demo_mode: IS_DEMO_MODE });
});

// ---- Limite de tentativas de login (Correção Seção 14) ----
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 5 * 60 * 1000;

function checkLoginRateLimit(username) {
  const entry = loginAttempts.get(username);
  if (!entry) return null;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) {
    return Math.ceil((entry.blockedUntil - Date.now()) / 1000);
  }
  return null;
}
function registerLoginFailure(username) {
  const entry = loginAttempts.get(username) || { count: 0, blockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
    entry.count = 0;
  }
  loginAttempts.set(username, entry);
}
function clearLoginFailures(username) { loginAttempts.delete(username); }

router.post('/api/auth/forgot-password', async (req, res) => {
  const body = await readJsonBody(req);
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(body.username);
  if (!user) {
    return sendJson(res, 200, { ok: true, note: 'Se o usuário existir, um link de recuperação foi gerado.' });
  }
  const token = auth.issueAccessToken(user.id, 'recuperacao_senha');
  logAudit({ actorUserId: user.id, actorLabel: user.name, action: 'auth.password_reset_requested' });
  // FASE 10.5 — CORREÇÃO: token NUNCA volta na resposta a menos que
  // SEXSOS_ENABLE_DEMO_TOKEN=true explicitamente. Fail-safe, não fail-open.
  const payload = { ok: true };
  if (IS_DEMO_MODE) payload.dev_only_token = token;
  sendJson(res, 200, payload);
});

router.post('/api/auth/reset-password/:token', async (req, res, params) => {
  const body = await readJsonBody(req);
  try {
    const user = auth.setPasswordViaToken(params.token, 'recuperacao_senha', body.password);
    logAudit({ actorUserId: user.id, actorLabel: user.name, action: 'auth.password_reset_completed' });
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

router.get('/api/me', requireAuth((req, res) => {
  sendJson(res, 200, { user: auth.publicUser(req.user), capabilities: capabilitiesFor(req.user) });
}));

// ---- Conversas ----
router.get('/api/conversations/:thread', requireAuth((req, res, params) => {
  const rows = db
    .prepare('SELECT * FROM conversation_messages WHERE user_id = ? AND thread = ? ORDER BY id ASC')
    .all(req.user.id, params.thread);
  sendJson(res, 200, { messages: rows });
}, { roles: ['ceo'] }));

router.post('/api/messages', requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  const { thread, text } = body;
  if (!thread || !text) return sendJson(res, 400, { error: 'thread e text são obrigatórios.' });
  if (typeof text !== 'string' || text.length > 2000) return sendJson(res, 400, { error: 'Mensagem inválida ou longa demais.' });

  const mention = conversationalBrain.extractMention(text);
  const effectiveThread = mention.thread || thread;
  const effectiveText = mention.thread ? mention.text : text;

  db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body) VALUES (?,?,?,?)').run(req.user.id, effectiveThread, 'ceo', text);

  let result;
  try {
    result = await proposalService.handleDirectorMessage({ thread: effectiveThread, text: effectiveText, userId: req.user.id });
  } catch (e) {
    return sendJson(res, 500, { error: `Falhou ao processar mensagem: ${e.message}` });
  }

  db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body, proposal_id) VALUES (?,?,?,?,?)').run(
    req.user.id, effectiveThread, 'agente', result.reply, result.proposal ? result.proposal.id : null
  );

  sendJson(res, 200, { ...result, routed_to: effectiveThread });
}, { roles: ['ceo'] }));

router.post('/api/brain/message', requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  const { text } = body;
  if (!text) return sendJson(res, 400, { error: 'text é obrigatório.' });
  if (typeof text !== 'string' || text.length > 2000) return sendJson(res, 400, { error: 'Mensagem inválida ou longa demais.' });

  let result;
  try {
    result = await conversationalBrain.routeMessage({ text, userId: req.user.id });
  } catch (e) {
    return sendJson(res, 500, { error: `Falhou ao processar mensagem: ${e.message}` });
  }

  db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body) VALUES (?,?,?,?)').run(req.user.id, result.routed_to, 'ceo', text);
  db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body, proposal_id) VALUES (?,?,?,?,?)').run(
    req.user.id, result.routed_to, 'agente', result.reply, result.proposal ? result.proposal.id : null
  );

  if (result.routed_to !== 'ana') {
    const label = conversationalBrain.DIRECTOR_LABEL[result.routed_to] || result.routed_to;
    db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body) VALUES (?,?,?,?)').run(req.user.id, 'ana', 'ceo', text);
    db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body) VALUES (?,?,?,?)').run(
      req.user.id, 'ana', 'agente', `Encaminhei para ${label}. ${label} respondeu: ${result.reply}`
    );
  }

  sendJson(res, 200, result);
}, { roles: ['ceo'] }));

// FASE 10.5 — Actions via GET com redirect (funciona com qualquer proxy)
router.get('/api/messages', requireAuth(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const thread = urlObj.searchParams.get('thread') || 'ana';
  const text = urlObj.searchParams.get('text') || '';
  const redirect = urlObj.searchParams.get('redirect') || ('/app?token=' + (urlObj.searchParams.get('token') || ''));
  if (text) {
    try {
      db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body) VALUES (?,?,?,?)').run(req.user.id, thread, 'ceo', text);
      const result = await proposalService.handleDirectorMessage({ thread, text, userId: req.user.id });
      db.prepare('INSERT INTO conversation_messages (user_id, thread, sender, body, proposal_id) VALUES (?,?,?,?,?)').run(req.user.id, thread, 'agente', result.reply, result.proposal ? result.proposal.id : null);
    } catch(e) {}
  }
  res.writeHead(302, { Location: redirect });
  res.end();
}, { roles: ['ceo'] }));

router.get('/api/proposals/:id/approve', requireAuth((req, res, params) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const redirect = urlObj.searchParams.get('redirect') || ('/app?token=' + (urlObj.searchParams.get('token') || ''));
  try { proposalService.approveAndExecute(Number(params.id), req.user); } catch(e) {}
  res.writeHead(302, { Location: redirect });
  res.end();
}, { roles: ['ceo'] }));

router.get('/api/proposals/:id/reject', requireAuth((req, res, params) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const redirect = urlObj.searchParams.get('redirect') || ('/app?token=' + (urlObj.searchParams.get('token') || ''));
  try { proposalService.reject(Number(params.id), req.user, null); } catch(e) {}
  res.writeHead(302, { Location: redirect });
  res.end();
}, { roles: ['ceo'] }));

// ---- Propostas ----
router.get('/api/proposals', requireAuth((req, res) => {
  // FASE 10.5 — CORREÇÃO: url.parse substituído por new URL()
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const status = urlObj.searchParams.get('status');
  sendJson(res, 200, { proposals: proposalService.listProposals({ status }) });
}, { roles: ['ceo'] }));

router.post('/api/proposals/:id/approve', requireAuth((req, res, params) => {
  try {
    const proposal = proposalService.approveAndExecute(Number(params.id), req.user);
    sendJson(res, 200, { proposal });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}, { roles: ['ceo'] }));

router.post('/api/proposals/:id/reject', requireAuth(async (req, res, params) => {
  const body = await readJsonBody(req);
  try {
    const proposal = proposalService.reject(Number(params.id), req.user, body.reason);
    sendJson(res, 200, { proposal });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}, { roles: ['ceo'] }));

// ---- Produtos / Estoque (Diego) ----
// FASE 10.5 — CORREÇÃO: N+1 query resolvida com query única agregada
router.get('/api/products', requireCapability('stock:read', (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  // Saldo: physical = estoque real (movimentos), reserved = itens com revendedoras, available = physical
  const balances = db.prepare(`
    SELECT p.id,
           COALESCE((SELECT SUM(quantity) FROM stock_movements WHERE product_id = p.id), 0) as physical_balance,
           COALESCE((SELECT SUM(ki.quantity_delivered - ki.quantity_confirmed_sold - ki.quantity_returned)
                     FROM kit_items ki JOIN kits k ON k.id = ki.kit_id
                     WHERE ki.product_id = p.id AND k.status IN ('entregue','aguardando_fechamento')
                       AND ki.quantity_delivered > 0), 0) as reserved
    FROM products p
  `).all();
  const balanceMap = new Map(balances.map(b => [b.id, b]));
  const withBalance = products.map((p) => {
    const bal = balanceMap.get(p.id) || { physical_balance: 0, reserved: 0 };
    return { ...p, physical_balance: bal.physical_balance, reserved: bal.reserved, available_balance: bal.physical_balance };
  });
  sendJson(res, 200, { products: withBalance });
}));

router.get('/api/stock-movements', requireCapability('stock:read', (req, res) => {
  const rows = db.prepare(
    `SELECT m.*, p.name as product_name FROM stock_movements m JOIN products p ON p.id = m.product_id ORDER BY m.id DESC LIMIT 200`
  ).all();
  sendJson(res, 200, { movements: rows });
}));

router.get('/api/resellers/basic', requireCapability('resellers:basic', (req, res) => {
  const rows = db.prepare('SELECT id, name, status FROM resellers ORDER BY name').all();
  sendJson(res, 200, { resellers: rows });
}));

// ---- Auditoria ----
router.get('/api/audit-log', requireAuth((req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
  sendJson(res, 200, { audit_log: rows.map((r) => ({ ...r, details: r.details_json ? JSON.parse(r.details_json) : null })) });
}, { roles: ['ceo'] }));

// ---- Regra de precificação ----
router.get('/api/pricing-rule', requireCapability('pricing:read', (req, res) => {
  sendJson(res, 200, { rule: proposalService.getActivePricingRule() });
}));

// ---- Revendedoras ----
router.get('/api/resellers', requireCapability('resellers:read', (req, res) => {
  sendJson(res, 200, { resellers: resellerService.listResellers() });
}));

router.post('/api/resellers/:id/regenerate-access', requireCapability('resellers:write', (req, res, params) => {
  try {
    const result = resellerService.regenerateFirstAccess(Number(params.id), req.user);
    sendJson(res, 200, result);
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.get('/api/ranking', requireCapability('ranking:read', (req, res) => {
  sendJson(res, 200, { ranking: kitService.rankingFull() });
}));

// ---- Kits consignados ----
router.get('/api/kits', requireCapability('kits:read', (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  sendJson(res, 200, { kits: kitService.listKits({ resellerId: urlObj.searchParams.get('reseller_id') ? Number(urlObj.searchParams.get('reseller_id')) : undefined, status: urlObj.searchParams.get('status') }) });
}));

// CEO: Produtos nos kits das revendedoras + estoque reservado (DEVE vir antes de /kits/:id)
router.get('/api/kits/products-summary', requireAuth((req, res) => {
  const items = db.prepare(`
    SELECT ki.product_id, p.name as product_name, ki.quantity_suggested, ki.quantity_delivered,
           ki.quantity_confirmed_sold, ki.quantity_returned, ki.unit_sale_price_cents,
           k.id as kit_id, k.status as kit_status, k.reseller_id, r.name as reseller_name
    FROM kit_items ki
    JOIN products p ON p.id = ki.product_id
    JOIN kits k ON k.id = ki.kit_id
    JOIN resellers r ON r.id = k.reseller_id
    WHERE k.status IN ('entregue', 'aguardando_fechamento', 'aprovado')
    ORDER BY r.name, p.name
  `).all();
  // Estoque reservado = itens entregues em kits ativos que ainda não foram vendidos/devolvidos
  const reserved = db.prepare(`
    SELECT ki.product_id, p.name as product_name,
           SUM(ki.quantity_delivered - ki.quantity_confirmed_sold - ki.quantity_returned) as total_reserved
    FROM kit_items ki
    JOIN products p ON p.id = ki.product_id
    JOIN kits k ON k.id = ki.kit_id
    WHERE k.status IN ('entregue', 'aguardando_fechamento')
      AND ki.quantity_delivered > 0
    GROUP BY ki.product_id
    HAVING total_reserved > 0
    ORDER BY p.name
  `).all();
  sendJson(res, 200, { kit_items: items, reserved_stock: reserved });
}));

router.get('/api/kits/:id', requireCapability('kits:read', (req, res, params) => {
  const kit = kitService.getKit(Number(params.id));
  if (!kit) return sendJson(res, 404, { error: 'Kit não encontrado.' });
  sendJson(res, 200, { kit });
}));

router.post('/api/kits/suggest', requireCapability('kits:manage', async (req, res) => {
  const body = await readJsonBody(req);
  try {
    const kit = kitService.suggestKit({ resellerId: body.reseller_id, items: body.items, userId: req.user.id });
    sendJson(res, 200, { kit });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.post('/api/kits/:id/approve', requireAuth((req, res, params) => {
  try { sendJson(res, 200, { kit: kitService.approveKit(Number(params.id), req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/kits/:id/reject', requireAuth(async (req, res, params) => {
  const body = await readJsonBody(req);
  try { sendJson(res, 200, { kit: kitService.rejectKit(Number(params.id), req.user, body.reason) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/kits/:id/cancel', requireAuth(async (req, res, params) => {
  const body = await readJsonBody(req);
  try { sendJson(res, 200, { kit: kitService.cancelApprovedKit(Number(params.id), req.user, body.reason) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/kits/:id/start-preparation', requireAuth((req, res, params) => {
  try { sendJson(res, 200, { kit: kitService.startPreparation(Number(params.id), req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/kits/:id/confirm-delivery', requireAuth((req, res, params) => {
  try { sendJson(res, 200, { kit: kitService.confirmDelivery(Number(params.id), req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/kits/:id/request-closure', requireAuth((req, res, params) => {
  try { sendJson(res, 200, { kit: kitService.requestClosure(Number(params.id), req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.get('/api/kits/:id/reconciliation', requireAuth((req, res, params) => {
  try { sendJson(res, 200, { items: kitService.getReconciliationDraft(Number(params.id)) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/kits/:id/reconciliation/:itemId', requireAuth(async (req, res, params) => {
  const body = await readJsonBody(req);
  try {
    const saved = kitService.saveReconciliationItem({ kitId: Number(params.id), kitItemId: Number(params.itemId), values: body, ceoUser: req.user });
    sendJson(res, 200, { item: saved });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

// ADMIN: Force delete a kit (remove all related data)
router.post('/api/kits/:id/force-delete', requireAuth(async (req, res, params) => {
  try {
    const kitId = Number(params.id);
    const kit = kitService.getKit(kitId);
    if (!kit) return sendJson(res, 404, { error: 'Kit não encontrado' });
    
    // Return stock if kit was delivered
    if (['entregue', 'aguardando_fechamento', 'encerrado'].includes(kit.status)) {
      for (const item of kit.items) {
        const qty = item.quantity_delivered || item.quantity_suggested || 0;
        if (qty > 0) {
          const bal = db.prepare('SELECT COALESCE(SUM(quantity),0) as b FROM stock_movements WHERE product_id = ?').get(item.product_id).b;
          db.prepare('INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?)')
            .run(item.product_id, 'retorno_kit', qty, bal + qty, 'Retorno kit #' + kitId + ' (deletado)', req.user.id);
        }
      }
    }
    
    // Release reservations
    db.prepare("UPDATE stock_reservations SET status = 'liberada' WHERE kit_id = ?").run(kitId);
    
    // Delete all related data
    const kitItemIds = db.prepare("SELECT id FROM kit_items WHERE kit_id = ?").all(kitId).map(r => r.id);
    if (kitItemIds.length > 0) {
      const placeholders = kitItemIds.map(() => '?').join(',');
      db.prepare("DELETE FROM kit_sales WHERE kit_item_id IN (" + placeholders + ")").run(...kitItemIds);
      db.prepare("DELETE FROM kit_item_reconciliations WHERE kit_item_id IN (" + placeholders + ")").run(...kitItemIds);
    }
    db.prepare("DELETE FROM kit_closures WHERE kit_id = ?").run(kitId);
    db.prepare("DELETE FROM kit_items WHERE kit_id = ?").run(kitId);
    db.prepare("DELETE FROM kits WHERE id = ?").run(kitId);
    
    sendJson(res, 200, { ok: true, message: 'Kit #' + kitId + ' deletado com sucesso' });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

// ADMIN: Force close kit (skip reconciliation check)
router.post('/api/kits/:id/force-close', requireAuth(async (req, res, params) => {
  try {
    const kitId = Number(params.id);
    const kit = kitService.getKit(kitId);
    if (!kit) return sendJson(res, 404, { error: 'Kit não encontrado' });
    if (kit.status !== 'aguardando_fechamento') return sendJson(res, 400, { error: 'Kit não está aguardando fechamento' });
    
    const CEO_ID = req.user.id;
    
    // Confirm all pending sales (via kit_items)
    const pendingSales = db.prepare("SELECT ks.id FROM kit_sales ks JOIN kit_items ki ON ki.id = ks.kit_item_id WHERE ki.kit_id = ? AND ks.status = 'informada'").all(kitId);
    for (const sale of pendingSales) {
      try { kitService.decideSale(sale.id, 'confirm', req.user); } catch(e) {}
    }
    
    // Create/finalize ALL reconciliation items for this kit
    // Use pending_closure as sold (what reseller reported) and available as returned
    const kitItems = db.prepare("SELECT * FROM kit_items WHERE kit_id = ?").all(kitId);
    for (const ki of kitItems) {
      const soldQty = ki.quantity_pending_closure + ki.quantity_confirmed_sold;
      const returnedQty = ki.quantity_available;
      const existing = db.prepare("SELECT * FROM kit_item_reconciliations WHERE kit_item_id = ?").get(ki.id);
      if (existing) {
        db.prepare("UPDATE kit_item_reconciliations SET quantity_sold_confirmed = ?, quantity_returned = ?, finalized = 1, updated_at = datetime('now') WHERE id = ?")
          .run(soldQty, returnedQty, existing.id);
      } else {
        db.prepare("INSERT INTO kit_item_reconciliations (kit_id, kit_item_id, quantity_sold_confirmed, quantity_returned, finalized, created_by) VALUES (?,?,?,?,1,?)")
          .run(kitId, ki.id, soldQty, returnedQty, CEO_ID);
      }
    }
    
    // Force approve closure
    const closure = kitService.approveClosure(kitId, req.user);
    sendJson(res, 200, { ok: true, kit: kitService.getKit(kitId), closure });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/kits/:id/approve-closure', requireAuth((req, res, params) => {
  try { sendJson(res, 200, kitService.approveClosure(Number(params.id), req.user)); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.get('/api/kits/:id/pending-sales', requireAuth((req, res, params) => {
  sendJson(res, 200, { sales: kitService.pendingSalesForReview({ kitId: Number(params.id) }) });
}, { roles: ['ceo'] }));

router.post('/api/kit-sales/:id/decide', requireAuth(async (req, res, params) => {
  const body = await readJsonBody(req);
  try { sendJson(res, 200, { sale: kitService.decideSale(Number(params.id), body.action, req.user, body.note) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

// ---- Portal da revendedora ----
function requireReseller(handler) {
  return requireAuth((req, res, params) => {
    if (req.user.role !== 'revendedora' || !req.user.reseller_id) {
      return sendJson(res, 403, { error: 'Esta área é exclusiva do portal da revendedora.' });
    }
    return handler(req, res, params);
  });
}

router.get('/api/portal/me', requireReseller((req, res) => {
  const reseller = resellerService.getResellerByUserId(req.user.id);
  sendJson(res, 200, { reseller });
}));

router.get('/api/portal/kits', requireReseller((req, res) => {
  const allKits = kitService.listKits({ resellerId: req.user.reseller_id });
  // Esconder kits rejeitados da revendedora
  const visibleKits = allKits.filter(k => k.status !== 'rejeitado');
  sendJson(res, 200, { kits: visibleKits });
}));

router.get('/api/portal/kits/:id', requireReseller((req, res, params) => {
  const kit = kitService.getKit(Number(params.id));
  if (!kit || kit.reseller_id !== req.user.reseller_id) return sendJson(res, 404, { error: 'Kit não encontrado.' });
  // Filtrar dados: revendedora só vê nome, quantidade e preço de venda
  const filteredKit = {
    ...kit,
    items: kit.items.map(item => ({
      id: item.id,
      product_name: item.product_name,
      quantity_available: item.quantity_available,
      quantity_suggested: item.quantity_suggested,
      quantity_confirmed_sold: item.quantity_confirmed_sold,
      quantity_pending_closure: item.quantity_pending_closure,
      quantity_returned: item.quantity_returned,
      unit_sale_price_cents: item.unit_sale_price_cents,
    })),
    // Não enviar dados sensíveis
    reseller: { name: kit.reseller?.name },
  };
  // Remover campos internos
  delete filteredKit.reseller_id;
  delete filteredKit.created_by;
  delete filteredKit.approved_by;
  sendJson(res, 200, { kit: filteredKit });
}));

router.post('/api/portal/kit-items/:id/inform-sale', requireReseller(async (req, res, params) => {
  const body = await readJsonBody(req);
  try {
    const sale = kitService.informSale({ kitItemId: Number(params.id), quantity: body.quantity, resellerUser: req.user });
    sendJson(res, 200, { sale });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.post('/api/portal/kits/:id/request-closure', requireReseller((req, res, params) => {
  try { sendJson(res, 200, { kit: kitService.requestClosure(Number(params.id), req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.get('/api/portal/ranking', requireReseller((req, res) => {
  sendJson(res, 200, { ranking: kitService.rankingForReseller(req.user.reseller_id) });
}));

router.get('/api/portal/tips', requireReseller((req, res) => {
  sendJson(res, 200, { tips: ordersService.listActiveTips() });
}));

router.get('/api/portal/orders', requireReseller((req, res) => {
  sendJson(res, 200, { orders: ordersService.listOrdersForReseller(req.user.reseller_id) });
}));

router.post('/api/portal/orders', requireReseller(async (req, res) => {
  const body = await readJsonBody(req);
  try {
    const order = ordersService.createOrder({ resellerId: req.user.reseller_id, productId: Number(body.product_id), quantity: Number(body.quantity), note: body.note });
    sendJson(res, 200, { order });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.get('/api/portal/products', requireReseller((req, res) => {
  const rows = db.prepare('SELECT id, name FROM products WHERE active = 1 ORDER BY name').all();
  sendJson(res, 200, { products: rows });
}));

// ---- Portal: Minhas Vendas (histórico da revendedora) ----
router.get('/api/portal/sales', requireReseller((req, res) => {
  const resellerId = req.user.reseller_id;
  const sales = db.prepare(`
    SELECT ks.id, ks.quantity, ks.unit_price_cents, ks.status, ks.created_at,
           p.name as product_name, ki.kit_id
    FROM kit_sales ks
    JOIN kit_items ki ON ki.id = ks.kit_item_id
    JOIN products p ON p.id = ki.product_id
    JOIN kits k ON k.id = ki.kit_id
    WHERE k.reseller_id = ?
    ORDER BY ks.created_at DESC
  `).all(resellerId);

  const totalSold = sales.filter(s => s.status === 'confirmada' || s.status === 'informada')
    .reduce((sum, s) => sum + s.quantity * s.unit_price_cents, 0);
  const totalConfirmed = sales.filter(s => s.status === 'confirmada')
    .reduce((sum, s) => sum + s.quantity * s.unit_price_cents, 0);
  const commissionPct = db.prepare('SELECT commission_pct FROM resellers WHERE id = ?').get(resellerId)?.commission_pct || 0.30;
  const commissionEarned = Math.round(totalConfirmed * commissionPct);

  sendJson(res, 200, {
    sales,
    summary: {
      total_sold_cents: totalSold,
      total_confirmed_cents: totalConfirmed,
      commission_pct: commissionPct,
      commission_earned_cents: commissionEarned,
      items_sold: sales.reduce((sum, s) => sum + s.quantity, 0),
    }
  });
}));

// ---- Portal: Recados da revendedora para CEO ----
router.get('/api/portal/messages', requireReseller((req, res) => {
  const msgs = db.prepare(`
    SELECT id, message, read_at, created_at
    FROM reseller_messages
    WHERE reseller_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.reseller_id);
  sendJson(res, 200, { messages: msgs });
}));

router.post('/api/portal/messages', requireReseller(async (req, res) => {
  const body = await readJsonBody(req);
  if (!body.message || !body.message.trim()) return sendJson(res, 400, { error: 'Mensagem vazia.' });
  const info = db.prepare('INSERT INTO reseller_messages (reseller_id, message) VALUES (?, ?)')
    .run(req.user.reseller_id, body.message.trim());
  sendJson(res, 200, { ok: true, id: info.lastInsertRowid });
}));

// ---- CEO: Recados das revendedoras ----
router.get('/api/reseller-messages', requireAuth((req, res) => {
  const msgs = db.prepare(`
    SELECT rm.id, rm.message, rm.read_at, rm.created_at,
           r.name as reseller_name, r.id as reseller_id
    FROM reseller_messages rm
    JOIN resellers r ON r.id = rm.reseller_id
    ORDER BY rm.created_at DESC LIMIT 100
  `).all();
  const unread = msgs.filter(m => !m.read_at).length;
  sendJson(res, 200, { messages: msgs, unread });
}));

router.post('/api/reseller-messages/:id/read', requireAuth((req, res) => {
  db.prepare("UPDATE reseller_messages SET read_at = datetime('now') WHERE id = ?").run(Number(req.params.id));
  sendJson(res, 200, { ok: true });
}));



// ---- Ricardo (comercial) ----
router.get('/api/commercial/performance', requireCapability('commercial:read', (req, res) => {
  sendJson(res, 200, { performance: commercialService.performanceSnapshot() });
}));

// ---- Theo (marketing) ----
router.get('/api/marketing/campaigns', requireCapability('marketing:read', (req, res) => {
  sendJson(res, 200, { campaigns: marketingService.listCampaigns() });
}));

// ---- Arthur (conselheiro) ----
router.get('/api/advisory/synthesis', requireCapability('advisory:read', (req, res) => {
  sendJson(res, 200, { synthesis: advisorService.synthesize() });
}));

// ---- Dados legais da empresa ----
router.get('/api/company', requireAuth((req, res) => {
  sendJson(res, 200, { company: companyService.getCompanyInfo() });
}, { roles: ['ceo'] }));

router.post('/api/company', requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  try { sendJson(res, 200, { company: companyService.setCompanyInfo(body, req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

// ---- Conselho Executivo ----
router.post('/api/council/convene', requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  try {
    const briefing = await councilService.runDebate({ topic: body.topic, ceoUser: req.user });
    sendJson(res, 200, { briefing });
  } catch (e) {
    sendJson(res, 500, { error: `Falha ao convocar o conselho: ${e.message}` });
  }
}, { roles: ['ceo'] }));

router.get('/api/council/decisions', requireAuth((req, res) => {
  sendJson(res, 200, { decisions: councilService.listDecisions() });
}, { roles: ['ceo', 'diretor'] }));

router.post('/api/council/decisions', requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  if (!body.description) return sendJson(res, 400, { error: 'Descrição é obrigatória.' });
  const decision = councilService.createDecision({ topic: body.topic, description: body.description, assignedTo: body.assigned_to, dueDate: body.due_date, ceoUser: req.user });
  sendJson(res, 200, { decision });
}, { roles: ['ceo'] }));

router.post('/api/council/decisions/:id/complete', requireAuth((req, res, params) => {
  try { sendJson(res, 200, { decision: councilService.completeDecision(Number(params.id), req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

// ---- Documentos ----
router.get('/api/resellers/:id/documents', requireCapability('documents:read', (req, res, params) => {
  sendJson(res, 200, { documents: documentService.listDocumentsForReseller(Number(params.id)) });
}));

router.post('/api/documents/:id/status', requireCapability('documents:write', async (req, res, params) => {
  const body = await readJsonBody(req);
  try { sendJson(res, 200, { document: documentService.updateDocumentStatus(Number(params.id), body.status, req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.get('/api/documents/:id/download', requireCapability('documents:read', async (req, res, params) => {
  const document = documentService.getDocumentById(Number(params.id));
  if (!document) return sendJson(res, 404, { error: 'Documento não encontrado.' });
  try {
    const buffer = await docxGenerator.generateDocx(document);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${document.type}-${document.id}.docx"`,
      'Content-Length': buffer.length,
    });
    res.end(buffer);
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'Falha ao gerar o documento.' });
  }
}));

// ---- Pedidos consolidados (Diego) ----
router.get('/api/orders/consolidated', requireCapability('orders:read', (req, res) => {
  sendJson(res, 200, { demand: ordersService.consolidatedDemand() });
}));

// ---- Dicas rápidas ----
router.get('/api/tips', requireCapability('tips:write', (req, res) => {
  sendJson(res, 200, { tips: ordersService.listActiveTips() });
}));

router.post('/api/tips', requireCapability('tips:write', async (req, res) => {
  const body = await readJsonBody(req);
  try { sendJson(res, 200, { tip: ordersService.createTip(body.text, req.user) }); }
  catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.post('/api/tips/:id/deactivate', requireCapability('tips:write', (req, res, params) => {
  ordersService.deactivateTip(Number(params.id), req.user);
  sendJson(res, 200, { ok: true });
}));

// ---- Comissão individual ----
router.post('/api/resellers/:id/commission', requireAuth(async (req, res, params) => {
  const body = await readJsonBody(req);
  try {
    const pct = body.commission_pct === null || body.commission_pct === '' ? null : Number(body.commission_pct);
    sendJson(res, 200, { reseller: resellerService.setCommission(Number(params.id), pct, req.user) });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

// ---- Notificações ----
router.get('/api/notifications', requireAuth((req, res) => {
  sendJson(res, 200, { notifications: notificationService.listForRole(req.user.role === 'ceo' ? 'ceo' : req.user.role) });
}, { roles: ['ceo'] }));

router.post('/api/notifications/:id/read', requireAuth((req, res, params) => {
  notificationService.markRead(Number(params.id));
  sendJson(res, 200, { ok: true });
}, { roles: ['ceo'] }));

router.post('/api/notifications/read-all', requireAuth((req, res) => {
  notificationService.markAllRead('ceo');
  sendJson(res, 200, { ok: true });
}, { roles: ['ceo'] }));

// ---- Painel consolidado ----
router.get('/api/dashboard', requireAuth((req, res) => {
  sendJson(res, 200, { dashboard: dashboardService.getDashboard() });
}, { roles: ['ceo'] }));

// ---- Financeiro ----
router.get('/api/financial/summary', requireCapability('financial:read', (req, res) => {
  sendJson(res, 200, { summary: financeService.financialSummary() });
}));

router.get('/api/financial/expenses', requireCapability('financial:read', (req, res) => {
  sendJson(res, 200, { expenses: financeService.listExpenses() });
}));

router.get('/api/financial/commission-payments', requireCapability('financial:read', (req, res) => {
  sendJson(res, 200, { payments: financeService.listCommissionPayments() });
}));

router.post('/api/financial/commission-payments', requireCapability('financial:write', async (req, res) => {
  const body = await readJsonBody(req);
  try {
    const payment = financeService.recordCommissionPayment({ resellerId: Number(body.reseller_id), kitId: body.kit_id ? Number(body.kit_id) : null, amountCents: Math.round(Number(body.amount_cents)), actorUser: req.user, notes: body.notes });
    sendJson(res, 200, { payment });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.get('/api/financial/receivable-payments', requireCapability('financial:read', (req, res) => {
  sendJson(res, 200, { payments: financeService.listReceivablePayments() });
}));

router.post('/api/financial/receivable-payments', requireCapability('financial:write', async (req, res) => {
  const body = await readJsonBody(req);
  try {
    const payment = financeService.recordReceivablePayment({ resellerId: Number(body.reseller_id), kitId: body.kit_id ? Number(body.kit_id) : null, amountCents: Math.round(Number(body.amount_cents)), actorUser: req.user, notes: body.notes });
    sendJson(res, 200, { payment });
  } catch (e) { sendJson(res, 400, { error: e.message }); }
}));

router.get('/api/pricing-rule/history', requireCapability('pricing:read', (req, res) => {
  const rows = db.prepare('SELECT * FROM pricing_rules ORDER BY version DESC').all();
  sendJson(res, 200, { history: rows });
}));

// =============================================================================
// FASE 10.5 — Health check endpoints
// =============================================================================
const startTime = Date.now();

router.get('/health', async (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    sendJson(res, 200, {
      status: 'ok',
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    sendJson(res, 503, { status: 'error', database: 'disconnected', error: e.message });
  }
});

router.get('/healthz', async (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.writeHead(200); res.end('ok');
  } catch (e) {
    res.writeHead(503); res.end('error');
  }
});

router.get('/ready', async (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    sendJson(res, 200, { ready: true });
  } catch (e) {
    sendJson(res, 503, { ready: false });
  }
});

// ---- Estático (frontend) ----
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': cacheControl });
    res.end(data);
  });
}

// FASE 10.5 — Server-Side Rendering: renderiza o app com dados embutidos no HTML
function serveApp(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = urlObj.searchParams.get('token');
    const user = token ? auth.getUserBySessionToken(token) : null;
    if (!user) { res.writeHead(302, { Location: '/#error=Sessao expirada.' }); return res.end(); }
    const capabilities = capabilitiesFor(user);
    let dashboard = null, conversations = [], proposals = [], notifications = [];
    if (user.role === 'ceo') {
      try { dashboard = dashboardService.getDashboard(); } catch(e) {}
      try { conversations = db.prepare('SELECT * FROM conversation_messages WHERE user_id = ? AND thread = ? ORDER BY id ASC').all(user.id, 'ana'); } catch(e) {}
      try { proposals = proposalService.listProposals({ status: 'pendente' }); } catch(e) {}
      try { notifications = notificationService.listForRole('ceo'); } catch(e) {}
    }
    const initData = JSON.stringify({ token, user: auth.publicUser(user), capabilities, dashboard, conversations, proposals, notifications }).replace(/</g, '\\u003c');
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      const injected = html.replace('</head>', '<script>window.__INIT__=' + initData + ';</script></head>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(injected);
    });
  } catch(e) {
    res.writeHead(302, { Location: '/#error=Erro interno.' });
    res.end();
  }
}

// =============================================================================
// FASE 10.5 — CORREÇÃO: Cabeçalhos de segurança completos
// =============================================================================
function applySecurityHeaders(res, req) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');

  // FASE 10.5 — X-Frame-Options e CSP frame-ancestors:
  // Em produção: DENY (previne clickjacking)
  // Em desenvolvimento/preview: permite iframes (necessário para preview do Arena)
  if (IS_PRODUCTION) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'"
    );
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  } else {
    // Desenvolvimento: permite iframes para preview e connect-src amplo
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: blob:; " +
      "connect-src 'self' *; " +
      "frame-ancestors *"
    );
  }

  // CORS
  const allowedOrigin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Preservar Accept-Encoding para gzip
  if (req && req.headers['accept-encoding']) {
    res.setHeader('X-Original-Accept-Encoding', req.headers['accept-encoding']);
  }
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res, req);

  // FASE 10.5 — Detectar JSONP callback (antes de qualquer sendJson)
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const cb = u.searchParams.get('callback');
    if (cb) res._jsonpCallback = cb;
  } catch(e) {}

  // FASE 10.5 — CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // FASE 10.5 — Rate limiting geral
  const rlBlocked = checkGeneralRateLimit(req);
  if (rlBlocked) {
    return sendJson(res, 429, { error: `Muitas requisições. Tente novamente em ${rlBlocked}s.` });
  }

  // FASE 10.5 — url.parse substituído por new URL()
  let pathname;
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pathname = urlObj.pathname;
  } catch (e) {
    return sendJson(res, 400, { error: 'URL inválida.' });
  }

  // DEBUG LOG — capturar todas as requests para diagnosticar problemas com o proxy
  if (!IS_PRODUCTION) {
    console.log(`[REQ] ${req.method} ${req.url} → pathname: ${pathname}`);
  }

  // FASE 10.5 — Proxy workaround: paths com .js são tratados como API
  // O proxy do Arena só encaminha requests para paths que parecem arquivos.
  // Então o frontend chama /api/auth/login.js e aqui removemos o .js.
  if (pathname.endsWith('.js') && pathname.startsWith('/api/')) {
    pathname = pathname.slice(0, -3); // Remove .js
    req.url = req.url.replace('.js', ''); // Atualizar a URL também
  }

  // FASE 10.5 — Rotas de navegação HTML (login, logout, app)
  if (pathname === '/login' || pathname === '/logout') {
    const match = router.match('GET', pathname);
    if (match) {
      try { await match.handler(req, res, match.params); } catch(e) { res.writeHead(302, { Location: '/#error=Erro' }); res.end(); }
      return;
    }
  }

  if (pathname.startsWith('/api/') || pathname === '/health' || pathname === '/healthz' || pathname === '/ready') {
    let match = router.match(req.method, pathname);

    // FASE 10.5 — Fallback: se a rota só existe como POST mas chegou como GET
    // (proxy do Arena bloqueia POST), trata como se fosse POST com os dados da query string.
    if (!match && req.method === 'GET') {
      match = router.match('POST', pathname);
      if (match) {
        // Simular um body a partir dos query parameters
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const bodyObj = {};
        for (const [key, val] of urlObj.searchParams) {
          if (key !== 'token') bodyObj[key] = val;
        }
        req._simulatedBody = JSON.stringify(bodyObj);
      }
    }

    if (!match) return sendJson(res, 404, { error: 'Rota não encontrada.' });
    try {
      await match.handler(req, res, match.params);
    } catch (e) {
      // FASE 10.5 — CORREÇÃO: Tratamento global de erros
      // Nunca expor stack trace ou detalhes internos em produção
      if (IS_PRODUCTION) {
        console.error(`[ERROR] ${req.method} ${pathname}:`, e.message);
      } else {
        console.error(`[ERROR] ${req.method} ${pathname}:`, e);
      }
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Erro interno do servidor.' });
      }
    }
    return;
  }

  serveStatic(req, res, pathname);
});

// FASE 10.5 — Graceful shutdown
function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Encerrando graciosamente...`);
  server.close(() => {
    console.log('Servidor fechado.');
    process.exit(0);
  });
  // Força encerramento após 10s se não fechar naturalmente
  setTimeout(() => {
    console.error('Forçando encerramento após timeout.');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// FASE 10.5 — Capturar erros não tratados
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// ADMIN: Reset do sistema (apaga dados de teste, mantém CEO e config)
router.post('/api/admin/reset', requireAuth(async (req, res) => {
  const body = await readJsonBody(req);
  if (body.confirm !== 'RESET_SEXS_2026') {
    return sendJson(res, 403, { error: 'Confirmação inválida.' });
  }
  try {
    db.exec('BEGIN');
    // Apagar dados de negócio
    db.exec('DELETE FROM kit_item_reconciliations');
    db.exec('DELETE FROM kit_closures');
    db.exec('DELETE FROM kit_sales');
    db.exec('DELETE FROM kit_items');
    db.exec('DELETE FROM kits');
    db.exec('DELETE FROM stock_reservations');
    db.exec('DELETE FROM stock_movements');
    db.exec('DELETE FROM stock_lots');
    db.exec('DELETE FROM products');
    db.exec('DELETE FROM suppliers');
    db.exec('DELETE FROM documents');
    db.exec('DELETE FROM reseller_orders');
    db.exec('DELETE FROM expenses');
    db.exec('DELETE FROM commission_payments');
    db.exec('DELETE FROM receivable_payments');
    db.exec('DELETE FROM proposals');
    db.exec('DELETE FROM conversation_messages');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM notifications');
    db.exec('DELETE FROM council_decisions');
    db.exec('DELETE FROM marketing_campaigns');
    db.exec('DELETE FROM sales_goals');
    db.exec('DELETE FROM tips');
    db.exec('DELETE FROM product_drafts');
    // Apagar revendedoras e seus users
    db.exec('DELETE FROM resellers');
    db.exec("DELETE FROM users WHERE role = 'revendedora'");
    // Apagar sessões e tokens
    db.exec('DELETE FROM sessions');
    db.exec('DELETE FROM access_tokens');
    // Recriar dicas padrão
    const ceo = db.prepare("SELECT id FROM users WHERE role = 'ceo' LIMIT 1").get();
    if (ceo) {
      const tips = [
        'Guarde os produtos em local seco e longe de luz direta.',
        'Informe a venda assim que acontecer para não esquecer no fechamento.',
        'Dúvidas sobre um produto? Pergunte antes de vender.',
      ];
      for (const t of tips) db.prepare('INSERT INTO tips (text, created_by) VALUES (?,?)').run(t, ceo.id);
    }
    db.exec('COMMIT');
    sendJson(res, 200, { ok: true, message: 'Sistema resetado com sucesso. CEO preservada.' });
  } catch (e) {
    db.exec('ROLLBACK');
    sendJson(res, 500, { error: e.message });
  }
}, { roles: ['ceo'] }));

// ADMIN: Force-seed (repopular todos os cadastros)
router.post('/api/admin/force-seed', requireAuth(async (req, res) => {
  try {
    // Limpar dados de negócio
    db.exec('DELETE FROM kit_item_reconciliations');
    db.exec('DELETE FROM kit_closures');
    db.exec('DELETE FROM kit_sales');
    db.exec('DELETE FROM kit_items');
    db.exec('DELETE FROM kits');
    db.exec('DELETE FROM stock_reservations');
    db.exec('DELETE FROM stock_movements');
    db.exec('DELETE FROM stock_lots');
    db.exec('DELETE FROM products');
    db.exec('DELETE FROM suppliers');
    db.exec("DELETE FROM users WHERE role = 'revendedora'");
    db.exec('DELETE FROM resellers');
    db.exec('DELETE FROM expenses');

    const { simulatePricing } = require('./src/pricing');
    const { hashPassword } = require('./src/auth');
    const rule = db.prepare('SELECT * FROM pricing_rules WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
    const CEO_ID = db.prepare("SELECT id FROM users WHERE role = 'ceo' ORDER BY id LIMIT 1").get().id;
    function brl(v) { return Math.round(v * 100); }

    // Fornecedor
    const supInfo = db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('SexShop Atacadão (Eccosys)');
    const supplierId = supInfo.lastInsertRowid;

    // Produtos
    const products = [
      { name: 'Anel Vibrador Bichinhos', cat: 'Anéis Penianos', code: 'MA001SP', qty: 3, cost: 2.73 },
      { name: 'Egg Spider Sensual Love', cat: 'Estimuladores Masculinos', code: 'MA001SK', qty: 2, cost: 7.74 },
      { name: 'Egg Stepper Sensual Love', cat: 'Estimuladores Masculinos', code: 'MA001ST', qty: 2, cost: 7.74 },
      { name: 'Lubrificante Fresh 30ml - Tutti Frutti', cat: 'Lubrificantes', code: 'LS-TUTTI', qty: 2, cost: 5.34 },
      { name: 'Lubrificante Fresh 30ml - Morango', cat: 'Lubrificantes', code: 'LS-MORANGO', qty: 3, cost: 5.34 },
      { name: 'Lubrificante Fresh 30ml - Menta', cat: 'Lubrificantes', code: 'LS-MENTA', qty: 3, cost: 5.34 },
      { name: 'Gotas Afrodisíacas 20ml', cat: 'Estimulantes Orais', code: 'KGA20', qty: 3, cost: 9.51 },
      { name: 'Gel Massageador 250g', cat: 'Massageadores', code: 'GMS', qty: 1, cost: 4.57 },
      { name: 'Fofa Toba Excitante 15ml', cat: 'Anal', code: 'FOFA', qty: 3, cost: 4.56 },
      { name: 'Papermint Lâminas - Morango', cat: 'Acessórios', code: 'PAPER-MOR', qty: 5, cost: 1.81 },
      { name: 'Papermint Lâminas - Extra Forte', cat: 'Acessórios', code: 'PAPER-EXT', qty: 5, cost: 1.81 },
      { name: 'Kuloko Gel Excitante 15g', cat: 'Géis Excitantes', code: 'HC683', qty: 2, cost: 8.01 },
      { name: 'Triple Shock Bolinhas 3un', cat: 'Bolinhas Funcionais', code: 'TS-BOL', qty: 4, cost: 3.18 },
      { name: 'Vibrador Golfinho - Lilás', cat: 'Vibradores', code: 'SS003-LIL', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Pink', cat: 'Vibradores', code: 'SS003-PNK', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Tiffany', cat: 'Vibradores', code: 'SS003-TIF', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Verde', cat: 'Vibradores', code: 'SS003-VRD', qty: 1, cost: 5.76 },
      { name: 'Vibrador Golfinho - Vermelho', cat: 'Vibradores', code: 'SS003-VRM', qty: 1, cost: 5.76 },
      { name: 'Gel Hot Comestível - Tutti Frutti', cat: 'Géis Excitantes', code: 'GH15-TUT', qty: 1, cost: 5.48 },
      { name: 'Gel Hot Comestível - Uva', cat: 'Géis Excitantes', code: 'GH15-UVA', qty: 2, cost: 5.48 },
      { name: 'Gel Hot Comestível - Morango Champagne', cat: 'Géis Excitantes', code: 'GH15-MOR', qty: 1, cost: 5.48 },
      { name: 'Pênis Aromático 14cm - Tangerina', cat: 'Próteses', code: 'TORSVA-TAN', qty: 1, cost: 10.23 },
      { name: 'Pênis Aromático 14cm - Menta', cat: 'Próteses', code: 'TORSVA-MEN', qty: 1, cost: 10.23 },
      { name: 'Six Ball Black Ice 6un', cat: 'Bolinhas Funcionais', code: '1086', qty: 2, cost: 1.99 },
      { name: 'Power Kiss Jatos - Cereja', cat: 'Aromáticos', code: '104-CER', qty: 2, cost: 3.99 },
      { name: 'Power Kiss Jatos - Black Ice', cat: 'Aromáticos', code: '104-BLK', qty: 2, cost: 3.99 },
      { name: 'Pop Lub Gel Corporal 60g', cat: 'Lubrificantes', code: 'SS012', qty: 3, cost: 3.36 },
      { name: 'Pop Ball Beijável - Morango', cat: 'Lubrificantes', code: 'HC18-MOR', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Beijável - Menta', cat: 'Lubrificantes', code: 'HC18-MEN', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Beijável - Uva', cat: 'Lubrificantes', code: 'HC18-UVA', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Beijável - Frutas Vermelhas', cat: 'Lubrificantes', code: 'HC18-FRV', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Ice', cat: 'Lubrificantes', code: 'HC192', qty: 2, cost: 2.72 },
      { name: 'Pop Ball Hot Ice', cat: 'Lubrificantes', code: 'HC193', qty: 6, cost: 2.72 },
      { name: 'Plug Anal Coração - Roxo', cat: 'Anal', code: 'T002-ROX', qty: 2, cost: 3.20 },
      { name: 'Plug Anal Coração - Rosa', cat: 'Anal', code: 'T002-ROS', qty: 2, cost: 3.20 },
      { name: 'Anel Vibrador Bichinho - Rosa', cat: 'Anéis Penianos', code: '03138-ROSA', qty: 5, cost: 2.70 },
      { name: 'Vibrador Golfinho - Roxo', cat: 'Vibradores', code: '76175-ROXO', qty: 8, cost: 5.99 },
      { name: 'Gotas Afrodisíacas 20ml Klab', cat: 'Estimulantes Orais', code: '4310', qty: 4, cost: 3.90 },
      { name: 'Calcinha Tailandesa - Preta', cat: 'Lingeries', code: '56794-PRETO', qty: 4, cost: 11.24 },
      { name: 'Calcinha Tailandesa - Vermelha', cat: 'Lingeries', code: '56794-VERM', qty: 4, cost: 11.24 },
      { name: 'Egg Clicker Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-CLICK', qty: 1, cost: 4.99 },
      { name: 'Egg Silky Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-SILKY', qty: 1, cost: 4.99 },
      { name: 'Egg Twister Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-TWIST', qty: 1, cost: 4.99 },
      { name: 'Egg Wavy Sensual Love', cat: 'Estimuladores Masculinos', code: '02535-WAVY', qty: 1, cost: 4.99 },
      { name: 'Sabonete Íntimo Babaloob 150ml', cat: 'Higiene Íntima', code: '11746', qty: 1, cost: 4.55 },
      { name: 'Perfume de Calcinha Beijável 40ml', cat: 'Aromáticos', code: '15742', qty: 4, cost: 6.12 },
      { name: 'Bolinha Satisfaction Duo 2un', cat: 'Bolinhas Funcionais', code: '70526', qty: 4, cost: 3.55 },
      { name: 'Bolinha Beijável Yummy - Morango Hot', cat: 'Bolinhas Funcionais', code: '95171-MOR', qty: 3, cost: 4.45 },
      { name: 'Bolinha Kiss Me Hot - Uva 3un', cat: 'Bolinhas Funcionais', code: '72288-UVA', qty: 2, cost: 3.52 },
      { name: 'Bolinha Kiss Me Hot - Morango 3un', cat: 'Bolinhas Funcionais', code: '72288-MOR', qty: 2, cost: 3.52 },
      { name: 'Bolinha Satisfaction Segredos 2un', cat: 'Bolinhas Funcionais', code: '85695', qty: 3, cost: 3.55 },
      { name: 'Plug Anal P - Azul', cat: 'Anal', code: '03124-AZUL', qty: 4, cost: 9.40 },
      { name: 'Gel Glow Virilha 250ml - Tutti Frutti', cat: 'Géis Excitantes', code: '58135-TUT', qty: 1, cost: 5.99 },
      { name: 'Creme Gel Virilha 240ml - Menta Ice', cat: 'Géis Excitantes', code: '33666-MEN', qty: 1, cost: 12.90 },
    ];

    for (const p of products) {
      const costCents = brl(p.cost);
      const pricing = simulatePricing(costCents, rule);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);
      const info = db.prepare('INSERT INTO products (name, category, default_supplier_id, internal_code, unit, last_purchase_cost_cents, min_price_cents, ideal_price_cents, promo_price_cents, low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(p.name, p.cat, supplierId, p.code, 'unidade', costCents, pricing.min_price_cents, pricing.recommended_price_cents, promoPrice, 2);
      const productId = info.lastInsertRowid;
      const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
        .run(productId, supplierId, p.qty, costCents, CEO_ID);
      db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
        .run(productId, lotInfo.lastInsertRowid, 'entrada_compra', p.qty, p.qty, 'Compra SexShop Atacadão', CEO_ID);
    }

    // Revendedoras
    const resellers = [
      { name: 'Yasmin', phone: '(16) 99443-6541', commission: 0.30 },
      { name: 'Flavia', phone: '(16) 99418-1014', commission: 0.30 },
      { name: 'Larissa', phone: '(16) 99401-9877', commission: 0.25 },
      { name: 'Taina', phone: '(16) 99398-0297', commission: 0.25 },
      { name: 'Luana', phone: '(16) 99355-6560', commission: 0.25 },
      { name: 'Gizelle', phone: '(16) 99293-9887', commission: 0.25 },
    ];
    for (const r of resellers) {
      const rInfo = db.prepare('INSERT INTO resellers (name, phone, status, commission_pct, created_by) VALUES (?,?,?,?,?)')
        .run(r.name, r.phone, 'ativa', r.commission, CEO_ID);
      const username = r.name.toLowerCase();
      let uname = username; let n = 1;
      while (db.prepare('SELECT id FROM users WHERE username = ?').get(uname)) { n++; uname = username + n; }
      const { hash, salt } = hashPassword('@Sexs2026');
      db.prepare('INSERT INTO users (name, username, role, reseller_id, password_hash, password_salt) VALUES (?,?,?,?,?,?)')
        .run(r.name, uname, 'revendedora', rInfo.lastInsertRowid, hash, salt);
    }

    const productCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
    const resellerCount = db.prepare('SELECT COUNT(*) as c FROM resellers').get().c;
    sendJson(res, 200, { ok: true, products: productCount, resellers: resellerCount, message: 'Seed concluído!' });
  } catch (e) {
    sendJson(res, 500, { error: e.message, stack: e.stack });
  }
}, { roles: ['ceo'] }));

// ADMIN: Atualizar custos dos produtos a partir de stock_lots
router.post('/api/admin/fix-costs', requireAuth(async (req, res) => {
  try {
    const rule = proposalService.getActivePricingRule();
    const products = db.prepare('SELECT id FROM products').all();
    let updated = 0;
    for (const p of products) {
      const lot = db.prepare('SELECT unit_cost_cents, supplier_id FROM stock_lots WHERE product_id = ? ORDER BY id DESC LIMIT 1').get(p.id);
      if (lot && lot.unit_cost_cents) {
        const { simulatePricing } = require('./src/pricing');
        const pricing = simulatePricing(lot.unit_cost_cents, rule);
        db.prepare('UPDATE products SET last_purchase_cost_cents = ?, default_supplier_id = ?, min_price_cents = ?, ideal_price_cents = ?, promo_price_cents = ? WHERE id = ?')
          .run(lot.unit_cost_cents, lot.supplier_id, pricing.min_price_cents, pricing.current_price_cents, pricing.premium_price_cents, p.id);
        updated++;
      }
    }
    sendJson(res, 200, { ok: true, updated });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}, { roles: ['ceo'] }));

// ADMIN: Merge duplicate products (keep_id gets stock from remove_id, then remove_id is deleted)
router.post('/api/admin/merge-products', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const keepId = Number(body.keep_id);
    const removeId = Number(body.remove_id);
    const newCostCents = body.cost_cents ? Number(body.cost_cents) : null;
    const newName = body.name || null;

    if (!keepId || !removeId || keepId === removeId) {
      return sendJson(res, 400, { error: 'Informe keep_id e remove_id diferentes.' });
    }

    const keepProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(keepId);
    const removeProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(removeId);
    if (!keepProduct || !removeProduct) return sendJson(res, 404, { error: 'Produto não encontrado.' });

    // Transferir estoque do remove_id para keep_id
    const removeLots = db.prepare('SELECT * FROM stock_lots WHERE product_id = ?').all(removeId);
    for (const lot of removeLots) {
      db.prepare('UPDATE stock_lots SET product_id = ? WHERE id = ?').run(keepId, lot.id);
    }
    const removeMovements = db.prepare('SELECT * FROM stock_movements WHERE product_id = ?').all(removeId);
    for (const mov of removeMovements) {
      db.prepare('UPDATE stock_movements SET product_id = ? WHERE id = ?').run(keepId, mov.id);
    }
    // Transferir reservas
    db.prepare('UPDATE stock_reservations SET product_id = ? WHERE product_id = ?').run(keepId, removeId);
    // Transferir kit_items
    db.prepare('UPDATE kit_items SET product_id = ? WHERE product_id = ?').run(keepId, removeId);

    // Recalcular saldo das movimentações do keep_id
    const movements = db.prepare('SELECT id, quantity FROM stock_movements WHERE product_id = ? ORDER BY id').all(keepId);
    let balance = 0;
    for (const m of movements) {
      balance += m.quantity;
      db.prepare('UPDATE stock_movements SET balance_after = ? WHERE id = ?').run(balance, m.id);
    }

    // Atualizar custo e preços se informado
    if (newCostCents) {
      const { simulatePricing } = require('./src/pricing');
      const rule = proposalService.getActivePricingRule();
      const pricing = simulatePricing(newCostCents, rule);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);
      db.prepare('UPDATE products SET last_purchase_cost_cents = ?, min_price_cents = ?, ideal_price_cents = ?, promo_price_cents = ? WHERE id = ?')
        .run(newCostCents, pricing.min_price_cents, pricing.recommended_price_cents, promoPrice, keepId);
    }

    // Atualizar nome se informado
    if (newName) {
      db.prepare('UPDATE products SET name = ? WHERE id = ?').run(newName, keepId);
    }

    // Deletar produto duplicado
    db.prepare('DELETE FROM products WHERE id = ?').run(removeId);

    const updatedProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(keepId);
    const newBalance = db.prepare('SELECT COALESCE(SUM(quantity),0) as bal FROM stock_movements WHERE product_id = ?').get(keepId).bal;

    sendJson(res, 200, {
      ok: true,
      message: `Produtos mesclados! "${removeProduct.name}" removido, estoque transferido para "${updatedProduct.name}".`,
      product: { id: keepId, name: updatedProduct.name, cost: updatedProduct.last_purchase_cost_cents, balance: newBalance }
    });
  } catch (e) {
    sendJson(res, 500, { error: e.message, stack: e.stack });
  }
}, { roles: ['ceo'] }));


// ADMIN: Full reset (clear all business data, keep CEO and pricing rule)
router.post('/api/admin/full-reset', requireAuth(async (req, res) => {
  try {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('DELETE FROM kit_item_reconciliations');
    db.exec('DELETE FROM kit_closures');
    db.exec('DELETE FROM kit_sales');
    db.exec('DELETE FROM kit_items');
    db.exec('DELETE FROM kits');
    db.exec('DELETE FROM stock_reservations');
    db.exec('DELETE FROM stock_movements');
    db.exec('DELETE FROM stock_lots');
    db.exec('DELETE FROM reseller_orders');
    db.exec('DELETE FROM products');
    db.exec('DELETE FROM suppliers');
    db.exec("DELETE FROM users WHERE role = 'revendedora'");
    db.exec('DELETE FROM resellers');
    db.exec('DELETE FROM expenses');
    db.exec('DELETE FROM proposals');
    db.exec('DELETE FROM conversation_messages');
    db.exec('DELETE FROM notifications');
    db.exec('DELETE FROM documents');
    db.exec('DELETE FROM product_drafts');
    db.exec('PRAGMA foreign_keys = ON');
    sendJson(res, 200, { ok: true, message: 'Reset completo. Dados de negócio apagados. CEO e regra de precificação preservados.' });
  } catch (e) {
    db.exec('PRAGMA foreign_keys = ON');
    sendJson(res, 500, { error: e.message });
  }
}, { roles: ['ceo'] }));

// ADMIN: Force cancel a kit (even if delivered) - returns all stock
router.post('/api/admin/force-cancel-kit', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const kitId = Number(body.kit_id);
    if (!kitId) return sendJson(res, 400, { error: 'kit_id required' });
    const kit = kitService.getKit(kitId);
    if (!kit) return sendJson(res, 404, { error: 'Kit not found' });
    
    // Return stock: reverse delivery movements
    if (['entregue', 'aguardando_fechamento'].includes(kit.status)) {
      for (const item of kit.items) {
        const qty = item.quantity_delivered || item.quantity_suggested || 0;
        if (qty > 0) {
          const bal = db.prepare('SELECT COALESCE(SUM(quantity),0) as b FROM stock_movements WHERE product_id = ?').get(item.product_id).b;
          db.prepare('INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?)')
            .run(item.product_id, 'retorno_kit', qty, bal + qty, `Retorno kit #${kitId} (cancelado)`, req.user.id);
        }
      }
      // Release reservations
      db.prepare("UPDATE stock_reservations SET status = 'liberada', released_at = datetime('now') WHERE kit_id = ?").run(kitId);
    }
    
    // Reset kit items
    db.prepare("UPDATE kit_items SET quantity_delivered = 0, quantity_available = 0, quantity_confirmed_sold = 0, quantity_returned = 0 WHERE kit_id = ?").run(kitId);
    
    // Set kit status to rejeitado
    db.prepare("UPDATE kits SET status = 'rejeitado' WHERE id = ?").run(kitId);
    
    sendJson(res, 200, { ok: true, message: `Kit #${kitId} cancelado, estoque retornado.` });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}, { roles: ['ceo'] }));

// ADMIN: Update stock lot costs (affects kit pricing)
router.post('/api/admin/update-lot-costs', requireAuth(async (req, res) => {
  try {
    const updates = await readJsonBody(req);
    if (!Array.isArray(updates)) return sendJson(res, 400, { error: 'Expected array' });
    const { simulatePricing } = require('./src/pricing');
    const rule = proposalService.getActivePricingRule();
    let count = 0;
    for (const u of updates) {
      const pid = Number(u.product_id);
      const costCents = Number(u.cost_cents);
      if (!pid || !costCents) continue;
      db.prepare('UPDATE stock_lots SET unit_cost_cents = ? WHERE product_id = ?').run(costCents, pid);
      const pricing = simulatePricing(costCents, rule);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);
      db.prepare('UPDATE products SET last_purchase_cost_cents = ?, min_price_cents = ?, ideal_price_cents = ?, promo_price_cents = ? WHERE id = ?')
        .run(costCents, pricing.min_price_cents, pricing.recommended_price_cents, promoPrice, pid);
      count++;
    }
    sendJson(res, 200, { ok: true, updated: count });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}, { roles: ['ceo'] }));

// ADMIN: Bulk update product prices
router.post('/api/admin/update-prices', requireAuth(async (req, res) => {
  try {
    const updates = await readJsonBody(req);
    if (!Array.isArray(updates)) return sendJson(res, 400, { error: 'Expected array' });
    const { simulatePricing } = require('./src/pricing');
    const rule = proposalService.getActivePricingRule();
    const results = [];
    for (const u of updates) {
      const pid = Number(u.product_id);
      const costCents = Number(u.cost_cents);
      if (!pid || !costCents) continue;
      const pricing = simulatePricing(costCents, rule);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);
      db.prepare('UPDATE products SET last_purchase_cost_cents = ?, min_price_cents = ?, ideal_price_cents = ?, promo_price_cents = ? WHERE id = ?')
        .run(costCents, pricing.min_price_cents, pricing.recommended_price_cents, promoPrice, pid);
      results.push({ id: pid, cost: costCents, sale: pricing.recommended_price_cents });
    }
    sendJson(res, 200, { ok: true, updated: results.length });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}, { roles: ['ceo'] }));

// ADMIN: Adjust stock to match original purchase quantities
router.post('/api/admin/adjust-stock', requireAuth(async (req, res) => {
  try {
    const adjustments = await readJsonBody(req);
    if (!Array.isArray(adjustments)) return sendJson(res, 400, { error: 'Expected array' });
    const results = [];
    for (const adj of adjustments) {
      const pid = Number(adj.product_id);
      const diff = Number(adj.diff);
      if (!pid || !diff) continue;
      const bal = db.prepare('SELECT COALESCE(SUM(quantity),0) as b FROM stock_movements WHERE product_id = ?').get(pid).b;
      const newBal = bal + diff;
      if (newBal < 0) {
        results.push({ id: pid, error: 'saldo negativo', current: bal, diff });
        continue;
      }
      db.prepare('INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?)')
        .run(pid, diff > 0 ? 'ajuste_positivo' : 'ajuste_negativo', diff, newBal, 'Ajuste para estoque original', req.user.id);
      results.push({ id: pid, ok: true, old: bal, new: newBal, diff });
    }
    sendJson(res, 200, { ok: true, results });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}, { roles: ['ceo'] }));

// ADMIN: Bulk add products with cost and quantity

// ADMIN: Fix a closed kit's item counts (correct sold vs returned)
router.post('/api/admin/fix-closed-kit', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const kitId = Number(body.kit_id);
    const corrections = body.corrections; // [{kit_item_id, correct_sold, correct_returned}]
    
    const kit = kitService.getKit(kitId);
    if (!kit) return sendJson(res, 404, { error: 'Kit não encontrado' });
    
    let totalSoldCents = 0;
    let totalReturnedToStock = 0;
    
    for (const corr of corrections) {
      const ki = db.prepare("SELECT * FROM kit_items WHERE id = ? AND kit_id = ?").get(corr.kit_item_id, kitId);
      if (!ki) continue;
      
      const correctSold = Number(corr.correct_sold);
      const correctReturned = Number(corr.correct_returned);
      const previousReturned = ki.quantity_returned;
      const returnedDiff = correctReturned - previousReturned;
      
      // Update kit_items
      db.prepare("UPDATE kit_items SET quantity_confirmed_sold = ?, quantity_returned = ?, quantity_available = 0, quantity_pending_closure = 0 WHERE id = ?")
        .run(correctSold, correctReturned, ki.id);
      
      // Also update kit_item_reconciliations
      const recon = db.prepare("SELECT id FROM kit_item_reconciliations WHERE kit_item_id = ?").get(ki.id);
      if (recon) {
        db.prepare("UPDATE kit_item_reconciliations SET quantity_sold_confirmed = ?, quantity_returned = ?, finalized = 1, updated_at = datetime('now') WHERE id = ?")
          .run(correctSold, correctReturned, recon.id);
      }
      
      // Return items to stock (via stock_movements only - physical_balance is computed)
      if (returnedDiff > 0) {
        db.prepare("INSERT INTO stock_movements (product_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?)")
          .run(ki.product_id, 'entrada_devolucao', returnedDiff, 0,
            `Correção fechamento kit #${kitId}: ${returnedDiff}un devolvidas (não vendidas)`, req.user.id);
        totalReturnedToStock += returnedDiff;
      }
      
      totalSoldCents += correctSold * ki.unit_sale_price_cents;
    }
    
    // Update kit_closures
    const commissionPct = kit.reseller ? kit.reseller.commission_pct : 0.3;
    const commissionCents = Math.round(totalSoldCents * commissionPct);
    const dueToSexs = totalSoldCents - commissionCents;
    
    let cogs = 0;
    const allItems = db.prepare("SELECT ki.*, p.last_purchase_cost_cents FROM kit_items ki JOIN products p ON p.id = ki.product_id WHERE ki.kit_id = ?").all(kitId);
    for (const item of allItems) {
      cogs += (item.quantity_confirmed_sold || 0) * (item.last_purchase_cost_cents || 0);
    }
    const grossProfit = dueToSexs - cogs;
    
    const existingClosure = db.prepare("SELECT id FROM kit_closures WHERE kit_id = ?").get(kitId);
    if (existingClosure) {
      db.prepare("UPDATE kit_closures SET total_sold_confirmed_cents = ?, total_commission_cents = ?, total_due_to_sexs_cents = ?, cost_of_goods_sold_cents = ?, gross_profit_cents = ?, items_returned_to_stock = ? WHERE id = ?")
        .run(totalSoldCents, commissionCents, dueToSexs, cogs, grossProfit, totalReturnedToStock, existingClosure.id);
    }
    
    sendJson(res, 200, { 
      ok: true, 
      total_sold: totalSoldCents / 100,
      commission: commissionCents / 100,
      due_to_sexs: dueToSexs / 100,
      returned_to_stock: totalReturnedToStock,
      message: `Kit #${kitId} corrigido: ${corrections.length} itens ajustados, ${totalReturnedToStock} devolvidos ao estoque`
    });
  } catch(e) { 
    sendJson(res, 400, { error: e.message }); 
  }
}, { roles: ['ceo'] }));

// ADMIN: Reject all sales for specific kit_items (for items that were returned, not sold)
// ADMIN: List all sales for a kit (debug)
router.get('/api/admin/kit-sales/:kitId', requireAuth(async (req, res, params) => {
  try {
    const kitId = Number(params.kitId);
    const sales = db.prepare("SELECT ks.*, ki.product_id, p.name as product_name FROM kit_sales ks JOIN kit_items ki ON ki.id = ks.kit_item_id JOIN products p ON p.id = ki.product_id WHERE ki.kit_id = ? ORDER BY ks.id").all(kitId);
    sendJson(res, 200, { sales });
  } catch(e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/admin/reject-kit-item-sales', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const kitItemIds = body.kit_item_ids;
    
    if (!kitItemIds || !Array.isArray(kitItemIds)) {
      return sendJson(res, 400, { error: 'kit_item_ids must be an array' });
    }
    
    let rejectedCount = 0;
    
    for (const kitItemId of kitItemIds) {
      const result = db.prepare("UPDATE kit_sales SET status = 'rejeitada', decided_at = datetime('now') WHERE kit_item_id = ? AND status = 'confirmada'").run(kitItemId);
      rejectedCount += result.changes;
    }
    
    sendJson(res, 200, { ok: true, rejected_count: rejectedCount });
  } catch(e) { 
    sendJson(res, 400, { error: e.message }); 
  }
}, { roles: ['ceo'] }));

// ADMIN: Force reject confirmed sales (for correcting closed kits)
router.post('/api/admin/force-reject-sales', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const saleIds = body.sale_ids; // Array of sale IDs to force reject
    
    if (!saleIds || !Array.isArray(saleIds)) {
      return sendJson(res, 400, { error: 'sale_ids must be an array' });
    }
    
    let rejectedCount = 0;
    for (const saleId of saleIds) {
      const result = db.prepare("UPDATE kit_sales SET status = 'rejeitada', decided_at = datetime('now') WHERE id = ?").run(saleId);
      rejectedCount += result.changes;
    }
    
    sendJson(res, 200, { ok: true, rejected_count: rejectedCount });
  } catch(e) { 
    sendJson(res, 400, { error: e.message }); 
  }
}, { roles: ['ceo'] }));

// ADMIN: Update unit_sale_price_cents for kit items
router.post('/api/admin/update-kit-item-prices', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const updates = body.updates; // [{kit_item_id, unit_sale_price_cents}]
    
    if (!updates || !Array.isArray(updates)) {
      return sendJson(res, 400, { error: 'updates must be an array' });
    }
    
    let updatedCount = 0;
    for (const u of updates) {
      const result = db.prepare("UPDATE kit_items SET unit_sale_price_cents = ? WHERE id = ?")
        .run(Number(u.unit_sale_price_cents), Number(u.kit_item_id));
      updatedCount += result.changes;
    }
    
    sendJson(res, 200, { ok: true, updated_count: updatedCount });
  } catch(e) { 
    sendJson(res, 400, { error: e.message }); 
  }
}, { roles: ['ceo'] }));

// ADMIN: Delete expenses by IDs
router.post('/api/admin/delete-expenses', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const ids = body.ids; // Array of expense IDs to delete
    
    if (!ids || !Array.isArray(ids)) {
      return sendJson(res, 400, { error: 'ids must be an array' });
    }
    
    let deletedCount = 0;
    for (const id of ids) {
      const result = db.prepare("DELETE FROM expenses WHERE id = ?").run(Number(id));
      deletedCount += result.changes;
    }
    
    sendJson(res, 200, { ok: true, deleted_count: deletedCount });
  } catch(e) { 
    sendJson(res, 400, { error: e.message }); 
  }
}, { roles: ['ceo'] }));

// ADMIN: List products with resellers (active kits)
router.get('/api/admin/products-with-resellers', requireAuth((req, res) => {
  try {
    const kits = db.prepare(`
      SELECT k.id as kit_id, k.status, r.name as reseller_name, r.id as reseller_id
      FROM kits k
      JOIN resellers r ON r.id = k.reseller_id
      WHERE k.status IN ('entregue', 'aguardando_fechamento')
    `).all();

    const result = {};
    
    for (const kit of kits) {
      const items = db.prepare(`
        SELECT 
          ki.id as kit_item_id,
          p.name as product_name,
          p.id as product_id,
          ki.quantity_delivered,
          ki.quantity_available,
          ki.quantity_confirmed_sold,
          ki.unit_sale_price_cents
        FROM kit_items ki
        JOIN products p ON p.id = ki.product_id
        WHERE ki.kit_id = ?
      `).all(kit.kit_id);

      for (const item of items) {
        if (!result[item.product_name]) {
          result[item.product_name] = {
            product_id: item.product_id,
            product_name: item.product_name,
            unit_price: item.unit_sale_price_cents,
            resellers: []
          };
        }
        
        result[item.product_name].resellers.push({
          reseller_name: kit.reseller_name,
          reseller_id: kit.reseller_id,
          kit_id: kit.kit_id,
          kit_status: kit.status,
          delivered: item.quantity_delivered,
          available: item.quantity_available,
          sold: item.quantity_confirmed_sold
        });
      }
    }

    sendJson(res, 200, { products: Object.values(result) });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}, { roles: ['ceo'] }));

// RESELLER: Product catalog with prices
router.get('/api/portal/catalog', requireReseller((req, res) => {
  try {
    const products = db.prepare(`
      SELECT DISTINCT
        p.id,
        p.name,
        p.category,
        p.description,
        ki.unit_sale_price_cents,
        ki.quantity_available as available_balance
      FROM products p
      JOIN kit_items ki ON ki.product_id = p.id
      JOIN kits k ON k.id = ki.kit_id
      WHERE k.reseller_id = ?
        AND k.status IN ('entregue', 'aguardando_fechamento')
      ORDER BY p.category, p.name
    `).all(req.user.reseller_id);

    sendJson(res, 200, { catalog: products });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}));

// ADMIN: Delete expenses by IDs
router.post('/api/admin/delete-expenses', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const ids = body.ids;
    if (!ids || !Array.isArray(ids)) return sendJson(res, 400, { error: 'ids must be an array' });
    let deletedCount = 0;
    for (const id of ids) {
      const result = db.prepare("DELETE FROM expenses WHERE id = ?").run(Number(id));
      deletedCount += result.changes;
    }
    sendJson(res, 200, { ok: true, deleted_count: deletedCount });
  } catch(e) { sendJson(res, 400, { error: e.message }); }
}, { roles: ['ceo'] }));

router.post('/api/admin/bulk-add-products', requireAuth(async (req, res) => {
  try {
    const products = await readJsonBody(req);
    if (!Array.isArray(products)) return sendJson(res, 400, { error: 'Expected array of products' });
    const { simulatePricing } = require('./src/pricing');
    const rule = proposalService.getActivePricingRule();
    let sup = db.prepare('SELECT id FROM suppliers WHERE name = ?').get('Estoque Antigo');
    if (!sup) sup = { id: db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('Estoque Antigo').lastInsertRowid };
    const supplierId = sup.id;
    const added = [];
    for (const p of products) {
      if (!p.name) continue;
      const existing = db.prepare('SELECT id FROM products WHERE name LIKE ?').get('%' + p.name + '%');
      if (existing) continue; // skip if already exists
      const costCents = Math.round((p.cost || 5) * 100);
      const pricing = simulatePricing(costCents, rule);
      const promoPrice = Math.round(pricing.min_price_cents * 1.1);
      const info = db.prepare('INSERT INTO products (name, category, default_supplier_id, internal_code, unit, last_purchase_cost_cents, min_price_cents, ideal_price_cents, promo_price_cents, low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(p.name, p.cat || 'Geral', supplierId, p.code || '', 'unidade', costCents, pricing.min_price_cents, pricing.recommended_price_cents, promoPrice, 2);
      const productId = info.lastInsertRowid;
      const qty = p.qty || 1;
      const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
        .run(productId, supplierId, qty, costCents, req.user.id);
      db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
        .run(productId, lotInfo.lastInsertRowid, 'entrada_compra', qty, qty, 'Estoque Yasmin', req.user.id);
      added.push(p.name);
    }
    sendJson(res, 200, { ok: true, added: added.length, names: added });
  } catch (e) { sendJson(res, 500, { error: e.message }); }
}, { roles: ['ceo'] }));

// ADMIN: Add old/existing products with known sale price (not from supplier invoice)
router.post('/api/admin/add-old-products', requireAuth(async (req, res) => {
  try {
    const { simulatePricing } = require('./src/pricing');
    const rule = proposalService.getActivePricingRule();
    const CEO_ID = req.user.id;

    // Get or create "Estoque Antigo" supplier
    let sup = db.prepare('SELECT id FROM suppliers WHERE name = ?').get('Estoque Antigo');
    if (!sup) {
      sup = { id: db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('Estoque Antigo').lastInsertRowid };
    }
    const supplierId = sup.id;

    const oldProducts = [
      { name: 'Prótese Realista 15cm', cat: 'Próteses', code: 'PROT-15', salePrice: 57.50, qty: 1 },
      { name: 'Slim Pingente', cat: 'Vibradores', code: 'SLIM-PING', salePrice: 30.00, qty: 1 },
      { name: 'Bolinha Mágica', cat: 'Bolinhas Funcionais', code: 'BOL-MAG', salePrice: 8.00, qty: 2 },
      { name: 'Sexy Ball Bolinha', cat: 'Bolinhas Funcionais', code: 'SEXY-BALL', salePrice: 5.00, qty: 1 },
      { name: 'Prótese Rosa Vibratória', cat: 'Próteses', code: 'PROT-ROSA-VIB', salePrice: 53.00, qty: 1 },
      { name: 'Mini Bailarina', cat: 'Vibradores', code: 'MINI-BAIL', salePrice: 25.50, qty: 1 },
      { name: 'Bombeira', cat: 'Estimuladores', code: 'BOMBEIRA', salePrice: 25.50, qty: 1 },
    ];

    const added = [];
    const updated = [];

    for (const p of oldProducts) {
      const salePriceCents = Math.round(p.salePrice * 100);
      // Custo estimado = preço_venda / multiplicador (inverso do custo×3)
      const costCents = Math.round(salePriceCents / rule.cost_multiplier);
      const minPriceCents = Math.round(costCents / (1 - rule.commission_pct));
      const promoPrice = Math.round(minPriceCents * 1.1);

      const existing = db.prepare('SELECT id FROM products WHERE name = ? COLLATE NOCASE').get(p.name);

      if (existing) {
        // Adicionar estoque ao existente
        const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
          .run(existing.id, supplierId, p.qty, costCents, CEO_ID);
        const bal = db.prepare('SELECT COALESCE(SUM(quantity),0) as b FROM stock_movements WHERE product_id = ?').get(existing.id).b;
        db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
          .run(existing.id, lotInfo.lastInsertRowid, 'entrada_compra', p.qty, bal + p.qty, 'Estoque antigo (revendedora)', CEO_ID);
        updated.push({ name: p.name, qty: p.qty, salePrice: p.salePrice });
      } else {
        // Produto novo
        const info = db.prepare('INSERT INTO products (name, category, default_supplier_id, internal_code, unit, last_purchase_cost_cents, min_price_cents, ideal_price_cents, promo_price_cents, low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(p.name, p.cat, supplierId, p.code, 'unidade', costCents, minPriceCents, salePriceCents, promoPrice, 2);
        const productId = info.lastInsertRowid;
        const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)')
          .run(productId, supplierId, p.qty, costCents, CEO_ID);
        db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
          .run(productId, lotInfo.lastInsertRowid, 'entrada_compra', p.qty, p.qty, 'Estoque antigo (revendedora)', CEO_ID);
        added.push({ name: p.name, qty: p.qty, cost: costCents/100, salePrice: p.salePrice });
      }
    }

    const totalProducts = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
    sendJson(res, 200, { ok: true, added, updated, totalProducts, message: `${added.length} novos + ${updated.length} atualizados` });
  } catch (e) {
    sendJson(res, 500, { error: e.message, stack: e.stack });
  }
}, { roles: ['ceo'] }));

// Endpoint /app - Server-Side Rendering com token na query string
router.get('/app', async (req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  const token = urlObj.searchParams.get('token');
  if (!token) {
    res.writeHead(302, { Location: '/' });
    return res.end();
  }
  
  const user = auth.getUserBySessionToken(token);
  if (!user) {
    res.writeHead(302, { Location: '/?error=token_invalido' });
    return res.end();
  }
  
  // Renderizar HTML com dados do usuário embutidos
  const fs = require('fs');
  const path = require('path');
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  
  // Injetar script que define o token antes do init()
  const injectScript = `<script>window.SEXS_TOKEN='${token}';window.SEXS_USER=${JSON.stringify(user)};</script>`;
  
  // Inserir antes do </head>
  html = html.replace('</head>', injectScript + '</head>');
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// Catálogo público de produtos
router.get('/catalogo', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SexS — Catálogo Premium</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;1,400&family=DM+Sans:wght@300;400;500;600;700&family=Dancing+Script:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --preto-absoluto: #000000;
            --preto-azulado: #0C0F14;
            --grafite: #181C1F;
            --rosa-sexs: #FF2F9D;
            --rosa-claro: #EFA9C8;
            --branco: #FFFFFF;
            --cinza-secundario: #A8A8AD;
            --rosa-glow: rgba(255, 47, 157, 0.15);
            --rosa-glow-strong: rgba(255, 47, 157, 0.3);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: var(--preto-azulado);
            color: var(--branco);
            line-height: 1.6;
            -webkit-font-smoothing: antialiased;
        }

        /* Header */
        .header {
            background: linear-gradient(135deg, var(--preto-absoluto) 0%, var(--grafite) 100%);
            padding: 60px 20px;
            text-align: center;
            border-bottom: 2px solid var(--rosa-sexs);
            box-shadow: 0 4px 30px var(--rosa-glow);
        }

        .header h1 {
            font-family: 'Playfair Display', serif;
            font-size: 3.5em;
            font-weight: 700;
            color: var(--branco);
            margin-bottom: 10px;
            letter-spacing: 2px;
        }

        .header .brand-accent {
            color: var(--rosa-sexs);
            text-shadow: 0 0 20px var(--rosa-glow-strong);
        }

        .header p {
            font-size: 1.1em;
            color: var(--cinza-secundario);
            font-weight: 300;
            letter-spacing: 1px;
        }

        .header .decorative {
            font-family: 'Dancing Script', cursive;
            color: var(--rosa-claro);
            font-size: 1.3em;
            margin-top: 15px;
            font-style: italic;
        }

        /* Container */
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 20px;
        }

        /* Category Section */
        .category {
            margin-bottom: 60px;
        }

        .category-header {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-bottom: 30px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--grafite);
        }

        .category-icon {
            font-size: 2em;
        }

        .category-title {
            font-family: 'Playfair Display', serif;
            font-size: 2em;
            font-weight: 600;
            color: var(--branco);
        }

        .category-description {
            color: var(--cinza-secundario);
            font-size: 0.95em;
            margin-top: 5px;
        }

        /* Product Grid */
        .product-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 25px;
        }

        /* Product Card */
        .product-card {
            background: var(--grafite);
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid rgba(255, 47, 157, 0.1);
            transition: all 0.3s ease;
            cursor: pointer;
        }

        .product-card:hover {
            transform: translateY(-5px);
            border-color: var(--rosa-sexs);
            box-shadow: 0 8px 30px var(--rosa-glow);
        }

        .product-image {
            width: 100%;
            height: 250px;
            object-fit: cover;
            background: var(--preto-absoluto);
        }

        .product-content {
            padding: 20px;
        }

        .product-name {
            font-family: 'DM Sans', sans-serif;
            font-size: 1.1em;
            font-weight: 600;
            color: var(--branco);
            margin-bottom: 10px;
            line-height: 1.4;
        }

        .product-description {
            color: var(--cinza-secundario);
            font-size: 0.9em;
            line-height: 1.6;
            margin-bottom: 15px;
        }

        .product-specs {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 15px;
        }

        .spec-tag {
            background: rgba(255, 47, 157, 0.1);
            color: var(--rosa-claro);
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 0.8em;
            border: 1px solid rgba(255, 47, 157, 0.2);
        }

        .product-cta {
            display: block;
            text-align: center;
            background: linear-gradient(135deg, var(--rosa-sexs) 0%, #E91E63 100%);
            color: var(--branco);
            padding: 12px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            font-size: 0.9em;
            transition: all 0.3s ease;
            border: none;
            cursor: pointer;
            width: 100%;
        }

        .product-cta:hover {
            transform: scale(1.02);
            box-shadow: 0 4px 20px var(--rosa-glow-strong);
        }

        /* Reseller Section */
        .reseller-section {
            background: linear-gradient(135deg, var(--grafite) 0%, var(--preto-azulado) 100%);
            padding: 60px 20px;
            margin-top: 80px;
            border-top: 2px solid var(--rosa-sexs);
            border-bottom: 2px solid var(--rosa-sexs);
        }

        .reseller-container {
            max-width: 1200px;
            margin: 0 auto;
        }

        .reseller-title {
            font-family: 'Playfair Display', serif;
            font-size: 2.5em;
            text-align: center;
            margin-bottom: 15px;
            color: var(--branco);
        }

        .reseller-subtitle {
            text-align: center;
            color: var(--cinza-secundario);
            margin-bottom: 40px;
            font-size: 1.1em;
        }

        .reseller-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 20px;
        }

        .reseller-card {
            background: var(--preto-absoluto);
            border: 1px solid rgba(255, 47, 157, 0.2);
            border-radius: 12px;
            padding: 25px;
            text-align: center;
            transition: all 0.3s ease;
        }

        .reseller-card:hover {
            border-color: var(--rosa-sexs);
            box-shadow: 0 4px 20px var(--rosa-glow);
            transform: translateY(-3px);
        }

        .reseller-avatar {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background: linear-gradient(135deg, var(--rosa-sexs) 0%, var(--rosa-claro) 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 15px;
            font-size: 2em;
            font-weight: 700;
            color: var(--branco);
            font-family: 'Playfair Display', serif;
        }

        .reseller-name {
            font-size: 1.2em;
            font-weight: 600;
            color: var(--branco);
            margin-bottom: 8px;
        }

        .reseller-phone {
            color: var(--cinza-secundario);
            font-size: 0.95em;
            margin-bottom: 15px;
        }

        .reseller-whatsapp {
            display: inline-block;
            background: #25D366;
            color: var(--branco);
            padding: 10px 25px;
            border-radius: 25px;
            text-decoration: none;
            font-weight: 600;
            font-size: 0.9em;
            transition: all 0.3s ease;
        }

        .reseller-whatsapp:hover {
            transform: scale(1.05);
            box-shadow: 0 4px 15px rgba(37, 211, 102, 0.4);
        }

        /* Footer */
        .footer {
            background: var(--preto-absoluto);
            padding: 40px 20px;
            text-align: center;
            border-top: 1px solid var(--grafite);
        }

        .footer-brand {
            font-family: 'Playfair Display', serif;
            font-size: 1.8em;
            color: var(--rosa-sexs);
            margin-bottom: 10px;
        }

        .footer-text {
            color: var(--cinza-secundario);
            font-size: 0.9em;
        }

        .footer-ceo {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--grafite);
        }

        .footer-ceo a {
            color: var(--rosa-claro);
            text-decoration: none;
            font-weight: 600;
        }

        .footer-ceo a:hover {
            color: var(--rosa-sexs);
        }

        /* Responsive */
        @media (max-width: 768px) {
            .header h1 {
                font-size: 2.5em;
            }

            .category-title {
                font-size: 1.5em;
            }

            .product-grid {
                grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
                gap: 20px;
            }

            .reseller-title {
                font-size: 2em;
            }
        }

        /* Decorative Elements */
        .heart-accent {
            color: var(--rosa-sexs);
            font-size: 0.9em;
        }

        .glow-line {
            height: 2px;
            background: linear-gradient(90deg, transparent, var(--rosa-sexs), transparent);
            margin: 30px 0;
        }
    </style>
</head>
<body>
    <!-- Header -->
    <div class="header">
        <h1>Sex<span class="brand-accent">S</span></h1>
        <p>CATÁLOGO PREMIUM DE PRODUTOS SENSUAIS</p>
        <div class="decorative">Sensualidade • Elegância • Sofisticação</div>
    </div>

    <div class="container">
        <!-- Géis Lubrificantes -->
        <div class="category">
            <div class="category-header">
                <span class="category-icon">💧</span>
                <div>
                    <h2 class="category-title">Géis Lubrificantes</h2>
                    <p class="category-description">Lubrificação e hidratação para momentos de prazer</p>
                </div>
            </div>

            <div class="product-grid">
                <!-- Pop Lub Gel Neutro -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17098975099625_thumb.jpg" alt="Pop Lub Gel Neutro" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Pop Lub Gel Corporal Neutro 60g</h3>
                        <p class="product-description">Gel lubrificante corporal neutro desenvolvido para proporcionar sensação suave, natural e duradoura. Textura leve e transparente que cria deslizamento sedoso.</p>
                        <div class="product-specs">
                            <span class="spec-tag">60g</span>
                            <span class="spec-tag">Sem aroma</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Gel Hot Menta -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17725395022760_thumb.jpg" alt="Gel Hot Menta" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Gel Hot Comestível 15ml — Menta</h3>
                        <p class="product-description">Gel comestível sabor menta com efeito quente. Sensação refrescante que aquece os sentidos. Ideal para massagens sensuais pelo corpo todo.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Menta</span>
                            <span class="spec-tag">15ml</span>
                            <span class="spec-tag">Efeito quente</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Gel Hot Morango -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17725395007938_thumb.jpg" alt="Gel Hot Morango" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Gel Hot Comestível 15ml — Morango</h3>
                        <p class="product-description">Gel comestível sabor morango com efeito quente. Sabor doce e aroma envolvente que desperta o paladar e a sensualidade.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Morango</span>
                            <span class="spec-tag">15ml</span>
                            <span class="spec-tag">Efeito quente</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Gel Hot Morango Champanhe -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17725395044863_thumb.jpg" alt="Gel Hot Morango Champanhe" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Gel Hot Comestível 15ml — Morango com Champanhe</h3>
                        <p class="product-description">Gel comestível sabor morango com champanhe e efeito quente. Combinação clássica e excitante para o casal.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Morango Champanhe</span>
                            <span class="spec-tag">15ml</span>
                            <span class="spec-tag">Efeito quente</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Gel Hot Tutti Frutti -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17725395069721_thumb.jpg" alt="Gel Hot Tutti Frutti" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Gel Hot Comestível 15ml — Tutti Frutti</h3>
                        <p class="product-description">Gel comestível sabor tutti frutti com efeito quente. Mistura irresistível de frutas com aquecimento que apimenta a brincadeira.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Tutti Frutti</span>
                            <span class="spec-tag">15ml</span>
                            <span class="spec-tag">Efeito quente</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Gel Hot Uva -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17725395056640_thumb.jpg" alt="Gel Hot Uva" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Gel Hot Comestível 15ml — Uva</h3>
                        <p class="product-description">Gel comestível sabor uva com efeito quente. Sabor marcante e textura aveludada que hidrata a pele enquanto aquece.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Uva</span>
                            <span class="spec-tag">15ml</span>
                            <span class="spec-tag">Efeito quente</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="glow-line"></div>

        <!-- Bolinhas Beijáveis -->
        <div class="category">
            <div class="category-header">
                <span class="category-icon">💫</span>
                <div>
                    <h2 class="category-title">Bolinhas Beijáveis</h2>
                    <p class="category-description">Bolinhas que se dissolvem e liberam lubrificação, aroma e sensações únicas</p>
                </div>
            </div>

            <div class="product-grid">
                <!-- Pop Ball Chocolate -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17598458855423_thumb.jpg" alt="Pop Ball Chocolate" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Pop Ball Bolinha Lubrificante Beijável — Chocolate</h3>
                        <p class="product-description">Bolinha gelatinosa sabor chocolate. Se dissolve ao toque liberando lubrificação natural, calor suave e aroma envolvente. Totalmente beijável.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Chocolate</span>
                            <span class="spec-tag">2 unidades</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Pop Ball Frutas Vermelhas -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17598458889671_thumb.jpg" alt="Pop Ball Frutas Vermelhas" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Pop Ball Bolinha Lubrificante Beijável — Frutas Vermelhas</h3>
                        <p class="product-description">Bolinha gelatinosa sabor frutas vermelhas. Proporciona lubrificação, aquecimento suave e aroma frutado irresistível.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Frutas Vermelhas</span>
                            <span class="spec-tag">2 unidades</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Pop Ball Menta -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17598458859934_thumb.jpg" alt="Pop Ball Menta" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Pop Ball Bolinha Lubrificante Beijável — Menta</h3>
                        <p class="product-description">Bolinha gelatinosa sabor menta. Se dissolve ao toque liberando lubrificação, calor e frescor. Ideal para preliminares refrescantes.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Menta</span>
                            <span class="spec-tag">2 unidades</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Pop Ball Morango -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17598458842070_thumb.jpg" alt="Pop Ball Morango" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Pop Ball Bolinha Lubrificante Beijável — Morango</h3>
                        <p class="product-description">Bolinha gelatinosa sabor morango. Lubrificação natural com calor suave e aroma adocicado. Perfeita para sexo oral e preliminares.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Morango</span>
                            <span class="spec-tag">2 unidades</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Pop Ball Ice -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17597765221213_thumb.jpg" alt="Pop Ball Ice" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Pop Ball Bolinha Lubrificante Ice (Efeito Gelado)</h3>
                        <p class="product-description">Bolinha gelatinosa com efeito Ice refrescante. Ao dissolver com o calor do corpo, libera óleo aromático com sensação gelada, lubrificante e hidratante.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Efeito Gelado</span>
                            <span class="spec-tag">2 unidades</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Pop Ball Hot -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17597766956219_thumb.jpg" alt="Pop Ball Hot" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Pop Ball Bolinha Lubrificante Hot (Efeito Quente)</h3>
                        <p class="product-description">Bolinha gelatinosa com efeito Hot de aquecimento. Ao dissolver com o calor do corpo, libera óleos essenciais aromáticos com efeito de aquecimento imediato.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Efeito Quente</span>
                            <span class="spec-tag">2 unidades</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="glow-line"></div>

        <!-- Vibradores -->
        <div class="category">
            <div class="category-header">
                <span class="category-icon">💫</span>
                <div>
                    <h2 class="category-title">Vibradores</h2>
                    <p class="category-description">Estimulação do Ponto G, Clitóris e corpo todo</p>
                </div>
            </div>

            <div class="product-grid">
                <!-- Vibrador Golfinho Lilás -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17794512832637_thumb.jpg" alt="Vibrador Golfinho Lilás" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Vibrador Ponto G Golfinho Aveludado — Lilás</h3>
                        <p class="product-description">Vibrador em formato de golfinho, super resistente, com ponta levemente curvada para estimular o ponto G.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Lilás</span>
                            <span class="spec-tag">Ponto G</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Vibrador Golfinho Vermelho -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/17794512895505_thumb.jpg" alt="Vibrador Golfinho Vermelho" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Vibrador Ponto G Golfinho Aveludado — Vermelho</h3>
                        <p class="product-description">Vibrador em formato de golfinho, super resistente, com ponta levemente curvada para estimular o ponto G.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Vermelho</span>
                            <span class="spec-tag">Ponto G</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Vibrador Golfinho Roxo -->
                <div class="product-card">
                    <img src="https://atacadaosexyshop.vtexassets.com/arquivos/ids/350177/Vibrador_Aveludado_Golfinho_Es_954.jpg?v=639142939538770000" alt="Vibrador Golfinho Roxo" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Vibrador Aveludado Golfinho Estimulador de Ponto G — Roxo</h3>
                        <p class="product-description">Vibrador compacto e aveludado, ideal para estimular o Ponto G ou Clitóris. Textura macia e formato anatômico. Funciona com 1 pilha AA.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Roxo</span>
                            <span class="spec-tag">12cm x 2,5cm</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="glow-line"></div>

        <!-- Anéis Penianos -->
        <div class="category">
            <div class="category-header">
                <span class="category-icon">🍆</span>
                <div>
                    <h2 class="category-title">Anéis Penianos</h2>
                    <p class="category-description">Auxiliam na manutenção da ereção e retardam a ejaculação</p>
                </div>
            </div>

            <div class="product-grid">
                <!-- Anel Peniano Bichinhos -->
                <div class="product-card">
                    <img src="https://static.cdnlive.com.br/uploads/487/unidade/16963621759981_thumb.jpg" alt="Anel Peniano Bichinhos" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Anel Peniano Vibrador Bichinhos — Transparente</h3>
                        <p class="product-description">Anel peniano com vibração única e constante. Auxilia na manutenção da ereção e retarda a ejaculação. Bichinhos divertidos que vibram para o casal.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Transparente</span>
                            <span class="spec-tag">Vibrador</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Anel Peniano Vibro -->
                <div class="product-card">
                    <img src="https://atacadaosexyshop.vtexassets.com/arquivos/ids/302908/Anel_Peniano_Com_Vibro_Bichinh_860.png?v=638609862555270000" alt="Anel Peniano Vibro" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Anel Peniano com Vibro Bichinho</h3>
                        <p class="product-description">Anel peniano com vibração que ajuda a retardar a ejaculação, fortalecer a ereção e dar mais prazer à parceira. Material TPR elástico, funciona com 2 baterias LR1130.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Diâmetro 2,5cm até 8cm</span>
                            <span class="spec-tag">Vibrador</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="glow-line"></div>

        <!-- Lingeries -->
        <div class="category">
            <div class="category-header">
                <span class="category-icon">👙</span>
                <div>
                    <h2 class="category-title">Lingeries</h2>
                    <p class="category-description">Calcinhas tailandesas com regulagem para todos os gostos</p>
                </div>
            </div>

            <div class="product-grid">
                <!-- Calcinha Tailandesa Branco -->
                <div class="product-card">
                    <img src="https://atacadaosexyshop.vtexassets.com/arquivos/ids/310594/Calcinha_Tailandesa_Com_Regula_106.jpg?v=638756793424700000" alt="Calcinha Tailandesa Branco" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Calcinha Tailandesa com Regulagem — Branco</h3>
                        <p class="product-description">Calcinha com regulagem, modelagem fio, renda transparente e escrita provocante. Perfeita para casais ousados que gostam de inovar.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Branco</span>
                            <span class="spec-tag">Com regulagem</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Calcinha Tailandesa Preto -->
                <div class="product-card">
                    <img src="https://atacadaosexyshop.vtexassets.com/arquivos/ids/310596/Calcinha_Tailandesa_Com_Regula_904.jpg?v=638756793424870000" alt="Calcinha Tailandesa Preto" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Calcinha Tailandesa com Regulagem — Preto</h3>
                        <p class="product-description">Calcinha preta com regulagem, modelagem fio, renda transparente e escrita provocante. Visual ousado e provocante.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Preto</span>
                            <span class="spec-tag">Com regulagem</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>

                <!-- Calcinha Tailandesa Vermelho -->
                <div class="product-card">
                    <img src="https://atacadaosexyshop.vtexassets.com/arquivos/ids/310600/Calcinha_Tailandesa_Com_Regula_681.jpg?v=638756793425170000" alt="Calcinha Tailandesa Vermelho" class="product-image">
                    <div class="product-content">
                        <h3 class="product-name">Calcinha Tailandesa com Regulagem — Vermelho</h3>
                        <p class="product-description">Calcinha vermelha com regulagem, modelagem fio, renda transparente e escrita provocante. A cor da paixão para noites inesquecíveis.</p>
                        <div class="product-specs">
                            <span class="spec-tag">Vermelho</span>
                            <span class="spec-tag">Com regulagem</span>
                        </div>
                        <button class="product-cta">Verificar Disponibilidade</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Seção de Revendedoras -->
    <div class="reseller-section">
        <div class="reseller-container">
            <h2 class="reseller-title">Nossas Revendedoras</h2>
            <p class="reseller-subtitle">Fale com uma de nós para fazer seu pedido!</p>

            <div class="reseller-grid">
                <!-- Yasmin -->
                <div class="reseller-card">
                    <div class="reseller-avatar">Y</div>
                    <div class="reseller-name">Yasmin</div>
                    <div class="reseller-phone">📱 (16) 99443-6541</div>
                    <a href="https://wa.me/5516994436541" class="reseller-whatsapp" target="_blank">
                        💬 WhatsApp
                    </a>
                </div>

                <!-- Flavia -->
                <div class="reseller-card">
                    <div class="reseller-avatar">F</div>
                    <div class="reseller-name">Flavia</div>
                    <div class="reseller-phone">📱 (16) 99418-1014</div>
                    <a href="https://wa.me/5516994181014" class="reseller-whatsapp" target="_blank">
                        💬 WhatsApp
                    </a>
                </div>

                <!-- Larissa -->
                <div class="reseller-card">
                    <div class="reseller-avatar">L</div>
                    <div class="reseller-name">Larissa</div>
                    <div class="reseller-phone">📱 (16) 99401-9877</div>
                    <a href="https://wa.me/5516994019877" class="reseller-whatsapp" target="_blank">
                        💬 WhatsApp
                    </a>
                </div>

                <!-- Taina -->
                <div class="reseller-card">
                    <div class="reseller-avatar">T</div>
                    <div class="reseller-name">Taina</div>
                    <div class="reseller-phone">📱 (16) 99398-0297</div>
                    <a href="https://wa.me/5516993980297" class="reseller-whatsapp" target="_blank">
                        💬 WhatsApp
                    </a>
                </div>

                <!-- Luana -->
                <div class="reseller-card">
                    <div class="reseller-avatar">L</div>
                    <div class="reseller-name">Luana</div>
                    <div class="reseller-phone">📱 (16) 99355-6560</div>
                    <a href="https://wa.me/5516993556560" class="reseller-whatsapp" target="_blank">
                        💬 WhatsApp
                    </a>
                </div>

                <!-- Gizelle -->
                <div class="reseller-card">
                    <div class="reseller-avatar">G</div>
                    <div class="reseller-name">Gizelle</div>
                    <div class="reseller-phone">📱 (16) 99293-9887</div>
                    <a href="https://wa.me/5516992939887" class="reseller-whatsapp" target="_blank">
                        💬 WhatsApp
                    </a>
                </div>

                <!-- Jéssica CEO -->
                <div class="reseller-card" style="border: 2px solid var(--rosa-sexs);">
                    <div class="reseller-avatar" style="background: linear-gradient(135deg, var(--rosa-sexs) 0%, #FF1493 100%);">J</div>
                    <div class="reseller-name">Jéssica <span style="color: var(--rosa-sexs); font-size: 0.8em;">CEO</span></div>
                    <div class="reseller-phone">📱 (16) 98863-8987</div>
                    <a href="https://wa.me/5516988638987" class="reseller-whatsapp" target="_blank">
                        💬 WhatsApp
                    </a>
                </div>
            </div>
        </div>
    </div>

    <!-- Footer -->
    <div class="footer">
        <div class="footer-brand">SexS</div>
        <div class="footer-text">
            <span class="heart-accent">♥</span> Sensualidade • Elegância • Sofisticação <span class="heart-accent">♥</span>
        </div>
        <div class="footer-text" style="margin-top: 10px; font-size: 0.85em;">
            Catálogo Premium de Produtos Sensuais
        </div>
        <div class="footer-ceo">
            <div class="footer-text">
                CEO & Founder: <a href="https://wa.me/5516988638987" target="_blank">Jéssica</a>
            </div>
        </div>
    </div>
</body>
</html>
`);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`SexS OS rodando em http://0.0.0.0:${PORT}`);
  console.log(`Ambiente: ${IS_PRODUCTION ? 'PRODUÇÃO' : 'desenvolvimento'}${IS_DEMO_MODE ? ' (DEMO ATIVO — tokens visíveis)' : ''}`);
  console.log(`Health check: http://localhost:${PORT}/health`);

  // FASE 10.5 — Backup automático
  try {
    await backupService.autoRestoreIfNeeded();
  } catch (e) {
    console.error('[Backup] Erro no auto-restore:', e.message);
  }
  backupService.startBackupScheduler();
  backupService.setupShutdownBackup();

  // FASE 10.5 — Criar conta CEO padrão se não existir nenhuma
  try {
    const ceoExists = db.prepare("SELECT id FROM users WHERE role = 'ceo' LIMIT 1").get();
    if (!ceoExists) {
      console.log('[Setup] Nenhuma conta CEO encontrada — criando conta padrão...');
      const salt = crypto.randomBytes(16).toString('hex');
      const defaultPassword = process.env.CEO_DEFAULT_PASSWORD || 'SexS2026@Jessica';
      const hash = crypto.scryptSync(defaultPassword, salt, 64).toString('hex');
      db.prepare('INSERT INTO users (name, username, role, password_hash, password_salt) VALUES (?,?,?,?,?)').run(
        'CEO', 'ceo', 'ceo', hash, salt
      );
      console.log('[Setup] ✅ Conta CEO criada automaticamente!');
      console.log('[Setup]    Login: ceo');
      console.log('[Setup]    Senha: ' + defaultPassword);
      console.log('[Setup] ⚠️  Troque esta senha após o primeiro login!');

      // Criar regra de precificação padrão
      const ruleExists = db.prepare("SELECT id FROM pricing_rules WHERE active = 1").get();
      if (!ruleExists) {
        const ceo = db.prepare("SELECT id FROM users WHERE role = 'ceo'").get();
        db.prepare("INSERT INTO pricing_rules (version, cost_multiplier, commission_pct, premium_multiplier, active, created_by) VALUES (1, 3.0, 0.30, 1.3, 1, ?)").run(ceo.id);
        console.log('[Setup] ✅ Regra de precificação criada (custo x3, comissão 30%)');
      }

      // Criar dicas padrão
      const tipsCount = db.prepare("SELECT COUNT(*) as c FROM tips").get();
      if (tipsCount.c === 0) {
        const ceo = db.prepare("SELECT id FROM users WHERE role = 'ceo'").get();
        const tips = [
          'Guarde os produtos em local seco e longe de luz direta.',
          'Informe a venda assim que acontecer para não esquecer no fechamento.',
          'Dúvidas sobre um produto? Pergunte antes de vender.',
        ];
        for (const t of tips) db.prepare('INSERT INTO tips (text, created_by) VALUES (?,?)').run(t, ceo.id);
        console.log('[Setup] ✅ Dicas rápidas criadas');
      }
    }
  } catch (e) {
    console.error('[Setup] Erro:', e.message);
  }

  // Auto-seed + restore completo (produtos + merges + kits)
  try {
    const { autoSeed } = require('./src/autoSeed');
    autoSeed();
    
    // Restore: se não há kits ativos, recriar tudo
    const kitCount = db.prepare("SELECT COUNT(*) as c FROM kits WHERE status NOT IN ('rejeitado')").get().c;
    if (kitCount === 0) {
      console.log('[Restore] Sem kits ativos - restaurando estado completo...');
      const { simulatePricing } = require('./src/pricing');
      const rule = db.prepare('SELECT * FROM pricing_rules WHERE active = 1 LIMIT 1').get();
      const CEO_ID = db.prepare("SELECT id FROM users WHERE role = 'ceo' LIMIT 1").get().id;
      
      // Merges: [keep_id, [remove_ids], cost_cents, name]
      const merges = [[37,[14,15,16,17,18],599,'Vibrador Golfinho'],[2,[3,44,45,46,47,48,49],333,'Egg Sensual Love'],[11,[10,39,40,41],167,'Papermint Lâminas'],[7,[38],267,'Gotas Afrodisíacas 20ml'],[42,[43],1124,'Calcinha Tailandesa'],[35,[34],267,'Plug Anal Coração']];
      for (const [keep, rems, cost, name] of merges) {
        for (const rem of rems) {
          try {
            if (db.prepare('SELECT id FROM products WHERE id = ?').get(keep) && db.prepare('SELECT id FROM products WHERE id = ?').get(rem)) {
              db.prepare('UPDATE stock_lots SET product_id = ? WHERE product_id = ?').run(keep, rem);
              db.prepare('UPDATE stock_movements SET product_id = ? WHERE product_id = ?').run(keep, rem);
              db.prepare('UPDATE stock_reservations SET product_id = ? WHERE product_id = ?').run(keep, rem);
              db.prepare('DELETE FROM products WHERE id = ?').run(rem);
              db.prepare('UPDATE products SET name = ?, last_purchase_cost_cents = ? WHERE id = ?').run(name, cost, keep);
            }
          } catch(e) {}
        }
      }
      
      // Estoque extra
      const extraStock = [[6,2],[5,2],[4,2],[9,2],[12,2],[27,2],[35,2],[24,4],[26,2],[25,2]];
      for (const [pid, qty] of extraStock) {
        try {
          const bal = db.prepare('SELECT COALESCE(SUM(quantity),0) as b FROM stock_movements WHERE product_id = ?').get(pid).b;
          const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,100,?)').run(pid, qty, CEO_ID);
          db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
            .run(pid, lotInfo.lastInsertRowid, 'entrada_compra', qty, bal + qty, 'Estoque extra', CEO_ID);
        } catch(e) {}
      }
      
      // Preços Yasmin (DEPOIS do estoque extra para sobrescrever custos)
      const yasminPrices = [[6,417],[5,417],[4,417],[7,267],[9,383],[11,167],[12,600],[20,433],[24,167],[26,333],[27,283],[35,267],[61,383],[62,1500],[63,850],[23,833],[2,333]];
      for (const [pid, cost] of yasminPrices) {
        try {
          const pricing = simulatePricing(cost, rule);
          db.prepare('UPDATE stock_lots SET unit_cost_cents = ? WHERE product_id = ?').run(cost, pid);
          db.prepare('UPDATE products SET last_purchase_cost_cents = ?, min_price_cents = ?, ideal_price_cents = ?, promo_price_cents = ? WHERE id = ?')
            .run(cost, pricing.min_price_cents, pricing.recommended_price_cents, Math.round(pricing.min_price_cents * 1.1), pid);
        } catch(e) {}
      }
      
      // Preços 2x para itens com custo real > R$10 (lot_cost = custo_real * 2/3)
      const allRoundedPrices = [
        [1,275],[2,334],[4,425],[5,425],[6,425],[7,275],[8,459],[9,384],[11,175],[13,325],
        [19,550],[20,434],[21,550],[22,834],[23,834],[24,175],[25,400],[26,334],[27,284],
        [28,275],[29,275],[30,275],[31,275],[32,275],[33,275],[35,275],[36,275],[37,600],
        [42,825],[50,459],[51,617],[52,359],[53,450],[54,359],[55,359],[56,359],[57,942],
        [58,600],[59,950],[60,434],[61,384],[62,1500],[63,850],[64,1917],[65,1000],
        [66,275],[67,175],[68,1767],[69,850],[70,850]
      ]; // Todos arredondados 0,25 cima + preços antigos respeitados
      for (const [pid, cost] of allRoundedPrices) {
        try {
          const pricing = simulatePricing(cost, rule);
          db.prepare('UPDATE stock_lots SET unit_cost_cents = ? WHERE product_id = ?').run(cost, pid);
          db.prepare('UPDATE products SET last_purchase_cost_cents = ?, min_price_cents = ?, ideal_price_cents = ?, promo_price_cents = ? WHERE id = ?')
            .run(cost, pricing.min_price_cents, pricing.recommended_price_cents, Math.round(pricing.min_price_cents * 1.1), pid);
        } catch(e) {}
      }
      
      // Produtos faltantes
      const missingProducts = [['Gel Ice Comestível Caipirinha','Géis',433,2],['Six Ball Mamba Negra 6un','Bolinhas',383,2],['Slim Cone 57g','Vibradores',1500,2],['Viuva Negra','Vibradores',850,2],['Prótese Realista 15cm','Próteses',1917,2],['Slim Pingente','Vibradores',1000,2],['Bolinha Mágica','Bolinhas',267,3],['Sexy Ball Bolinha','Bolinhas',167,2],['Prótese Rosa Vibratória','Próteses',1767,2],['Mini Bailarina','Vibradores',850,2],['Bombeira','Vibradores',850,2]];
      let sup = db.prepare('SELECT id FROM suppliers LIMIT 1').get();
      if (!sup) { sup = { id: db.prepare('INSERT INTO suppliers (name) VALUES (?)').run('SexShop Atacadão').lastInsertRowid }; }
      for (const [name, cat, cost, qty] of missingProducts) {
        try {
          const exists = db.prepare('SELECT id FROM products WHERE name LIKE ?').get('%' + name + '%');
          if (!exists) {
            const pricing = simulatePricing(cost, rule);
            const pInfo = db.prepare('INSERT INTO products (name, category, default_supplier_id, unit, last_purchase_cost_cents, min_price_cents, ideal_price_cents, promo_price_cents, low_stock_threshold) VALUES (?,?,?,?,?,?,?,?,?)')
              .run(name, cat, sup.id, 'unidade', cost, pricing.min_price_cents, pricing.recommended_price_cents, Math.round(pricing.min_price_cents * 1.1), 2);
            const lotInfo = db.prepare('INSERT INTO stock_lots (product_id, supplier_id, quantity_purchased, unit_cost_cents, created_by) VALUES (?,?,?,?,?)').run(pInfo.lastInsertRowid, sup.id, qty, cost, CEO_ID);
            db.prepare('INSERT INTO stock_movements (product_id, lot_id, type, quantity, balance_after, reason, created_by) VALUES (?,?,?,?,?,?,?)')
              .run(pInfo.lastInsertRowid, lotInfo.lastInsertRowid, 'entrada_compra', qty, qty, 'Restore', CEO_ID);
          }
        } catch(e) {}
      }
      
      // Criar kits automaticamente
      const kitService = require('./src/kitService');
      const findProd = (name) => { const p = db.prepare('SELECT id FROM products WHERE name LIKE ? LIMIT 1').get('%' + name + '%'); return p ? p.id : null; };
      
      const yasminId = db.prepare("SELECT id FROM resellers WHERE name LIKE '%Yasmin%' OR name LIKE '%yasmin%' LIMIT 1").get();
      if (yasminId) {
        try {
          const yItems = [['Lubrificante Fresh 30ml - Menta',2],['Lubrificante Fresh 30ml - Morango',1],['Lubrificante Fresh 30ml - Tutti',1],['Gotas Afrodisíacas 20ml',1],['Fofa Toba',2],['Papermint Lâminas',1],['Kuloko Gel',1],['Gel Hot Comestível - Uva',1],['Gel Ice Comestível Caipirinha',1],['Six Ball Black Ice',4],['Power Kiss Jatos - Black',1],['Pop Lub Gel',1],['Plug Anal Coração',1],['Six Ball Mamba',1],['Slim Cone 57g',1],['Viuva Negra',1],['Pênis Aromático',1],['Egg Sensual Love',1],['Triple Shock',1]].map(([n,q]) => ({product_id: findProd(n), quantity: q})).filter(i => i.product_id);
          const kit = kitService.suggestKit({resellerId: yasminId.id, items: yItems, userId: CEO_ID});
          kitService.approveKit(kit.id, {id: CEO_ID});
          kitService.confirmDelivery(kit.id, {id: CEO_ID});
          console.log('[Restore] Kit Yasmin criado: ' + yItems.length + ' itens');
        } catch(e) { console.error('[Restore] Kit Yasmin:', e.message); }
      }
      
      const flaviaId = db.prepare("SELECT id FROM resellers WHERE name LIKE '%Flavia%' OR name LIKE '%flavia%' LIMIT 1").get();
      if (flaviaId) {
        try {
          const fItems = [['Gotas Afrodisíacas 20ml',4],['Fofa Toba',1],['Papermint Lâminas',7],['Kuloko Gel',2],['Gel Hot Comestível - Tutti',1],['Gel Hot Comestível - Morango Champagne',1],['Six Ball Black Ice',1],['Power Kiss Jatos - Cereja',2],['Pop Lub Gel',2],['Prótese Realista',1],['Egg Sensual Love',4],['Pop Ball Beijável - Morango',2],['Pop Ball Beijável - Frutas',2],['Plug Anal Coração',4],['Lubrificante Fresh 30ml - Morango',2],['Lubrificante Fresh 30ml - Menta',2],['Slim Pingente',1],['Bolinha Mágica',2],['Sexy Ball',1],['Prótese Rosa Vibratória',1],['Mini Bailarina',1],['Bombeira',1],['Vibrador Golfinho',5],['Anel Vibrador',3],['Calcinha Tailandesa',5],['Gel Massageador',1],['Kiss Me Hot - Uva',2],['Kiss Me Hot - Morango',2],['Triple Shock',1]].map(([n,q]) => ({product_id: findProd(n), quantity: q})).filter(i => i.product_id);
          const kit = kitService.suggestKit({resellerId: flaviaId.id, items: fItems, userId: CEO_ID});
          kitService.approveKit(kit.id, {id: CEO_ID});
          kitService.confirmDelivery(kit.id, {id: CEO_ID});
          console.log('[Restore] Kit Flavia criado: ' + fItems.length + ' itens');
        } catch(e) { console.error('[Restore] Kit Flavia:', e.message); }
      }
      
      console.log('[Restore] Estado completo restaurado!');
    }
  } catch (e) {
    console.error('[AutoSeed/Restore] Erro:', e.message);
  }

  const aiGateway = require('./src/aiGateway');
  const provider = aiGateway.detectProvider();
  const PAID_PROVIDERS = new Set(['anthropic', 'openai', 'gemini']);
  if (!provider) {
    console.log('IA: desligada. Sistema 100% gratuito, rodando só no mecanismo offline.');
  } else if (PAID_PROVIDERS.has(provider)) {
    console.log(`IA: ATIVA via "${provider}" — este provedor cobra por uso da API.`);
  } else {
    console.log(`IA: ativa via "${provider}" (local/Ollama — sem custo de API).`);
  }
});

module.exports = server;

// ADMIN: Update product images
router.post('/api/admin/update-product-images', requireAuth(async (req, res) => {
  try {
    const body = await readJsonBody(req);
    const { updates } = body; // Array de {product_id, photo_url}
    
    if (!updates || !Array.isArray(updates)) {
      return sendJson(res, 400, { error: 'updates deve ser um array' });
    }
    
    let updatedCount = 0;
    for (const update of updates) {
      const result = db.prepare(
        "UPDATE products SET photo_url = ? WHERE id = ?"
      ).run(update.photo_url, update.product_id);
      updatedCount += result.changes;
    }
    
    sendJson(res, 200, { ok: true, updated_count: updatedCount });
  } catch(e) {
    sendJson(res, 500, { error: e.message });
  }
}, { roles: ['ceo'] }));

// PUBLIC: Catalog endpoint (no auth required)
router.get('/api/public/catalog', (req, res) => {
  try {
    const products = db.prepare(`
      SELECT 
        p.id,
        p.name,
        p.category,
        p.description,
        p.photo_url,
        p.ideal_price_cents,
        p.last_purchase_cost_cents,
        COALESCE((SELECT SUM(quantity) FROM stock_movements WHERE product_id = p.id), 0) as physical_balance,
        COALESCE((SELECT SUM(quantity) FROM stock_reservations WHERE product_id = p.id AND status = 'ativa'), 0) as reserved
      FROM products p
      WHERE p.active = 1
      ORDER BY p.category, p.name
    `).all();

    // Formatar dados para o catálogo
    const catalog = products.map(p => ({
      name: p.name,
      description: p.description || '',
      image_url: p.photo_url || '',
      category: p.category || 'Outros',
      availability: (p.physical_balance - p.reserved) || 0,
      price_cents: p.ideal_price_cents || 0,
      specs: []
    }));

    sendJson(res, 200, { success: true, catalog });
  } catch(e) {
    sendJson(res, 500, { error: e.message });
  }
});

// ADMIN: Get kit closure details
router.get('/api/admin/kit-closure/:kitId', requireAuth((req, res, params) => {
  try {
    const kitId = Number(params.kitId);
    const closure = db.prepare('SELECT * FROM kit_closures WHERE kit_id = ?').get(kitId);
    if (!closure) {
      return sendJson(res, 404, { error: 'Fechamento não encontrado' });
    }
    
    // Buscar itens do kit com custos
    const items = db.prepare(`
      SELECT 
        ki.id,
        ki.product_id,
        p.name as product_name,
        ki.quantity_delivered,
        ki.quantity_confirmed_sold,
        ki.quantity_returned,
        ki.unit_sale_price_cents,
        COALESCE((
          SELECT SUM(quantity_purchased * unit_cost_cents) / NULLIF(SUM(quantity_purchased), 0)
          FROM stock_lots
          WHERE product_id = ki.product_id
        ), 0) as avg_cost_cents
      FROM kit_items ki
      JOIN products p ON p.id = ki.product_id
      WHERE ki.kit_id = ?
    `).all(kitId);
    
    sendJson(res, 200, { closure, items });
  } catch(e) {
    sendJson(res, 500, { error: e.message });
  }
}, { roles: ['ceo'] }));
