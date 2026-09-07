/** Paints `diagram` JSON fences. */

const DIAGRAM_TYPES = [
  "architecture",
  "it-state",
  "flowchart",
  "sequence",
  "state",
  "er",
  "timeline",
  "swimlane",
  "quadrant",
  "radar",
  "loop",
  "nested",
  "tree",
  "org-chart",
  "layers",
  "venn",
  "pyramid",
  "bar",
  "line",
  "gantt",
  "scatter",
  "high-level",
  "process",
  "medallion",
  "data-flow",
  "dp-integration",
  "dp-security-matrix",
] as const;

export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export type DNode = {
  id: string;
  label: string;
  sub?: string;
  kind?: string;
  lane?: string;
  parent?: string;
  group?: string;
  value?: number;
  x?: number;
  y?: number;
  start?: number;
  end?: number;
  items?: string[];
};

export type DEdge = {
  from: string;
  to: string;
  label?: string;
  kind?: string;
};

export type DiagramSpec = {
  type: DiagramType;
  title?: string;
  subtitle?: string;
  nodes: DNode[];
  edges: DEdge[];
  axes?: { x?: string; y?: string; items?: string[] };
  sets?: { label: string; items: string[] }[];
  hub?: DNode;
  layers?: { label: string; items?: string[] }[];
  series?: { label: string; values?: number[]; points?: { x: number; y: number }[] }[];
  categories?: string[];
  tasks?: DNode[];
};

const TYPE_ALIAS: Record<string, DiagramType> = {
  arch: "architecture",
  architecture: "architecture",
  "it-state": "it-state",
  it_state: "it-state",
  "it-current-state": "it-state",
  currentstate: "it-state",
  flow: "flowchart",
  flowchart: "flowchart",
  "flow-chart": "flowchart",
  seq: "sequence",
  sequence: "sequence",
  statediagram: "state",
  "state-machine": "state",
  statemachine: "state",
  state: "state",
  er: "er",
  "er-diagram": "er",
  entity: "er",
  timeline: "timeline",
  swimlane: "swimlane",
  "swim-lane": "swimlane",
  quadrant: "quadrant",
  "2x2": "quadrant",
  radar: "radar",
  spider: "radar",
  loop: "loop",
  flywheel: "loop",
  nested: "nested",
  tree: "tree",
  org: "org-chart",
  orgchart: "org-chart",
  "org-chart": "org-chart",
  layers: "layers",
  layer: "layers",
  "layer-stack": "layers",
  venn: "venn",
  pyramid: "pyramid",
  funnel: "pyramid",
  bar: "bar",
  "bar-chart": "bar",
  line: "line",
  "line-chart": "line",
  gantt: "gantt",
  scatter: "scatter",
  "high-level": "high-level",
  highlevel: "high-level",
  process: "process",
  medallion: "medallion",
  "data-flow": "data-flow",
  dataflow: "data-flow",
  "dp-integration": "dp-integration",
  integration: "dp-integration",
  "dp-security-matrix": "dp-security-matrix",
  "security-matrix": "dp-security-matrix",
  matrix: "dp-security-matrix",
};

export function isEditorialLang(lang?: string): boolean {
  const name = (lang || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
  return name === "diagram" || name === "grotesque" || name === "gdiagram";
}

export function diagramFences(
  text: string,
): { type: DiagramType; title: string }[] {
  const out: { type: DiagramType; title: string }[] = [];
  const re = /```(?:diagram|grotesque|gdiagram)[^\n]*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const spec = parseDiagram(m[1] || "");
    if (!spec) continue;
    out.push({
      type: spec.type,
      title: spec.title || diagramTypeLabel(spec.type),
    });
  }
  return out;
}

export function isDiagramTypeHunt(query: string): boolean {
  const parts = query
    .split(/[|,]/)
    .map((s) => s.trim().toLowerCase().replace(/[\s_]+/g, "-"))
    .filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((p) => !!TYPE_ALIAS[p]);
}

export function isPainterPath(path: string): boolean {
  return /(^|\/)diagrams\.ts$/i.test(path.replace(/\\/g, "/"));
}

export function diagramTypeLabel(type: string): string {
  return type.replace(/-/g, " ");
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return undefined;
}

function slug(label: string, i: number): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || `n${i + 1}`;
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter(Boolean);
}

function asNode(item: unknown, i: number): DNode {
  if (typeof item === "string") {
    return { id: slug(item, i), label: item };
  }
  const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const label = str(o.label ?? o.name ?? o.title ?? o.id) || `N${i + 1}`;
  const items = asStringList(o.items ?? o.fields ?? o.children);
  return {
    id: str(o.id) || slug(label, i),
    label,
    sub: str(o.sub ?? o.subtitle ?? o.detail ?? o.desc) || undefined,
    kind: str(o.kind ?? o.role ?? o.tone) || undefined,
    lane: str(o.lane ?? o.actor ?? o.row ?? o.role) || undefined,
    parent: str(o.parent) || undefined,
    group: str(o.group ?? o.zone ?? o.column ?? o.col) || undefined,
    value: num(o.value ?? o.v ?? o.score),
    x: num(o.x),
    y: num(o.y),
    start: num(o.start ?? o.from ?? o.begin),
    end: num(o.end ?? o.to),
    items: items.length ? items : undefined,
  };
}

function asNodes(raw: unknown): DNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(asNode);
}

function asEdge(item: unknown): DEdge | null {
  if (typeof item === "string") {
    const m = item.split(/\s*->\s*/);
    if (m.length >= 2) {
      return { from: m[0].trim(), to: m[1].trim(), label: m[2]?.trim() };
    }
    return null;
  }
  const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const from = str(o.from ?? o.source ?? o.src ?? o.a);
  const to = str(o.to ?? o.target ?? o.dst ?? o.b);
  if (!from || !to) return null;
  return {
    from,
    to,
    label: str(o.label ?? o.name) || undefined,
    kind: str(o.kind ?? o.tone) || undefined,
  };
}

function asEdges(raw: unknown): DEdge[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(asEdge).filter((e): e is DEdge => !!e);
}

function asSets(raw: unknown): { label: string; items: string[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    if (typeof item === "string") return { label: item, items: [] };
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      label: str(o.label ?? o.name) || `Set ${i + 1}`,
      items: asStringList(o.items ?? o.members),
    };
  });
}

function asLayers(raw: unknown): { label: string; items?: string[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    if (typeof item === "string") return { label: item };
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const items = asStringList(o.items ?? o.nodes);
    return {
      label: str(o.label ?? o.name) || `Layer ${i + 1}`,
      items: items.length ? items : undefined,
    };
  });
}

function asSeries(
  raw: unknown,
): { label: string; values?: number[]; points?: { x: number; y: number }[] }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, i) => {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const values = Array.isArray(o.values)
      ? o.values.map((v) => num(v) ?? 0)
      : undefined;
    const points = Array.isArray(o.points)
      ? o.points
          .map((p) => {
            const q = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
            return { x: num(q.x) ?? 0, y: num(q.y) ?? 0 };
          })
      : undefined;
    return {
      label: str(o.label ?? o.name) || `S${i + 1}`,
      values,
      points,
    };
  });
}

function inferType(o: Record<string, unknown>): DiagramType {
  if (o.hub) return "loop";
  if (Array.isArray(o.sets)) return "venn";
  if (Array.isArray(o.tasks)) return "gantt";
  if (Array.isArray(o.layers)) return "layers";
  if (Array.isArray(o.series) && Array.isArray(o.categories)) return "line";
  if (Array.isArray(o.series)) return "bar";
  if (o.axes && typeof o.axes === "object") return "quadrant";
  return "architecture";
}

function extractJson(text: string): unknown | null {
  const raw = text.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = raw.slice(start, end + 1);
    try {
      return JSON.parse(slice);
    } catch {
      try {
        return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parseDiagram(text: string): DiagramSpec | null {
  const data = extractJson(text);
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  const typeKey = str(o.type ?? o.kind ?? o.diagram)
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const type = TYPE_ALIAS[typeKey] || inferType(o);
  const nodes = asNodes(o.nodes ?? o.items ?? o.entities ?? o.events ?? o.steps);
  const tasks = asNodes(o.tasks);
  const edges = asEdges(o.edges ?? o.links ?? o.arrows ?? o.connections);
  const hubRaw = o.hub;
  const hub =
    hubRaw && typeof hubRaw === "object" ? asNode(hubRaw, 0) : undefined;
  const spec: DiagramSpec = {
    type,
    title: str(o.title) || undefined,
    subtitle: str(o.subtitle ?? o.caption) || undefined,
    nodes,
    edges,
    axes:
      o.axes && typeof o.axes === "object"
        ? {
            x: str((o.axes as Record<string, unknown>).x) || undefined,
            y: str((o.axes as Record<string, unknown>).y) || undefined,
            items: asStringList((o.axes as Record<string, unknown>).items),
          }
        : undefined,
    sets: asSets(o.sets),
    hub,
    layers: asLayers(o.layers),
    series: asSeries(o.series),
    categories: asStringList(o.categories ?? o.labels),
    tasks: tasks.length ? tasks : undefined,
  };
  return spec;
}

type Box = {
  id: string;
  label: string;
  sub?: string;
  kind?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: "rect" | "diamond" | "round";
};

const PAPER = "var(--diagram-paper)";
const INK = "var(--diagram-ink)";
const MUTED = "var(--diagram-muted)";
const RULE = "var(--diagram-rule)";
const ACCENT = "var(--accent)";
const TINT = "var(--diagram-accent-tint)";
const STORE = "var(--diagram-store)";
const FONT = "var(--font)";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

function snap(n: number): number {
  return Math.round(n / 4) * 4;
}

function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function textW(s: string, size: number): number {
  return Math.ceil([...s].length * size * 0.62);
}

function boxSize(n: DNode, minW = 96): { w: number; h: number } {
  const labelW = textW(n.label, 12);
  const subW = n.sub ? textW(n.sub, 9) : 0;
  const w = snap(clamp(Math.max(labelW, subW) + 24, minW, 200));
  const h = snap(n.sub ? 56 : 44);
  return { w, h };
}

let drawSeq = 0;

function look(kind?: string): {
  fill: string;
  stroke: string;
  dash?: string;
} {
  const k = (kind || "").toLowerCase();
  if (k === "focal" || k === "accent") {
    return { fill: TINT, stroke: ACCENT };
  }
  if (k === "store" || k === "db" || k === "state") {
    return { fill: STORE, stroke: MUTED };
  }
  if (k === "external" || k === "cloud") {
    return { fill: PAPER, stroke: MUTED, dash: "4 3" };
  }
  if (k === "input" || k === "user") {
    return { fill: STORE, stroke: MUTED };
  }
  if (k === "optional" || k === "async") {
    return { fill: PAPER, stroke: MUTED, dash: "4 3" };
  }
  return { fill: PAPER, stroke: INK };
}

function drawBox(b: Box): string {
  const { fill, stroke, dash } = look(b.kind);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
  const rx = b.shape === "round" ? b.h / 2 : 6;
  if (b.shape === "diamond") {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const pts = `${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}`;
    return (
      `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
      labelText(b)
    );
  }
  return (
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" fill="${PAPER}"/>` +
    `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1"${dashAttr}/>` +
    labelText(b)
  );
}

function labelText(b: Box): string {
  const cx = b.x + b.w / 2;
  const hasSub = !!b.sub;
  const ly = hasSub ? b.y + b.h / 2 - 6 : b.y + b.h / 2 + 4;
  let s =
    `<text x="${cx}" y="${ly}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(clip(b.label, b.w))}</text>`;
  if (b.sub) {
    s += `<text x="${cx}" y="${ly + 14}" fill="${MUTED}" font-size="9" font-family="${MONO}" text-anchor="middle">${esc(clip(b.sub, b.w))}</text>`;
  }
  return s;
}

function clip(s: string, w: number): string {
  const max = Math.max(4, Math.floor((w - 16) / 7.4));
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function port(
  a: Box,
  b: Box,
): { x1: number; y1: number; x2: number; y2: number } {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return {
      x1: dx >= 0 ? a.x + a.w : a.x,
      y1: acy,
      x2: dx >= 0 ? b.x : b.x + b.w,
      y2: bcy,
    };
  }
  return {
    x1: acx,
    y1: dy >= 0 ? a.y + a.h : a.y,
    x2: bcx,
    y2: dy >= 0 ? b.y : b.y + b.h,
  };
}

function ortho(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const sx1 = snap(x1);
  const sy1 = snap(y1);
  const sx2 = snap(x2);
  const sy2 = snap(y2);
  if (sx1 === sx2 || sy1 === sy2) {
    return `M${sx1} ${sy1} L${sx2} ${sy2}`;
  }
  const mx = snap((sx1 + sx2) / 2);
  return `M${sx1} ${sy1} L${mx} ${sy1} L${mx} ${sy2} L${sx2} ${sy2}`;
}

function drawEdge(
  a: Box,
  b: Box,
  e: DEdge,
  uid: string,
): string {
  const p = port(a, b);
  const accent = e.kind === "accent" || e.kind === "focal";
  const link = e.kind === "link";
  const color = accent ? ACCENT : link ? "var(--diagram-link)" : MUTED;
  const mark = accent ? `${uid}-aa` : `${uid}-a`;
  const d = ortho(p.x1, p.y1, p.x2, p.y2);
  let s = `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.2" marker-end="url(#${mark})"/>`;
  if (e.label) {
    const mx = snap((p.x1 + p.x2) / 2);
    const my = snap((p.y1 + p.y2) / 2) - 10;
    const lw = textW(e.label.toUpperCase(), 8) + 8;
    s +=
      `<rect x="${mx - lw / 2}" y="${my - 8}" width="${lw}" height="12" rx="2" fill="${PAPER}"/>` +
      `<text x="${mx}" y="${my + 2}" fill="${MUTED}" font-size="8" font-family="${MONO}" text-anchor="middle" letter-spacing="0.06em">${esc(e.label.toUpperCase())}</text>`;
  }
  return s;
}

function wrapSvg(
  w: number,
  h: number,
  title: string,
  body: string,
): string {
  const uid = `ed${++drawSeq}`;
  const vw = Math.max(snap(w), 160);
  const vh = Math.max(snap(h), 80);
  return (
    `<svg class="editorial-svg" viewBox="0 0 ${vw} ${vh}" width="100%" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>` +
    `<defs>` +
    `<marker id="${uid}-a" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">` +
    `<polygon points="0 0, 8 3, 0 6" fill="${MUTED}"/>` +
    `</marker>` +
    `<marker id="${uid}-aa" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">` +
    `<polygon points="0 0, 8 3, 0 6" fill="${ACCENT}"/>` +
    `</marker>` +
    `</defs>` +
    body +
    `</svg>`
  );
}

function heading(title: string | undefined, subtitle: string | undefined): {
  h: number;
  svg: string;
} {
  if (!title && !subtitle) return { h: 12, svg: "" };
  let y = 20;
  let s = "";
  if (title) {
    s += `<text x="16" y="${y}" fill="${INK}" font-size="16" font-weight="600" font-family="${FONT}">${esc(title)}</text>`;
    y += 20;
  }
  if (subtitle) {
    s += `<text x="16" y="${y}" fill="${MUTED}" font-size="12" font-family="${FONT}">${esc(subtitle)}</text>`;
    y += 16;
  }
  return { h: y + 8, svg: s };
}

function ensureNodes(spec: DiagramSpec): DNode[] {
  if (spec.nodes.length) return spec.nodes.slice(0, 12);
  if (spec.tasks?.length) return spec.tasks.slice(0, 12);
  if (spec.layers?.length) {
    return spec.layers.map((l, i) => ({ id: slug(l.label, i), label: l.label }));
  }
  if (spec.sets?.length) {
    return spec.sets.map((s, i) => ({
      id: slug(s.label, i),
      label: s.label,
      items: s.items,
    }));
  }
  return [{ id: "n1", label: spec.title || "Diagram" }];
}

function mapBoxes(boxes: Box[]): Map<string, Box> {
  return new Map(boxes.map((b) => [b.id, b]));
}

function paintGraph(
  spec: DiagramSpec,
  boxes: Box[],
  padR = 24,
  padB = 24,
): string {
  const head = heading(spec.title, spec.subtitle);
  const shifted = boxes.map((b) => ({ ...b, y: b.y + Math.max(0, head.h - 12) }));
  const by = mapBoxes(shifted);
  const uid = `g${drawSeq + 1}`;
  const edges = spec.edges
    .map((e) => {
      const a = by.get(e.from);
      const b = by.get(e.to);
      if (!a || !b) return "";
      return drawEdge(a, b, e, uid);
    })
    .join("");
  const maxX = Math.max(240, ...shifted.map((b) => b.x + b.w));
  const maxY = Math.max(80, ...shifted.map((b) => b.y + b.h));
  return wrapSvg(
    maxX + padR,
    maxY + padB,
    spec.title || spec.type,
    head.svg + edges + shifted.map(drawBox).join(""),
  );
}

function gridPlace(
  nodes: DNode[],
  originX: number,
  originY: number,
  gapX = 40,
  gapY = 32,
  cols?: number,
): Box[] {
  const c = cols ?? Math.min(3, Math.max(1, Math.ceil(Math.sqrt(nodes.length))));
  let colW = 140;
  const sizes = nodes.map((n) => boxSize(n));
  colW = Math.max(colW, ...sizes.map((s) => s.w));
  const rowH = Math.max(56, ...sizes.map((s) => s.h));
  return nodes.map((n, i) => {
    const { w, h } = sizes[i];
    const col = i % c;
    const row = Math.floor(i / c);
    return {
      id: n.id,
      label: n.label,
      sub: n.sub,
      kind: n.kind,
      x: snap(originX + col * (colW + gapX)),
      y: snap(originY + row * (rowH + gapY)),
      w,
      h,
    };
  });
}

function ranksOf(nodes: DNode[], edges: DEdge[]): DNode[][] {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const n of nodes) {
    incoming.set(n.id, 0);
    outs.set(n.id, []);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue;
    incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    outs.get(e.from)?.push(e.to);
  }
  const roots = nodes.filter((n) => (incoming.get(n.id) || 0) === 0);
  const start = roots.length ? roots : [nodes[0]];
  const seen = new Set<string>();
  const layers: DNode[][] = [];
  let wave = start;
  while (wave.length) {
    const layer: DNode[] = [];
    for (const n of wave) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      layer.push(n);
    }
    if (!layer.length) break;
    layers.push(layer);
    const next: DNode[] = [];
    for (const n of layer) {
      for (const id of outs.get(n.id) || []) {
        if (!seen.has(id)) {
          const node = nodes.find((x) => x.id === id);
          if (node) next.push(node);
        }
      }
    }
    wave = next;
  }
  for (const n of nodes) {
    if (!seen.has(n.id)) {
      layers.push([n]);
      seen.add(n.id);
    }
  }
  return layers;
}

function layoutFlow(spec: DiagramSpec, vertical: boolean): Box[] {
  const nodes = ensureNodes(spec);
  const layers = ranksOf(nodes, spec.edges);
  const boxes: Box[] = [];
  const sizes = new Map(nodes.map((n) => [n.id, boxSize(n)]));
  if (vertical) {
    let y = 20;
    for (const layer of layers) {
      let x = 24;
      for (const n of layer) {
        const { w, h } = sizes.get(n.id)!;
        const decision =
          n.kind === "decision" ||
          /\?$/.test(n.label) ||
          (spec.edges.filter((e) => e.from === n.id).length >= 2 &&
            spec.type === "flowchart");
        boxes.push({
          id: n.id,
          label: n.label,
          sub: n.sub,
          kind: n.kind,
          x: snap(x),
          y: snap(y),
          w: decision ? Math.max(w, 112) : w,
          h: decision ? Math.max(h, 64) : h,
          shape: decision ? "diamond" : "rect",
        });
        x += w + 32;
      }
      y += 96;
    }
  } else {
    let x = 24;
    for (const layer of layers) {
      let y = 20;
      const colW = Math.max(...layer.map((n) => sizes.get(n.id)!.w));
      for (const n of layer) {
        const { w, h } = sizes.get(n.id)!;
        boxes.push({
          id: n.id,
          label: n.label,
          sub: n.sub,
          kind: n.kind,
          x: snap(x),
          y: snap(y),
          w,
          h,
        });
        y += h + 28;
      }
      x += colW + 56;
    }
  }
  return boxes;
}

function childrenMap(nodes: DNode[], edges: DEdge[]): Map<string, DNode[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, DNode[]>();
  for (const n of nodes) kids.set(n.id, []);
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent)) {
      kids.get(n.parent)!.push(n);
    }
  }
  if ([...kids.values()].some((k) => k.length)) return kids;
  for (const e of edges) {
    if (byId.has(e.from) && byId.has(e.to)) {
      kids.get(e.from)!.push(byId.get(e.to)!);
    }
  }
  return kids;
}

function rootsOf(nodes: DNode[], kids: Map<string, DNode[]>): DNode[] {
  const childIds = new Set<string>();
  for (const list of kids.values()) for (const c of list) childIds.add(c.id);
  const roots = nodes.filter((n) => !childIds.has(n.id));
  return roots.length ? roots : nodes.slice(0, 1);
}

function layoutTree(spec: DiagramSpec, cardH?: number): Box[] {
  const nodes = ensureNodes(spec);
  const kids = childrenMap(nodes, spec.edges);
  const sizes = new Map(nodes.map((n) => [n.id, boxSize(n)]));
  const pos = new Map<string, { x: number; y: number }>();
  const gapX = 24;
  const gapY = 36;
  let nextX = 24;

  const walk = (n: DNode, depth: number): number => {
    const ch = kids.get(n.id) || [];
    const { w, h } = sizes.get(n.id)!;
    const y = 20 + depth * ((cardH ?? h) + gapY);
    if (!ch.length) {
      const x = nextX;
      pos.set(n.id, { x, y });
      nextX += w + gapX;
      return x + w / 2;
    }
    const centers = ch.map((c) => walk(c, depth + 1));
    const cx = (centers[0] + centers[centers.length - 1]) / 2;
    const x = cx - w / 2;
    pos.set(n.id, { x: Math.max(16, x), y });
    return cx;
  };

  for (const r of rootsOf(nodes, kids)) walk(r, 0);
  for (const n of nodes) {
    if (!pos.has(n.id)) {
      pos.set(n.id, { x: nextX, y: 20 });
      nextX += (sizes.get(n.id)?.w ?? 120) + gapX;
    }
  }
  return nodes.map((n) => {
    const { w, h } = sizes.get(n.id)!;
    const p = pos.get(n.id)!;
    return {
      id: n.id,
      label: n.label,
      sub: n.sub,
      kind: n.kind,
      x: snap(p.x),
      y: snap(p.y),
      w,
      h: cardH ?? h,
    };
  });
}

function unique(values: (string | undefined)[]): string[] {
  return [...new Set(values.map((v) => (v || "").trim()).filter(Boolean))];
}

function drawArchitecture(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const groups = unique(nodes.map((n) => n.group));
  if (groups.length >= 2) {
    const boxes: Box[] = [];
    let x = 24;
    for (const g of groups) {
      const col = nodes.filter((n) => n.group === g);
      const colBoxes = gridPlace(col, x, 48, 24, 20, 1);
      boxes.push(...colBoxes);
      const colW = Math.max(...colBoxes.map((b) => b.w), 100);
      x += colW + 56;
    }
    return paintGraph(spec, boxes);
  }
  return paintGraph(spec, layoutFlow(spec, false));
}

function drawItState(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  let groups = unique(nodes.map((n) => n.group));
  if (groups.length < 2) {
    const labels = ["Legacy", "Current", "Target"];
    groups = labels.slice(0, Math.min(3, Math.max(2, nodes.length)));
    nodes.forEach((n, i) => {
      n.group = groups[i % groups.length];
    });
  }
  const head = heading(spec.title, spec.subtitle);
  let x = 24;
  const boxes: Box[] = [];
  const labels: string[] = [];
  for (const g of groups) {
    const col = nodes.filter((n) => n.group === g);
    const colBoxes = gridPlace(col, x, head.h + 28, 20, 16, 1);
    boxes.push(...colBoxes);
    labels.push(
      `<text x="${x}" y="${head.h + 12}" fill="${MUTED}" font-size="10" font-family="${MONO}" letter-spacing="0.12em">${esc(g.toUpperCase())}</text>`,
    );
    const colW = Math.max(120, ...colBoxes.map((b) => b.w));
    x += colW + 48;
  }
  const by = mapBoxes(boxes);
  const uid = `it${drawSeq + 1}`;
  const edges = spec.edges
    .map((e) => {
      const a = by.get(e.from);
      const b = by.get(e.to);
      if (!a || !b) return "";
      return drawEdge(a, b, e, uid);
    })
    .join("");
  const w = x;
  const h = Math.max(160, ...boxes.map((b) => b.y + b.h)) + 24;
  return wrapSvg(
    w,
    h,
    spec.title || "IT current-state",
    head.svg + labels.join("") + edges + boxes.map(drawBox).join(""),
  );
}

function drawSequence(spec: DiagramSpec): string {
  const actors = ensureNodes(spec);
  const msgs = spec.edges.length
    ? spec.edges
    : actors.slice(1).map((n, i) => ({
        from: actors[i].id,
        to: n.id,
        label: n.sub || "",
      }));
  const colW = 140;
  const head = heading(spec.title, spec.subtitle);
  const top = head.h + 8;
  const boxes: Box[] = actors.map((n, i) => {
    const { w, h } = boxSize(n);
    return {
      id: n.id,
      label: n.label,
      sub: n.sub,
      kind: n.kind,
      x: snap(24 + i * colW + (colW - w) / 2),
      y: snap(top),
      w,
      h,
    };
  });
  const by = mapBoxes(boxes);
  const lifeTop = top + 52;
  const lifeBot = lifeTop + Math.max(4, msgs.length) * 36 + 16;
  let s = head.svg + boxes.map(drawBox).join("");
  for (const b of boxes) {
    const cx = b.x + b.w / 2;
    s += `<line x1="${cx}" y1="${b.y + b.h}" x2="${cx}" y2="${lifeBot}" stroke="${RULE}" stroke-width="1" stroke-dasharray="4 3"/>`;
  }
  const uid = `seq${drawSeq + 1}`;
  msgs.forEach((e, i) => {
    const a = by.get(e.from);
    const b = by.get(e.to);
    if (!a || !b) return;
    const y = snap(lifeTop + 20 + i * 36);
    const x1 = a.x + a.w / 2;
    const x2 = b.x + b.w / 2;
    const color = "kind" in e && e.kind === "accent" ? ACCENT : MUTED;
    const mark = "kind" in e && e.kind === "accent" ? `${uid}-aa` : `${uid}-a`;
    s += `<path d="M${x1} ${y} L${x2} ${y}" fill="none" stroke="${color}" stroke-width="1.2" marker-end="url(#${mark})"/>`;
    if (e.label) {
      const mx = (x1 + x2) / 2;
      s += `<text x="${mx}" y="${y - 6}" fill="${MUTED}" font-size="8" font-family="${MONO}" text-anchor="middle">${esc(e.label)}</text>`;
    }
  });
  return wrapSvg(
    24 + actors.length * colW,
    lifeBot + 16,
    spec.title || "Sequence",
    s,
  );
}

function drawEr(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const boxes: Box[] = [];
  let x = 24;
  let y = 20;
  let rowH = 0;
  nodes.forEach((n, i) => {
    const fields = n.items?.length ? n.items : n.sub ? [n.sub] : [];
    const w = snap(clamp(Math.max(textW(n.label, 12), ...fields.map((f) => textW(f, 10))) + 28, 128, 200));
    const h = snap(32 + fields.length * 18 + 12);
    if (x + w > 640 && i > 0) {
      x = 24;
      y += rowH + 28;
      rowH = 0;
    }
    boxes.push({
      id: n.id,
      label: n.label,
      kind: n.kind,
      x,
      y,
      w,
      h,
    });
    rowH = Math.max(rowH, h);
    x += w + 36;
  });
  const head = heading(spec.title, spec.subtitle);
  const shifted = boxes.map((b) => ({ ...b, y: b.y + head.h }));
  const by = mapBoxes(shifted);
  const uid = `er${drawSeq + 1}`;
  let s = head.svg;
  s += spec.edges
    .map((e) => {
      const a = by.get(e.from);
      const b = by.get(e.to);
      if (!a || !b) return "";
      return drawEdge(a, b, e, uid);
    })
    .join("");
  for (const n of nodes) {
    const b = by.get(n.id);
    if (!b) continue;
    const { fill, stroke } = look(n.kind);
    const fields = n.items?.length ? n.items : n.sub ? [n.sub] : [];
    s +=
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6" fill="${PAPER}"/>` +
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="28" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
      `<rect x="${b.x}" y="${b.y + 16}" width="${b.w}" height="${b.h - 16}" fill="${PAPER}" stroke="${stroke}" stroke-width="1"/>` +
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="28" fill="${fill}"/>` +
      `<text x="${b.x + b.w / 2}" y="${b.y + 18}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(clip(n.label, b.w))}</text>`;
    fields.forEach((f, i) => {
      s += `<text x="${b.x + 10}" y="${b.y + 46 + i * 18}" fill="${MUTED}" font-size="10" font-family="${MONO}">${esc(clip(f, b.w - 16))}</text>`;
    });
  }
  const w = Math.max(280, ...shifted.map((b) => b.x + b.w)) + 24;
  const h = Math.max(120, ...shifted.map((b) => b.y + b.h)) + 24;
  return wrapSvg(w, h, spec.title || "ER", s);
}

function drawTimeline(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const head = heading(spec.title, spec.subtitle);
  const y = head.h + 48;
  const left = 32;
  const right = Math.max(560, 80 + nodes.length * 100);
  let s = head.svg;
  s += `<line x1="${left}" y1="${y}" x2="${right - 24}" y2="${y}" stroke="${MUTED}" stroke-width="1.2"/>`;
  nodes.forEach((n, i) => {
    const x = left + 16 + i * ((right - left - 48) / Math.max(1, nodes.length - 1 || 1));
    const focal = n.kind === "focal";
    s +=
      `<circle cx="${x}" cy="${y}" r="5" fill="${focal ? ACCENT : PAPER}" stroke="${focal ? ACCENT : INK}" stroke-width="1.2"/>` +
      `<text x="${x}" y="${y - 16}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(n.label)}</text>`;
    if (n.sub) {
      s += `<text x="${x}" y="${y + 20}" fill="${MUTED}" font-size="9" font-family="${MONO}" text-anchor="middle">${esc(n.sub)}</text>`;
    }
  });
  return wrapSvg(right, y + 40, spec.title || "Timeline", s);
}

function drawSwimlane(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  let lanes = unique(nodes.map((n) => n.lane));
  if (!lanes.length) lanes = ["Flow"];
  const cols = Math.max(
    3,
    ...lanes.map((ln) => nodes.filter((n) => (n.lane || lanes[0]) === ln).length),
    spec.edges.length + 1,
  );
  const head = heading(spec.title, spec.subtitle);
  const laneH = 88;
  const colW = 148;
  const left = 108;
  let s = head.svg;
  lanes.forEach((ln, i) => {
    const y = head.h + i * laneH;
    s +=
      `<rect x="16" y="${y}" width="${left - 24 + cols * colW}" height="${laneH}" fill="${i % 2 ? STORE : "transparent"}" stroke="${RULE}" stroke-width="1"/>` +
      `<text x="24" y="${y + laneH / 2 + 4}" fill="${MUTED}" font-size="10" font-family="${MONO}" letter-spacing="0.08em">${esc(ln.toUpperCase())}</text>`;
  });
  const boxes: Box[] = [];
  const used = new Map<string, number>();
  for (const n of nodes) {
    const ln = n.lane || lanes[0];
    const li = Math.max(0, lanes.indexOf(ln));
    const step = used.get(ln) ?? 0;
    used.set(ln, step + 1);
    const { w, h } = boxSize(n);
    boxes.push({
      id: n.id,
      label: n.label,
      sub: n.sub,
      kind: n.kind,
      x: snap(left + step * colW),
      y: snap(head.h + li * laneH + (laneH - h) / 2),
      w,
      h,
    });
  }
  const by = mapBoxes(boxes);
  const uid = `sw${drawSeq + 1}`;
  s += spec.edges
    .map((e) => {
      const a = by.get(e.from);
      const b = by.get(e.to);
      if (!a || !b) return "";
      return drawEdge(a, b, e, uid);
    })
    .join("");
  s += boxes.map(drawBox).join("");
  return wrapSvg(
    left + cols * colW + 16,
    head.h + lanes.length * laneH + 16,
    spec.title || "Swimlane",
    s,
  );
}

function unit(v: number | undefined): number {
  if (v == null) return 0.5;
  return v > 1 ? clamp(v / 100, 0, 1) : clamp(v, 0, 1);
}

function drawQuadrant(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const head = heading(spec.title, spec.subtitle);
  const x0 = 56;
  const y0 = head.h + 16;
  const size = 280;
  const midX = x0 + size / 2;
  const midY = y0 + size / 2;
  const xLabel = spec.axes?.x || "X";
  const yLabel = spec.axes?.y || "Y";
  let s = head.svg;
  s +=
    `<rect x="${x0}" y="${y0}" width="${size}" height="${size}" fill="${PAPER}" stroke="${RULE}" stroke-width="1"/>` +
    `<line x1="${midX}" y1="${y0}" x2="${midX}" y2="${y0 + size}" stroke="${RULE}" stroke-width="1"/>` +
    `<line x1="${x0}" y1="${midY}" x2="${x0 + size}" y2="${midY}" stroke="${RULE}" stroke-width="1"/>` +
    `<text x="${x0 + size / 2}" y="${y0 + size + 20}" fill="${MUTED}" font-size="10" font-family="${MONO}" text-anchor="middle">${esc(xLabel)}</text>` +
    `<text x="${x0 - 12}" y="${y0 + size / 2}" fill="${MUTED}" font-size="10" font-family="${MONO}" text-anchor="middle" transform="rotate(-90 ${x0 - 12} ${y0 + size / 2})">${esc(yLabel)}</text>`;
  nodes.forEach((n, i) => {
    const px = x0 + 16 + unit(n.x ?? (i % 2 === 0 ? 0.25 : 0.75)) * (size - 32);
    const py = y0 + size - 16 - unit(n.y ?? (i < nodes.length / 2 ? 0.75 : 0.25)) * (size - 32);
    const focal = n.kind === "focal";
    s +=
      `<circle cx="${px}" cy="${py}" r="4" fill="${focal ? ACCENT : INK}"/>` +
      `<text x="${px + 8}" y="${py + 4}" fill="${INK}" font-size="11" font-weight="600" font-family="${FONT}">${esc(n.label)}</text>`;
  });
  return wrapSvg(x0 + size + 40, y0 + size + 36, spec.title || "Quadrant", s);
}

function drawRadar(spec: DiagramSpec): string {
  const axes =
    spec.axes?.items?.length
      ? spec.axes.items
      : ensureNodes(spec).map((n) => n.label);
  const n = Math.max(3, Math.min(8, axes.length));
  const series = spec.series?.length
    ? spec.series
    : [
        {
          label: spec.title || "Score",
          values: ensureNodes(spec).map((node) => unit(node.value)),
        },
      ];
  const head = heading(spec.title, spec.subtitle);
  const cx = 180;
  const cy = head.h + 140;
  const r = 100;
  let s = head.svg;
  for (let ring = 1; ring <= 4; ring++) {
    const rr = (r * ring) / 4;
    const pts = Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`;
    }).join(" ");
    s += `<polygon points="${pts}" fill="none" stroke="${RULE}" stroke-width="1"/>`;
  }
  axes.slice(0, n).forEach((label, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const x = cx + (r + 18) * Math.cos(a);
    const y = cy + (r + 18) * Math.sin(a);
    s +=
      `<line x1="${cx}" y1="${cy}" x2="${cx + r * Math.cos(a)}" y2="${cy + r * Math.sin(a)}" stroke="${RULE}" stroke-width="1"/>` +
      `<text x="${x}" y="${y}" fill="${INK}" font-size="10" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(label)}</text>`;
  });
  series.forEach((ser, si) => {
    const vals = ser.values || [];
    const pts = Array.from({ length: n }, (_, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      const v = unit(vals[i] ?? 0.4);
      return `${cx + r * v * Math.cos(a)},${cy + r * v * Math.sin(a)}`;
    }).join(" ");
    const fill = si === 0 ? TINT : "transparent";
    const stroke = si === 0 ? ACCENT : MUTED;
    s += `<polygon points="${pts}" fill="${fill}" fill-opacity="0.7" stroke="${stroke}" stroke-width="1.4"/>`;
  });
  return wrapSvg(360, cy + r + 36, spec.title || "Radar", s);
}

function drawLoop(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const hub = spec.hub || {
    id: "hub",
    label: "Hub",
    kind: "focal",
  };
  const head = heading(spec.title, spec.subtitle);
  const cx = 210;
  const cy = head.h + 150;
  const r = 120;
  const hubBox: Box = {
    id: hub.id,
    label: hub.label,
    sub: hub.sub,
    kind: hub.kind || "focal",
    x: cx - 48,
    y: cy - 28,
    w: 96,
    h: 56,
    shape: "round",
  };
  const boxes: Box[] = nodes.map((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / nodes.length;
    const { w, h } = boxSize(n);
    return {
      id: n.id,
      label: n.label,
      sub: n.sub,
      kind: n.kind,
      x: snap(cx + r * Math.cos(a) - w / 2),
      y: snap(cy + r * Math.sin(a) - h / 2),
      w,
      h,
    };
  });
  const cycle =
    spec.edges.length > 0
      ? spec.edges
      : nodes.map((n, i) => ({
          from: n.id,
          to: nodes[(i + 1) % nodes.length].id,
        }));
  const all = [hubBox, ...boxes];
  const by = mapBoxes(all);
  const uid = `lp${drawSeq + 1}`;
  let s = head.svg;
  s += cycle
    .map((e) => {
      const a = by.get(e.from);
      const b = by.get(e.to);
      if (!a || !b) return "";
      return drawEdge(a, b, e, uid);
    })
    .join("");
  if (!spec.edges.length) {
    for (const b of boxes) {
      s += drawEdge(hubBox, b, { from: hub.id, to: b.id, kind: "accent" }, uid);
    }
  }
  s += all.map(drawBox).join("");
  return wrapSvg(420, cy + r + 48, spec.title || "Loop", s);
}

function drawNested(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const kids = childrenMap(nodes, spec.edges);
  const roots = rootsOf(nodes, kids);
  type Frame = { n: DNode; x: number; y: number; w: number; h: number };
  const frames: Frame[] = [];

  const measure = (n: DNode): { w: number; h: number } => {
    const ch = kids.get(n.id) || [];
    if (!ch.length) {
      const s = boxSize(n);
      return { w: s.w + 16, h: s.h + 20 };
    }
    const inner = ch.map(measure);
    const w = Math.max(boxSize(n).w, ...inner.map((c) => c.w)) + 24;
    const h = 36 + inner.reduce((a, c) => a + c.h + 8, 0) + 8;
    return { w: snap(w), h: snap(h) };
  };

  const place = (n: DNode, x: number, y: number) => {
    const size = measure(n);
    frames.push({ n, x, y, w: size.w, h: size.h });
    let iy = y + 32;
    for (const c of kids.get(n.id) || []) {
      const cs = measure(c);
      place(c, x + 12, iy);
      iy += cs.h + 8;
    }
  };

  const head = heading(spec.title, spec.subtitle);
  let x = 16;
  for (const r of roots) {
    place(r, x, head.h);
    x += measure(r).w + 16;
  }
  let s = head.svg;
  const depth = new Map<string, number>();
  const walkD = (n: DNode, d: number) => {
    depth.set(n.id, d);
    for (const c of kids.get(n.id) || []) walkD(c, d + 1);
  };
  for (const r of roots) walkD(r, 0);
  for (const f of frames) {
    const d = depth.get(f.n.id) || 0;
    const { fill, stroke } = look(f.n.kind || (d === 0 ? "store" : "step"));
    s +=
      `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1"/>` +
      `<text x="${f.x + 12}" y="${f.y + 18}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}">${esc(f.n.label)}</text>`;
  }
  const w = Math.max(240, ...frames.map((f) => f.x + f.w)) + 16;
  const h = Math.max(120, ...frames.map((f) => f.y + f.h)) + 16;
  return wrapSvg(w, h, spec.title || "Nested", s);
}

function drawLayers(spec: DiagramSpec): string {
  const layers =
    spec.layers?.length
      ? spec.layers
      : ensureNodes(spec).map((n) => ({
          label: n.label,
          items: n.items,
        }));
  const head = heading(spec.title, spec.subtitle);
  const w = 440;
  let s = head.svg;
  layers.forEach((layer, i) => {
    const y = head.h + i * 64;
    const focal = i === 0;
    s +=
      `<rect x="20" y="${y}" width="${w - 40}" height="56" rx="6" fill="${focal ? TINT : PAPER}" stroke="${focal ? ACCENT : INK}" stroke-width="1"/>` +
      `<text x="36" y="${y + 24}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}">${esc(layer.label)}</text>`;
    if (layer.items?.length) {
      s += `<text x="36" y="${y + 42}" fill="${MUTED}" font-size="10" font-family="${MONO}">${esc(layer.items.join(" - "))}</text>`;
    }
  });
  return wrapSvg(w, head.h + layers.length * 64 + 8, spec.title || "Layers", s);
}

function drawVenn(spec: DiagramSpec): string {
  const sets =
    spec.sets && spec.sets.length >= 2
      ? spec.sets.slice(0, 3)
      : ensureNodes(spec)
          .slice(0, 3)
          .map((n) => ({ label: n.label, items: n.items || [] }));
  while (sets.length < 2) sets.push({ label: `Set ${sets.length + 1}`, items: [] });
  const head = heading(spec.title, spec.subtitle);
  const cy = head.h + 110;
  let s = head.svg;
  if (sets.length === 2) {
    s +=
      `<circle cx="150" cy="${cy}" r="80" fill="${TINT}" fill-opacity="0.55" stroke="${ACCENT}" stroke-width="1.2"/>` +
      `<circle cx="250" cy="${cy}" r="80" fill="${STORE}" fill-opacity="0.7" stroke="${INK}" stroke-width="1"/>` +
      `<text x="120" y="${cy - 92}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(sets[0].label)}</text>` +
      `<text x="280" y="${cy - 92}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(sets[1].label)}</text>`;
  } else {
    s +=
      `<circle cx="180" cy="${cy - 16}" r="76" fill="${TINT}" fill-opacity="0.45" stroke="${ACCENT}" stroke-width="1.2"/>` +
      `<circle cx="240" cy="${cy - 16}" r="76" fill="${STORE}" fill-opacity="0.55" stroke="${INK}" stroke-width="1"/>` +
      `<circle cx="210" cy="${cy + 40}" r="76" fill="${PAPER}" fill-opacity="0.5" stroke="${MUTED}" stroke-width="1"/>` +
      `<text x="150" y="${cy - 100}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}">${esc(sets[0].label)}</text>` +
      `<text x="250" y="${cy - 100}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}">${esc(sets[1].label)}</text>` +
      `<text x="210" y="${cy + 128}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(sets[2].label)}</text>`;
  }
  sets.forEach((set, i) => {
    if (!set.items?.length) return;
    s += `<text x="24" y="${cy + 140 + i * 16}" fill="${MUTED}" font-size="10" font-family="${MONO}">${esc(set.label)}: ${esc(set.items.join(", "))}</text>`;
  });
  return wrapSvg(400, cy + 140 + sets.length * 16 + 12, spec.title || "Venn", s);
}

function drawPyramid(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const head = heading(spec.title, spec.subtitle);
  const top = head.h + 8;
  const maxW = 360;
  const h = 48;
  let s = head.svg;
  nodes.forEach((n, i) => {
    const t = i / Math.max(1, nodes.length);
    const w = 120 + t * (maxW - 120);
    const x = (400 - w) / 2;
    const y = top + i * (h + 8);
    const focal = n.kind === "focal" || i === 0;
    const x1 = x;
    const x2 = x + w;
    const inset = 16;
    s +=
      `<polygon points="${x1 + inset},${y} ${x2 - inset},${y} ${x2},${y + h} ${x1},${y + h}" fill="${focal ? TINT : PAPER}" stroke="${focal ? ACCENT : INK}" stroke-width="1"/>` +
      `<text x="200" y="${y + 30}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}" text-anchor="middle">${esc(n.label)}</text>`;
  });
  return wrapSvg(400, top + nodes.length * 56 + 8, spec.title || "Pyramid", s);
}

function drawBar(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const cats = spec.categories?.length
    ? spec.categories
    : nodes.map((n) => n.label);
  const values =
    spec.series?.[0]?.values ||
    nodes.map((n, i) => n.value ?? (nodes.length - i) * 3);
  const max = Math.max(1, ...values);
  const head = heading(spec.title, spec.subtitle);
  const base = head.h + 180;
  const left = 40;
  const bw = 28;
  const gap = 20;
  let s = head.svg;
  s += `<line x1="${left}" y1="${base}" x2="${left + cats.length * (bw + gap)}" y2="${base}" stroke="${RULE}" stroke-width="1"/>`;
  cats.forEach((c, i) => {
    const v = values[i] ?? 0;
    const bh = (v / max) * 140;
    const x = left + i * (bw + gap);
    const focal = i === values.indexOf(Math.max(...values));
    s +=
      `<rect x="${x}" y="${base - bh}" width="${bw}" height="${bh}" rx="3" fill="${focal ? ACCENT : STORE}" stroke="${focal ? ACCENT : MUTED}" stroke-width="1"/>` +
      `<text x="${x + bw / 2}" y="${base + 16}" fill="${MUTED}" font-size="9" font-family="${MONO}" text-anchor="middle">${esc(c)}</text>`;
  });
  return wrapSvg(
    left + cats.length * (bw + gap) + 24,
    base + 32,
    spec.title || "Bar",
    s,
  );
}

function drawLine(spec: DiagramSpec): string {
  const cats =
    spec.categories?.length
      ? spec.categories
      : ensureNodes(spec).map((n) => n.label);
  const series = spec.series?.length
    ? spec.series
    : [
        {
          label: "Value",
          values: ensureNodes(spec).map((n, i) => n.value ?? i + 1),
        },
      ];
  const all = series.flatMap((s) => s.values || []);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const head = heading(spec.title, spec.subtitle);
  const left = 40;
  const top = head.h + 16;
  const width = Math.max(280, (cats.length - 1) * 48);
  const height = 160;
  const base = top + height;
  const xAt = (i: number) =>
    left + (cats.length <= 1 ? width / 2 : (i / (cats.length - 1)) * width);
  const yAt = (v: number) =>
    base - ((v - min) / (max - min || 1)) * height;
  let s = head.svg;
  s +=
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${base}" stroke="${RULE}" stroke-width="1"/>` +
    `<line x1="${left}" y1="${base}" x2="${left + width}" y2="${base}" stroke="${RULE}" stroke-width="1"/>`;
  cats.forEach((c, i) => {
    s += `<text x="${xAt(i)}" y="${base + 16}" fill="${MUTED}" font-size="9" font-family="${MONO}" text-anchor="middle">${esc(c)}</text>`;
  });
  series.forEach((ser, si) => {
    const vals = ser.values || [];
    const pts = vals
      .map((v, i) => `${xAt(i)},${yAt(v)}`)
      .join(" ");
    const color = si === 0 ? ACCENT : MUTED;
    s += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/>`;
    vals.forEach((v, i) => {
      s += `<circle cx="${xAt(i)}" cy="${yAt(v)}" r="3" fill="${PAPER}" stroke="${color}" stroke-width="1.2"/>`;
    });
  });
  return wrapSvg(left + width + 24, base + 32, spec.title || "Line", s);
}

function drawGantt(spec: DiagramSpec): string {
  const tasks = (spec.tasks?.length ? spec.tasks : ensureNodes(spec)).slice(0, 12);
  const maxEnd = Math.max(
    1,
    ...tasks.map((t, i) => t.end ?? (t.start ?? i) + 2),
  );
  const head = heading(spec.title, spec.subtitle);
  const left = 120;
  const rowH = 28;
  const width = 360;
  let s = head.svg;
  tasks.forEach((t, i) => {
    const y = head.h + 8 + i * rowH;
    const start = t.start ?? i;
    const end = t.end ?? start + 2;
    const x = left + (start / maxEnd) * width;
    const w = Math.max(8, ((end - start) / maxEnd) * width);
    const focal = t.kind === "focal";
    s +=
      `<text x="16" y="${y + 16}" fill="${INK}" font-size="11" font-weight="600" font-family="${FONT}">${esc(clip(t.label, 100))}</text>` +
      `<rect x="${x}" y="${y + 6}" width="${w}" height="16" rx="3" fill="${focal ? TINT : STORE}" stroke="${focal ? ACCENT : MUTED}" stroke-width="1"/>`;
  });
  return wrapSvg(
    left + width + 24,
    head.h + tasks.length * rowH + 16,
    spec.title || "Gantt",
    s,
  );
}

function drawScatter(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const xs = nodes.map((n, i) => n.x ?? i);
  const ys = nodes.map((n, i) => n.y ?? n.value ?? i);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const head = heading(spec.title, spec.subtitle);
  const left = 48;
  const top = head.h + 12;
  const width = 280;
  const height = 200;
  const xAt = (v: number) =>
    left + ((v - minX) / (maxX - minX || 1)) * width;
  const yAt = (v: number) =>
    top + height - ((v - minY) / (maxY - minY || 1)) * height;
  let s = head.svg;
  s +=
    `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + height}" stroke="${RULE}" stroke-width="1"/>` +
    `<line x1="${left}" y1="${top + height}" x2="${left + width}" y2="${top + height}" stroke="${RULE}" stroke-width="1"/>` +
    `<text x="${left + width / 2}" y="${top + height + 20}" fill="${MUTED}" font-size="10" font-family="${MONO}" text-anchor="middle">${esc(spec.axes?.x || "X")}</text>` +
    `<text x="${left - 20}" y="${top + height / 2}" fill="${MUTED}" font-size="10" font-family="${MONO}" text-anchor="middle" transform="rotate(-90 ${left - 20} ${top + height / 2})">${esc(spec.axes?.y || "Y")}</text>`;
  nodes.forEach((n, i) => {
    const focal = n.kind === "focal";
    s +=
      `<circle cx="${xAt(xs[i])}" cy="${yAt(ys[i])}" r="4" fill="${focal ? ACCENT : INK}"/>` +
      `<text x="${xAt(xs[i]) + 8}" y="${yAt(ys[i]) + 4}" fill="${INK}" font-size="10" font-family="${FONT}">${esc(n.label)}</text>`;
  });
  return wrapSvg(left + width + 48, top + height + 36, spec.title || "Scatter", s);
}

function drawHighLevel(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const head = heading(spec.title, spec.subtitle);
  const inner = gridPlace(nodes, 40, head.h + 36, 24, 20, Math.min(4, nodes.length));
  const maxX = Math.max(200, ...inner.map((b) => b.x + b.w));
  const maxY = Math.max(80, ...inner.map((b) => b.y + b.h));
  const cluster = `<rect x="20" y="${head.h + 8}" width="${maxX}" height="${maxY - head.h + 20}" rx="10" fill="${STORE}" stroke="${INK}" stroke-width="1"/>`;
  const by = mapBoxes(inner);
  const uid = `hl${drawSeq + 1}`;
  const edges = spec.edges
    .map((e) => {
      const a = by.get(e.from);
      const b = by.get(e.to);
      if (!a || !b) return "";
      return drawEdge(a, b, e, uid);
    })
    .join("");
  return wrapSvg(
    maxX + 40,
    maxY + 32,
    spec.title || "High-level",
    head.svg + cluster + edges + inner.map(drawBox).join(""),
  );
}

function drawMedallion(spec: DiagramSpec): string {
  const bands = ["Bronze", "Silver", "Gold"];
  const nodes = ensureNodes(spec);
  const head = heading(spec.title, spec.subtitle);
  let s = head.svg;
  bands.forEach((band, i) => {
    const y = head.h + i * 72;
    const grouped = nodes.filter(
      (n) => (n.group || bands[nodes.indexOf(n) % 3]).toLowerCase() === band.toLowerCase(),
    );
    const col = grouped.length
      ? grouped
      : nodes.filter((_, idx) => idx % 3 === i);
    s +=
      `<rect x="20" y="${y}" width="400" height="64" rx="6" fill="${i === 2 ? TINT : PAPER}" stroke="${i === 2 ? ACCENT : INK}" stroke-width="1"/>` +
      `<text x="36" y="${y + 20}" fill="${MUTED}" font-size="10" font-family="${MONO}" letter-spacing="0.12em">${esc(band.toUpperCase())}</text>` +
      `<text x="36" y="${y + 42}" fill="${INK}" font-size="12" font-weight="600" font-family="${FONT}">${esc(col.map((n) => n.label).join(" - ") || "—")}</text>`;
  });
  return wrapSvg(440, head.h + 3 * 72 + 8, spec.title || "Medallion", s);
}

function drawDpIntegration(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  const zones = ["Sources", "Core", "Consumers"];
  nodes.forEach((n, i) => {
    if (n.group) return;
    if (n.kind === "external") n.group = "Sources";
    else if (n.kind === "store") n.group = "Core";
    else n.group = zones[i % 3];
  });
  return drawItState({
    ...spec,
    title: spec.title || "DP integration",
    nodes,
  });
}

function drawSecurityMatrix(spec: DiagramSpec): string {
  const nodes = ensureNodes(spec);
  let rows = unique(nodes.map((n) => n.lane));
  let cols = unique(nodes.map((n) => n.group));
  if (!rows.length || !cols.length) {
    rows = nodes.map((n) => n.label).slice(0, Math.ceil(nodes.length / 2) || 1);
    cols = ["Read", "Write", "Admin"];
  }
  const head = heading(spec.title, spec.subtitle);
  const cw = 80;
  const rh = 32;
  const left = 100;
  let s = head.svg;
  cols.forEach((c, i) => {
    s += `<text x="${left + i * cw + cw / 2}" y="${head.h + 16}" fill="${MUTED}" font-size="10" font-family="${MONO}" text-anchor="middle">${esc(c)}</text>`;
  });
  rows.forEach((r, ri) => {
    const y = head.h + 28 + ri * rh;
    s += `<text x="16" y="${y + 18}" fill="${INK}" font-size="11" font-weight="600" font-family="${FONT}">${esc(r)}</text>`;
    cols.forEach((c, ci) => {
      const hit = nodes.find(
        (n) =>
          (n.lane || n.label) === r &&
          (!n.group || n.group === c),
      );
      const mark = hit ? (hit.kind === "focal" || (hit.value ?? 1) > 0 ? "●" : "○") : "-";
      const color = mark === "●" ? ACCENT : MUTED;
      s +=
        `<rect x="${left + ci * cw}" y="${y}" width="${cw}" height="${rh}" fill="transparent" stroke="${RULE}" stroke-width="1"/>` +
        `<text x="${left + ci * cw + cw / 2}" y="${y + 20}" fill="${color}" font-size="12" text-anchor="middle">${mark}</text>`;
    });
  });
  return wrapSvg(
    left + cols.length * cw + 16,
    head.h + 28 + rows.length * rh + 16,
    spec.title || "Security matrix",
    s,
  );
}

function drawState(spec: DiagramSpec): string {
  const boxes = layoutFlow(spec, false).map((b) => ({ ...b, shape: "round" as const }));
  return paintGraph(spec, boxes);
}

function withParentEdges(spec: DiagramSpec): DiagramSpec {
  if (spec.edges.length) return spec;
  const extra: DEdge[] = [];
  for (const n of spec.nodes) {
    if (n.parent) extra.push({ from: n.parent, to: n.id });
  }
  return extra.length ? { ...spec, edges: extra } : spec;
}

export function drawDiagram(text: string): string | null {
  const spec = parseDiagram(text);
  if (!spec) return null;
  try {
    switch (spec.type) {
      case "architecture":
        return drawArchitecture(spec);
      case "it-state":
        return drawItState(spec);
      case "flowchart":
        return paintGraph(spec, layoutFlow(spec, true));
      case "sequence":
        return drawSequence(spec);
      case "state":
        return drawState(spec);
      case "er":
        return drawEr(spec);
      case "timeline":
        return drawTimeline(spec);
      case "swimlane":
        return drawSwimlane(spec);
      case "quadrant":
        return drawQuadrant(spec);
      case "radar":
        return drawRadar(spec);
      case "loop":
        return drawLoop(spec);
      case "nested":
        return drawNested(spec);
      case "tree":
        return paintGraph(withParentEdges(spec), layoutTree(spec));
      case "org-chart":
        return paintGraph(withParentEdges(spec), layoutTree(spec, 60));
      case "layers":
        return drawLayers(spec);
      case "venn":
        return drawVenn(spec);
      case "pyramid":
        return drawPyramid(spec);
      case "bar":
        return drawBar(spec);
      case "line":
        return drawLine(spec);
      case "gantt":
        return drawGantt(spec);
      case "scatter":
        return drawScatter(spec);
      case "high-level":
        return drawHighLevel(spec);
      case "process":
        return drawSwimlane({
          ...spec,
          title: spec.title || "Process",
        });
      case "medallion":
        return drawMedallion(spec);
      case "data-flow":
        return paintGraph(spec, layoutFlow(spec, false));
      case "dp-integration":
        return drawDpIntegration(spec);
      case "dp-security-matrix":
        return drawSecurityMatrix(spec);
      default:
        return drawArchitecture(spec);
    }
  } catch {
    return null;
  }
}
