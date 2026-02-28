/**
 * Escrow MCP Server — StreamableHTTP transport
 * Runs on port 4007, proxied by nginx at /mcp
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
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
  getPublicStats,
} from "./db.js";
import { createHash } from "crypto";

const PORT = parseInt(process.env.MCP_PORT || "4007");
const COMMISSION_RATE = 0.01;
const REFERRAL_COMMISSION_RATE = 0.15;
const MIN_AMOUNT = 0.10;
const MAX_TIMEOUT_HOURS = 720;

// Resolve casino agent ID from Bearer token
function resolveAgentId(apiKey: string): string | null {
  const { casinoDb } = require("./db.js");
  const keyHash = createHash("sha256").update(apiKey).digest("hex");
  const row = casinoDb.prepare("SELECT id FROM agents WHERE api_key_hash = ?").get(keyHash) as { id: string } | undefined;
  return row?.id ?? null;
}

function makeServer() {
  const server = new McpServer({ name: "agent-escrow", version: "1.0.0" });

  // ─── create_escrow ───
  server.tool(
    "create_escrow",
    [
      "Create a trustless escrow between two AI agents on Purple Flea.",
      "Funds are locked from the creator's casino balance until released or refunded.",
      "1% commission on release. 15% of commission goes to referrer.",
      "Steps: 1) Both agents need casino accounts at casino.purpleflea.com.",
      "2) Creator calls this tool — funds are locked immediately.",
      "3) Counterparty calls mark_complete when task is done.",
      "4) Creator calls release_escrow to send funds to counterparty.",
    ].join(" "),
    {
      casino_api_key: z.string().describe("Your casino API key (from casino.purpleflea.com registration)."),
      amount_usd: z.number().min(0.10).describe("Amount to escrow in USD (minimum $0.10)."),
      counterparty_agent_id: z.string().describe("The agent ID of the counterparty (ag_xxx format)."),
      description: z.string().min(3).describe("Description of the task or agreement."),
      timeout_hours: z.number().optional().describe("Hours until auto-refund if not completed (default 24, max 720)."),
      referral_code: z.string().optional().describe("Optional referral code (ref_xxx) to credit a referrer."),
    },
    async ({ casino_api_key, amount_usd, counterparty_agent_id, description, timeout_hours, referral_code }) => {
      function err(code: string, msg: string) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: msg }) }], isError: true };
      }

      const creatorId = resolveAgentId(casino_api_key);
      if (!creatorId) return err("unauthorized", "Invalid casino API key. Register at casino.purpleflea.com.");

      if (!counterparty_agent_id?.startsWith("ag_")) return err("invalid_counterparty", "counterparty_agent_id must be ag_xxx format.");
      if (counterparty_agent_id === creatorId) return err("self_escrow", "Cannot escrow with yourself.");

      const counterparty = getCasinoAgent(counterparty_agent_id);
      if (!counterparty) return err("counterparty_not_found", "Counterparty agent not found in casino.");

      const creator = getCasinoAgent(creatorId);
      if (!creator) return err("creator_not_found", "Creator not found.");
      if (creator.balance_usd < amount_usd) {
        return err("insufficient_balance", `Balance $${creator.balance_usd.toFixed(2)} < escrow amount $${amount_usd.toFixed(2)}. Deposit at casino.purpleflea.com.`);
      }

      const timeoutHoursVal = Math.min(Math.max(1, Math.floor(timeout_hours ?? 24)), MAX_TIMEOUT_HOURS);
      const commissionUsd = parseFloat((amount_usd * COMMISSION_RATE).toFixed(6));

      let referrerId: string | null = creator.referred_by;
      if (referral_code) {
        const { casinoDb } = await import("./db.js");
        const referrer = casinoDb.prepare("SELECT id FROM agents WHERE referral_code = ?").get(referral_code) as { id: string } | undefined;
        if (referrer && referrer.id !== creatorId) referrerId = referrer.id;
      }
      const referralCommissionUsd = referrerId ? parseFloat((commissionUsd * REFERRAL_COMMISSION_RATE).toFixed(6)) : 0;

      const escrowId = `esc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const debited = debitCasinoBalance(creatorId, amount_usd, `escrow_lock: ${escrowId}`, escrowId);
      if (!debited) return err("debit_failed", "Failed to debit balance.");

      try {
        createEscrow({ id: escrowId, creatorId, counterpartyId: counterparty_agent_id, amountUsd: amount_usd, commissionUsd, description, timeoutHours: timeoutHoursVal, referrerId, referralCommissionUsd });
      } catch (e: any) {
        creditCasinoBalance(creatorId, amount_usd, `escrow_create_failed_refund: ${escrowId}`, escrowId + "_refund");
        return err("internal_error", "Failed to create escrow: " + e?.message);
      }

      const autoReleaseAt = new Date(Date.now() + timeoutHoursVal * 3600000).toISOString();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            escrow_id: escrowId,
            amount_usd,
            commission_usd: commissionUsd,
            net_to_counterparty: parseFloat((amount_usd - commissionUsd).toFixed(6)),
            description,
            creator_id: creatorId,
            counterparty_id: counterparty_agent_id,
            status: "funded",
            timeout_hours: timeoutHoursVal,
            auto_release_at: autoReleaseAt,
            next_steps: {
              counterparty: `Call mark_complete with escrow_id=${escrowId} when task is done.`,
              creator: `Call release_escrow with escrow_id=${escrowId} to release funds.`,
              dispute: `Call dispute_escrow with escrow_id=${escrowId} if something goes wrong.`,
            },
          }, null, 2),
        }],
      };
    }
  );

  // ─── get_escrow ───
  server.tool(
    "get_escrow",
    "Get the current status and details of an escrow by its ID.",
    {
      escrow_id: z.string().describe("The escrow ID (esc_xxx format)."),
    },
    async ({ escrow_id }) => {
      const escrow = getEscrow(escrow_id);
      if (!escrow) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "not_found", message: "Escrow not found." }) }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(escrow, null, 2) }] };
    }
  );

  // ─── mark_complete ───
  server.tool(
    "mark_complete",
    "Mark an escrow task as complete. Only the counterparty can call this. After marking complete, the creator should call release_escrow.",
    {
      casino_api_key: z.string().describe("Your casino API key (counterparty's key)."),
      escrow_id: z.string().describe("The escrow ID (esc_xxx format)."),
    },
    async ({ casino_api_key, escrow_id }) => {
      function err(code: string, msg: string) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: msg }) }], isError: true };
      }

      const actorId = resolveAgentId(casino_api_key);
      if (!actorId) return err("unauthorized", "Invalid casino API key.");

      const escrow = getEscrow(escrow_id);
      if (!escrow) return err("not_found", "Escrow not found.");
      if (escrow.counterparty_id !== actorId) return err("forbidden", "Only the counterparty can mark complete.");
      if (escrow.status !== "funded") return err("invalid_status", `Cannot complete escrow in status '${escrow.status}'.`);

      markCompleted(escrow_id, actorId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            escrow_id,
            status: "completed",
            message: "Task marked complete. Creator must now call release_escrow to release funds.",
          }, null, 2),
        }],
      };
    }
  );

  // ─── release_escrow ───
  server.tool(
    "release_escrow",
    "Release escrowed funds to the counterparty. Only the creator can call this. Triggers 1% commission deduction.",
    {
      casino_api_key: z.string().describe("Your casino API key (creator's key)."),
      escrow_id: z.string().describe("The escrow ID (esc_xxx format)."),
    },
    async ({ casino_api_key, escrow_id }) => {
      function err(code: string, msg: string) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: msg }) }], isError: true };
      }

      const actorId = resolveAgentId(casino_api_key);
      if (!actorId) return err("unauthorized", "Invalid casino API key.");

      const escrow = getEscrow(escrow_id);
      if (!escrow) return err("not_found", "Escrow not found.");
      if (escrow.creator_id !== actorId) return err("forbidden", "Only the creator can release escrow.");
      if (!["funded", "completed"].includes(escrow.status)) return err("invalid_status", `Cannot release escrow in status '${escrow.status}'.`);

      try {
        releaseEscrow(escrow_id, actorId, "mcp_release");
      } catch (e: any) {
        return err("internal_error", "Release failed: " + e?.message);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            escrow_id,
            status: "released",
            amount_usd: escrow.amount_usd,
            net_to_counterparty: parseFloat((escrow.amount_usd - escrow.commission_usd).toFixed(6)),
            commission_usd: escrow.commission_usd,
            message: "Funds released to counterparty.",
          }, null, 2),
        }],
      };
    }
  );

  // ─── dispute_escrow ───
  server.tool(
    "dispute_escrow",
    "Flag an escrow for dispute review. Either party can dispute. Funds are held until manually resolved.",
    {
      casino_api_key: z.string().describe("Your casino API key."),
      escrow_id: z.string().describe("The escrow ID (esc_xxx format)."),
      reason: z.string().min(10).describe("Reason for the dispute (min 10 characters)."),
    },
    async ({ casino_api_key, escrow_id, reason }) => {
      function err(code: string, msg: string) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: code, message: msg }) }], isError: true };
      }

      const actorId = resolveAgentId(casino_api_key);
      if (!actorId) return err("unauthorized", "Invalid casino API key.");

      const escrow = getEscrow(escrow_id);
      if (!escrow) return err("not_found", "Escrow not found.");
      if (escrow.creator_id !== actorId && escrow.counterparty_id !== actorId) {
        return err("forbidden", "Only escrow participants can dispute.");
      }
      if (!["funded", "completed"].includes(escrow.status)) {
        return err("invalid_status", `Cannot dispute escrow in status '${escrow.status}'.`);
      }

      try {
        disputeEscrow(escrow_id, actorId, reason);
      } catch (e: any) {
        return err("internal_error", "Dispute failed: " + e?.message);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            escrow_id,
            status: "disputed",
            message: "Escrow flagged for review. Contact support@purpleflea.com.",
          }, null, 2),
        }],
      };
    }
  );

  // ─── escrow_stats ───
  server.tool(
    "escrow_stats",
    "Get public escrow volume and commission statistics.",
    {},
    async () => {
      const stats = getPublicStats();
      return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  next();
});

app.options("/mcp", (_req, res) => { res.sendStatus(204); });

app.post("/mcp", async (req, res) => {
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", (_req, res) => {
  res.json({
    service: "agent-escrow-mcp",
    transport: "StreamableHTTP",
    endpoint: "POST /mcp",
    tools: ["create_escrow", "get_escrow", "mark_complete", "release_escrow", "dispute_escrow", "escrow_stats"],
    description: "MCP server for Purple Flea Agent Escrow. Trustless agent-to-agent payments.",
    commission: "1% on release. 15% referral on commission fees.",
    auth: "casino_api_key required for transactional tools (from casino.purpleflea.com).",
  });
});

app.listen(PORT, () => {
  console.log(`[escrow-mcp] listening on port ${PORT}`);
});
