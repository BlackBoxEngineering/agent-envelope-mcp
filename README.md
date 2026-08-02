# agent-envelope-mcp

The neutral authority layer for agent runtimes, as an [MCP](https://modelcontextprotocol.io) server.

Any MCP client — Claude, an OpenAI agent, LangChain, CrewAI, a custom runtime —
can call these tools to **check and issue agent authority** without building its
own policy engine, audit log, or verification stack. AgentEnvelope is owned by
no framework, so every framework can embed it.

## Run

```bash
npx agent-envelope-mcp
```

It speaks MCP over stdio. No API key is needed to start, or to use the sovereign
verifier — only the vault-governed tools require `AE_API_KEY`.

## Wire it into an MCP client

Point your client at the command and pass the vault-issued key in the
environment (only needed for the custody tools):

```jsonc
{
  "mcpServers": {
    "agent-envelope": {
      "command": "npx",
      "args": ["-y", "agent-envelope-mcp"],
      "env": { "AE_API_KEY": "your-vault-issued-key" }
    }
  }
}
```

## Tools

| Tool | Mode | Credential |
|---|---|---|
| `ae_verify_sovereign` | Sovereign | none — offline, always free |
| `ae_get_agent` | Custody | `AE_API_KEY` |
| `ae_verify_action` | Custody | `AE_API_KEY` |
| `ae_mint` | Custody | `AE_API_KEY` |

- **`ae_verify_sovereign`** — verify a signed message against a known agent
  address. Pure crypto: no vault, no key, no network. Verification is always free.
- **`ae_get_agent`** — fetch the vault-registered public record for an agent id.
- **`ae_verify_action`** — verify a signed action against the vault-held record.
- **`ae_mint`** — mint a capability through the vault from a `MintDelegate` and a
  signed `MintRequest`, returning a mint receipt. This is a governed action.

The sovereign verifier needs no vault and no key. The vault-gated tools are the
governed surface a framework offloads rather than rebuilds.

## Programmatic use

```js
import { createServer } from 'agent-envelope-mcp';
// mount createServer() on your own MCP transport
```

## Environment

| Variable | Required for | Purpose |
|---|---|---|
| `AE_API_KEY` | `ae_get_agent`, `ae_verify_action`, `ae_mint` | Vault-issued API key |

The server is fail-closed: vault-gated tools return an error result when
`AE_API_KEY` is absent rather than exposing an unauthenticated surface.

## License

[Apache-2.0](LICENSE) — see [NOTICE](NOTICE) for attribution.
