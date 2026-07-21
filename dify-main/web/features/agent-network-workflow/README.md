# Agent Network Workflow

Compiles AgentNetwork Python-like pseudocode directly in the browser and applies the generated graph to Dify's workflow canvas.

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
- `python-syntax`
- `types`
- `use-agent-network-workflow`

## External Modules

- `app/components/workflow/collaboration/core/collaboration-manager`
- `app/components/workflow/hooks/use-workflow-update`
- `app/components/workflow/hooks-store/store`
- `app/components/workflow/store`
- `app/components/workflow/types`
