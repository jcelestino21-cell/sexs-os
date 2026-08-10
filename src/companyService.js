// Dados legais da empresa (razão social, CNPJ, endereço, CNAEs) — linha única no
// banco, preenchida a partir do Certificado da Condição de MEI. Usado para que os
// documentos internos (contratos, termos) tragam a identificação legal real da
// empresa, em vez de só o nome da marca.
const db = require('../db');
const { logAudit } = require('./audit');

function getCompanyInfo() {
  const row = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  if (!row) return null;
  return { ...row, secondary_cnaes: row.secondary_cnaes_json ? JSON.parse(row.secondary_cnaes_json) : [] };
}

/** Cria ou substitui a linha única de dados da empresa. */
function setCompanyInfo(data, actorUser) {
  const secondaryJson = JSON.stringify(data.secondary_cnaes || []);
  const exists = db.prepare('SELECT id FROM company_settings WHERE id = 1').get();
  if (exists) {
    db.prepare(`UPDATE company_settings SET
      legal_name=?, trade_name=?, document_id=?, owner_name=?, owner_document_id=?, opening_date=?,
      registration_status=?, tax_regime=?, main_cnae=?, main_cnae_description=?, secondary_cnaes_json=?,
      address_zip=?, address_street=?, address_number=?, address_district=?, address_city=?, address_state=?,
      updated_by=?, updated_at=datetime('now')
      WHERE id=1`).run(
      data.legal_name, data.trade_name, data.document_id, data.owner_name, data.owner_document_id, data.opening_date,
      data.registration_status, data.tax_regime, data.main_cnae, data.main_cnae_description, secondaryJson,
      data.address_zip, data.address_street, data.address_number, data.address_district, data.address_city, data.address_state,
      actorUser ? actorUser.id : null
    );
  } else {
    db.prepare(`INSERT INTO company_settings (
      id, legal_name, trade_name, document_id, owner_name, owner_document_id, opening_date,
      registration_status, tax_regime, main_cnae, main_cnae_description, secondary_cnaes_json,
      address_zip, address_street, address_number, address_district, address_city, address_state, updated_by
    ) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.legal_name, data.trade_name, data.document_id, data.owner_name, data.owner_document_id, data.opening_date,
      data.registration_status, data.tax_regime, data.main_cnae, data.main_cnae_description, secondaryJson,
      data.address_zip, data.address_street, data.address_number, data.address_district, data.address_city, data.address_state,
      actorUser ? actorUser.id : null
    );
  }
  logAudit({ actorUserId: actorUser ? actorUser.id : null, actorLabel: 'CEO', action: 'company.settings_updated', entityType: 'company_settings', entityId: 1 });
  return getCompanyInfo();
}

/** Endereço formatado em uma linha, pronto para uso em documentos. */
function formattedAddress(info) {
  if (!info || !info.address_street) return null;
  return `${info.address_street}, ${info.address_number || 's/n'} — ${info.address_district || ''}, ${info.address_city}/${info.address_state} — CEP ${info.address_zip}`;
}

module.exports = { getCompanyInfo, setCompanyInfo, formattedAddress };
