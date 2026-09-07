import { createElement, type IconNode } from "lucide";
import {
  Aperture,
  ArrowDown,
  ArrowRight,
  Asterisk,
  Atom,
  Blocks,
  BookOpen,
  Bot,
  Check,
  ChevronsLeftRight,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Diamond,
  Download,
  File,
  FileDown,
  Flag,
  Flame,
  Flower2,
  Folder,
  FolderOpen,
  Globe,
  GripVertical,
  Hexagon,
  MoreHorizontal,
  Link,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  Moon,
  Orbit,
  PanelLeft,
  PanelRight,
  Pencil,
  PenLine,
  Pin,
  Plus,
  Reply,
  RotateCw,
  Search,
  Settings,
  Snowflake,
  Sparkle,
  Sparkles,
  Square,
  SquareCheck,
  SquarePen,
  Star,
  Terminal,
  TextSearch,
  ThumbsUp,
  Sun,
  TextQuote,
  Trash2,
  Triangle,
  X,
  Zap,
} from "lucide";
import {
  defineMorphIcon,
  type IconInput,
  type MorphIconElement,
} from "morphicons/element";

defineMorphIcon();

const STROKE = "1.5";

export const Ico = {
  send: ArrowRight,
  jumpLatest: ArrowDown,
  // Filled stop. Send/stop swap by CSS; no morph.
  stop: [
    [
      "rect",
      {
        x: 6,
        y: 6,
        width: 12,
        height: 12,
        rx: 2,
        fill: "currentColor",
        stroke: "none",
      },
    ],
  ] satisfies IconNode,
  sidebar: PanelLeft,
  search: Search,
  find: TextSearch,
  back: ChevronLeft,
  forward: ChevronRight,
  newChat: SquarePen,
  sideChat: PanelRight,
  sidePick: MessageSquare,
  tasks: ListTodo,
  todo: Square,
  todoDone: SquareCheck,
  plugins: Blocks,
  settings: Settings,
  plus: Plus,
  minus: Minus,
  folder: Folder,
  folderOpen: FolderOpen,
  spinner: LoaderCircle,
  check: Check,
  trash: Trash2,
  retry: RotateCw,
  slash: Sparkles,
  cli: Terminal,
  quote: TextQuote,
  addSide: MessageSquarePlus,
  file: File,
  link: Link,
  book: BookOpen,
  pin: Pin,
  pencil: Pencil,
  more: MoreHorizontal,
  grip: GripVertical,
  steer: Reply,
  command: ChevronsLeftRight,
  clock: Clock,
  copy: Copy,
  download: Download,
  fileDown: FileDown,
  close: X,
  thought: Sparkle,
  globe: Globe,
  modeBypass: Zap,
  modePlan: Flag,
  modeAuto: Bot,
  planKeep: PenLine,
  planChange: MessageCircleQuestion,
  planAccept: ThumbsUp,
} as const;

type IconOpts = {
  size?: number;
  className?: string;
  stroke?: string;
};

function svgAttrs(opts?: IconOpts): Record<string, string | number> {
  const size = opts?.size ?? 16;
  const attrs: Record<string, string | number> = {
    width: size,
    height: size,
    "stroke-width": opts?.stroke ?? STROKE,
    "aria-hidden": "true",
  };
  if (opts?.className) attrs.class = opts.className;
  return attrs;
}

export function iconEl(node: IconNode, opts?: IconOpts): SVGElement {
  return createElement(node, svgAttrs(opts));
}

export function iconHtml(node: IconNode, opts?: IconOpts): string {
  return iconEl(node, opts).outerHTML;
}

const SUB_GLYPHS: IconNode[] = [
  Sparkle,
  Sparkles,
  Asterisk,
  Star,
  Zap,
  Hexagon,
  Aperture,
  Orbit,
  Atom,
  Sun,
  Moon,
  Flower2,
  Diamond,
  Triangle,
  Flame,
  Snowflake,
];

export function hashStr(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function subGlyph(name: string): IconNode {
  return SUB_GLYPHS[hashStr(name, 0) % SUB_GLYPHS.length]!;
}

export function subHue(name: string): number {
  return hashStr(name, 13) % 360;
}

export function pinHtml(filled: boolean, size = 14): string {
  const el = iconEl(Ico.pin, { size });
  if (filled) el.setAttribute("fill", "currentColor");
  return el.outerHTML;
}

export function morphEl(icon: IconInput, opts?: IconOpts): MorphIconElement {
  const el = document.createElement("morph-icon");
  el.setAttribute("size", String(opts?.size ?? 16));
  el.setAttribute("stroke-width", STROKE);
  el.setAttribute("aria-hidden", "true");
  if (opts?.className) el.className = opts.className;
  el.spring = "smooth";
  el.reducedMotion = "user";
  el.icon = icon;
  return el;
}

export function playMorph(el: MorphIconElement, icon: IconInput): void {
  // icon stays on the first mark after morphTo — do not early-return on it.
  if (el.icon == null) el.set(icon);
  else el.morphTo(icon, el.spring ?? "smooth");
}

export function todoGlyph(
  done: boolean,
  prev: boolean | undefined,
  size = 16,
): Element {
  const target = done ? Ico.todoDone : Ico.todo;
  const from = prev === undefined ? done : prev;
  const el = morphEl(from ? Ico.todoDone : Ico.todo, { size });
  if (prev !== undefined && prev !== done) {
    requestAnimationFrame(() => {
      el.morphTo(target, el.spring ?? "smooth");
    });
  }
  return el;
}

export function syncFolderIcon(
  host: HTMLElement,
  open: boolean,
  prev: boolean | undefined,
  size = 16,
): void {
  host.classList.toggle("is-open", open);
  const target = open ? Ico.folderOpen : Ico.folder;
  let el = host.querySelector<MorphIconElement>("morph-icon");
  if (!el) {
    const from = prev === undefined ? open : prev;
    el = morphEl(from ? Ico.folderOpen : Ico.folder, {
      size,
      className: "folder-svg",
    });
    host.replaceChildren(el);
  }
  if (prev !== undefined && prev !== open) playMorph(el, target);
  else if (el.icon !== target) el.set(target);
}

export function replaceIcon(
  host: HTMLElement | null,
  node: IconNode,
  opts?: IconOpts,
): void {
  if (!host) return;
  const next = iconEl(node, opts);
  const prev = host.querySelector("svg, morph-icon");
  if (prev) prev.replaceWith(next);
  else host.prepend(next);
}

export function mountMorph(
  host: HTMLElement | null,
  icon: IconInput,
  opts?: IconOpts,
): MorphIconElement | null {
  if (!host) return null;
  const existing = host.querySelector("morph-icon");
  if (existing) return existing;
  const el = morphEl(icon, opts);
  const old = host.querySelector("svg");
  if (old) old.replaceWith(el);
  else host.prepend(el);
  return el;
}
