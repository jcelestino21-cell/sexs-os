-- SexS OS — Schema completo do banco de dados (SQLite)
-- Este arquivo é executado na inicialização via db.js (CREATE TABLE IF NOT EXISTS).

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- =============================================================================
-- USUÁRIOS E AUTENTICAÇÃO
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('ceo','diretor','revendedora')),
  director_key TEXT,
  reseller_id INTEGER,
  password_hash TEXT,
  password_salt TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- CADASTRO MESTRE
-- =============================================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  brand TEXT,
  default_supplier_id INTEGER REFERENCES suppliers(id),
  internal_code TEXT,
  barcode TEXT,
  description TEXT,
  unit TEXT NOT NULL DEFAULT 'unidade',
  photo_url TEXT,
  last_purchase_cost_cents INTEGER,
  commission_pct_override REAL,
  target_margin_pct REAL,
  min_price_cents INTEGER,
  ideal_price_cents INTEGER,
  promo_price_cents INTEGER,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

-- =============================================================================
-- ESTOQUE
-- =============================================================================

CREATE TABLE IF NOT EXISTS stock_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  quantity_purchased INTEGER NOT NULL,
  unit_cost_cents INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  proposal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stock_lots_product ON stock_lots(product_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  lot_id INTEGER REFERENCES stock_lots(id),
  type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  proposal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);

CREATE TABLE IF NOT EXISTS stock_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  kit_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK(status IN ('ativa','liberada','convertida')),
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stock_reservations_product_status ON stock_reservations(product_id, status);
CREATE INDEX IF NOT EXISTS idx_stock_reservations_kit ON stock_reservations(kit_id);

-- =============================================================================
-- PRECIFICAÇÃO
-- =============================================================================

CREATE TABLE IF NOT EXISTS pricing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  cost_multiplier REAL NOT NULL,
  commission_pct REAL NOT NULL,
  premium_multiplier REAL NOT NULL DEFAULT 1.3,
  active INTEGER NOT NULL DEFAULT 0,
  proposed_by_director TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- REVENDEDORAS
-- =============================================================================

CREATE TABLE IF NOT EXISTS resellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  document_id TEXT,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK(status IN ('ativa','inativa','pendente_documentos')),
  commission_pct REAL,
  created_by INTEGER REFERENCES users(id),
  proposal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_resellers_status ON resellers(status);
CREATE INDEX IF NOT EXISTS idx_resellers_name ON resellers(name);

-- =============================================================================
-- KITS CONSIGNADOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS kits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  cycle_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'sugerido'
    CHECK(status IN ('sugerido','aprovado','em_preparacao','entregue','aguardando_fechamento','encerrado','rejeitado')),
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  delivered_at TEXT,
  closure_requested_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kits_reseller ON kits(reseller_id);
CREATE INDEX IF NOT EXISTS idx_kits_status ON kits(status);

CREATE TABLE IF NOT EXISTS kit_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL REFERENCES kits(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity_suggested INTEGER NOT NULL,
  unit_sale_price_cents INTEGER NOT NULL,
  quantity_delivered INTEGER NOT NULL DEFAULT 0,
  quantity_available INTEGER NOT NULL DEFAULT 0,
  quantity_pending_closure INTEGER NOT NULL DEFAULT 0,
  quantity_confirmed_sold INTEGER NOT NULL DEFAULT 0,
  quantity_returned INTEGER NOT NULL DEFAULT 0,
  quantity_kept_by_reseller INTEGER NOT NULL DEFAULT 0,
  quantity_damaged INTEGER NOT NULL DEFAULT 0,
  quantity_lost INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_kit_items_kit ON kit_items(kit_id);

CREATE TABLE IF NOT EXISTS kit_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_item_id INTEGER NOT NULL REFERENCES kit_items(id),
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'informada' CHECK(status IN ('informada','confirmada','rejeitada')),
  created_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kit_sales_item ON kit_sales(kit_item_id);
CREATE INDEX IF NOT EXISTS idx_kit_sales_status ON kit_sales(status);

CREATE TABLE IF NOT EXISTS kit_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL UNIQUE REFERENCES kits(id),
  total_sold_confirmed_cents INTEGER NOT NULL,
  total_commission_cents INTEGER NOT NULL,
  total_due_to_sexs_cents INTEGER NOT NULL,
  cost_of_goods_sold_cents INTEGER NOT NULL,
  gross_profit_cents INTEGER NOT NULL,
  write_off_cost_cents INTEGER NOT NULL DEFAULT 0,
  items_returned_to_stock INTEGER NOT NULL DEFAULT 0,
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kit_item_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kit_id INTEGER NOT NULL REFERENCES kits(id),
  kit_item_id INTEGER NOT NULL UNIQUE REFERENCES kit_items(id),
  quantity_sold_confirmed INTEGER NOT NULL DEFAULT 0,
  quantity_returned INTEGER NOT NULL DEFAULT 0,
  quantity_kept_authorized INTEGER NOT NULL DEFAULT 0,
  quantity_damaged INTEGER NOT NULL DEFAULT 0,
  quantity_lost INTEGER NOT NULL DEFAULT 0,
  quantity_divergence INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  finalized INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- PROPOSTAS E AUDITORIA
-- =============================================================================

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text TEXT,
  intent TEXT NOT NULL,
  extracted_json TEXT,
  missing_fields_json TEXT,
  impact_json TEXT,
  risk_level TEXT,
  target_director TEXT,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','executada','rejeitada','falhou')),
  created_by INTEGER REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  executed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

-- =============================================================================
-- FINANCEIRO
-- =============================================================================

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  description TEXT,
  amount_cents INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  proposal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commission_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  kit_id INTEGER,
  amount_cents INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS receivable_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  kit_id INTEGER,
  amount_cents INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- DOCUMENTOS
-- =============================================================================

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  reference_id INTEGER,
  status TEXT NOT NULL DEFAULT 'rascunho'
    CHECK(status IN ('rascunho','aguardando_revisao','aprovado','enviado','assinado','arquivado')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_reseller ON documents(reseller_id);

-- =============================================================================
-- CONVERSAS E MEMÓRIA
-- =============================================================================

CREATE TABLE IF NOT EXISTS conversation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  thread TEXT NOT NULL,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  proposal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversation_messages_user_thread ON conversation_messages(user_id, thread);

-- =============================================================================
-- NOTIFICAÇÕES
-- =============================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_role TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_role, read_at);

-- =============================================================================
-- CONSELHO EXECUTIVO
-- =============================================================================

CREATE TABLE IF NOT EXISTS council_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT,
  description TEXT NOT NULL,
  assigned_to TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK(status IN ('aberta','concluida','cancelada')),
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- MARKETING E COMERCIAL
-- =============================================================================

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'planejada' CHECK(status IN ('planejada','ativa','encerrada')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_label TEXT NOT NULL,
  target_cents INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- PORTAL DA REVENDEDORA
-- =============================================================================

CREATE TABLE IF NOT EXISTS tips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reseller_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity_requested INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK(status IN ('pendente','atendido','cancelado')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reseller_orders_reseller ON reseller_orders(reseller_id);
CREATE INDEX IF NOT EXISTS idx_reseller_orders_status ON reseller_orders(status);

-- =============================================================================
-- CADASTRO DE PRODUTO (MULTI-TURNO)
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  data_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'em_andamento' CHECK(status IN ('em_andamento','concluido','cancelado')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- =============================================================================
-- DADOS DA EMPRESA
-- =============================================================================

CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  legal_name TEXT,
  trade_name TEXT,
  document_id TEXT,
  owner_name TEXT,
  owner_document_id TEXT,
  opening_date TEXT,
  registration_status TEXT,
  tax_regime TEXT,
  main_cnae TEXT,
  main_cnae_description TEXT,
  secondary_cnaes_json TEXT,
  address_zip TEXT,
  address_street TEXT,
  address_number TEXT,
  address_district TEXT,
  address_city TEXT,
  address_state TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reseller_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reseller_id INTEGER NOT NULL REFERENCES resellers(id),
  message TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
