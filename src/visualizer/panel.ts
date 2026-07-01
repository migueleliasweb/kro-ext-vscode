import * as vscode from 'vscode';
import * as path from 'path';
import { parseKroDocument, KroParsedDocument } from '../parser';

export class KroVisualizerPanel {
  public static currentPanel: KroVisualizerPanel | undefined;
  public static readonly viewType = 'kroVisualizer';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private _activeEditor: vscode.TextEditor | undefined;

  public static createOrShow(extensionUri: vscode.Uri, editor: vscode.TextEditor) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it in the target column
    if (KroVisualizerPanel.currentPanel) {
      KroVisualizerPanel.currentPanel._activeEditor = editor;
      KroVisualizerPanel.currentPanel._panel.reveal(column ? column + 1 : vscode.ViewColumn.Two);
      KroVisualizerPanel.currentPanel.updateGraph();
      return;
    }

    // Otherwise, create a new panel
    const targetColumn = column ? column + 1 : vscode.ViewColumn.Two;
    const panel = vscode.window.createWebviewPanel(
      KroVisualizerPanel.viewType,
      'KRO Resource Graph',
      targetColumn,
      {
        enableScripts: true,
        // Restrict the webview to only loading content from our extension's src/visualizer/media directory
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, 'src', 'visualizer', 'media')
        ],
        retainContextWhenHidden: true
      }
    );

    KroVisualizerPanel.currentPanel = new KroVisualizerPanel(panel, extensionUri, editor);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, editor: vscode.TextEditor) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._activeEditor = editor;

    // Set the webview's initial html content
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Listen for when the panel is disposed (user closes it)
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Update the content based on context changes
    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          this.updateGraph();
        }
      },
      null,
      this._disposables
    );

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'ready':
            this.updateGraph();
            break;
          case 'jumpToResource':
            this._handleJumpToResource(message.resourceId);
            break;
        }
      },
      null,
      this._disposables
    );

    // Listen for text document changes in the active editor
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        if (this._activeEditor && e.document === this._activeEditor.document) {
          this.updateGraph();
        }
      },
      null,
      this._disposables
    );

    // Listen for when the active editor changes
    vscode.window.onDidChangeActiveTextEditor(
      (e) => {
        if (e && e.document.languageId === 'yaml') {
          // If kind is KRO ResourceGraphDefinition, track it
          const parsed = parseKroDocument(e.document);
          if (parsed.symbols.length > 0) {
            this._activeEditor = e;
            this.updateGraph();
          }
        }
      },
      null,
      this._disposables
    );
  }

  public updateGraph() {
    if (!this._activeEditor) {
      return;
    }

    const parsed = parseKroDocument(this._activeEditor.document);
    
    // Prepare Vis-Network node and edge payloads
    const nodes: any[] = [];
    const edges: any[] = [];

    // Add Root RGD Nodes (one for each parsed RGD in the file)
    const rgdNames = parsed.symbols.map(s => s.name);
    for (const rgdName of rgdNames) {
      const rgdId = rgdName;
      nodes.push({
        id: rgdId,
        label: rgdName,
        kind: 'ResourceGraphDefinition',
        title: `ResourceGraphDefinition: ${rgdName}`
      });
    }

    // Extract nodes from resource definitions and link only to their parent RGD roots
    for (const [id, def] of parsed.resourceDefs.entries()) {
      if (id === 'schema') {
        continue;
      }
      nodes.push({
        id: id,
        label: id,
        kind: def.kind,
        title: `${def.kind}: ${id}`
      });

      // Edge from its specific parent RGD root to this resource (dashed)
      const parentRgdId = def.parentRgdName;
      edges.push({
        from: parentRgdId,
        to: id,
        arrows: 'to',
        dashes: true,
        color: { color: 'rgba(255, 255, 255, 0.12)' }
      });
    }

    // Extract edges from parsed references
    for (const ref of parsed.references) {
      if (ref.resourceId === 'schema') {
        continue;
      }
      // Find which resource definition contains this reference
      let sourceId: string | undefined;
      for (const [id, def] of parsed.resourceDefs.entries()) {
        const line = ref.range.start.line;
        if (line >= def.fullRange.start.line && line <= def.fullRange.end.line) {
          sourceId = id;
          break;
        }
      }

      // If reference is inside a resource, and points to another resource, add edge
      // Avoid self-references or duplicate edges
      if (sourceId && sourceId !== ref.resourceId) {
        const edgeExists = edges.some(e => e.from === ref.resourceId && e.to === sourceId);
        if (!edgeExists) {
          edges.push({
            from: ref.resourceId,
            to: sourceId,
            arrows: 'to'
          });
        }
      }
    }

    // Send payload to Webview
    this._panel.webview.postMessage({
      type: 'update',
      nodes: nodes,
      edges: edges,
      fileName: path.basename(this._activeEditor.document.fileName)
    });
  }

  private _handleJumpToResource(resourceId: string) {
    if (!this._activeEditor) {
      return;
    }

    const parsed = parseKroDocument(this._activeEditor.document);

    // Check if the clicked node is one of the RGD root nodes
    const rgdSym = parsed.symbols.find(s => s.name === resourceId);
    if (rgdSym) {
      vscode.window.showTextDocument(this._activeEditor.document, this._activeEditor.viewColumn).then(editor => {
        editor.selection = new vscode.Selection(rgdSym.range.start, rgdSym.range.start);
        editor.revealRange(rgdSym.range, vscode.TextEditorRevealType.InCenter);
      });
      return;
    }

    const def = parsed.resourceDefs.get(resourceId);

    if (def) {
      // Focus the text editor
      vscode.window.showTextDocument(this._activeEditor.document, this._activeEditor.viewColumn).then(editor => {
        // Move selection to resource ID range and reveal it
        editor.selection = new vscode.Selection(def.idRange.start, def.idRange.end);
        editor.revealRange(def.idRange, vscode.TextEditorRevealType.InCenter);
      });
    }
  }

  public dispose() {
    KroVisualizerPanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Get paths to local resources on disk
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'visualizer', 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'visualizer', 'media', 'main.css')
    );

    // Use a nonce to restrict the scripts that can run in the webview
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- Content Security Policy -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}' https://unpkg.com/ ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource} https://fonts.googleapis.com/; font-src https://fonts.gstatic.com/;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KRO Resource Graph</title>
  
  <!-- Inter Font -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  
  <!-- Vis-Network CSS CDN -->
  <link rel="stylesheet" href="https://unpkg.com/vis-network/styles/vis-network.min.css" />
  
  <!-- Local Styles -->
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <!-- Vis-Network Container -->
  <div id="network-container"></div>

  <!-- Glassmorphic Details Overlay Panel -->
  <div id="details-panel" class="details-panel hidden">
    <div class="panel-header">
      <h3 id="panel-title">Resource Details</h3>
      <button id="close-panel-btn" class="close-btn">&times;</button>
    </div>
    <div class="panel-body">
      <div class="detail-row">
        <span class="label">ID:</span>
        <span id="detail-id" class="value code"></span>
      </div>
      <div class="detail-row">
        <span class="label">Kind:</span>
        <span id="detail-kind" class="value badge"></span>
      </div>
      <div class="detail-row info-row">
        <span class="info-text">💡 Hold <b>Cmd</b> (or <b>Ctrl</b>) and click node to jump to definition in the editor.</span>
      </div>
    </div>
  </div>

  <!-- Header Info Panel -->
  <div id="header-panel">
    <div class="file-info">
      <span class="icon">📊</span>
      <span id="active-filename">loading...</span>
    </div>
    <div class="graph-actions">
      <select id="layout-select" title="Change Graph Layout">
        <option value="hierarchical-ud">Layout: Top-Down</option>
        <option value="hierarchical-lr">Layout: Left-Right</option>
        <option value="free">Layout: Free (Physics)</option>
      </select>
      <button id="fit-btn" title="Fit Entire Graph">⛶ Fit</button>
    </div>
  </div>

  <!-- Vis-Network JS Library -->
  <script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>

  <!-- Local Script -->
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
