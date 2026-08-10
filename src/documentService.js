// Documentos administrativos — preenchimento determinístico a partir de dados já
// informados. NUNCA alega assinatura eletrônica ou envio real: status é só
// rastreamento manual (Seção 5, "Documentos e trabalho administrativo").
const db = require('../db');
const { logAudit } = require('./audit');
const companyService = require('./companyService');

/** Identificação legal da empresa para documentos — cai no nome da marca se os dados
 * legais (razão social/CNPJ) ainda não tiverem sido cadastrados em /api/company. */
function companyIdentification() {
  const info = companyService.getCompanyInfo();
  if (!info || !info.legal_name) return 'SexS';
  return `${info.trade_name || 'SexS'} (${info.legal_name}, CNPJ ${info.document_id})`;
}

function fichaCadastralTemplate(reseller) {
  return [
    `FICHA CADASTRAL DE REVENDEDORA`, ``,
    `Nome: ${reseller.name}`,
    `Telefone: ${reseller.phone || '(a preencher)'}`,
    `Endereço: ${reseller.address || '(a preencher)'}`,
    `Documento (CPF): ${reseller.document_id || '(a preencher)'}`,
    `Status: ${reseller.status}`,
    `Cadastrada em: ${reseller.created_at}`,
  ].join('\n');
}

function termoCienciaTemplate(reseller) {
  return [
    `TERMO DE CIÊNCIA — CONDIÇÕES DE REVENDA CONSIGNADA`, ``,
    `Eu, ${reseller.name}, declaro estar ciente de que os produtos recebidos em kit`,
    `consignado permanecem de propriedade da ${companyIdentification()} até a venda ser confirmada, e que`,
    `devo informar corretamente cada venda realizada para fins de fechamento mensal.`, ``,
    `[Este documento é um rascunho gerado automaticamente. Assinatura, quando aplicável,`,
    `é tratada fora deste sistema — não há integração de assinatura eletrônica aqui.]`,
  ].join('\n');
}

function contratoTemplate(reseller) {
  return [
    `CONTRATO DE REVENDA CONSIGNADA`, ``,
    `Entre ${companyIdentification()} ("Empresa") e ${reseller.name} ("Revendedora"), telefone ${reseller.phone || '(a preencher)'},`,
    `endereço ${reseller.address || '(a preencher)'}, fica ajustado o regime de consignação`,
    `de produtos para revenda, com comissão de ${reseller.commission_pct != null ? (reseller.commission_pct*100).toFixed(1)+'%' : 'conforme política vigente'}`,
    `sobre o valor efetivamente vendido.`, ``,
    `[Rascunho gerado automaticamente a partir do cadastro. Requer revisão jurídica e`,
    `assinatura por canal externo antes de qualquer validade formal.]`,
  ].join('\n');
}

function termoEntregaTemplate(kit, reseller, items, productNames) {
  const lines = [
    `TERMO DE ENTREGA / CONSIGNAÇÃO — KIT #${kit.id} (ciclo ${kit.cycle_number})`, ``,
    `Revendedora: ${reseller.name}`,
    `Data: ${new Date().toLocaleString('pt-BR')}`, ``,
    `Itens entregues:`,
  ];
  for (const item of items) {
    lines.push(`- ${productNames[item.product_id]}: ${item.quantity_suggested} unidades, preço de venda R$ ${(item.unit_sale_price_cents/100).toFixed(2)}/un`);
  }
  lines.push('', `[Os produtos permanecem propriedade da ${companyIdentification()} até a venda ser confirmada no fechamento.]`);
  return lines.join('\n');
}

function createDocument({ resellerId, type, content, referenceId, userId }) {
  const info = db
    .prepare('INSERT INTO documents (reseller_id, type, content, reference_id, created_by) VALUES (?,?,?,?,?)')
    .run(resellerId, type, content, referenceId || null, userId);
  logAudit({ actorUserId: userId, actorLabel: 'Sistema', action: 'document.created', entityType: 'document', entityId: info.lastInsertRowid, details: { type, reseller_id: resellerId } });
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(info.lastInsertRowid);
}

/** Chamado automaticamente quando uma revendedora é contratada (Seção 5: Marina
 * "prepara contrato e documentos a partir de modelos aprovados"). */
function generateHireDocuments(reseller, userId) {
  createDocument({ resellerId: reseller.id, type: 'ficha_cadastral', content: fichaCadastralTemplate(reseller), userId });
  createDocument({ resellerId: reseller.id, type: 'termo_ciencia', content: termoCienciaTemplate(reseller), userId });
  createDocument({ resellerId: reseller.id, type: 'contrato', content: contratoTemplate(reseller), userId });
}

/** Chamado automaticamente na confirmação de entrega de um kit. */
function generateDeliveryDocument(kit, reseller, items, productNames, userId) {
  return createDocument({
    resellerId: reseller.id, type: 'termo_entrega',
    content: termoEntregaTemplate(kit, reseller, items, productNames),
    referenceId: kit.id, userId,
  });
}

function listDocumentsForReseller(resellerId) {
  return db.prepare('SELECT * FROM documents WHERE reseller_id = ? ORDER BY id DESC').all(resellerId);
}

function getDocumentById(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

function updateDocumentStatus(documentId, status, actorUser) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  if (!doc) throw new Error('Documento não encontrado.');
  const allowed = ['rascunho','aguardando_revisao','aprovado','enviado','assinado','arquivado'];
  if (!allowed.includes(status)) throw new Error('Status inválido.');
  db.prepare(`UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, documentId);
  logAudit({ actorUserId: actorUser.id, actorLabel: actorUser.role === 'ceo' ? 'CEO' : 'Marina', action: 'document.status_changed', entityType: 'document', entityId: documentId, details: { status } });
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
}

module.exports = {
  generateHireDocuments, generateDeliveryDocument, listDocumentsForReseller, updateDocumentStatus, createDocument, getDocumentById,
};
