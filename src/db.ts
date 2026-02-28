import Database, { type Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";

const dir = "./data";
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

// Escrow's own DB
const ESCROW_DB_PATH = process.env.ESCROW_DB_PATH || "./data/escrow.db";
export const escrowDb: DatabaseType = new Database(ESCROW_DB_PATH);
escrowDb.pragma("journal_mode = WAL");
escrowDb.pragma("foreign_keys = ON");
escrowDb.pragma("busy_timeout = 30000");

// Casino DB — for balance debit/credit
const CASINO_DB_PATH = process.env.CASINO_DB_PATH || "/home/dev/casino/data/casino.db";
export const casinoDb: DatabaseType = new Database(CASINO_DB_PATH);
casinoDb.pragma("journal_mode = WAL");
casinoDb.pragma("busy_timeout = 30000");

// ─── Schema ───
escrowDb.exec(`
  CREATE TABLE IF NOT EXISTS escrows (
    id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    counterparty_id TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    commission_usd REAL NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'funded',
    timeout_hours INTEGER NOT NULL DEFAULT 24,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    funded_at INTEGER,
    completed_at INTEGER,
    released_at INTEGER,
    disputed_at INTEGER,
    auto_release_at INTEGER NOT NULL,
    referrer_id TEXT,
    referral_commission_usd REAL NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_escrows_creator ON escrows(creator_id);
  CREATE INDEX IF NOT EXISTS idx_escrows_counterparty ON escrows(counterparty_id);
  CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);
  CREATE INDEX IF NOT EXISTS idx_escrows_auto_release ON escrows(auto_release_at, status);

  CREATE TABLE IF NOT EXISTS escrow_events (
    id TEXT PRIMARY KEY,
    escrow_id TEXT NOT NULL REFERENCES escrows(id),
    event TEXT NOT NULL,
    actor_id TEXT,
    note TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_events_escrow ON escrow_events(escrow_id);

  CREATE TABLE IF NOT EXISTS escrow_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_created INTEGER NOT NULL DEFAULT 0,
    total_released INTEGER NOT NULL DEFAULT 0,
    total_disputed INTEGER NOT NULL DEFAULT 0,
    total_volume_usd REAL NOT NULL DEFAULT 0,
    total_commission_usd REAL NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO escrow_stats (id) VALUES (1);
`);

// ─── Types ───
export interface Escrow {
  id: string;
  creator_id: string;
  counterparty_id: string;
  amount_usd: number;
  commission_usd: number;
  description: string;
  status: "funded" | "completed" | "released" | "disputed" | "refunded";
  timeout_hours: number;
  created_at: number;
  funded_at: number | null;
  completed_at: number | null;
  released_at: number | null;
  disputed_at: number | null;
  auto_release_at: number;
  referrer_id: string | null;
  referral_commission_usd: number;
}

// ─── Casino helpers ───
interface CasinoAgent {
  id: string;
  balance_usd: number;
  referred_by: string | null;
  referral_code: string | null;
}

export function getCasinoAgent(agentId: string): CasinoAgent | null {
  return casinoDb.prepare(
    "SELECT id, balance_usd, referred_by, referral_code FROM agents WHERE id = ?"
  ).get(agentId) as CasinoAgent | null;
}

export function debitCasinoBalance(
  agentId: string,
  amount: number,
  reason: string,
  reference: string
): boolean {
  let success = false;
  casinoDb.transaction(() => {
    const agent = casinoDb.prepare("SELECT balance_usd FROM agents WHERE id = ?").get(agentId) as
      | { balance_usd: number }
      | undefined;
    if (!agent || agent.balance_usd < amount) return;

    casinoDb.prepare("UPDATE agents SET balance_usd = balance_usd - ? WHERE id = ?").run(amount, agentId);
    const updated = casinoDb.prepare("SELECT balance_usd FROM agents WHERE id = ?").get(agentId) as {
      balance_usd: number;
    };

    casinoDb.prepare(`
      INSERT INTO ledger_entries (id, agent_id, type, amount, balance_after, reason, reference, service, created_at)
      VALUES (?, ?, 'debit', ?, ?, ?, ?, 'escrow', unixepoch())
    `).run(reference + "_debit", agentId, amount, updated.balance_usd, reason, reference);

    success = true;
  })();
  return success;
}

export function creditCasinoBalance(
  agentId: string,
  amount: number,
  reason: string,
  reference: string
): void {
  casinoDb.transaction(() => {
    casinoDb.prepare("UPDATE agents SET balance_usd = balance_usd + ? WHERE id = ?").run(amount, agentId);
    const agent = casinoDb.prepare("SELECT balance_usd FROM agents WHERE id = ?").get(agentId) as {
      balance_usd: number;
    };
    casinoDb.prepare(`
      INSERT INTO ledger_entries (id, agent_id, type, amount, balance_after, reason, reference, service, created_at)
      VALUES (?, ?, 'credit', ?, ?, ?, ?, 'escrow', unixepoch())
    `).run(reference + "_credit", agentId, amount, agent.balance_usd, reason, reference);
  })();
}

// ─── Escrow helpers ───
export function createEscrow(params: {
  id: string;
  creatorId: string;
  counterpartyId: string;
  amountUsd: number;
  commissionUsd: number;
  description: string;
  timeoutHours: number;
  referrerId: string | null;
  referralCommissionUsd: number;
}): void {
  const now = Math.floor(Date.now() / 1000);
  const autoReleaseAt = now + params.timeoutHours * 3600;

  escrowDb.prepare(`
    INSERT INTO escrows (id, creator_id, counterparty_id, amount_usd, commission_usd, description, status, timeout_hours, funded_at, auto_release_at, referrer_id, referral_commission_usd)
    VALUES (?, ?, ?, ?, ?, ?, 'funded', ?, unixepoch(), ?, ?, ?)
  `).run(
    params.id,
    params.creatorId,
    params.counterpartyId,
    params.amountUsd,
    params.commissionUsd,
    params.description,
    params.timeoutHours,
    autoReleaseAt,
    params.referrerId,
    params.referralCommissionUsd
  );

  escrowDb.prepare(`
    INSERT INTO escrow_events (id, escrow_id, event, actor_id, note)
    VALUES (?, ?, 'created', ?, ?)
  `).run(params.id + "_created", params.id, params.creatorId, `Escrow created: $${params.amountUsd} for "${params.description}"`);

  escrowDb.prepare("UPDATE escrow_stats SET total_created = total_created + 1, total_volume_usd = total_volume_usd + ? WHERE id = 1")
    .run(params.amountUsd);
}

export function getEscrow(id: string): Escrow | null {
  return escrowDb.prepare("SELECT * FROM escrows WHERE id = ?").get(id) as Escrow | null;
}

export function markCompleted(id: string, counterpartyId: string): void {
  escrowDb.prepare("UPDATE escrows SET status = 'completed', completed_at = unixepoch() WHERE id = ? AND status = 'funded'").run(id);
  escrowDb.prepare(`
    INSERT INTO escrow_events (id, escrow_id, event, actor_id, note)
    VALUES (?, ?, 'completed', ?, 'Counterparty marked task complete')
  `).run(id + "_completed_" + Date.now(), id, counterpartyId);
}

export function releaseEscrow(id: string, actorId: string | null, note: string): void {
  escrowDb.prepare(
    "UPDATE escrows SET status = 'released', released_at = unixepoch() WHERE id = ? AND status IN ('funded', 'completed')"
  ).run(id);
  escrowDb.prepare(`
    INSERT INTO escrow_events (id, escrow_id, event, actor_id, note)
    VALUES (?, ?, 'released', ?, ?)
  `).run(id + "_released_" + Date.now(), id, actorId, note);
  escrowDb.prepare(
    "UPDATE escrow_stats SET total_released = total_released + 1, total_commission_usd = total_commission_usd + (SELECT commission_usd FROM escrows WHERE id = ?) WHERE id = 1"
  ).run(id);
}

export function disputeEscrow(id: string, actorId: string, reason: string): void {
  escrowDb.prepare("UPDATE escrows SET status = 'disputed', disputed_at = unixepoch() WHERE id = ? AND status IN ('funded', 'completed')").run(id);
  escrowDb.prepare(`
    INSERT INTO escrow_events (id, escrow_id, event, actor_id, note)
    VALUES (?, ?, 'disputed', ?, ?)
  `).run(id + "_disputed_" + Date.now(), id, actorId, reason);
  escrowDb.prepare("UPDATE escrow_stats SET total_disputed = total_disputed + 1 WHERE id = 1").run();
}

export function refundEscrow(id: string, note: string): void {
  escrowDb.prepare("UPDATE escrows SET status = 'refunded', released_at = unixepoch() WHERE id = ?").run(id);
  escrowDb.prepare(`
    INSERT INTO escrow_events (id, escrow_id, event, actor_id, note)
    VALUES (?, ?, 'refunded', null, ?)
  `).run(id + "_refunded_" + Date.now(), id, note);
}

export function getEscrowEvents(id: string): unknown[] {
  return escrowDb.prepare("SELECT * FROM escrow_events WHERE escrow_id = ? ORDER BY created_at ASC").all(id);
}

export function getPublicStats(): {
  total_created: number;
  total_released: number;
  total_disputed: number;
  total_volume_usd: number;
  total_commission_usd: number;
} {
  return escrowDb.prepare("SELECT * FROM escrow_stats WHERE id = 1").get() as {
    total_created: number;
    total_released: number;
    total_disputed: number;
    total_volume_usd: number;
    total_commission_usd: number;
  };
}

// ─── Auto-release processor ───
export function processAutoReleases(): void {
  const now = Math.floor(Date.now() / 1000);
  const expired = escrowDb.prepare(
    "SELECT * FROM escrows WHERE status IN ('funded', 'completed') AND auto_release_at <= ?"
  ).all(now) as Escrow[];

  for (const escrow of expired) {
    try {
      // Return funds to creator (minus commission)
      const netToCreator = escrow.amount_usd - escrow.commission_usd;
      creditCasinoBalance(escrow.creator_id, netToCreator, `escrow_timeout_refund: ${escrow.id}`, escrow.id + "_timeout");

      // Commission to house (no wallet for house — just record it)
      // If referrer, pay referral commission
      if (escrow.referrer_id && escrow.referral_commission_usd > 0) {
        creditCasinoBalance(
          escrow.referrer_id,
          escrow.referral_commission_usd,
          `escrow_referral_commission: ${escrow.id}`,
          escrow.id + "_refcom"
        );
      }

      refundEscrow(escrow.id, `Auto-refunded after ${escrow.timeout_hours}h timeout`);
      console.log(`[escrow] auto-refunded ${escrow.id} → creator ${escrow.creator_id} $${netToCreator.toFixed(2)}`);
    } catch (err: any) {
      console.error(`[escrow] auto-release failed for ${escrow.id}:`, err?.message);
    }
  }
}

// Run auto-release every 5 minutes
setInterval(processAutoReleases, 5 * 60 * 1000);
// Also run on startup
processAutoReleases();
