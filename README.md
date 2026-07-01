# KRO Support - VS Code Extension

Rich autocompletion, schema validation, outline navigation, Go to Definition, and resource dependency graph visualization for **KRO (Kube Resource Orchestrator)** manifests.

---

## Features

### 1. Schema Validation & Autocompletion
- **Draft-07 JSON Schema Validation**: Auto-associates with `.rgd.yaml`, `.rgd.yml`, `*-rgd.yaml`, and `*-rgd.yml` files. Ensures manifest structure matches KRO CRD specifications.
- **Scaffolding Snippets**: Injects templates for creating new `ResourceGraphDefinition` specs and resource template entries.

### 2. Context-Aware CEL Autocompletion (`$` / `.`)
- **Root-Level Suggestions**: Auto-activates when typing `${` or starting a CEL expression. Suggests `schema`, KRO library namespaces (`hash`, `json`, `lists`, `random`, `cel`), and all declared resource IDs.
- **Dynamic Schema Auto-resolution**: Dynamically suggests input properties under `schema.spec.*` and output properties under `schema.status.*` defined in the file.
- **Nested Resource Properties**: Suggests template paths (e.g. `deployment.metadata`, `deployment.spec`) recursively.
- **CEL Function Library Snippets**: Injects KRO custom library method signatures with tab-stop arguments:
  - `hash.fnv64a(string)`, `hash.sha256(string)`, `hash.md5(string)`
  - `json.unmarshal(string)`, `json.marshal(value)`
  - `lists.setAtIndex(list, index, value)`, `lists.insertAtIndex(list, index, value)`, `lists.removeAtIndex(list, index)`
  - `random.seededString(length, seed)`, `random.seededInt(min, max, seed)`
  - `cel.bind(varName, init, body)`

### 3. Editor Go to Definition (`Cmd+Click` / `F12`)
- **Deep Property Redirection**: Command-clicking on any property in a CEL reference (like `${deployment.metadata.namespace}`) takes the editor cursor directly to the line where `namespace: ...` is defined inside `deployment`'s template!
- **Schema Navigation**: Support for schema references (such as `${schema.spec.replicas}`). Resolves directly to the definition key under the schema interface.
- **Fallback Resolution**: Unmatched properties fall back to the resource ID definition (`id: deployment`).

### 4. Interactive Resource Graph Visualizer
- **Webview Panel**: Renders a dark-themed visualizer panel side-by-side with your editor.
- **Real-Time Synchronisation**: Automatically redrafts the graph as you type in the text editor.
- **Hierarchical Tree Layouts**:
  - **Top-Down Layout** (Default): RGD root is centered at the top, and resources cascade downward.
  - **Left-Right Layout**: Flowcharts resource composition starting from the left.
  - **Free Physics Layout**: Toggles dynamic force-directed physics.
  - Switch styles dynamically with a glassmorphic selector menu.
- **Composition Graph Chaining**: Supports multi-document YAML files. Connects RGD root nodes (named after the RGD itself) only to the resources directly defined by them.
- **Canvas-to-Editor Navigation**: Command-clicking a resource node or RGD root node in the Visualizer centers the editor directly on its definition line.

### 5. Document Symbol Outline (`Cmd+Shift+O` / `Ctrl+Shift+O`)
- Compiles the YAML AST to show a structured list of symbols:
  - Custom API schema kind (e.g. `Schema: WebApp`).
  - Resources list detailing resource IDs and kinds (e.g. `deployment (Deployment)`).

---

## Usage

1. Open any `.rgd.yaml` or `.rgd.yml` KRO manifest.
2. Press `Cmd+Shift+P` (or `Ctrl+Shift+P` on Windows/Linux) to open the Command Palette.
3. Search and select:
   - `KRO: Visualize Resource Graph`: Opens the visual dependency diagram.
   - `KRO: Create New ResourceGraphDefinition`: Scaffolds a boilerplate manifest.
