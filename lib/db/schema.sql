-- APC Dashboard Postgres Schema
-- Migrating from JSON seed files to Vercel Postgres (Neon)

-- Phone-to-list mappings (from 7 CSV list files, ~478K unique phones)
CREATE TABLE IF NOT EXISTS list_phones (
  phone CHAR(10) NOT NULL,
  list_key VARCHAR(20) NOT NULL,
  PRIMARY KEY (phone, list_key)
);
CREATE INDEX IF NOT EXISTS idx_list_phones_phone ON list_phones(phone);

-- 3CX Mail 4 phones (ITD gate - phones that have been through Mail 4)
CREATE TABLE IF NOT EXISTS mail4_phones (
  phone CHAR(10) PRIMARY KEY
);

-- 3CX phone last queue (most recent sales queue per phone)
CREATE TABLE IF NOT EXISTS phone_last_queue (
  phone CHAR(10) PRIMARY KEY,
  queue VARCHAR(50) NOT NULL,
  call_date DATE NOT NULL
);

-- 3CX opened calls by date (for transfer counting)
CREATE TABLE IF NOT EXISTS opened_calls (
  call_date DATE NOT NULL,
  phone CHAR(10) NOT NULL,
  PRIMARY KEY (call_date, phone)
);

-- AIM transfers
CREATE TABLE IF NOT EXISTS aim_transfers (
  call_id VARCHAR(50) PRIMARY KEY,
  phone CHAR(10) NOT NULL,
  list_key VARCHAR(20),
  agent VARCHAR(100),
  call_date DATE NOT NULL,
  duration_sec REAL DEFAULT 0,
  cost REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_aim_transfers_date ON aim_transfers(call_date);
CREATE INDEX IF NOT EXISTS idx_aim_transfers_phone ON aim_transfers(phone);

-- AIM daily costs per list (ALL calls, not just transfers)
CREATE TABLE IF NOT EXISTS aim_daily_costs (
  list_key VARCHAR(20) NOT NULL,
  call_date DATE NOT NULL,
  minutes REAL DEFAULT 0,
  cost REAL DEFAULT 0,
  PRIMARY KEY (list_key, call_date)
);

-- AIM daily costs per agent (ALL calls)
CREATE TABLE IF NOT EXISTS aim_agent_daily_costs (
  agent VARCHAR(100) NOT NULL,
  call_date DATE NOT NULL,
  minutes REAL DEFAULT 0,
  cost REAL DEFAULT 0,
  PRIMARY KEY (agent, call_date)
);

-- AIM all-call phone-to-agent (most recent agent per phone from ANY call)
CREATE TABLE IF NOT EXISTS aim_phone_agent (
  phone CHAR(10) PRIMARY KEY,
  agent VARCHAR(100) NOT NULL,
  last_call_date DATE NOT NULL
);

-- AIM phone history (for list attribution tiebreaker)
CREATE TABLE IF NOT EXISTS aim_phone_history (
  phone CHAR(10) NOT NULL,
  list_key VARCHAR(20) NOT NULL,
  call_date DATE NOT NULL,
  PRIMARY KEY (phone, list_key, call_date)
);
CREATE INDEX IF NOT EXISTS idx_aim_phone_history_phone ON aim_phone_history(phone);

-- Moxy deals
CREATE TABLE IF NOT EXISTS moxy_deals (
  customer_id VARCHAR(50),
  contract_no VARCHAR(50),
  sold_date DATE,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  home_phone CHAR(10),
  mobile_phone CHAR(10),
  salesperson VARCHAR(100),
  deal_status VARCHAR(50),
  promo_code VARCHAR(50),
  campaign VARCHAR(50),
  source VARCHAR(50),
  cancel_reason VARCHAR(100),
  make VARCHAR(50),
  model VARCHAR(100),
  state VARCHAR(10),
  admin REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_moxy_deals_sold_date ON moxy_deals(sold_date);
CREATE INDEX IF NOT EXISTS idx_moxy_deals_home_phone ON moxy_deals(home_phone);
CREATE INDEX IF NOT EXISTS idx_moxy_deals_mobile_phone ON moxy_deals(mobile_phone);
CREATE INDEX IF NOT EXISTS idx_moxy_deals_contract ON moxy_deals(contract_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_moxy_deals_unique ON moxy_deals(contract_no) WHERE contract_no IS NOT NULL AND contract_no != '';

-- Metadata tracking
CREATE TABLE IF NOT EXISTS seed_metadata (
  source VARCHAR(20) PRIMARY KEY,  -- 'aim', 'tcx', 'moxy', 'lists'
  max_date DATE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  row_count INTEGER DEFAULT 0
);
