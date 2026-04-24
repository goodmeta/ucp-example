# UCP Implementation Observations

Protocol: Universal Commerce Protocol (UCP)  
Spec version: v2026-04-08  
Maintainers: Google + Shopify + community  
Built: 2026-04-22

This file logs what was discovered building a minimal UCP merchant MCP server + agent client from scratch. Updated during and after the build.

---

## 1. MCP as Transport Is the Most Interesting Design Choice in Any Protocol

UCP is the only commerce protocol with a native MCP transport binding. That means:
- An AI agent using Claude (or any MCP client) can check out via tool calls with zero adapter code
- The merchant exposes `create_checkout`, `update_checkout`, `complete_checkout` as MCP tools
- Claude can discover and call these tools just like any other MCP server

In this implementation, we ran the full checkout — create, update, complete — entirely via MCP tool calls. No HTTP client, no REST, no custom protocol handling. The agent just called tools.

**Why this matters:** x402 and ACP are REST protocols that require agents to speak HTTP with payment-specific headers. UCP over MCP means the checkout is natively visible to LLM agents as callable tools. Lower integration friction for the dominant agent runtime (Claude, GPT).

**The catch:** MCP is stateful (session-per-connection). UCP's in-memory session model is natural for stdio MCP but requires careful handling in multi-tenant HTTP deployments — same race condition we hit with intelligence-mcp (two machines, one session Map).

## 2. Status Naming: "cart" > "not_ready_for_payment"

UCP uses `"cart"` → `"ready"` → `"completed"` | `"canceled"`.  
ACP uses `"not_ready_for_payment"` → `"ready_for_payment"` → `"completed"` | `"canceled"`.

UCP's naming is cleaner. `"cart"` is a widely understood commerce concept. `"not_ready_for_payment"` is a double-negative that tells you what you don't have, not what you do.

Minor observation, but language matters in protocol design — agents and developers reading these status strings form different mental models.

## 3. Price Objects vs. Bare Integers

UCP: `{ "amount": 32591, "currency": "usd" }`  
ACP: `32591` (with currency implicit from session-level `currency` field)

UCP's approach is strictly better for multi-currency:
- Each price carries its own currency, so mixed-currency carts are representable
- No ambiguity about what currency a line item total is in
- More verbose, but verbose-and-correct beats terse-and-ambiguous

The tradeoff: UCP amounts require an extra object per price field. In a cart with 50 items, this adds noticeable payload size. For agent use cases (one item, high frequency), it's negligible.

## 4. Idempotency Is More Targeted in UCP

ACP: `Idempotency-Key` header required on **all** POST requests.  
UCP: `idempotency-key` in `meta` required only for `complete_checkout` and `cancel_checkout`.

UCP's approach is more principled. Idempotency matters where the action has financial consequences (completing, canceling). Create/update are naturally idempotent by design — retrying a `create_checkout` with the same items creates a new session (which is fine). Retrying a `complete_checkout` could double-charge, which is not fine.

This distinction makes idempotency a semantic choice, not a boilerplate requirement.

## 5. meta["ucp-agent"] Profile — Discovery or Enforcement?

Every UCP tool input requires:
```json
{
  "meta": {
    "ucp-agent": { "profile": "dev.ucp.shopping" }
  }
}
```

The spec doesn't clearly define what merchants should do if this field is missing or has an unsupported profile. In our implementation we validate it, but many implementations will ignore it.

**Purpose:** Capability negotiation before the checkout starts. If UCP adds a new profile (`dev.ucp.subscriptions`, `dev.ucp.auction`), the agent declares which profile it speaks. The merchant responds with what it supports.

**Gap:** Unlike ACP's explicit capability negotiation (where merchant responds with the intersection of supported features), UCP's `meta` check is a one-way declaration with no response contract. The merchant could just accept any profile string.

## 6. The Zod Dependency Is Implicit via MCP SDK

UCP server uses Zod for tool input validation, but Zod isn't in `package.json` — it's available as a transitive dependency of `@modelcontextprotocol/sdk`. This works now but is fragile: if the MCP SDK changes its Zod version or makes it a peer dependency, builds break silently.

For production: explicitly add `"zod": "..."` to `package.json`.

## 7. No Delegate Payment Endpoint

ACP has `POST /agentic_commerce/delegate_payment` — an explicit step where the agent tokenizes payment credentials with an Allowance before completing checkout.

UCP has no equivalent. Payment happens at `complete_checkout` with a `credential_token` already in hand. The spec doesn't define where that token comes from — it's assumed the agent has obtained it out-of-band (from the user's wallet, from a payment network, etc.).

This is both simpler and less safe:
- **Simpler:** Fewer round-trips, no Allowance negotiation
- **Less safe:** No protocol-level constraint on how much the token can authorize. The merchant can charge anything up to the token's limit without agent-visible enforcement.

**ACP's Allowance is stronger for budget enforcement.** UCP's model delegates enforcement to the payment provider, making it invisible to the protocol layer.

## 8. The Cross-Merchant Budget Gap (Core Observation)

Same structural gap as ACP, different mechanism.

An agent with a $500 budget buys via UCP at two merchants:

```
Agent budget: $500

Purchase 1: TOKEN2049 ticket via UCP (TicketShop MCP server)
  complete_checkout with credential_token=tok_ABC
  → Order confirmed: $325.91

Purchase 2: Anthropic API subscription via UCP (AnthropicShop MCP server)
  complete_checkout with credential_token=tok_DEF (same wallet, different token)
  → Order confirmed: $250.00

Total spent: $575.91
Budget: $500
Overflow: $75.91
```

Neither merchant knows about the other transaction. The `credential_token` is per-checkout, not budget-aware. The agent's wallet provider could enforce a budget, but UCP defines no protocol for the agent to communicate budget constraints to the wallet.

ACP has the Allowance's `max_amount` field, which at least bounds individual transactions. UCP has no equivalent.

**Neither protocol has cross-merchant budget tracking. Neither requires it. This is the gap.**

## 9. What UCP Does Well

- MCP transport — native to LLM agent runtimes
- Clean status naming
- Multi-currency price objects
- Transport-agnostic design (same checkout logic over REST, MCP, A2A)
- AP2 mandates extension (cryptographic proof of authorization, Phase 2)
- Extensions framework (discount, fulfillment, buyer_consent)

## 10. What UCP Doesn't Do

- Cross-merchant budget tracking (none)
- Delegate payment tokenization with spending constraints (no Allowance equivalent)
- Post-purchase (returns, refunds)
- Recurring/subscription authorization
- Real-time inventory

---

## Comparison: UCP vs ACP

| Dimension | UCP | ACP |
|-----------|-----|-----|
| Transport | MCP (native) + REST + A2A | REST only |
| Status model | cart → ready → completed | not_ready → ready_for_payment → completed |
| Price format | `{ amount, currency }` per field | bare integer, session-level currency |
| Idempotency | Only on finalizing actions | All POST requests |
| Payment auth | Credential token (opaque) | Allowance (scoped, amount-bounded) |
| Budget enforcement | None at protocol layer | max_amount per Allowance |
| Crypto-native | Not by default (AP2 extension) | No |
| Session model | MCP stateful per connection | REST stateless sessions |
| Multi-currency | Native (per-price objects) | Implicit (session-level field) |

## Comparison: UCP vs x402

| Dimension | UCP | x402 |
|-----------|-----|------|
| Session model | Stateful (create → update → complete) | Stateless (one request) |
| Use case | Commerce checkout (cart, items, fulfillment) | API access, micropayments |
| Transport | MCP / REST / A2A | HTTP (any) |
| Crypto payment | AP2 extension only | Native (ERC-20) |
| Agent integration | MCP tool calls | HTTP 402 → retry |
| Complexity | High (session, fulfillment, buyer, payment) | Low (one header) |

---

*Next: See CROSS_PROTOCOL.md for the budget gap scenario across all five protocols.*
