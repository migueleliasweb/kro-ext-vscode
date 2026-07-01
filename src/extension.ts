import * as vscode from 'vscode';
import { parseKroDocument } from './parser';
import { KroVisualizerPanel } from './visualizer/panel';
import { KroCompletionItemProvider } from './completion';

class KroDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    const parsed = parseKroDocument(document);
    return parsed.symbols;
  }
}

class KroDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition> {
    const parsed = parseKroDocument(document);
    for (const ref of parsed.references) {
      if (ref.range.contains(position)) {
        const def = parsed.resourceDefs.get(ref.resourceId);
        if (def) {
          // If the reference specifies a property path (e.g. "metadata.namespace")
          // and that property is explicitly defined in the target resource's template,
          // jump directly to that property's line!
          if (ref.propertyPath && def.propertyRanges.has(ref.propertyPath)) {
            const propRange = def.propertyRanges.get(ref.propertyPath);
            if (propRange) {
              return new vscode.Location(document.uri, propRange);
            }
          }
          // Otherwise, fall back to the resource ID definition
          return new vscode.Location(document.uri, def.idRange);
        }
      }
    }
    return null;
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('KRO Support extension is now active!');

  const documentSelector = [
    { language: 'yaml' },
    { language: 'kro-rgd' }
  ];

  // Register Document Symbol Provider
  const symbolProvider = vscode.languages.registerDocumentSymbolProvider(
    documentSelector,
    new KroDocumentSymbolProvider()
  );
  context.subscriptions.push(symbolProvider);

  // Register Definition Provider (Cmd+Click / Go to Definition)
  const definitionProvider = vscode.languages.registerDefinitionProvider(
    documentSelector,
    new KroDefinitionProvider()
  );
  context.subscriptions.push(definitionProvider);

  // Register Autocomplete/Completion Item Provider
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    documentSelector,
    new KroCompletionItemProvider(),
    '$',
    '.'
  );
  context.subscriptions.push(completionProvider);

  // Command: Create New ResourceGraphDefinition Template
  const createTemplateCmd = vscode.commands.registerCommand('kro.createTemplate', async () => {
    const boilerplate = [
      'apiVersion: kro.run/v1alpha1',
      'kind: ResourceGraphDefinition',
      'metadata:',
      '  name: my-app',
      'spec:',
      '  schema:',
      '    apiVersion: v1alpha1',
      '    kind: MyAppStack',
      '    spec:',
      '      properties:',
      '        replicas:',
      '          type: integer',
      '          default: 1',
      '  resources:',
      '    - id: my-deployment',
      '      template:',
      '        apiVersion: apps/v1',
      '        kind: Deployment',
      '        metadata:',
      '          name: ${schema.metadata.name}',
      '        spec:',
      '          replicas: ${schema.spec.replicas}',
      '          selector:',
      '            matchLabels:',
      '              app: ${schema.metadata.name}',
      '          template:',
      '            metadata:',
      '              labels:',
      '                app: ${schema.metadata.name}',
      '            spec:',
      '              containers:',
      '                - name: app',
      '                  image: nginx:latest',
      ''
    ].join('\n');

    try {
      const doc = await vscode.workspace.openTextDocument({
        language: 'kro-rgd',
        content: boilerplate
      });
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to create template: ${err}`);
    }
  });
  context.subscriptions.push(createTemplateCmd);

  // Command: Visualize KRO Resource Graph
  const visualizeCmd = vscode.commands.registerCommand('kro.visualize', () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && (editor.document.languageId === 'yaml' || editor.document.languageId === 'kro-rgd')) {
      KroVisualizerPanel.createOrShow(context.extensionUri, editor);
    } else {
      vscode.window.showErrorMessage('Please open a KRO ResourceGraphDefinition YAML file to visualize.');
    }
  });
  context.subscriptions.push(visualizeCmd);
}

export function deactivate() {}
