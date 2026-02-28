import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "@hono/node-server/serve-static";
import { randomUUID } from "crypto";
import {
  getCasinoAgent,
  debitCasinoBalance,
  creditCasinoBalance,
  createEscrow,
  getEscrow,
  markCompleted,
  releaseEscrow,
  disputeEscrow,
  refundEscrow,
  getEscrowEvents,
  getPublicStats,
} from "./db.js";

const PORT = parseInt(process.env.PORT || "3007");
const COMMISSION_RATE = 0.01; // 1%
const REFERRAL_COMMISSION_RATE = 0.15; // 15% of commission fee
const MIN_AMOUNT = 0.10;
const MAX_TIMEOUT_HOURS = 720; // 30 days

const app = new Hono();

// ─── Rate limiter ───
const rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();
function rateLimit(maxRequests: number, windowMs: number) {
  return async (c: any, next: () => Promise<void>) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("x-real-ip")
      || "unknown";
    const key = `${c.req.path}:${ip}`;
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || now - bucket.windowStart > windowMs) {
      rateLimitBuckets.set(key, { count: 1, windowStart: now });
    } else {
      bucket.count++;
      if (bucket.count > maxRequests) {
        return c.json(
          { error: "rate_limited", message: `Too many requests. Limit: ${maxRequests} per ${windowMs / 1000}s` },
          429
        );
      }
    }
    await next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.windowStart < cutoff) rateLimitBuckets.delete(key);
  }
}, 300_000);

// ─── Simple API key auth ───
// Escrow uses the casino agent system — auth header is the casino API key.
// We look up the agent by calling casino's internal DB directly.
async function resolveAgent(c: any): Promise<string | null> {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const apiKey = auth.slice(7);
  // Hash and look up in casino DB
  const { createHash } = await import("crypto");
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const row = (await import("./db.js")).casinoDb.prepare(
    "SELECT id FROM agents WHERE api_key_hash = ?"
  ).get(keyHash) as { id: string } | undefined;
  return row?.id ?? null;
}

// ─── Middleware ───
app.use("*", cors({ origin: "*" }));
app.use("*", logger());

// ─── _info metadata ───
app.use("*", async (c, next) => {
  await next();
  const ct = c.res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return;
  try {
    const body = await c.res.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      body._info = {
        service: "agent-escrow",
        docs: "https://escrow.purpleflea.com/llms.txt",
        referral: "GET /gossip — 15% referral commission on escrow fees",
        version: "1.0.0",
      };
      c.res = new Response(JSON.stringify(body), {
        status: c.res.status,
        headers: { "content-type": "application/json; charset=UTF-8" },
      });
    }
  } catch { /* skip */ }
});

// ─── Static ───
app.use("/llms.txt", serveStatic({ path: "./public/llms.txt" }));
app.use("/robots.txt", serveStatic({ path: "./public/robots.txt" }));

// ─── GET / ───
app.get("/", (c) =>
  c.json({
    service: "agent-escrow",
    version: "1.0.0",
    description: "Trustless escrow between AI agents. Agent A deposits funds, Agent B completes task, funds release. 1% commission.",
    commission: "1% on released escrow. Referral: 15% of commission to referrer.",
    endpoints: {
      "POST /escrow/create": "Create escrow — deducts from creator casino balance",
      "POST /escrow/complete/:id": "Counterparty marks task complete",
      "POST /escrow/release/:id": "Creator releases funds to counterparty",
      "POST /escrow/dispute/:id": "Flag escrow for manual review",
      "GET /escrow/:id": "Get escrow status",
      "GET /escrow/stats": "Public volume/commission stats",
      "GET /gossip": "Referral program info",
    },
    docs: "https://escrow.purpleflea.com/llms.txt",
    auth: "Bearer {casino_api_key} — same key from casino.purpleflea.com registration",
  })
);

// ─── POST /escrow/create ───
app.post("/escrow/create", rateLimit(20, 60_000), async (c) => {
  const creatorId = await resolveAgent(c);
  if (!creatorId) {
    return c.json(
      { error: "unauthorized", message: "Bearer {casino_api_key} required. Register at casino.purpleflea.com." },
      401
    );
  }

  const body = await c.req.json().catch(() => ({})) as {
    amount_usd?: number;
    description?: string;
    counterparty_agent_id?: string;
    timeout_hours?: number;
    referral_code?: string;
  };

  const amountUsd = typeof body.amount_usd === "number" ? body.amount_usd : parseFloat(String(body.amount_usd ?? "0"));
  const description = body.description?.trim();
  const counterpartyId = body.counterparty_agent_id?.trim();
  const timeoutHours = Math.min(
    Math.max(1, Math.floor(body.timeout_hours ?? 24)),
    MAX_TIMEOUT_HOURS
  );

  if (!amountUsd || amountUsd < MIN_AMOUNT) {
    return c.json({ error: "invalid_amount", message: `Minimum escrow amount is $${MIN_AMOUNT}` }, 400);
  }
  if (!description || description.length < 3) {
    return c.json({ error: "invalid_description", message: "description is required (min 3 chars)" }, 400);
  }
  if (!counterpartyId?.startsWith("ag_")) {
    return c.json({ error: "invalid_counterparty", message: "counterparty_agent_id must be in ag_xxx format" }, 400);
  }
  if (counterpartyId === creatorId) {
    return c.json({ error: "self_escrow", message: "Cannot create escrow with yourself" }, 400);
  }

  // Verify counterparty exists
  const counterparty = getCasinoAgent(counterpartyId);
  if (!counterparty) {
    return c.json({ error: "counterparty_not_found", message: "Counterparty agent not found in casino" }, 404);
  }

  // Check creator balance
  const creator = getCasinoAgent(creatorId);
  if (!creator) return c.json({ error: "creator_not_found" }, 404);
  if (creator.balance_usd < amountUsd) {
    return c.json(
      {
        error: "insufficient_balance",
        message: `Balance $${creator.balance_usd.toFixed(2)} < escrow amount $${amountUsd.toFixed(2)}`,
        balance: creator.balance_usd,
      },
      402
    );
  }

  // Commission calculation
  const commissionUsd = parseFloat((amountUsd * COMMISSION_RATE).toFixed(6));

  // Referral — 15% of commission goes to referrer of the creator
  let referrerId: string | null = null;
  const referralCode = body.referral_code;
  if (referralCode) {
    const { casinoDb } = await import("./db.js");
    const referrer = casinoDb.prepare("SELECT id FROM agents WHERE referral_code = ?").get(referralCode) as
      | { id: string }
      | undefined;
    if (referrer && referrer.id !== creatorId) referrerId = referrer.id;
  } else if (creator.referred_by) {
    referrerId = creator.referred_by;
  }
  const referralCommissionUsd = referrerId
    ? parseFloat((commissionUsd * REFERRAL_COMMISSION_RATE).toFixed(6))
    : 0;

  // Deduct from creator
  const escrowId = `esc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const debited = debitCasinoBalance(creatorId, amountUsd, `escrow_lock: ${escrowId}`, escrowId);
  if (!debited) {
    return c.json({ error: "debit_failed", message: "Failed to debit balance. Check your balance and try again." }, 500);
  }

  // Create escrow record
  try {
    createEscrow({
      id: escrowId,
      creatorId,
      counterpartyId,
      amountUsd,
      commissionUsd,
      description,
      timeoutHours,
      referrerId,
      referralCommissionUsd,
    });
  } catch (err: any) {
    // Refund on DB error
    creditCasinoBalance(creatorId, amountUsd, `escrow_create_failed_refund: ${escrowId}`, escrowId + "_refund");
    console.error("[escrow/create] DB error:", err?.message);
    return c.json({ error: "internal_error", message: "Failed to create escrow record." }, 500);
  }

  const autoReleaseAt = Math.floor(Date.now() / 1000) + timeoutHours * 3600;

  return c.json(
    {
      escrow_id: escrowId,
      amount_usd: amountUsd,
      commission_usd: commissionUsd,
      net_to_counterparty: parseFloat((amountUsd - commissionUsd).toFixed(6)),
      description,
      creator_id: creatorId,
      counterparty_id: counterpartyId,
      status: "funded",
      timeout_hours: timeoutHours,
      auto_release_at: new Date(autoReleaseAt * 1000).toISOString(),
      next_steps: {
        counterparty: `POST /escrow/complete/${escrowId} when task is done`,
        creator: `POST /escrow/release/${escrowId} to release funds`,
        dispute: `POST /escrow/dispute/${escrowId} if something goes wrong`,
      },
    },
    201
  );
});

// ─── POST /escrow/complete/:id ───
app.post("/escrow/complete/:id", rateLimit(30, 60_000), async (c) => {
  const actorId = await resolveAgent(c);
  if (!actorId) return c.json({ error: "unauthorized" }, 401);

  const escrowId = c.req.param("id");
  const escrow = getEscrow(escrowId);
  if (!escrow) return c.json({ error: "not_found", message: "Escrow not found" }, 404);

  if (escrow.counterparty_id !== actorId) {
    return c.json(
      { error: "forbidden", message: "Only the counterparty can mark the task complete" },
      403
    );
  }
  if (escrow.status !== "funded") {
    return c.json({ error: "invalid_status", message: `Cannot complete escrow in status '${escrow.status}'` }, 409);
  }

  markCompleted(escrowId, actorId);

  return c.json({
    escrow_id: escrowId,
    status: "completed",
    message: "Task marked complete. Waiting for creator to release funds.",
    next_step: `Creator should call POST /escrow/release/${escrowId}`,
    auto_release_at: new Date(escrow.auto_release_at * 1000).toISOString(),
  });
});

// ─── POST /escrow/release/:id ───
app.post("/escrow/release/:id", rateLimit(30, 60_000), async (c) => {
  const actorId = await resolveAgent(c);
  if (!actorId) return c.json({ error: "unauthorized" }, 401);

  const escrowId = c.req.param("id");
  const escrow = getEscrow(escrowId);
  if (!escrow) return c.json({ error: "not_found", message: "Escrow not found" }, 404);

  // Only creator can release (or auto-release handles timeout)
  if (escrow.creator_id !== actorId) {
    return c.json(
      { error: "forbidden", message: "Only the escrow creator can release funds" },
      403
    );
  }
  if (!["funded", "completed"].includes(escrow.status)) {
    return c.json({ error: "invalid_status", message: `Cannot release escrow in status '${escrow.status}'` }, 409);
  }

  const netToCounterparty = parseFloat((escrow.amount_usd - escrow.commission_usd).toFixed(6));
  const houseCommission = parseFloat(
    (escrow.commission_usd - escrow.referral_commission_usd).toFixed(6)
  );

  try {
    // Pay counterparty (net of commission)
    creditCasinoBalance(
      escrow.counterparty_id,
      netToCounterparty,
      `escrow_release: ${escrowId}`,
      escrowId + "_release"
    );

    // Referral commission (if any)
    if (escrow.referrer_id && escrow.referral_commission_usd > 0) {
      creditCasinoBalance(
        escrow.referrer_id,
        escrow.referral_commission_usd,
        `escrow_referral_commission: ${escrowId}`,
        escrowId + "_refcom"
      );
    }

    // House keeps remaining commission (houseCommission — no wallet address, just tracked in ledger)
    // Record house commission as a "house" agent credit if we had one, otherwise just log it

    releaseEscrow(escrowId, actorId, `Released by creator ${actorId}`);
  } catch (err: any) {
    console.error("[escrow/release] error:", err?.message);
    return c.json({ error: "release_failed", message: "Failed to release funds. Contact support." }, 500);
  }

  return c.json({
    escrow_id: escrowId,
    status: "released",
    amount_released: netToCounterparty,
    commission: escrow.commission_usd,
    referral_commission: escrow.referral_commission_usd,
    counterparty_id: escrow.counterparty_id,
    message: `$${netToCounterparty.toFixed(2)} released to counterparty.`,
  });
});

// ─── POST /escrow/dispute/:id ───
app.post("/escrow/dispute/:id", rateLimit(10, 60_000), async (c) => {
  const actorId = await resolveAgent(c);
  if (!actorId) return c.json({ error: "unauthorized" }, 401);

  const escrowId = c.req.param("id");
  const escrow = getEscrow(escrowId);
  if (!escrow) return c.json({ error: "not_found" }, 404);

  if (escrow.creator_id !== actorId && escrow.counterparty_id !== actorId) {
    return c.json({ error: "forbidden", message: "Only escrow participants can dispute" }, 403);
  }
  if (!["funded", "completed"].includes(escrow.status)) {
    return c.json({ error: "invalid_status", message: `Cannot dispute escrow in status '${escrow.status}'` }, 409);
  }

  const body = await c.req.json().catch(() => ({})) as { reason?: string };
  const reason = body.reason?.trim() || "No reason provided";

  disputeEscrow(escrowId, actorId, reason);

  return c.json({
    escrow_id: escrowId,
    status: "disputed",
    reason,
    message: "Escrow flagged for manual review. Purple Flea team will investigate.",
    contact: "support@purpleflea.com",
  });
});

// ─── GET /escrow/stats ───
app.get("/escrow/stats", async (c) => {
  const stats = getPublicStats();
  return c.json({
    total_created: stats.total_created,
    total_released: stats.total_released,
    total_disputed: stats.total_disputed,
    total_volume_usd: parseFloat(stats.total_volume_usd.toFixed(2)),
    total_commission_usd: parseFloat(stats.total_commission_usd.toFixed(2)),
    commission_rate: "1%",
    referral_commission_rate: "15% of fees",
  });
});

// ─── GET /escrow/:id ───
app.get("/escrow/:id", async (c) => {
  const actorId = await resolveAgent(c);
  const escrowId = c.req.param("id");
  const escrow = getEscrow(escrowId);
  if (!escrow) return c.json({ error: "not_found", message: "Escrow not found" }, 404);

  // Participants see full details; public sees redacted
  const isParticipant = actorId && (actorId === escrow.creator_id || actorId === escrow.counterparty_id);

  const events = isParticipant ? getEscrowEvents(escrowId) : [];

  return c.json({
    escrow_id: escrow.id,
    status: escrow.status,
    amount_usd: escrow.amount_usd,
    commission_usd: escrow.commission_usd,
    net_to_counterparty: parseFloat((escrow.amount_usd - escrow.commission_usd).toFixed(6)),
    description: escrow.description,
    creator_id: escrow.creator_id,
    counterparty_id: escrow.counterparty_id,
    timeout_hours: escrow.timeout_hours,
    created_at: new Date(escrow.created_at * 1000).toISOString(),
    auto_release_at: new Date(escrow.auto_release_at * 1000).toISOString(),
    completed_at: escrow.completed_at ? new Date(escrow.completed_at * 1000).toISOString() : null,
    released_at: escrow.released_at ? new Date(escrow.released_at * 1000).toISOString() : null,
    disputed_at: escrow.disputed_at ? new Date(escrow.disputed_at * 1000).toISOString() : null,
    ...(isParticipant ? { events } : {}),
  });
});

// ─── GET /gossip ───
app.get("/gossip", (c) =>
  c.json({
    service: "agent-escrow",
    tagline: "Trustless AI-to-AI escrow with 1% commission",
    referral_program: {
      how_it_works: "When your referred agents create and release escrows, you earn 15% of the 1% commission fee.",
      example: "Agent B (referred by you) creates a $100 escrow. Commission = $1.00. You earn $0.15.",
      total_passive_income: "Unlimited — stacks across all referred agents forever.",
      get_your_code: "POST /api/v1/auth/register at https://casino.purpleflea.com — returns your referral code",
    },
    escrow: {
      commission_rate: "1% on released escrows",
      min_amount_usd: MIN_AMOUNT,
      max_timeout_hours: MAX_TIMEOUT_HOURS,
      use_cases: [
        "Agent A pays Agent B to scrape data",
        "Agent A pays Agent B to run ML inference",
        "Agent A pays Agent B for API access credits",
        "Trustless gig work between autonomous agents",
      ],
    },
    network: {
      casino: "https://casino.purpleflea.com",
      wallet: "https://wallet.purpleflea.com",
      trading: "https://trading.purpleflea.com",
      domains: "https://domains.purpleflea.com",
      escrow: "https://escrow.purpleflea.com",
      faucet: "https://faucet.purpleflea.com",
    },
  })
);

// ─── GET /health ───
app.get("/health", (c) =>
  c.json({ status: "ok", service: "agent-escrow", uptime: process.uptime() })
);

// ─── Error handlers ───
app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("[error]", err.message);
  return c.json({ error: "internal_error" }, 500);
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[escrow] listening on port ${info.port}`);
});
