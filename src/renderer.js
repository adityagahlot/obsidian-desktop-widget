/* ═══════════════════════════════════════════════════════════════
   Obsidian Graph Widget – Renderer v4.1
   ═══════════════════════════════════════════════════════════════ */
const api = window.electronAPI;

// ── State ────────────────────────────────────────────────────────
let graphData     = null;
let simulation    = null;
let currentMode   = 'local';  // default: local graph
let selectedNode  = null;
let linkDepth     = 1;
let fontSize      = 9;
let nodeScale     = 1.0;
let showLabels    = true;
let isAlwaysOnTop = false;
let panelOpen     = false;
let focusTab      = 'backlinks';
let pinnedNodeId  = null;
let tooltipNodeId = null;
let currentTheme  = 'default';
let transform     = d3.zoomIdentity;
let searchResultIdx = -1;
let activeTags    = [];
let folderFilter  = '';
let orphansOnly   = false;
let colorBy       = 'theme';   // 'theme' | 'age' | 'length'
let panelOpacity  = 0.93;

// keep references to live d3 selections for label updates
let _labelSel = null;
let _linksCopy = [];
let _nodesCopy = [];
let _degreeFull = new Map();  // node id → degree across the whole vault
let _degreeView = new Map();  // node id → degree in the current view

function computeDegrees(links) {
  const m = new Map();
  for (const l of links) {
    const s = lid(l.source), t = lid(l.target);
    m.set(s, (m.get(s) || 0) + 1);
    m.set(t, (m.get(t) || 0) + 1);
  }
  return m;
}

// ── Elements ─────────────────────────────────────────────────────
const svg           = d3.select('#graph');
const graphRoot     = d3.select('#graph-root');
const linksLayer    = d3.select('#links-layer');
const nodesLayer    = d3.select('#nodes-layer');
const labelsLayer   = d3.select('#labels-layer');
const tooltip       = document.getElementById('tooltip');
const ttName        = document.getElementById('tt-name');
const ttMeta        = document.getElementById('tt-meta');
const ttTags        = document.getElementById('tt-tags');
const setupScreen   = document.getElementById('setup-screen');
const controlPanel  = document.getElementById('control-panel');
const panelTab      = document.getElementById('panel-tab');
const notePreview   = document.getElementById('note-preview');
const focusSidebar  = document.getElementById('focus-sidebar');
const focusNoteEl   = document.getElementById('focus-note-name');
const focusMetaEl   = document.getElementById('focus-note-meta');
const focusListEl   = document.getElementById('focus-list');
const statsEl       = document.getElementById('stats');
const fileSearch    = document.getElementById('file-search');
const searchResults = document.getElementById('search-results');
const briefMsg      = document.getElementById('brief-msg');
const parseProg     = document.getElementById('parse-progress');

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  const prefs = await api.loadPrefs();

  if (prefs.customColors) {
    customColors = { ...CC_DEFAULTS, ...prefs.customColors };
    syncColorInputs();
  }
  if (prefs.theme)    applyTheme(prefs.theme, false);
  if (prefs.mode)     { currentMode = prefs.mode; }
  if (prefs.fontSize) {
    fontSize = prefs.fontSize;
    document.getElementById('font-slider').value = fontSize;
    document.getElementById('font-val').textContent = fontSize + 'px';
  }
  if (prefs.nodeScale !== undefined) {
    nodeScale = prefs.nodeScale;
    document.getElementById('node-slider').value = nodeScale;
    document.getElementById('node-val').textContent = nodeScale.toFixed(1) + '×';
  }
  if (prefs.showLabels !== undefined) {
    showLabels = prefs.showLabels;
    syncToggle('toggle-labels', showLabels);
  }
  if (prefs.linkDepth) {
    linkDepth = prefs.linkDepth;
    document.getElementById('depth-slider').value = linkDepth;
    document.getElementById('depth-val').textContent = linkDepth;
  }
  if (prefs.colorBy) {
    colorBy = prefs.colorBy;
    document.getElementById('colorby-select').value = colorBy;
    updateHeatmapLegend();
  }
  if (prefs.panelOpacity !== undefined) {
    panelOpacity = prefs.panelOpacity;
    document.getElementById('opacity-slider').value = Math.round(panelOpacity * 100);
    document.getElementById('opacity-val').textContent = Math.round(panelOpacity * 100) + '%';
  }
  applyPanelOpacity();

  setActiveMode(currentMode);

  isAlwaysOnTop = await api.getAlwaysOnTop();
  syncToggle('toggle-top', isAlwaysOnTop);
  updatePinBtn();

  const startup = await api.getStartup();
  syncToggle('toggle-startup', startup);

  const vaultPath = await api.getVaultPath();
  if (vaultPath) {
    await loadAndDraw();
    populateFolderFilter();
    setupScreen.classList.add('hidden');
  }

  // Show configured hotkey
  api.getHotkey().then(a => { document.getElementById('hotkey-btn').textContent = prettyAccel(a); }).catch(() => {});

  // Silent update check on launch
  api.checkUpdate().then(upd => {
    if (upd?.newer) toast(`Update available: v${upd.latest} — see "Check for updates" in the panel`);
  }).catch(() => {});
}

function setActiveMode(mode) {
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  // note search: visible in local + focus
  document.getElementById('note-search-section').style.display = mode !== 'global' ? 'block' : 'none';
  // depth slider: only local
  document.getElementById('depth-section').style.display = mode === 'local' ? 'block' : 'none';
}

// ── Vault ─────────────────────────────────────────────────────────
async function loadAndDraw() {
  graphData = await api.loadGraph();
  if (!graphData) return;
  draw();
}

// ── Helpers ───────────────────────────────────────────────────────
function lid(x) { return typeof x === 'object' && x !== null ? x.id : x; }

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function bfsDepth(targetId, sourceId) {
  if (targetId === sourceId) return 0;
  const visited = new Set([sourceId]);
  let frontier = [sourceId], d = 0;
  while (frontier.length && d < 10) {
    d++;
    const next = [];
    for (const fid of frontier) {
      for (const l of (graphData.links || [])) {
        const s = lid(l.source), t = lid(l.target);
        const nb = s === fid ? t : t === fid ? s : null;
        if (nb && !visited.has(nb)) {
          if (nb === targetId) return d;
          visited.add(nb); next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return 99;
}

// ── Filters (tags / folder / orphans) ─────────────────────────────
function filteredGraph() {
  if (!graphData) return { nodes: [], links: [] };
  let nodes = graphData.nodes;

  if (folderFilter) {
    nodes = nodes.filter(n => n.id.startsWith(folderFilter + '/'));
  }
  if (activeTags.length) {
    nodes = nodes.filter(n =>
      activeTags.every(t => (n.tags || []).some(x => x === t || x.startsWith(t + '/')))
    );
  }
  if (orphansOnly) {
    // orphan = no links anywhere in the vault
    const linked = new Set();
    graphData.links.forEach(l => { linked.add(lid(l.source)); linked.add(lid(l.target)); });
    nodes = nodes.filter(n => !linked.has(n.id));
  }

  const ids = new Set(nodes.map(n => n.id));
  const links = graphData.links.filter(l => ids.has(lid(l.source)) && ids.has(lid(l.target)));
  return { nodes, links };
}

function filtersActive() {
  return !!(activeTags.length || folderFilter || orphansOnly);
}

// ── Data filter ───────────────────────────────────────────────────
function getDisplayData() {
  if (!graphData) return { nodes: [], links: [] };
  const now = Date.now(), week = 7 * 24 * 60 * 60 * 1000;
  const G = filteredGraph();

  if (currentMode === 'global') {
    return {
      nodes: G.nodes.map(n => ({ ...n, _recent: n.mtime > now - week, _role: 'normal' })),
      links: G.links
    };
  }

  if (!selectedNode) {
    // No note selected — show recent notes as a hint
    const recent = G.nodes
      .filter(n => n.mtime > now - week)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 25)
      .map(n => ({ ...n, _recent: true, _role: 'recent' }));
    return { nodes: recent, links: [] };
  }

  if (currentMode === 'local') {
    // BFS up to linkDepth layers
    const included = new Set([selectedNode.id]);
    let frontier = new Set([selectedNode.id]);
    for (let d = 0; d < linkDepth; d++) {
      const next = new Set();
      G.links.forEach(l => {
        const s = lid(l.source), t = lid(l.target);
        if (frontier.has(s) && !included.has(t)) { included.add(t); next.add(t); }
        if (frontier.has(t) && !included.has(s)) { included.add(s); next.add(s); }
      });
      frontier = next;
    }
    const nodesCopy = G.nodes.filter(n => included.has(n.id)).map(n => ({
      ...n,
      _role: n.id === selectedNode.id ? 'center' : 'neighbor',
      _recent: n.mtime > now - week,
      _depth: bfsDepth(n.id, selectedNode.id)
    }));
    const linksCopy = G.links.filter(l => included.has(lid(l.source)) && included.has(lid(l.target)));
    return { nodes: nodesCopy, links: linksCopy };
  }

  if (currentMode === 'focus') {
    const included = new Set([selectedNode.id]);
    const backlinkIds = new Set(), outlinkIds = new Set();
    G.links.forEach(l => {
      const s = lid(l.source), t = lid(l.target);
      if (t === selectedNode.id) { included.add(s); backlinkIds.add(s); }
      if (s === selectedNode.id) { included.add(t); outlinkIds.add(t); }
    });
    G.nodes.filter(n => n.mtime > now - week).forEach(n => included.add(n.id));

    const nodesCopy = G.nodes.filter(n => included.has(n.id)).map(n => {
      let role = 'recent';
      if (n.id === selectedNode.id)  role = 'center';
      else if (backlinkIds.has(n.id)) role = 'backlink';
      else if (outlinkIds.has(n.id))  role = 'outlink';
      return { ...n, _role: role, _recent: n.mtime > now - week };
    });
    const filteredLinks = G.links.filter(l => included.has(lid(l.source)) && included.has(lid(l.target)));
    return { nodes: nodesCopy, links: filteredLinks };
  }

  return { nodes: [], links: [] };
}

// ── Node styling ──────────────────────────────────────────────────
function nodeColor(d) {
  // Heatmap modes override category colors (center stays highlighted)
  if (colorBy === 'age' && d._role !== 'center') {
    const days = (Date.now() - d.mtime) / 86400000;
    const t = Math.min(1, Math.sqrt(days / 180)); // 0 = today … 1 = ≥6 months
    return d3.interpolateRgb(cssVar('--node-recent'), cssVar('--node-default'))(t);
  }
  if (colorBy === 'length' && d._role !== 'center') {
    const t = Math.min(1, Math.sqrt((d.wordCount || 0) / 2000)); // 1 = ≥2000 words
    return d3.interpolateRgb(cssVar('--node-default'), cssVar('--node-center'))(t);
  }
  if (d._role === 'center')   return cssVar('--node-center');
  if (d._role === 'backlink') return cssVar('--node-backlink');
  if (d._role === 'outlink')  return cssVar('--node-outlink');
  if (d._recent || d._role === 'recent') return cssVar('--node-recent');
  if (d.tags && d.tags.length > 0) return cssVar('--node-tagged');
  return cssVar('--node-default');
}

function nodeRadius(d) {
  const base = d._role === 'center' ? 9 : 3.5;
  const degree = _degreeFull.get(d.id) || 0;
  return Math.max(base, Math.min(13, base + degree * 0.55)) * nodeScale;
}

// ── Draw ──────────────────────────────────────────────────────────
function draw() {
  if (simulation) simulation.stop();

  _degreeFull = computeDegrees(graphData?.links || []);
  const { nodes, links } = getDisplayData();

  // Dedup links
  const seen = new Set();
  const dedupLinks = links.filter(l => {
    const k = [lid(l.source), lid(l.target)].sort().join('→');
    return seen.has(k) ? false : (seen.add(k), true);
  });

  const nodesCopy = nodes.map(n => ({ ...n }));
  const linksCopy = dedupLinks.map(l => ({ source: lid(l.source), target: lid(l.target) }));
  _nodesCopy = nodesCopy;
  _linksCopy = linksCopy;
  _degreeView = computeDegrees(linksCopy);

  const w = window.innerWidth, h = window.innerHeight;
  const isLocal = currentMode !== 'global';

  simulation = d3.forceSimulation(nodesCopy)
    .force('link', d3.forceLink(linksCopy).id(d => d.id)
      .distance(d => {
        if (!isLocal) return 60;
        const depth = nodesCopy.find(n => n.id === (d.source.id || d.source))?._depth || 0;
        return 120 + depth * 35;
      })
      .strength(isLocal ? 0.28 : 0.45))
    .force('charge', d3.forceManyBody()
      .strength(isLocal ? -280 : -60)
      .distanceMax(isLocal ? 700 : 320))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide()
      .radius(d => nodeRadius(d) + (isLocal ? 22 : 7))
      .iterations(isLocal ? 4 : 2))
    .alphaDecay(0.016)
    .velocityDecay(0.44);

  // ── Links ──
  const linkSel = linksLayer.selectAll('line')
    .data(linksCopy, d => `${d.source}-${d.target}`)
    .join(
      e => e.append('line')
             .attr('stroke', 'var(--link-base)')
             .attr('stroke-width', 1)
             .style('opacity', 0)
             .call(e2 => e2.transition().duration(350).style('opacity', 1)),
      u => u,
      x => x.transition().duration(200).style('opacity', 0).remove()
    );

  // ── Nodes ──
  const nodeSel = nodesLayer.selectAll('circle')
    .data(nodesCopy, d => d.id)
    .join(
      e => {
        const c = e.append('circle')
          .attr('r', 0)
          .attr('fill', d => nodeColor(d))
          .attr('cursor', 'pointer')
          .style('filter', d => d._role === 'center' ? 'url(#glow-a)' : d._recent ? 'url(#glow-b)' : 'none');
        c.transition().duration(300).attr('r', d => nodeRadius(d));
        return c;
      },
      u => u
        .attr('fill', d => nodeColor(d))
        .style('filter', d => d._role === 'center' ? 'url(#glow-a)' : d._recent ? 'url(#glow-b)' : 'none')
        .call(u2 => u2.transition().duration(250).attr('r', d => nodeRadius(d))),
      x => x.transition().duration(200).attr('r', 0).remove()
    );

  nodeSel
    .on('mouseenter', (event, d) => {
      if (pinnedNodeId) return;
      highlightNode(d, linkSel, nodeSel);
      showTooltip(event, d);
    })
    .on('mousemove', (event) => { if (!pinnedNodeId) positionTooltip(event); })
    .on('mouseleave', (event, d) => {
      if (pinnedNodeId) return;
      resetHighlight(linkSel, nodeSel, nodesCopy);
      tooltip.classList.remove('show');
    })
    .on('click', (event, d) => {
      event.stopPropagation();
      if (pinnedNodeId === d.id) {
        pinnedNodeId = null;
        tooltip.classList.remove('show');
        resetHighlight(linkSel, nodeSel, nodesCopy);
      } else {
        pinnedNodeId = d.id;
        highlightNode(d, linkSel, nodeSel);
        showTooltip(event, d);
        positionTooltip(event);
        if (currentMode !== 'global') {
          selectedNode = graphData.nodes.find(n => n.id === d.id);
          fileSearch.value = d.name;
          refreshFocusSidebar();
          if (currentMode === 'local') draw();
        }
      }
    })
    .call(d3.drag()
      .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; })
    );

  // ── Labels ──
  const labelSel = labelsLayer.selectAll('text')
    .data(nodesCopy, d => d.id)
    .join(
      e => e.append('text')
             .text(d => d.name)
             .attr('font-size', d => d._role === 'center' ? fontSize + 2 : fontSize)
             .attr('fill', d => d._role === 'center' ? 'rgba(196,181,253,0.95)' : 'rgba(255,255,255,0.62)')
             .attr('text-anchor', 'middle')
             .attr('pointer-events', 'none')
             .attr('dy', d => nodeRadius(d) + fontSize + 3)
             .style('opacity', 0)
             .call(e2 => e2.transition().delay(400).duration(350).style('opacity', 1)),
      u => u.text(d => d.name)
             .call(u2 => u2.transition().duration(250)
               .attr('font-size', d => d._role === 'center' ? fontSize + 2 : fontSize)
               .attr('dy', d => nodeRadius(d) + fontSize + 3)),
      x => x.transition().duration(200).style('opacity', 0).remove()
    );

  _labelSel = labelSel;

  // ── Tick ──
  let tickCount = 0;
  simulation.on('tick', () => {
    tickCount++;
    linkSel
      .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
    nodeSel.attr('cx', d => d.x).attr('cy', d => d.y);
    labelSel.attr('x', d => d.x).attr('y', d => d.y);

    // Overlap detection every 25 ticks (and at end)
    if (tickCount % 25 === 0) resolveLabels(labelSel, nodesCopy, linksCopy);
  });

  simulation.on('end', () => resolveLabels(labelSel, nodesCopy, linksCopy));

  // Stats
  statsEl.textContent = `${nodesCopy.length} notes · ${dedupLinks.length} links`;

  // Legend
  document.getElementById('leg-recent').style.display   = 'flex';
  document.getElementById('leg-backlink').style.display = currentMode === 'focus' ? 'flex' : 'none';
  document.getElementById('leg-outlink').style.display  = currentMode === 'focus' ? 'flex' : 'none';

  refreshFocusSidebar();
}

// ── Label overlap resolution ──────────────────────────────────────
function resolveLabels(labelSel, nodesCopy, linksCopy) {
  if (!showLabels) { labelSel.style('display', 'none'); return; }

  const sc = transform.k;
  const charW = fontSize * 0.56;
  const placed = [];
  const visible = new Set();

  // Priority order: center > high-degree > others (O(1) degree lookups)
  const sorted = [...nodesCopy].filter(d => d.x != null).sort((a, b) => {
    if (a._role === 'center') return -1;
    if (b._role === 'center') return 1;
    return (_degreeView.get(b.id) || 0) - (_degreeView.get(a.id) || 0);
  });

  for (const d of sorted) {
    // Decide if this node wants a label at current zoom
    const deg = _degreeView.get(d.id) || 0;
    const wants = d._role === 'center'
      || currentMode !== 'global'
      || sc > 1.4
      || (sc > 0.8 && deg >= 3)
      || (sc <= 0.8 && deg >= 5);
    if (!wants) continue;

    const tw = d.name.length * charW;
    const lx = d.x - tw / 2;
    const ly = d.y + nodeRadius(d) + 2;
    const box = { x1: lx - 2, y1: ly - 1, x2: lx + tw + 2, y2: ly + fontSize + 3 };

    const overlaps = placed.some(p =>
      box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1
    );

    if (!overlaps) { placed.push(box); visible.add(d.id); }
  }

  labelSel.style('display', d => visible.has(d.id) ? 'block' : 'none');
}

// ── Highlight ─────────────────────────────────────────────────────
function highlightNode(d, linkSel, nodeSel) {
  const connected = new Set([d.id]);
  linkSel.each(l => {
    if (lid(l.source) === d.id) connected.add(lid(l.target));
    if (lid(l.target) === d.id) connected.add(lid(l.source));
  });
  linkSel
    .attr('stroke', l => (lid(l.source) === d.id || lid(l.target) === d.id) ? 'var(--link-hot)' : 'var(--link-base)')
    .attr('stroke-width', l => (lid(l.source) === d.id || lid(l.target) === d.id) ? 2 : 1);
  nodeSel.attr('opacity', nd => connected.has(nd.id) ? 1 : 0.2);
  d3.select(nodeSel.nodes().find(el => d3.select(el).datum().id === d.id))
    .attr('r', nodeRadius(d) * 1.38).attr('fill', '#ede4ff');
}

function resetHighlight(linkSel, nodeSel, nodesCopy) {
  linkSel.attr('stroke', 'var(--link-base)').attr('stroke-width', 1);
  nodeSel.attr('opacity', 1).each(function(d) {
    d3.select(this).attr('r', nodeRadius(d)).attr('fill', nodeColor(d));
  });
}

// ── Tooltip ───────────────────────────────────────────────────────
function showTooltip(event, d) {
  tooltipNodeId = d.id;
  const now = Date.now();
  const daysAgo = Math.floor((now - d.mtime) / 86400000);
  const lc = _degreeView.get(d.id) || 0;

  ttName.textContent = d.name;
  ttMeta.innerHTML = [
    `${lc} link${lc !== 1 ? 's' : ''}`,
    d.wordCount ? `~${d.wordCount} words` : null,
    daysAgo === 0 ? 'edited today' : daysAgo < 7 ? `edited ${daysAgo}d ago` : null
  ].filter(Boolean).join(' · ');
  ttTags.innerHTML = (d.tags || []).slice(0, 5)
    .map(t => `<span class="tt-tag">#${t}</span>`).join('');

  tooltip.classList.add('show');
  positionTooltip(event);
}

function positionTooltip(event) {
  const r = document.getElementById('graph').getBoundingClientRect();
  // Default: right of cursor; flip left if near right edge; flip up if near bottom
  let x = event.clientX - r.left + 16;
  let y = event.clientY - r.top - 10;
  const tw = tooltip.offsetWidth || 230;
  const th = tooltip.offsetHeight || 120;
  if (x + tw > r.width - 10)  x = event.clientX - r.left - tw - 16;
  if (y + th > r.height - 10) y = event.clientY - r.top - th - 10;
  if (x < 10) x = 10;
  if (y < 10) y = 10;
  tooltip.style.left = x + 'px';
  tooltip.style.top  = y + 'px';
}

// Tooltip buttons
document.getElementById('tt-preview').addEventListener('click', e => {
  e.stopPropagation();
  if (tooltipNodeId) { openPreview(tooltipNodeId); pinnedNodeId = null; tooltip.classList.remove('show'); }
});
document.getElementById('tt-obsidian').addEventListener('click', async e => {
  e.stopPropagation();
  if (!tooltipNodeId) return;
  const ok = await api.openInObsidian(tooltipNodeId);
  if (!ok) toast('Obsidian not found — is it installed and has opened this vault at least once?');
});
document.getElementById('tt-explorer').addEventListener('click', async e => {
  e.stopPropagation();
  if (!tooltipNodeId) return;
  const ok = await api.openInExplorer(tooltipNodeId);
  if (!ok) toast('Could not open file location');
});

// Dismiss tooltip on outside click
document.addEventListener('click', e => {
  if (!tooltip.contains(e.target) && !e.target.closest('circle')) {
    pinnedNodeId = null;
    tooltip.classList.remove('show');
  }
});

// ── Note Preview (RIGHT panel) ────────────────────────────────────
async function openPreview(nodeId) {
  const node = graphData?.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const daysAgo = Math.floor((Date.now() - node.mtime) / 86400000);
  document.getElementById('preview-title').textContent = node.name;
  document.getElementById('preview-meta').textContent = [
    node.wordCount ? `${node.wordCount} words` : null,
    `edited ${daysAgo === 0 ? 'today' : daysAgo + 'd ago'}`,
    node.tags?.length ? node.tags.slice(0, 3).map(t => '#' + t).join(' ') : null
  ].filter(Boolean).join(' · ');

  const body = document.getElementById('preview-body');
  body.innerHTML = '<span style="color:var(--text-dim)">Loading…</span>';
  notePreview.classList.add('show');

  const raw = await api.readNote(nodeId);
  if (!raw) { body.textContent = '(empty note)'; return; }

  // Simple markdown render: headings, bold, italic, wikilinks, code
  const rendered = raw
    .replace(/^#{1,6} (.+)$/gm, (_, t) => `<b style="font-size:${fontSize + 2}px;color:var(--node-center);display:block;margin:4px 0 2px">${t}</b>`)
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-size:11px">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
      const label = alias || target;
      return `<span class="wikilink" data-target="${target}" style="color:var(--node-tagged);cursor:pointer;text-decoration:underline;text-decoration-color:rgba(125,211,252,0.4)">[[${label}]]</span>`;
    });

  body.innerHTML = rendered;

  // Wikilink navigation
  body.querySelectorAll('.wikilink').forEach(el => {
    el.addEventListener('click', () => {
      const target = el.dataset.target.trim().toLowerCase();
      const found = graphData.nodes.find(n => n.name.toLowerCase() === target);
      if (found) {
        selectedNode = found;
        fileSearch.value = found.name;
        draw();
        openPreview(found.id);
      } else {
        toast(`Note "${el.dataset.target}" not found in vault`);
      }
    });
  });

  // Wire action buttons
  document.getElementById('preview-obsidian').onclick = async () => {
    const ok = await api.openInObsidian(nodeId);
    if (!ok) toast('Could not open Obsidian — make sure it is installed and the vault has been opened in Obsidian at least once');
  };
  document.getElementById('preview-explorer').onclick = async () => {
    const ok = await api.openInExplorer(nodeId);
    if (!ok) toast('Could not open folder — file path may have changed');
  };
}

document.getElementById('preview-close').addEventListener('click', () => notePreview.classList.remove('show'));

// ── Focus Sidebar ─────────────────────────────────────────────────
function refreshFocusSidebar() {
  const show = currentMode === 'focus' && !!selectedNode;
  focusSidebar.classList.toggle('show', show);
  if (!show) return;

  focusNoteEl.textContent = selectedNode.name;
  const now = Date.now(), week = 7 * 24 * 60 * 60 * 1000;
  const d0 = Math.floor((now - selectedNode.mtime) / 86400000);
  focusMetaEl.textContent = `${selectedNode.wordCount || 0} words · ${d0 === 0 ? 'today' : d0 + 'd ago'}`;

  document.getElementById('focus-open-btn').onclick = () => api.openInObsidian(selectedNode.id);

  const backlinkIds = new Set(), outlinkIds = new Set();
  graphData.links.forEach(l => {
    const s = lid(l.source), t = lid(l.target);
    if (t === selectedNode.id) backlinkIds.add(s);
    if (s === selectedNode.id) outlinkIds.add(t);
  });

  let items = [];
  if (focusTab === 'backlinks') {
    items = [...backlinkIds]
      .map(id => graphData.nodes.find(n => n.id === id))
      .filter(Boolean).map(n => ({ ...n, _role: 'backlink' }))
      .sort((a, b) => b.mtime - a.mtime);
  } else if (focusTab === 'outlinks') {
    items = [...outlinkIds]
      .map(id => graphData.nodes.find(n => n.id === id))
      .filter(Boolean).map(n => ({ ...n, _role: 'outlink' }))
      .sort((a, b) => b.mtime - a.mtime);
  } else {
    items = graphData.nodes
      .filter(n => n.mtime > now - week && n.id !== selectedNode.id)
      .sort((a, b) => b.mtime - a.mtime).slice(0, 30)
      .map(n => ({ ...n, _role: 'recent' }));
  }

  const roleLabelMap = { backlink: 'BACKLINK', outlink: 'LINK OUT', recent: 'RECENT' };

  focusListEl.innerHTML = items.length
    ? items.map(n => {
        const da = Math.floor((now - n.mtime) / 86400000);
        return `<div class="focus-item" data-id="${n.id}">
          <div class="fi-badge ${n._role}">${roleLabelMap[n._role] || ''}</div>
          <div class="fi-name">${escapeHtml(n.name)}</div>
          <div class="fi-meta">${n.wordCount || 0}w · ${da === 0 ? 'today' : da + 'd ago'}${n.tags?.length ? ' · #' + n.tags[0] : ''}</div>
        </div>`;
      }).join('')
    : `<div style="padding:16px 12px;font-size:11px;color:var(--text-dim);text-align:center;line-height:1.6">
        No ${focusTab} found
      </div>`;

  focusListEl.querySelectorAll('.focus-item').forEach(el => {
    // Single click → navigate graph to this node
    el.addEventListener('click', () => {
      const node = graphData.nodes.find(n => n.id === el.dataset.id);
      if (!node) return;
      selectedNode = node;
      fileSearch.value = node.name;
      refreshFocusSidebar();
      draw();
    });
    // Click on name → open preview
    el.querySelector('.fi-name').addEventListener('click', e => {
      e.stopPropagation();
      openPreview(el.dataset.id);
    });
    // Double click → open in Obsidian
    el.addEventListener('dblclick', () => api.openInObsidian(el.dataset.id));
  });
}

document.querySelectorAll('.focus-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.focus-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    focusTab = tab.dataset.tab;
    refreshFocusSidebar();
  });
});

// ── Utilities ─────────────────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer = null;
function toast(msg) {
  briefMsg.textContent = msg;
  briefMsg.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => briefMsg.classList.remove('show'), 3500);
}

// ── Zoom & Pan ────────────────────────────────────────────────────
const zoom = d3.zoom().scaleExtent([0.1, 6])
  .on('zoom', e => {
    transform = e.transform;
    graphRoot.attr('transform', e.transform);
    // Refresh label visibility on zoom change
    if (_labelSel) resolveLabels(_labelSel, _nodesCopy, _linksCopy);
  });
svg.call(zoom);
svg.on('dblclick.zoom', null); // disable double-click zoom

// ── Panel ─────────────────────────────────────────────────────────
panelTab.addEventListener('click', () => {
  panelOpen = !panelOpen;
  controlPanel.classList.toggle('open', panelOpen);
  panelTab.style.left = panelOpen ? '240px' : '0';
});
document.getElementById('panel-close-btn').addEventListener('click', () => {
  panelOpen = false;
  controlPanel.classList.remove('open');
  panelTab.style.left = '0';
});

// ── Mode buttons ──────────────────────────────────────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentMode = btn.dataset.mode;
    setActiveMode(currentMode);
    if (currentMode === 'global') selectedNode = null;
    draw();
    savePrefs();
  });
});

// ── File search ───────────────────────────────────────────────────
fileSearch.addEventListener('input', () => {
  const q = fileSearch.value.toLowerCase().trim();
  searchResultIdx = -1;
  if (!q || !graphData) { searchResults.innerHTML = ''; return; }
  const matches = graphData.nodes.filter(n => n.name.toLowerCase().includes(q)).slice(0, 12);
  searchResults.innerHTML = matches.map(n =>
    `<div class="sr-item" data-id="${n.id}" data-name="${escapeHtml(n.name)}">${escapeHtml(n.name)}</div>`
  ).join('');
  searchResults.querySelectorAll('.sr-item').forEach(el =>
    el.addEventListener('click', () => pickNote(el.dataset.id, el.dataset.name))
  );
});

fileSearch.addEventListener('keydown', e => {
  const items = searchResults.querySelectorAll('.sr-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchResultIdx = Math.min(searchResultIdx + 1, items.length - 1);
    items.forEach((it, i) => it.classList.toggle('sel', i === searchResultIdx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchResultIdx = Math.max(searchResultIdx - 1, 0);
    items.forEach((it, i) => it.classList.toggle('sel', i === searchResultIdx));
  } else if (e.key === 'Enter') {
    const s = items[searchResultIdx] || items[0];
    if (s) pickNote(s.dataset.id, s.dataset.name);
  } else if (e.key === 'Escape') {
    searchResults.innerHTML = '';
  }
});

document.addEventListener('click', e => {
  if (!e.target.closest('#note-search-section')) searchResults.innerHTML = '';
});

function pickNote(id, name) {
  selectedNode = graphData.nodes.find(n => n.id === id);
  fileSearch.value = name;
  searchResults.innerHTML = '';
  draw();
}

// ── Sliders ───────────────────────────────────────────────────────
document.getElementById('depth-slider').addEventListener('input', e => {
  linkDepth = parseInt(e.target.value);
  document.getElementById('depth-val').textContent = linkDepth;
  if (currentMode === 'local') draw();
  savePrefs();
});

document.getElementById('font-slider').addEventListener('input', e => {
  fontSize = parseInt(e.target.value);
  document.getElementById('font-val').textContent = fontSize + 'px';
  if (_labelSel) {
    _labelSel
      .attr('font-size', d => d._role === 'center' ? fontSize + 2 : fontSize)
      .attr('dy', d => nodeRadius(d) + fontSize + 3);
  }
  savePrefs();
});

document.getElementById('node-slider').addEventListener('input', e => {
  nodeScale = parseFloat(e.target.value);
  document.getElementById('node-val').textContent = nodeScale.toFixed(1) + '×';
  if (graphData) draw();
  savePrefs();
});

// ── Themes ────────────────────────────────────────────────────────
const CC_DEFAULTS = {
  accent: '#7c3aed', default: '#7c7c7c', center: '#a78bfa',
  tagged: '#7dd3fc', recent: '#34d399', link: '#a78bfa'
};
let customColors = { ...CC_DEFAULTS };

// CSS vars driven by the custom pickers (others fall back to :root defaults)
const CC_VARS = [
  ['--accent',        c => c.accent],
  ['--accent-glow',   c => hexToRgba(c.accent, 0.3)],
  ['--focus-ring',    c => hexToRgba(c.accent, 0.5)],
  ['--tag-bg',        c => hexToRgba(c.accent, 0.18)],
  ['--tag-text',      c => c.center],
  ['--node-default',  c => c.default],
  ['--node-center',   c => c.center],
  ['--node-backlink', c => c.center],
  ['--node-tagged',   c => c.tagged],
  ['--node-outlink',  c => c.tagged],
  ['--node-recent',   c => c.recent],
  ['--link-hot',      c => hexToRgba(c.link, 0.55)],
  ['--link-base',     c => hexToRgba(c.link, 0.1)],
];

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function applyCustomColors() {
  const root = document.documentElement;
  CC_VARS.forEach(([v, fn]) => root.style.setProperty(v, fn(customColors)));
}

function clearCustomColors() {
  const root = document.documentElement;
  CC_VARS.forEach(([v]) => root.style.removeProperty(v));
}

function syncColorInputs() {
  for (const key of Object.keys(CC_DEFAULTS)) {
    const el = document.getElementById('cc-' + key);
    if (el) el.value = customColors[key];
  }
}

document.querySelectorAll('.theme-dot').forEach(dot =>
  dot.addEventListener('click', () => applyTheme(dot.dataset.theme))
);

function applyTheme(name, save = true) {
  currentTheme = name;
  if (name === 'custom') {
    document.documentElement.dataset.theme = '';
    applyCustomColors();
  } else {
    clearCustomColors();
    document.documentElement.dataset.theme = name === 'default' ? '' : name;
  }
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.theme === name));
  document.getElementById('custom-colors').classList.toggle('show', name === 'custom');
  applyPanelOpacity();
  updateHeatmapLegend();
  if (graphData) draw();
  if (save) savePrefs();
}

// Color picker wiring: edit → apply live + switch to custom theme
for (const key of Object.keys(CC_DEFAULTS)) {
  const el = document.getElementById('cc-' + key);
  if (!el) continue;
  el.addEventListener('input', () => {
    customColors[key] = el.value;
    if (currentTheme !== 'custom') applyTheme('custom', false);
    else applyCustomColors();
    if (graphData) draw();
  });
  el.addEventListener('change', () => savePrefs());
}

document.getElementById('cc-reset').addEventListener('click', () => {
  customColors = { ...CC_DEFAULTS };
  syncColorInputs();
  applyCustomColors();
  if (graphData) draw();
  savePrefs();
});

// ── Toggles ───────────────────────────────────────────────────────
function syncToggle(id, state) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('on', state);
}

document.getElementById('toggle-labels').addEventListener('click', function() {
  showLabels = !this.classList.contains('on');
  this.classList.toggle('on', showLabels);
  if (!showLabels) {
    labelsLayer.selectAll('text').style('display', 'none');
  } else if (_labelSel) {
    resolveLabels(_labelSel, _nodesCopy, _linksCopy);
  }
  savePrefs();
});

document.getElementById('toggle-top').addEventListener('click', async function() {
  isAlwaysOnTop = !this.classList.contains('on');
  this.classList.toggle('on', isAlwaysOnTop);
  await api.toggleAlwaysOnTop(isAlwaysOnTop);
  updatePinBtn();
});

document.getElementById('toggle-startup').addEventListener('click', async function() {
  const newVal = !this.classList.contains('on');
  this.classList.toggle('on', newVal);
  const ok = await api.setStartup(newVal);
  if (newVal) toast('Widget will launch on startup (using Windows login items)');
});

// ── Corner buttons ────────────────────────────────────────────────
document.getElementById('close-btn').addEventListener('click', () => api.closeApp());
document.getElementById('minimize-btn').addEventListener('click', () => api.minimizeApp());

// ── Fullscreen ────────────────────────────────────────────────────
let isFullscreen = false;

function updateFullscreenBtn() {
  const btn = document.getElementById('fullscreen-btn');
  btn.classList.toggle('on', isFullscreen);
  btn.title = isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen (Esc to exit)';
}

document.getElementById('fullscreen-btn').addEventListener('click', async () => {
  isFullscreen = await api.toggleFullscreen();
  updateFullscreenBtn();
});

// Stay in sync if fullscreen changes from elsewhere
api.onFullscreenChange(v => { isFullscreen = v; updateFullscreenBtn(); });

// Esc exits fullscreen (unless a hotkey is being recorded)
document.addEventListener('keydown', async e => {
  if (e.key === 'Escape' && isFullscreen && !recordingHotkey) {
    isFullscreen = await api.toggleFullscreen();
    updateFullscreenBtn();
  }
});

document.getElementById('pin-btn').addEventListener('click', async () => {
  isAlwaysOnTop = !isAlwaysOnTop;
  await api.toggleAlwaysOnTop(isAlwaysOnTop);
  syncToggle('toggle-top', isAlwaysOnTop);
  updatePinBtn();
});

function updatePinBtn() {
  const btn = document.getElementById('pin-btn');
  btn.classList.toggle('on', isAlwaysOnTop);
  btn.title = isAlwaysOnTop ? 'Always on top: ON — click to return to desktop layer' : 'Always on top: OFF — click to float above all windows';
  btn.style.opacity = isAlwaysOnTop ? '1' : '0.45';
  btn.style.filter  = isAlwaysOnTop ? 'none' : 'grayscale(0.6)';
}

document.getElementById('refresh-btn').addEventListener('click', async () => {
  await loadAndDraw();
  populateFolderFilter();
});

// ── Tag / folder / orphan filters ─────────────────────────────────
const tagInput = document.getElementById('tag-filter-input');
const tagSuggestions = document.getElementById('tag-suggestions');
const activeTagsEl = document.getElementById('active-tags');

function allVaultTags() {
  const s = new Set();
  (graphData?.nodes || []).forEach(n => (n.tags || []).forEach(t => s.add(t)));
  return [...s].sort();
}

function renderTagChips() {
  activeTagsEl.innerHTML = activeTags.map(t =>
    `<div class="tag-chip">#${escapeHtml(t)}<span data-tag="${escapeHtml(t)}">✕</span></div>`
  ).join('');
  activeTagsEl.querySelectorAll('.tag-chip span').forEach(x =>
    x.addEventListener('click', () => {
      activeTags = activeTags.filter(t => t !== x.dataset.tag);
      renderTagChips(); draw();
    })
  );
}

tagInput.addEventListener('input', () => {
  const q = tagInput.value.toLowerCase().replace(/^#/, '').trim();
  if (!q) { tagSuggestions.innerHTML = ''; return; }
  const matches = allVaultTags()
    .filter(t => t.toLowerCase().includes(q) && !activeTags.includes(t))
    .slice(0, 10);
  tagSuggestions.innerHTML = matches.map(t =>
    `<div class="sr-item" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</div>`
  ).join('');
  tagSuggestions.querySelectorAll('.sr-item').forEach(el =>
    el.addEventListener('click', () => {
      activeTags.push(el.dataset.tag);
      tagInput.value = ''; tagSuggestions.innerHTML = '';
      renderTagChips(); draw();
    })
  );
});

tagInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const first = tagSuggestions.querySelector('.sr-item');
    if (first) { first.dispatchEvent(new Event('click')); }
  } else if (e.key === 'Escape') tagSuggestions.innerHTML = '';
});

document.addEventListener('click', e => {
  if (!e.target.closest('#filter-section')) tagSuggestions.innerHTML = '';
});

function populateFolderFilter() {
  const sel = document.getElementById('folder-filter');
  const folders = new Set();
  (graphData?.nodes || []).forEach(n => {
    const idx = n.id.indexOf('/');
    if (idx > 0) folders.add(n.id.slice(0, idx));
  });
  const current = folderFilter;
  sel.innerHTML = '<option value="">All folders</option>' +
    [...folders].sort().map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}/</option>`).join('');
  sel.value = [...folders].includes(current) ? current : '';
}

document.getElementById('folder-filter').addEventListener('change', e => {
  folderFilter = e.target.value;
  draw();
});

document.getElementById('toggle-orphans').addEventListener('click', function() {
  orphansOnly = !this.classList.contains('on');
  this.classList.toggle('on', orphansOnly);
  draw();
  if (orphansOnly) toast('Showing notes without any links');
});

// ── Color-by (heatmap) ────────────────────────────────────────────
function updateHeatmapLegend() {
  const leg = document.getElementById('heatmap-legend');
  const grad = document.getElementById('heatmap-gradient');
  leg.classList.toggle('show', colorBy !== 'theme');
  if (colorBy === 'age') {
    grad.style.background = `linear-gradient(90deg, ${cssVar('--node-recent')}, ${cssVar('--node-default')})`;
    document.getElementById('hm-left').textContent = 'new';
    document.getElementById('hm-right').textContent = 'old';
  } else if (colorBy === 'length') {
    grad.style.background = `linear-gradient(90deg, ${cssVar('--node-default')}, ${cssVar('--node-center')})`;
    document.getElementById('hm-left').textContent = 'short';
    document.getElementById('hm-right').textContent = 'long';
  }
}

document.getElementById('colorby-select').addEventListener('change', e => {
  colorBy = e.target.value;
  updateHeatmapLegend();
  draw();
  savePrefs();
});

// ── Panel opacity ─────────────────────────────────────────────────
function applyPanelOpacity() {
  const root = document.documentElement;
  root.style.removeProperty('--panel');
  const base = getComputedStyle(root).getPropertyValue('--panel').trim();
  const m = base.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (m) root.style.setProperty('--panel', `rgba(${m[1]},${m[2]},${m[3]},${panelOpacity})`);
}

document.getElementById('opacity-slider').addEventListener('input', e => {
  panelOpacity = parseInt(e.target.value) / 100;
  document.getElementById('opacity-val').textContent = e.target.value + '%';
  applyPanelOpacity();
  savePrefs();
});

// ── PNG export ────────────────────────────────────────────────────
document.getElementById('export-btn').addEventListener('click', async () => {
  if (!graphData) { toast('Nothing to export yet'); return; }
  try {
    const svgEl = document.getElementById('graph');
    const clone = svgEl.cloneNode(true);

    // Resolve CSS variables into concrete attributes
    const orig = svgEl.querySelectorAll('circle, line, text');
    const copy = clone.querySelectorAll('circle, line, text');
    orig.forEach((el, i) => {
      const cs = getComputedStyle(el);
      const c = copy[i];
      c.setAttribute('fill', cs.fill);
      c.setAttribute('stroke', cs.stroke);
      c.setAttribute('stroke-width', cs.strokeWidth);
      c.setAttribute('opacity', cs.opacity);
      if (el.tagName === 'text') {
        c.setAttribute('font-size', cs.fontSize);
        c.setAttribute('font-family', 'Segoe UI, sans-serif');
        if (cs.display === 'none') c.remove();
      }
    });

    const w = svgEl.clientWidth, h = svgEl.clientHeight;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
    clone.setAttribute('width', w * 2);
    clone.setAttribute('height', h * 2);

    const ser = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej;
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(ser)));
    });

    const canvas = document.createElement('canvas');
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0d0d12';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const ok = await api.exportPng(canvas.toDataURL('image/png'));
    if (ok) toast('Graph exported as PNG');
  } catch (e) {
    toast('Export failed: ' + e.message);
  }
});

// ── Update check ──────────────────────────────────────────────────
document.getElementById('update-btn').addEventListener('click', async () => {
  toast('Checking for updates…');
  const upd = await api.checkUpdate();
  if (!upd) { toast('Could not reach GitHub (offline? repo not set?)'); return; }
  if (upd.newer) {
    toast(`Update available: v${upd.latest} (current v${upd.current}) — opening release page`);
    api.openUrl(upd.url);
  } else {
    toast(`Up to date (v${upd.current})`);
  }
});

// ── Parse progress (only shown for large vaults to avoid flashing) ─
api.onParseProgress(({ done, total }) => {
  if (!total || total < 150 || done >= total) {
    parseProg.classList.remove('show');
    return;
  }
  parseProg.textContent = `Parsing vault… ${done} / ${total}`;
  parseProg.classList.add('show');
});

// ── Live refresh on vault changes ─────────────────────────────────
api.onVaultChanged(async () => {
  await loadAndDraw();
  populateFolderFilter();
  toast('Vault changed — graph refreshed');
});

// ── Hotkey remap ──────────────────────────────────────────────────
const hotkeyBtn = document.getElementById('hotkey-btn');
let recordingHotkey = false;

function prettyAccel(a) { return (a || '').replace('Control', 'Ctrl').replace('CommandOrControl', 'Ctrl'); }

hotkeyBtn.addEventListener('click', () => {
  if (recordingHotkey) return;
  recordingHotkey = true;
  hotkeyBtn.textContent = 'Press keys… (Esc cancels)';
});

const KEY_MAP = { ' ': 'Space', 'ArrowUp': 'Up', 'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right' };
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

document.addEventListener('keydown', async e => {
  if (!recordingHotkey) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    recordingHotkey = false;
    hotkeyBtn.textContent = prettyAccel(await api.getHotkey());
    return;
  }
  if (MODIFIER_KEYS.has(e.key)) return; // wait for the actual key

  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (!mods.length) { toast('Hotkey needs at least one modifier (Ctrl/Alt/Shift)'); return; }

  let key = KEY_MAP[e.key] || e.key;
  if (key.length === 1) key = key.toUpperCase();

  const accel = [...mods, key].join('+');
  const ok = await api.setHotkey(accel);
  recordingHotkey = false;
  hotkeyBtn.textContent = prettyAccel(ok ? accel : await api.getHotkey());
  toast(ok ? `Hotkey set: ${prettyAccel(accel)}` : 'Could not register that combination (in use by another app?)');
}, true);

document.getElementById('vault-btn').addEventListener('click', async () => {
  const p = await api.selectVault();
  if (p) { setupScreen.classList.add('hidden'); await loadAndDraw(); }
});

document.getElementById('select-vault-btn').addEventListener('click', async () => {
  const p = await api.selectVault();
  if (p) { await loadAndDraw(); setupScreen.classList.add('hidden'); }
});

// ── Prefs ─────────────────────────────────────────────────────────
function savePrefs() {
  api.savePrefs({ theme: currentTheme, fontSize, nodeScale, showLabels, mode: currentMode, linkDepth, customColors, colorBy, panelOpacity });
}

// ── Resize ────────────────────────────────────────────────────────
new ResizeObserver(() => {
  if (simulation) {
    simulation.force('center', d3.forceCenter(window.innerWidth / 2, window.innerHeight / 2));
    simulation.alpha(0.2).restart();
  }
}).observe(document.body);

// ── Boot ─────────────────────────────────────────────────────────
init();
