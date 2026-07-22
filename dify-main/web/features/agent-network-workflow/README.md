# Agent Network Workflow

Compiles AgentNetwork Python-like pseudocode in the browser or Next.js server and applies the generated graph to Dify's workflow canvas.

## Entry Points

Application code inside the workflow React tree can use:

```ts
function AgentNetworkCaller() {
  const { applyPseudocode } = useAgentNetworkWorkflow()
  return () => applyPseudocode(source, { saveDraft: true })
}
```

When a workflow editor is open, browser integrations and the developer console can use:

```ts
await window.difyAgentNetworkWorkflow.applyPseudocode(source, {
  saveDraft: true,
})
```

The bridge renders no UI. It only exposes the existing hook while the workflow editor is mounted.

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
- `python-syntax`
- `types`
- `use-agent-network-workflow`

## External Modules

- `app/components/workflow/collaboration/core/collaboration-manager`
- `app/components/workflow/hooks/use-workflow-update`
- `app/components/workflow/hooks-store/store`
- `app/components/workflow/store`
- `app/components/workflow/types`
