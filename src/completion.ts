import * as vscode from 'vscode';
import { parseKroDocument } from './parser';

export class KroCompletionItemProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    
    // Parse the document
    const parsed = parseKroDocument(document);
    // If it's not a KRO document, don't provide completions
    if (parsed.symbols.length === 0) {
      return [];
    }

    const lineText = document.lineAt(position.line).text;
    const character = position.character;

    // Detect if the cursor is inside a string or CEL context
    const prefix = lineText.substring(0, character);
    
    // Check if the cursor is inside a "${...}" block on the current line.
    const lastOpenBrace = prefix.lastIndexOf('${');
    const lastCloseBrace = prefix.lastIndexOf('}');
    const isInsideBraces = lastOpenBrace !== -1 && lastOpenBrace > lastCloseBrace;

    // Also check if this line is part of a CEL-only list field (like readyWhen or includeWhen)
    const isCelListLine = /^\s*-\s+/.test(lineText) || lineText.includes('readyWhen') || lineText.includes('includeWhen');
    const isCelContext = isInsideBraces || isCelListLine;

    if (!isCelContext) {
      return [];
    }

    // Extract the active CEL expression segment before the cursor
    let celExpr = '';
    if (isInsideBraces) {
      celExpr = prefix.substring(lastOpenBrace + 2); // skip "${"
    } else {
      const match = prefix.match(/([\w\d\.\[\]_-]+)$/);
      if (match) {
        celExpr = match[1];
      }
    }

    const suggestions: vscode.CompletionItem[] = [];

    if (celExpr.endsWith('.')) {
      const scope = celExpr.slice(0, -1); // e.g. "schema.spec", "hash", "deployment", etc.

      if (scope === 'schema.spec') {
        for (const key of parsed.schemaSpecKeys) {
          const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Field);
          item.detail = 'Schema Input Property';
          suggestions.push(item);
        }
      } else if (scope === 'schema.status') {
        for (const key of parsed.schemaStatusKeys) {
          const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Field);
          item.detail = 'Schema Output Property';
          suggestions.push(item);
        }
      } else if (scope === 'schema') {
        const specItem = new vscode.CompletionItem('spec', vscode.CompletionItemKind.Folder);
        specItem.detail = 'Schema Input Fields';
        const statusItem = new vscode.CompletionItem('status', vscode.CompletionItemKind.Folder);
        statusItem.detail = 'Schema Output Fields';
        suggestions.push(specItem, statusItem);
      } else if (scope === 'hash') {
        suggestions.push(
          createMethodItem('fnv64a', 'fnv64a(${1:string})', 'hash.fnv64a(string)\n\nComputes an FNV-1a 64-bit hash.'),
          createMethodItem('sha256', 'sha256(${1:string})', 'hash.sha256(string)\n\nComputes a SHA-256 hash.'),
          createMethodItem('md5', 'md5(${1:string})', 'hash.md5(string)\n\nComputes an MD5 hash.')
        );
      } else if (scope === 'json') {
        suggestions.push(
          createMethodItem('unmarshal', 'unmarshal(${1:string})', 'json.unmarshal(string)\n\nParses a JSON string into a dynamic CEL type.'),
          createMethodItem('marshal', 'marshal(${1:value})', 'json.marshal(value)\n\nConverts a CEL value into a JSON string.')
        );
      } else if (scope === 'lists') {
        suggestions.push(
          createMethodItem('setAtIndex', 'setAtIndex(${1:list}, ${2:index}, ${3:value})', 'lists.setAtIndex(list, int, value)\n\nReturns a new list with the element replaced.'),
          createMethodItem('insertAtIndex', 'insertAtIndex(${1:list}, ${2:index}, ${3:value})', 'lists.insertAtIndex(list, int, value)\n\nReturns a new list with the value inserted.'),
          createMethodItem('removeAtIndex', 'removeAtIndex(${1:list}, ${2:index})', 'lists.removeAtIndex(list, int)\n\nReturns a new list with the element removed.')
        );
      } else if (scope === 'random') {
        suggestions.push(
          createMethodItem('seededString', 'seededString(${1:length}, ${2:seed})', 'random.seededString(length, seed)\n\nGenerates a deterministic alphanumeric string based on a seed.'),
          createMethodItem('seededInt', 'seededInt(${1:min}, ${2:max}, ${3:seed})', 'random.seededInt(min, max, seed)\n\nGenerates a deterministic integer based on a seed.')
        );
      } else if (scope === 'cel') {
        suggestions.push(
          createMethodItem('bind', 'bind(${1:varName}, ${2:init}, ${3:body})', 'cel.bind(varName, init, body)\n\nBinds intermediate values to local variables.')
        );
      } else {
        // Check if scope is a valid resource ID (e.g. "deployment")
        const def = parsed.resourceDefs.get(scope);
        if (def) {
          const directKeys = new Set<string>();
          for (const key of def.propertyRanges.keys()) {
            const firstDot = key.indexOf('.');
            if (firstDot === -1) {
              directKeys.add(key);
            } else {
              directKeys.add(key.substring(0, firstDot));
            }
          }
          for (const key of directKeys) {
            const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
            item.detail = `${def.kind} Property`;
            suggestions.push(item);
          }
        } else {
          // Check if scope is nested (e.g. "deployment.metadata")
          const firstDot = scope.indexOf('.');
          if (firstDot !== -1) {
            const resourceId = scope.substring(0, firstDot);
            const pathPrefix = scope.substring(firstDot + 1);
            const def = parsed.resourceDefs.get(resourceId);
            if (def) {
              const prefixWithDot = pathPrefix + '.';
              const childKeys = new Set<string>();
              for (const key of def.propertyRanges.keys()) {
                if (key.startsWith(prefixWithDot)) {
                  const suffix = key.substring(prefixWithDot.length);
                  const nextDot = suffix.indexOf('.');
                  if (nextDot === -1) {
                    childKeys.add(suffix);
                  } else {
                    childKeys.add(suffix.substring(0, nextDot));
                  }
                }
              }
              for (const key of childKeys) {
                const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Property);
                item.detail = `${def.kind} ${pathPrefix} Property`;
                suggestions.push(item);
              }
            }
          }
        }
      }
    } else {
      // Suggest top-level variable names and library namespaces
      const schemaItem = new vscode.CompletionItem('schema', vscode.CompletionItemKind.Variable);
      schemaItem.detail = 'KRO Schema Inputs/Outputs';
      suggestions.push(schemaItem);

      // Suggest resource IDs
      for (const [id, def] of parsed.resourceDefs.entries()) {
        const item = new vscode.CompletionItem(id, vscode.CompletionItemKind.Variable);
        item.detail = `Defined Resource: ${def.kind}`;
        suggestions.push(item);
      }

      // Suggest KRO library namespaces
      const namespaces = ['hash', 'json', 'lists', 'random', 'cel'];
      for (const ns of namespaces) {
        const item = new vscode.CompletionItem(ns, vscode.CompletionItemKind.Module);
        item.detail = `KRO Custom CEL Library`;
        suggestions.push(item);
      }
    }

    return suggestions;
  }
}

function createMethodItem(label: string, insertText: string, documentation: string): vscode.CompletionItem {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Method);
  item.insertText = new vscode.SnippetString(insertText);
  item.documentation = new vscode.MarkdownString(documentation);
  return item;
}
