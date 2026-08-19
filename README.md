# agent-envelope-mcp

The neutral authority layer for action-performing systems, as an [MCP](https://modelcontextprotocol.io) server.

Any MCP client — Claude, an OpenAI agent, LangChain, CrewAI, a custom runtime —
can call these tools to **check delegated action authority** without
building its own verification stack. AgentEnvelope
is owned by no framework, so every framework can embed it.

An AgentEnvelope "agent" is a bounded action identity: a named actor, operation,
resources, decay policy, and verifiable address. That actor can be an AI agent,
backend worker, workflow step, service, device command, access grant, order, or
instruction.

## Run

```bash
npx agent-envelope-mcp
```

It speaks MCP over stdio. No API key is needed to start, or to use sovereign
signature/record verification — only the hosted-governance tools require `AE_API_KEY`.

## Wire it into an MCP client

Point your client at the command and pass the portal-issued API key in the
environment (only needed for hosted-governance tools):

```jsonc
{
  "mcpServers": {
    "agent-envelope": {
      "command": "npx",
      "args": ["-y", "agent-envelope-mcp"],
      "env": { "AE_API_KEY": "your-portal-issued-api-key" }
    }
  }
}
```

## Tools

| Tool | Mode | Credential |
|---|---|---|
| `ae_verify_sovereign` | Sovereign signature check | none — offline, always free |
| `ae_verify_sovereign_record` | Sovereign public-record check | none — offline, always free |
| `ae_get_agent` | Hosted governance | `AE_API_KEY` |
| `ae_verify_action` | Hosted governance | `AE_API_KEY` |
| `ae_mint` | Hosted governance | `AE_API_KEY` |

- **`ae_verify_sovereign`** — verify a signed message against a known agent
  address. Pure crypto: no vault, no key, no network. This is a signature-only
  check; it does not check action-envelope scope, expiry, usage limits, or hosted
  record status.
- **`ae_verify_sovereign_record`** — verify a signed action against a public
  action record. Checks record status, action index, signature/address match,
  optional expected envelope hash, and time decay without a network call.
- **`ae_get_agent`** — fetch the hosted public record for an agent id.
- **`ae_verify_action`** — verify a signed action against the hosted public record.
- **`ae_mint`** — verify a `MintDelegate` and signed `MintRequest` through hosted
  governance, returning a mint receipt. It does not return private capability
  material. This is a governed action.

The sovereign verifier needs no account and no key. The hosted-governance tools
are the governed surface a framework offloads rather than rebuilds. API keys
meter and protect hosted service routes; signatures prove authority.

## Programmatic use

```js
import { createServer } from 'agent-envelope-mcp';
// mount createServer() on your own MCP transport
```

## Environment

| Variable | Required for | Purpose |
|---|---|---|
| `AE_API_KEY` | `ae_get_agent`, `ae_verify_action`, `ae_mint` | Portal-issued API key for hosted governance |

The server is fail-closed: hosted-governance tools return an error result when
`AE_API_KEY` is absent rather than exposing an unauthenticated surface.

## License

[Apache-2.0](LICENSE) — see [NOTICE](NOTICE) for attribution.
