(function () {
  const vscode = acquireVsCodeApi();

  let network = null;
  let nodesDataSet = null;
  let edgesDataSet = null;
  let currentLayout = 'hierarchical-ud'; // Default to Hierarchical Top-Down

  // DOM elements
  const container = document.getElementById('network-container');
  const detailsPanel = document.getElementById('details-panel');
  const detailId = document.getElementById('detail-id');
  const detailKind = document.getElementById('detail-kind');
  const closePanelBtn = document.getElementById('close-panel-btn');
  const filenameSpan = document.getElementById('active-filename');
  const fitBtn = document.getElementById('fit-btn');
  const layoutSelect = document.getElementById('layout-select');

  // Color mapping based on KRO Resource Kind
  function getNodeStyle(kind) {
    const kindLower = kind.toLowerCase();

    // Root RGD Node
    if (kindLower === 'resourcegraphdefinition') {
      return {
        color: {
          background: '#231230',
          border: 'rgba(187, 134, 252, 0.5)',
          highlight: { background: '#351c47', border: '#bb86fc' },
          hover: { background: '#2d183d', border: 'rgba(187, 134, 252, 0.75)' }
        },
        font: { color: '#e2d5f8' },
        shadow: { enabled: true, color: 'rgba(187, 134, 252, 0.3)', size: 14, x: 0, y: 0 }
      };
    }

    const defaultStyle = {
      color: {
        background: '#1e1e28',
        border: 'rgba(255, 255, 255, 0.15)',
        highlight: { background: '#252535', border: '#9c27b0' },
        hover: { background: '#252535', border: 'rgba(255, 255, 255, 0.3)' }
      },
      font: { color: '#e0e0e8' },
      shadow: { enabled: true, color: 'rgba(156, 39, 176, 0.15)', size: 10, x: 0, y: 0 }
    };

    // Workloads (Deployments, DaemonSets, StatefulSets, Jobs, Pods)
    if (kindLower.includes('deploy') || kindLower.includes('pod') || kindLower.includes('replica') || kindLower.includes('job') || kindLower.includes('stateful')) {
      return {
        color: {
          background: '#132238',
          border: 'rgba(56, 139, 253, 0.4)',
          highlight: { background: '#1c3254', border: '#58a6ff' },
          hover: { background: '#182b48', border: 'rgba(56, 139, 253, 0.7)' }
        },
        font: { color: '#c9d1d9' },
        shadow: { enabled: true, color: 'rgba(56, 139, 253, 0.3)', size: 12, x: 0, y: 0 }
      };
    }

    // Networking (Services, Ingresses, Routes, Gateways)
    if (kindLower.includes('service') || kindLower.includes('ingress') || kindLower.includes('route') || kindLower.includes('gateway')) {
      return {
        color: {
          background: '#0d2818',
          border: 'rgba(46, 160, 67, 0.4)',
          highlight: { background: '#143f25', border: '#56d364' },
          hover: { background: '#10331e', border: 'rgba(46, 160, 67, 0.7)' }
        },
        font: { color: '#c9d1d9' },
        shadow: { enabled: true, color: 'rgba(46, 160, 67, 0.3)', size: 12, x: 0, y: 0 }
      };
    }

    // Config & Secrets (ConfigMaps, Secrets)
    if (kindLower.includes('config') || kindLower.includes('secret')) {
      return {
        color: {
          background: '#2b2207',
          border: 'rgba(210, 153, 34, 0.4)',
          highlight: { background: '#3e310a', border: '#e3b341' },
          hover: { background: '#352909', border: 'rgba(210, 153, 34, 0.7)' }
        },
        font: { color: '#c9d1d9' },
        shadow: { enabled: true, color: 'rgba(210, 153, 34, 0.3)', size: 12, x: 0, y: 0 }
      };
    }

    return defaultStyle;
  }

  // Generate Vis-Network options dynamically based on layout state
  function getNetworkOptions() {
    const isHierarchical = currentLayout.startsWith('hierarchical-');
    const direction = currentLayout === 'hierarchical-lr' ? 'LR' : 'UD';

    return {
      layout: {
        hierarchical: isHierarchical ? {
          enabled: true,
          direction: direction,
          sortMethod: 'directed',
          nodeSpacing: 180,
          treeSpacing: 240,
          levelSeparation: 150,
          parentCentralization: true
        } : {
          enabled: false
        }
      },
      physics: {
        enabled: !isHierarchical, // Physics disabled in hierarchical mode to align properly
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -40,
          centralGravity: 0.015,
          springLength: 120,
          springConstant: 0.08,
          damping: 0.4
        }
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        selectConnectedEdges: false
      }
    };
  }

  // Initialize network
  function initNetwork(nodes, edges) {
    // Convert KRO node structures to Vis-Network nodes
    const visNodes = nodes.map(node => {
      const style = getNodeStyle(node.kind);
      return {
        id: node.id,
        label: node.label,
        title: node.title,
        shape: 'box',
        margin: 12,
        shapeProperties: {
          borderRadius: 8
        },
        borderWidth: 1.5,
        font: {
          face: 'Inter, system-ui, sans-serif',
          size: 13,
          weight: '500',
          ...style.font
        },
        color: style.color,
        shadow: style.shadow
      };
    });

    // Style edges cleanly
    const visEdges = edges.map(edge => {
      return {
        from: edge.from,
        to: edge.to,
        arrows: {
          to: { enabled: true, scaleFactor: 0.8, type: 'arrow' }
        },
        color: {
          color: 'rgba(255, 255, 255, 0.15)',
          highlight: '#58a6ff',
          hover: 'rgba(255, 255, 255, 0.3)'
        },
        width: 1.5,
        smooth: {
          enabled: true,
          type: 'cubicBezier',
          forceDirection: 'horizontal',
          roundness: 0.5
        },
        dashes: edge.dashes || false
      };
    });

    nodesDataSet = new vis.DataSet(visNodes);
    edgesDataSet = new vis.DataSet(visEdges);

    const data = {
      nodes: nodesDataSet,
      edges: edgesDataSet
    };

    network = new vis.Network(container, data, getNetworkOptions());

    // Click handler for nodes (jump definition on Cmd/Ctrl click)
    network.on('click', function (params) {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const srcNode = nodes.find(n => n.id === nodeId);
        
        // Show details panel
        if (srcNode) {
          showDetails(srcNode);
        }

        // Detect Cmd click (Mac) or Ctrl click (Windows/Linux)
        const srcEvent = params.event.srcEvent;
        const isCmdOrCtrl = srcEvent.metaKey || srcEvent.ctrlKey;
        
        if (isCmdOrCtrl) {
          vscode.postMessage({
            command: 'jumpToResource',
            resourceId: nodeId
          });
        }
      } else {
        hideDetails();
      }
    });
  }

  function updateNetwork(nodes, edges) {
    if (!network) {
      initNetwork(nodes, edges);
      return;
    }

    // Keep track of selected node to preserve selection
    const selection = network.getSelectedNodes();

    // Sync nodes
    const currentNodes = nodesDataSet.get();
    const currentIds = currentNodes.map(n => n.id);
    const newIds = nodes.map(n => n.id);

    // Remove nodes that are no longer there
    currentIds.forEach(id => {
      if (!newIds.includes(id)) {
        nodesDataSet.remove(id);
      }
    });

    // Add/Update nodes
    nodes.forEach(node => {
      const style = getNodeStyle(node.kind);
      nodesDataSet.update({
        id: node.id,
        label: node.label,
        title: node.title,
        shape: 'box',
        margin: 12,
        shapeProperties: {
          borderRadius: 8
        },
        borderWidth: 1.5,
        font: {
          face: 'Inter, system-ui, sans-serif',
          size: 13,
          weight: '500',
          ...style.font
        },
        color: style.color,
        shadow: style.shadow
      });
    });

    // Sync edges
    edgesDataSet.clear();
    const visEdges = edges.map(edge => {
      return {
        from: edge.from,
        to: edge.to,
        arrows: {
          to: { enabled: true, scaleFactor: 0.8, type: 'arrow' }
        },
        color: {
          color: 'rgba(255, 255, 255, 0.15)',
          highlight: '#58a6ff',
          hover: 'rgba(255, 255, 255, 0.3)'
        },
        width: 1.5,
        smooth: {
          enabled: true,
          type: 'cubicBezier',
          forceDirection: 'horizontal',
          roundness: 0.5
        },
        dashes: edge.dashes || false
      };
    });
    edgesDataSet.add(visEdges);

    // Preserve selection if the node still exists
    if (selection.length > 0 && newIds.includes(selection[0])) {
      network.selectNodes(selection);
    } else {
      hideDetails();
    }
  }

  function showDetails(node) {
    detailId.innerText = node.id;
    detailKind.innerText = node.kind;
    
    // Set badge style based on resource kind
    detailKind.className = 'value badge';
    const kindLower = node.kind.toLowerCase();
    if (kindLower.includes('deploy') || kindLower.includes('pod') || kindLower.includes('replica') || kindLower.includes('job') || kindLower.includes('stateful')) {
      detailKind.classList.add('badge-blue');
    } else if (kindLower.includes('service') || kindLower.includes('ingress') || kindLower.includes('route') || kindLower.includes('gateway')) {
      detailKind.classList.add('badge-green');
    } else if (kindLower.includes('config') || kindLower.includes('secret')) {
      detailKind.classList.add('badge-gold');
    } else {
      detailKind.classList.add('badge-purple');
    }

    detailsPanel.classList.remove('hidden');
  }

  function hideDetails() {
    detailsPanel.classList.add('hidden');
  }

  // Event Listeners
  closePanelBtn.addEventListener('click', hideDetails);

  fitBtn.addEventListener('click', () => {
    if (network) {
      network.fit({ animation: true });
    }
  });

  layoutSelect.addEventListener('change', (e) => {
    currentLayout = e.target.value;
    if (network) {
      network.setOptions(getNetworkOptions());
      network.fit({ animation: true });
    }
  });

  // Handle messages from the extension host
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.type) {
      case 'update':
        filenameSpan.innerText = message.fileName;
        updateNetwork(message.nodes, message.edges);
        break;
    }
  });

  // Notify extension host that webview is ready
  vscode.postMessage({ command: 'ready' });
}());
