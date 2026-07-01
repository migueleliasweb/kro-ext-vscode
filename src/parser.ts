import * as vscode from 'vscode';
import { parseAllDocuments, isMap, isSeq, Pair, Scalar } from 'yaml';

export interface KroResourceDef {
  id: string;
  kind: string;
  name: string;
  idRange: vscode.Range;
  fullRange: vscode.Range;
  parentRgdName: string; // The name of the parent RGD that defines this resource
  propertyRanges: Map<string, vscode.Range>; // Maps nested property paths (e.g. "metadata.namespace") to document Ranges
}

export interface KroReference {
  resourceId: string;
  propertyPath?: string; // Optional suffix path (e.g. "metadata.namespace")
  range: vscode.Range;
}

export interface KroParsedDocument {
  resourceDefs: Map<string, KroResourceDef>;
  references: KroReference[];
  symbols: vscode.DocumentSymbol[];
  schemaSpecKeys: string[];
  schemaStatusKeys: string[];
}

export function parseKroDocument(document: vscode.TextDocument): KroParsedDocument {
  const text = document.getText();
  const resourceDefs = new Map<string, KroResourceDef>();
  const references: KroReference[] = [];
  const symbols: vscode.DocumentSymbol[] = [];
  const schemaSpecKeys: string[] = [];
  const schemaStatusKeys: string[] = [];

  let docs;
  try {
    docs = parseAllDocuments(text);
  } catch (e) {
    // Return empty results if parsing fails completely
    return { resourceDefs, references, symbols, schemaSpecKeys, schemaStatusKeys };
  }

  // Helper to convert yaml-ast offsets to vscode Range
  function getRange(range: [number, number, number] | [number, number] | null | undefined): vscode.Range {
    if (!range) {
      return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }
    const start = document.positionAt(range[0]);
    const end = document.positionAt(range[1]);
    return new vscode.Range(start, end);
  }

  // Helper to recursively map property paths in a template node to their Ranges
  function mapPathRanges(node: any, currentPath: string, pathsMap: Map<string, vscode.Range>) {
    if (!node) {
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (pair.key instanceof Scalar) {
          const keyName = String(pair.key.value);
          const nextPath = currentPath ? `${currentPath}.${keyName}` : keyName;
          pathsMap.set(nextPath, getRange(pair.key.range));
          mapPathRanges(pair.value, nextPath, pathsMap);
        }
      }
    } else if (isSeq(node)) {
      for (let i = 0; i < node.items.length; i++) {
        const item = node.items[i];
        const nextPath = `${currentPath}[${i}]`;
        mapPathRanges(item, nextPath, pathsMap);
      }
    }
  }

  // Helper to recursively generate detailed DocumentSymbols from a YAML AST node
  function createYamlSymbol(keyName: string, valueNode: any, keyRange: vscode.Range, fullRange: vscode.Range): vscode.DocumentSymbol {
    let symbolKind = vscode.SymbolKind.Property;
    const children: vscode.DocumentSymbol[] = [];

    if (isMap(valueNode)) {
      symbolKind = vscode.SymbolKind.Struct;
      for (const pair of (valueNode.items as any[])) {
        if (pair.key instanceof Scalar) {
          const kName = String(pair.key.value);
          const kRange = getRange(pair.key.range);
          const pStart = pair.key.range ? pair.key.range[0] : 0;
          const pEnd = (pair.value && pair.value.range) ? pair.value.range[1] : (pair.key.range ? pair.key.range[1] : 0);
          const fRange = getRange([pStart, pEnd]);
          children.push(createYamlSymbol(kName, pair.value, kRange, fRange));
        }
      }
    } else if (isSeq(valueNode)) {
      symbolKind = vscode.SymbolKind.Array;
      for (let i = 0; i < valueNode.items.length; i++) {
        const item = valueNode.items[i] as any;
        const label = `[${i}]`;
        const itemRange = getRange(item.range);
        children.push(createYamlSymbol(label, item, itemRange, itemRange));
      }
    } else if (valueNode instanceof Scalar) {
      const val = valueNode.value;
      if (typeof val === 'boolean') {
        symbolKind = vscode.SymbolKind.Boolean;
      } else if (typeof val === 'number') {
        symbolKind = vscode.SymbolKind.Number;
      } else if (typeof val === 'string') {
        symbolKind = vscode.SymbolKind.String;
      }
    }

    const symbol = new vscode.DocumentSymbol(
      keyName,
      valueNode instanceof Scalar ? String(valueNode.value) : '',
      symbolKind,
      fullRange,
      keyRange
    );
    symbol.children = children;
    return symbol;
  }

  for (const doc of docs) {
    if (!doc || !isMap(doc.contents)) {
      continue;
    }

    // Guard: Only process if kind is ResourceGraphDefinition and apiVersion is kro.run/*
    const kindPair = doc.contents.items.find((item: any) => item.key && (item.key as Scalar).value === 'kind');
    const apiVersionPair = doc.contents.items.find((item: any) => item.key && (item.key as Scalar).value === 'apiVersion');
    
    const kindVal = kindPair && kindPair.value ? String((kindPair.value as Scalar).value) : '';
    const apiVersionVal = apiVersionPair && apiVersionPair.value ? String((apiVersionPair.value as Scalar).value) : '';

    if (kindVal !== 'ResourceGraphDefinition' || !apiVersionVal.startsWith('kro.run/')) {
      continue;
    }

    // 1. First Pass: Locate all resource definitions under spec.resources
    const specPair = doc.contents.items.find((item: any) => item.key && (item.key as Scalar).value === 'spec');
    const specNode = specPair?.value;

    let rgdName = 'ResourceGraphDefinition';
    const metadataPair = doc.contents.items.find((item: any) => item.key && (item.key as Scalar).value === 'metadata');
    if (metadataPair && isMap(metadataPair.value)) {
      const namePair = metadataPair.value.items.find((item: any) => item.key && (item.key as Scalar).value === 'name');
      if (namePair && namePair.value && (namePair.value as Scalar).value) {
        rgdName = String((namePair.value as Scalar).value);
      }
    }

    const rgdRange = getRange(doc.contents.range);
    const rgdSymbol = new vscode.DocumentSymbol(
      rgdName,
      'ResourceGraphDefinition',
      vscode.SymbolKind.Class,
      rgdRange,
      rgdRange
    );
    symbols.push(rgdSymbol);

    let schemaSymbol: vscode.DocumentSymbol | undefined;
    let resourcesSymbol: vscode.DocumentSymbol | undefined;

    if (specNode && isMap(specNode)) {
      // Extract Schema Details
      const schemaPair = specNode.items.find((item: any) => item.key && (item.key as Scalar).value === 'schema');
      const schemaNode = schemaPair?.value;
      if (schemaPair && schemaNode && isMap(schemaNode)) {
        const kindPair = schemaNode.items.find((item: any) => item.key && (item.key as Scalar).value === 'kind');
        const customKind = kindPair && kindPair.value ? String((kindPair.value as Scalar).value) : 'CustomKind';
        const schemaRange = getRange(schemaNode.range);
        schemaSymbol = new vscode.DocumentSymbol(
          `Schema: ${customKind}`,
          'API Interface',
          vscode.SymbolKind.Interface,
          schemaRange,
          schemaRange
        );
        rgdSymbol.children.push(schemaSymbol);

        // Build hierarchical outline for schema properties
        for (const pair of (schemaNode.items as any[])) {
          if (pair.key instanceof Scalar) {
            const kName = String(pair.key.value);
            const kRange = getRange(pair.key.range);
            const pStart = pair.key.range ? pair.key.range[0] : 0;
            const pEnd = (pair.value && pair.value.range) ? pair.value.range[1] : (pair.key.range ? pair.key.range[1] : 0);
            const fRange = getRange([pStart, pEnd]);
            schemaSymbol.children.push(createYamlSymbol(kName, pair.value, kRange, fRange));
          }
        }

        // Collect fields under spec.schema.spec
        const schemaSpecPair = schemaNode.items.find((item: any) => item.key && (item.key as Scalar).value === 'spec');
        if (schemaSpecPair && isMap(schemaSpecPair.value)) {
          for (const pair of schemaSpecPair.value.items) {
            if (pair.key instanceof Scalar) {
              schemaSpecKeys.push(String(pair.key.value));
            }
          }
        }

        // Collect fields under spec.schema.status
        const schemaStatusPair = schemaNode.items.find((item: any) => item.key && (item.key as Scalar).value === 'status');
        if (schemaStatusPair && isMap(schemaStatusPair.value)) {
          for (const pair of schemaStatusPair.value.items) {
            if (pair.key instanceof Scalar) {
              schemaStatusKeys.push(String(pair.key.value));
            }
          }
        }

        // Map property ranges for schema.spec.* and schema.status.*
        const schemaPropertyRanges = new Map<string, vscode.Range>();
        if (schemaSpecPair && isMap(schemaSpecPair.value)) {
          mapPathRanges(schemaSpecPair.value, 'spec', schemaPropertyRanges);
        }
        if (schemaStatusPair && isMap(schemaStatusPair.value)) {
          mapPathRanges(schemaStatusPair.value, 'status', schemaPropertyRanges);
        }

        // Register schema as a pseudo-resource to enable deep property Click-to-Definition
        resourceDefs.set('schema', {
          id: 'schema',
          kind: 'Schema',
          name: 'schema',
          idRange: getRange(schemaPair.key.range),
          fullRange: schemaRange,
          parentRgdName: rgdName,
          propertyRanges: schemaPropertyRanges
        });
      }

      // Extract Resources Details
      const resourcesPair = specNode.items.find((item: any) => item.key && (item.key as Scalar).value === 'resources');
      const resourcesNode = resourcesPair?.value;
      if (resourcesPair && resourcesNode && isSeq(resourcesNode)) {
        const resourcesRange = getRange(resourcesNode.range);
        resourcesSymbol = new vscode.DocumentSymbol(
          'resources',
          'Resource List',
          vscode.SymbolKind.Namespace,
          resourcesRange,
          resourcesRange
        );
        rgdSymbol.children.push(resourcesSymbol);

        // Parse individual resources in the sequence
        for (const item of resourcesNode.items) {
          if (!isMap(item)) {
            continue;
          }

          const idPair = item.items.find((p: any) => p.key && (p.key as Scalar).value === 'id');
          const idVal = idPair?.value;
          if (!idPair || !idVal || (idVal as Scalar).value === undefined) {
            continue;
          }

          const resourceId = String((idVal as Scalar).value);
          const idRange = getRange(idVal.range);
          const fullRange = getRange(item.range);

          // Try to get kind of template
          let resourceKind = 'Resource';
          let resourceName = '';
          const templatePair = item.items.find((p: any) => p.key && (p.key as Scalar).value === 'template');
          const templateVal = templatePair?.value;
          if (templatePair && templateVal && isMap(templateVal)) {
            const kindPair = templateVal.items.find((p: any) => p.key && (p.key as Scalar).value === 'kind');
            if (kindPair && kindPair.value) {
              resourceKind = String((kindPair.value as Scalar).value);
            }
            const metadataPair = templateVal.items.find((p: any) => p.key && (p.key as Scalar).value === 'metadata');
            if (metadataPair && metadataPair.value && isMap(metadataPair.value)) {
              const namePair = metadataPair.value.items.find((p: any) => p.key && (p.key as Scalar).value === 'name');
              if (namePair && namePair.value) {
                resourceName = String((namePair.value as Scalar).value);
              }
            }
          }

          // Build nested property paths ranges map for template
          const propertyRanges = new Map<string, vscode.Range>();
          if (templateVal && isMap(templateVal)) {
            mapPathRanges(templateVal, '', propertyRanges);
          }

          // Save definition
          resourceDefs.set(resourceId, {
            id: resourceId,
            kind: resourceKind,
            name: resourceName,
            idRange,
            fullRange,
            parentRgdName: rgdName,
            propertyRanges
          });

          // Add to symbols
          const itemSymbol = new vscode.DocumentSymbol(
            resourceId,
            resourceKind,
            vscode.SymbolKind.Field,
            fullRange,
            idRange
          );
          
          // Populate child symbols hierarchically from YAML map properties
          for (const pair of (item.items as any[])) {
            if (pair.key instanceof Scalar) {
              const kName = String(pair.key.value);
              const kRange = getRange(pair.key.range);
              const pStart = pair.key.range ? pair.key.range[0] : 0;
              const pEnd = (pair.value && pair.value.range) ? pair.value.range[1] : (pair.key.range ? pair.key.range[1] : 0);
              const fRange = getRange([pStart, pEnd]);
              itemSymbol.children.push(createYamlSymbol(kName, pair.value, kRange, fRange));
            }
          }
          
          resourcesSymbol.children.push(itemSymbol);
        }
      }
    }
  }

  // 2. Second Pass: Find references inside all string scalar nodes in the document
  const resourceIds = Array.from(resourceDefs.keys());

  function traverseAndFindReferences(node: any) {
    if (!node) {
      return;
    }

    if (node instanceof Scalar && typeof node.value === 'string' && node.range) {
      const startOffset = node.range[0];
      const rawText = text.substring(startOffset, node.range[1]);

      // Regex matching standard CEL references ${resource_id.something.or.index[0]}
      const celRegex = /\$\{([a-zA-Z0-9_-]+)((?:\.[a-zA-Z0-9_-]+|\[\d+\])*)\}/g;
      let match;
      while ((match = celRegex.exec(rawText)) !== null) {
        const refId = match[1];
        const pathSuffix = match[2];
        const propertyPath = pathSuffix ? pathSuffix.substring(1) : ''; // e.g. "metadata.namespace"
        
        if (resourceIds.includes(refId)) {
          // Calculate exact start/end offsets in the document for the full reference (e.g. deployment.metadata.namespace)
          const matchStart = startOffset + match.index + 2; // +2 for "${"
          const matchEnd = matchStart + refId.length + (pathSuffix ? pathSuffix.length : 0);
          references.push({
            resourceId: refId,
            propertyPath: propertyPath,
            range: new vscode.Range(
              document.positionAt(matchStart),
              document.positionAt(matchEnd)
            )
          });
        }
      }

      // Also scan plain text if this scalar is part of readyWhen or includeWhen CEL expressions
      // e.g. "resource_id.status.ready == true"
      const plainRegex = /\b([a-zA-Z0-9_-]+)((?:\.[a-zA-Z0-9_-]+|\[\d+\])*)/g;
      while ((match = plainRegex.exec(rawText)) !== null) {
        const refId = match[1];
        const pathSuffix = match[2];
        const propertyPath = pathSuffix ? pathSuffix.substring(1) : '';
        
        if (resourceIds.includes(refId)) {
          const matchStart = startOffset + match.index;
          const matchEnd = matchStart + refId.length + (pathSuffix ? pathSuffix.length : 0);
          // Avoid duplicate ranges we might have already added if overlapping
          const alreadyExists = references.some(
            r => r.resourceId === refId &&
                 r.range.start.character === document.positionAt(matchStart).character &&
                 r.range.start.line === document.positionAt(matchStart).line
          );
          if (!alreadyExists) {
            references.push({
              resourceId: refId,
              propertyPath: propertyPath,
              range: new vscode.Range(
                document.positionAt(matchStart),
                document.positionAt(matchEnd)
              )
            });
          }
        }
      }
    }

    if (isMap(node)) {
      for (const pair of node.items) {
        traverseAndFindReferences(pair.key);
        traverseAndFindReferences(pair.value);
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        traverseAndFindReferences(item);
      }
    }
  }

  for (const doc of docs) {
    if (doc && doc.contents) {
      traverseAndFindReferences(doc.contents);
    }
  }

  return { resourceDefs, references, symbols, schemaSpecKeys, schemaStatusKeys };
}
