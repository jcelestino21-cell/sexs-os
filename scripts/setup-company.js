// Preenche os dados legais da empresa a partir de variáveis de ambiente.
// FASE 10.5 — CORREÇÃO: dados pessoais removidos do código-fonte (LGPD).
// Antes: CPF, CNPJ, nome e endereço hardcoded em texto puro.
// Agora: todos os dados vêm de variáveis de ambiente (.env).
//
// Rode com: node scripts/setup-company.js
// Certifique-se de que o .env está preenchido (veja .env.example).
const db = require('../db');
const companyService = require('../src/companyService');

function run() {
  const ceo = db.prepare(`SELECT id FROM users WHERE role = 'ceo' ORDER BY id LIMIT 1`).get();
  if (!ceo) {
    console.log('Nenhuma usuária CEO encontrada ainda — rode scripts/seed.js antes deste script.');
    return;
  }

  const data = {
    legal_name: process.env.COMPANY_LEGAL_NAME,
    trade_name: process.env.COMPANY_TRADE_NAME,
    document_id: process.env.COMPANY_DOCUMENT_ID,
    owner_name: process.env.COMPANY_OWNER_NAME,
    owner_document_id: process.env.COMPANY_OWNER_DOCUMENT_ID,
    opening_date: process.env.COMPANY_OPENING_DATE,
    registration_status: process.env.COMPANY_REGISTRATION_STATUS || 'ATIVA',
    tax_regime: process.env.COMPANY_TAX_REGIME,
    main_cnae: process.env.COMPANY_MAIN_CNAE,
    main_cnae_description: process.env.COMPANY_MAIN_CNAE_DESCRIPTION,
    secondary_cnaes: process.env.COMPANY_SECONDARY_CNAES
      ? JSON.parse(process.env.COMPANY_SECONDARY_CNAES)
      : [],
    address_zip: process.env.COMPANY_ADDRESS_ZIP,
    address_street: process.env.COMPANY_ADDRESS_STREET,
    address_number: process.env.COMPANY_ADDRESS_NUMBER,
    address_district: process.env.COMPANY_ADDRESS_DISTRICT,
    address_city: process.env.COMPANY_ADDRESS_CITY,
    address_state: process.env.COMPANY_ADDRESS_STATE,
  };

  // Validação mínima: pelo menos os campos essenciais precisam estar preenchidos
  const required = ['legal_name', 'document_id', 'trade_name'];
  const missing = required.filter(f => !data[f]);
  if (missing.length > 0) {
    console.error(`Erro: variáveis de ambiente obrigatórias não definidas no .env:`);
    missing.forEach(f => console.error(`  - COMPANY_${f.toUpperCase()}`));
    console.error(`\nVeja .env.example para a lista completa de variáveis.`);
    process.exit(1);
  }

  companyService.setCompanyInfo(data, { id: ceo.id, role: 'ceo' });

  console.log('Dados legais da empresa gravados com sucesso.');
  console.log(`  Razão social: ${data.legal_name}`);
  console.log(`  Nome fantasia: ${data.trade_name}`);
  console.log(`  CNPJ: ${data.document_id}`);
  console.log(`  Cidade: ${data.address_city || '(não informado)'}`);
}

run();
