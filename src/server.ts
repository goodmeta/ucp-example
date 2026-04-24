// UCP Merchant Server — TicketShop (MCP transport)
// Implements the Universal Commerce Protocol (UCP) spec: v2026-04-08
// Spec: github.com/Universal-Commerce-Protocol/ucp
//
// Exposes 5 MCP tools:
//   create_checkout    — establish new session with items
//   get_checkout       — retrieve current checkout state
//   update_checkout    — add buyer info / fulfillment choice
//   complete_checkout  — finalize with payment credential
//   cancel_checkout    — terminate incomplete session
//
// Transport: stdio (connect via MCP client or Claude Code)
// Run: tsx src/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type {
  CheckoutObject,
  CheckoutItem,
  TotalLine,
  UCPToolResult,
  Price,
} from "./types.js"

const MERCHANT_ID = process.env.MERCHANT_ID ?? "ticketshop"
const UCP_VERSION = "2026-04-08" as const

// Product catalog
const CATALOG: Record<string, { title: string; unit_price: number; tax_rate: number }> = {
  "token2049-vip": {
    title: "TOKEN2049 Singapore VIP Pass",
    unit_price: 29900, // $299.00 in cents
    tax_rate: 0.09,    // 9% GST (Singapore)
  },
}

const FULFILLMENT_OPTIONS = [
  {
    id: "email-delivery",
    title: "Email Delivery (instant)",
    cost: { amount: 0, currency: "usd" } as Price,
    type: "digital" as const,
  },
  {
    id: "conference-pickup",
    title: "Pick up at TOKEN2049 venue",
    cost: { amount: 0, currency: "usd" } as Price,
    type: "pickup" as const,
  },
]

// In-memory session store
const sessions = new Map<string, CheckoutObject>()

function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

function price(amount: number): Price {
  return { amount, currency: "usd" }
}

function computeTotals(items: CheckoutItem[], fulfillmentCost: Price): TotalLine[] {
  const subtotal = items.reduce((s, i) => s + i.total_price.amount, 0)
  const taxAmount = items.reduce((s, i) => {
    const product = CATALOG[i.id]
    return s + Math.round(i.total_price.amount * (product?.tax_rate ?? 0))
  }, 0)
  const final = subtotal + taxAmount + fulfillmentCost.amount

  const totals: TotalLine[] = [
    { type: "subtotal", amount: price(subtotal) },
    { type: "tax", amount: price(taxAmount) },
  ]
  if (fulfillmentCost.amount > 0) {
    totals.push({ type: "shipping", amount: fulfillmentCost })
  }
  totals.push({ type: "final", amount: price(final) })
  return totals
}

function toResult(checkout: CheckoutObject): UCPToolResult {
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: {
        "dev.ucp.shopping": true,
        "dev.ucp.shopping.fulfillment": true,
        "dev.ucp.shopping.discount": false,
        "dev.ucp.shopping.ap2_mandate": false, // Phase 2
      },
    },
    checkout,
    continue_url: `https://ticketshop.example.com/checkout/${checkout.id}`,
  }
}

// Zod schemas for MCP tool inputs
const metaSchema = z.object({
  "ucp-agent": z.object({ profile: z.literal("dev.ucp.shopping") }),
  "idempotency-key": z.string().optional(),
})

const addressSchema = z.object({
  line_one: z.string(),
  line_two: z.string().optional(),
  city: z.string(),
  state: z.string(),
  country: z.string(),
  postal_code: z.string(),
})

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: `ucp-ticketshop`,
  version: "1.0.0",
})

// Tool: create_checkout
server.tool(
  "create_checkout",
  "Create a new UCP checkout session. Provide items with product IDs and quantities.",
  {
    meta: metaSchema,
    checkout: z.object({
      items: z.array(z.object({ id: z.string(), quantity: z.number().int().positive() })),
    }),
  },
  async ({ meta: _meta, checkout: body }) => {
    const items: CheckoutItem[] = []
    for (const req of body.items) {
      const product = CATALOG[req.id]
      if (!product) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown product: ${req.id}` }],
        }
      }
      const total = product.unit_price * req.quantity
      items.push({
        id: req.id,
        title: product.title,
        quantity: req.quantity,
        unit_price: price(product.unit_price),
        total_price: price(total),
      })
    }

    const checkout: CheckoutObject = {
      id: generateId("ck"),
      status: "cart",
      items,
      totals: computeTotals(items, price(0)),
      payment: {
        instruments: [],
        available_methods: [
          {
            id: "mock-card",
            type: "card",
            display: "Credit/Debit Card",
            requires_credential: true,
          },
        ],
      },
      messages: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    sessions.set(checkout.id, checkout)
    console.error(`[UCP] Checkout created: ${checkout.id}`)

    return {
      content: [{ type: "text", text: JSON.stringify(toResult(checkout), null, 2) }],
      structuredContent: toResult(checkout),
    }
  }
)

// Tool: get_checkout
server.tool(
  "get_checkout",
  "Retrieve the current state of a UCP checkout session.",
  {
    meta: metaSchema,
    checkout_id: z.string(),
  },
  async ({ checkout_id }) => {
    const checkout = sessions.get(checkout_id)
    if (!checkout) {
      return {
        isError: true,
        content: [{ type: "text", text: `Checkout not found: ${checkout_id}` }],
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(toResult(checkout), null, 2) }],
      structuredContent: toResult(checkout),
    }
  }
)

// Tool: update_checkout
server.tool(
  "update_checkout",
  "Update a checkout with buyer details and fulfillment selection.",
  {
    meta: metaSchema,
    checkout_id: z.string(),
    checkout: z.object({
      buyer: z
        .object({
          name: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().optional(),
        })
        .optional(),
      fulfillment: z
        .object({
          type: z.enum(["digital", "shipping"]),
          option_id: z.string(),
          address: addressSchema.optional(),
        })
        .optional(),
    }),
  },
  async ({ checkout_id, checkout: updates }) => {
    const checkout = sessions.get(checkout_id)
    if (!checkout) {
      return {
        isError: true,
        content: [{ type: "text", text: `Checkout not found: ${checkout_id}` }],
      }
    }

    if (checkout.status === "completed" || checkout.status === "canceled") {
      return {
        isError: true,
        content: [{ type: "text", text: `Cannot update checkout in status: ${checkout.status}` }],
      }
    }

    if (updates.buyer) {
      checkout.buyer = { ...checkout.buyer, ...updates.buyer }
    }

    if (updates.fulfillment) {
      const option = FULFILLMENT_OPTIONS.find((o) => o.id === updates.fulfillment!.option_id)
      if (!option) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown fulfillment option: ${updates.fulfillment.option_id}` }],
        }
      }
      checkout.fulfillment = {
        type: updates.fulfillment.type,
        address: updates.fulfillment.address,
        option_id: option.id,
        option_title: option.title,
        cost: option.cost,
      }
      checkout.totals = computeTotals(checkout.items, option.cost)
    }

    // Transition to "ready" if we have enough info
    if (checkout.buyer?.email && checkout.fulfillment) {
      checkout.status = "ready"
    }

    checkout.updated_at = new Date().toISOString()
    sessions.set(checkout_id, checkout)
    console.error(`[UCP] Checkout updated: ${checkout_id} → ${checkout.status}`)

    return {
      content: [{ type: "text", text: JSON.stringify(toResult(checkout), null, 2) }],
      structuredContent: toResult(checkout),
    }
  }
)

// Tool: complete_checkout
server.tool(
  "complete_checkout",
  "Finalize the checkout with a payment credential token. Idempotency-key required in meta.",
  {
    meta: metaSchema,
    checkout_id: z.string(),
    payment: z.object({
      instrument_id: z.string(),
      credential_token: z.string().optional(),
    }),
  },
  async ({ meta, checkout_id, payment }) => {
    if (!meta["idempotency-key"]) {
      return {
        isError: true,
        content: [{ type: "text", text: "idempotency-key required in meta for complete_checkout" }],
      }
    }

    const checkout = sessions.get(checkout_id)
    if (!checkout) {
      return {
        isError: true,
        content: [{ type: "text", text: `Checkout not found: ${checkout_id}` }],
      }
    }

    if (checkout.status !== "ready") {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Checkout not ready. Status: ${checkout.status}. Add buyer email and fulfillment first.`,
          },
        ],
      }
    }

    if (!payment.credential_token) {
      return {
        isError: true,
        content: [{ type: "text", text: "payment.credential_token required" }],
      }
    }

    const finalAmount = checkout.totals.find((t) => t.type === "final")?.amount ?? price(0)
    checkout.status = "completed"
    checkout.payment!.instruments = [
      {
        id: payment.instrument_id,
        type: "card",
        credential: { token: payment.credential_token },
        display: "Card ending in ****",
      },
    ]
    checkout.order = {
      id: generateId("ord"),
      created_at: new Date().toISOString(),
      status: "confirmed",
      total: finalAmount,
    }
    checkout.updated_at = new Date().toISOString()
    sessions.set(checkout_id, checkout)
    console.error(`[UCP] Checkout completed: ${checkout_id} → order ${checkout.order.id}`)

    return {
      content: [{ type: "text", text: JSON.stringify(toResult(checkout), null, 2) }],
      structuredContent: toResult(checkout),
    }
  }
)

// Tool: cancel_checkout
server.tool(
  "cancel_checkout",
  "Cancel an incomplete checkout session.",
  {
    meta: metaSchema,
    checkout_id: z.string(),
  },
  async ({ checkout_id }) => {
    const checkout = sessions.get(checkout_id)
    if (!checkout) {
      return {
        isError: true,
        content: [{ type: "text", text: `Checkout not found: ${checkout_id}` }],
      }
    }
    if (checkout.status === "completed") {
      return {
        isError: true,
        content: [{ type: "text", text: "Cannot cancel a completed checkout" }],
      }
    }
    checkout.status = "canceled"
    checkout.updated_at = new Date().toISOString()
    sessions.set(checkout_id, checkout)
    console.error(`[UCP] Checkout canceled: ${checkout_id}`)

    return {
      content: [{ type: "text", text: JSON.stringify(toResult(checkout), null, 2) }],
      structuredContent: toResult(checkout),
    }
  }
)

// Start stdio transport
const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[UCP] TicketShop MCP server running (stdio)`)
console.error(`[UCP] Merchant: ${MERCHANT_ID} | Tools: create_checkout, get_checkout, update_checkout, complete_checkout, cancel_checkout`)
