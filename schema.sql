-- Run this once against your Neon Postgres database (DATABASE_URL in Vercel env vars).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                          -- RevenueCat app_user_id, sent from the app as userId
  daily_message_count INTEGER NOT NULL DEFAULT 0,
  count_reset_date DATE NOT NULL DEFAULT CURRENT_DATE,
  is_pro BOOLEAN NOT NULL DEFAULT FALSE,         -- Lumie Pro (teen tier)
  is_family_pro BOOLEAN NOT NULL DEFAULT FALSE,  -- Lumie Family (parent tier)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bridge_rooms (
  room_code TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bridge_messages (
  id SERIAL PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES bridge_rooms(room_code),
  sender TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bridge_messages_room ON bridge_messages(room_code, created_at);