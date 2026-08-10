// Módulo de negócio: contratação de revendedora via Marina (RH). Registra-se no motor
// genérico de propostas, igual ao módulo de estoque.
const db = require('../db');
const proposalService = require('./proposalService');
const auth = require('./auth');
const { parseHireMessageSmart, parseUpdateResellerMessageSmart, parseDeactivateResellerMessageSmart } = require('./events');
const { logAudit } = require('./audit');
const documentService = require('./documentService');

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function slugUsername(name) {
  const base = name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
  let candidate = base || 'revendedora';
  let n = 1;
  while (db.prepare('SELECT id FROM users WHERE username = ?').get(candidate)) {
    n += 1;
    candidate = `${base}${n}`;
  }
  return candidate;
}

function findResellerByName(name) {
  return db.prepare('SELECT * FROM resellers WHERE name = ? COLLATE NOCASE').get(name);
}

async function handleMarinaMessage({ text, userId }) {
  // Hire check FIRST (most common intent)
  const parsed = await parseHireMessageSmart(text, userId);

  // Validate: if name looks wrong (contains phone/address keywords), fix with regex
  if (parsed.recognized && parsed.entities.name && /zap|telefone|fone|mora|rua|avenida|trabalhar|gente|endere/i.test(parsed.entities.name)) {
    const properName = text.match(/^(?:a\s+|o\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/);
    if (properName) parsed.entities.name = properName[1].trim();
    const addrMatch = text.match(/(?:mora|endere[çc]o)[^,]{0,10}((?:rua|av\.?|avenida|travessa|alameda)\s+[^,]+)/i)
      || text.match(/mora\s+(?:em|na|no)?\s*([^,]{5,})/i);
    if (addrMatch) parsed.entities.address = addrMatch[1].trim();
  }

  // Fallback: se reconheceu mas faltou telefone, tentar extrair do texto livre
  if (parsed.recognized && parsed.missing.includes('telefone')) {
    const phoneMatch = text.match(/(?:zap|tel|telefone|fone|whats|celular|contato)[^0-9]{0,30}(\(?[0-9]{2}\)?[\s\-]?[0-9]{4,5}[\s\-]?[0-9]{4})/i)
      || text.match(/(\([0-9]{2}\)\s*[0-9]{4,5}[\s\-][0-9]{4})/)
      || text.match(/((?:1[1-9]|[2-9][0-9])\s*[0-9]{4,5}[\s\-]?[0-9]{4})/);
    if (phoneMatch) {
      parsed.entities.phone = phoneMatch[1].trim();
      parsed.missing = parsed.missing.filter(m => m !== 'telefone');
    }
  }
  // Fallback: se nao reconheceu, tentar detectar intencao de contratacao + telefone
  if (!parsed.recognized) {
    const hasIntent = /(?:quer|vai|come[çc]ou)\s+(?:trabalhar|vender)|trabalhar\s+(?:com\s+a\s+gente|conosco)|revendedora\s+nova|contrat/i.test(text);
    const phone = text.match(/(?:zap|tel|telefone|fone|whats|celular|contato)[^0-9]{0,30}(\(?[0-9]{2}\)?[\s\-]?[0-9]{4,5}[\s\-]?[0-9]{4})/i)
      || text.match(/(\([0-9]{2}\)\s*[0-9]{4,5}[\s\-][0-9]{4})/)
      || text.match(/((?:1[1-9]|[2-9][0-9])\s*[0-9]{4,5}[\s\-]?[0-9]{4})/);
    const nameMatch = text.match(/^(?:a\s+|o\s+)?([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)/);
    if (hasIntent && phone && nameMatch) {
      const addrMatch = text.match(/(?:mora|endere[çc]o)[^,]{0,10}((?:rua|av\.?|avenida|travessa|alameda)\s+[^,]+)/i);
      parsed.recognized = true;
      parsed.intent = 'contratar_revendedora';
      parsed.entities = { name: nameMatch[1].trim(), phone: phone[1].trim(), address: addrMatch ? addrMatch[1].trim() : null };
      parsed.missing = [];
    }
  }

  if (!parsed.recognized) {
    // Try update/deactivate before giving up
    const updateMsg = await parseUpdateResellerMessageSmart(text, userId);
    if (updateMsg.recognized) return handleUpdateReseller(updateMsg, text, userId);
    const deactivateMsg = await parseDeactivateResellerMessageSmart(text, userId);
    if (deactivateMsg.recognized) return handleDeactivateReseller(deactivateMsg, text, userId);
    
    return {
      reply: pick([
        'Hmm, não entendi bem o que você precisa. 🤔\n\nEu cuido de revendedoras! Tenta assim:\n• "Contratamos [Nome], telefone [tel], endereço [end]" — pra cadastrar nova revendedora\n• "[Nome] mudou de telefone para [novo]" — pra atualizar dados\n• "[Nome] saiu da empresa" — pra desligar uma revendedora',
        'Opa, não consegui identificar. 😊\n\nPosso te ajudar com:\n• Contratar revendedora nova\n• Atualizar telefone ou endereço\n• Desligar revendedora\n\nMe conta o que precisa!',
      ]),
      proposal: null,
    };
  }

  if (parsed.missing.length > 0) {
    return {
      reply: `Que ótimo que vamos ter uma revendedora nova! 🎉\n\nSó preciso de mais alguns dados:\n${parsed.missing.map(m => `• ${m}`).join('\n')}\n\nPode completar?`,
      proposal: null,
    };
  }

  const existing = db.prepare('SELECT id FROM resellers WHERE name = ? COLLATE NOCASE').get(parsed.entities.name);

  const extracted = {
    name: parsed.entities.name,
    phone: parsed.entities.phone,
    address: parsed.entities.address,
    already_exists: !!existing,
  };

  // Risco médio: cria cadastro e conta de acesso, mas é reversível (desativar usuário).
  const proposal = proposalService.createProposal({
    rawText: text, intent: 'contratar_revendedora', extracted,
    riskLevel: 'medio', targetDirector: 'marina', userId,
  });

  const firstName = extracted.name.split(' ')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const reply = existing
    ? `Opa, "${extracted.name}" já tá cadastrada aqui! 😊 Não quero duplicar o cadastro.\n\nDá uma olhadinha na aba Revendedoras pra conferir se é a mesma pessoa.`
    : `Que legal, nova revendedora na equipe! 🎉\n\nConfere os dados:\n• **Nome:** ${extracted.name}\n• **Telefone:** ${extracted.phone}\n• **Endereço:** ${extracted.address}\n\nAo aprovar, vou criar o cadastro com:\n• 👤 Login: **${firstName}**\n• 🔒 Senha: **@Sexs2026**\n• 📄 Documentos gerados automaticamente\n\nÉ só enviar esses dados pra ela acessar o portal! Aprova? 💕`;

  if (existing) {
    // Já registramos a proposta para rastreabilidade, mas marcamos como rejeitada automaticamente
    // para não deixar uma pendência que resultaria em erro ao tentar aprovar.
    proposalService.reject(proposal.id, { id: userId }, 'Revendedora já cadastrada — proposta automática.');
    return { reply, proposal: null };
  }

  return { reply, proposal };
}

/** Retorna { user, username, password } — login e senha criados automaticamente.
 * Login = primeiro nome em minúsculo, Senha = @Sexs2026 (padrão da empresa). */
function executeContratarRevendedora(extracted, proposalId, ceoUser) {
  const resellerInfo = db
    .prepare('INSERT INTO resellers (name, phone, address, status, created_by, proposal_id) VALUES (?,?,?,?,?,?)')
    .run(extracted.name, extracted.phone, extracted.address, 'ativa', ceoUser.id, proposalId);
  const resellerId = resellerInfo.lastInsertRowid;
  const resellerRow = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
  documentService.generateHireDocuments(resellerRow, ceoUser.id);

  // Login = primeiro nome em minúsculo sem acentos
  const firstName = extracted.name.split(' ')[0]
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  // Verificar se já existe e adicionar sufixo se necessário
  let username = firstName;
  let n = 1;
  while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    n += 1;
    username = `${firstName}${n}`;
  }
  
  // Senha padrão da empresa
  const password = '@Sexs2026';
  const { hash, salt } = auth.hashPassword(password);

  const userInfo = db
    .prepare('INSERT INTO users (name, username, role, reseller_id, password_hash, password_salt) VALUES (?,?,?,?,?,?)')
    .run(extracted.name, username, 'revendedora', resellerId, hash, salt);

  logAudit({
    actorUserId: ceoUser.id, actorLabel: 'CEO (via proposta)', action: 'reseller.created',
    entityType: 'reseller', entityId: resellerId, details: { name: extracted.name, username },
  });

  return { resellerId, userId: userInfo.lastInsertRowid, username, password };
}

proposalService.registerMessageHandler('marina', handleMarinaMessage);
proposalService.registerExecutor('contratar_revendedora', executeContratarRevendedora);
proposalService.registerExecutor('atualizar_revendedora', executeAtualizarRevendedora);
proposalService.registerExecutor('desativar_revendedora', executeDesativarRevendedora);

function listResellers() {
  return db.prepare('SELECT * FROM resellers ORDER BY name').all();
}

function getResellerByUserId(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.reseller_id) return null;
  return db.prepare('SELECT * FROM resellers WHERE id = ?').get(user.reseller_id);
}

function handleUpdateReseller(parsed, text, userId) {
  const reseller = findResellerByName(parsed.entities.name);
  if (!reseller) {
    return { reply: `Não encontrei nenhuma revendedora chamada "${parsed.entities.name}".`, proposal: null };
  }
  const fieldLabel = parsed.entities.field === 'phone' ? 'telefone' : 'endereço';
  const extracted = { reseller_id: reseller.id, name: reseller.name, field: parsed.entities.field, old_value: reseller[parsed.entities.field], new_value: parsed.entities.value };
  // Risco baixo: atualização de contato é trivialmente reversível.
  const proposal = proposalService.createProposal({
    rawText: text, intent: 'atualizar_revendedora', extracted, riskLevel: 'baixo', targetDirector: 'marina', userId,
  });
  return {
    reply: `Entendi: atualizar o ${fieldLabel} de "${reseller.name}" de "${extracted.old_value || '(vazio)'}" para "${extracted.new_value}". Aprova ou rejeita?`,
    proposal,
  };
}

function executeAtualizarRevendedora(extracted, proposalId, ceoUser) {
  db.prepare(`UPDATE resellers SET ${extracted.field} = ? WHERE id = ?`).run(extracted.new_value, extracted.reseller_id);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO (via proposta)', action: 'reseller.updated', entityType: 'reseller', entityId: extracted.reseller_id, details: extracted });
}

function handleDeactivateReseller(parsed, text, userId) {
  const reseller = findResellerByName(parsed.entities.name);
  if (!reseller) {
    return { reply: `Não encontrei nenhuma revendedora chamada "${parsed.entities.name}".`, proposal: null };
  }
  if (reseller.status === 'inativa') {
    return { reply: `"${reseller.name}" já está inativa.`, proposal: null };
  }
  const extracted = { reseller_id: reseller.id, name: reseller.name };
  // Risco médio: afeta acesso ao portal e participação em novos kits — reversível, mas não trivial.
  const proposal = proposalService.createProposal({
    rawText: text, intent: 'desativar_revendedora', extracted, riskLevel: 'medio', targetDirector: 'marina', userId,
  });
  return { reply: `Entendi: marcar "${reseller.name}" como inativa. O acesso ao portal dela será bloqueado. Aprova ou rejeita?`, proposal };
}

function executeDesativarRevendedora(extracted, proposalId, ceoUser) {
  db.prepare(`UPDATE resellers SET status = 'inativa' WHERE id = ?`).run(extracted.reseller_id);
  db.prepare(`UPDATE users SET active = 0 WHERE reseller_id = ?`).run(extracted.reseller_id);
  logAudit({ actorUserId: ceoUser.id, actorLabel: 'CEO (via proposta)', action: 'reseller.deactivated', entityType: 'reseller', entityId: extracted.reseller_id, details: extracted });
}



function regenerateFirstAccess(resellerId, actorUser) {
  let user = db.prepare('SELECT * FROM users WHERE reseller_id = ? AND role = ?').get(resellerId, 'revendedora');
  
  // Se o user não existe (pode ter sido perdido em restart), recriar
  if (!user) {
    const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
    if (!reseller) throw new Error('Revendedora não encontrada.');
    const username = slugUsername(reseller.name);
    const userInfo = db.prepare(
      'INSERT INTO users (name, username, role, reseller_id) VALUES (?,?,?,?)'
    ).run(reseller.name, username, 'revendedora', resellerId);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userInfo.lastInsertRowid);
    console.log(`[Regenerate] Recriado user para ${reseller.name}: ${username}`);
  }
  
  if (user.password_hash) throw new Error('Esta revendedora já concluiu o primeiro acesso. Se ela esqueceu a senha, gere um novo link.');
  const token = auth.issueAccessToken(user.id, 'primeiro_acesso');
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.name || 'CEO', action: 'reseller.first_access_regenerated', entityType: 'reseller', entityId: resellerId });
  return { username: user.username, firstAccessToken: token };
}

function setCommission(resellerId, commissionPct, actorUser) {
  const reseller = db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
  if (!reseller) throw new Error('Revendedora não encontrada.');
  if (commissionPct !== null && (commissionPct < 0 || commissionPct > 1)) throw new Error('Comissão deve estar entre 0% e 100%.');
  db.prepare('UPDATE resellers SET commission_pct = ? WHERE id = ?').run(commissionPct, resellerId);
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.role === 'ceo' ? 'CEO' : 'Marina', action: 'reseller.commission_changed', entityType: 'reseller', entityId: resellerId, details: { commission_pct: commissionPct } });
  return db.prepare('SELECT * FROM resellers WHERE id = ?').get(resellerId);
}

module.exports = { listResellers, getResellerByUserId, executeContratarRevendedora, handleMarinaMessage, regenerateFirstAccess, setCommission };
