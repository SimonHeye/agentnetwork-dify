# Agent Network Workflow

Provides both directions of the Dify and Agent Network workflow integration:

- Agent Network pseudocode to a Dify workflow canvas through the browser or Next.js server.
- The current Dify canvas to canonical pseudocode, followed by server-side HTTP delivery to Agent Network.

## Entry Points

Application code inside the workflow React tree can use:

```ts
function AgentNetworkCaller() {
  const { applyPseudocode } = useAgentNetworkWorkflow()
  return () => applyPseudocode(source, { saveDraft: true })
}
```

The app sidebar Chat entry renders the same `WorkflowApp` and opens the Agent Network conversation panel inside the workflow React tree. It calls `applyPseudocode` directly and does not expose a browser `window` API.

## Reverse Delivery

The workflow header opens a read-only preview containing generated pseudocode and compiler diagnostics. It intentionally has no clipboard or download action.

The Save action only saves the current Dify workflow draft. It never generates or sends pseudocode.

The separate Execute action is the delivery boundary. It performs these operations in order:

1. Force-save the current Dify workflow draft.
1. Reverse-compile the latest canvas graph, including LLM `data.skills`, to pseudocode.
1. Post the pseudocode to the internal transport only after the draft save succeeds.

Opening the preview and saving the draft never send data. If reverse compilation reports an error during execution, the diagnostics window opens and no HTTP request is made.

Delivery uses two hops:

1. The browser posts the latest saved pseudocode to `/internal/agent-network/pseudocode` on the same Dify origin.
1. The Next.js server route validates the payload and forwards a versioned event to the configured Agent Network receiver.

The receiver URL and token are server-only environment variables:

```text
AGENT_NETWORK_PSEUDOCODE_URL=http://127.0.0.1:8787/pseudocode
AGENT_NETWORK_PSEUDOCODE_API_KEY=local-test-token
AGENT_NETWORK_PSEUDOCODE_TIMEOUT_MS=10000
```

The outbound body is JSON with `schema_version`, `event`, `delivery_id`, `sent_at`, `app`, `pseudocode`, `diagnostics`, and `stats`. The current contract version is `1.0`, and the event name is `dify.workflow.pseudocode.generated`.

For the standalone local planner and execution receiver, run from the repository root:

```powershell
node mock-agent-network-server.mjs
```

## HTTP Demo

The web service exposes a demo endpoint that compiles pseudocode on the Next.js server and queues the resulting graph for an open workflow editor. The editor polls for compiled graphs and applies them directly through `useAgentNetworkWorkflow`; this path does not use the browser `window` bridge.

1. Start the web service and open the target workflow editor in the browser.
2. Copy the app id from the workflow URL.
3. Send this request from Apifox:

```http
POST http://localhost:3000/agent-network/pseudocode
Content-Type: application/json
Authorization: Bearer <AGENT_NETWORK_API_KEY>
```

```json
{
  "app_id": "replace-with-the-open-app-id",
  "source": "probe = ReasoningGroup(task=task)\nif probe.get(\"kind\") == \"calc\":\n    answer = CalculatorGroup(task=task)\nelse:\n    answer = SearchGroup(task=task)\nfinal_result = answer",
  "preserve_positions": true,
  "save_draft": true
}
```

`Authorization` is optional in development when `AGENT_NETWORK_API_KEY` is unset. Production requires `AGENT_NETWORK_API_KEY` on the web service. A successful request returns `202` with a `command_id`; the open editor normally renders the graph within one second.

Query the browser processing result with:

```http
GET http://localhost:3000/agent-network/pseudocode?command_id=<command_id>
```

The command store is intentionally process-local for this demo and expires commands after ten minutes. A multi-instance deployment must replace `command-store.ts` with Redis or another shared store before production use.

All generated Group nodes share one model unless `model` or a group override is supplied. The browser entry uses the current Dify LLM default when available and otherwise falls back to:

```ts
const DEFAULT_MODEL = {
  provider: 'langgenius/deepseek/deepseek',
  name: 'deepseek-chat',
  mode: 'chat',
  completion_params: {},
}
```

## Internal Modules

- `compiler`
- `compiler-helpers`
- `bridge`
- `command-client`
- `command-consumer`
- `command-store`
- `constants`
- `reverse-compiler`
- `send-pseudocode`
- `python-syntax`
- `types`
- `use-agent-network-workflow`

## External Modules

- `app/components/workflow/collaboration/core/collaboration-manager`
- `app/components/workflow/hooks/use-workflow-update`
- `app/components/workflow/hooks-store/store`
- `app/components/workflow/store`
- `app/components/workflow/types`
