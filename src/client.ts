// UCP Agent Client — simulates an AI agent buying a conference ticket via MCP
// Drives the full UCP checkout lifecycle using the MCP SDK Client:
//   1. create_checkout
//   2. update_checkout (buyer + fulfillment)
//   3. complete_checkout (with payment token)
//
// Run: tsx src/client.ts
// (starts the server as a subprocess via stdio transport)

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { UCPToolResult } from "./types.js"

const UCP_PROFILE = "dev.ucp.shopping" as const

function meta(idempotent = false): Record<string, unknown> {
  return {
    "ucp-agent": { profile: UCP_PROFILE },
    ...(idempotent ? { "idempotency-key": crypto.randomUUID() } : {}),
  }
}

function log(step: string, result: UCPToolResult) {
  console.log(`\n${"─".repeat(60)}`)
  console.log(`STEP: ${step}`)
  console.log("─".repeat(60))
  const { checkout } = result
  console.log(JSON.stringify({
    id: checkout.id,
    status: checkout.status,
    totals: checkout.totals,
    fulfillment: checkout.fulfillment,
    order: checkout.order,
  }, null, 2))
}

async function callTool(client: Client, name: string, args: unknown): Promise<UCPToolResult> {
  const res = await client.callTool({ name, arguments: args as Record<string, unknown> })

  if (res.isError) {
    const msg = (res.content as Array<{ type: string; text: string }>)
      .map((c) => c.text)
      .join("\n")
    throw new Error(`Tool ${name} failed: ${msg}`)
  }

  // UCP returns structured content — parse from text if structuredContent not surfaced
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}"
  return JSON.parse(text) as UCPToolResult
}

async function runCheckout() {
  console.log("UCP Agent — Buying TOKEN2049 VIP Pass")
  console.log("Protocol: Universal Commerce Protocol v2026-04-08")
  console.log("Transport: MCP (stdio)\n")

  // Start the UCP merchant server as a subprocess via stdio
  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/server.ts"],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined)
    ) as Record<string, string>,
  })

  const client = new Client({ name: "ucp-agent", version: "1.0.0" })
  await client.connect(transport)

  try {
    // ── Step 1: create_checkout ─────────────────────────────────────────────
    const created = await callTool(client, "create_checkout", {
      meta: meta(),
      checkout: {
        items: [{ id: "token2049-vip", quantity: 1 }],
      },
    })
    log("1. create_checkout", created)

    const checkoutId = created.checkout.id

    // OBSERVATION: UCP starts in "cart" status. Unlike ACP's "not_ready_for_payment",
    // "cart" is more semantically clear — this is a shopping cart, not a payment flow.
    // The naming reflects UCP's broader commerce scope.

    // ── Step 2: update_checkout (buyer + fulfillment) ───────────────────────
    const updated = await callTool(client, "update_checkout", {
      meta: meta(),
      checkout_id: checkoutId,
      checkout: {
        buyer: {
          name: "Alice Agent",
          email: "alice@example.com",
        },
        fulfillment: {
          type: "digital",
          option_id: "email-delivery",
        },
      },
    })
    log("2. update_checkout (buyer + fulfillment)", updated)

    // OBSERVATION: UCP combines buyer + fulfillment in a single update call.
    // ACP separates these into fulfillment_details + selected_fulfillment_options
    // as separate fields updated in one call, but semantically the same.
    // UCP's "extensions" pattern is cleaner for adding optional fields later.

    const finalTotal = updated.checkout.totals.find((t) => t.type === "final")
    console.log(`\nFinal total: $${((finalTotal?.amount.amount ?? 0) / 100).toFixed(2)} USD`)

    // ── Step 3: complete_checkout ────────────────────────────────────────────
    // Idempotency-key is REQUIRED for complete_checkout in UCP spec
    const completed = await callTool(client, "complete_checkout", {
      meta: meta(true), // includes idempotency-key
      checkout_id: checkoutId,
      payment: {
        instrument_id: "mock-card",
        credential_token: `tok_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      },
    })
    log("3. complete_checkout", completed)

    // OBSERVATION: UCP requires idempotency-key specifically for complete_checkout
    // and cancel_checkout (the "finalizing" actions), but not for create/get/update.
    // ACP requires it on ALL POST requests. UCP's approach is more targeted —
    // idempotency matters most where the action has financial consequences.

    // ── Summary ──────────────────────────────────────────────────────────────
    const order = completed.checkout.order
    console.log("\n" + "═".repeat(60))
    console.log("CHECKOUT COMPLETE (UCP / MCP)")
    console.log("═".repeat(60))
    console.log(`Order ID:    ${order?.id}`)
    console.log(`Total:       $${((order?.total.amount ?? 0) / 100).toFixed(2)} ${order?.total.currency.toUpperCase()}`)
    console.log(`Status:      ${order?.status}`)
    console.log(`Checkout:    ${checkoutId}`)
    console.log("\nSee OBSERVATIONS.md for implementation notes.")

  } finally {
    await client.close()
  }
}

runCheckout().catch((err) => {
  console.error("Agent failed:", err)
  process.exit(1)
})
