# UCP Example

Minimal implementation of the [Universal Commerce Protocol (UCP)](https://github.com/Universal-Commerce-Protocol/ucp) — spec version v2026-04-08.

Built to understand UCP from the inside. Implements a merchant MCP server and an agent client that calls it via MCP tool calls.

## What's here

- `src/server.ts` — UCP merchant (TicketShop) as an MCP server, exposing 5 checkout tools
- `src/client.ts` — AI agent that connects via MCP stdio and buys a ticket
- `src/types.ts` — UCP types (CheckoutObject, Price, UCPMeta, etc.)
- `OBSERVATIONS.md` — What we learned implementing this from scratch

## Run it

```bash
npm install

# Run client (it spawns the server automatically via stdio)
npm run client

# Or run server standalone (connect via Claude Code or any MCP client)
npm run server
```

## Connect via Claude Code

Add to your Claude Code MCP config:
```json
{
  "mcpServers": {
    "ucp-ticketshop": {
      "command": "tsx",
      "args": ["/path/to/ucp-example/src/server.ts"]
    }
  }
}
```

Then ask Claude: *"Buy me a TOKEN2049 VIP pass from TicketShop."* Claude will call `create_checkout`, `update_checkout`, and `complete_checkout` as tool calls.

## Key observations

See [OBSERVATIONS.md](./OBSERVATIONS.md) for the full findings. The most important:

**MCP as transport is the most interesting design decision.** UCP is the only commerce protocol with a native MCP binding — an AI agent using Claude or any MCP client can check out via tool calls with zero adapter code. This is a meaningful advantage for LLM-native agent runtimes.

**The cross-merchant budget gap persists.** UCP has no Allowance equivalent. A credential token authorizes a checkout but doesn't enforce the agent's total budget across merchants. Neither ACP nor UCP solves this. Neither is designed to.

## Protocol

UCP supports REST, MCP, and A2A transports with the same checkout logic. This implementation covers MCP (stdio).

Compare with [acp-example](../acp-example/) for the REST transport version.
