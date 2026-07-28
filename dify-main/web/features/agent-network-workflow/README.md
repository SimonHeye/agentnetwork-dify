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

## AgentNetwork HTTP Contract

Planning uses `POST /service/plan_code`. Dify sends the user's task through the same-origin `/internal/agent-network/plan` proxy:

```json
{
  "task": "the user's original task"
}
```

The browser receives `{ "pseudocode": "..." }`, compiles it to `workflow.graph`, saves the draft, and renders it on the open canvas. The Chat panel then executes that generated pseudocode with the same user task and displays the returned final result below the Agent Network message. An execution failure leaves the generated and saved graph intact and is reported separately from planning or compilation failures.

Execution uses `POST /service/execute_code` through `/internal/agent-network/pseudocode`:

```json
{
  "task": "the task selected by the Dify execution task resolver",
  "code": "the latest pseudocode reverse-compiled from the canvas",
  "params": {},
  "need_task": false,
  "need_match": false,
  "include_agents": true
}
```

Chat-triggered execution uses the task from the current conversation turn. For the separate workflow-header Execute action, the resolver reuses the first successfully planned task for the app. `resolve-execute-task.ts` is the single extension point for changing that header-action policy later.

Successful execution keeps the raw `final_result` until the presentation boundary.
The result renderer unwraps `final_result.value` when present, displays strings
and numbers directly, renders HTTP(S) image URLs inline, and presents other
HTTP(S) file URLs with an in-panel preview dialog plus open/download actions.
Structured resources may also use `{ "url", "filename", "mime_type" }`.
Other structured values fall back to formatted JSON. The execution proxy accepts
minimal real-backend responses containing only `final_result` and normalizes
missing `context`, `trace`, and `calls`. Non-2xx plain-text responses from
AgentNetwork are surfaced to the user.

## Reverse Delivery

The workflow header opens a read-only preview containing generated pseudocode and compiler diagnostics. It intentionally has no clipboard or download action.

The Save action only saves the current Dify workflow draft. It never generates or sends pseudocode.

The separate Execute action is the delivery boundary for manually edited canvas workflows. It performs these operations in order:

1. Force-save the current Dify workflow draft.
1. Reverse-compile the latest canvas graph, including LLM `data.skills`, to pseudocode.
1. Post the pseudocode to the internal transport only after the draft save succeeds.

Opening the preview and saving the draft never send data. If reverse compilation reports an error during execution, the diagnostics window opens and no HTTP request is made.

Delivery uses two hops:

1. The browser posts the latest saved pseudocode to `/internal/agent-network/pseudocode` on the same Dify origin.
1. The Next.js server route validates the payload and forwards the official `task + code` request to `/service/execute_code`.

The receiver URL and token are server-only environment variables:

```text
AGENT_NETWORK_EXECUTE_URL=http://127.0.0.1:8787/service/execute_code
AGENT_NETWORK_EXECUTE_API_KEY=
AGENT_NETWORK_EXECUTE_TIMEOUT_MS=120000
```

The browser keeps Dify diagnostics and graph statistics locally; AgentNetwork receives only the fields defined by `/service/execute_code`.

For the standalone local planner and execution receiver, run from the repository root:

```powershell
node mock-agent-network-server.mjs
```

## Reverse Compiler Contracts

`graph-to-pseudocode.ts` classifies every `BlockEnum` value. The full enum is
larger than the ordinary Workflow node menu because it also contains dynamic
plugin nodes, knowledge-pipeline nodes, feature-gated nodes, legacy data, and
internal container helpers.

| Category            | Dify node types                                                                                                           | Pseudocode contract                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Entry               | User Input, Schedule Trigger, Webhook Trigger, Plugin Trigger, DataSource                                                 | Injected input namespace or a typed trigger/data-source call                                                                 |
| Model and retrieval | LLM, Knowledge Retrieval, Agent, Agent V2                                                                                 | `LLM`, selected `*Group`, `KnowledgeRetrieval`, `Agent`, or `AgentV2` assignment                                             |
| Transformation      | Code, Template Transform, HTTP Request, Tool, Parameter Extractor, Document Extractor, List Operator, Variable Aggregator | Typed assignment with selectors and node configuration                                                                       |
| Control             | If/Else, Question Classifier, Human Input                                                                                 | Python `if`/`elif`/`else` branches                                                                                           |
| Containers          | Iteration, Loop                                                                                                           | Iteration is always `for ... in enumerate(...)`; Loop is always bounded `for ... in range(loop_count)` with optional `break` |
| Mutation            | Variable Assigner                                                                                                         | Assignment, append/extend, arithmetic update, clear, or remove operation                                                     |
| Output              | Answer, End, KnowledgeBase                                                                                                | `reply(...)`, `final_result = value/dict`, or knowledge-index result                                                         |
| Internal            | Start Placeholder, DataSource Empty, Iteration Start, Loop Start, Loop End                                                | Structural only; container starts provide aliases and Loop End emits `break`                                                 |

Skills have one owner: only an LLM node's `data.skills` becomes
`skills=[...]`. Tool nodes are standalone calls. Native Agent and Agent V2
nodes preserve `agent_parameters` or `agent_binding`; those fields are not
reinterpreted as skills.

An LLM is emitted as an Agent Network group only when
`data.agent_network_group` contains a valid Python function name ending in
`Group`. Otherwise it is emitted as native `LLM(...)`. This keeps future group
names round-trippable without misclassifying ordinary Dify LLM nodes.

Configured `*Group` calls follow AgentNetwork scalar semantics. Dify selectors for a Group's `text` or `structured_output` are emitted as the assigned scalar variable, so a branch is written as `if kind == "calc":` rather than `if kind.get("kind") == "calc":`.

Generated executable pseudocode follows the AgentNetwork restrictions:

- Group calls use keyword arguments and describe work through `task`.
- Branches use assignments, comparisons, f-strings, and `if`/`elif`/`else`.
- Iteration and Loop export as bounded `for` statements. Parallel Dify Iteration is serialized and produces a `PARALLEL_ITERATION_SERIALIZED` diagnostic because AgentNetwork forbids `def`.
- The generator emits no `import`, `def`, or `class`, and terminal output is assigned to `final_result`.

The plan-to-canvas compiler closes the canonical round trip for the structural
nodes used by this integration:

- selected `*Group(...)` calls become configured LLM nodes;
- `CodeExecution(...)` becomes a Code node and preserves named outputs;
- `if`/`elif`/`else` becomes If/Else;
- `reply(...)` becomes Answer and `final_result` becomes End;
- `for index, item in enumerate(value)` plus a final accumulator `append`
  becomes Iteration;
- `for index in range(count)` plus an optional final `if ...: break` becomes
  a bounded Loop;
- incoming `while condition` becomes a Loop with the inverse break condition
  and emits a bounded-conversion warning. A terminal `break` maps to one
  iteration; otherwise the safety limit is 100 iterations.

The Iteration and Loop forms emitted by the reverse compiler are covered by
Graph-to-pseudocode-to-Graph tests. Arbitrary Python loop iterators and loop
bodies that cannot be represented by Dify selectors remain explicit errors.

End keeps the Agent Network top-level output convention:

- one output: `final_result = expression`
- multiple outputs: `final_result = {"name": expression, ...}`

## Legacy Inbound HTTP Demo

The web service exposes a demo endpoint that compiles pseudocode on the Next.js server and queues the resulting graph for an open workflow editor. The editor polls for compiled graphs and applies them directly through `useAgentNetworkWorkflow`; this path does not use the browser `window` bridge.

1. Start the web service and open the target workflow editor in the browser.
1. Copy the app id from the workflow URL.
1. Send this request from Apifox:

```http
POST http://localhost:3000/agent-network/pseudocode
Content-Type: application/json
Authorization: Bearer <AGENT_NETWORK_API_KEY>
```

```json
{
  "app_id": "replace-with-the-open-app-id",
  "source": "kind = ReasoningGroup(task=task)\nif kind == \"calc\":\n    answer = CalculatorGroup(task=task)\nelse:\n    answer = SearchGroup(task=task)\nfinal_result = answer",
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
- `command-client`
- `command-consumer`
- `command-store`
- `constants`
- `execution-result`
- `execution-result-model`
- `graph-to-pseudocode`
- `reverse-compiler`
- `run-generated-workflow`
- `python-syntax`
- `types`
- `use-agent-network-workflow`

## External Modules

- `app/components/workflow/collaboration/core/collaboration-manager`
- `app/components/workflow/hooks/use-workflow-update`
- `app/components/workflow/hooks-store/store`
- `app/components/workflow/store`
- `app/components/workflow/types`
