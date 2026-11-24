-- Nomad clusters: the gossip key being rotated in, kept until every server
-- uses it and the configuration generations carry it.
ALTER TABLE clusters ADD COLUMN gossip_key_pending_encrypted TEXT NOT NULL DEFAULT '';
