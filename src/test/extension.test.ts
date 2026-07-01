import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseKroDocument } from '../parser';
import { KroCompletionItemProvider } from '../completion';

// Minimal mock for vscode.TextDocument
class MockTextDocument {
  constructor(public content: string) {}
  
  getText(): string {
    return this.content;
  }

  positionAt(offset: number): vscode.Position {
    const before = this.content.substring(0, offset);
    const lines = before.split('\n');
    const line = lines.length - 1;
    const character = lines[line].length;
    return new vscode.Position(line, character);
  }

  lineAt(line: number) {
    const lines = this.content.split('\n');
    return {
      text: lines[line] || ''
    };
  }
}

suite('KRO Parser Test Suite', () => {
  test('Parses ResourceGraphDefinition schema, resources, symbols, and references correctly', () => {
    const sampleYaml = [
      'apiVersion: kro.run/v1alpha1',
      'kind: ResourceGraphDefinition',
      'metadata:',
      '  name: test-app',
      'spec:',
      '  schema:',
      '    apiVersion: v1alpha1',
      '    kind: TestApp',
      '    spec:',
      '      properties:',
      '        replicas:',
      '          type: integer',
      '  resources:',
      '    - id: my-service',
      '      template:',
      '        apiVersion: v1',
      '        kind: Service',
      '        metadata:',
      '          name: ${schema.metadata.name}',
      '    - id: my-deployment',
      '      template:',
      '        apiVersion: apps/v1',
      '        kind: Deployment',
      '        metadata:',
      '          name: ${schema.metadata.name}-deploy',
      '        spec:',
      '          replicas: ${schema.spec.replicas}',
      '          selector:',
      '            matchLabels:',
      '              app: ${my-service.metadata.name}',
      '      readyWhen:',
      '        - my-service.status.active == true',
      ''
    ].join('\n');

    const doc = new MockTextDocument(sampleYaml) as unknown as vscode.TextDocument;
    const parsed = parseKroDocument(doc);

    // 1. Verify resources are extracted
    assert.strictEqual(parsed.resourceDefs.size, 3);
    assert.ok(parsed.resourceDefs.has('schema'));
    const serviceDef = parsed.resourceDefs.get('my-service');
    assert.ok(serviceDef);
    assert.strictEqual(serviceDef.id, 'my-service');
    assert.strictEqual(serviceDef.kind, 'Service');
    assert.strictEqual(serviceDef.parentRgdName, 'test-app');

    const deploymentDef = parsed.resourceDefs.get('my-deployment');
    assert.ok(deploymentDef);
    assert.strictEqual(deploymentDef.id, 'my-deployment');
    assert.strictEqual(deploymentDef.kind, 'Deployment');
    assert.strictEqual(deploymentDef.parentRgdName, 'test-app');

    // 2. Verify symbols are generated
    assert.strictEqual(parsed.symbols.length, 1);
    const rootSymbol = parsed.symbols[0];
    assert.strictEqual(rootSymbol.name, 'test-app');
    assert.strictEqual(rootSymbol.kind, vscode.SymbolKind.Class);
    
    // Verify children (Schema and resources)
    assert.strictEqual(rootSymbol.children.length, 2);
    const schemaSym = rootSymbol.children[0];
    assert.strictEqual(schemaSym.name, 'Schema: TestApp');
    
    const resourcesSym = rootSymbol.children[1];
    assert.strictEqual(resourcesSym.name, 'resources');
    assert.strictEqual(resourcesSym.children.length, 2);
    assert.strictEqual(resourcesSym.children[0].name, 'my-service');
    assert.strictEqual(resourcesSym.children[1].name, 'my-deployment');

    // Verify children of schema (spec -> properties -> replicas)
    assert.ok(schemaSym.children.length > 0);
    const schemaSpecChild = schemaSym.children.find(c => c.name === 'spec');
    assert.ok(schemaSpecChild);
    const propertiesChild = schemaSpecChild.children.find(c => c.name === 'properties');
    assert.ok(propertiesChild);
    assert.ok(propertiesChild.children.some(c => c.name === 'replicas'));

    // Verify children of my-deployment (template -> metadata -> name)
    const myDeploymentSym = resourcesSym.children[1];
    assert.ok(myDeploymentSym.children.length > 0);
    const templateChild = myDeploymentSym.children.find(c => c.name === 'template');
    assert.ok(templateChild);
    assert.ok(templateChild.children.length > 0);
    const metadataChild = templateChild.children.find(c => c.name === 'metadata');
    assert.ok(metadataChild);
    assert.ok(metadataChild.children.some(c => c.name === 'name'));

    // 3. Verify references inside template CEL expressions are captured
    // In our sample YAML, we have "${my-service.metadata.name}" in deployment metadata labels
    // and "my-service.status.active == true" in readyWhen list
    const serviceRefs = parsed.references.filter(ref => ref.resourceId === 'my-service');
    assert.ok(serviceRefs.length >= 2, `Expected at least 2 references to my-service, found ${serviceRefs.length}`);

    // Verify ranges are valid
    for (const ref of serviceRefs) {
      assert.strictEqual(ref.resourceId, 'my-service');
      const textAtRange = sampleYaml.substring(
        doc.offsetAt ? doc.offsetAt(ref.range.start) : (ref.range.start.line * 20), // approximate if no offsetAt, but we can compute it
        doc.offsetAt ? doc.offsetAt(ref.range.end) : 0
      );
      // Let's test using custom position-to-offset matching
      const startOffset = sampleYaml.split('\n').slice(0, ref.range.start.line).join('\n').length + 1 + ref.range.start.character;
      const endOffset = sampleYaml.split('\n').slice(0, ref.range.end.line).join('\n').length + 1 + ref.range.end.character;
      const extractedText = sampleYaml.substring(startOffset, endOffset);
      assert.ok(extractedText.startsWith('my-service'));
    }
  });

  test('Gracefully ignores non-KRO YAML files', () => {
    const normalYaml = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: normal-deployment',
      'spec:',
      '  replicas: 1'
    ].join('\n');

    const doc = new MockTextDocument(normalYaml) as unknown as vscode.TextDocument;
    const parsed = parseKroDocument(doc);

    assert.strictEqual(parsed.symbols.length, 0);
    assert.strictEqual(parsed.resourceDefs.size, 0);
    assert.strictEqual(parsed.references.length, 0);
  });

  test('Parses official upstream webapp example and maps nested template properties', () => {
    const filePath = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures', 'rg.yaml');
    const content = fs.readFileSync(filePath, 'utf8');

    const doc = new MockTextDocument(content) as unknown as vscode.TextDocument;
    const parsed = parseKroDocument(doc);

    // 1. Verify general parsing
    assert.strictEqual(parsed.symbols[0].name, 'webapp.kro.run');
    assert.strictEqual(parsed.resourceDefs.size, 4);
    assert.ok(parsed.resourceDefs.has('deployment'));
    assert.ok(parsed.resourceDefs.has('service'));
    assert.ok(parsed.resourceDefs.has('ingress'));
    assert.ok(parsed.resourceDefs.has('schema'));

    const schemaDef = parsed.resourceDefs.get('schema');
    assert.ok(schemaDef);
    assert.ok(schemaDef.propertyRanges.has('spec.name'));
    // Line 10 in rg.yaml (0-indexed line number is 9)
    assert.strictEqual(schemaDef.propertyRanges.get('spec.name')?.start.line, 9);

    // 2. Verify property ranges mapping for deployment template
    const deploymentDef = parsed.resourceDefs.get('deployment');
    assert.ok(deploymentDef);
    
    // Check that we mapped "metadata.namespace" in deployment
    assert.ok(deploymentDef.propertyRanges.has('metadata.namespace'));
    const namespaceRange = deploymentDef.propertyRanges.get('metadata.namespace');
    assert.ok(namespaceRange);
    
    // Line 33 in rg.yaml (0-indexed line number is 32)
    assert.strictEqual(namespaceRange.start.line, 32); 

    // 3. Verify that references capture suffixes (e.g. deployment.metadata.namespace)
    // Check references to deployment
    const deploymentRefs = parsed.references.filter(r => r.resourceId === 'deployment');
    assert.ok(deploymentRefs.length > 0);

    // Find the one for deployment.metadata.namespace
    const namespaceRef = deploymentRefs.find(r => r.propertyPath === 'metadata.namespace');
    assert.ok(namespaceRef, 'Expected to find reference with propertyPath="metadata.namespace"');
    
    // Get text at the reference range
    const lines = content.split('\n');
    const startChar = namespaceRef.range.start.character;
    const endChar = namespaceRef.range.end.character;
    const refLineText = lines[namespaceRef.range.start.line];
    const extractedText = refLineText.substring(startChar, endChar);
    assert.strictEqual(extractedText, 'deployment.metadata.namespace');
  });

  test('KroCompletionItemProvider suggests top-level variables and namespaces inside CEL wrapper', async () => {
    const sampleYaml = [
      'apiVersion: kro.run/v1alpha1',
      'kind: ResourceGraphDefinition',
      'metadata:',
      '  name: test-app',
      'spec:',
      '  schema:',
      '    apiVersion: v1alpha1',
      '    kind: TestApp',
      '    spec:',
      '      replicas: integer',
      '  resources:',
      '    - id: my-service',
      '      template:',
      '        apiVersion: v1',
      '        kind: Service',
      '        metadata:',
      '          name: ${',
      ''
    ].join('\n');

    const doc = new MockTextDocument(sampleYaml) as unknown as vscode.TextDocument;
    const provider = new KroCompletionItemProvider();
    
    // Position of the cursor after "${" (line 16, char 18)
    const position = new vscode.Position(16, 18);
    const items = await provider.provideCompletionItems(
      doc,
      position,
      new vscode.CancellationTokenSource().token,
      { triggerKind: vscode.CompletionTriggerKind.Invoke } as any
    ) as vscode.CompletionItem[];

    assert.ok(items && items.length > 0);
    // Root suggestions should include "schema", "my-service", and KRO namespaces
    const labels = items.map(item => item.label);
    assert.ok(labels.includes('schema'), 'Should suggest schema');
    assert.ok(labels.includes('my-service'), 'Should suggest my-service');
    assert.ok(labels.includes('hash'), 'Should suggest hash');
    assert.ok(labels.includes('json'), 'Should suggest json');
  });

  test('KroCompletionItemProvider suggests nested schema fields and library functions', async () => {
    const sampleYaml = [
      'apiVersion: kro.run/v1alpha1',
      'kind: ResourceGraphDefinition',
      'metadata:',
      '  name: test-app',
      'spec:',
      '  schema:',
      '    apiVersion: v1alpha1',
      '    kind: TestApp',
      '    spec:',
      '      replicas: integer',
      '      appName: string',
      '  resources:',
      '    - id: my-service',
      '      template:',
      '        apiVersion: v1',
      '        kind: Service',
      '        metadata:',
      '          name: ${schema.spec.',
      '          namespace: ${hash.',
      ''
    ].join('\n');

    const doc = new MockTextDocument(sampleYaml) as unknown as vscode.TextDocument;
    const provider = new KroCompletionItemProvider();

    // 1. Test schema.spec.* suggestion
    const posSchema = new vscode.Position(17, 30);
    const itemsSchema = await provider.provideCompletionItems(
      doc,
      posSchema,
      new vscode.CancellationTokenSource().token,
      { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '.' } as any
    ) as vscode.CompletionItem[];

    assert.ok(itemsSchema && itemsSchema.length > 0);
    const schemaLabels = itemsSchema.map(item => item.label);
    assert.ok(schemaLabels.includes('replicas'), 'Should suggest replicas');
    assert.ok(schemaLabels.includes('appName'), 'Should suggest appName');

    // 2. Test hash.* library function suggestions
    const posHash = new vscode.Position(18, 28);
    const itemsHash = await provider.provideCompletionItems(
      doc,
      posHash,
      new vscode.CancellationTokenSource().token,
      { triggerKind: vscode.CompletionTriggerKind.TriggerCharacter, triggerCharacter: '.' } as any
    ) as vscode.CompletionItem[];

    assert.ok(itemsHash && itemsHash.length > 0);
    const hashLabels = itemsHash.map(item => item.label);
    assert.ok(hashLabels.includes('fnv64a'), 'Should suggest fnv64a');
    assert.ok(hashLabels.includes('sha256'), 'Should suggest sha256');
    assert.ok(hashLabels.includes('md5'), 'Should suggest md5');
  });
});
