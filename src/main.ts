import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import {
  availableMonitors,
  getCurrentWindow,
  type Monitor,
} from "@tauri-apps/api/window";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkAppUpdate } from "@tauri-apps/plugin-updater";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import DOMPurify from "dompurify";
import { marked, Renderer } from "marked";
import {
  Ico,
  hashStr,
  iconEl,
  iconHtml,
  mountMorph,
  pinHtml,
  replaceIcon,
  subGlyph,
  subHue,
  syncFolderIcon,
  todoGlyph,
} from "./icons";
import {
  diagramFences,
  diagramTypeLabel,
  drawDiagram,
  isDiagramTypeHunt,
  isEditorialLang,
  isPainterPath,
  parseDiagram,
} from "./diagrams";

type GrokRunResult = {
  ok: boolean;
  text: string;
  error: string | null;
  session_id: string | null;
};

type StreamEvent = {
  kind: string;
  data: string;
};

type AskOption = {
  label: string;
  description: string;
};

type AskQuestion = {
  question: string;
  options: AskOption[];
  multiSelect: boolean;
};

type QuestionRequest = {
  id: number;
  chatKey: string;
  questions: AskQuestion[];
};

type PlanRequest = {
  id: number;
  chatKey: string;
  planContent: string;
};

type ModeChange = {
  chatKey: string;
  mode: string;
};

type SessionInfo = {
  sessionId: string;
  title: string;
  updatedAt: string;
};

type HistoryPart = {
  kind: string;
  text: string;
  toolId?: string;
  toolName?: string;
  query?: string;
  path?: string;
  span?: string;
  old?: string;
  new?: string;
  urls?: string[];
  todos?: TodoItem[];
  todosMerge?: boolean;
};

type HistoryMessage = {
  role: string;
  text: string;
  thought?: string | null;
  parts?: HistoryPart[];
  attachments?: HistoryAttachment[];
  workedSecs?: number;
  at?: number;
};

type HistoryAttachment = {
  name: string;
  mime: string;
  kind: string;
  path?: string | null;
  url?: string | null;
};

type SessionSearchHit = {
  cwd: string;
  sessionId: string;
  snippet: string;
};

type ArchivedChat = {
  sessionId: string;
  cwd: string;
  title: string;
  archivedAt: number;
};

type ChatTrio = {
  model: string;
  effort: string;
  mode: string;
};

type Prefs = {
  activeCwd: string | null;
  recent: string[];
  mode: string;
  model: string;
  /** Last reasoning effort; clamped to the selected model’s menu. */
  effort: string;
  /** `${cwd}` → last focused trio. */
  projectSeed: Record<string, ChatTrio>;
  /** `${cwd}::${sessionId}` → trio. */
  chatSettings: Record<string, ChatTrio>;
  /** Last focused session id per project. */
  sessionByCwd: Record<string, string>;
  /** Archived chats. Hidden after ARCHIVE_DAYS. */
  archive: ArchivedChat[];
  /** Hidden from Grotesque for good: `${cwd}::${sessionId}`. */
  gone: string[];
  /** Grotesque titles: `${cwd}::${sessionId}` → name */
  titles: Record<string, string>;
  /** Grotesque message times: `${cwd}::${sessionId}` → unix ms per user/assistant line */
  messageTimes: Record<string, number[]>;
  /** Quote chips on sent prompts: `${cwd}::${sessionId}` → one list per user line */
  messageQuotes: Record<string, StoredQuote[][]>;
  /** Pinned chats: `${cwd}::${sessionId}` (or `draft:` key). */
  pinned: string[];
  pinnedProjects: Record<string, true>;
  /** Grotesque project names: folder path → label. */
  projectNames: Record<string, string>;
  /** Pinned section order. `p:` + path or `c:` + pin key. */
  pinnedMix: string[];
  /** Missing key = collapsed. */
  projectExpanded: Record<string, true>;
  /** Sidebar Pinned / Projects / Recents. Missing key = open. */
  navCollapsed: Record<string, true>;
  /** Last used: `${cwd}::${sessionId}` → unix ms. */
  lastActive: Record<string, number>;
  /** MCP names the operator turned Off (plugin-owned rows do not persist in the CLI). */
  mcpOff: string[];
  /** MCP name → local picture path. Replaces the row mark on this Mac. */
  mcpMarks: Record<string, string>;
  /** Grotesque plugin names: CLI name → label. */
  mcpNames: Record<string, string>;
  /** Waiting queues: `${cwd}::${sessionId}` or `draft:${key}`. */
  waiting: Record<string, WaitingItem[]>;
  /** Right panel per chat: `${cwd}::${sessionId}` or `draft:${key}`. */
  panels: Record<string, StoredPanel>;
  sideWidth: number;
  sidebarWidth: number;
  sidebarOpen: boolean;
  /** Outputs card on the main chat. Off hides it. */
  tasksPinned: boolean;
  /** Last logical window box. */
  windowBounds: WindowBounds | null;
  /** `dark` default; `system` follows macOS. */
  theme: ThemePref;
  accent: AccentId;
  /** Percent. 100 is default. */
  typeScale: number;
};

type StoredPanel = {
  open: boolean;
  pages: string[];
  sideCount: number;
  planText?: string;
};

type StoredQuote = { quote: string; comment?: string };

type WindowBounds = { x: number; y: number; w: number; h: number };

type ThemePref = "dark" | "light" | "system";
type AccentId = "orange" | "teal" | "blue" | "purple";
type ResolvedTheme = "dark" | "light";

const THEME_PREFS = new Set<ThemePref>(["dark", "light", "system"]);
const ACCENT_IDS = new Set<AccentId>(["orange", "teal", "blue", "purple"]);
const TYPE_SCALE_MIN = 80;
const TYPE_SCALE_MAX = 150;
const TYPE_SCALE_STEP = 10;
const TYPE_SCALE_DEFAULT = 100;

type EffortOption = {
  id: string;
  label: string;
  isDefault: boolean;
};

type SlashCmd = {
  name: string;
  description: string;
  source?: string;
  skill?: boolean;
};

type SuggestKind = "slash" | "path" | "recent";

type SuggestItem = {
  label: string;
  detail: string;
  insert: string;
  dir?: boolean;
  section?: "cmd" | "skill" | "path" | "recent" | "plugin";
  source?: string;
  pluginName?: string;
};

type ModelInfo = {
  id: string;
  name: string;
  isDefault: boolean;
  efforts?: EffortOption[];
  contextWindow?: number;
  autoCompactPercent?: number;
};

const DEFAULT_MODEL = "grok-4.6";
const DEFAULT_EFFORT = "high";
/** When models_cache has no efforts for a model. */
const FALLBACK_EFFORTS: EffortOption[] = [
  { id: "high", label: "High", isDefault: true },
  { id: "medium", label: "Medium", isDefault: false },
  { id: "low", label: "Low", isDefault: false },
];
/** Empty catalog: default model + 4.6-style effort menu. */
const FALLBACK_MODEL: ModelInfo = {
  id: DEFAULT_MODEL,
  name: "Grok 4.6",
  isDefault: true,
  efforts: [
    { id: "xhigh", label: "Extra high", isDefault: true },
    { id: "high", label: "High", isDefault: false },
    { id: "medium", label: "Medium", isDefault: false },
    { id: "low", label: "Low", isDefault: false },
  ],
  contextWindow: 500_000,
  autoCompactPercent: 80,
};

type CtxTarget =
  | { kind: "session"; cwd: string; sessionId: string; title: string }
  | { kind: "draft"; cwd: string; runtimeKey: string }
  | { kind: "project"; cwd: string };

type LoaderKind = "drive" | "dots" | "orbit";
const LOADER_KINDS: LoaderKind[] = ["drive", "dots", "orbit"];
const LIVE_VERBS = [
  "Churning",
  "Pondering",
  "Ruminating",
  "Marinating",
  "Spelunking",
  "Schlepping",
  "Moseying",
  "Noodling",
  "Tinkering",
  "Mulling",
  "Percolating",
  "Simmering",
  "Stewing",
  "Brewing",
  "Crunching",
  "Hashing",
  "Hatching",
  "Wrangling",
  "Unravelling",
  "Puttering",
  "Meandering",
  "Contemplating",
  "Cogitating",
  "Incubating",
  "Fermenting",
  "Forging",
  "Crafting",
  "Calculating",
  "Synthesizing",
  "Deciphering",
  "Orchestrating",
  "Reticulating",
] as const;

type ToolDiff = {
  path: string;
  old?: string;
  new?: string;
};

type WebHit = { title: string; host: string; href: string };

type ToolChip = {
  id: string;
  title: string;
  status: string;
  kind: string;
  name?: string;
  path?: string;
  diff?: ToolDiff;
  query?: string;
  hits?: WebHit[];
  variant?: string;
  span?: string;
  server?: string;
  todos?: TodoItem[];
  todosMerge?: boolean;
  sessionId?: string;
  description?: string;
  subagentType?: string;
};

type WorkStep =
  | { kind: "thought"; text: string }
  | { kind: "tool"; chip: ToolChip }
  | { kind: "text"; text: string };

type AssistantPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; chip: ToolChip };

type ToolEventPayload = {
  id?: string;
  title?: string;
  status?: string;
  kind?: string;
  name?: string;
  path?: string;
  diff?: ToolDiff;
  query?: string;
  urls?: string[];
  variant?: string;
  span?: string;
  server?: string;
  todos?: TodoItem[];
  todosMerge?: boolean;
  sessionId?: string;
  description?: string;
  subagentType?: string;
};

type Attachment = {
  id: string;
  name: string;
  path?: string;
  mime: string;
  kind: "image" | "file" | "quote";
  quote?: string;
  comment?: string;
  size?: number;
  previewUrl?: string;
  dataB64?: string;
  snapTitle?: string;
  snapIconUrl?: string;
};

type WaitingItem = {
  id: string;
  text: string;
  attachments?: Attachment[];
};

type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
};

/** Open chat: own agent process (`chatKey`). */
type ChatRuntime = {
  key: string;
  cwd: string;
  sessionId: string | null;
  forceNew: boolean;
  title: string;
  runInFlight: boolean;
  /** Plan or question card is up; live gerund is off. */
  reviewWait: boolean;
  /** Finished while you were elsewhere; green tick until you open it. */
  doneUnread: boolean;
  draft: string;
  /** Sidebar: after first send, or after you leave with a draft. */
  listedDraft: boolean;
  attachments: Attachment[];
  lines: TranscriptLine[];
  status: string;
  liveMeta: HTMLElement | null;
  liveStream: HTMLElement | null;
  liveRow: HTMLElement | null;
  liveThoughtDetails: HTMLDetailsElement | null;
  thoughtBuf: string;
  waiting: WaitingItem[];
  /** After stop: run this next, before the waiting list. */
  steerNext: string | null;
  lastUserPrompt: string | null;
  lastUserAttachments: Attachment[];
  /** After stop: attachments for steerNext. */
  steerNextAttachments: Attachment[] | null;
  stopRequested: boolean;
  lastStopped: boolean;
  scrollTop: number;
  /** At the bottom: stream follows. */
  scrollPinned: boolean;
  contextUsed: number;
  contextSize: number;
  slashCommands: SlashCmd[];
  model: string;
  effort: string;
  mode: string;
  todos: TodoItem[];
  tasksCollapsed: boolean;
  subsCollapsed: boolean;
  reviewCollapsed: boolean;
  lockedMarks: string[];
  pluginMarks: Record<string, { label: string; name: string }>;
  /** Main stays in the sidebar. Panel agents do not. */
  surface: "main" | "panel";
  mainKey?: string;
  tabId?: string;
  seeded?: boolean;
  subLabel?: string;
  liveSubs: LiveSub[];
  /** Parked main transcript. Switch shows this instead of redrawing. */
  pane: DocumentFragment | null;
  paneLines: number;
  paneLive: boolean;
  compacting: boolean;
};

type LiveSub = {
  id: string;
  name: string;
  label: string;
  type: string;
  status: "running" | "done" | "failed";
  toolId: string;
};

const SCIENTISTS = [
  "Newton",
  "Curie",
  "Darwin",
  "Einstein",
  "Faraday",
  "Galileo",
  "Kepler",
  "Pasteur",
  "Mendel",
  "Hawking",
  "Turing",
  "Lovelace",
  "Franklin",
  "Goodall",
  "Feynman",
  "Bohr",
  "Planck",
  "Maxwell",
  "Hubble",
  "Sagan",
  "Carson",
  "Tesla",
  "Archimedes",
  "Euclid",
  "Pythagoras",
  "Avicenna",
  "Copernicus",
  "Halley",
  "Herschel",
  "Ampere",
  "Volta",
  "Ohm",
  "Hertz",
  "Fermi",
  "Meitner",
  "Hodgkin",
  "McClintock",
  "Salk",
  "Fleming",
  "Jenner",
  "Linnaeus",
  "Humboldt",
  "Raman",
  "Bose",
  "Dirac",
  "Heisenberg",
  "Rutherford",
  "Dalton",
  "Lavoisier",
  "Hooke",
] as const;

function scientistName(id: string, taken: Set<string>): string {
  const start = hashStr(id, 0) % SCIENTISTS.length;
  for (let n = 0; n < SCIENTISTS.length; n++) {
    const name = SCIENTISTS[(start + n) % SCIENTISTS.length]!;
    if (!taken.has(name)) return name;
  }
  return SCIENTISTS[start]!;
}

function takenScientistNames(chat: ChatRuntime, skipId?: string): Set<string> {
  const taken = new Set<string>();
  for (const s of chat.liveSubs) {
    if (skipId && s.id === skipId) continue;
    if (s.name) taken.add(s.name);
  }
  return taken;
}

function nameSub(chat: ChatRuntime, sub: LiveSub): LiveSub {
  if (sub.name && SCIENTISTS.includes(sub.name as (typeof SCIENTISTS)[number])) {
    return sub;
  }
  return {
    ...sub,
    name: scientistName(sub.label || sub.id, takenScientistNames(chat, sub.id)),
  };
}

function subMarkEl(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "sub-mark";
  el.setAttribute("aria-hidden", "true");
  el.style.setProperty("--sub-h", String(subHue(name)));
  el.appendChild(iconEl(subGlyph(name), { size: 16 }));
  return el;
}

type SubagentInfo = {
  id: string;
  description: string;
  subagentType?: string;
  status: string;
};

function subStatusFromDisk(raw: string): LiveSub["status"] {
  const s = raw.trim().toLowerCase();
  if (s === "running" || s === "in_progress" || s === "pending") return "running";
  if (s === "failed" || s === "error" || s === "cancelled") return "failed";
  return "done";
}

async function hydrateSubsFromDisk(chat: ChatRuntime) {
  if (!chat.sessionId) {
    if (!chat.runInFlight) finishLiveSubs(chat);
    return;
  }
  let rows: SubagentInfo[] = [];
  try {
    rows = await invoke<SubagentInfo[]>("list_subagents", {
      cwd: chat.cwd,
      parentId: chat.sessionId,
    });
  } catch {
    rows = [];
  }
  if (!rows.length) {
    if (!chat.runInFlight) finishLiveSubs(chat);
    return;
  }
  const before = chat.liveSubs.map((s) => `${s.id}:${s.status}:${s.name}:${s.label}`).join("|");
  const prev = chat.liveSubs.slice();
  const used = new Set<number>();
  const next: LiveSub[] = [];
  for (const row of rows) {
    const label = row.description.trim() || "Subagent";
    let i = prev.findIndex((s, idx) => !used.has(idx) && s.id === row.id);
    if (i < 0) {
      i = prev.findIndex((s, idx) => !used.has(idx) && s.label === label);
    }
    if (i < 0) {
      i = prev.findIndex((s, idx) => !used.has(idx) && s.id.startsWith("call-"));
    }
    if (i >= 0) used.add(i);
    const old = i >= 0 ? prev[i] : undefined;
    const status = chat.runInFlight
      ? subStatusFromDisk(row.status)
      : subStatusFromDisk(row.status) === "running"
        ? "done"
        : subStatusFromDisk(row.status);
    let sub: LiveSub = {
      id: row.id,
      name: old?.name || "",
      label,
      type: row.subagentType || old?.type || "general-purpose",
      status,
      toolId: old?.toolId || row.id,
    };
    sub = nameSub(chat, sub);
    next.push(sub);
    if (old && old.id !== row.id) {
      for (const a of agents.values()) {
        if (a.mainKey === chat.key && a.sessionId === old.id) {
          a.sessionId = row.id;
          a.title = label;
          a.subLabel = sub.name;
        }
      }
    }
  }
  chat.liveSubs = next;
  paintLiveSubs(chat, before);
  for (const s of next) refreshFrontSubTab(chat, s.id, s.status);
}

type PanelTabKind = "side" | "page" | "sub" | "plan";

const PLAN_TAB_ID = "plan";

type PanelTab = {
  id: string;
  kind: PanelTabKind;
};

type PlanPane = {
  reqId: number | null;
  text: string;
  editable: boolean;
};

type PageTab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  error: string;
  history: string[];
  histIndex: number;
  scrollY: number;
};

type RightPanel = {
  open: boolean;
  tabs: PanelTab[];
  front: string | null;
  plan?: PlanPane;
};

type SideChat = ChatRuntime;

type TranscriptLine =
  | { kind: "user"; text: string; at?: number; attachments?: Attachment[] }
  | {
      kind: "assistant";
      meta: string;
      thought?: string;
      error?: boolean;
      stopped?: boolean;
      at?: number;
      parts: AssistantPart[];
      /** Thought and tools in arrival order for the fold. */
      work?: WorkStep[];
      /** User pinned work fold open or shut. */
      workOpen?: boolean;
      loader?: LoaderKind;
      liveVerb?: string;
    }
  | { kind: "question"; req: QuestionRequest; resolved?: string }
  | {
      kind: "plan";
      req: PlanRequest;
      resolved?: "approved" | "keep" | "change";
      edited?: string;
    };

type AssistantLine = Extract<TranscriptLine, { kind: "assistant" }>;

type AssistantDom = {
  row: HTMLElement;
  meta: HTMLElement;
  stream: HTMLElement;
  thoughtDetails: HTMLDetailsElement;
};

const PREFS_KEY = "grok-desk.prefs";
const MAX_RECENT = 8;
const ARCHIVE_DAYS = 7;
const ARCHIVE_MS = ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_SIDE_W = 340;
const MIN_SIDE_W = 240;
const DEFAULT_SIDEBAR_W = 228;
// Traffic 92 + 4×28 controls + 3×4 gaps + 12 after Forward, before the divider.
const MIN_SIDEBAR_W = 228;
const MAX_SIDEBAR_W = 420;
// Below this, close like Hide. The drag stays so a move back can open it.
const COLLAPSE_SIDEBAR_W = 120;
const MIN_WIN_W = 880;
const MIN_WIN_H = 560;
const SPINNER_SVG = iconHtml(Ico.spinner, {
  size: 16,
  className: "chat-item-spinner-svg",
});
const CHECK_SVG = iconHtml(Ico.check, { size: 16 });
const TRASH_SVG = iconHtml(Ico.trash, { size: 16 });
const RETRY_SVG = iconHtml(Ico.retry, { size: 16 });
const MARK_SLASH_SVG = iconHtml(Ico.slash, { size: 16 });
const MARK_FILE_SVG = iconHtml(Ico.file, { size: 16 });
const MARK_FOLDER_SVG = iconHtml(Ico.folder, { size: 16 });
const MARK_LINK_SVG = iconHtml(Ico.link, { size: 16 });
const OBSIDIAN_SVG = iconHtml(Ico.book, { size: 16 });
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const DUR_SHELL = 500;
const EASE_SHELL =
  "linear(0, 0.0293 4.17%, 0.1003 8.33%, 0.1936 12.5%, 0.2956 16.67%, 0.3976 20.83%, 0.494 25%, 0.5816 29.17%, 0.6591 33.33%, 0.726 37.5%, 0.7826 41.67%, 0.8298 45.83%, 0.8685 50%, 0.8998 54.17%, 0.9248 58.33%, 0.9444 62.5%, 0.9598 66.67%, 0.9715 70.83%, 0.9804 75%, 0.987 79.17%, 0.9918 83.33%, 0.9953 87.5%, 0.9977 91.67%, 0.9993 95.83%, 1)";

let shellMotionTimer = 0;

function armShellMotion() {
  if (!motionOk()) return;
  const shell = document.getElementById("shell");
  if (!shell) return;
  shell.classList.add("is-shell-motion");
  window.clearTimeout(shellMotionTimer);
  shellMotionTimer = window.setTimeout(() => {
    shell.classList.remove("is-shell-motion");
    shellMotionTimer = 0;
    syncBrowserBounds();
  }, DUR_SHELL + 80);
}

function motionOk(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Matches `--ease-shell`: 500ms, damping 0.9. */
function easeShell(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const duration = 0.5;
  const zeta = 0.9;
  const w0 = (2 * Math.PI) / duration;
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const time = t * duration;
  const e = Math.exp(-zeta * w0 * time);
  const y =
    1 -
    e * (Math.cos(wd * time) + ((zeta * w0) / wd) * Math.sin(wd * time));
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

function fadeIn(el: HTMLElement | null, ms = 160) {
  if (!el || !motionOk()) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: ms,
    easing: EASE_OUT,
  });
}

const form = () => $<HTMLFormElement>("#prompt-form");
const input = () => $<HTMLElement>("#prompt-input");
const lockedMarks = new Set<string>();
const pluginChipMeta = new Map<string, { label: string; name: string }>();
const runBtn = () => $<HTMLButtonElement>("#run-btn");
const attachBtn = () => $<HTMLButtonElement>("#attach-btn");
const attachFileInput = () => $<HTMLInputElement>("#attach-file-input");
const attachChips = () => $<HTMLElement>("#attach-chips");
const dropOverlay = () => $<HTMLElement>("#drop-overlay");
const waitingBlock = () => $<HTMLElement>("#waiting-block");
const waitingList = () => $<HTMLUListElement>("#waiting-list");
const waitingCtxMenu = () => $<HTMLElement>("#waiting-ctx-menu");
const jumpLatestBtn = () => $<HTMLButtonElement>("#jump-latest");
const transcript = () => $<HTMLElement>("#transcript");
const promptJumps = () => $<HTMLElement>("#prompt-jumps");

const runProgress = () => $<HTMLElement>("#run-progress");
const appUpdateBtn = () => $<HTMLButtonElement>("#app-update-btn");
const cliUpdateBtn = () => $<HTMLButtonElement>("#cli-update-btn");
const aboutAppUpdateBtn = () => $<HTMLButtonElement>("#about-app-update-btn");
const aboutCliUpdateBtn = () => $<HTMLButtonElement>("#about-cli-update-btn");
const chatTitle = () => $<HTMLElement>("#chat-title");
const topbarTitleWrap = () => $<HTMLElement>("#topbar-title-wrap");
const topbarNewChatBtn = () => $<HTMLButtonElement>("#topbar-new-chat-btn");
const contextRing = () => $<HTMLElement>("#ctx-ring");
const suggestBox = () => $<HTMLElement>("#suggest");
const suggestList = () => $<HTMLUListElement>("#suggest-list");
const emptyLead = () => $<HTMLElement>("#empty-lead");
const newProjectBar = () => $<HTMLElement>("#new-project-bar");
const newProjectChip = () => $<HTMLButtonElement>("#new-project-chip");
const newProjectName = () => $<HTMLElement>("#new-project-name");
const newProjectMenu = () => $<HTMLElement>("#new-project-menu");
const newProjectList = () => $<HTMLElement>("#new-project-list");
const newProjectQ = () => $<HTMLInputElement>("#new-project-q");
const newProjectNew = () => $<HTMLButtonElement>("#new-project-new");
const newProjectNone = () => $<HTMLButtonElement>("#new-project-none");
const recentsList = () => $<HTMLUListElement>("#recents-list");
const newProjectPlugins = () => $<HTMLButtonElement>("#new-project-plugins");
const newProjectPluginMarks = () => $<HTMLElement>("#new-project-plugin-marks");
const pluginPicker = () => $<HTMLElement>("#plugin-picker");

const pluginPickerList = () => $<HTMLElement>("#plugin-picker-list");
const pluginPickerConnect = () => $<HTMLButtonElement>("#plugin-picker-connect");
const mainPane = () => $<HTMLElement>("#main-pane");
const modelEffortBtn = () => $<HTMLButtonElement>("#model-effort-btn");
const modeBtn = () => $<HTMLButtonElement>("#mode-btn");
const composerPickEl = () => $<HTMLElement>("#composer-pick");
const composerPickList = () => $<HTMLUListElement>("#composer-pick-list");
const projectList = () => $<HTMLUListElement>("#project-list");
const pinnedList = () => $<HTMLUListElement>("#pinned-list");
const projectsHint = () => $<HTMLElement>("#projects-hint");
const openFolderBtn = () => $<HTMLButtonElement>("#open-folder-btn");
const settingsPage = () => $<HTMLElement>("#settings-page");
const useLifetime = () => $<HTMLElement>("#use-lifetime");
const usePeak = () => $<HTMLElement>("#use-peak");
const useLongest = () => $<HTMLElement>("#use-longest");
const useStreak = () => $<HTMLElement>("#use-streak");
const useBestStreak = () => $<HTMLElement>("#use-best-streak");
const useStatsStatus = () => $<HTMLElement>("#use-stats-status");
const useGrid = () => $<HTMLElement>("#use-grid");
const useGridWrap = () => $<HTMLElement>("#use-grid-wrap");
const useMonths = () => $<HTMLElement>("#use-months");
const archiveList = () => $<HTMLUListElement>("#archive-list");
const archiveEmpty = () => $<HTMLElement>("#archive-empty");
const archiveEmptyBtn = () => $<HTMLButtonElement>("#archive-empty-btn");
const aboutAppVer = () => $<HTMLElement>("#about-app-ver");
const aboutCliVer = () => $<HTMLElement>("#about-cli-ver");
const aboutLogStatus = () => $<HTMLElement>("#about-log-status");
const chatCtxMenu = () => $<HTMLElement>("#chat-ctx-menu");
const mcpCtxMenu = () => $<HTMLElement>("#mcp-ctx-menu");
const docOpenMenu = () => $<HTMLElement>("#doc-open-menu");
const mediaOverlay = () => $<HTMLElement>("#media-overlay");
const mediaOverlayImg = () => $<HTMLImageElement>("#media-overlay-img");
const openSideBtn = () => $<HTMLButtonElement>("#open-side-btn");
const tasksPinBtn = () => $<HTMLButtonElement>("#tasks-pin-btn");
const closeSideBtn = () => $<HTMLButtonElement>("#close-side-btn");
const sidePane = () => $<HTMLElement>("#side-pane");
const sideSplitter = () => $<HTMLElement>("#side-splitter");
const sideTranscript = () => $<HTMLElement>("#side-transcript");
const sideEmpty = () => $<HTMLElement>("#side-empty");
const sideForm = () => $<HTMLFormElement>("#side-form");
const sideInput = () => $<HTMLTextAreaElement>("#side-input");
const sideAttachChips = () => $<HTMLElement>("#side-attach-chips");
const sideAttachBtn = () => $<HTMLButtonElement>("#side-attach-btn");
const sideAttachFileInput = () => $<HTMLInputElement>("#side-attach-file-input");
const sideSendBtn = () => $<HTMLButtonElement>("#side-send-btn");
const sideStatus = () => $<HTMLElement>("#side-status");
const sideComposerDock = () => $<HTMLElement>("#side-composer-dock");
const panelTabs = () => $<HTMLElement>("#panel-tabs");
const panelTabsRow = () => $<HTMLElement>("#panel-tabs-row");
const panelAddBtn = () => $<HTMLButtonElement>("#panel-add-btn");
const panelPlusMenu = () => $<HTMLElement>("#panel-plus-menu");
const panelEmpty = () => $<HTMLElement>("#panel-empty");
const panelBody = () => $<HTMLElement>("#panel-body");
const browserChrome = () => $<HTMLElement>("#browser-chrome");
const browserBackBtn = () => $<HTMLButtonElement>("#browser-back");
const browserForwardBtn = () => $<HTMLButtonElement>("#browser-forward");
const browserReloadBtn = () => $<HTMLButtonElement>("#browser-reload");
const browserUrl = () => $<HTMLInputElement>("#browser-url");
const browserEmpty = () => $<HTMLElement>("#browser-empty");
const browserError = () => $<HTMLElement>("#browser-error");
const browserStage = () => $<HTMLElement>("#browser-stage");
const planPane = () => $<HTMLElement>("#plan-pane");
const planCopyBtn = () => $<HTMLButtonElement>("#plan-copy");
const planView = () => $<HTMLElement>("#plan-pane-view");
const sideWaitingBlock = () => $<HTMLElement>("#side-waiting-block");
const sideWaitingList = () => $<HTMLUListElement>("#side-waiting-list");
const sidebarEl = () => $<HTMLElement>("#sidebar");
const sidebarSplitter = () => $<HTMLElement>("#sidebar-splitter");
const toggleSidebarBtn = () => $<HTMLButtonElement>("#toggle-sidebar-btn");
const navBackBtn = () => $<HTMLButtonElement>("#nav-back-btn");
const navForwardBtn = () => $<HTMLButtonElement>("#nav-forward-btn");
const chatSearchBtn = () => $<HTMLButtonElement>("#chat-search-btn");
const chatSearchOverlay = () => $<HTMLElement>("#chat-search-overlay");
const chatSearchInput = () => $<HTMLInputElement>("#chat-search");
const findBar = () => $<HTMLElement>("#find-bar");
const findInput = () => $<HTMLInputElement>("#find-input");
const findCountEl = () => $<HTMLElement>("#find-count");
const findPrevBtn = () => $<HTMLButtonElement>("#find-prev");
const findNextBtn = () => $<HTMLButtonElement>("#find-next");
const findCloseBtn = () => $<HTMLButtonElement>("#find-close");
const spotChatList = () => $<HTMLUListElement>("#spot-chat-list");
const spotSuggestList = () => $<HTMLUListElement>("#spot-suggest-list");
const spotChatsBlock = () => $<HTMLElement>("#spot-chats-block");
const spotSuggestBlock = () => $<HTMLElement>("#spot-suggest-block");
const spotEmpty = () => $<HTMLElement>("#spot-empty");
const winbarSide = () => $<HTMLElement>("#winbar-side");
const pluginsNavBtn = () => $<HTMLButtonElement>("#plugins-nav-btn");
const settingsNavBtn = () => $<HTMLButtonElement>("#settings-nav-btn");
const pluginsPage = () => $<HTMLElement>("#plugins-page");
const pluginsTabMcp = () => $<HTMLButtonElement>("#plugins-tab-mcp");
const pluginsTabMarket = () => $<HTMLButtonElement>("#plugins-tab-market");
const pluginsTabSkills = () => $<HTMLButtonElement>("#plugins-tab-skills");
const pluginsAddBtn = () => $<HTMLButtonElement>("#plugins-add");
const pluginsMcpPane = () => $<HTMLElement>("#plugins-mcp-pane");
const pluginsMarketPane = () => $<HTMLElement>("#plugins-market-pane");
const pluginsSkillsPane = () => $<HTMLElement>("#plugins-skills-pane");
const mcpList = () => $<HTMLUListElement>("#mcp-list");
const mcpEmpty = () => $<HTMLElement>("#mcp-empty");
const mcpStatus = () => $<HTMLElement>("#mcp-status");
const marketList = () => $<HTMLUListElement>("#market-list");
const marketEmpty = () => $<HTMLElement>("#market-empty");
const marketStatus = () => $<HTMLElement>("#market-status");
const skillsList = () => $<HTMLUListElement>("#skills-list");
const skillsEmpty = () => $<HTMLElement>("#skills-empty");
const skillsStatus = () => $<HTMLElement>("#skills-status");
const addPluginCard = () => $<HTMLElement>("#add-plugin-card");
const addPluginForm = () => $<HTMLFormElement>("#add-plugin-form");
const addPluginName = () => $<HTMLInputElement>("#add-plugin-name");
const addPluginUrl = () => $<HTMLInputElement>("#add-plugin-url");
const addPluginCancel = () => $<HTMLButtonElement>("#add-plugin-cancel");
const addPluginSubmit = () => $<HTMLButtonElement>("#add-plugin-submit");

const MODES = new Set(["bypass", "plan", "auto"]);
const MODE_ORDER = ["plan", "auto", "bypass"] as const;

function canonicalMode(mode: string | undefined | null): string {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "bypass" || m === "plan" || m === "auto") return m;
  return "auto";
}

function modeLabel(mode: string): string {
  const id = canonicalMode(mode);
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function modeGlyph(mode: string) {
  const id = canonicalMode(mode);
  if (id === "bypass") return Ico.modeBypass;
  if (id === "plan") return Ico.modePlan;
  return Ico.modeAuto;
}

function paintModeBtn(mode: string) {
  const el = modeBtn();
  if (!el) return;
  const name = modeLabel(mode);
  const ico = document.createElement("span");
  ico.className = "pill-select-ico";
  ico.setAttribute("aria-hidden", "true");
  ico.appendChild(iconEl(modeGlyph(mode), { size: 16 }));
  const lab = document.createElement("span");
  lab.className = "pill-select-label";
  lab.textContent = name;
  el.replaceChildren(ico, lab);
  el.setAttribute("aria-label", `Run mode, ${name}`);
}

function pairLabel(modelId: string, effortId: string): string {
  const m = modelById(modelId);
  const name = m?.name || modelId || DEFAULT_MODEL;
  const es = m?.efforts && m.efforts.length > 0 ? m.efforts : FALLBACK_EFFORTS;
  const e = es.find((x) => x.id === effortId) ?? es.find((x) => x.isDefault) ?? es[0];
  return `${name} - ${e?.label || effortId || DEFAULT_EFFORT}`;
}

let prefs: Prefs = loadPrefs();
void restoreWindowBounds();
type MainPage = "plugins" | "settings" | null;
let mainPage: MainPage = null;

function pageOpen(): boolean {
  return mainPage != null;
}

type NavPlace =
  | { kind: "chat"; key: string }
  | { kind: "plugins" }
  | { kind: "settings" };
const NAV_CAP = 50;
let navStack: NavPlace[] = [];
let navIndex = -1;
let navSilent = false;
const CHAT_LIST_CAP = 5;
let chatsShown = CHAT_LIST_CAP;
let pendingExpandPath: string | null = null;
const folderOpenSeen = new Map<string, boolean>();
let projectDragged = false;
/** Blocks the delayed chat-open after a live sidebar drag. */
let skipChatOpen = false;
/** True during in-app drag. Tauri file-drop must ignore it. */
let uiDragActive = false;
const PROJECT_DRAG_PX = 3;

function positionGrabPill(
  pill: HTMLElement,
  x: number,
  y: number,
  grabX: number,
  grabY: number,
) {
  pill.style.transform = `translate3d(${Math.round(x - grabX)}px, ${Math.round(y - grabY)}px, 0)`;
}

function liftClone(src: HTMLElement): HTMLElement {
  const pill = src.cloneNode(true) as HTMLElement;
  pill.removeAttribute("id");
  pill.classList.add("drag-lift");
  pill.classList.remove("is-drag-source", "active", "is-on", "is-pinned");
  pill.setAttribute("aria-hidden", "true");
  for (const n of pill.querySelectorAll("[id]")) n.removeAttribute("id");
  const r = src.getBoundingClientRect();
  pill.style.width = `${Math.round(r.width)}px`;
  pill.style.position = "fixed";
  pill.style.left = "0";
  pill.style.top = "0";
  pill.style.zIndex = "90";
  pill.style.pointerEvents = "none";
  pill.style.margin = "0";
  document.body.appendChild(pill);
  return pill;
}

function applyAxisShifts(
  items: HTMLElement[],
  from: number,
  insert: number,
  axis: "x" | "y",
  gap: number,
) {
  if (!items.length) return;
  const src = from >= 0 ? items[from] : items[0];
  const size = axis === "x" ? src.offsetWidth : src.offsetHeight;
  const delta = size + gap;
  const fn = axis === "x" ? "translateX" : "translateY";
  for (let i = 0; i < items.length; i++) {
    if (i === from) {
      items[i].style.transform = "";
      continue;
    }
    let d = 0;
    if (from < 0) {
      if (i >= insert) d = delta;
    } else if (from < insert && i > from && i < insert) d = -delta;
    else if (from > insert && i >= insert && i < from) d = delta;
    items[i].style.transform = d ? `${fn}(${d}px)` : "";
  }
}

function clearAxisShifts(host: HTMLElement | null) {
  if (!host) return;
  host.classList.remove("is-shifting");
  for (const el of host.querySelectorAll<HTMLElement>(":scope > *")) {
    el.style.transform = "";
  }
}

function flipFromFirst(
  items: HTMLElement[],
  first: Map<string, DOMRect>,
  keyOf: (el: HTMLElement) => string,
) {
  if (!motionOk() || !items.length) return;
  for (const el of items) {
    const a = first.get(keyOf(el));
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.style.transition = "none";
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  items[0].getBoundingClientRect();
  for (const el of items) {
    el.style.transition = `transform var(--dur-enter) ${EASE_OUT}`;
    el.style.transform = "";
  }
  window.setTimeout(() => {
    for (const el of items) {
      el.style.transition = "";
      el.style.transform = "";
    }
  }, 220);
}

function chatRowKey(el: HTMLElement): string {
  return el.dataset.sid || el.dataset.key || "";
}

function captureChatFirst(root: ParentNode): Map<string, DOMRect> {
  const first = new Map<string, DOMRect>();
  if (!motionOk()) return first;
  for (const el of root.querySelectorAll<HTMLElement>("li[data-sid], li[data-key]")) {
    const k = chatRowKey(el);
    if (k) first.set(k, el.getBoundingClientRect());
  }
  return first;
}

function flipChatFirst(root: ParentNode, first: Map<string, DOMRect>) {
  if (!motionOk() || first.size === 0) return;
  const items = [
    ...root.querySelectorAll<HTMLElement>("li[data-sid], li[data-key]"),
  ];
  if (!items.length) return;
  let moved = false;
  for (const el of items) {
    const k = chatRowKey(el);
    const a = k ? first.get(k) : undefined;
    el.style.transition = "none";
    if (a) {
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) {
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        moved = true;
      }
    } else {
      const head = el.parentElement?.querySelector<HTMLElement>(
        ":scope > li[data-sid], :scope > li[data-key]",
      );
      if (el === head) {
        el.style.transform = `translateY(${-(el.offsetHeight + 4)}px)`;
        el.style.opacity = "0";
        moved = true;
      }
    }
  }
  if (!moved) {
    for (const el of items) el.style.transition = "";
    return;
  }
  items[0].getBoundingClientRect();
  for (const el of items) {
    el.style.transition = `transform var(--dur-enter) ${EASE_OUT}, opacity var(--dur-enter) ${EASE_OUT}`;
    el.style.transform = "";
    el.style.opacity = "";
  }
  window.setTimeout(() => {
    for (const el of items) {
      el.style.transition = "";
      el.style.transform = "";
      el.style.opacity = "";
    }
  }, 220);
}

let projectDrag: {
  pointerId: number;
  from: string;
  x: number;
  y: number;
  live: boolean;
  insert: number;
  pin: boolean;
  handle: HTMLElement;
  pill: HTMLElement | null;
  grabX: number;
  grabY: number;
  shiftHost: HTMLElement | null;
} | null = null;
let chatDrag: {
  pointerId: number;
  from: string;
  label: string;
  active: boolean;
  x: number;
  y: number;
  live: boolean;
  insert: number;
  pin: boolean;
  handle: HTMLElement;
  pill: HTMLElement | null;
  grabX: number;
  grabY: number;
  shiftHost: HTMLElement | null;
} | null = null;
let waitingDrag: {
  pointerId: number;
  from: string;
  chat: ChatRuntime;
  side: boolean;
  label: string;
  x: number;
  y: number;
  live: boolean;
  insert: number;
  handle: HTMLElement;
  row: HTMLElement;
  list: HTMLElement;
  pill: HTMLElement | null;
  grabX: number;
  grabY: number;
} | null = null;
const sessionsCache: Record<string, SessionInfo[]> = {};
let projectSwitchGen = 0;
const diskSnippets: Record<string, string> = {};
let diskSnippetsQ = "";
let searchQueryGen = 0;
let searchIndexRunning = false;
const chats = new Map<string, ChatRuntime>();
/** Side and subagent tabs keyed by ACP chat key. */
const agents = new Map<string, ChatRuntime>();
const sides = agents;
const tabAgents = new Map<string, ChatRuntime>();
const panels = new Map<string, RightPanel>();
const pages = new Map<string, PageTab>();
let activeChatKey: string | null = null;
let ctxTarget: CtxTarget | null = null;
let renameTarget: CtxTarget | null = null;
/** Where the rename UI should appear for the active chat. */
let renameSource: "list" | "topbar" = "list";
let chatSearch = "";
let chatSearchOpen = false;
let archiveArmedKey: string | null = null;
let emptyArchiveArmed = false;
let spotItems: SpotItem[] = [];
let spotIndex = 0;
/** Project path → has `.obsidian`. Filled as rows render. */
const scannedVaults = new Map<string, boolean>();

type SpotHit = {
  cwd: string;
  sessionId: string | null;
  runtime: ChatRuntime | null;
  label: string;
  project: string;
  snippet: string | null;
};

type SpotItem =
  | { kind: "chat"; hit: SpotHit }
  | { kind: "new" }
  | { kind: "folder" };

function parseTrio(raw: unknown): ChatTrio | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const model =
    typeof o.model === "string" && o.model.trim().length > 0
      ? o.model.trim()
      : "";
  const effort =
    typeof o.effort === "string" && o.effort.trim().length > 0
      ? o.effort.trim()
      : "";
  const mode = typeof o.mode === "string" ? canonicalMode(o.mode) : "";
  if (!model && !effort && !mode) return null;
  return {
    model: model || DEFAULT_MODEL,
    effort: effort || DEFAULT_EFFORT,
    mode: mode || "auto",
  };
}

function parseTrioMap(raw: unknown): Record<string, ChatTrio> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ChatTrio> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k) continue;
    const t = parseTrio(v);
    if (t) out[k] = t;
  }
  return out;
}

function parseFlagMap(raw: unknown): Record<string, true> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, true> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k && v) out[k] = true;
  }
  return out;
}

function parseNameMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== "string") continue;
    const n = v.trim();
    if (n) out[k] = n;
  }
  return out;
}

function parsePinnedMix(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    if (!v.startsWith("p:") && !v.startsWith("c:")) continue;
    if (v.length < 3 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function seedPinnedMix(
  pinned: string[],
  pinnedProjects: Record<string, true>,
  recent: string[],
): string[] {
  const mix: string[] = [];
  for (const p of recent) {
    if (pinnedProjects[p]) mix.push(`p:${p}`);
  }
  for (const k of pinned) mix.push(`c:${k}`);
  return mix;
}

function reconcilePinnedMix(
  mix: string[],
  pinned: string[],
  pinnedProjects: Record<string, true>,
  recent: string[],
): string[] {
  const chats = new Set(pinned);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of mix) {
    if (id.startsWith("p:")) {
      const path = id.slice(2);
      if (!path || !pinnedProjects[path] || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    } else if (id.startsWith("c:")) {
      const key = id.slice(2);
      if (!key || !chats.has(key) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  for (const p of recent) {
    const id = `p:${p}`;
    if (pinnedProjects[p] && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const k of pinned) {
    const id = `c:${k}`;
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

function parseNumMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
    out[k] = Math.round(v);
  }
  return out;
}

function parseWindowBounds(raw: unknown): WindowBounds | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nums = [o.x, o.y, o.w, o.h];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
    return null;
  }
  return {
    x: Math.round(o.x as number),
    y: Math.round(o.y as number),
    w: Math.max(MIN_WIN_W, Math.round(o.w as number)),
    h: Math.max(MIN_WIN_H, Math.round(o.h as number)),
  };
}

function parseThemePref(raw: unknown): ThemePref {
  return typeof raw === "string" && THEME_PREFS.has(raw as ThemePref)
    ? (raw as ThemePref)
    : "dark";
}

function parseAccentId(raw: unknown): AccentId {
  // Earlier builds stored other swatch ids.
  if (raw === "coral" || raw === "clay") return "orange";
  if (raw === "yellow" || raw === "amber" || raw === "gold") return "teal";
  return typeof raw === "string" && ACCENT_IDS.has(raw as AccentId)
    ? (raw as AccentId)
    : "orange";
}

function parseTypeScale(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return TYPE_SCALE_DEFAULT;
  const n = Math.round(raw / TYPE_SCALE_STEP) * TYPE_SCALE_STEP;
  return Math.min(TYPE_SCALE_MAX, Math.max(TYPE_SCALE_MIN, n));
}

function systemIsLight(): boolean {
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

function resolvedTheme(pref: ThemePref = prefs.theme): ResolvedTheme {
  if (pref === "system") return systemIsLight() ? "light" : "dark";
  return pref;
}

function applyAppearance() {
  const theme = resolvedTheme();
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = prefs.accent;
  applyTypeScale();
  paintAppearanceControls();
  void syncWindowTheme(prefs.theme);
}

function withoutThemeMotion(fn: () => void) {
  const root = document.documentElement;
  root.classList.add("is-theme-swap");
  fn();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.remove("is-theme-swap"));
  });
}

function applyTypeScale() {
  document.documentElement.style.setProperty(
    "--ui-zoom",
    String(prefs.typeScale / 100),
  );
  document.documentElement.classList.toggle("is-zoomed", prefs.typeScale !== 100);
  resetLiveTurnMetrics();
}

function layoutSegThumb(row: HTMLElement | null, selected: HTMLElement | null) {
  if (!row || row.closest("[hidden]")) return;
  let thumb = row.querySelector(":scope > .seg-thumb") as HTMLElement | null;
  if (!thumb) {
    thumb = document.createElement("span");
    thumb.className = "seg-thumb";
    thumb.setAttribute("aria-hidden", "true");
    row.insertBefore(thumb, row.firstChild);
  }
  if (!selected || selected.parentElement !== row) {
    thumb.style.opacity = "0";
    return;
  }
  const rr = row.getBoundingClientRect();
  const br = selected.getBoundingClientRect();
  if (rr.width < 1 || br.width < 1) {
    thumb.style.opacity = "0";
    thumb.classList.remove("is-ready");
    return;
  }
  const toW = Math.round(br.width);
  const toH = Math.round(br.height);
  const to = `translate(${Math.round(br.left - rr.left)}px, ${Math.round(br.top - rr.top)}px)`;
  const ready = thumb.classList.contains("is-ready");
  const fromW = thumb.offsetWidth;
  const fromH = thumb.offsetHeight;
  const fromT = getComputedStyle(thumb).transform;
  thumb.getAnimations().forEach((a) => a.cancel());
  thumb.style.opacity = "1";
  thumb.style.width = `${toW}px`;
  thumb.style.height = `${toH}px`;
  thumb.style.transform = to;
  if (ready && motionOk()) {
    thumb.animate(
      [
        {
          width: `${fromW}px`,
          height: `${fromH}px`,
          transform: fromT === "none" ? "translate(0px, 0px)" : fromT,
        },
        { width: `${toW}px`, height: `${toH}px`, transform: to },
      ],
      { duration: 180, easing: EASE_IN_OUT },
    );
  }
  thumb.classList.add("is-ready");
}

function layoutSegThumbs() {
  const tabs = document.querySelector(".plugins-tabs-row") as HTMLElement | null;
  layoutSegThumb(tabs, tabs?.querySelector(".plugins-tab.is-on") as HTMLElement | null);
  document.querySelectorAll<HTMLElement>(".appear-seg").forEach((seg) => {
    layoutSegThumb(seg, seg.querySelector(".appear-opt.is-on"));
  });
}

function paintAppearanceControls() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-theme].appear-opt")) {
    const on = btn.dataset.theme === prefs.theme;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
    btn.setAttribute("role", "radio");
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-accent].appear-swatch")) {
    const on = btn.dataset.accent === prefs.accent;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
    btn.setAttribute("role", "radio");
  }
  const value = $<HTMLButtonElement>("#type-scale-value");
  const smaller = $<HTMLButtonElement>("#type-smaller");
  const larger = $<HTMLButtonElement>("#type-larger");
  if (value) value.textContent = `${prefs.typeScale}%`;
  if (smaller) smaller.disabled = prefs.typeScale <= TYPE_SCALE_MIN;
  if (larger) larger.disabled = prefs.typeScale >= TYPE_SCALE_MAX;
  layoutSegThumbs();
}

let typeScaleAt = 0;

function bumpTypeScale(dir: 1 | -1) {
  const now = Date.now();
  // Menu shortcut and the window keydown can both fire once.
  if (now - typeScaleAt < 200) return;
  typeScaleAt = now;
  setTypeScale(prefs.typeScale + dir * TYPE_SCALE_STEP);
}

function resetTypeScale() {
  const now = Date.now();
  if (now - typeScaleAt < 200) return;
  typeScaleAt = now;
  setTypeScale(TYPE_SCALE_DEFAULT);
}

function setTypeScale(next: number) {
  const scale = parseTypeScale(next);
  if (scale === prefs.typeScale) {
    paintAppearanceControls();
    return;
  }
  prefs.typeScale = scale;
  savePrefs();
  applyTypeScale();
  paintAppearanceControls();
}

async function syncWindowTheme(pref: ThemePref) {
  try {
    await getCurrentWindow().setTheme(pref === "system" ? null : pref);
  } catch {
    /* web preview or missing window permission */
  }
}

function setThemePref(next: ThemePref) {
  if (!THEME_PREFS.has(next) || prefs.theme === next) {
    paintAppearanceControls();
    return;
  }
  prefs.theme = next;
  savePrefs();
  paintAppearanceControls();
  withoutThemeMotion(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme();
    applyTypeScale();
    void syncWindowTheme(prefs.theme);
  });
}

function setAccentId(next: AccentId) {
  if (!ACCENT_IDS.has(next) || prefs.accent === next) {
    paintAppearanceControls();
    return;
  }
  prefs.accent = next;
  savePrefs();
  withoutThemeMotion(applyAppearance);
}

function emptyPrefs(): Prefs {
  return {
    activeCwd: null,
    recent: [],
    mode: "auto",
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    projectSeed: {},
    chatSettings: {},
    sessionByCwd: {},
    archive: [],
    gone: [],
    titles: {},
    messageTimes: {},
    messageQuotes: {},
    pinned: [],
    pinnedProjects: {},
    projectNames: {},
    pinnedMix: [],
    projectExpanded: {},
    navCollapsed: {},
    lastActive: {},
    mcpOff: [],
    mcpMarks: {},
    mcpNames: {},
    waiting: {},
    panels: {},
    sideWidth: DEFAULT_SIDE_W,
    sidebarWidth: DEFAULT_SIDEBAR_W,
    sidebarOpen: true,
    tasksPinned: true,
    windowBounds: null,
    theme: "dark",
    accent: "orange",
    typeScale: TYPE_SCALE_DEFAULT,
  };
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return emptyPrefs();
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const recent = Array.isArray(parsed.recent)
      ? parsed.recent.filter((p): p is string => typeof p === "string" && p.length > 0)
      : [];
    const activeCwd =
      typeof parsed.activeCwd === "string" && parsed.activeCwd.length > 0
        ? parsed.activeCwd
        : null;
    const mode =
      typeof parsed.mode === "string" ? canonicalMode(parsed.mode) : "auto";
    const model =
      typeof parsed.model === "string" && parsed.model.trim().length > 0
        ? parsed.model.trim()
        : DEFAULT_MODEL;
    const effort =
      typeof parsed.effort === "string" && parsed.effort.trim().length > 0
        ? parsed.effort.trim()
        : DEFAULT_EFFORT;
    const projectSeed = parseTrioMap(parsed.projectSeed);
    const chatSettings = parseTrioMap(parsed.chatSettings);
    const sessionByCwd =
      parsed.sessionByCwd && typeof parsed.sessionByCwd === "object"
        ? (parsed.sessionByCwd as Record<string, string>)
        : {};
    const archive = parseArchive(parsed.archive);
    const gone = parseGone(parsed.gone);
    const titles =
      parsed.titles && typeof parsed.titles === "object"
        ? (parsed.titles as Record<string, string>)
        : {};
    const messageTimes = parseMessageTimes(parsed.messageTimes);
    const messageQuotes = parseMessageQuotes(parsed.messageQuotes);
    const pinned = parseNameList(parsed.pinned);
    const pinnedProjects = parseFlagMap(parsed.pinnedProjects);
    const projectNames = parseNameMap(parsed.projectNames);
    const pinnedMixRaw = parsePinnedMix(parsed.pinnedMix);
    const pinnedMix =
      pinnedMixRaw.length > 0
        ? reconcilePinnedMix(pinnedMixRaw, pinned, pinnedProjects, recent)
        : seedPinnedMix(pinned, pinnedProjects, recent);
    const projectExpanded = parseFlagMap(parsed.projectExpanded);
    const navCollapsed = parseFlagMap(parsed.navCollapsed);
    const lastActive = parseNumMap(parsed.lastActive);
    const mcpOff = parseNameList(parsed.mcpOff);
    const mcpMarks = parseNameMap(parsed.mcpMarks);
    const mcpNames = parseNameMap(parsed.mcpNames);
    const waiting = parseWaitingMap(parsed.waiting);
    const panels = parseStoredPanels(parsed.panels);
    const sideWidth =
      typeof parsed.sideWidth === "number" &&
      parsed.sideWidth >= MIN_SIDE_W &&
      parsed.sideWidth <= 900
        ? Math.round(parsed.sideWidth)
        : DEFAULT_SIDE_W;
    const sidebarWidth =
      typeof parsed.sidebarWidth === "number"
        ? Math.max(
            MIN_SIDEBAR_W,
            Math.min(MAX_SIDEBAR_W, Math.round(parsed.sidebarWidth)),
          )
        : DEFAULT_SIDEBAR_W;
    const sidebarOpen =
      typeof parsed.sidebarOpen === "boolean" ? parsed.sidebarOpen : true;
    const tasksPinned =
      typeof parsed.tasksPinned === "boolean" ? parsed.tasksPinned : true;
    const windowBounds = parseWindowBounds(parsed.windowBounds);
    const theme = parseThemePref(parsed.theme);
    const accent = parseAccentId(parsed.accent);
    const typeScale = parseTypeScale(parsed.typeScale);
    return {
      activeCwd,
      recent,
      mode,
      model,
      effort,
      projectSeed,
      chatSettings,
      sessionByCwd,
      archive,
      gone,
      titles,
      messageTimes,
      messageQuotes,
      pinned,
      pinnedProjects,
      projectNames,
      pinnedMix,
      projectExpanded,
      navCollapsed,
      lastActive,
      mcpOff,
      mcpMarks,
      mcpNames,
      waiting,
      panels,
      sideWidth,
      sidebarWidth,
      sidebarOpen,
      tasksPinned,
      windowBounds,
      theme,
      accent,
      typeScale,
    };
  } catch {
    return emptyPrefs();
  }
}

/** Last list_models result (effort menus). */
let modelCatalog: ModelInfo[] = [];

function modelById(id: string | null | undefined): ModelInfo | null {
  if (!id) return null;
  return modelCatalog.find((m) => m.id === id) ?? null;
}

function effortsForModel(modelId: string | null | undefined): EffortOption[] {
  const fromModel = modelById(modelId)?.efforts;
  if (fromModel && fromModel.length > 0) return fromModel;
  return FALLBACK_EFFORTS;
}

const PAIR_SEP = "::";

function pairValue(modelId: string, effortId: string): string {
  return `${modelId}${PAIR_SEP}${effortId}`;
}

function parsePair(value: string): { model: string; effort: string } {
  const i = value.indexOf(PAIR_SEP);
  if (i <= 0) {
    return {
      model: value || prefs.model || DEFAULT_MODEL,
      effort: prefs.effort || DEFAULT_EFFORT,
    };
  }
  return {
    model: value.slice(0, i),
    effort: value.slice(i + PAIR_SEP.length),
  };
}

function clampTrio(raw: Partial<ChatTrio> | null | undefined): ChatTrio {
  const mode = canonicalMode(raw?.mode);
  const wantModel = (raw?.model || "").trim() || DEFAULT_MODEL;
  const wantEffort = (raw?.effort || "").trim() || DEFAULT_EFFORT;
  if (modelCatalog.length === 0) {
    return { model: wantModel, effort: wantEffort, mode };
  }
  const model =
    modelCatalog.find((m) => m.id === wantModel)?.id ??
    modelCatalog.find((m) => m.isDefault)?.id ??
    modelCatalog[0]?.id ??
    DEFAULT_MODEL;
  const efforts = effortsForModel(model);
  const effort = efforts.some((e) => e.id === wantEffort)
    ? wantEffort
    : (efforts.find((e) => e.isDefault)?.id ??
      efforts[0]?.id ??
      DEFAULT_EFFORT);
  return { model, effort, mode };
}

function trioOf(chat: ChatRuntime): ChatTrio {
  return { model: chat.model, effort: chat.effort, mode: chat.mode };
}

function defaultTrio(): ChatTrio {
  return clampTrio({
    model: prefs.model,
    effort: prefs.effort,
    mode: prefs.mode,
  });
}

function seedForProject(cwd: string): ChatTrio {
  return prefs.projectSeed[cwd]
    ? clampTrio(prefs.projectSeed[cwd])
    : defaultTrio();
}

function trioForSession(cwd: string, sessionId: string): ChatTrio {
  return clampTrio(
    prefs.chatSettings[titleKey(cwd, sessionId)] ?? seedForProject(cwd),
  );
}

/** Project seed follows the focused chat. */
function touchProjectSeed(chat: ChatRuntime) {
  const trio = trioOf(chat);
  prefs.projectSeed[chat.cwd] = trio;
  prefs.model = trio.model;
  prefs.effort = trio.effort;
  prefs.mode = trio.mode;
  savePrefs();
}

function persistSessionTrio(chat: ChatRuntime) {
  if (!chat.sessionId) return;
  prefs.chatSettings[titleKey(chat.cwd, chat.sessionId)] = trioOf(chat);
  savePrefs();
}

function paintComposerFrom(chat: ChatRuntime | null) {
  const trio = chat
    ? clampTrio(chat)
    : prefs.activeCwd
      ? seedForProject(prefs.activeCwd)
      : defaultTrio();
  if (chat) {
    const changed =
      chat.model !== trio.model ||
      chat.effort !== trio.effort ||
      chat.mode !== trio.mode;
    chat.model = trio.model;
    chat.effort = trio.effort;
    chat.mode = trio.mode;
    if (changed && chat.sessionId && modelCatalog.length > 0) {
      persistSessionTrio(chat);
    }
  }
  const modelBtn = modelEffortBtn();
  if (modelBtn) modelBtn.textContent = pairLabel(trio.model, trio.effort);
  paintModeBtn(trio.mode);
  fitComposerPills();
  requestAnimationFrame(() => fitComposerPills());
  paintContextRing(chat);
}

function fitPillSelect(el: HTMLElement | null, label: string, iconPx = 0) {
  if (!el) return;
  const probe = document.createElement("span");
  probe.textContent = label;
  const cs = getComputedStyle(el);
  probe.style.cssText =
    "position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden;" +
    `font:${cs.font};letter-spacing:${cs.letterSpacing}`;
  document.body.appendChild(probe);
  const extra =
    (parseFloat(cs.paddingLeft) || 0) +
    (parseFloat(cs.paddingRight) || 0) +
    (parseFloat(cs.borderLeftWidth) || 0) +
    (parseFloat(cs.borderRightWidth) || 0);
  const gap = iconPx > 0 ? (parseFloat(cs.columnGap) || parseFloat(cs.gap) || 6) : 0;
  const w = probe.getBoundingClientRect().width + extra + iconPx + gap + 2;
  probe.remove();
  if (w < 8) return;
  el.style.width = `${Math.ceil(w)}px`;
}

function fitComposerPills() {
  const trio = activeChat() ? trioOf(activeChat()!) : defaultTrio();
  fitPillSelect(modelEffortBtn(), pairLabel(trio.model, trio.effort));
  fitPillSelect(modeBtn(), modeLabel(trio.mode), 16);
}

async function loadModels() {
  try {
    const models = await invoke<ModelInfo[]>("list_models");
    modelCatalog = models.length ? models : [FALLBACK_MODEL];
  } catch {
    modelCatalog = [FALLBACK_MODEL];
  }
  paintComposerFrom(activeChat());
  paintContextRing();
  void document.fonts.ready.then(() => fitComposerPills());
}

type ComposerPickKind = "model" | "mode";
let composerPick: ComposerPickKind | null = null;
let composerPickIndex = 0;
let composerPickValues: string[] = [];

function isComposerPickOpen(): boolean {
  return composerPick != null && composerPickEl()?.hidden === false;
}

function closeComposerPick() {
  composerPick = null;
  composerPickValues = [];
  const menu = composerPickEl();
  if (menu) menu.hidden = true;
  modelEffortBtn()?.setAttribute("aria-expanded", "false");
  modeBtn()?.setAttribute("aria-expanded", "false");
}

function placeComposerPick() {
  const menu = composerPickEl();
  const btn = composerPick === "mode" ? modeBtn() : modelEffortBtn();
  if (!menu || menu.hidden || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = 280;
  const gap = 8;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const below = window.innerHeight - r.bottom - gap;
  const above = r.top - gap;
  const openDown = below >= 160 || below >= above;
  menu.style.left = `${Math.round(left)}px`;
  if (openDown) {
    menu.style.top = `${Math.round(r.bottom + gap)}px`;
    menu.style.bottom = "auto";
    menu.style.maxHeight = `${Math.round(Math.min(360, Math.max(120, below)))}px`;
    menu.style.transformOrigin = "top left";
  } else {
    menu.style.bottom = `${Math.round(window.innerHeight - r.top + gap)}px`;
    menu.style.top = "auto";
    menu.style.maxHeight = `${Math.round(Math.min(360, Math.max(120, above)))}px`;
    menu.style.transformOrigin = "bottom left";
  }
}

function setComposerPickIndex(i: number) {
  const rows = composerPickList()?.querySelectorAll<HTMLElement>(".new-project-item");
  if (!rows?.length) return;
  composerPickIndex = ((i % rows.length) + rows.length) % rows.length;
  rows.forEach((row, n) => {
    row.classList.toggle("is-on", n === composerPickIndex);
  });
  rows[composerPickIndex]?.scrollIntoView({ block: "nearest" });
}

function appendComposerPickRow(
  list: HTMLElement,
  value: string,
  label: string,
  on: boolean,
  glyph?: ReturnType<typeof modeGlyph>,
) {
  const i = composerPickValues.length;
  composerPickValues.push(value);
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "new-project-item";
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-selected", on ? "true" : "false");
  if (glyph) {
    const ico = document.createElement("span");
    ico.className = "new-project-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.appendChild(iconEl(glyph, { size: 16 }));
    btn.appendChild(ico);
  }
  const lab = document.createElement("span");
  lab.className = "new-project-item-name";
  lab.textContent = label;
  btn.appendChild(lab);
  if (on) {
    composerPickIndex = i;
    const mark = document.createElement("span");
    mark.className = "new-project-check";
    mark.setAttribute("aria-hidden", "true");
    mark.appendChild(iconEl(Ico.check, { size: 16 }));
    btn.appendChild(mark);
  }
  btn.addEventListener("click", () => applyComposerPick(value));
  li.appendChild(btn);
  list.appendChild(li);
}

function paintComposerPick() {
  const list = composerPickList();
  if (!list || !composerPick) return;
  list.replaceChildren();
  composerPickValues = [];
  composerPickIndex = 0;
  if (composerPick === "mode") {
    const cur = canonicalMode(activeChat()?.mode || prefs.mode);
    for (const mode of MODE_ORDER) {
      appendComposerPickRow(
        list,
        mode,
        modeLabel(mode),
        mode === cur,
        modeGlyph(mode),
      );
    }
    return;
  }
  const trio = activeChat() ? trioOf(activeChat()!) : defaultTrio();
  const cur = pairValue(trio.model, trio.effort);
  const models = modelCatalog.length ? modelCatalog : [FALLBACK_MODEL];
  for (const m of models) {
    const head = document.createElement("li");
    head.className = "composer-pick-head";
    head.textContent = m.name || m.id;
    list.appendChild(head);
    const es = m.efforts && m.efforts.length > 0 ? m.efforts : FALLBACK_EFFORTS;
    for (const e of es) {
      const v = pairValue(m.id, e.id);
      appendComposerPickRow(
        list,
        v,
        `${m.name || m.id} - ${e.label || e.id}`,
        v === cur,
      );
    }
  }
}

function applyComposerPick(value: string) {
  if (composerPick === "mode") {
    if (MODES.has(value)) void onModeChange(value);
  } else {
    const pair = parsePair(value);
    const chat = activeChat();
    if (chat) {
      chat.model = pair.model;
      chat.effort = pair.effort;
      persistSessionTrio(chat);
      touchProjectSeed(chat);
    } else {
      prefs.model = pair.model;
      prefs.effort = pair.effort;
      savePrefs();
    }
    paintContextRing();
  }
  closeComposerPick();
  paintComposerFrom(activeChat());
}

function toggleComposerPick(kind: ComposerPickKind) {
  if (composerPick === kind && isComposerPickOpen()) {
    closeComposerPick();
    return;
  }
  hideSuggest();
  closeNewChatMenus();
  composerPick = kind;
  const menu = composerPickEl();
  if (menu) menu.hidden = false;
  modelEffortBtn()?.setAttribute("aria-expanded", kind === "model" ? "true" : "false");
  modeBtn()?.setAttribute("aria-expanded", kind === "mode" ? "true" : "false");
  paintComposerPick();
  placeComposerPick();
}

function onComposerPickKey(e: KeyboardEvent): boolean {
  if (!isComposerPickOpen()) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setComposerPickIndex(composerPickIndex + 1);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    setComposerPickIndex(composerPickIndex - 1);
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const value = composerPickValues[composerPickIndex];
    if (value) applyComposerPick(value);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeComposerPick();
    input()?.focus();
    return true;
  }
  return false;
}

function contextSizeFor(chat: ChatRuntime | null): number {
  if (chat && chat.contextSize > 0) return chat.contextSize;
  const id = chat?.model || prefs.model || DEFAULT_MODEL;
  return modelById(id)?.contextWindow || FALLBACK_MODEL.contextWindow || 0;
}

function compactPercentFor(chat: ChatRuntime | null = activeChat()): number {
  const id = chat?.model || prefs.model || DEFAULT_MODEL;
  const n = modelById(id)?.autoCompactPercent ?? FALLBACK_MODEL.autoCompactPercent ?? 80;
  return Math.min(100, Math.max(1, n));
}

function paintContextRing(chat: ChatRuntime | null = activeChat()) {
  const el = contextRing();
  const fill = el?.querySelector<SVGCircleElement>(".ctx-ring-fill");
  const usedEl = $("#ctx-pop-used");
  const leftEl = $("#ctx-pop-left");
  if (!el || !fill) return;
  const used = chat?.contextUsed ?? 0;
  const size = contextSizeFor(chat);
  const usedPct = size > 0 ? Math.min(100, used / size) : 0;
  const remainPct = 1 - usedPct;
  const c = 2 * Math.PI * 6;
  fill.style.strokeDasharray = String(c);
  fill.style.strokeDashoffset = String(c * usedPct);
  const thresh = compactPercentFor(chat) / 100;
  el.classList.toggle("is-high", size > 0 && usedPct >= thresh);
  const usedLabel = size > 0 ? `${formatTokenCount(used)} of ${formatTokenCount(size)} is used` : "Context unknown";
  if (usedEl) usedEl.textContent = usedLabel;
  if (leftEl) {
    if (size > 0) {
      const until = Math.max(0, Math.round(size * thresh) - used);
      leftEl.textContent =
        until > 0
          ? `${formatTokenCount(until)} until auto-compact`
          : "At auto-compact";
      leftEl.hidden = false;
    } else {
      leftEl.hidden = true;
    }
  }
  el.setAttribute("aria-label", usedLabel);
  el.setAttribute("aria-valuenow", String(Math.round(remainPct * 100)));
}

function applyUsage(chat: ChatRuntime, used: number, size?: number) {
  if (used > 0) chat.contextUsed = used;
  if (size && size > 0) chat.contextSize = size;
  if (activeChatKey === chat.key) paintContextRing(chat);
}

async function refreshContextUsage(chat: ChatRuntime) {
  if (!chat.sessionId) {
    if (activeChatKey === chat.key) paintContextRing(chat);
    return;
  }
  try {
    const u = await invoke<{ used: number; size: number }>("load_session_usage", {
      cwd: chat.cwd,
      sessionId: chat.sessionId,
    });
    applyUsage(chat, u.used, u.size);
  } catch {
    if (activeChatKey === chat.key) paintContextRing(chat);
  }
}

const FALLBACK_SLASH: SlashCmd[] = [
  { name: "compact", description: "Compact conversation history" },
  { name: "imagine", description: "Generate an image" },
];

const deskRecents: string[] = [];
let skillCache: { cwd: string; cmds: SlashCmd[] } | null = null;
let suggestKind: SuggestKind | null = null;
let suggestItems: SuggestItem[] = [];
let suggestIndex = 0;
let suggestKeyNav = false;
let suggestAtStart = 0;
let suggestAtEnd = 0;
let pathTimer = 0;
let slashGen = 0;
let pathGen = 0;

function rememberPrompt(text: string) {
  const t = text.trim();
  if (!t) return;
  const i = deskRecents.indexOf(t);
  if (i >= 0) deskRecents.splice(i, 1);
  deskRecents.unshift(t);
  if (deskRecents.length > 20) deskRecents.length = 20;
}

function slashCatalog(chat: ChatRuntime | null): SlashCmd[] {
  const raw =
    chat && chat.slashCommands.length > 0 ? chat.slashCommands : FALLBACK_SLASH;
  return raw.filter((c) => c.name.toLowerCase() !== "help");
}

async function skillsFor(cwd: string): Promise<SlashCmd[]> {
  if (skillCache?.cwd === cwd) return skillCache.cmds;
  try {
    const cmds = await invoke<SlashCmd[]>("list_skill_commands", { cwd });
    skillCache = {
      cwd,
      cmds: Array.isArray(cmds)
        ? cmds.map((c) => ({ ...c, skill: true }))
        : [],
    };
  } catch {
    skillCache = { cwd, cmds: [] };
  }
  return skillCache.cmds;
}

function isCenteredComposer(chat: ChatRuntime | null): boolean {
  if (!chat) return true;
  if (chat.runInFlight) return false;
  return !chat.lines.some((l) => l.kind === "user" || l.kind === "assistant");
}

function canUseSideChat(chat: ChatRuntime | null): boolean {
  return !!prefs.activeCwd && !!chat && !isCenteredComposer(chat) && !pageOpen();
}

function pageCovered(): boolean {
  return !!document.getElementById("shell")?.classList.contains("page-open");
}

function fadeEmptyTrayOut() {
  const bar = newProjectBar();
  if (!bar || bar.hidden || bar.classList.contains("is-leaving")) return;
  closeNewChatMenus();
  bar.classList.add("is-leaving");
  bar.hidden = false;
  const fade = bar.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 150,
    easing: EASE_OUT,
  });
  void fade.finished.finally(() => {
    if (!bar.classList.contains("is-leaving")) return;
    bar.classList.remove("is-leaving");
    bar.style.removeProperty("opacity");
    paintNewProjectBar();
  });
}

function syncEmptyMain(chat: ChatRuntime | null = activeChat()) {
  // Keep empty layout under a page so the composer stays put.
  const on = isCenteredComposer(chat);
  if (on && findOpen) closeFind();
  const main = mainPane();
  const stack = $<HTMLElement>(".composer-stack");
  const card = form();
  const lead = emptyLead();
  const was = !!main?.classList.contains("is-empty-chat");
  if (main && stack && card && was !== on && motionOk()) {
    // Composer top, not the dock — empty layout stretches the dock to the pane.
    const fromTop = card.getBoundingClientRect().top;
    if (was && !on) {
      if (lead) {
        lead.animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateY(-6px)" },
          ],
          { duration: 150, easing: EASE_OUT },
        );
      }
      fadeEmptyTrayOut();
    }
    main.classList.toggle("is-empty-chat", on);
    if (lead) lead.hidden = !on;
    if (!(was && !on)) paintNewProjectBar();
    const dy = fromTop - card.getBoundingClientRect().top;
    if (Math.abs(dy) > 2) {
      stack.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
        { duration: 200, easing: EASE_OUT },
      );
    }
    if (lead && on) {
      lead.animate(
        [
          { opacity: 0, transform: "translateY(-6px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 180, easing: EASE_OUT },
      );
    }
    requestAnimationFrame(() => fitComposerPills());
    return;
  }
  main?.classList.toggle("is-empty-chat", on);
  if (lead) lead.hidden = !on;
  paintNewProjectBar();
  requestAnimationFrame(() => fitComposerPills());
}

function markQuery(
  text: string,
  caret: number,
  mark: "/" | "@",
): { start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = new RegExp(`(?:^|[\\s])\\${mark}([^\\s]*)$`).exec(before);
  if (!m) return null;
  if (m[1] && lockedMarks.has(`${mark}${m[1]}`)) return null;
  return { start: caret - m[1].length - 1, q: m[1] };
}

function hideSuggest() {
  slashGen++;
  pathGen++;
  window.clearTimeout(pathTimer);
  suggestKind = null;
  suggestItems = [];
  suggestIndex = 0;
  suggestKeyNav = false;
  const box = suggestBox();
  if (box) {
    box.hidden = true;
    box.classList.remove("is-key");
    box.style.removeProperty("top");
    box.style.removeProperty("bottom");
    box.style.removeProperty("left");
    box.style.removeProperty("width");
    box.querySelectorAll(".suggest-kicker").forEach((el) => el.remove());
  }
  const list = suggestList();
  if (list) list.replaceChildren();
  syncSuggestAria();
}

const SUGGEST_ICO = {
  cmd: iconHtml(Ico.command, { size: 16, className: "suggest-ico" }),
  skill: MARK_SLASH_SVG,
  folder: iconHtml(Ico.folder, { size: 16, className: "suggest-ico" }),
  file: MARK_FILE_SVG,
  recent: iconHtml(Ico.clock, { size: 16, className: "suggest-ico" }),
};

function paintSuggest() {
  const box = suggestBox();
  const list = suggestList();
  if (!box || !list) return;
  if (!suggestKind || suggestItems.length === 0) {
    hideSuggest();
    return;
  }
  list.replaceChildren();
  box.querySelectorAll(".suggest-kicker").forEach((el) => el.remove());
  let lastSection = "";
  const sectionLabel: Record<string, string> = {
    cmd: "Commands",
    skill: "Skills",
    path: "Files",
    plugin: "Plugins",
    recent: "Recent",
  };
  const sections = new Set(
    suggestItems.map((it) => it.section || suggestKind || "cmd"),
  );
  const only = sections.size === 1 ? [...sections][0] : "";
  const kickerText = only && sectionLabel[only] ? sectionLabel[only] : "";
  if (kickerText) {
    const kicker = document.createElement("div");
    kicker.className = "suggest-kicker";
    kicker.textContent = kickerText;
    box.prepend(kicker);
  }
  suggestItems.forEach((item, i) => {
    const section = item.section || "cmd";
    if (!kickerText && section !== lastSection && sectionLabel[section]) {
      const head = document.createElement("li");
      head.className = "suggest-head";
      head.setAttribute("role", "presentation");
      head.textContent = sectionLabel[section];
      list.appendChild(head);
    }
    lastSection = section;
    const row = document.createElement("li");
    row.setAttribute("role", "presentation");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = `suggest-opt-${i}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("tabindex", "-1");
    btn.setAttribute("aria-selected", i === suggestIndex ? "true" : "false");
    btn.className =
      "suggest-item" +
      (i === suggestIndex ? " is-on" : "") +
      (section === "cmd" || section === "path" ? ` is-${section}` : "");
    if (section === "plugin" && item.pluginName) {
      const mark = document.createElement("span");
      mark.className = "suggest-ico suggest-plugin-mark";
      mark.setAttribute("aria-hidden", "true");
      paintMcpMark(mark, item.pluginName);
      btn.appendChild(mark);
    } else {
      const ico =
        section === "skill"
          ? SUGGEST_ICO.skill
          : section === "path"
            ? item.dir
              ? SUGGEST_ICO.folder
              : SUGGEST_ICO.file
            : section === "recent"
              ? SUGGEST_ICO.recent
              : SUGGEST_ICO.cmd;
      btn.innerHTML = ico;
    }
    const copy = document.createElement("span");
    copy.className = "suggest-copy";
    const name = document.createElement("span");
    name.className = "suggest-name";
    name.textContent = item.label;
    copy.appendChild(name);
    if (item.detail) {
      const detail = document.createElement("span");
      detail.className = "suggest-detail";
      detail.textContent = item.detail;
      copy.appendChild(detail);
    }
    btn.appendChild(copy);
    if (item.section === "skill" && item.source) {
      const tag = slashSourceLabel(item.source);
      if (tag) {
        const src = document.createElement("span");
        src.className = "suggest-source";
        const plugin = pluginSourceName(item.source);
        const fam = plugin ? mcpFamily(plugin) : null;
        if (item.source === "bundled") {
          const mark = document.createElement("img");
          mark.className = "suggest-source-mark";
          mark.src = "/grok-logo.png";
          mark.alt = "";
          mark.width = 16;
          mark.height = 16;
          src.appendChild(mark);
        } else if (plugin && fam && (fam.icon || fam.letters)) {
          const mark = document.createElement("span");
          mark.className = "suggest-source-mark suggest-plugin-mark";
          mark.setAttribute("aria-hidden", "true");
          paintMcpMark(mark, plugin);
          src.appendChild(mark);
        }
        const lab = document.createElement("span");
        lab.textContent = tag;
        src.appendChild(lab);
        btn.appendChild(src);
      }
    }
    btn.addEventListener("mouseenter", () => {
      if (suggestKeyNav) return;
      if (suggestIndex === i) return;
      suggestIndex = i;
      highlightSuggest();
    });
    btn.addEventListener("mousemove", (e) => {
      onSuggestPointerMove(e, i);
    });
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      suggestIndex = i;
      applySuggest();
    });
    row.appendChild(btn);
    list.appendChild(row);
  });
  box.hidden = false;
  pinSuggestToComposer();
  highlightSuggest();
  syncSuggestAria();
}

function pinSuggestToComposer() {
  const box = suggestBox();
  const card = form();
  if (!box || box.hidden || !card) return;
  const empty = !!mainPane()?.classList.contains("is-empty-chat");
  const cardR = card.getBoundingClientRect();
  const gap = 8;
  box.style.left = `${Math.round(cardR.left)}px`;
  box.style.width = `${Math.round(cardR.width)}px`;
  if (empty) {
    box.style.top = `${Math.round(cardR.bottom + gap)}px`;
    box.style.bottom = "auto";
    box.style.transformOrigin = "top center";
    return;
  }
  box.style.bottom = `${Math.round(window.innerHeight - cardR.top + gap)}px`;
  box.style.top = "auto";
  box.style.transformOrigin = "bottom center";
}

function highlightSuggest() {
  const list = suggestList();
  if (!list) return;
  const items = [...list.querySelectorAll<HTMLElement>(".suggest-item")];
  items.forEach((el, i) => {
    const on = i === suggestIndex;
    el.classList.toggle("is-on", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  });
  const on = items[suggestIndex];
  if (!on) return;
  const row = on.closest("li") ?? on;
  const r = row.getBoundingClientRect();
  const lr = list.getBoundingClientRect();
  if (r.top < lr.top) list.scrollTop -= lr.top - r.top;
  else if (r.bottom > lr.bottom) list.scrollTop += r.bottom - lr.bottom;
  syncSuggestAria();
}

function syncSuggestAria() {
  const field = input();
  const list = suggestList();
  const open = !!suggestKind && suggestItems.length > 0;
  if (field) {
    field.setAttribute("aria-autocomplete", "list");
    field.setAttribute("aria-controls", "suggest-list");
    field.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      field.setAttribute("aria-activedescendant", `suggest-opt-${suggestIndex}`);
    } else {
      field.removeAttribute("aria-activedescendant");
    }
  }
  if (!list) return;
  list.setAttribute("role", "listbox");
  const label =
    suggestKind === "path"
      ? "Files and plugins"
      : suggestKind === "slash"
        ? "Commands and skills"
        : suggestKind === "recent"
          ? "Recent prompts"
          : "Suggestions";
  list.setAttribute("aria-label", label);
}

function onSuggestPointerMove(e: MouseEvent, i: number) {
  if (suggestKeyNav) {
    // Scroll can fire mousemove with no pointer move and must not steal the arrow row.
    if (!e.movementX && !e.movementY) return;
    suggestKeyNav = false;
    suggestBox()?.classList.remove("is-key");
  }
  if (suggestIndex === i) return;
  suggestIndex = i;
  highlightSuggest();
}

function moveSuggest(delta: number) {
  if (!suggestItems.length) return;
  suggestKeyNav = true;
  suggestBox()?.classList.add("is-key");
  suggestIndex =
    (suggestIndex + delta + suggestItems.length) % suggestItems.length;
  highlightSuggest();
}

function applySuggest() {
  const item = suggestItems[suggestIndex];
  const field = input();
  if (!item || !field || !suggestKind) return;
  const text = composerText(field);
  const caret = composerCaret(field);
  let pos: number;
  if (suggestKind === "recent") {
    pos = item.insert.length;
    setComposerText(item.insert, pos);
    hideSuggest();
  } else {
    const mark = item.insert.trim();
    if (item.pluginName) {
      pluginChipMeta.set(mark, { label: item.label, name: item.pluginName });
      lockedMarks.add(mark);
    } else if (mark.startsWith("/") || mark.startsWith("@")) {
      lockedMarks.add(mark);
    }
    // Suggest mousedown can move the live caret; keep the token range from last sync.
    const cut = suggestAtEnd >= suggestAtStart ? suggestAtEnd : caret;
    const rest = text.slice(cut);
    const padAfter = rest.startsWith(" ") ? "" : " ";
    const insert = mark + padAfter;
    const next = text.slice(0, suggestAtStart) + insert + rest;
    pos = suggestAtStart + mark.length + padAfter.length;
    suggestAtEnd = pos;
    setComposerText(next, pos);
    hideSuggest();
  }
  applySendChrome();
  const chat = activeChat();
  if (chat) {
    chat.draft = composerText(field);
    chat.lockedMarks = [...lockedMarks];
    chat.pluginMarks = Object.fromEntries(pluginChipMeta);
  }
  field.focus();
  setComposerCaret(field, pos);
}

async function openSlashSuggest(q: string) {
  const gen = ++slashGen;
  const chat = activeChat();
  const cwd = chat?.cwd || prefs.activeCwd || "";
  const skills = cwd ? await skillsFor(cwd) : [];
  if (gen !== slashGen) return;
  const seen = new Set<string>();
  const merged: SlashCmd[] = [];
  for (const c of [...slashCatalog(chat), ...skills]) {
    const key = c.name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(c);
  }
  const needle = q.toLowerCase();
  suggestKind = "slash";
  const cmds = merged.filter((c) => !c.skill);
  const skillRows = merged
    .filter((c) => c.skill && !slashPluginSkillOff(c.source))
    .sort((a, b) => {
      const r = slashSkillRank(a.source) - slashSkillRank(b.source);
      if (r !== 0) return r;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  const toItem = (c: SlashCmd, section: "cmd" | "skill"): SuggestItem => ({
    label: section === "skill" ? c.name : `/${c.name}`,
    detail: c.description,
    insert: `/${c.name}`,
    section,
    source: c.source,
  });
  suggestItems = [
    ...cmds.filter((c) => c.name.toLowerCase().startsWith(needle)).map((c) => toItem(c, "cmd")),
    ...skillRows
      .filter((c) => c.name.toLowerCase().startsWith(needle))
      .map((c) => toItem(c, "skill")),
  ].slice(0, 60);
  suggestIndex = 0;
  paintSuggest();
}

async function openPathSuggest(q: string) {
  const gen = ++pathGen;
  const cwd = activeChat()?.cwd || prefs.activeCwd || recentsCwd || "";
  const needle = q.toLowerCase();
  const plugins = await ensureTrayMcp(cwd);
  if (gen !== pathGen || suggestKind !== "path") return;
  const pluginItems: SuggestItem[] = trayPluginChoices(plugins)
    .filter((c) => {
      if (!needle) return true;
      return (
        c.label.toLowerCase().startsWith(needle) ||
        c.name.toLowerCase().includes(needle)
      );
    })
    .map((c) => ({
      label: c.label,
      detail: "",
      insert: c.label,
      section: "plugin" as const,
      pluginName: c.name,
    }));
  let pathItems: SuggestItem[] = [];
  if (cwd && !isRecentsCwd(cwd)) {
    try {
      const hits = await invoke<Array<{ path: string; isDir: boolean }>>(
        "list_path_hits",
        { cwd, prefix: q },
      );
      if (gen !== pathGen || suggestKind !== "path") return;
      pathItems = hits.map((h) => ({
        label: h.path,
        detail: h.isDir ? "Folder" : "File",
        insert: `@${h.path}`,
        dir: h.isDir,
        section: "path" as const,
      }));
    } catch {
      pathItems = [];
    }
  }
  suggestItems = [...pluginItems, ...pathItems].slice(0, 60);
  if (!suggestItems.length) {
    hideSuggest();
    return;
  }
  suggestIndex = 0;
  paintSuggest();
}

async function openRecentSuggest() {
  const cwd = activeChat()?.cwd || prefs.activeCwd;
  let disk: string[] = [];
  if (cwd) {
    try {
      disk = await invoke<string[]>("load_recent_prompts", { cwd });
    } catch {
      disk = [];
    }
  }
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const p of [...deskRecents, ...disk]) {
    if (seen.has(p)) continue;
    seen.add(p);
    merged.push(p);
    if (merged.length >= 20) break;
  }
  suggestKind = "recent";
  suggestItems = merged.map((p) => ({
    label: p.length > 72 ? `${p.slice(0, 70)}…` : p,
    detail: "",
    insert: p,
    section: "recent" as const,
  }));
  suggestIndex = 0;
  suggestAtStart = 0;
  paintSuggest();
}

function syncSuggest() {
  const field = input();
  if (!field) {
    hideSuggest();
    return;
  }
  const text = composerText(field);
  if (suggestKind === "recent" && text.trim()) hideSuggest();
  const caret = composerCaret(field);
  const slash = markQuery(text, caret, "/");
  if (slash) {
    suggestAtStart = slash.start;
    suggestAtEnd = caret;
    void openSlashSuggest(slash.q);
    return;
  }
  const at = markQuery(text, caret, "@");
  if (at) {
    suggestKind = "path";
    suggestAtStart = at.start;
    suggestAtEnd = caret;
    window.clearTimeout(pathTimer);
    pathTimer = window.setTimeout(() => {
      void openPathSuggest(at.q);
    }, 60);
    return;
  }
  if (suggestKind && suggestKind !== "recent") hideSuggest();
}

function titleKey(cwd: string, sessionId: string): string {
  return `${cwd}::${sessionId}`;
}

function pinKey(
  cwd: string,
  sessionId: string | null,
  runtimeKey?: string | null,
): string | null {
  if (sessionId) return titleKey(cwd, sessionId);
  if (runtimeKey) return titleKey(cwd, `draft:${runtimeKey}`);
  return null;
}

function setEmptyArchiveArmed(on: boolean) {
  emptyArchiveArmed = on;
  const btn = archiveEmptyBtn();
  if (!btn) return;
  btn.classList.toggle("is-confirm", on);
  btn.title = on ? "Click again to empty" : "Hide archived chats for good";
  btn.setAttribute(
    "aria-label",
    on ? "Click again to empty archive" : "Empty archive",
  );
}

function setArchiveArmed(key: string | null) {
  archiveArmedKey = key;
  if (key) setEmptyArchiveArmed(false);
  document.querySelectorAll<HTMLButtonElement>(".chat-trash").forEach((el) => {
    const on = key != null && el.dataset.arm === key;
    el.classList.toggle("is-confirm", on);
    el.title = on ? "Click again to archive" : "Move to Archive";
  });
}

function pinKeyForCtx(target: CtxTarget): string | null {
  if (target.kind === "session") return pinKey(target.cwd, target.sessionId);
  if (target.kind === "draft") return pinKey(target.cwd, null, target.runtimeKey);
  return null;
}

function parsePinKey(
  key: string,
): { cwd: string; sessionId: string | null; draftKey: string | null } | null {
  const i = key.lastIndexOf("::");
  if (i <= 0) return null;
  const cwd = key.slice(0, i);
  const id = key.slice(i + 2);
  if (!cwd || !id) return null;
  if (id.startsWith("draft:")) {
    return { cwd, sessionId: null, draftKey: id.slice(6) };
  }
  return { cwd, sessionId: id, draftKey: null };
}

function mixProjectId(path: string): string {
  return `p:${path}`;
}

function mixChatId(key: string): string {
  return `c:${key}`;
}

function addMixIfMissing(id: string) {
  if (!prefs.pinnedMix.includes(id)) prefs.pinnedMix.push(id);
}

function removeMixId(id: string) {
  const i = prefs.pinnedMix.indexOf(id);
  if (i >= 0) prefs.pinnedMix.splice(i, 1);
}

function moveMixId(id: string, insert: number): boolean {
  const order = prefs.pinnedMix.slice();
  const fromIdx = order.indexOf(id);
  if (fromIdx >= 0) {
    if (insert === fromIdx || insert === fromIdx + 1) return false;
    const [moved] = order.splice(fromIdx, 1);
    let dest = insert > fromIdx ? insert - 1 : insert;
    dest = Math.max(0, Math.min(dest, order.length));
    order.splice(dest, 0, moved);
  } else {
    const dest = Math.max(0, Math.min(insert, order.length));
    order.splice(dest, 0, id);
  }
  prefs.pinnedMix = order;
  return true;
}

function isPinnedKey(key: string | null): boolean {
  return !!key && prefs.pinned.includes(key);
}

function setPinnedKey(key: string | null, on: boolean) {
  if (!key) return;
  const i = prefs.pinned.indexOf(key);
  if (on) {
    if (i < 0) prefs.pinned.push(key);
    addMixIfMissing(mixChatId(key));
  } else if (i >= 0) {
    prefs.pinned.splice(i, 1);
    removeMixId(mixChatId(key));
  } else {
    removeMixId(mixChatId(key));
  }
  savePrefs();
}

function touchLastActive(cwd: string, sessionId: string | null, runtimeKey?: string | null) {
  const key = pinKey(cwd, sessionId, runtimeKey);
  if (!key) return;
  prefs.lastActive[key] = Date.now();
  savePrefs();
}

function migrateDraftPin(chat: ChatRuntime) {
  if (!chat.sessionId) return;
  const from = pinKey(chat.cwd, null, chat.key);
  const to = pinKey(chat.cwd, chat.sessionId);
  if (!from || !to || from === to) return;
  let dirty = false;
  const fromI = prefs.pinned.indexOf(from);
  if (fromI >= 0) {
    const toI = prefs.pinned.indexOf(to);
    if (toI >= 0) prefs.pinned.splice(fromI, 1);
    else prefs.pinned[fromI] = to;
    dirty = true;
  }
  const fromMix = prefs.pinnedMix.indexOf(mixChatId(from));
  if (fromMix >= 0) {
    const toId = mixChatId(to);
    if (prefs.pinnedMix.includes(toId)) prefs.pinnedMix.splice(fromMix, 1);
    else prefs.pinnedMix[fromMix] = toId;
    dirty = true;
  }
  if (prefs.lastActive[from]) {
    prefs.lastActive[to] = Math.max(
      prefs.lastActive[to] ?? 0,
      prefs.lastActive[from],
    );
    delete prefs.lastActive[from];
    dirty = true;
  }
  if (dirty) savePrefs();
}

function lastActiveAt(
  cwd: string,
  sessionId: string | null,
  runtime: ChatRuntime | null,
  grokUpdatedAt?: string,
): number {
  const key = pinKey(cwd, sessionId, runtime?.key);
  const desk = key ? prefs.lastActive[key] ?? 0 : 0;
  const times = sessionId ? prefs.messageTimes[titleKey(cwd, sessionId)] : [];
  let lastMsg = 0;
  if (times) {
    for (const n of times) if (n > lastMsg) lastMsg = n;
  }
  let grok = 0;
  if (grokUpdatedAt) {
    const t = Date.parse(grokUpdatedAt);
    if (Number.isFinite(t)) grok = t;
  }
  return Math.max(desk, lastMsg, grok);
}

function displayTitle(cwd: string, sessionId: string, fallback: string): string {
  const custom = prefs.titles[titleKey(cwd, sessionId)]?.trim();
  return custom || fallback || "Chat";
}

function setSessionTitle(cwd: string, sessionId: string, name: string) {
  const key = titleKey(cwd, sessionId);
  const t = name.trim();
  if (!t) {
    delete prefs.titles[key];
  } else {
    prefs.titles[key] = t;
  }
  for (const a of prefs.archive) {
    if (a.cwd === cwd && a.sessionId === sessionId) {
      a.title = t || a.title;
    }
  }
  for (const c of chats.values()) {
    if (c.cwd === cwd && c.sessionId === sessionId) {
      c.title = t || c.title;
    }
  }
  savePrefs();
  if (
    activeChat()?.cwd === cwd &&
    activeChat()?.sessionId === sessionId
  ) {
    setChatName(t || "Chat");
  }
  renderProjects();
  paintTopbarTitle();
  if (mainPage === "settings") renderArchiveList();
}

function parseMessageTimes(raw: unknown): Record<string, number[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(val)) continue;
    out[key] = val.map((n) =>
      typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
    );
  }
  return out;
}

function persistChatTimes(chat: ChatRuntime) {
  if (!chat.sessionId) return;
  const key = titleKey(chat.cwd, chat.sessionId);
  const times = chat.lines
    .filter(
      (line): line is Extract<TranscriptLine, { kind: "user" | "assistant" }> =>
        line.kind === "user" || line.kind === "assistant",
    )
    .map((line) => line.at ?? 0);
  prefs.messageTimes[key] = times;
  const quotes: StoredQuote[][] = [];
  for (const line of chat.lines) {
    if (line.kind !== "user") continue;
    quotes.push(
      (line.attachments ?? [])
        .filter((a) => a.kind === "quote" && (a.quote ?? "").trim())
        .map((a) => ({
          quote: (a.quote ?? "").trim(),
          comment: a.comment?.trim() || undefined,
        })),
    );
  }
  if (quotes.some((q) => q.length)) prefs.messageQuotes[key] = quotes;
  else delete prefs.messageQuotes[key];
  savePrefs();
}

function applyStoredTimes(chat: ChatRuntime) {
  if (!chat.sessionId) return;
  const times = prefs.messageTimes[titleKey(chat.cwd, chat.sessionId)];
  if (!times?.length) return;
  let i = 0;
  for (const line of chat.lines) {
    if (line.kind !== "user" && line.kind !== "assistant") continue;
    const at = times[i++];
    if (at) line.at = at;
  }
}

function parseMessageQuotes(raw: unknown): Record<string, StoredQuote[][]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, StoredQuote[][]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(val)) continue;
    const turns: StoredQuote[][] = [];
    for (const item of val) {
      if (!Array.isArray(item)) {
        turns.push([]);
        continue;
      }
      const qs: StoredQuote[] = [];
      for (const q of item) {
        if (!q || typeof q !== "object") continue;
        const o = q as Record<string, unknown>;
        if (typeof o.quote !== "string" || !o.quote.trim()) continue;
        qs.push({
          quote: o.quote.trim(),
          comment:
            typeof o.comment === "string" && o.comment.trim()
              ? o.comment.trim()
              : undefined,
        });
      }
      turns.push(qs);
    }
    if (turns.some((t) => t.length)) out[key] = turns;
  }
  return out;
}

function applyStoredQuotes(chat: ChatRuntime) {
  if (!chat.sessionId) return;
  const stored = prefs.messageQuotes[titleKey(chat.cwd, chat.sessionId)];
  if (!stored?.length) return;
  let ui = 0;
  for (const line of chat.lines) {
    if (line.kind !== "user") continue;
    const quotes = stored[ui++] ?? [];
    if (!quotes.length) continue;
    const atts = [...(line.attachments ?? [])];
    for (const q of quotes) {
      if (
        atts.some((a) => a.kind === "quote" && (a.quote ?? "").trim() === q.quote)
      ) {
        continue;
      }
      const att = makeQuoteAtt(q.quote);
      if (q.comment) att.comment = q.comment;
      atts.push(att);
    }
    line.attachments = atts;
    const comment = quotes.map((q) => q.comment?.trim()).find(Boolean) ?? "";
    if (comment) {
      line.text = comment;
      continue;
    }
    let text = line.text;
    for (const q of quotes) {
      const block = q.quote.trim();
      if (!block) continue;
      if (text.trim() === block) {
        text = "";
        break;
      }
      const rest = text.startsWith(block) ? text.slice(block.length) : "";
      if (rest && /^\s*\n/.test(rest)) {
        text = rest.replace(/^\s*\n+/, "");
      }
    }
    line.text = text;
  }
}

function fillMissingWorkMeta(chat: ChatRuntime) {
  for (let i = 0; i < chat.lines.length; i++) {
    const line = chat.lines[i];
    if (line.kind !== "assistant") continue;
    const meta = (line.meta || "").trim();
    if (meta && meta !== "Worked") continue;
    let userAt: number | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const prev = chat.lines[j];
      if (prev.kind === "user") {
        userAt = prev.at;
        break;
      }
    }
    if (userAt && line.at && line.at > userAt) {
      line.meta = workMetaLabel((line.at - userAt) / 1000);
    } else if (!meta) {
      line.meta = workMetaLabel();
    }
  }
}

function parseArchive(raw: unknown): ArchivedChat[] {
  if (!Array.isArray(raw)) return [];
  const out: ArchivedChat[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (
      typeof o.sessionId === "string" &&
      typeof o.cwd === "string" &&
      typeof o.title === "string" &&
      typeof o.archivedAt === "number"
    ) {
      out.push({
        sessionId: o.sessionId,
        cwd: o.cwd,
        title: o.title,
        archivedAt: o.archivedAt,
      });
    }
  }
  return out;
}

function parseNameList(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (item: string) => {
    const n = item.trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") push(item);
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw as Record<string, unknown>)) push(k);
  }
  return out;
}

function waitStoreKey(
  cwd: string,
  sessionId: string | null,
  draftKey: string,
): string {
  return sessionId ? titleKey(cwd, sessionId) : `draft:${draftKey}`;
}

function parseWaitingMap(raw: unknown): Record<string, WaitingItem[]> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, WaitingItem[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(val)) continue;
    const items: WaitingItem[] = [];
    for (const item of val) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.text !== "string") continue;
      const attachments = Array.isArray(o.attachments)
        ? (o.attachments as Attachment[])
        : [];
      items.push({ id: o.id, text: o.text, attachments });
    }
    if (items.length) out[key] = items;
  }
  return out;
}

function parseStoredPanels(raw: unknown): Record<string, StoredPanel> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, StoredPanel> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !val || typeof val !== "object") continue;
    const o = val as Record<string, unknown>;
    const pages = Array.isArray(o.pages)
      ? o.pages.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u))
      : [];
    const sideCount =
      typeof o.sideCount === "number" && o.sideCount > 0
        ? Math.min(8, Math.round(o.sideCount))
        : 0;
    const planText =
      typeof o.planText === "string"
        ? o.planText.length > 200_000
          ? o.planText.slice(0, 200_000)
          : o.planText
        : undefined;
    out[key] = {
      open: o.open === true,
      pages,
      sideCount,
      ...(planText != null ? { planText } : {}),
    };
  }
  return out;
}

function loadWaitingFor(
  cwd: string,
  sessionId: string | null,
  draftKey: string,
): WaitingItem[] {
  const key = waitStoreKey(cwd, sessionId, draftKey);
  const items = prefs.waiting[key];
  return items ? items.map((w) => ({ ...w, attachments: [...(w.attachments ?? [])] })) : [];
}

function persistWaiting(chat: ChatRuntime) {
  const key = waitStoreKey(chat.cwd, chat.sessionId, chat.key);
  if (chat.waiting.length === 0) delete prefs.waiting[key];
  else prefs.waiting[key] = chat.waiting.map((w) => ({ ...w }));
  savePrefs();
}

function parseGone(raw: unknown): string[] {
  return parseNameList(raw).filter((s) => s.includes("::"));
}

let prefsTimer = 0;
let prefsGuardDone = false;

function flushPrefs() {
  if (prefsTimer) {
    window.clearTimeout(prefsTimer);
    prefsTimer = 0;
  }
  try {
    if (!prefsGuardDone && prefs.recent.length === 0 && !prefs.activeCwd) {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as Partial<Prefs>;
        const storedRecent = Array.isArray(stored.recent)
          ? stored.recent.filter(
              (p): p is string => typeof p === "string" && p.length > 0,
            )
          : [];
        if (storedRecent.length > 0) {
          prefs.recent = storedRecent;
          if (typeof stored.activeCwd === "string" && stored.activeCwd.length > 0) {
            prefs.activeCwd = stored.activeCwd;
          }
        }
      }
    }
    prefsGuardDone = true;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* keep in-memory prefs */
  }
}

function savePrefs() {
  if (prefsTimer) return;
  prefsTimer = window.setTimeout(() => {
    prefsTimer = 0;
    flushPrefs();
  }, 80);
}

async function readWindowBounds(): Promise<WindowBounds | null> {
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(factor);
    const pos = (await win.outerPosition()).toLogical(factor);
    return {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      w: Math.max(MIN_WIN_W, Math.round(size.width)),
      h: Math.max(MIN_WIN_H, Math.round(size.height)),
    };
  } catch {
    return null;
  }
}

function boundsOnAScreen(b: WindowBounds, monitors: Monitor[]): boolean {
  // A strip of the window must sit on a current screen (a monitor may be gone).
  return monitors.some((m) => {
    const pos = m.workArea.position.toLogical(m.scaleFactor);
    const size = m.workArea.size.toLogical(m.scaleFactor);
    return (
      b.x + 80 > pos.x &&
      b.x < pos.x + size.width &&
      b.y + 40 > pos.y &&
      b.y < pos.y + size.height
    );
  });
}

async function restoreWindowBounds() {
  const b = prefs.windowBounds;
  if (!b) return;
  const win = getCurrentWindow();
  try {
    const monitors = await availableMonitors();
    if (monitors.length && !boundsOnAScreen(b, monitors)) {
      await win.setSize(new LogicalSize(b.w, b.h));
    } else {
      await win.setPosition(new LogicalPosition(b.x, b.y));
      await win.setSize(new LogicalSize(b.w, b.h));
    }
  } catch {
    /* keep default frame */
  }
  void pinTrafficLights();
}

function pinTrafficLights() {
  void invoke("pin_traffic_lights").catch(() => {});
}

let boundsTimer: number | null = null;

async function persistWindowBounds() {
  const b = await readWindowBounds();
  if (!b) return;
  prefs.windowBounds = b;
  flushPrefs();
}

function schedulePersistWindowBounds() {
  if (boundsTimer != null) window.clearTimeout(boundsTimer);
  boundsTimer = window.setTimeout(() => {
    boundsTimer = null;
    void persistWindowBounds();
  }, 250);
}

function archiveIsExpired(archivedAt: number): boolean {
  return Date.now() - archivedAt >= ARCHIVE_MS;
}

function isGone(cwd: string, sessionId: string): boolean {
  return prefs.gone.includes(titleKey(cwd, sessionId));
}

function isHiddenChat(cwd: string, sessionId: string): boolean {
  return isArchived(cwd, sessionId) || isGone(cwd, sessionId);
}

function hideFromGrotesque(cwd: string, sessionId: string) {
  const key = titleKey(cwd, sessionId);
  if (!prefs.gone.includes(key)) prefs.gone.push(key);
  prefs.archive = prefs.archive.filter(
    (a) => !(a.cwd === cwd && a.sessionId === sessionId),
  );
  setPinnedKey(pinKey(cwd, sessionId), false);
  delete prefs.lastActive[key];
  if (prefs.sessionByCwd[cwd] === sessionId) delete prefs.sessionByCwd[cwd];
}

function pruneArchive(): boolean {
  const keep: ArchivedChat[] = [];
  let hid = false;
  for (const a of prefs.archive) {
    if (archiveIsExpired(a.archivedAt)) {
      hideFromGrotesque(a.cwd, a.sessionId);
      hid = true;
    } else keep.push(a);
  }
  if (!hid && keep.length === prefs.archive.length) return false;
  prefs.archive = keep;
  savePrefs();
  return true;
}

function paintEmptyArchive() {
  const btn = archiveEmptyBtn();
  if (!btn) return;
  const empty = prefs.archive.length === 0;
  btn.disabled = empty;
  if (empty) setEmptyArchiveArmed(false);
}

function emptyArchive() {
  if (prefs.archive.length === 0) return;
  for (const a of [...prefs.archive]) hideFromGrotesque(a.cwd, a.sessionId);
  savePrefs();
  renderArchiveList();
  renderProjects();
}

function onEmptyArchiveClick() {
  if (prefs.archive.length === 0) return;
  if (emptyArchiveArmed) {
    setEmptyArchiveArmed(false);
    emptyArchive();
    return;
  }
  setArchiveArmed(null);
  setEmptyArchiveArmed(true);
}

function isArchived(cwd: string, sessionId: string): boolean {
  return prefs.archive.some((a) => a.cwd === cwd && a.sessionId === sessionId);
}

function daysLeftInArchive(archivedAt: number): number {
  const left = ARCHIVE_MS - (Date.now() - archivedAt);
  return Math.max(0, Math.ceil(left / (24 * 60 * 60 * 1000)));
}

function pruneProjectMeta() {
  const keep = new Set(prefs.recent);
  for (const key of Object.keys(prefs.pinnedProjects)) {
    if (!keep.has(key)) delete prefs.pinnedProjects[key];
  }
  for (const key of Object.keys(prefs.projectExpanded)) {
    if (!keep.has(key)) delete prefs.projectExpanded[key];
  }
  prefs.pinnedMix = prefs.pinnedMix.filter((id) => {
    if (id.startsWith("p:")) return keep.has(id.slice(2));
    return true;
  });
  for (const key of Object.keys(prefs.projectNames)) {
    if (!keep.has(key)) delete prefs.projectNames[key];
  }
}

let recentsCwd = "";
let recentsShown = CHAT_LIST_CAP;

async function ensureRecentsCwd(): Promise<string> {
  if (recentsCwd) return recentsCwd;
  recentsCwd = await invoke<string>("recents_dir");
  return recentsCwd;
}

function isRecentsCwd(path: string): boolean {
  return !!path && !!recentsCwd && path === recentsCwd;
}

/** Add a new folder. Do not move a folder that is already listed. */
function rememberFolder(path: string) {
  if (!path || isRecentsCwd(path) || prefs.recent.includes(path)) return;
  prefs.recent = [path, ...prefs.recent].slice(0, MAX_RECENT);
  pruneProjectMeta();
}

function pinnedProjectPaths(): string[] {
  const out: string[] = [];
  for (const id of prefs.pinnedMix) {
    if (!id.startsWith("p:")) continue;
    const path = id.slice(2);
    if (prefs.pinnedProjects[path]) out.push(path);
  }
  return out;
}

function unpinnedProjectPaths(): string[] {
  const out = prefs.recent.filter((p) => !prefs.pinnedProjects[p] && !isRecentsCwd(p));
  const seen = new Set(out);
  for (const c of chats.values()) {
    if (!c.runInFlight || !c.cwd || isRecentsCwd(c.cwd)) continue;
    if (prefs.pinnedProjects[c.cwd] || seen.has(c.cwd)) continue;
    seen.add(c.cwd);
    out.push(c.cwd);
  }
  return out;
}

function orderedProjects(): string[] {
  return [...pinnedProjectPaths(), ...unpinnedProjectPaths()];
}

function isProjectPinned(path: string): boolean {
  return !!prefs.pinnedProjects[path];
}

function isObsidianVault(path: string): boolean {
  return scannedVaults.get(path) === true;
}

let vaultScanBusy = false;

async function scanObsidianVaults() {
  if (vaultScanBusy) return;
  const missing = orderedProjects().filter((p) => !scannedVaults.has(p));
  if (missing.length === 0) return;
  vaultScanBusy = true;
  try {
    const found = await invoke<string[]>("list_obsidian_vaults", { paths: missing });
    const hit = new Set(found);
    let show = false;
    for (const p of missing) {
      const v = hit.has(p);
      scannedVaults.set(p, v);
      if (v) show = true;
    }
    if (show) renderProjects();
  } catch {
    for (const p of missing) scannedVaults.set(p, false);
  } finally {
    vaultScanBusy = false;
  }
}

async function openProjectInObsidian(path: string) {
  try {
    await invoke("open_in_obsidian", { path });
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

function setProjectPinned(path: string, on: boolean) {
  if (on) {
    prefs.pinnedProjects[path] = true;
    addMixIfMissing(mixProjectId(path));
  } else {
    delete prefs.pinnedProjects[path];
    removeMixId(mixProjectId(path));
  }
  pruneProjectMeta();
  savePrefs();
}

function isProjectExpanded(path: string): boolean {
  return !!prefs.projectExpanded[path];
}

function setProjectExpanded(path: string, on: boolean) {
  if (on) prefs.projectExpanded[path] = true;
  else delete prefs.projectExpanded[path];
  if (!on) chatsShown = CHAT_LIST_CAP;
  savePrefs();
}

function folderName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function projectLabel(path: string): string {
  if (isRecentsCwd(path)) return "Recents";
  const n = prefs.projectNames[path]?.trim();
  return n || folderName(path);
}

function setProjectName(path: string, raw: string) {
  const n = raw.trim();
  if (!n || n === folderName(path)) delete prefs.projectNames[path];
  else prefs.projectNames[path] = n;
  savePrefs();
}

function mcpDisplayName(name: string): string {
  const n = prefs.mcpNames[name]?.trim();
  return n || name;
}

function setMcpName(name: string, raw: string) {
  const n = raw.trim();
  if (!n || n === name) delete prefs.mcpNames[name];
  else prefs.mcpNames[name] = n;
  savePrefs();
}

function newChatKey(): string {
  return crypto.randomUUID();
}

function activeChat(): ChatRuntime | null {
  return activeChatKey ? chats.get(activeChatKey) ?? null : null;
}

function makeChat(cwd: string, opts?: Partial<ChatRuntime>): ChatRuntime {
  const key = opts?.key ?? newChatKey();
  const seeded = opts?.sessionId
    ? trioForSession(cwd, opts.sessionId)
    : seedForProject(cwd);
  const chat: ChatRuntime = {
    key,
    cwd,
    sessionId: opts?.sessionId ?? null,
    forceNew: opts?.forceNew ?? true,
    title: opts?.title ?? "New chat",
    runInFlight: false,
    reviewWait: false,
    doneUnread: false,
    draft: "",
    listedDraft: opts?.listedDraft ?? false,
    attachments: [],
    lines: opts?.lines ?? [],
    status: "",
    liveMeta: null,
    liveStream: null,
    liveRow: null,
    liveThoughtDetails: null,
    thoughtBuf: "",
    waiting: opts?.waiting ?? loadWaitingFor(cwd, opts?.sessionId ?? null, key),
    steerNext: null,
    lastUserPrompt: null,
    lastUserAttachments: [],
    steerNextAttachments: null,
    stopRequested: false,
    lastStopped: false,
    scrollTop: 0,
    scrollPinned: true,
    contextUsed: 0,
    contextSize: 0,
    slashCommands: [],
    model: opts?.model ?? seeded.model,
    effort: opts?.effort ?? seeded.effort,
    mode: opts?.mode ?? seeded.mode,
    todos: opts?.todos ?? [],
    tasksCollapsed: opts?.tasksCollapsed ?? false,
    subsCollapsed: opts?.subsCollapsed ?? false,
    reviewCollapsed: opts?.reviewCollapsed ?? false,
    lockedMarks: opts?.lockedMarks ?? [],
    pluginMarks: opts?.pluginMarks ?? {},
    surface: opts?.surface ?? "main",
    mainKey: opts?.mainKey,
    tabId: opts?.tabId,
    seeded: opts?.seeded ?? false,
    subLabel: opts?.subLabel,
    liveSubs: opts?.liveSubs ?? [],
    pane: null,
    paneLines: 0,
    paneLive: false,
    compacting: false,
  };
  if (chat.surface === "main") chats.set(key, chat);
  else agents.set(key, chat);
  return chat;
}

function joinTextParts(parts: AssistantPart[]): string {
  const texts = parts.filter(
    (p): p is { kind: "text"; text: string } => p.kind === "text",
  );
  const researchTurn = parts.some((p) => p.kind === "tool");
  const kept = researchTurn ? texts.filter((p) => !isMachineJsonText(p.text)) : texts;
  return kept
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

function hasVisibleParts(parts: AssistantPart[]): boolean {
  return parts.some(
    (p) =>
      p.kind === "tool" || (p.kind === "text" && p.text.trim().length > 0),
  );
}

function chipLabel(chip: ToolChip): string {
  return chip.title.trim() || chip.kind.trim() || "Tool";
}

function appendTextPart(parts: AssistantPart[], chunk: string) {
  const last = parts[parts.length - 1];
  if (last?.kind === "text") {
    last.text = joinAnswerText(last.text, chunk);
    return;
  }
  // A chunk split by tool updates continues the earlier text, not a new part.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.kind === "tool") continue;
    if (p.kind === "text" && chunkContinuesText(p.text, chunk)) {
      p.text = joinContinuedText(p.text, chunk);
      return;
    }
    break;
  }
  parts.push({ kind: "text", text: chunk });
}

function mergeChipOnto(into: ToolChip, chip: ToolChip) {
  if (chip.title) into.title = chip.title;
  if (chip.status) into.status = chip.status;
  if (chip.kind) into.kind = chip.kind;
  if (chip.name) into.name = chip.name;
  if (chip.path) into.path = chip.path;
  if (chip.diff) into.diff = chip.diff;
  if (chip.sessionId) into.sessionId = chip.sessionId;
  if (chip.description) into.description = chip.description;
  if (chip.subagentType) into.subagentType = chip.subagentType;
  mergeWebOntoChip(into, chip);
}

function upsertToolPart(parts: AssistantPart[], chip: ToolChip) {
  for (const p of parts) {
    if (p.kind !== "tool" || !p.chip.id || p.chip.id !== chip.id) continue;
    mergeChipOnto(p.chip, chip);
    return;
  }
  parts.push({ kind: "tool", chip: { ...chip } });
}

function parseTodoStatus(raw: string): TodoStatus {
  const s = raw.trim().toLowerCase();
  if (s === "in_progress" || s === "completed" || s === "cancelled") return s;
  return "pending";
}

function parseTodoItems(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: TodoItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { id?: unknown; content?: unknown; status?: unknown };
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!content && !id) continue;
    out.push({
      id: id || `t${out.length + 1}`,
      content,
      status: parseTodoStatus(typeof rec.status === "string" ? rec.status : ""),
    });
  }
  return out.length ? out : undefined;
}

/** Hide lifts only when id, status, or text changes. */
function mergeChatTodos(chat: ChatRuntime, incoming: TodoItem[], merge: boolean) {
  if (!merge || chat.todos.length === 0) {
    chat.todos = incoming.map((t) => ({ ...t }));
  } else {
    const byId = new Map(chat.todos.map((t) => [t.id, t]));
    for (const item of incoming) {
      const prev = byId.get(item.id);
      if (!prev) {
        const next = { ...item };
        chat.todos.push(next);
        byId.set(item.id, next);
        continue;
      }
      if (item.content) prev.content = item.content;
      prev.status = item.status;
    }
  }
}

function applyTodosFromChip(chat: ChatRuntime, chip: ToolChip) {
  if (!chip.todos?.length) return;
  mergeChatTodos(chat, chip.todos, chip.todosMerge !== false);
  if (activeChatKey === chat.key) paintOutputs(chat);
  if (chat.runInFlight) syncLiveWorkCaption(chat);
}

function applyReviewFromChip(chat: ChatRuntime, chip: ToolChip) {
  const verb = shortToolName(chip);
  if (verb !== "Write" && verb !== "Edit") return;
  if (activeChatKey === chat.key) paintOutputs(chat);
}

function chipToolName(chip: ToolChip): string {
  return (chip.name ?? "").trim().toLowerCase();
}

function isSubWaitChip(chip: ToolChip): boolean {
  const name = chipToolName(chip);
  if (/get_command_or_subagent|subagent_output/.test(name)) return true;
  const variant = (chip.variant ?? "").toLowerCase();
  if (variant === "taskoutput" || variant === "task_output") return true;
  const title = chip.title.trim().toLowerCase();
  return /get task output|multi-wait/.test(title);
}

function isSpawnChip(chip: ToolChip): boolean {
  if (isSubWaitChip(chip)) return false;
  const name = chipToolName(chip);
  if (name.includes("spawn")) return true;
  const variant = (chip.variant ?? "").toLowerCase();
  if (variant === "task") return true;
  if (chip.subagentType) return true;
  const blob = `${chip.kind} ${variant} ${chip.title} ${name}`;
  return /spawn_subagent|\bspawn\b/.test(blob);
}

function isAskChip(chip: ToolChip): boolean {
  const name = chipToolName(chip);
  if (/ask_user/.test(name)) return true;
  const variant = (chip.variant ?? "").toLowerCase();
  if (variant === "ask" || variant === "askuser" || variant.includes("ask_user")) {
    return true;
  }
  const title = chip.title.trim().toLowerCase();
  return title === "ask" || /\bask_user\b/.test(title) || title.includes("question");
}

function refreshLiveWorkFold(chat: ChatRuntime) {
  if (!chatVisible(chat)) return;
  const line = lastAssistantLine(chat);
  const details = chat.liveThoughtDetails;
  if (!line || !details) return;
  paintWorkTimeline(details, interleaveWorkAnswers(line.work ?? [], line.parts), {
    live: turnIsLive(chat),
    cursor: turnIsLive(chat),
  });
}

function paintLiveSubs(chat: ChatRuntime, before: string) {
  const seen = new Set<string>();
  chat.liveSubs = chat.liveSubs.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  const after = chat.liveSubs.map((s) => `${s.id}:${s.status}:${s.name}:${s.label}`).join("|");
  if (before === after) return;
  if (activeChatKey === chat.key) {
    paintOutputs(chat);
    refreshLiveWorkFold(chat);
  }
}

function finishLiveSubs(chat: ChatRuntime) {
  let changed = false;
  for (const s of chat.liveSubs) {
    if (s.status === "running") {
      s.status = "done";
      changed = true;
    }
  }
  if (!changed) return;
  lastOutputsSig = "";
  if (activeChatKey === chat.key) {
    paintOutputs(chat);
    refreshLiveWorkFold(chat);
  }
}

function findLiveSub(chat: ChatRuntime, id: string, label: string): number {
  const i = chat.liveSubs.findIndex((s) => s.id === id);
  if (i >= 0) return i;
  const lab = label.trim();
  if (!lab) return -1;
  return chat.liveSubs.findIndex(
    (s) => s.status === "running" && s.label.trim() === lab,
  );
}

function applySpawnFromChip(chat: ChatRuntime, chip: ToolChip) {
  if (isSubWaitChip(chip)) {
    if (chipStatusClass(chip.status) === "is-done") finishLiveSubs(chat);
    return;
  }
  if (!isSpawnChip(chip) && !chip.sessionId && !chip.description) return;
  const sid = (chip.sessionId || "").trim() || chip.id;
  if (!sid) return;
  const failed = chipStatusClass(chip.status) === "is-failed";
  const i = chat.liveSubs.findIndex((s) => s.toolId === chip.id || s.id === sid);
  const label =
    chip.description ||
    (!/spawn/i.test(chip.title) ? chip.title.trim() : "") ||
    "Subagent";
  const prev = i >= 0 ? chat.liveSubs[i] : null;
  let next: LiveSub = {
    id: chip.sessionId || prev?.id || sid,
    name: prev?.name || "",
    label: label || prev?.label || "Subagent",
    type: chip.subagentType || prev?.type || "general-purpose",
    status: failed ? "failed" : prev?.status === "done" ? "done" : "running",
    toolId: chip.id,
  };
  next = nameSub(chat, next);
  const before = chat.liveSubs.map((s) => `${s.id}:${s.status}:${s.name}:${s.label}`).join("|");
  if (i >= 0) chat.liveSubs[i] = { ...prev!, ...next };
  else chat.liveSubs.push(next);
  paintLiveSubs(chat, before);
}

function applySubEvent(chat: ChatRuntime, data: string) {
  let raw: { id?: string; label?: string; type?: string; status?: string };
  try {
    raw = JSON.parse(data) as {
      id?: string;
      label?: string;
      type?: string;
      status?: string;
    };
  } catch {
    return;
  }
  const id = (raw.id ?? "").trim();
  if (!id) return;
  const status =
    raw.status === "failed" ? "failed" : raw.status === "running" ? "running" : "done";
  const i = findLiveSub(chat, id, raw.label ?? "");
  const before = chat.liveSubs.map((s) => `${s.id}:${s.status}:${s.name}:${s.label}`).join("|");
  const prev = i >= 0 ? chat.liveSubs[i] : null;
  let next: LiveSub = {
    id,
    name: prev?.name || "",
    label: (raw.label ?? "").trim() || prev?.label || "Subagent",
    type: (raw.type ?? "").trim() || prev?.type || "general-purpose",
    status,
    toolId: prev?.toolId || id,
  };
  next = nameSub(chat, next);
  if (i >= 0) {
    const oldId = prev!.id;
    chat.liveSubs[i] = { ...prev!, ...next };
    if (oldId !== next.id) {
      for (const a of agents.values()) {
        if (a.mainKey === chat.key && a.sessionId === oldId) {
          a.sessionId = next.id;
          if (frontAgent()?.key === a.key) void fillSubHistory(chat, a);
        }
      }
    }
  } else chat.liveSubs.push(next);
  paintLiveSubs(chat, before);
  refreshFrontSubTab(chat, id, status);
}

/** Open sub tabs already refilled, once per terminal status. */
const filledSubTabs = new Set<string>();

/** A tab opened mid-run freezes on takes. Refill the open one when the child lands. */
function refreshFrontSubTab(chat: ChatRuntime, subId: string, status: string) {
  if (status !== "done" && status !== "failed") return;
  const id = subId.trim();
  if (!id) return;
  const key = `${chat.key}::${id}::${status}`;
  if (filledSubTabs.has(key)) return;
  const front = frontTabOf(panelOf(chat.key));
  if (!front || front.kind === "page") return;
  const agent = sideForTab(front.id);
  if (!agent || agent.mainKey !== chat.key || agent.sessionId !== id) return;
  if (agent.runInFlight) return;
  filledSubTabs.add(key);
  void fillSubHistory(chat, agent);
}

function outputsPane(): HTMLElement | null {
  return document.getElementById("outputs-pane");
}

let lastOutputsSig = "";
let outputsHideTimer = 0;

function setOutputsVisible(pane: HTMLElement, show: boolean) {
  pane.setAttribute("aria-hidden", show ? "false" : "true");
  document.getElementById("main-pane")?.classList.toggle("has-tasks", show);
  if (outputsHideTimer) {
    window.clearTimeout(outputsHideTimer);
    outputsHideTimer = 0;
  }
  if (show) {
    pane.hidden = false;
    pane.removeAttribute("hidden");
    const open = () => pane.classList.add("is-open");
    if (!motionOk()) open();
    else requestAnimationFrame(open);
    return;
  }
  pane.classList.remove("is-open");
  const finish = () => {
    outputsHideTimer = 0;
    if (pane.classList.contains("is-open")) return;
    pane.hidden = true;
    pane.setAttribute("hidden", "");
    pane.querySelector("#outputs-list")?.replaceChildren();
    const step = pane.querySelector("#outputs-step");
    if (step) step.textContent = "";
  };
  if (!motionOk()) {
    finish();
    return;
  }
  outputsHideTimer = window.setTimeout(finish, 220);
}

function outputsPaintSig(
  chat: ChatRuntime,
  items: TodoItem[],
  subs: LiveSub[],
  files: ToolChip[],
): string {
  return `${chat.key}:${chat.tasksCollapsed ? "t" : "T"}:${chat.subsCollapsed ? "s" : "e"}:${chat.reviewCollapsed ? "r" : "v"}:${items.map((t) => `${t.id}:${t.status}:${t.content}`).join("|")}:${subs.map((s) => `${s.id}:${s.status}:${s.name}`).join("|")}:${files.map((c) => c.diff?.path || c.path || "").join("|")}`;
}

function paintOutputs(chat: ChatRuntime | null) {
  const pane = outputsPane();
  if (!pane) return;
  const items = (chat?.todos ?? []).filter((t) => t.status !== "cancelled");
  const subs = chat?.liveSubs ?? [];
  const files = chat ? reviewWritesForTurn(chat) : [];
  const has = items.length > 0 || subs.length > 0 || files.length > 0;
  const show = !!chat && has && !pageOpen() && prefs.tasksPinned !== false;
  const sig = show && chat ? outputsPaintSig(chat, items, subs, files) : "";
  const pin = tasksPinBtn();
  if (pin) {
    const pinOn = !!chat && !pageOpen() && has;
    pin.hidden = !pinOn;
    if (pinOn) pin.removeAttribute("hidden");
    else pin.setAttribute("hidden", "");
    pin.setAttribute("aria-pressed", prefs.tasksPinned !== false ? "true" : "false");
    pin.title = "Outputs";
    pin.setAttribute("aria-label", "Outputs");
  }
  const open = pane.classList.contains("is-open");
  if (sig === lastOutputsSig && open === show) return;
  lastOutputsSig = sig;
  if (open !== show) setOutputsVisible(pane, show);
  const title = pane.querySelector("#outputs-title");
  if (title) title.textContent = "Outputs";
  const list = pane.querySelector("#outputs-list");
  const step = pane.querySelector("#outputs-step");
  if (!list || !step) return;
  if (!show || !chat) return;
  let current = items.findIndex((t) => t.status === "in_progress");
  if (current < 0) current = items.findIndex((t) => t.status === "pending");
  const live = current >= 0;
  if (current < 0 && items.length) current = Math.max(0, items.length - 1);
  const prevDone = new Map<string, boolean>();
  list.querySelectorAll<HTMLElement>(".todo-item[data-id]").forEach((el) => {
    prevDone.set(el.dataset.id || "", el.dataset.status === "completed");
  });
  list.replaceChildren();
  const writeStep = () => {
    if (items.length && live && !chat.tasksCollapsed) {
      step.textContent = `Step ${current + 1} / ${items.length}`;
    } else {
      step.textContent = "";
    }
  };
  const nestHead = (
    name: string,
    collapsedNest: boolean,
    flip: () => void,
  ): HTMLElement => {
    const nest = document.createElement("li");
    nest.className = "outputs-section" + (collapsedNest ? " is-collapsed" : "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "outputs-subhead" + (collapsedNest ? " is-collapsed" : "");
    btn.setAttribute("aria-expanded", collapsedNest ? "false" : "true");
    const lab = document.createElement("span");
    lab.textContent = name;
    const chev = document.createElement("span");
    chev.className = "outputs-chevron";
    chev.setAttribute("aria-hidden", "true");
    chev.appendChild(iconEl(Ico.forward, { size: 16 }));
    btn.append(lab, chev);
    const body = document.createElement("div");
    body.className = "outputs-nest";
    const inner = document.createElement("div");
    inner.className = "outputs-nest-inner";
    body.appendChild(inner);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (motionOk()) {
        pane.classList.add("is-motion");
        const done = () => {
          pane.classList.remove("is-motion");
          body.removeEventListener("transitionend", onEnd);
          window.clearTimeout(t);
        };
        const onEnd = (ev: TransitionEvent) => {
          if (ev.target !== body || ev.propertyName !== "grid-template-rows") return;
          done();
        };
        const t = window.setTimeout(done, 520);
        body.addEventListener("transitionend", onEnd);
      }
      flip();
      const shut = name === "Tasks"
        ? chat.tasksCollapsed
        : name === "Subagents"
          ? chat.subsCollapsed
          : chat.reviewCollapsed;
      nest.classList.toggle("is-collapsed", shut);
      btn.classList.toggle("is-collapsed", shut);
      btn.setAttribute("aria-expanded", shut ? "false" : "true");
      lastOutputsSig = outputsPaintSig(chat, items, subs, files);
      writeStep();
    });
    nest.append(btn, body);
    list.append(nest);
    return inner;
  };
  if (items.length) {
    const inner = nestHead("Tasks", !!chat.tasksCollapsed, () => {
      chat.tasksCollapsed = !chat.tasksCollapsed;
    });
    items.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "todo-item";
      row.dataset.id = t.id;
      row.dataset.status = t.status;
      if (live && i === current) row.classList.add("is-current");
      const done = t.status === "completed";
      const mark = document.createElement("span");
      mark.className = "todo-mark" + (done ? " is-done" : "");
      mark.setAttribute("aria-hidden", "true");
      mark.appendChild(todoGlyph(done, prevDone.has(t.id) ? !!prevDone.get(t.id) : undefined));
      const lab = document.createElement("span");
      lab.className = "todo-text";
      lab.textContent = t.content;
      row.append(mark, lab);
      inner.append(row);
    });
  }
  const paintSub = (host: HTMLElement, sub: LiveSub) => {
    const row = document.createElement("div");
    row.className = "todo-item task-sub";
    const name = sub.name || sub.label;
    const lab = document.createElement("span");
    lab.className = "todo-text";
    lab.textContent = name;
    row.title = sub.label && name !== sub.label ? sub.label : "Open subagent";
    row.addEventListener("click", () => openSubagentTab(chat, sub));
    row.append(subMarkEl(name), lab);
    if (sub.status === "running") {
      const extra = document.createElement("span");
      extra.className = "todo-extra";
      extra.textContent = "is working";
      row.append(extra);
    }
    host.append(row);
  };
  if (subs.length) {
    const inner = nestHead("Subagents", !!chat.subsCollapsed, () => {
      chat.subsCollapsed = !chat.subsCollapsed;
    });
    for (const sub of subs) paintSub(inner, sub);
  }
  if (files.length) {
    const inner = nestHead("Review", !!chat.reviewCollapsed, () => {
      chat.reviewCollapsed = !chat.reviewCollapsed;
    });
    const wrap = document.createElement("div");
    wrap.className = "outputs-review";
    const box = document.createElement("div");
    box.className = "review-list";
    fillReviewFiles(box, files);
    wrap.appendChild(box);
    inner.appendChild(wrap);
  }
  writeStep();
}

function parseToolEvent(data: string): ToolChip | null {
  try {
    const raw = JSON.parse(data) as ToolEventPayload;
    const id = (raw.id ?? "").trim();
    const title = (raw.title ?? "").trim();
    const status = (raw.status ?? "").trim();
    const kind = (raw.kind ?? "").trim();
    if (!id && !title && !kind) return null;
    const path = (raw.path ?? "").trim();
    const diff = raw.diff;
    const query = (raw.query ?? "").trim();
    const urls = Array.isArray(raw.urls) ? raw.urls : [];
    const variant = (raw.variant ?? "").trim();
    const span = (raw.span ?? "").trim();
    return {
      id: id || `${title || kind}-${status}`,
      title,
      status,
      kind,
      path: path || undefined,
      diff:
        diff && (diff.path || diff.old || diff.new)
          ? {
              path: (diff.path || path || "").trim(),
              old: diff.old,
              new: diff.new,
            }
          : undefined,
      query: query || queryFromWebTitle(title) || undefined,
      hits: urls.length ? urls.map((u) => hitFromUrl(u)) : undefined,
      variant: variant || undefined,
      span: span || undefined,
      server: (raw.server ?? "").trim() || undefined,
      name: (raw.name ?? "").trim() || undefined,
      todos: parseTodoItems(raw.todos),
      todosMerge: raw.todosMerge,
      sessionId: (raw.sessionId ?? "").trim() || undefined,
      description: (raw.description ?? "").trim() || undefined,
      subagentType: (raw.subagentType ?? "").trim() || undefined,
    };
  } catch {
    const t = data.trim();
    if (!t) return null;
    return { id: t, title: t, status: "", kind: "" };
  }
}

function chipStatusClass(status: string): string {
  const st = status.toLowerCase();
  if (st === "in_progress" || st === "pending" || st === "running") {
    return "is-running";
  }
  if (st === "failed" || st === "error" || st === "cancelled") {
    return "is-failed";
  }
  if (st === "completed" || st === "done") return "is-done";
  return "";
}

function isStopError(err: string | null | undefined): boolean {
  if (!err) return false;
  const t = err.trim().toLowerCase();
  return t === "stopped." || t === "stopped" || t.startsWith("stopped");
}

function canRetry(chat: ChatRuntime | null): boolean {
  if (!chat || chat.runInFlight) return false;
  if (!chat.lastUserPrompt?.trim() && chat.lastUserAttachments.length === 0) {
    return false;
  }
  if (chat.lastStopped) return true;
  for (let i = chat.lines.length - 1; i >= 0; i--) {
    const line = chat.lines[i];
    if (line.kind === "assistant") return !!(line.error || line.stopped);
    if (line.kind === "user") break;
  }
  return false;
}

function paintStopSend(
  send: HTMLButtonElement | null,
  opts: { busy: boolean; enabled: boolean; stopTitle: string; sendTitle: string },
) {
  if (!send) return;
  send.disabled = !opts.enabled;
  send.classList.toggle("is-stop", opts.busy);
  send.title = opts.busy ? opts.stopTitle : opts.sendTitle;
  send.setAttribute("aria-label", opts.busy ? "Stop" : "Send");
  send.type = opts.busy ? "button" : "submit";
}

function applySendChrome() {
  const chat = activeChat();
  const busy = !!chat?.runInFlight;
  const hasPrompt = !!composerText().trim();
  const hasAttach = (chat?.attachments.length ?? 0) > 0;
  paintStopSend(runBtn(), {
    busy,
    enabled: !!chat && (busy || hasPrompt || hasAttach),
    stopTitle: "Stop (ends live turn only). ⌘Enter send now",
    sendTitle: "Send (Enter). Shift+Enter newline. ⌘Enter send now",
  });
  syncWindowRunChrome();
  refreshRetryChrome();
}

const APP_TITLE = "Grotesque";
let progressForKey: string | null = null;
let progressFadeGen = 0;
let windowTitle = "";

function setWindowTitle(name: string) {
  if (windowTitle === name) return;
  windowTitle = name;
  document.title = name;
  void getCurrentWindow()
    .setTitle(name)
    .catch(() => {})
    .then(() => pinTrafficLights());
}

function syncWindowRunChrome() {
  const chat = activeChat();
  const busy = !!chat && turnIsLive(chat);
  const bar = runProgress();
  const main = mainPane();
  if (main) main.setAttribute("aria-busy", busy ? "true" : "false");

  if (busy && chat) {
    progressFadeGen += 1;
    progressForKey = chat.key;
    setWindowTitle("Working");
    if (bar) {
      bar.classList.remove("is-fading");
      bar.classList.add("is-on");
    }
    return;
  }

  setWindowTitle(APP_TITLE);
  if (!bar) {
    progressForKey = null;
    return;
  }

  // Fade only when this open chat finishes. Switching away is instant.
  const fade =
    !!chat && progressForKey === chat.key && bar.classList.contains("is-on");
  progressForKey = null;
  bar.classList.remove("is-on");
  if (!fade) {
    progressFadeGen += 1;
    bar.classList.remove("is-fading");
    return;
  }
  bar.classList.add("is-fading");
  const gen = ++progressFadeGen;
  window.setTimeout(() => {
    if (gen !== progressFadeGen) return;
    bar.classList.remove("is-fading");
  }, 320);
}

function runningChatCount(): number {
  let n = 0;
  for (const c of chats.values()) {
    if (c.runInFlight) n += 1;
  }
  for (const s of sides.values()) {
    if (s.runInFlight) n += 1;
  }
  return n;
}

async function confirmIfBusy(
  action: "quit" | "update",
): Promise<boolean> {
  const n = runningChatCount();
  if (n === 0) return true;
  const many = n !== 1;
  const body =
    action === "update"
      ? many
        ? `${n} chats are still running. Update Grotesque anyway?`
        : "A chat is still running. Update Grotesque anyway?"
      : many
        ? `${n} chats are still running. Quit anyway?`
        : "A chat is still running. Quit anyway?";
  try {
    return await confirm(body, {
      title: "Grotesque",
      kind: "warning",
      okLabel: action === "update" ? "Update" : "Quit",
      cancelLabel: "Stay",
    });
  } catch {
    return false;
  }
}

let quitPrompting = false;

async function requestQuit() {
  if (quitPrompting) return;
  quitPrompting = true;
  try {
    if (!(await confirmIfBusy("quit"))) return;
    await persistWindowBounds();
    flushPrefs();
    await invoke("allow_and_quit");
  } catch {
    /* stay */
  } finally {
    quitPrompting = false;
  }
}

function refreshRetryOn(
  chat: ChatRuntime | null,
  t: HTMLElement | null,
  onRetry: () => void,
) {
  if (!t) return;
  const want = canRetry(chat);
  const existing = t.querySelector(".msg-retry");
  if (!want) {
    existing?.remove();
    return;
  }
  if (existing || !chat) return;
  const bubble = lastUserBubbleIn(t);
  const stack = bubble?.closest(".user-stack");
  let line = bubble?.parentElement ?? null;
  if (bubble && (!line || !line.classList.contains("user-bubble-row"))) {
    line = document.createElement("div");
    line.className = "user-bubble-row";
    bubble.replaceWith(line);
    line.appendChild(bubble);
  }
  const host = line ?? stack;
  if (!host) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-retry";
  btn.title = "Retry this prompt";
  btn.setAttribute("aria-label", "Retry this prompt");
  btn.innerHTML = RETRY_SVG;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRetry();
  });
  if (bubble) host.insertBefore(btn, bubble);
  else host.insertBefore(btn, host.firstChild);
}

function refreshRetryChrome() {
  refreshRetryOn(activeChat(), transcript(), () => void retryLastPrompt());
}

function setStatus(text: string) {
  const chat = activeChat();
  if (chat) chat.status = text;
}

const NEAR_BOTTOM_PX = 72;
/** Skip scroll-handler writes during transcript rebuild. */
let ignoreTranscriptScroll = false;
/** Drops a stale restore frame if rebuild runs again. */
let transcriptRestoreGen = 0;
let lastDockPad = 0;
let jumpToLatestGen = 0;
/** Non-zero while a jump ease is in flight; matches `jumpToLatestGen`. */
let jumpToLatestAnim = 0;
let jumpLatestHideTimer = 0;
let jumpLatestShowRaf = 0;

function isTranscriptNearBottom(t: HTMLElement): boolean {
  return t.scrollHeight - t.scrollTop - t.clientHeight <= NEAR_BOTTOM_PX;
}

function syncJumpLatest() {
  const btn = jumpLatestBtn();
  const t = transcript();
  const chat = activeChat();
  if (!btn || !t) return;
  const overflow = t.scrollHeight - t.clientHeight > 8;
  const show = !!(chat && !chat.scrollPinned && overflow);
  if (show) {
    if (jumpLatestHideTimer) {
      window.clearTimeout(jumpLatestHideTimer);
      jumpLatestHideTimer = 0;
    }
    btn.hidden = false;
    btn.removeAttribute("hidden");
    btn.removeAttribute("inert");
    btn.setAttribute("aria-hidden", "false");
    if (btn.classList.contains("is-on")) return;
    if (!motionOk()) {
      btn.classList.add("is-on");
      return;
    }
    if (jumpLatestShowRaf) return;
    jumpLatestShowRaf = requestAnimationFrame(() => {
      jumpLatestShowRaf = 0;
      if (btn.hasAttribute("inert")) return;
      btn.classList.add("is-on");
    });
    return;
  }
  if (jumpLatestShowRaf) {
    cancelAnimationFrame(jumpLatestShowRaf);
    jumpLatestShowRaf = 0;
  }
  if (!btn.classList.contains("is-on") && btn.hidden) return;
  if (!btn.classList.contains("is-on") && jumpLatestHideTimer) return;
  btn.classList.remove("is-on");
  btn.setAttribute("inert", "");
  btn.setAttribute("aria-hidden", "true");
  const finish = () => {
    jumpLatestHideTimer = 0;
    if (btn.classList.contains("is-on")) return;
    btn.hidden = true;
    btn.setAttribute("hidden", "");
  };
  if (!motionOk() || btn.hidden) {
    finish();
    return;
  }
  jumpLatestHideTimer = window.setTimeout(finish, 160);
}

function saveTranscriptScroll(chat: ChatRuntime | null) {
  const t = transcript();
  if (!chat || !t || ignoreTranscriptScroll) return;
  chat.scrollTop = t.scrollTop;
  chat.scrollPinned = isTranscriptNearBottom(t);
}

function restoreTranscriptScroll(chat: ChatRuntime) {
  const t = transcript();
  if (!t) return;
  if (chat.scrollPinned) t.scrollTop = t.scrollHeight;
  else t.scrollTop = chat.scrollTop;
  syncJumpLatest();
}

function pinTranscriptToLatest(
  chat: ChatRuntime | null = activeChat(),
  opts?: { ease?: boolean },
) {
  if (chat) chat.scrollPinned = true;
  const t = transcript();
  if (!t) return;
  syncJumpLatest();
  if (opts?.ease && motionOk()) {
    const gen = ++jumpToLatestGen;
    jumpToLatestAnim = gen;
    const from = t.scrollTop;
    const start = performance.now();
    const max0 = Math.max(0, t.scrollHeight - t.clientHeight);
    const dist = Math.abs(max0 - from);
    if (dist < 1) {
      jumpToLatestAnim = 0;
      t.scrollTop = max0;
      if (chat) chat.scrollTop = max0;
      syncJumpLatest();
      return;
    }
    const dur = DUR_SHELL;
    const ease = easeShell;
    const tick = (now: number) => {
      if (gen !== jumpToLatestGen) {
        if (jumpToLatestAnim === gen) jumpToLatestAnim = 0;
        return;
      }
      const max = Math.max(0, t.scrollHeight - t.clientHeight);
      const p = Math.min(1, (now - start) / dur);
      t.scrollTop = from + (max - from) * ease(p);
      if (chat) chat.scrollTop = t.scrollTop;
      if (p < 1) requestAnimationFrame(tick);
      else {
        jumpToLatestAnim = 0;
        if (chat) chat.scrollPinned = true;
        syncJumpLatest();
      }
    };
    requestAnimationFrame(tick);
    return;
  }
  jumpToLatestGen += 1;
  jumpToLatestAnim = 0;
  const apply = () => {
    if (chat && !chat.scrollPinned) return;
    const pane = transcript();
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
    if (chat) chat.scrollTop = pane.scrollTop;
    syncJumpLatest();
  };
  apply();
  // Fold and empty-chat layout land next frame.
  requestAnimationFrame(apply);
}

function clearTurnFill(root?: HTMLElement | null) {
  const t = root ?? transcript();
  t?.querySelectorAll<HTMLElement>(".msg-row.assistant.is-turn-fill").forEach((el) => {
    el.classList.remove("is-turn-fill");
    el.style.minHeight = "";
  });
}

let liveTurnGap = 20;
let liveTurnPad = 64;
let liveTurnMetrics = false;

function resetLiveTurnMetrics() {
  liveTurnMetrics = false;
}

function fillLiveTurn(chat: ChatRuntime) {
  const t = paintHostFor(chat) ?? transcript();
  const live = chat.liveRow;
  if (!t || !live?.isConnected || chat.surface === "panel") return;
  const card = live.nextElementSibling;
  if (card instanceof HTMLElement && card.dataset.cardId) {
    live.classList.remove("is-turn-fill");
    live.style.minHeight = "";
    return;
  }
  if (!live.classList.contains("is-turn-fill")) {
    clearTurnFill(t);
    live.classList.add("is-turn-fill");
  }
  let user: HTMLElement | null = live.previousElementSibling as HTMLElement | null;
  while (user && !user.classList.contains("user")) {
    user = user.previousElementSibling as HTMLElement | null;
  }
  const userH = user?.getBoundingClientRect().height ?? 0;
  if (!liveTurnMetrics) {
    const cs = getComputedStyle(t);
    liveTurnGap = parseFloat(cs.rowGap || cs.gap) || 20;
    liveTurnPad = parseFloat(cs.paddingTop) || 0;
    liveTurnMetrics = true;
  }
  const dock = lastDockPad || 220;
  // Spacer (dock) is in the scroll content. Subtract it so the fill stops above the bar.
  const minH = Math.max(80, t.clientHeight - dock - liveTurnPad - userH - liveTurnGap);
  const next = `${Math.round(minH)}px`;
  if (live.style.minHeight !== next) live.style.minHeight = next;
}

function parkSentTurn(chat: ChatRuntime) {
  fillLiveTurn(chat);
  pinTranscriptToLatest(chat);
}

function scrollTranscript() {
  const t = transcript();
  const chat = activeChat();
  if (!t || !chat) return;
  if (chat.scrollPinned) t.scrollTop = t.scrollHeight;
  syncJumpLatest();
}

function onTranscriptContentGrew() {
  const chat = activeChat();
  const t = transcript();
  if (!t || !chat || ignoreTranscriptScroll) return;
  if (chat.scrollPinned) {
    // Growth moves the floor; a pending scroll event may not have cleared the pin yet.
    if (t.scrollTop >= chat.scrollTop || isTranscriptNearBottom(t)) {
      t.scrollTop = t.scrollHeight;
    } else {
      chat.scrollPinned = false;
    }
  } else if (t.scrollTop < chat.scrollTop) {
    const max = Math.max(0, t.scrollHeight - t.clientHeight);
    t.scrollTop = Math.min(chat.scrollTop, max);
  }
  syncJumpLatest();
}

const scrollLayerTimers = new WeakMap<HTMLElement, number>();

function markScrolling(el: HTMLElement | null) {
  if (!el) return;
  el.classList.add("is-scrolling");
  const prev = scrollLayerTimers.get(el);
  if (prev) window.clearTimeout(prev);
  scrollLayerTimers.set(
    el,
    window.setTimeout(() => {
      el.classList.remove("is-scrolling");
      scrollLayerTimers.delete(el);
    }, 160),
  );
}

function onTranscriptUserScroll() {
  if (ignoreTranscriptScroll) return;
  const chat = activeChat();
  const t = transcript();
  if (!chat || !t) return;
  markScrolling(t);
  chat.scrollTop = t.scrollTop;
  // Programmatic ease fires scroll events; do not unpin mid-jump.
  if (jumpToLatestAnim && jumpToLatestAnim === jumpToLatestGen) return;
  chat.scrollPinned = isTranscriptNearBottom(t);
  if (transcriptScrollRaf) return;
  transcriptScrollRaf = requestAnimationFrame(() => {
    transcriptScrollRaf = 0;
    syncJumpLatest();
    syncPromptJumpCurrent();
  });
}

function setPromptJumpEq(hover: number | null) {
  if (hover === jumpEqHover) return;
  jumpEqHover = hover;
  const nav = promptJumps();
  if (!nav) return;
  nav.querySelectorAll<HTMLElement>(".prompt-jump").forEach((tick, i) => {
    if (hover == null) {
      delete tick.dataset.eq;
      return;
    }
    const next = String(Math.min(3, Math.abs(i - hover)));
    if (tick.dataset.eq !== next) tick.dataset.eq = next;
  });
}

let transcriptScrollRaf = 0;
let transcriptResizeRaf = 0;
let dividerDragging = false;

function clampSidebarWidth(px: number): number {
  const max = Math.min(MAX_SIDEBAR_W, Math.floor(window.innerWidth * 0.4));
  return Math.max(MIN_SIDEBAR_W, Math.min(Math.round(px), max));
}

function clampSideWidth(px: number): number {
  return Math.max(MIN_SIDE_W, Math.min(Math.round(px), Math.floor(window.innerWidth * 0.55)));
}

/** Live column width on the pane only. A :root --sidebar-w restyles the whole tree. */
function previewSidebarWidth(px: number) {
  const w = clampSidebarWidth(px);
  const bar = sidebarEl();
  if (bar) {
    bar.style.width = `${w}px`;
    bar.style.setProperty("--sidebar-w", `${w}px`);
  }
  const win = $<HTMLElement>(".winbar-left");
  if (win) win.style.width = `${w}px`;
}

function previewSideWidth(px: number) {
  const w = clampSideWidth(px);
  const pane = sidePane();
  if (pane) {
    pane.style.width = `${w}px`;
    pane.style.setProperty("--side-open-w", `${w}px`);
  }
  const win = $<HTMLElement>(".winbar-side");
  if (win) win.style.width = `${w}px`;
  syncBrowserBounds();
}

function clearWidthPreview() {
  const bar = sidebarEl();
  if (bar) {
    bar.style.removeProperty("width");
    bar.style.removeProperty("--sidebar-w");
  }
  const pane = sidePane();
  if (pane) {
    pane.style.removeProperty("width");
    pane.style.removeProperty("--side-open-w");
  }
  $<HTMLElement>(".winbar-left")?.style.removeProperty("width");
  $<HTMLElement>(".winbar-side")?.style.removeProperty("width");
}

function reflowSideUserBubbles() {
  const t = sideTranscript();
  if (!t) return;
  const stacks = t.querySelectorAll<HTMLElement>(".user-stack");
  for (const el of stacks) el.style.width = "0px";
  void t.offsetWidth;
  for (const el of stacks) el.style.width = "";
}

function afterDividerDrag() {
  const chat = activeChat();
  if (chat?.liveRow) fillLiveTurn(chat);
  if (chat?.scrollPinned) scrollTranscript();
  else syncJumpLatest();
  const jumps = promptJumps();
  if (jumps && !jumps.hidden && jumpMarks.length >= 2) {
    fitPromptJumpGap(jumps, jumpMarks.length);
  }
  syncTranscriptDockPad();
  syncBrowserBounds();
  reflowSideUserBubbles();
}

function bindTranscriptScroll() {
  const t = transcript();
  if (!t) return;
  t.addEventListener("scroll", onTranscriptUserScroll, { passive: true });
  t.addEventListener("wheel", () => {
    jumpToLatestGen += 1;
  }, { passive: true });
  t.addEventListener("pointerdown", () => {
    jumpToLatestGen += 1;
  });
  const jumps = promptJumps();
  jumps?.addEventListener("pointerover", (e) => {
    const tick = (e.target as HTMLElement | null)?.closest(".prompt-jump");
    if (!(tick instanceof HTMLElement) || !jumps.contains(tick)) return;
    const i = Number(tick.dataset.i);
    if (Number.isFinite(i)) setPromptJumpEq(i);
  });
  jumps?.addEventListener("pointerleave", () => {
    setPromptJumpEq(null);
    hidePromptJumpCard();
  });
  new ResizeObserver(() => {
    if (ignoreTranscriptScroll || dividerDragging) return;
    if (transcriptResizeRaf) return;
    transcriptResizeRaf = requestAnimationFrame(() => {
      transcriptResizeRaf = 0;
      if (ignoreTranscriptScroll || dividerDragging) return;
      const chat = activeChat();
      if (chat?.liveRow) fillLiveTurn(chat);
      if (chat?.scrollPinned) scrollTranscript();
      else syncJumpLatest();
      const jumps = promptJumps();
      if (jumps && !jumps.hidden && jumpMarks.length >= 2) {
        fitPromptJumpGap(jumps, jumpMarks.length);
      }
    });
  }).observe(t);
  const dock = $<HTMLElement>(".composer-dock");
  if (dock) new ResizeObserver(() => syncTranscriptDockPad()).observe(dock);
  syncTranscriptDockPad();
  const sideT = sideTranscript();
  sideT?.addEventListener("scroll", () => markScrolling(sideT), { passive: true });
  const sideNav = $<HTMLElement>(".sidebar-scroll");
  sideNav?.addEventListener("scroll", () => markScrolling(sideNav), { passive: true });
}

/** Dock overlays the transcript; pad so the last answer sits above the bar. */
function syncTranscriptDockPad() {
  const main = mainPane();
  const dock = $<HTMLElement>(".composer-dock");
  if (!dock || !main || main.classList.contains("is-empty-chat")) return;
  if (dividerDragging) return;
  // Dock box is flush with the bar; extra keeps a gap above it.
  const next = Math.max(Math.ceil(dock.getBoundingClientRect().height) + 16, 160);
  if (next === lastDockPad) return;
  const t = transcript();
  const chat = activeChat();
  const pinned = !!(chat?.scrollPinned || (t && isTranscriptNearBottom(t)));
  const prev = lastDockPad || next;
  lastDockPad = next;
  document.documentElement.style.setProperty("--transcript-dock", `${next}px`);
  if (!t || ignoreTranscriptScroll) return;
  const liveChat = activeChat();
  if (liveChat?.liveRow) fillLiveTurn(liveChat);
  if (pinned) {
    t.scrollTop = t.scrollHeight;
    if (chat) {
      chat.scrollPinned = true;
      chat.scrollTop = t.scrollTop;
    }
  } else {
    t.scrollTop += next - prev;
  }
  syncJumpLatest();
}

function isComposerBlock(el: HTMLElement): boolean {
  return /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|TR)$/.test(el.tagName);
}

function composerChipRoot(n: Node, root: HTMLElement): HTMLElement | null {
  const el = n instanceof HTMLElement ? n : n.parentElement;
  const chip = el?.closest<HTMLElement>("[data-raw]");
  return chip && chip !== root && root.contains(chip) ? chip : null;
}

/** Browser DIV/P are newlines. Caret offsets use this walk. */
function serializeComposer(
  root: HTMLElement,
  point?: { node: Node; offset: number } | null,
): { text: string; at: number } {
  let out = "";
  let at = 0;
  let hit = false;
  const mark = (node: Node, offset: number) => {
    if (!point || hit) return;
    if (point.node === node && point.offset === offset) {
      hit = true;
      at = out.length;
    }
  };
  const walk = (n: Node, isRoot: boolean) => {
    if (n instanceof HTMLElement && n.dataset.raw != null && !isRoot) {
      const raw = n.dataset.raw;
      if (point && (point.node === n || n.contains(point.node))) {
        hit = true;
        at = out.length + raw.length;
      }
      out += raw;
      return;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      const raw = n.textContent ?? "";
      if (point && point.node === n) {
        hit = true;
        at = out.length + raw.slice(0, point.offset).replace(/\u200b/g, "").length;
      }
      out += raw.replace(/\u200b/g, "");
      return;
    }
    if (n instanceof HTMLElement && n.tagName === "BR") {
      if (point && point.node === n) {
        hit = true;
        at = out.length + (point.offset > 0 ? 1 : 0);
      }
      out += "\n";
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const block = !isRoot && isComposerBlock(n);
    if (block && out.length && !out.endsWith("\n")) out += "\n";
    let i = 0;
    for (const c of n.childNodes) {
      mark(n, i);
      walk(c, false);
      i += 1;
    }
    mark(n, i);
  };
  walk(root, true);
  if (point && !hit) at = out.length;
  return { text: out.replace(/\u00a0/g, " "), at };
}

function composerText(el: HTMLElement | null = input()): string {
  if (!el) return "";
  return serializeComposer(el).text;
}

function composerOffsetOfNode(root: HTMLElement, node: Node): number {
  const target = composerChipRoot(node, root) ?? node;
  if (target === root) return 0;
  const parent = target.parentNode;
  if (!parent) return serializeComposer(root).text.length;
  let i = 0;
  for (; i < parent.childNodes.length; i++) {
    if (parent.childNodes[i] === target) break;
  }
  return serializeComposer(root, { node: parent, offset: i }).at;
}

function composerCaret(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return serializeComposer(root).text.length;
  if (sel.anchorNode !== root && !root.contains(sel.anchorNode)) {
    return serializeComposer(root).text.length;
  }
  return serializeComposer(root, { node: sel.anchorNode, offset: sel.anchorOffset }).at;
}

function composerSelEnd(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.focusNode) return composerCaret(root);
  if (sel.focusNode !== root && !root.contains(sel.focusNode)) return composerCaret(root);
  return serializeComposer(root, { node: sel.focusNode, offset: sel.focusOffset }).at;
}

function landAfter(n: Node, range: Range) {
  const next = n.nextSibling;
  if (next && onlyZwsp(next)) range.setStart(next, 0);
  else range.setStartAfter(n);
  range.collapse(true);
}

function placeComposerOffset(root: HTMLElement, offset: number): Range {
  const range = document.createRange();
  let acc = 0;
  let lastNl = false;
  const walk = (n: Node, isRoot: boolean): boolean => {
    if (n instanceof HTMLElement && n.dataset.raw != null && !isRoot) {
      const len = n.dataset.raw.length;
      if (offset <= acc) {
        range.setStartBefore(n);
        range.collapse(true);
        return true;
      }
      if (offset <= acc + len) {
        landAfter(n, range);
        return true;
      }
      acc += len;
      lastNl = n.dataset.raw.endsWith("\n");
      return false;
    }
    if (n.nodeType === Node.TEXT_NODE) {
      const raw = n.textContent ?? "";
      const vis = raw.replace(/\u200b/g, "");
      if (offset <= acc + vis.length) {
        const want = offset - acc;
        let seen = 0;
        let i = 0;
        for (; i < raw.length; i++) {
          if (raw[i] === "\u200b") continue;
          if (seen === want) break;
          seen += 1;
        }
        range.setStart(n, i);
        range.collapse(true);
        return true;
      }
      acc += vis.length;
      if (vis.length) lastNl = vis.endsWith("\n");
      return false;
    }
    if (n instanceof HTMLElement && n.tagName === "BR") {
      if (offset <= acc) {
        range.setStartBefore(n);
        range.collapse(true);
        return true;
      }
      if (offset <= acc + 1) {
        landAfter(n, range);
        return true;
      }
      acc += 1;
      lastNl = true;
      return false;
    }
    if (!(n instanceof HTMLElement)) return false;
    const block = !isRoot && isComposerBlock(n);
    if (block && acc > 0 && !lastNl) {
      if (offset <= acc) {
        if (n.firstChild) range.setStartBefore(n.firstChild);
        else range.setStart(n, 0);
        range.collapse(true);
        return true;
      }
      acc += 1;
      lastNl = true;
    }
    for (const c of n.childNodes) {
      if (walk(c, false)) return true;
    }
    return false;
  };
  if (!walk(root, true)) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  return range;
}

function setComposerCaret(root: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = placeComposerOffset(root, offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setComposerRange(root: HTMLElement, start: number, end: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  const r1 = placeComposerOffset(root, a);
  const r2 = placeComposerOffset(root, b);
  const range = document.createRange();
  range.setStart(r1.startContainer, r1.startOffset);
  range.setEnd(r2.startContainer, r2.startOffset);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeComposerChipCaret(root: HTMLElement, chip: HTMLElement, x: number) {
  const start = composerOffsetOfNode(root, chip);
  const raw = chip.dataset.raw ?? "";
  const rect = chip.getBoundingClientRect();
  const after = x >= rect.left + rect.width * 0.5;
  setComposerCaret(root, after ? start + raw.length : start);
}

function isUrlMark(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

function isHexMark(raw: string): boolean {
  return /^#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})$/.test(raw);
}

function hexTokenClosed(raw: string, after: string): boolean {
  if (after !== "" && !/[\s.,;:!?)]/.test(after[0] ?? "")) return false;
  if (raw.length <= 5 && after === "") return false;
  return true;
}

function composerChip(raw: string): HTMLElement {
  const plug = pluginChipMeta.get(raw);
  const link = isUrlMark(raw);
  const hex = isHexMark(raw);
  const at = raw.startsWith("@");
  const el = document.createElement("span");
  el.className =
    "mark " +
    (plug
      ? "mark-plugin"
      : link
        ? "mark-link"
        : hex
          ? "mark-hex"
          : at
            ? "mark-at"
            : "mark-slash");
  el.dataset.raw = raw;
  el.contentEditable = "false";
  if (hex) {
    el.append(raw);
    const chip = document.createElement("span");
    chip.className = "hex-swatch-chip";
    chip.style.background = cssHex(raw);
    chip.setAttribute("aria-hidden", "true");
    el.appendChild(chip);
    return el;
  }
  const ico = document.createElement("span");
  ico.className = "mark-ico";
  ico.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "mark-lab";
  if (plug) {
    paintMcpMark(ico, plug.name);
    label.textContent = plug.label;
    el.append(ico, label);
  } else if (link) {
    fillLinkChip(el, raw, raw);
  } else {
    ico.innerHTML = at
      ? isFolderChipPath(raw)
        ? MARK_FOLDER_SVG
        : MARK_FILE_SVG
      : MARK_SLASH_SVG;
    label.textContent = at ? markBasename(raw.slice(1)) : raw.slice(1);
    el.append(ico, label);
  }
  return el;
}

function shouldChipToken(raw: string, after: string): boolean {
  if (!lockedMarks.has(raw)) return false;
  return after === "" || /[\s.,;:!?)]/.test(after[0] ?? "");
}

function lockUrlMarks(text: string) {
  URL_RE.lastIndex = 0;
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimPathMatch(m[0]);
    if (raw) lockedMarks.add(raw);
  }
}

function collectPluginMarkHits(
  text: string,
  raws: Iterable<string> = lockedMarks,
): { start: number; raw: string }[] {
  const hits: { start: number; raw: string }[] = [];
  for (const raw of raws) {
    if (!raw || !pluginChipMeta.has(raw)) continue;
    if (raw.startsWith("/") || raw.startsWith("@") || isUrlMark(raw)) continue;
    let from = 0;
    while (from < text.length) {
      const i = text.indexOf(raw, from);
      if (i < 0) break;
      const beforeOk = i === 0 || /[\s]/.test(text[i - 1] ?? "");
      const after = text[i + raw.length] ?? "";
      if (beforeOk && (after === "" || /[\s.,;:!?)]/.test(after[0] ?? ""))) {
        hits.push({ start: i, raw });
      }
      from = i + Math.max(raw.length, 1);
    }
  }
  return hits;
}

function collectChipHits(text: string): { start: number; raw: string }[] {
  const hits: { start: number; raw: string }[] = collectPluginMarkHits(text);
  MARK_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARK_TOKEN_RE.exec(text))) {
    const lead = m[1] ?? "";
    const raw = trimPathMatch(m[2] ?? "");
    if (!raw) continue;
    const start = m.index + lead.length;
    const after = text[start + raw.length] ?? "";
    if (!shouldChipToken(raw, after)) {
      MARK_TOKEN_RE.lastIndex = start + 1;
      continue;
    }
    hits.push({ start, raw });
    MARK_TOKEN_RE.lastIndex = start + raw.length;
  }
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const raw = trimPathMatch(m[0]);
    if (!raw) continue;
    const start = m.index;
    const after = text[start + raw.length] ?? "";
    if (!shouldChipToken(raw, after)) {
      URL_RE.lastIndex = start + 1;
      continue;
    }
    hits.push({ start, raw });
    URL_RE.lastIndex = start + raw.length;
  }
  HEX_RE.lastIndex = 0;
  while ((m = HEX_RE.exec(text))) {
    const raw = m[0];
    const start = m.index;
    const after = text[start + raw.length] ?? "";
    if (!hexTokenClosed(raw, after)) {
      HEX_RE.lastIndex = start + 1;
      continue;
    }
    hits.push({ start, raw });
    HEX_RE.lastIndex = start + raw.length;
  }
  hits.sort((a, b) => a.start - b.start || b.raw.length - a.raw.length);
  const out: { start: number; raw: string }[] = [];
  let end = 0;
  for (const h of hits) {
    if (h.start < end) continue;
    out.push(h);
    end = h.start + h.raw.length;
  }
  return out;
}

function appendComposerPlain(el: HTMLElement, s: string) {
  const parts = s.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) el.append(parts[i]);
    if (i < parts.length - 1) el.appendChild(document.createElement("br"));
  }
}

function paintComposer(el: HTMLElement, text: string) {
  el.replaceChildren();
  if (!text) {
    el.classList.add("is-empty");
    return;
  }
  el.classList.remove("is-empty");
  let last = 0;
  for (const h of collectChipHits(text)) {
    if (h.start > last) appendComposerPlain(el, text.slice(last, h.start));
    el.appendChild(composerChip(h.raw));
    last = h.start + h.raw.length;
  }
  if (last < text.length) appendComposerPlain(el, text.slice(last));
  // Chip, break, or trailing space has no glyph after it; ZWSP is the caret landing.
  if (isComposerLanding(el.lastChild)) el.append("\u200b");
}

function isComposerLanding(n: Node | null): boolean {
  if (isComposerChip(n) || (n instanceof HTMLElement && n.tagName === "BR")) return true;
  return !!n && n.nodeType === Node.TEXT_NODE && /[ \u00a0]$/.test(n.textContent ?? "");
}

/** Trailing ZWSP mixed into typed text: WebKit paints the caret on the last letter. */
function trimComposerZwsp(el: HTMLElement) {
  const caret = composerCaret(el);
  let changed = false;
  for (const n of [...el.childNodes]) {
    if (n.nodeType !== Node.TEXT_NODE) continue;
    const raw = n.textContent ?? "";
    if (!raw.includes("\u200b")) continue;
    const next = raw.replace(/\u200b/g, "");
    if (next) {
      n.textContent = next;
      changed = true;
    } else if (!isComposerLanding(n.previousSibling) || n.nextSibling) {
      n.remove();
      changed = true;
    }
  }
  if (isComposerLanding(el.lastChild)) {
    el.append("\u200b");
    changed = true;
  }
  if (changed) setComposerCaret(el, caret);
}

function setComposerText(text: string, caret = -1) {
  const el = input();
  if (!el) return;
  paintComposer(el, text);
  if (caret >= 0) setComposerCaret(el, Math.min(caret, text.length));
  else if (text) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  autoGrowTextarea();
}

function scrollComposerCaret(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return;
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(false);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!rect || (!rect.height && !rect.width && !rect.top)) {
    if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    return;
  }
  const host = el.getBoundingClientRect();
  if (rect.bottom > host.bottom) el.scrollTop += rect.bottom - host.bottom;
  else if (rect.top < host.top) el.scrollTop -= host.top - rect.top;
}

function autoGrowTextarea() {
  const el = input();
  if (!el) return;
  const prevH = el.style.height;
  const prevOverflow = el.style.overflowY;
  el.style.height = "auto";
  const cap = 160;
  const sh = el.scrollHeight;
  const h = Math.min(sh, cap);
  const nextH = `${h}px`;
  const nextOverflow = sh > cap ? "auto" : "hidden";
  el.style.height = nextH;
  el.style.overflowY = nextOverflow;
  scrollComposerCaret(el);
  if (nextH === prevH && nextOverflow === prevOverflow) return;
  syncTranscriptDockPad();
}

function isComposerChip(n: Node | null): n is HTMLElement {
  return n instanceof HTMLElement && n.dataset.raw != null;
}

function onlySpace(n: Node | null): boolean {
  return !!n && n.nodeType === Node.TEXT_NODE && /^[\s\u00a0\u200b]*$/.test(n.textContent ?? "");
}

function commitComposerSlice(lo: number, hi: number): boolean {
  const field = input();
  if (!field || lo >= hi) return false;
  const text = composerText(field);
  const next = text.slice(0, lo) + text.slice(hi);
  for (const raw of [...lockedMarks]) {
    if (!next.includes(raw)) lockedMarks.delete(raw);
  }
  if (!next.trim()) lockedMarks.clear();
  setComposerText(next, lo);
  const chat = activeChat();
  if (chat) {
    chat.draft = next;
    chat.lockedMarks = [...lockedMarks];
  }
  applySendChrome();
  syncSuggest();
  return true;
}

function deleteComposerSelection(): boolean {
  const field = input();
  if (!field) return false;
  const a = composerCaret(field);
  const b = composerSelEnd(field);
  if (a === b) return false;
  return commitComposerSlice(Math.min(a, b), Math.max(a, b));
}

function deleteComposerCharBefore(): boolean {
  const field = input();
  if (!field) return false;
  const caret = composerCaret(field);
  if (caret <= 0) return false;
  return commitComposerSlice(caret - 1, caret);
}

function deleteComposerCharAfter(): boolean {
  const field = input();
  if (!field) return false;
  const caret = composerCaret(field);
  const text = composerText(field);
  if (caret >= text.length) return false;
  return commitComposerSlice(caret, caret + 1);
}

function composerLineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", Math.max(0, offset) - 1) + 1;
}

function composerLineEnd(text: string, offset: number): number {
  const nl = text.indexOf("\n", offset);
  return nl < 0 ? text.length : nl;
}

function removeComposerChip(chip: HTMLElement) {
  const raw = chip.dataset.raw;
  const space = chip.nextSibling;
  chip.remove();
  if (onlySpace(space)) space?.remove();
  if (raw) lockedMarks.delete(raw);
  const field = input();
  if (field && !composerText(field).trim()) {
    lockedMarks.clear();
    paintComposer(field, "");
  }
  autoGrowTextarea();
  const chat = activeChat();
  if (chat) chat.draft = composerText(field);
  applySendChrome();
  syncSuggest();
}

function deleteComposerToLineStart() {
  const field = input();
  if (!field) return;
  const text = composerText(field);
  const a = composerCaret(field);
  const b = composerSelEnd(field);
  const cut = Math.max(a, b);
  const lineStart = composerLineStart(text, cut);
  if (cut <= lineStart) return;
  const next = text.slice(0, lineStart) + text.slice(cut);
  for (const raw of [...lockedMarks]) {
    if (!next.includes(raw)) lockedMarks.delete(raw);
  }
  if (!next.trim()) lockedMarks.clear();
  setComposerText(next, lineStart);
  const chat = activeChat();
  if (chat) chat.draft = next;
  applySendChrome();
  syncSuggest();
}

function onlyZwsp(n: Node | null): boolean {
  return !!n && n.nodeType === Node.TEXT_NODE && /^[\u200b]*$/.test(n.textContent ?? "");
}

function chipBeforeCaret(): HTMLElement | null {
  const root = input();
  const sel = window.getSelection();
  if (!root || !sel?.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const n = r.startContainer;
  const off = r.startOffset;
  if (n === root) {
    if (off === 0) return null;
    const prev = root.childNodes[off - 1];
    if (isComposerChip(prev)) return prev;
    const hop = prev?.previousSibling ?? null;
    if (onlyZwsp(prev) && isComposerChip(hop)) return hop;
    return null;
  }
  if (n.nodeType === Node.TEXT_NODE) {
    const before = (n.textContent ?? "").slice(0, off);
    if (before.replace(/[\s\u00a0\u200b]/g, "").length > 0) return null;
    const prev = n.previousSibling;
    if (isComposerChip(prev)) {
      if (before.replace(/[\u200b]/g, "").length === 0) return prev;
      return null;
    }
    const hop = prev?.previousSibling ?? null;
    if (onlyZwsp(prev) && isComposerChip(hop)) return hop;
  }
  return null;
}

function chipAfterCaret(): HTMLElement | null {
  const root = input();
  const sel = window.getSelection();
  if (!root || !sel?.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const n = r.startContainer;
  const off = r.startOffset;
  if (n === root) {
    const next = root.childNodes[off] ?? null;
    if (isComposerChip(next)) return next;
    const hop = next?.nextSibling ?? null;
    if (onlyZwsp(next) && isComposerChip(hop)) return hop;
    return null;
  }
  if (n.nodeType === Node.TEXT_NODE) {
    const after = (n.textContent ?? "").slice(off);
    if (after.replace(/[\s\u00a0\u200b]/g, "").length > 0) return null;
    const next = n.nextSibling;
    if (isComposerChip(next)) {
      if (after.replace(/[\u200b]/g, "").length === 0) return next;
      return null;
    }
    const hop = next?.nextSibling ?? null;
    if (onlyZwsp(next) && isComposerChip(hop)) return hop;
  }
  return null;
}

function chipInSelection(): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.anchorNode;
  const el = node instanceof HTMLElement ? node : node?.parentElement;
  return el?.closest<HTMLElement>("[data-raw]") ?? null;
}

function setChatName(name: string) {
  const title = chatTitle();
  if (title && !pageOpen()) title.textContent = name;
  const chat = activeChat();
  if (chat) chat.title = name;
}

function isDefaultChatTitle(name: string): boolean {
  const t = name.trim();
  return !t || t === "New chat" || t === "Current chat" || t === "Chat";
}

function shortTitle(text: string, max = 42): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let slice = t.slice(0, max);
  const sp = slice.lastIndexOf(" ");
  if (sp >= 16) slice = slice.slice(0, sp);
  return `${slice.trim()}…`;
}

function autoTitleFromPrompt(text: string, fileName?: string): string {
  let t = (text || "").replace(/\s+/g, " ").trim();
  const onlySlash = t.match(/^\/([^\s]+)\s*$/);
  if (onlySlash) {
    t = onlySlash[1].replace(/[-_]+/g, " ");
  } else {
    t = t.replace(/^\/[^\s]+\s+/, "").trim();
  }
  t = t.replace(/@([^\s]+)/g, (_, p: string) => {
    const segs = p.replace(/\/+$/, "").split("/");
    return segs[segs.length - 1] || p;
  });
  const stop = t.search(/[.!?](?:\s|$)/);
  if (stop >= 16 && stop <= 48) {
    t = t.slice(0, stop).trim();
  }
  if (!t) t = (fileName || "").replace(/\s+/g, " ").trim();
  return shortTitle(t || "New chat");
}

/** Grotesque prefs only. Do not write Grok session files. */
function persistDeskTitle(chat: ChatRuntime) {
  if (!chat.sessionId) return;
  const key = titleKey(chat.cwd, chat.sessionId);
  if (prefs.titles[key]) return;
  const t = chat.title.trim();
  if (isDefaultChatTitle(t)) return;
  prefs.titles[key] = t;
  savePrefs();
}

function applyAutoTitle(
  chat: ChatRuntime,
  prompt: string,
  fileName?: string,
) {
  if (!isDefaultChatTitle(chat.title)) return;
  const next = autoTitleFromPrompt(prompt, fileName);
  if (!next || isDefaultChatTitle(next)) return;
  chat.title = next;
  if (activeChatKey === chat.key) setChatName(next);
  persistDeskTitle(chat);
}

function hideChatContextMenu() {
  const menu = chatCtxMenu();
  if (menu) menu.hidden = true;
  ctxTarget = null;
}

let mcpCtxName: string | null = null;
let mcpCtxRow: HTMLElement | null = null;

function hideMcpContextMenu() {
  const menu = mcpCtxMenu();
  if (menu) menu.hidden = true;
  mcpCtxName = null;
  mcpCtxRow = null;
}

function setMenuOrigin(menu: HTMLElement, fromX: number, fromY: number) {
  const r = menu.getBoundingClientRect();
  menu.style.transformOrigin = `${fromX - r.left}px ${fromY - r.top}px`;
}

function placeCtxMenu(menu: HTMLElement, e: MouseEvent) {
  const pad = 6;
  const mw = menu.offsetWidth || 148;
  const mh = menu.offsetHeight || 36;
  let x = e.clientX;
  let y = e.clientY;
  if (x + mw + pad > window.innerWidth) x = window.innerWidth - mw - pad;
  if (y + mh + pad > window.innerHeight) y = window.innerHeight - mh - pad;
  menu.style.left = `${Math.max(pad, x)}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
  setMenuOrigin(menu, e.clientX, e.clientY);
}

function showMcpContextMenu(
  e: MouseEvent,
  name: string,
  rowEl: HTMLElement,
  canRemove: boolean,
) {
  e.preventDefault();
  e.stopPropagation();
  hideChatContextMenu();
  hideWaitingMenu();
  hideDocOpenMenu();
  const menu = mcpCtxMenu();
  if (!menu) return;
  mcpCtxName = name;
  mcpCtxRow = rowEl;
  const removeBtn = menu.querySelector<HTMLButtonElement>('[data-action="remove"]');
  if (removeBtn) removeBtn.hidden = !canRemove;
  menu.hidden = false;
  placeCtxMenu(menu, e);
}

function wirePluginName(el: HTMLElement, name: string, rowEl: HTMLElement) {
  el.className = "plugin-name";
  el.textContent = mcpDisplayName(name);
  el.title = "Double-click to rename";
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    beginMcpRename(name, rowEl);
  });
}

function beginMcpRename(name: string, rowEl: HTMLElement) {
  hideMcpContextMenu();
  const open = document.querySelector(".plugin-row.renaming");
  if (open && open !== rowEl) {
    open.querySelector<HTMLInputElement>(".chat-rename-input")?.blur();
  }
  if (rowEl.classList.contains("renaming")) return;
  const nameEl = rowEl.querySelector(".plugin-name");
  if (!nameEl) return;
  rowEl.classList.add("renaming");
  const field = document.createElement("input");
  field.type = "text";
  field.className = "chat-rename-input";
  field.value = mcpDisplayName(name);
  field.setAttribute("aria-label", "Rename plugin");
  field.addEventListener("click", (e) => e.stopPropagation());
  field.addEventListener("pointerdown", (e) => e.stopPropagation());
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) setMcpName(name, field.value);
    const label = document.createElement("div");
    wirePluginName(label, name, rowEl);
    field.replaceWith(label);
    rowEl.classList.remove("renaming");
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  field.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!done) finish(true);
    }, 0);
  });
  nameEl.replaceWith(field);
  queueMicrotask(() => {
    field.focus();
    field.select();
  });
}

function showChatContextMenu(e: MouseEvent, target: CtxTarget) {
  e.preventDefault();
  e.stopPropagation();
  hideMcpContextMenu();
  hideWaitingMenu();
  hideDocOpenMenu();
  renameTarget = null;
  const menu = chatCtxMenu();
  if (!menu) return;
  ctxTarget = target;
  const isProject = target.kind === "project";
  const pinBtn = menu.querySelector<HTMLButtonElement>('[data-action="pin"]');
  if (pinBtn) {
    const pinned = isProject
      ? isProjectPinned(target.cwd)
      : isPinnedKey(pinKeyForCtx(target));
    pinBtn.textContent = pinned ? "Unpin" : "Pin";
  }
  const archiveBtn = menu.querySelector<HTMLButtonElement>(
    '[data-action="archive"]',
  );
  const removeBtn = menu.querySelector<HTMLButtonElement>(
    '[data-action="remove"]',
  );
  if (archiveBtn) archiveBtn.hidden = isProject;
  if (removeBtn) removeBtn.hidden = !isProject;
  menu.setAttribute("aria-label", isProject ? "Project actions" : "Chat actions");
  menu.hidden = false;
  placeCtxMenu(menu, e);
}

function matchesCtx(a: CtxTarget, b: CtxTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "draft" && b.kind === "draft") {
    return a.cwd === b.cwd && a.runtimeKey === b.runtimeKey;
  }
  if (a.kind === "session" && b.kind === "session") {
    return a.cwd === b.cwd && a.sessionId === b.sessionId;
  }
  if (a.kind === "project" && b.kind === "project") {
    return a.cwd === b.cwd;
  }
  return false;
}

function ctxForChat(chat: ChatRuntime): CtxTarget {
  if (chat.sessionId) {
    return {
      kind: "session",
      cwd: chat.cwd,
      sessionId: chat.sessionId,
      title: displayTitle(chat.cwd, chat.sessionId, chat.title || "Chat"),
    };
  }
  return {
    kind: "draft",
    cwd: chat.cwd,
    runtimeKey: chat.key,
  };
}

function beginRename(target: CtxTarget, source: "list" | "topbar" = "list") {
  hideChatContextMenu();
  renameTarget = target;
  renameSource = source;
  if (target.kind === "session" && source === "list") {
    setProjectExpanded(target.cwd, true);
  }
  renderProjects();
  paintTopbarTitle();
}

function runCtxRename() {
  const t = ctxTarget;
  hideChatContextMenu();
  if (!t) return;
  beginRename(t, "list");
}

/** Topbar title + optional inline rename when source is topbar. */
function paintTopbarTitle() {
  const wrap = topbarTitleWrap();
  const titleEl = chatTitle();
  if (!wrap || !titleEl) return;

  wrap.querySelectorAll(".topbar-rename-input").forEach((el) => el.remove());

  if (mainPage === "plugins") {
    titleEl.hidden = false;
    titleEl.textContent =
      pluginsTab === "skills"
        ? "Skills"
        : pluginsTab === "market"
          ? "Marketplace"
          : "Plugins";
    return;
  }
  if (mainPage === "settings") {
    titleEl.hidden = false;
    titleEl.textContent = "Settings";
    return;
  }

  const chat = activeChat();
  const renamingHere =
    !!chat &&
    !!renameTarget &&
    renameSource === "topbar" &&
    matchesCtx(renameTarget, ctxForChat(chat));

  if (!renamingHere || !renameTarget || !chat) {
    titleEl.hidden = false;
    titleEl.style.removeProperty("width");
    titleEl.textContent = !chat
      ? "New chat"
      : chat.sessionId
        ? displayTitle(chat.cwd, chat.sessionId, chat.title)
        : chat.title || "New chat";
    return;
  }

  const lockW = Math.max(8, Math.ceil(titleEl.getBoundingClientRect().width));
  titleEl.hidden = true;
  const field = document.createElement("input");
  field.type = "text";
  field.className = "chat-rename-input topbar-rename-input";
  field.style.width = `${lockW}px`;
  const label =
    renameTarget.kind === "session"
      ? displayTitle(
          renameTarget.cwd,
          renameTarget.sessionId,
          renameTarget.title || chat.title || "Chat",
        )
      : chat.title || "New chat";
  field.value = label;
  field.setAttribute("aria-label", "Rename chat");
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save && renameTarget) commitRename(renameTarget, field.value);
    else cancelRename();
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  field.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (!done && renameTarget) finish(true);
    }, 0);
  });
  wrap.appendChild(field);
  queueMicrotask(() => {
    field.focus();
    field.select();
  });
}

function runCtxPin() {
  const t = ctxTarget;
  hideChatContextMenu();
  if (!t) return;
  if (t.kind === "project") {
    setProjectPinned(t.cwd, !isProjectPinned(t.cwd));
    renderProjects();
    return;
  }
  const key = pinKeyForCtx(t);
  if (!key) return;
  setPinnedKey(key, !isPinnedKey(key));
  renderProjects();
}

async function runCtxRemove() {
  const t = ctxTarget;
  hideChatContextMenu();
  if (!t || t.kind !== "project") return;
  await removeProjectFromSidebar(t.cwd);
}

async function removeProjectFromSidebar(path: string) {
  const label = projectLabel(path);
  const ok = await confirm(`Remove ${label} from the sidebar? The folder stays on disk.`, {
    title: "Remove project",
    kind: "warning",
  });
  if (!ok) return;
  prefs.recent = prefs.recent.filter((p) => p !== path);
  setProjectPinned(path, false);
  pruneProjectMeta();
  savePrefs();
  if (prefs.activeCwd === path) {
    const next = prefs.recent[0] || "";
    if (next) {
      await setActiveProject(next);
      return;
    }
    prefs.activeCwd = null;
    savePrefs();
    activeChatKey = null;
    setChatName("New chat");
    updatePlaceholder();
    syncEmptyMain();
    setSideChromeOpen(false);
  }
  renderProjects();
}

function runCtxArchive() {
  const t = ctxTarget;
  hideChatContextMenu();
  if (!t) return;
  if (t.kind === "session") {
    void archiveSession(t.cwd, t.sessionId, t.title);
    return;
  }
  if (t.kind !== "draft") return;
  const key = t.runtimeKey;
  void invoke("reset_session", { chatKey: key }).catch(() => {});
  chats.delete(key);
  if (activeChatKey === key) activeChatKey = null;
  syncDockBadge();
  void startNewChat();
}

function commitRename(target: CtxTarget, raw: string) {
  renameTarget = null;
  renameSource = "list";
  if (target.kind === "project") {
    setProjectName(target.cwd, raw);
    renderProjects();
    return;
  }
  if (target.kind === "session") {
    setSessionTitle(target.cwd, target.sessionId, raw);
    paintTopbarTitle();
    return;
  }
  const name = raw.trim() || "New chat";
  let draft = chats.get(target.runtimeKey);
  if (!draft || draft.cwd !== target.cwd) {
    draft = makeChat(target.cwd, {
      key: target.runtimeKey,
      forceNew: true,
      title: name,
    });
  } else {
    draft.title = name;
  }
  if (activeChatKey === draft.key) setChatName(name);
  renderProjects();
  paintTopbarTitle();
}

function cancelRename() {
  if (!renameTarget) return;
  renameTarget = null;
  renameSource = "list";
  renderProjects();
  paintTopbarTitle();
}

function makeChatRow(
  label: string,
  opts: {
    active: boolean;
    running: boolean;
    done?: boolean;
    answer?: boolean;
    plan?: boolean;
    pinned?: boolean;
    lastActive?: number;
    title?: string;
    ctx: CtxTarget;
    chatIco?: boolean;
    onOpen: () => void;
    onTrash: () => void;
  },
): HTMLElement {
  const done = !opts.running && !!opts.done;
  const row = document.createElement("div");
  row.className =
    "chat-row" +
    (opts.active ? " active" : "") +
    (opts.running ? " running" : "") +
    (done ? " done" : "");

  if (
    renameTarget &&
    renameSource === "list" &&
    matchesCtx(renameTarget, opts.ctx)
  ) {
    row.classList.add("renaming");
    const field = document.createElement("input");
    field.type = "text";
    field.className = "chat-rename-input";
    field.value = label || "Chat";
    field.setAttribute("aria-label", "Rename chat");
    field.addEventListener("click", (e) => e.stopPropagation());
    field.addEventListener("pointerdown", (e) => e.stopPropagation());
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) commitRename(opts.ctx, field.value);
      else cancelRename();
    };
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    field.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!done && renameTarget && matchesCtx(renameTarget, opts.ctx)) {
          finish(true);
        }
      }, 0);
    });
    row.appendChild(field);
    queueMicrotask(() => {
      field.focus();
      field.select();
    });
    return row;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-item";
  if (opts.chatIco) {
    const ico = document.createElement("span");
    ico.className = "chat-item-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.appendChild(iconEl(Ico.sidePick, { size: 16 }));
    btn.appendChild(ico);
  }

  const addBadge = (text: string) => {
    const badge = document.createElement("span");
    badge.className = "chat-item-plan";
    badge.textContent = text;
    btn.appendChild(badge);
  };
  if (opts.answer) addBadge("Answer");
  if (opts.plan) addBadge("Plan");

  const text = document.createElement("span");
  text.className = "chat-item-label";
  text.textContent = label;
  btn.appendChild(text);

  const mark = document.createElement("span");
  mark.className = "chat-item-mark";
  mark.setAttribute("aria-hidden", "true");
  if (opts.running) {
    mark.classList.add("is-spinner");
    mark.innerHTML = SPINNER_SVG;
    btn.title = opts.title
      ? `${opts.title} (working)`
      : `${label} (working)`;
    btn.setAttribute("aria-busy", "true");
  } else if (done) {
    mark.classList.add("is-done");
    mark.innerHTML = CHECK_SVG;
    btn.title = opts.title
      ? `${opts.title} (finished)`
      : `${label} (finished)`;
  } else {
    mark.hidden = true;
    if (opts.title) btn.title = opts.title;
  }
  btn.appendChild(mark);

  if (opts.active) btn.setAttribute("aria-current", "true");

  // Delay open so double-click can rename without the first click rebuilding the row
  let openTimer: number | null = null;
  btn.addEventListener("click", () => {
    if (projectDragged || skipChatOpen) return;
    if (openTimer != null) {
      window.clearTimeout(openTimer);
      openTimer = null;
      return;
    }
    openTimer = window.setTimeout(() => {
      openTimer = null;
      if (projectDragged || skipChatOpen) return;
      opts.onOpen();
    }, 280);
  });
  btn.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openTimer != null) {
      window.clearTimeout(openTimer);
      openTimer = null;
    }
    beginRename(opts.ctx, "list");
  });
  if (opts.answer) {
    btn.title = (btn.title ? `${btn.title} - ` : "") + "Needs an answer";
  }
  if (opts.plan) {
    btn.title = (btn.title ? `${btn.title} - ` : "") + "Plan";
  }
  if (opts.pinned) {
    btn.title = (btn.title ? `${btn.title} - ` : "") + "Pinned";
  }
  btn.title = (btn.title ? `${btn.title} - ` : "") + "Double-click to rename";

  const actions = document.createElement("div");
  actions.className = "chat-actions";

  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.className = "chat-action chat-pin" + (opts.pinned ? " is-on" : "");
  pinBtn.setAttribute(
    "aria-label",
    opts.pinned ? `Unpin ${label}` : `Pin ${label}`,
  );
  pinBtn.setAttribute("aria-pressed", opts.pinned ? "true" : "false");
  pinBtn.innerHTML = pinHtml(!!opts.pinned);
  pinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const key = pinKeyForCtx(opts.ctx);
    if (!key) return;
    setPinnedKey(key, !isPinnedKey(key));
    renderProjects();
  });

  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "chat-action chat-trash";
  trash.setAttribute("aria-label", `Archive ${label}`);
  trash.innerHTML = TRASH_SVG;
  const armKey = pinKeyForCtx(opts.ctx);
  if (armKey) trash.dataset.arm = armKey;
  if (armKey && archiveArmedKey === armKey) {
    trash.classList.add("is-confirm");
    trash.title = "Click again to archive";
  }
  trash.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!armKey) {
      opts.onTrash();
      return;
    }
    if (archiveArmedKey === armKey) {
      setArchiveArmed(null);
      opts.onTrash();
      return;
    }
    setArchiveArmed(armKey);
  });
  row.addEventListener("mouseleave", () => {
    if (archiveArmedKey === armKey) setArchiveArmed(null);
  });

  actions.append(pinBtn, trash);

  const openMenu = (e: MouseEvent) => {
    showChatContextMenu(e, opts.ctx);
  };
  row.addEventListener("contextmenu", openMenu);
  btn.addEventListener("contextmenu", openMenu);
  pinBtn.addEventListener("contextmenu", openMenu);
  trash.addEventListener("contextmenu", openMenu);

  row.append(btn, actions);
  return row;
}

async function archiveSession(
  cwd: string,
  sessionId: string,
  title: string,
) {
  pruneArchive();
  if (!isArchived(cwd, sessionId)) {
    prefs.archive.unshift({
      sessionId,
      cwd,
      title: title || "Chat",
      archivedAt: Date.now(),
    });
    savePrefs();
  }
  const gone = pinKey(cwd, sessionId);
  setPinnedKey(gone, false);
  if (gone && prefs.lastActive[gone]) {
    delete prefs.lastActive[gone];
    savePrefs();
  }

  for (const [key, c] of [...chats.entries()]) {
    if (c.cwd === cwd && c.sessionId === sessionId) {
      await discardSideForMainKey(key);
      try {
        await invoke("reset_session", { chatKey: key });
      } catch {
        /* ok */
      }
      chats.delete(key);
      if (activeChatKey === key) activeChatKey = null;
    }
  }
  syncDockBadge();

  if (prefs.sessionByCwd[cwd] === sessionId) {
    delete prefs.sessionByCwd[cwd];
    savePrefs();
  }
  delete prefs.waiting[titleKey(cwd, sessionId)];
  savePrefs();

  if (prefs.activeCwd === cwd && !activeChatKey) {
    await startNewChat();
  }
  renderProjects();
  if (mainPage === "settings") renderArchiveList();
}

async function restoreArchived(entry: ArchivedChat) {
  prefs.archive = prefs.archive.filter(
    (a) => !(a.cwd === entry.cwd && a.sessionId === entry.sessionId),
  );
  savePrefs();

  rememberFolder(entry.cwd);
  prefs.activeCwd = entry.cwd;
  setProjectExpanded(entry.cwd, true);
  savePrefs();
  updatePlaceholder();
  await refreshSessionsFor(entry.cwd);
  setMainPage(null);
  await openSession(entry.sessionId, entry.title);
}

function openSettings() {
  setMainPage("settings");
}

let settingsToggleAt = 0;

function toggleSettings() {
  const now = Date.now();
  // Menu Cmd+, and the window keydown can both fire once.
  if (now - settingsToggleAt < 250) return;
  settingsToggleAt = now;
  hideChatContextMenu();
  if (mainPage === "settings") setMainPage(null);
  else openSettings();
}

type McpRow = {
  name: string;
  enabled: boolean;
  scope: string;
  transport: string;
  url: string;
  canSignIn: boolean;
  signedIn: boolean;
};

type MarketPlugin = {
  name: string;
  description: string;
  marketplace: string;
  source: string;
  homepage: string;
  installed: boolean;
};

type SkillRow = {
  name: string;
  description: string;
  source: string;
  path: string;
  hasExtras: boolean;
  disabled: boolean;
};

type SkillFileNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: SkillFileNode[];
};

const skillTreeOpen = new Set<string>();
const skillTreeCache = new Map<string, SkillFileNode[]>();

const SKILL_EDIT_ICO = iconHtml(Ico.pencil, { size: 16 });

type PluginsSnapshot = {
  mcp: McpRow[];
  skills: SkillRow[];
  mcpError?: string | null;
};

const MCP_FAMILIES: {
  test: RegExp;
  label: string;
  icon: string;
  letters: string;
}[] = [
  { test: /^brandfetch/i, label: "Brandfetch", icon: "brandfetch", letters: "Bf" },
  { test: /^figma/i, label: "Figma", icon: "figma", letters: "Fi" },
  { test: /^filesystem$/i, label: "Filesystem", icon: "", letters: "Fs" },
  { test: /^github/i, label: "GitHub", icon: "github", letters: "Gh" },
  { test: /^gitlab/i, label: "GitLab", icon: "gitlab", letters: "Gl" },
  { test: /^gmail/i, label: "Gmail", icon: "gmail", letters: "Gm" },
  { test: /^google-docs|^gdocs/i, label: "Google Docs", icon: "google", letters: "Gd" },
  { test: /^granola/i, label: "Granola", icon: "granola", letters: "Gr" },
  { test: /^linear/i, label: "Linear", icon: "linear", letters: "Li" },
  { test: /^mixpanel/i, label: "Mixpanel", icon: "mixpanel", letters: "Mx" },
  { test: /^mymind/i, label: "mymind", icon: "mymind", letters: "Mm" },
  { test: /^notion/i, label: "Notion", icon: "notion", letters: "No" },
  { test: /^palmier/i, label: "Palmier", icon: "palmier", letters: "Pp" },
  { test: /^paste/i, label: "Paste", icon: "paste", letters: "Pa" },
  { test: /^pencil/i, label: "Pencil", icon: "pencil", letters: "Pe" },
  { test: /^postgres/i, label: "Postgres", icon: "", letters: "Pg" },
  { test: /^sentry/i, label: "Sentry", icon: "sentry", letters: "Se" },
  { test: /^slack/i, label: "Slack", icon: "slack", letters: "Sl" },
  { test: /^sqlite/i, label: "SQLite", icon: "", letters: "Sq" },
  { test: /^tasks$/i, label: "Tasks", icon: "", letters: "Tk" },
  { test: /^telegram/i, label: "Telegram", icon: "telegram", letters: "Tg" },
  { test: /^typefully/i, label: "Typefully", icon: "typefully", letters: "Ty" },
  { test: /^voice$/i, label: "Voice", icon: "", letters: "Vo" },
];

function mcpFamily(name: string): { label: string; icon: string; letters: string } {
  for (const f of MCP_FAMILIES) {
    if (f.test.test(name)) return f;
  }
  return { label: name, icon: "", letters: "" };
}

const MCP_MARK_GENERIC = iconHtml(Ico.folder, { size: 16 });

function mcpFaviconSrc(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.trim();
    if (!host) return "";
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  } catch {
    return "";
  }
}

function paintMcpMark(host: HTMLElement, name: string, url = "") {
  host.replaceChildren();
  host.classList.remove("is-generic");
  const custom = prefs.mcpMarks[name];
  if (custom) {
    const img = document.createElement("img");
    img.className = "plugin-mark-img";
    img.alt = "";
    img.src = convertFileSrc(custom);
    img.addEventListener("error", () => {
      img.remove();
      host.classList.add("is-generic");
      host.innerHTML = MCP_MARK_GENERIC;
    });
    host.appendChild(img);
    return;
  }
  const hit = mcpFamily(name);
  if (hit.icon) {
    const img = document.createElement("img");
    img.className = "plugin-mark-img";
    img.alt = "";
    img.src = `/mcp-icons/${hit.icon}.png`;
    img.addEventListener("error", () => {
      img.remove();
      host.textContent = hit.letters;
    });
    host.appendChild(img);
    return;
  }
  const fav = mcpFaviconSrc(url);
  if (fav) {
    const img = document.createElement("img");
    img.className = "plugin-mark-img";
    img.alt = "";
    img.src = fav;
    img.addEventListener("error", () => {
      img.remove();
      if (hit.letters) host.textContent = hit.letters;
      else {
        host.classList.add("is-generic");
        host.innerHTML = MCP_MARK_GENERIC;
      }
    });
    host.appendChild(img);
    return;
  }
  if (hit.letters) {
    host.textContent = hit.letters;
    return;
  }
  host.classList.add("is-generic");
  host.innerHTML = MCP_MARK_GENERIC;
}

function mcpTransportLabel(t: string): string {
  if (t === "stdio") return "Command";
  if (t === "sse") return "SSE";
  if (t === "http") return "HTTP";
  return "";
}

function mcpScopeLabel(scope: string): string {
  if (scope === "project") return "Project";
  if (scope === "user") return "";
  if (scope.startsWith("plugin:")) {
    const n = scope.slice(7);
    return n ? n : "Plugin";
  }
  if (scope === "plugin") return "Plugin";
  return "";
}

let pluginsPaneAnims: Animation[] = [];
let pluginsSwapGen = 0;
type PluginsTab = "mcp" | "market" | "skills";
let pluginsTab: PluginsTab = "mcp";
const PLUGINS_TAB_I: Record<PluginsTab, number> = {
  mcp: 0,
  market: 1,
  skills: 2,
};

function pluginsPaneFor(tab: PluginsTab): HTMLElement | null {
  if (tab === "mcp") return pluginsMcpPane();
  if (tab === "market") return pluginsMarketPane();
  return pluginsSkillsPane();
}

function swapPluginsPanes(
  incoming: HTMLElement,
  outgoing: HTMLElement,
  dir: number,
) {
  const gen = ++pluginsSwapGen;
  incoming.hidden = false;
  incoming.removeAttribute("hidden");
  if (!motionOk()) {
    if (!outgoing.id) outgoing.remove();
    else {
      outgoing.hidden = true;
      outgoing.setAttribute("hidden", "");
    }
    return;
  }
  for (const anim of pluginsPaneAnims) anim.cancel();
  incoming.classList.add("is-swap");
  outgoing.classList.add("is-swap");
  const stage = incoming.parentElement;
  const fromH = stage?.getBoundingClientRect().height ?? 0;
  const dx = 8 * dir;
  const leave = outgoing.animate(
    [
      { opacity: 1, transform: "none", filter: "blur(0)" },
      { opacity: 0, transform: `translateX(${-dx}px)`, filter: "blur(2px)" },
    ],
    { duration: 180, easing: EASE_IN_OUT, fill: "forwards" },
  );
  const enter = incoming.animate(
    [
      { opacity: 0, transform: `translateX(${dx}px)`, filter: "blur(2px)" },
      { opacity: 1, transform: "none", filter: "blur(0)" },
    ],
    { duration: 180, easing: EASE_IN_OUT, fill: "forwards" },
  );
  pluginsPaneAnims = [leave, enter];
  if (stage && fromH > 0) {
    const toH = incoming.getBoundingClientRect().height;
    if (Math.abs(toH - fromH) > 2) {
      pluginsPaneAnims.push(
        stage.animate(
          [{ height: `${fromH}px` }, { height: `${toH}px` }],
          { duration: 180, easing: EASE_IN_OUT },
        ),
      );
    }
  }
  void enter.finished.finally(() => {
    if (!outgoing.id) outgoing.remove();
    if (gen !== pluginsSwapGen) return;
    if (outgoing.isConnected) {
      outgoing.hidden = true;
      outgoing.setAttribute("hidden", "");
    }
    incoming.classList.remove("is-swap");
    outgoing.classList.remove("is-swap");
    leave.cancel();
    enter.cancel();
    pluginsPaneAnims = [];
  });
}

function setPluginsTab(tab: PluginsTab) {
  const prev = pluginsTab;
  pluginsTab = tab;
  pluginsTabMcp()?.classList.toggle("is-on", tab === "mcp");
  pluginsTabMarket()?.classList.toggle("is-on", tab === "market");
  pluginsTabSkills()?.classList.toggle("is-on", tab === "skills");
  pluginsTabMcp()?.setAttribute("aria-selected", tab === "mcp" ? "true" : "false");
  pluginsTabMarket()?.setAttribute(
    "aria-selected",
    tab === "market" ? "true" : "false",
  );
  pluginsTabSkills()?.setAttribute(
    "aria-selected",
    tab === "skills" ? "true" : "false",
  );
  paintTopbarTitle();
  layoutSegThumbs();
  closeAddPluginCard();
  const incoming = pluginsPaneFor(tab);
  const outgoing = pluginsPaneFor(prev);
  if (!incoming || !outgoing) return;
  if (tab === prev && !incoming.hidden) return;
  if (tab === "market") void loadMarketplacePage();
  const dir = PLUGINS_TAB_I[tab] >= PLUGINS_TAB_I[prev] ? 1 : -1;
  if (prev === tab) {
    incoming.hidden = false;
    incoming.removeAttribute("hidden");
    return;
  }
  swapPluginsPanes(incoming, outgoing, dir);
}

function setPaneStatus(el: HTMLElement | null, text: string, err = false) {
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("is-err");
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("is-err", err);
}

function currentNavPlace(): NavPlace | null {
  if (mainPage === "plugins") return { kind: "plugins" };
  if (mainPage === "settings") return { kind: "settings" };
  if (activeChatKey) return { kind: "chat", key: activeChatKey };
  return null;
}

function sameNavPlace(a: NavPlace, b: NavPlace): boolean {
  if (a.kind === "plugins" && b.kind === "plugins") return true;
  if (a.kind === "settings" && b.kind === "settings") return true;
  if (a.kind === "chat" && b.kind === "chat") return a.key === b.key;
  return false;
}

function navPlaceLive(place: NavPlace): boolean {
  if (place.kind === "plugins" || place.kind === "settings") return true;
  return chats.has(place.key);
}

function paintNavButtons() {
  const back = navBackBtn();
  const fwd = navForwardBtn();
  if (back) back.disabled = navIndex <= 0;
  if (fwd) fwd.disabled = navIndex < 0 || navIndex >= navStack.length - 1;
}

function recordCurrentNav() {
  if (navSilent) return;
  const place = currentNavPlace();
  if (!place) return;
  const cur = navStack[navIndex];
  if (cur && sameNavPlace(cur, place)) return;
  navStack = navStack.slice(0, navIndex + 1);
  navStack.push(place);
  if (navStack.length > NAV_CAP) {
    const drop = navStack.length - NAV_CAP;
    navStack = navStack.slice(drop);
  }
  navIndex = navStack.length - 1;
  paintNavButtons();
}

function goNav(delta: number) {
  let i = navIndex + delta;
  while (i >= 0 && i < navStack.length) {
    const place = navStack[i];
    if (navPlaceLive(place)) {
      navIndex = i;
      paintNavButtons();
      navSilent = true;
      try {
        applyNavPlace(place);
      } finally {
        navSilent = false;
      }
      return;
    }
    navStack.splice(i, 1);
    if (navIndex >= navStack.length) navIndex = navStack.length - 1;
    if (delta < 0) i -= 1;
  }
  paintNavButtons();
}

function applyNavPlace(place: NavPlace) {
  if (place.kind === "plugins") {
    setMainPage("plugins");
    return;
  }
  if (place.kind === "settings") {
    setMainPage("settings");
    return;
  }
  const chat = chats.get(place.key);
  if (chat) focusChat(chat);
}

let pageMotionGen = 0;
let pageMotion: Animation | null = null;

function pageHost(page: Exclude<MainPage, null>): HTMLElement | null {
  return page === "plugins" ? pluginsPage() : settingsPage();
}

function stopPageMotion() {
  pageMotionGen += 1;
  pageMotion?.cancel();
  pageMotion = null;
  pluginsPage()?.classList.remove("is-motion");
  settingsPage()?.classList.remove("is-motion");
}

function hidePage(el: HTMLElement) {
  el.hidden = true;
  el.setAttribute("hidden", "");
  el.classList.remove("is-motion");
}

function playPageMotion(
  host: HTMLElement,
  kind: "in" | "out",
  onDone?: () => void,
) {
  if (!motionOk()) {
    if (kind === "in") fadeIn(host, 160);
    onDone?.();
    return;
  }
  const gen = ++pageMotionGen;
  pageMotion?.cancel();
  const anim = host.animate(
    kind === "in"
      ? [
          { opacity: 0, transform: "translateY(12px)" },
          { opacity: 1, transform: "none" },
        ]
      : [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(8px)" },
        ],
    { duration: 200, easing: EASE_OUT },
  );
  pageMotion = anim;
  void anim.finished.finally(() => {
    if (gen !== pageMotionGen) return;
    anim.cancel();
    pageMotion = null;
    onDone?.();
  });
}

function closePageWithMotion(prev: Exclude<MainPage, null>): boolean {
  const host = pageHost(prev);
  if (!host || host.hidden) return false;
  mainPage = null;
  pageMotion?.cancel();
  host.classList.add("is-motion");
  const other = prev === "plugins" ? settingsPage() : pluginsPage();
  if (other) hidePage(other);
  if (prev === "plugins") pluginsNavBtn()?.classList.remove("is-on");
  if (prev === "settings") settingsNavBtn()?.classList.remove("is-on");
  const chat = activeChat();
  const title = chatTitle();
  if (title && chat) title.textContent = chat.title;
  if (!navSilent) recordCurrentNav();
  // Hide chat only after the page has left.
  playPageMotion(host, "out", () => {
    hidePage(host);
    document.getElementById("shell")?.classList.remove("page-open");
    syncEmptyMain();
    syncSidePanelForMain(activeChat());
    paintOutputs(activeChat());
    paintPromptJumps(activeChat());
    input()?.focus();
  });
  return true;
}

function setMainPage(next: MainPage) {
  if (next) closeFind();
  if (next && mainPage === next) {
    if (next === "plugins") {
      void loadPluginsPage();
    }
    if (next === "settings") void loadSettingsPage();
    return;
  }

  const prev = mainPage;
  if (next !== "plugins") closeAddPluginCard();
  const plug = pluginsPage();
  const setp = settingsPage();

  if (prev && next === null && closePageWithMotion(prev)) return;

  stopPageMotion();
  mainPage = next;
  const shell = document.getElementById("shell");
  if (!next) shell?.classList.remove("page-open");
  if (plug) {
    plug.hidden = next !== "plugins";
    if (next === "plugins") plug.removeAttribute("hidden");
    else plug.setAttribute("hidden", "");
    plug.classList.remove("is-motion");
  }
  if (setp) {
    setp.hidden = next !== "settings";
    if (next === "settings") setp.removeAttribute("hidden");
    else setp.setAttribute("hidden", "");
    setp.classList.remove("is-motion");
  }
  pluginsNavBtn()?.classList.toggle("is-on", next === "plugins");
  settingsNavBtn()?.classList.toggle("is-on", next === "settings");
  if (next) {
    if (chatSearchOpen) setChatSearchOpen(false, true);
    setSideChromeOpen(false);
    const openBtn = openSideBtn();
    if (openBtn) {
      openBtn.hidden = true;
      openBtn.setAttribute("hidden", "");
    }
    const title = chatTitle();
    if (title) {
      title.hidden = false;
      title.textContent =
        next === "plugins"
          ? pluginsTab === "skills"
            ? "Skills"
            : pluginsTab === "market"
              ? "Marketplace"
              : "Plugins"
          : "Settings";
    }
    syncEmptyMain();
    const host = pageHost(next);
    const startEnter = () => {
      if (mainPage !== next || !host) return;
      host.style.removeProperty("opacity");
      if (!prev && motionOk()) {
        host.classList.add("is-motion");
        playPageMotion(host, "in", () => {
          shell?.classList.add("page-open");
          host.classList.remove("is-motion");
          paintNewProjectBar();
          layoutSegThumbs();
        });
      } else {
        shell?.classList.add("page-open");
        fadeIn(host, 160);
        paintNewProjectBar();
        layoutSegThumbs();
      }
    };
    if (next === "plugins") {
      if (host && !prev && motionOk()) {
        host.classList.add("is-motion");
        // Hold cover until the list is painted.
        host.style.opacity = "0";
      }
      void loadPluginsPage().then(() => {
        startEnter();
      });
    } else {
      if (next === "settings") void loadSettingsPage();
      startEnter();
    }
    input()?.blur();
    paintOutputs(null);
    paintPromptJumps(null);
    if (!navSilent) recordCurrentNav();
    return;
  }
  const chat = activeChat();
  const title = chatTitle();
  if (title && chat) title.textContent = chat.title;
  syncSidePanelForMain(chat);
  paintOutputs(chat);
  syncEmptyMain();
  paintPromptJumps(chat);
  input()?.focus();
  if (!navSilent) recordCurrentNav();
}

async function onPickMcpMark(name: string, host: HTMLElement, url: string) {
  try {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path || typeof path !== "string") return;
    prefs.mcpMarks[name] = path;
    savePrefs();
    paintMcpMark(host, name, url);
    trayMcp = null;
  } catch {
    /* cancelled */
  }
}

function closeAddPluginCard() {
  const card = addPluginCard();
  if (!card) return;
  card.hidden = true;
  card.setAttribute("hidden", "");
}

function openAddPluginCard() {
  setPluginsTab("mcp");
  const card = addPluginCard();
  if (!card) return;
  card.hidden = false;
  card.removeAttribute("hidden");
  addPluginName()?.focus();
}

async function onAddPluginSubmit(e: Event) {
  e.preventDefault();
  const name = (addPluginName()?.value || "").trim();
  const url = (addPluginUrl()?.value || "").trim();
  const btn = addPluginSubmit();
  if (btn) btn.disabled = true;
  setPaneStatus(mcpStatus(), "");
  try {
    await invoke("add_mcp_url", {
      name,
      url,
      cwd: prefs.activeCwd || "",
    });
    closeAddPluginCard();
    const nameEl = addPluginName();
    const urlEl = addPluginUrl();
    if (nameEl) nameEl.value = "";
    if (urlEl) urlEl.value = "";
    trayMcp = null;
    await loadPluginsPage();
  } catch (err) {
    setPaneStatus(
      mcpStatus(),
      err instanceof Error ? err.message : String(err),
      true,
    );
  }
  if (btn) btn.disabled = false;
}

async function loadMarketplacePage() {
  try {
    const rows = await invoke<MarketPlugin[]>("list_marketplace_plugins", {
      cwd: prefs.activeCwd || "",
    });
    if (mainPage !== "plugins") return;
    setPaneStatus(marketStatus(), "");
    paintMarketplaceList(Array.isArray(rows) ? rows : []);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPaneStatus(marketStatus(), msg, true);
    paintMarketplaceList([]);
  }
}

function paintMarketplaceList(rows: MarketPlugin[]) {
  const list = marketList();
  const empty = marketEmpty();
  if (!list) return;
  list.replaceChildren();
  if (empty) empty.hidden = rows.length > 0;
  const sorted = [...rows];
  let lastGroup = "";
  for (const row of sorted) {
    const group = row.marketplace || "Marketplace";
    if (group !== lastGroup) {
      lastGroup = group;
      const head = document.createElement("li");
      head.className = "plugin-group-head";
      head.textContent = group;
      list.appendChild(head);
    }
    const li = document.createElement("li");
    li.className = "plugin-row";
    const mark = document.createElement("span");
    mark.className = "plugin-mark";
    const home = row.homepage || "";
    paintMcpMark(mark, row.name, home);
    const copy = document.createElement("div");
    copy.className = "plugin-copy";
    const name = document.createElement("div");
    name.className = "plugin-name";
    name.textContent = row.name;
    const meta = document.createElement("div");
    meta.className = "plugin-meta";
    meta.textContent = row.description;
    if (meta.textContent) meta.title = meta.textContent;
    copy.append(name, meta);
    const tools = document.createElement("div");
    tools.className = "plugin-tools";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mcp-signin";
    if (row.installed) {
      btn.textContent = "Installed";
      btn.disabled = true;
    } else {
      btn.textContent = "Install";
      btn.setAttribute("aria-label", `Install ${row.name}`);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void onInstallMarketPlugin(row, btn);
      });
    }
    tools.appendChild(btn);
    li.append(mark, copy, tools);
    list.appendChild(li);
  }
}

async function onInstallMarketPlugin(row: MarketPlugin, btn: HTMLButtonElement) {
  btn.disabled = true;
  btn.textContent = "Installing…";
  setPaneStatus(marketStatus(), "");
  try {
    await invoke("install_marketplace_plugin", {
      source: row.source,
      cwd: prefs.activeCwd || "",
    });
    trayMcp = null;
    await loadMarketplacePage();
    await loadPluginsPage();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Install";
    setPaneStatus(
      marketStatus(),
      e instanceof Error ? e.message : String(e),
      true,
    );
  }
}

async function loadPluginsPage() {
  try {
    const snap = await invoke<PluginsSnapshot>("load_plugins_snapshot", {
      cwd: prefs.activeCwd || "",
    });
    if (mainPage !== "plugins") return;
    setPaneStatus(mcpStatus(), snap.mcpError || "", !!snap.mcpError);
    setPaneStatus(skillsStatus(), "");
    const mcp = snap.mcp.map((row) => ({
      ...row,
      url: row.url || "",
      enabled: row.enabled && !prefs.mcpOff.includes(row.name),
    }));
    paintMcpList(mcp);
    paintSkillsList(snap.skills);
    if (pluginsTab === "market") void loadMarketplacePage();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPaneStatus(mcpStatus(), msg, true);
    setPaneStatus(skillsStatus(), msg, true);
    paintMcpList([]);
    paintSkillsList([]);
  }
}

function paintMcpList(rows: McpRow[]) {
  const list = mcpList();
  const empty = mcpEmpty();
  if (!list) return;
  list.replaceChildren();
  if (empty) empty.hidden = rows.length > 0;
  const sorted = [...rows].sort((a, b) => {
    const fa = mcpFamily(a.name);
    const fb = mcpFamily(b.name);
    const g = fa.label.localeCompare(fb.label, undefined, { sensitivity: "base" });
    if (g !== 0) return g;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  let lastGroup = "";
  for (const row of sorted) {
    const group = mcpFamily(row.name).label;
    if (group !== lastGroup) {
      lastGroup = group;
      const head = document.createElement("li");
      head.className = "plugin-group-head";
      head.textContent = group;
      list.appendChild(head);
    }
    const li = document.createElement("li");
    li.className = "plugin-row" + (row.enabled ? "" : " is-off");
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "plugin-mark";
    mark.setAttribute("aria-label", `Set picture for ${row.name}`);
    paintMcpMark(mark, row.name, row.url || "");
    mark.addEventListener("click", (e) => {
      e.stopPropagation();
      void onPickMcpMark(row.name, mark, row.url || "");
    });
    const copy = document.createElement("div");
    copy.className = "plugin-copy";
    const name = document.createElement("div");
    wirePluginName(name, row.name, li);
    const meta = document.createElement("div");
    meta.className = "plugin-meta";
    meta.textContent = [
      mcpTransportLabel(row.transport),
      mcpScopeLabel(row.scope),
      row.signedIn ? "Signed in" : "",
    ]
      .filter(Boolean)
      .join(" - ");
    if (meta.textContent) meta.title = meta.textContent;
    copy.append(name, meta);
    const tools = document.createElement("div");
    tools.className = "plugin-tools";
    if (row.canSignIn) {
      const sign = document.createElement("button");
      sign.type = "button";
      sign.className = "mcp-signin";
      if (row.signedIn) {
        sign.textContent = "Sign out";
        sign.setAttribute("aria-label", `Sign out ${row.name}`);
        sign.addEventListener("click", (e) => {
          e.stopPropagation();
          void onSignOutMcp(row.name);
        });
      } else {
        sign.textContent = "Sign in";
        sign.setAttribute("aria-label", `Sign in ${row.name}`);
        sign.addEventListener("click", (e) => {
          e.stopPropagation();
          void onSignInMcp(row.name, sign);
        });
      }
      tools.appendChild(sign);
    }
    li.addEventListener("contextmenu", (e) => {
      showMcpContextMenu(e, row.name, li, !row.scope.startsWith("plugin"));
    });
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "mcp-switch";
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", row.enabled ? "true" : "false");
    sw.setAttribute(
      "aria-label",
      `${row.enabled ? "Disable" : "Enable"} ${mcpDisplayName(row.name)}`,
    );
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      void onToggleMcp(row.name, sw);
    });
    tools.appendChild(sw);
    li.append(mark, copy, tools);
    list.appendChild(li);
  }
}

function slashPluginSkillOff(source?: string): boolean {
  if (!source || !source.startsWith("plugin")) return false;
  const plugin = source.startsWith("plugin:") ? source.slice(7) : "";
  if (!plugin) return false;
  const fam = mcpFamily(plugin);
  return prefs.mcpOff.some((n) => {
    if (n.toLowerCase() === plugin.toLowerCase()) return true;
    const off = mcpFamily(n);
    if (!(fam.icon || fam.letters) || !(off.icon || off.letters)) return false;
    return off.label.toLowerCase() === fam.label.toLowerCase();
  });
}

function slashSkillRank(source?: string): number {
  const s = source || "";
  if (s === "personal") return 0;
  if (s === "project" || s.startsWith("project:")) return 1;
  if (s.startsWith("plugin")) return 2;
  if (s === "bundled") return 3;
  return 4;
}

function pluginSourceName(source: string): string {
  if (!source.startsWith("plugin:")) return "";
  return source.slice(7);
}

function slashProjectLabel(source: string): string {
  const cwd = activeChat()?.cwd || prefs.activeCwd || "";
  if (cwd && !isRecentsCwd(cwd)) return projectLabel(cwd);
  if (source.startsWith("project:")) return source.slice(8) || "Project";
  return "Project";
}

function slashSourceLabel(source: string): string {
  if (source === "bundled") return "Grok";
  if (source === "project" || source.startsWith("project:")) {
    return slashProjectLabel(source);
  }
  if (source.startsWith("plugin")) {
    const n = pluginSourceName(source) || source;
    const fam = mcpFamily(n);
    if (fam.icon || fam.letters) return fam.label;
  }
  return skillGroupLabel(source);
}

function skillGroupLabel(source: string): string {
  if (source.startsWith("project:")) {
    const n = source.slice(8);
    return n || "Project";
  }
  if (source === "project") return "Project";
  if (source === "personal") return "Personal";
  if (source === "bundled") return "Bundled";
  if (source.startsWith("plugin:")) {
    const n = source.slice(7);
    return n ? n[0].toUpperCase() + n.slice(1) : "Plugin";
  }
  if (source === "plugin") return "Plugin";
  return source;
}

function paintSkillsList(rows: SkillRow[]) {
  const list = skillsList();
  const empty = skillsEmpty();
  if (!list) return;
  list.replaceChildren();
  if (empty) empty.hidden = rows.length > 0;
  // Group first. A name sort splits Slack around Figma.
  const skillRank = (source: string) => {
    if (source === "project" || source.startsWith("project:")) return 0;
    if (source === "personal") return 1;
    if (source.startsWith("plugin")) return 2;
    if (source === "bundled") return 3;
    return 4;
  };
  const sorted = [...rows].sort((a, b) => {
    const r = skillRank(a.source) - skillRank(b.source);
    if (r !== 0) return r;
    const g = skillGroupLabel(a.source).localeCompare(
      skillGroupLabel(b.source),
      undefined,
      { sensitivity: "base" },
    );
    if (g !== 0) return g;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  let lastGroup = "";
  for (const row of sorted) {
    const group = skillGroupLabel(row.source);
    if (group !== lastGroup) {
      lastGroup = group;
      const head = document.createElement("li");
      head.className = "plugin-group-head";
      head.textContent = group;
      list.appendChild(head);
    }
    list.appendChild(buildSkillRow(row));
  }
}

function buildSkillRow(row: SkillRow): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "plugin-row skill-row" + (row.disabled ? " is-off" : "");
  const head = document.createElement("div");
  head.className = "skill-head";
  const mark = document.createElement("span");
  mark.className = "plugin-mark is-generic";
  mark.innerHTML = SUGGEST_ICO.skill;
  const copy = document.createElement("div");
  copy.className = "plugin-copy";
  const name = document.createElement("div");
  name.className = "plugin-name";
  name.textContent = row.name;
  const meta = document.createElement("div");
  meta.className = "plugin-meta";
  meta.textContent = row.description || "";
  if (row.description) meta.title = row.description;
  copy.append(name, meta);
  const tools = document.createElement("div");
  tools.className = "plugin-tools";
  if (row.path) {
    if (row.hasExtras) {
      const chev = document.createElement("button");
      chev.type = "button";
      chev.className = "skill-chevron";
      chev.setAttribute("aria-label", `Files in ${row.name}`);
      chev.setAttribute("aria-expanded", "false");
      const tip = document.createElement("span");
      tip.className = "skill-chevron-mark";
      tip.setAttribute("aria-hidden", "true");
      chev.appendChild(tip);
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggleSkillTree(row, li, chev);
      });
      tools.appendChild(chev);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "skill-edit";
    edit.setAttribute("aria-label", `Edit ${row.name}`);
    edit.innerHTML = SKILL_EDIT_ICO;
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      void openSkillFile(row.path);
    });
    tools.appendChild(edit);
  }
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "mcp-switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", row.disabled ? "false" : "true");
  sw.setAttribute(
    "aria-label",
    `${row.disabled ? "Enable" : "Disable"} ${row.name}`,
  );
  sw.addEventListener("click", (e) => {
    e.stopPropagation();
    void onToggleSkill(row.name, sw);
  });
  tools.appendChild(sw);
  head.append(mark, copy, tools);
  li.appendChild(head);
  if (row.path && row.hasExtras && skillTreeOpen.has(row.path)) {
    li.classList.add("is-open");
    const chev = tools.querySelector(".skill-chevron");
    if (chev) chev.setAttribute("aria-expanded", "true");
    const tree = document.createElement("ul");
    tree.className = "skill-tree";
    li.appendChild(tree);
    const cached = skillTreeCache.get(row.path);
    if (cached) paintSkillTree(tree, cached);
    else void fillSkillTree(row.path, tree);
  }
  return li;
}

function paintSkillTree(host: HTMLElement, nodes: SkillFileNode[]) {
  host.replaceChildren();
  if (nodes.length === 0) {
    const empty = document.createElement("li");
    empty.className = "skill-tree-empty";
    empty.textContent = "No files.";
    host.appendChild(empty);
    return;
  }
  for (const node of nodes) host.appendChild(skillTreeItem(node));
}

function skillTreeItem(node: SkillFileNode): HTMLLIElement {
  const li = document.createElement("li");
  if (node.isDir) {
    li.className = "skill-tree-dir";
    const label = document.createElement("span");
    label.textContent = `${node.name}/`;
    li.appendChild(label);
    if (node.children.length > 0) {
      const nest = document.createElement("ul");
      for (const child of node.children) nest.appendChild(skillTreeItem(child));
      li.appendChild(nest);
    }
    return li;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "skill-tree-file";
  btn.textContent = node.name;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void openSkillFile(node.path);
  });
  li.appendChild(btn);
  return li;
}

async function fillSkillTree(path: string, host: HTMLElement) {
  host.replaceChildren();
  const load = document.createElement("li");
  load.className = "skill-tree-empty";
  load.textContent = "Loading…";
  host.appendChild(load);
  try {
    const nodes = await invoke<SkillFileNode[]>("list_skill_files", { path });
    skillTreeCache.set(path, nodes);
    if (!host.isConnected) return;
    paintSkillTree(host, nodes);
  } catch (e) {
    if (!host.isConnected) return;
    host.replaceChildren();
    const err = document.createElement("li");
    err.className = "skill-tree-empty";
    err.textContent = e instanceof Error ? e.message : String(e);
    host.appendChild(err);
  }
}

async function toggleSkillTree(
  row: SkillRow,
  li: HTMLLIElement,
  chev: HTMLButtonElement,
) {
  const open = !skillTreeOpen.has(row.path);
  if (open) skillTreeOpen.add(row.path);
  else skillTreeOpen.delete(row.path);
  li.classList.toggle("is-open", open);
  chev.setAttribute("aria-expanded", open ? "true" : "false");
  let tree = li.querySelector<HTMLUListElement>(":scope > .skill-tree");
  if (!open) {
    tree?.remove();
    return;
  }
  if (!tree) {
    tree = document.createElement("ul");
    tree.className = "skill-tree";
    li.appendChild(tree);
  }
  const cached = skillTreeCache.get(row.path);
  if (cached) paintSkillTree(tree, cached);
  else await fillSkillTree(row.path, tree);
}

async function openSkillFile(path: string) {
  if (!path) return;
  try {
    await invoke("open_in_textedit", { path });
    setPaneStatus(skillsStatus(), "");
  } catch (e) {
    setPaneStatus(
      skillsStatus(),
      e instanceof Error ? e.message : String(e),
      true,
    );
  }
}

function setSwitch(btn: HTMLButtonElement, on: boolean, name: string) {
  btn.setAttribute("aria-checked", on ? "true" : "false");
  btn.setAttribute("aria-label", `${on ? "Disable" : "Enable"} ${name}`);
  btn.closest(".plugin-row")?.classList.toggle("is-off", !on);
}

async function onToggleSkill(name: string, btn: HTMLButtonElement) {
  if (btn.dataset.busy) return;
  const nextOn = btn.getAttribute("aria-checked") !== "true";
  // Keep the same switch node so the thumb can transition.
  btn.dataset.busy = "1";
  setSwitch(btn, nextOn, name);
  try {
    await invoke("set_skill_enabled", {
      name,
      enabled: nextOn,
    });
    skillCache = null;
  } catch (e) {
    setSwitch(btn, !nextOn, name);
    setPaneStatus(
      skillsStatus(),
      e instanceof Error ? e.message : String(e),
      true,
    );
  }
  delete btn.dataset.busy;
}

async function onToggleMcp(name: string, btn: HTMLButtonElement) {
  if (btn.dataset.busy) return;
  const nextOn = btn.getAttribute("aria-checked") !== "true";
  btn.dataset.busy = "1";
  setSwitch(btn, nextOn, name);
  if (nextOn) {
    prefs.mcpOff = prefs.mcpOff.filter((n) => n !== name);
  } else if (!prefs.mcpOff.includes(name)) {
    prefs.mcpOff.push(name);
  }
  savePrefs();
  skillCache = null;
  try {
    await invoke("set_mcp_enabled", {
      name,
      enabled: nextOn,
      cwd: prefs.activeCwd || "",
    });
  } catch (e) {
    if (nextOn) {
      if (!prefs.mcpOff.includes(name)) prefs.mcpOff.push(name);
      savePrefs();
      setSwitch(btn, false, name);
      setPaneStatus(
        mcpStatus(),
        e instanceof Error ? e.message : String(e),
        true,
      );
    }
  }
  delete btn.dataset.busy;
}

async function onSignOutMcp(name: string) {
  const ok = await confirm(`Sign out of ${name}?`, {
    title: "Sign out",
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("sign_out_mcp", { name });
    await loadPluginsPage();
  } catch (e) {
    setPaneStatus(mcpStatus(), e instanceof Error ? e.message : String(e), true);
  }
}

async function onSignInMcp(name: string, btn: HTMLButtonElement) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  setPaneStatus(mcpStatus(), "Opening sign-in. Finish the page in the browser.");
  try {
    await invoke("sign_in_mcp", { name, cwd: prefs.activeCwd || "" });
    setPaneStatus(mcpStatus(), "");
    await loadPluginsPage();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = prev || "Sign in";
    setPaneStatus(mcpStatus(), e instanceof Error ? e.message : String(e), true);
  }
}

async function onRemoveMcp(name: string) {
  const ok = await confirm(`Remove ${name}?`, {
    title: "Remove MCP",
    kind: "warning",
  });
  if (!ok) return;
  try {
    await invoke("remove_mcp_server", { name, cwd: prefs.activeCwd || "" });
    await loadPluginsPage();
  } catch (e) {
    setPaneStatus(mcpStatus(), e instanceof Error ? e.message : String(e), true);
  }
}

function renderArchiveList() {
  const list = archiveList();
  const empty = archiveEmpty();
  if (!list) return;
  list.replaceChildren();

  if (prefs.archive.length === 0) {
    if (empty) empty.hidden = false;
    paintEmptyArchive();
    return;
  }
  if (empty) empty.hidden = true;

  for (const entry of prefs.archive) {
    const li = document.createElement("li");
    li.className = "archive-item";

    const body = document.createElement("div");
    body.className = "archive-item-body";

    const title = document.createElement("div");
    title.className = "archive-item-title";
    title.textContent = shortTitle(
      displayTitle(entry.cwd, entry.sessionId, entry.title || "Chat"),
    );

    const meta = document.createElement("div");
    meta.className = "archive-item-meta";
    const days = daysLeftInArchive(entry.archivedAt);
    meta.textContent = archiveIsExpired(entry.archivedAt)
      ? `${folderName(entry.cwd)} - Expired`
      : `${folderName(entry.cwd)} - ${days} day${days === 1 ? "" : "s"} left`;

    body.append(title, meta);

    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "archive-restore";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => {
      void restoreArchived(entry);
    });

    li.append(body, restore);
    list.appendChild(li);
  }
  paintEmptyArchive();
}

type AboutInfo = {
  grotesque: string;
  cli: string | null;
};

async function paintAbout() {
  const appEl = aboutAppVer();
  const cliEl = aboutCliVer();
  try {
    const info = await invoke<AboutInfo>("about_info");
    if (appEl) appEl.textContent = info.grotesque.trim() || "—";
    if (cliEl) cliEl.textContent = info.cli?.trim() || "Not found";
  } catch {
    if (appEl) appEl.textContent = "—";
    if (cliEl) cliEl.textContent = "Not found";
  }
}

async function openAppLog() {
  const status = aboutLogStatus();
  if (status) {
    status.hidden = true;
    status.textContent = "";
  }
  try {
    await invoke("open_app_log");
  } catch (e) {
    if (!status) return;
    status.hidden = false;
    status.textContent = e instanceof Error ? e.message : String(e);
  }
}

type UsageStats = {
  lifetimeTokens: number;
  peakTokens: number;
  longestChatSecs: number;
  days: string[];
  daily: { day: string; tokens: number }[];
};

type UseView = "daily" | "weekly" | "cumulative";
let useView: UseView = "daily";
let useDaily: { day: string; tokens: number }[] = [];
let lastUseStats: UsageStats | null = null;
let useStatsDirty = true;
let useGridEntered = false;

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${trimCount(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trimCount(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trimCount(n / 1_000)}k`;
  return String(Math.max(0, Math.round(n)));
}

function trimCount(n: number): string {
  const t = n >= 10 ? n.toFixed(0) : n.toFixed(1);
  return t.endsWith(".0") ? t.slice(0, -2) : t;
}

function formatChatSecs(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function localToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayOffset(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(y, m - 1, d + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function streakPair(days: string[], today: string): { current: number; longest: number } {
  const set = new Set(days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  if (set.size === 0) return { current: 0, longest: 0 };
  let current = 0;
  let cursor = set.has(today) ? today : dayOffset(today, -1);
  while (set.has(cursor)) {
    current += 1;
    cursor = dayOffset(cursor, -1);
  }
  const sorted = [...set].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = sorted[i] === dayOffset(sorted[i - 1], 1) ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

function paintUseDash(n: string) {
  const life = useLifetime();
  const peak = usePeak();
  const long = useLongest();
  const streak = useStreak();
  const best = useBestStreak();
  if (life) life.textContent = n;
  if (peak) peak.textContent = n;
  if (long) long.textContent = n;
  if (streak) streak.textContent = n;
  if (best) best.textContent = n;
}

function paintUseStats(stats: UsageStats) {
  const { current, longest } = streakPair(stats.days ?? [], localToday());
  const life = useLifetime();
  const peak = usePeak();
  const long = useLongest();
  const streak = useStreak();
  const best = useBestStreak();
  if (life) life.textContent = formatTokenCount(stats.lifetimeTokens || 0);
  if (peak) peak.textContent = formatTokenCount(stats.peakTokens || 0);
  if (long) long.textContent = formatChatSecs(stats.longestChatSecs || 0);
  if (streak) streak.textContent = `${current} day${current === 1 ? "" : "s"}`;
  if (best) best.textContent = `${longest} day${longest === 1 ? "" : "s"}`;
  useDaily = Array.isArray(stats.daily) ? stats.daily : [];
  paintUseViewTabs();
  paintUseGrid();
}

function paintUseViewTabs() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-use-view]")) {
    const on = btn.dataset.useView === useView;
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    btn.setAttribute("role", "tab");
  }
  layoutSegThumbs();
}

const USE_VIEW_I: Record<UseView, number> = {
  daily: 0,
  weekly: 1,
  cumulative: 2,
};

let useGridSwapGen = 0;

function setUseView(next: UseView) {
  if (useView === next) return;
  const prev = useView;
  useView = next;
  paintUseViewTabs();
  const wrap = useGridWrap();
  const dir = USE_VIEW_I[next] >= USE_VIEW_I[prev] ? 1 : -1;
  if (!wrap || !motionOk()) {
    paintUseGrid();
    return;
  }
  const gen = ++useGridSwapGen;
  const dx = 8 * dir;
  wrap.getAnimations().forEach((a) => a.cancel());
  const leave = wrap.animate(
    [
      { opacity: 1, transform: "translateX(0)" },
      { opacity: 0, transform: `translateX(${-dx}px)` },
    ],
    { duration: 180, easing: EASE_IN_OUT, fill: "forwards" },
  );
  void leave.finished
    .then(() => {
      if (gen !== useGridSwapGen) return;
      leave.cancel();
      paintUseGrid();
      wrap.animate(
        [
          { opacity: 0, transform: `translateX(${dx}px)` },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 180, easing: EASE_IN_OUT },
      );
    })
    .catch(() => {});
}

function paintUseGrid() {
  const grid = useGrid();
  const monthsEl = useMonths();
  if (!grid || !monthsEl) return;
  const wrap = useGridWrap();
  if (wrap) {
    const view =
      useView === "weekly" ? "weekly" : useView === "cumulative" ? "cumulative" : "daily";
    wrap.setAttribute("role", "img");
    wrap.setAttribute(
      "aria-label",
      `Token activity, last year, ${view} view. Darker cells used more tokens. Hover a day for the count.`,
    );
  }
  const enter = !useGridEntered;
  grid.classList.toggle("is-enter", enter);
  if (enter) useGridEntered = true;
  grid.replaceChildren();
  monthsEl.replaceChildren();
  const today = localToday();
  const map = new Map<string, number>();
  for (const row of useDaily) {
    if (row.tokens > 0) map.set(row.day, row.tokens);
  }
  const now = new Date();
  const dow = now.getDay();
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  const first = new Date(weekStart);
  first.setDate(first.getDate() - 52 * 7);
  type Cell = {
    date: string;
    daily: number;
    weekly: number;
    cum: number;
    future: boolean;
  };
  const weeks: Cell[][] = [];
  let run = 0;
  for (let w = 0; w < 53; w++) {
    let weekSum = 0;
    const dates: string[] = [];
    for (let r = 0; r < 7; r++) {
      const cellDay = new Date(first);
      cellDay.setDate(first.getDate() + w * 7 + r);
      const date = `${cellDay.getFullYear()}-${String(cellDay.getMonth() + 1).padStart(2, "0")}-${String(cellDay.getDate()).padStart(2, "0")}`;
      dates.push(date);
      if (date <= today) weekSum += map.get(date) ?? 0;
    }
    const col: Cell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = dates[r];
      const future = date > today;
      const daily = future ? 0 : (map.get(date) ?? 0);
      if (!future) run += daily;
      col.push({
        date,
        daily,
        weekly: future ? 0 : weekSum,
        cum: future ? 0 : run,
        future,
      });
    }
    weeks.push(col);
  }
  const vals: number[] = [];
  for (const col of weeks) {
    for (const c of col) {
      if (c.future) continue;
      const v =
        useView === "weekly" ? c.weekly : useView === "cumulative" ? c.cum : c.daily;
      if (v > 0) vals.push(v);
    }
  }
  const max = Math.max(1, ...vals);
  let filled = 0;
  for (const col of weeks) {
    const week = document.createElement("div");
    week.className = "use-week";
    for (const c of col) {
      const cell = document.createElement("span");
      cell.className = "use-cell";
      if (c.future) {
        cell.classList.add("is-future");
      } else {
        const v =
          useView === "weekly" ? c.weekly : useView === "cumulative" ? c.cum : c.daily;
        const level =
          v <= 0 ? 0 : v <= max * 0.25 ? 1 : v <= max * 0.5 ? 2 : v <= max * 0.75 ? 3 : 4;
        if (level > 0) {
          cell.dataset.l = String(level);
          cell.style.setProperty("--i", String(Math.min(filled, 20)));
          filled += 1;
        }
        cell.title = `${c.date} - ${formatTokenCount(v)}`;
      }
      week.appendChild(cell);
    }
    grid.appendChild(week);
  }
  let lastM = "";
  const months: { w: number; m: string }[] = [];
  for (let w = 0; w < 53; w++) {
    const weekDay = new Date(first);
    weekDay.setDate(first.getDate() + w * 7);
    const m = weekDay.toLocaleString("en", { month: "short" });
    if (m !== lastM) {
      months.push({ w, m });
      lastM = m;
    }
  }
  for (let i = 0; i < months.length; i++) {
    const { w, m } = months[i];
    const lab = document.createElement("span");
    lab.className = "use-month";
    lab.textContent = m;
    if (i === months.length - 1) {
      lab.classList.add("is-end");
    } else {
      lab.style.left = `calc(${w} * (100% + var(--use-gap)) / 53)`;
    }
    monthsEl.appendChild(lab);
  }
}

async function loadSettingsPage() {
  paintAppearanceControls();
  requestAnimationFrame(layoutSegThumbs);
  renderArchiveList();
  void paintAbout();
  if (lastUseStats) paintUseStats(lastUseStats);
  else {
    paintUseViewTabs();
    paintUseGrid();
  }
  const status = useStatsStatus();
  if (status) {
    status.hidden = true;
    status.textContent = "";
  }
  if (lastUseStats && !useStatsDirty) return;
  if (status && !lastUseStats) {
    status.hidden = false;
    status.textContent = "Loading usage";
  }
  try {
    const stats = await invoke<UsageStats>("load_usage_stats");
    if (mainPage !== "settings") return;
    if (status) {
      status.hidden = true;
      status.textContent = "";
    }
    lastUseStats = stats;
    useStatsDirty = false;
    paintUseStats(stats);
  } catch (e) {
    if (mainPage !== "settings") return;
    if (!lastUseStats) {
      paintUseDash("—");
      useDaily = [];
      paintUseGrid();
    }
    if (!status) return;
    status.hidden = false;
    status.textContent = e instanceof Error ? e.message : String(e);
  }
}

function projectPickerPaths(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...pinnedProjectPaths(), ...prefs.recent]) {
    if (!p || isRecentsCwd(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function isNewProjectMenuOpen(): boolean {
  return newProjectMenu()?.hidden === false;
}

function trayProjectCwd(): string {
  const chat = activeChat();
  if (chat && isCenteredComposer(chat) && !chat.sessionId) return chat.cwd || "";
  return chat?.cwd || prefs.activeCwd || "";
}

function placeNewProjectMenu() {
  const menu = newProjectMenu();
  const chip = newProjectChip();
  if (!menu || menu.hidden || !chip) return;
  const r = chip.getBoundingClientRect();
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
  menu.style.top = "auto";
}

function closeNewProjectMenu() {
  const menu = newProjectMenu();
  const chip = newProjectChip();
  const q = newProjectQ();
  if (menu) menu.hidden = true;
  chip?.setAttribute("aria-expanded", "false");
  if (q) q.value = "";
  if (!isPluginPickerOpen()) newProjectBar()?.classList.remove("is-picking");
}

function isPluginPickerOpen(): boolean {
  return pluginPicker()?.hidden === false;
}

function placePluginPicker() {
  const picker = pluginPicker();
  const bar = newProjectBar();
  if (!picker || picker.hidden || !bar) return;
  const r = bar.getBoundingClientRect();
  picker.style.left = `${Math.round(r.left + r.width / 2 - 130)}px`;
  picker.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
  picker.style.top = "auto";
}

function closePluginPicker() {
  const picker = pluginPicker();
  const btn = newProjectPlugins();
  if (picker) picker.hidden = true;
  btn?.setAttribute("aria-expanded", "false");
  newProjectBar()?.classList.remove("is-picking");
  pluginPickerIndex = 0;
}

function closeNewChatMenus() {
  closeNewProjectMenu();
  closePluginPicker();
}

type PluginChoice = { label: string; name: string };

let pluginPickerIndex = 0;
let pluginPickerChoices: PluginChoice[] = [];

function trayPluginChoices(rows: McpRow[]): PluginChoice[] {
  const seen = new Set<string>();
  const out: PluginChoice[] = [];
  const sorted = [...rows].sort((a, b) => {
    const g = mcpFamily(a.name).label.localeCompare(
      mcpFamily(b.name).label,
      undefined,
      { sensitivity: "base" },
    );
    if (g !== 0) return g;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const row of sorted) {
    const label = mcpFamily(row.name).label;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, name: row.name });
  }
  return out;
}

function paintPluginPicker(rows: McpRow[]) {
  const list = pluginPickerList();
  if (!list) return;
  const choices = trayPluginChoices(rows);
  pluginPickerChoices = choices;
  if (pluginPickerIndex >= choices.length) pluginPickerIndex = 0;
  list.replaceChildren();
  if (!choices.length) {
    const empty = document.createElement("li");
    empty.className = "plugin-picker-empty";
    empty.textContent = "No plugins";
    list.appendChild(empty);
    return;
  }
  choices.forEach((choice, i) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plugin-picker-item" + (i === pluginPickerIndex ? " is-on" : "");
    const mark = document.createElement("span");
    mark.className = "plugin-picker-mark";
    mark.setAttribute("aria-hidden", "true");
    paintMcpMark(mark, choice.name);
    const name = document.createElement("span");
    name.className = "plugin-picker-name";
    name.textContent = choice.label;
    btn.append(mark, name);
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pluginPickerIndex = i;
      insertPluginChip(choice);
    });
    li.appendChild(btn);
    list.appendChild(li);
  });
  list.querySelectorAll(".plugin-picker-item")[pluginPickerIndex]?.scrollIntoView({
    block: "nearest",
  });
}

function insertPluginChip(choice: PluginChoice) {
  const field = input();
  if (!field) return;
  const raw = choice.label;
  pluginChipMeta.set(raw, choice);
  lockedMarks.add(raw);
  const text = composerText(field);
  let pos = composerCaret(field);
  if (text.includes(raw)) {
    setComposerText(text, pos);
  } else {
    const before = text.slice(0, pos);
    const after = text.slice(pos);
    const padBefore = before && !/\s$/.test(before) ? " " : "";
    const padAfter = after.startsWith(" ") ? "" : " ";
    const insert = padBefore + raw + padAfter;
    pos = before.length + padBefore.length + raw.length + padAfter.length;
    setComposerText(before + insert + after, pos);
  }
  applySendChrome();
  const chat = activeChat();
  if (chat) {
    chat.draft = composerText(field);
    chat.lockedMarks = [...lockedMarks];
    chat.pluginMarks = Object.fromEntries(pluginChipMeta);
  }
  closePluginPicker();
  field.focus();
  setComposerCaret(field, pos);
}

async function openPluginPicker() {
  closeNewProjectMenu();
  const picker = pluginPicker();
  const btn = newProjectPlugins();
  if (!picker || !btn) return;
  const cwd = activeChat()?.cwd || prefs.activeCwd || "";
  const rows = await ensureTrayMcp(cwd);
  if ((activeChat()?.cwd || prefs.activeCwd || "") !== cwd) return;
  pluginPickerIndex = 0;
  paintPluginPicker(rows);
  picker.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  newProjectBar()?.classList.add("is-picking");
  placePluginPicker();
  picker.focus();
}

function togglePluginPicker() {
  if (isPluginPickerOpen()) closePluginPicker();
  else void openPluginPicker();
}

function movePluginPicker(delta: number) {
  if (!pluginPickerChoices.length) return;
  pluginPickerIndex =
    (pluginPickerIndex + delta + pluginPickerChoices.length) %
    pluginPickerChoices.length;
  const items = pluginPickerList()?.querySelectorAll(".plugin-picker-item");
  items?.forEach((el, i) => el.classList.toggle("is-on", i === pluginPickerIndex));
  items?.[pluginPickerIndex]?.scrollIntoView({ block: "nearest" });
}

function onPluginPickerKey(e: KeyboardEvent): boolean {
  if (!isPluginPickerOpen()) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    closePluginPicker();
    input()?.focus();
    return true;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    movePluginPicker(1);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    movePluginPicker(-1);
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const choice = pluginPickerChoices[pluginPickerIndex];
    if (choice) insertPluginChip(choice);
    return true;
  }
  return false;
}

let trayMcp: McpRow[] | null = null;
let trayMcpCwd = "";

async function ensureTrayMcp(cwd: string): Promise<McpRow[]> {
  if (trayMcp && trayMcpCwd === cwd) return trayMcp;
  try {
    const snap = await invoke<PluginsSnapshot>("load_plugins_snapshot", {
      cwd: cwd || "",
    });
    trayMcp = Array.isArray(snap.mcp) ? snap.mcp.filter((r) => r.enabled) : [];
  } catch {
    trayMcp = [];
  }
  trayMcpCwd = cwd;
  return trayMcp;
}

function paintTrayPlugins(rows: McpRow[]) {
  const host = newProjectPluginMarks();
  if (!host) return;
  host.replaceChildren();
  const marks = rows.filter((r) => mcpFamily(r.name).icon).slice(0, 3);
  for (const row of marks) {
    const el = document.createElement("span");
    el.className = "new-project-plugin-mark";
    paintMcpMark(el, row.name, row.url || "");
    host.appendChild(el);
  }
}

function paintNewProjectBar() {
  const bar = newProjectBar();
  const chip = newProjectChip();
  const name = newProjectName();
  const ico = chip?.querySelector(".new-project-ico");
  if (!bar || !chip || !name) return;
  const show = !pageCovered() && isCenteredComposer(activeChat());
  if (show) {
    bar.classList.remove("is-leaving");
    bar.getAnimations().forEach((a) => a.cancel());
    bar.style.removeProperty("opacity");
  }
  if (!show && bar.classList.contains("is-leaving")) return;
  bar.hidden = !show;
  if (!show) {
    closeNewChatMenus();
    return;
  }
  const cwd = trayProjectCwd();
  name.textContent = cwd ? projectLabel(cwd) : "Recents";
  if (ico) ico.replaceChildren(iconEl(Ico.folder, { size: 16 }));
  void ensureTrayMcp(cwd).then((rows) => {
    if (trayProjectCwd() !== cwd) return;
    paintTrayPlugins(rows);
  });
}

function paintNewProjectMenu() {
  const list = newProjectList();
  if (!list) return;
  const cwd = trayProjectCwd();
  const needle = (newProjectQ()?.value ?? "").trim().toLowerCase();
  list.replaceChildren();
  const paths = projectPickerPaths().filter((path) => {
    if (!needle) return true;
    return projectLabel(path).toLowerCase().includes(needle);
  });
  if (!paths.length) {
    const empty = document.createElement("li");
    empty.className = "new-project-empty";
    empty.textContent = needle ? "No matching projects" : "No projects";
    list.appendChild(empty);
    return;
  }
  for (const path of paths) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "new-project-item" + (path === cwd ? " is-on" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", path === cwd ? "true" : "false");
    const ico = document.createElement("span");
    ico.className = "new-project-ico";
    ico.setAttribute("aria-hidden", "true");
    ico.appendChild(iconEl(Ico.folder, { size: 16 }));
    const lab = document.createElement("span");
    lab.className = "new-project-item-name";
    lab.textContent = projectLabel(path);
    btn.append(ico, lab);
    if (path === cwd) {
      const mark = document.createElement("span");
      mark.className = "new-project-check";
      mark.setAttribute("aria-hidden", "true");
      mark.appendChild(iconEl(Ico.check, { size: 16 }));
      btn.appendChild(mark);
    }
    btn.addEventListener("click", () => {
      closeNewProjectMenu();
      void bindEmptyChatProject(path);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function bindEmptyChatProject(path: string) {
  prefs.activeCwd = path;
  rememberFolder(path);
  savePrefs();
  const chat = activeChat();
  if (chat && isCenteredComposer(chat) && !chat.sessionId) {
    chat.cwd = path;
  } else if (!chat) {
    focusChat(makeChat(path, { forceNew: true, title: "New chat" }));
  }
  updatePlaceholder();
  trayMcp = null;
  await refreshSessionsFor(path, { paint: false });
  renderProjects();
  paintNewProjectBar();
}

async function pickFolderForNewChat() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open project folder",
  });
  if (selected === null) return;
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (path) await bindEmptyChatProject(path);
}

async function unbindEmptyChatProject() {
  const path = await ensureRecentsCwd();
  const chat = activeChat();
  if (chat && isCenteredComposer(chat) && !chat.sessionId) {
    chat.cwd = path;
  } else if (!chat) {
    focusChat(makeChat(path, { forceNew: true, title: "New chat" }));
  }
  prefs.activeCwd = path;
  savePrefs();
  updatePlaceholder();
  trayMcp = null;
  await refreshSessionsFor(path, { paint: false });
  renderProjects();
  paintNewProjectBar();
}

function toggleNewProjectMenu() {
  const menu = newProjectMenu();
  const chip = newProjectChip();
  if (!menu || !chip) return;
  closePluginPicker();
  if (isNewProjectMenuOpen()) {
    closeNewProjectMenu();
    return;
  }
  paintNewProjectMenu();
  menu.hidden = false;
  chip.setAttribute("aria-expanded", "true");
  newProjectBar()?.classList.add("is-picking");
  placeNewProjectMenu();
  newProjectQ()?.focus();
}

function updatePlaceholder() {
  const field = input();
  if (field) {
    const cwd = trayProjectCwd() || prefs.activeCwd || "";
    field.dataset.placeholder =
      cwd && !isRecentsCwd(cwd)
        ? `Message Grok in ${folderName(cwd)}…`
        : "Message Grok…";
  }
  const sideField = sideInput();
  if (sideField) {
    const sideCwd = prefs.activeCwd || "";
    const sub = frontAgent();
    if (sub?.subLabel) {
      sideField.placeholder = `Message ${sub.subLabel}…`;
      sideField.setAttribute("aria-label", `Message ${sub.subLabel}`);
    } else {
      sideField.placeholder =
        sideCwd && !isRecentsCwd(sideCwd)
          ? `Message side chat in ${folderName(sideCwd)}…`
          : "Message side chat…";
      sideField.setAttribute("aria-label", "Message side chat");
    }
  }
}

function clearTranscriptDom(host?: HTMLElement | null) {
  const t = host ?? transcript();
  if (!t) return;
  if (t.id === "side-transcript") {
    t.querySelectorAll(".msg-row").forEach((el) => el.remove());
    return;
  }
  t.replaceChildren();
}

/** Place a card after the current live row (and any open cards). */
function placeCardRow(chat: ChatRuntime, row: HTMLElement) {
  const t = transcript();
  if (!t) return;
  const live = chat.liveRow;
  if (!live?.isConnected) {
    t.appendChild(row);
    return;
  }
  let anchor: Node = live;
  let next = live.nextSibling;
  while (next instanceof HTMLElement && next.dataset.cardId) {
    anchor = next;
    next = next.nextSibling;
  }
  if (anchor.nextSibling) t.insertBefore(row, anchor.nextSibling);
  else t.appendChild(row);
  fillLiveTurn(chat);
}

function formatMsgTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function coerceTimeMs(at?: number): number | null {
  const n = typeof at === "number" ? at : Number(at);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function makeTimeEl(at?: number): HTMLElement | null {
  const n = coerceTimeMs(at);
  if (n == null) return null;
  const el = document.createElement("span");
  el.className = "msg-time";
  el.textContent = formatMsgTime(n);
  el.title = new Date(n).toLocaleString();
  return el;
}

function makeCopyBtn(markdown: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-copy";
  btn.title = "Copy";
  btn.setAttribute("aria-label", "Copy answer");
  btn.dataset.copyLabel = "Copy answer";
  btn.dataset.markdown = markdown;
  btn.appendChild(iconEl(Ico.copy, { size: 16 }));
  return btn;
}

function makeAnswerMeta(opts: { at?: number; markdown?: string }): HTMLElement | null {
  const md = (opts.markdown ?? "").trim();
  if (!md) return null;
  // Chat JSONL has no turn time; rewind can miss.
  const time = makeTimeEl(opts.at) ?? makeTimeEl(Date.now());
  const wrap = document.createElement("div");
  wrap.className = "msg-answer-meta";
  if (time) wrap.appendChild(time);
  wrap.appendChild(makeCopyBtn(md));
  return wrap;
}

function stampAnswerMeta(
  host: HTMLElement | null,
  opts: { at?: number; markdown?: string },
) {
  if (!host) return;
  host.querySelector(":scope > .msg-answer-meta")?.remove();
  const meta = makeAnswerMeta(opts);
  if (meta) host.appendChild(meta);
}

function markLastAssistant(root: HTMLElement | null) {
  if (!root) return;
  const prev = root.querySelector<HTMLElement>(".msg-row.assistant.is-last-answer");
  const rows = root.querySelectorAll<HTMLElement>(".msg-row.assistant");
  const last = rows[rows.length - 1] ?? null;
  if (prev === last) return;
  prev?.classList.remove("is-last-answer");
  last?.classList.add("is-last-answer");
}

function answerMetaHost(stream: HTMLElement | null, fallback?: HTMLElement | null) {
  return stream ?? fallback ?? null;
}

async function copyAnswerMarkdown(btn: HTMLButtonElement) {
  const text = btn.dataset.markdown ?? "";
  if (!text) return;
  const label = btn.dataset.copyLabel || "Copy";
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add("is-copied");
    btn.title = "Copied";
    btn.setAttribute("aria-label", "Copied");
    btn.replaceChildren(iconEl(Ico.check, { size: 16 }));
    window.setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.replaceChildren(iconEl(Ico.copy, { size: 16 }));
    }, 1400);
  } catch {
    btn.title = "Copy failed";
    window.setTimeout(() => {
      btn.title = label;
    }, 1400);
  }
}

/** Machine spawn prompt. Sub tabs show it as plain prose, no tag soup. */
function isSpawnPrompt(text: string): boolean {
  return (
    /<[a-zA-Z][\w-]*(json|contract)>/i.test(text) ||
    /"questions"\s*:\s*\[/.test(text)
  );
}

/** Claim objects read as a plain numbered list. Anything else stays out. */
function claimsListOf(items: unknown[]): string | null {
  const lines = items
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        const claim = (c as Record<string, unknown>).claim;
        if (typeof claim === "string" && claim.trim()) return claim;
      }
      return "";
    })
    .filter((l) => l.trim());
  if (!lines.length) return null;
  return lines.map((l, i) => `${i + 1}. ${l}`).join("\n\n");
}

function machineJsonListOf(text: string): string | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (Array.isArray(v)) return claimsListOf(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.questions)) return claimsListOf(o.questions);
    for (const key of ["claims", "candidate_claims", "items"]) {
      if (Array.isArray(o[key])) return claimsListOf(o[key] as unknown[]);
    }
  }
  return null;
}

function unwrapQuoted(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const v = JSON.parse(t) as unknown;
      if (typeof v === "string") return v;
    } catch {
      /* fall through */
    }
    return t.slice(1, -1);
  }
  return t;
}

/** Envelope tags go away. Contracts drop. Payloads read as prose or lists. */
function formatSpawnPrompt(text: string): string {
  const list = machineJsonListOf(text.trim());
  if (list) return list;
  const s = text.replace(/<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g, (m, tag, inner) => {
    const k = String(tag).toLowerCase();
    if (k.includes("contract")) return "";
    if (k.includes("question") || k.includes("query") || k.includes("claim")) {
      return machineJsonListOf(inner.trim()) ?? unwrapQuoted(inner);
    }
    return m;
  });
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/** Contract evidence fence. Sub tabs keep the prose and drop the dump. */
function stripEvidenceFences(text: string): string {
  const out = text.replace(/```(?:json)?[^\n]*\n([\s\S]*?)```/g, (m, inner) =>
    /"claims"|"source_locator"|"questions"\s*:\s*\[/.test(inner as string) ? "" : m,
  );
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function appendUserDom(
  text: string,
  at?: number,
  attachments?: Attachment[],
  host?: HTMLElement | null,
) {  const t = host ?? transcript();
  if (!t) return;
  const row = document.createElement("div");
  row.className = "msg-row user";
  const stack = document.createElement("div");
  stack.className = "user-stack";
  if (attachments?.length) {
    stack.appendChild(renderAttachStrip(attachments, false));
  }
  if (text) {
    const line = document.createElement("div");
    line.className = "user-bubble-row";
    const bubble = document.createElement("div");
    bubble.className = "user-bubble";
    paintUserText(bubble, text);
    bubble.dataset.userText = "1";
    line.appendChild(bubble);
    stack.appendChild(line);
  }
  const meta = document.createElement("div");
  meta.className = "user-meta";
  const hint = document.createElement("span");
  hint.className = "user-edit-hint";
  hint.textContent = "Double-click to edit";
  meta.appendChild(hint);
  const time = makeTimeEl(at) ?? makeTimeEl(Date.now());
  if (time) meta.appendChild(time);
  stack.appendChild(meta);
  row.appendChild(stack);
  t.appendChild(row);
  refreshUserEditChrome();
  // Rebuild paints ticks once after every user row exists.
  if (!ignoreTranscriptScroll) paintPromptJumps(activeChat());
}

type JumpMark = { prompt: string; answer: string };

let jumpMarks: JumpMark[] = [];
let jumpEqHover: number | null = null;
let jumpCur = -1;
let jumpCurRaf = 0;
let jumpCard: HTMLElement | null = null;

function foldJumpUrls(s: string): string {
  URL_RE.lastIndex = 0;
  const without = s.replace(URL_RE, " ").replace(/\s+/g, " ").trim();
  if (without) return without;
  URL_RE.lastIndex = 0;
  const urls = s.match(URL_RE);
  if (!urls) return s;
  return urls.map(hostnameOf).join(" ");
}

function clipJumpText(s: string, n = 72): string {
  const t = foldJumpUrls(s).replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function clipPartsText(parts: AssistantPart[], n = 72): string {
  let s = "";
  for (const p of parts) {
    if (p.kind !== "text" || !p.text) continue;
    s = s ? `${s} ${p.text}` : p.text;
    const t = s.replace(/\s+/g, " ").trim();
    if (t.length >= n) return `${t.slice(0, n - 1)}…`;
  }
  return s.replace(/\s+/g, " ").trim();
}

function userJumpMarks(chat: ChatRuntime): JumpMark[] {
  const out: JumpMark[] = [];
  for (let i = 0; i < chat.lines.length; i++) {
    const line = chat.lines[i];
    if (line.kind !== "user") continue;
    const prompt =
      line.text.trim() || line.attachments?.[0]?.name || "";
    let answer = "";
    for (let j = i + 1; j < chat.lines.length; j++) {
      const next = chat.lines[j];
      if (next.kind === "user") break;
      if (next.kind === "assistant") {
        answer = clipPartsText(next.parts);
        break;
      }
    }
    out.push({ prompt, answer });
  }
  return out;
}

function hidePromptJumpCard() {
  if (jumpCard) jumpCard.hidden = true;
}

function showPromptJumpCard(tick: HTMLElement, prompt: string, answer: string) {
  const nav = promptJumps();
  if (!nav) return;
  if (!jumpCard || jumpCard.parentElement !== nav) {
    jumpCard = document.createElement("div");
    jumpCard.className = "prompt-jump-card";
    const q = document.createElement("p");
    q.className = "prompt-jump-q";
    const a = document.createElement("p");
    a.className = "prompt-jump-a";
    jumpCard.append(q, a);
    nav.appendChild(jumpCard);
  }
  const q = jumpCard.querySelector(".prompt-jump-q");
  const a = jumpCard.querySelector(".prompt-jump-a");
  if (q) q.textContent = clipJumpText(prompt) || "Prompt";
  const clip = clipJumpText(answer);
  if (a instanceof HTMLElement) {
    a.textContent = clip;
    a.hidden = !clip;
  }
  jumpCard.hidden = false;
  const navBox = nav.getBoundingClientRect();
  const tickBox = tick.getBoundingClientRect();
  let top = tickBox.top - navBox.top - 8;
  const h = jumpCard.getBoundingClientRect().height;
  top = Math.max(0, Math.min(top, navBox.height - h));
  jumpCard.style.top = `${Math.round(top)}px`;
}

function syncPromptJumpCurrent() {
  if (jumpCurRaf) return;
  jumpCurRaf = requestAnimationFrame(() => {
    jumpCurRaf = 0;
    syncPromptJumpCurrentNow();
  });
}

function syncPromptJumpCurrentNow() {
  const nav = promptJumps();
  const t = transcript();
  if (!nav || nav.hidden || !t) return;
  const ticks = nav.querySelectorAll<HTMLElement>(".prompt-jump");
  const rows = t.querySelectorAll<HTMLElement>(".msg-row.user");
  if (!ticks.length || !rows.length) return;
  const line = t.getBoundingClientRect().top + 56;
  const n = rows.length;
  let cur = Math.min(Math.max(jumpCur, 0), n - 1);
  while (cur + 1 < n && rows[cur + 1].getBoundingClientRect().top <= line + 24) {
    cur += 1;
  }
  while (cur > 0 && rows[cur].getBoundingClientRect().top > line + 24) {
    cur -= 1;
  }
  if (cur === jumpCur) return;
  jumpCur = cur;
  ticks.forEach((tick, i) => {
    tick.classList.toggle("is-on", i === cur);
  });
}

function jumpToUserRow(row: HTMLElement) {
  const t = transcript();
  const chat = activeChat();
  if (!t || !chat) return;
  chat.scrollPinned = false;
  const titleH =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--titlebar-h"),
    ) || 52;
  const delta =
    row.getBoundingClientRect().top - t.getBoundingClientRect().top - titleH - 8;
  t.scrollTop += delta;
  syncJumpLatest();
  syncPromptJumpCurrent();
}

function clearPromptJumpFit(nav: HTMLElement) {
  nav.style.removeProperty("gap");
  nav.style.removeProperty("--jump-tick-h");
  nav.style.removeProperty("--jump-hair");
}

function fitPromptJumpGap(nav: HTMLElement, count: number) {
  if (count < 2) {
    clearPromptJumpFit(nav);
    return;
  }
  const avail = nav.clientHeight;
  if (avail <= 0) {
    if (nav.hidden) return;
    requestAnimationFrame(() => {
      if (nav.isConnected && !nav.hidden) fitPromptJumpGap(nav, count);
    });
    return;
  }
  const tickMax = 12;
  const tickMin = 2;
  const gapMax = 3;
  const gapMin = 1;
  const need = (h: number, g: number) => count * h + (count - 1) * g;
  let gap = gapMax;
  let tickH = tickMax;
  if (need(tickH, gap) > avail) gap = gapMin;
  if (need(tickH, gap) > avail) {
    tickH = Math.max(
      tickMin,
      Math.floor((avail - (count - 1) * gap) / count),
    );
  }
  if (need(tickH, gap) > avail) {
    gap = 0;
    tickH = Math.max(1, Math.floor(avail / count));
  }
  nav.style.gap = `${gap}px`;
  nav.style.setProperty("--jump-tick-h", `${tickH}px`);
  nav.style.setProperty("--jump-hair", tickH < 4 ? "1px" : "2px");
}

function sameJumpPrompts(a: JumpMark[], b: JumpMark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].prompt !== b[i].prompt) return false;
  }
  return true;
}

function refreshLastJumpAnswer(chat: ChatRuntime) {
  if (jumpMarks.length < 2 || pageOpen() || isCenteredComposer(chat)) {
    paintPromptJumps(chat);
    return;
  }
  const last = lastAssistantLine(chat);
  if (last) jumpMarks[jumpMarks.length - 1].answer = clipPartsText(last.parts);
}

function paintPromptJumps(chat: ChatRuntime | null = activeChat()) {
  const nav = promptJumps();
  if (!nav) return;
  const marks =
    chat && !pageOpen() && !isCenteredComposer(chat) ? userJumpMarks(chat) : [];
  if (marks.length < 2) {
    jumpMarks = [];
    jumpEqHover = null;
    jumpCur = -1;
    jumpCard = null;
    nav.hidden = true;
    nav.replaceChildren();
    clearPromptJumpFit(nav);
    return;
  }
  if (sameJumpPrompts(jumpMarks, marks)) {
    marks.forEach((m, i) => {
      jumpMarks[i].answer = m.answer;
    });
    nav.hidden = false;
    fitPromptJumpGap(nav, marks.length);
    syncPromptJumpCurrent();
    return;
  }
  jumpMarks = marks;
  jumpEqHover = null;
  jumpCur = -1;
  nav.hidden = false;
  nav.replaceChildren();
  jumpCard = null;
  marks.forEach((mark, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prompt-jump";
    btn.dataset.i = String(i);
    btn.setAttribute("aria-label", clipJumpText(mark.prompt, 48) || `Prompt ${i + 1}`);
    btn.addEventListener("click", () => {
      const row = transcript()?.querySelectorAll<HTMLElement>(".msg-row.user")[i];
      if (row) jumpToUserRow(row);
    });
    btn.addEventListener("pointerenter", () => {
      showPromptJumpCard(btn, jumpMarks[i]?.prompt ?? mark.prompt, jumpMarks[i]?.answer ?? mark.answer);
    });
    nav.appendChild(btn);
  });
  fitPromptJumpGap(nav, marks.length);
  syncPromptJumpCurrent();
}

function lastUserLineIndex(chat: ChatRuntime): number {
  for (let i = chat.lines.length - 1; i >= 0; i--) {
    if (chat.lines[i].kind === "user") return i;
  }
  return -1;
}

function lastUserBubbleEl(): HTMLElement | null {
  const t = transcript();
  return t ? lastUserBubbleIn(t) : null;
}

function lastUserBubbleIn(t: HTMLElement): HTMLElement | null {
  const rows = t.querySelectorAll<HTMLElement>(".msg-row.user");
  const row = rows[rows.length - 1];
  return row?.querySelector<HTMLElement>(".user-bubble") ?? null;
}

function refreshEditChrome(chat: ChatRuntime | null, t: HTMLElement | null) {
  if (!t) return;
  t.querySelectorAll<HTMLElement>(".user-bubble").forEach((b) => {
    b.classList.remove("can-edit");
    b.title = "";
    b.removeAttribute("data-edit-hint");
  });
  if (!chat || chat.runInFlight) return;
  if (lastUserLineIndex(chat) < 0) return;
  const bubble = lastUserBubbleIn(t);
  if (!bubble || bubble.isContentEditable) return;
  bubble.classList.add("can-edit");
  bubble.title = "Double-click to edit and replace this turn";
  bubble.dataset.editHint = "1";
}

function refreshUserEditChrome() {
  refreshEditChrome(activeChat(), transcript());
}

function renderWaitingOn(
  chat: ChatRuntime | null,
  block: HTMLElement | null,
  list: HTMLUListElement | null,
  side: boolean,
) {
  hideWaitingMenu();
  if (!block || !list) return;
  const items = chat?.waiting ?? [];
  if (!chat || items.length === 0) {
    hideEl(block, true);
    list.replaceChildren();
    return;
  }
  const wasHidden = block.hidden;
  hideEl(block, false);
  paintWaitingRows(list, chat, side);
  if (wasHidden && motionOk()) {
    block.animate(
      [
        { opacity: 0, transform: "scale(0.98)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 150, easing: EASE_OUT },
    );
  }
}

function renderWaiting(chat: ChatRuntime | null = activeChat()) {
  renderWaitingOn(chat, waitingBlock(), waitingList(), false);
}

function paintWaitingRows(list: HTMLElement, chat: ChatRuntime, side: boolean) {
  list.classList.remove("is-overflow");
  list.replaceChildren();
  for (const item of chat.waiting) {
    list.appendChild(makeWaitingRow(chat, item, side));
  }
  list.classList.toggle("is-overflow", list.scrollHeight > 160);
}

function makeWaitingRow(
  chat: ChatRuntime,
  item: WaitingItem,
  side: boolean,
): HTMLElement {
  const li = document.createElement("li");
  li.className = "waiting-item";
  li.dataset.id = item.id;

  const slot = document.createElement("span");
  slot.className = "waiting-slot";

  const handle = document.createElement("span");
  handle.className = "waiting-handle";
  handle.setAttribute("aria-hidden", "true");
  handle.appendChild(iconEl(Ico.grip, { size: 16 }));

  const mark = document.createElement("span");
  mark.className = "waiting-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.appendChild(iconEl(Ico.steer, { size: 16 }));
  slot.append(mark, handle);

  const text = document.createElement("div");
  text.className = "waiting-text";
  const waitLabel = item.text.trim() || attachLabel(item.attachments);
  text.textContent = waitLabel;
  text.title = waitLabel;

  const actions = document.createElement("div");
  actions.className = "waiting-actions";

  const steer = document.createElement("button");
  steer.type = "button";
  steer.className = "waiting-steer";
  steer.title = "Stop live turn and send this next";
  steer.append(iconEl(Ico.steer, { size: 16 }), "Steer");
  steer.addEventListener("click", () => {
    if (side) {
      chat.waiting = chat.waiting.filter((w) => w.id !== item.id);
      persistWaiting(chat);
      renderSideWaiting(chat);
      void runSidePrompt(item.text, {
        chat,
        displayText: item.text,
        attachments: item.attachments,
      });
      return;
    }
    void steerWaitingItem(chat, item.id);
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "waiting-ico";
  remove.title = "Remove";
  remove.setAttribute("aria-label", "Remove");
  remove.appendChild(iconEl(Ico.trash, { size: 16 }));
  remove.addEventListener("click", () => {
    chat.waiting = chat.waiting.filter((w) => w.id !== item.id);
    if (side) renderSideWaiting(chat);
    else {
      persistWaiting(chat);
      renderWaiting(chat);
    }
  });

  const more = document.createElement("button");
  more.type = "button";
  more.className = "waiting-ico";
  more.title = "More";
  more.setAttribute("aria-label", "More");
  more.appendChild(iconEl(Ico.more, { size: 16 }));
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    showWaitingMenu(more, chat, item.id, text, side);
  });

  actions.append(steer, remove, more);
  li.append(slot, text, actions);
  return li;
}

type WaitingMenuTarget = {
  chat: ChatRuntime;
  id: string;
  textEl: HTMLElement;
  side: boolean;
};

let waitingMenuAt: WaitingMenuTarget | null = null;

function hideWaitingMenu() {
  const menu = waitingCtxMenu();
  if (menu) menu.hidden = true;
  waitingMenuAt = null;
}

function paintWaitingMenuItems(side: boolean) {
  const menu = waitingCtxMenu();
  if (!menu) return;
  const edit = menu.querySelector<HTMLButtonElement>("[data-action=edit]");
  const openSide = menu.querySelector<HTMLButtonElement>("[data-action=side]");
  if (edit) {
    edit.replaceChildren(iconEl(Ico.pencil, { size: 16 }), "Edit");
  }
  if (openSide) {
    openSide.hidden = side;
    openSide.replaceChildren(iconEl(Ico.addSide, { size: 16 }), "Open in side chat");
  }
}

function showWaitingMenu(
  anchor: HTMLElement,
  chat: ChatRuntime,
  id: string,
  textEl: HTMLElement,
  side: boolean,
) {
  hideChatContextMenu();
  hideMcpContextMenu();
  const menu = waitingCtxMenu();
  if (!menu) return;
  if (waitingMenuAt?.id === id && !menu.hidden) {
    hideWaitingMenu();
    return;
  }
  waitingMenuAt = { chat, id, textEl, side };
  paintWaitingMenuItems(side);
  menu.hidden = false;
  const pad = 6;
  const ar = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 72;
  let x = ar.right - mw;
  let y = ar.bottom + 4;
  if (y + mh + pad > window.innerHeight) y = ar.top - mh - 4;
  if (x < pad) x = pad;
  if (x + mw + pad > window.innerWidth) x = window.innerWidth - mw - pad;
  menu.style.left = `${x}px`;
  menu.style.top = `${Math.max(pad, y)}px`;
  setMenuOrigin(menu, ar.left + ar.width / 2, ar.top + ar.height / 2);
}

function beginEditWaiting(chat: ChatRuntime, id: string, textEl: HTMLElement) {
  if (textEl.isContentEditable) {
    finishEditWaiting(chat, id, textEl);
    return;
  }
  hideWaitingMenu();
  textEl.contentEditable = "true";
  textEl.classList.add("is-editing");
  textEl.closest(".waiting-item")?.classList.add("is-editing");
  textEl.focus();
  const range = document.createRange();
  range.selectNodeContents(textEl);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finishEditWaiting(chat, id, textEl);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const item = chat.waiting.find((w) => w.id === id);
      textEl.textContent = item?.text ?? textEl.textContent;
      finishEditWaiting(chat, id, textEl, false);
    }
  };
  textEl.addEventListener("keydown", onKey);
  (textEl as HTMLElement & { _waitingKey?: (e: KeyboardEvent) => void })._waitingKey = onKey;
  textEl.addEventListener(
    "blur",
    () => finishEditWaiting(chat, id, textEl),
    { once: true },
  );
}

function finishEditWaiting(
  chat: ChatRuntime,
  id: string,
  textEl: HTMLElement,
  save = true,
) {
  if (!textEl.isContentEditable) return;
  const keyHandler = (textEl as HTMLElement & { _waitingKey?: (e: KeyboardEvent) => void })
    ._waitingKey;
  if (keyHandler) textEl.removeEventListener("keydown", keyHandler);
  textEl.contentEditable = "false";
  textEl.classList.remove("is-editing");
  textEl.closest(".waiting-item")?.classList.remove("is-editing");
  if (!save) return;
  const next = composerText(textEl).trim();
  const item = chat.waiting.find((w) => w.id === id);
  if (!item) return;
  const side = chat.surface === "panel";
  if (!next && !(item.attachments?.length)) {
    chat.waiting = chat.waiting.filter((w) => w.id !== id);
    if (side) renderSideWaiting(chat);
    else {
      persistWaiting(chat);
      renderWaiting(chat);
    }
    return;
  }
  if (!next) {
    item.text = "";
    if (!side) persistWaiting(chat);
    textEl.textContent = attachLabel(item.attachments);
    textEl.title = attachLabel(item.attachments);
    return;
  }
  item.text = next;
  if (!side) persistWaiting(chat);
  textEl.textContent = next;
  textEl.title = next;
}

function openWaitingInSide(main: ChatRuntime, item: WaitingItem) {
  if (!canUseSideChat(main)) {
    setStatus(
      !prefs.activeCwd
        ? "Open a project folder first."
        : "Send a message in the main chat first.",
    );
    return;
  }
  main.waiting = main.waiting.filter((w) => w.id !== item.id);
  persistWaiting(main);
  renderWaiting(main);
  openSidePanel();
  const side = ensureFrontSide(main);
  panelOf(main.key).front = side.tabId ?? null;
  showPanelFor(main);
  const field = sideInput();
  const extra = item.text.trim();
  if (field && extra) {
    const cur = field.value.trim();
    field.value = cur ? `${cur}\n\n${extra}` : extra;
    side.draft = field.value;
  }
  for (const a of item.attachments ?? []) {
    if (side.attachments.length >= MAX_ATTACH) break;
    if (a.kind === "quote") {
      if (side.attachments.some((x) => x.kind === "quote" && x.quote === a.quote)) {
        continue;
      }
    }
    side.attachments.push(a);
  }
  renderSideAttachChips(side);
  applySideComposerLock(side);
  field?.focus();
}

function enqueueWaiting(
  chat: ChatRuntime,
  text: string,
  attachments: Attachment[] = [],
) {
  chat.waiting.push({ id: crypto.randomUUID(), text, attachments });
  persistWaiting(chat);
  if (chat.surface === "panel") renderSideWaiting(chat);
  else if (activeChatKey === chat.key) renderWaiting(chat);
}

let selBar: HTMLElement | null = null;
let selHeld = "";
let selTimer = 0;
let quoteChipCard: HTMLElement | null = null;

function hideSelActions() {
  selBar?.remove();
  selBar = null;
  selHeld = "";
}

function selActionsOpen(): boolean {
  return !!selBar;
}

function annotationLabel(n: number): string {
  return n === 1 ? "1 annotation" : `${n} annotations`;
}

function makeQuoteAtt(quote: string): Attachment {
  return {
    id: crypto.randomUUID(),
    name: annotationLabel(1),
    mime: "text/plain",
    kind: "quote",
    quote,
  };
}

function addSelToChat() {
  const quote = selHeld.trim();
  if (!quote) return;
  hideSelActions();
  window.getSelection()?.removeAllRanges();
  const chat = ensureAttachChat();
  if (!chat) return;
  if (!chat.attachments.some((a) => a.kind === "quote" && a.quote === quote)) {
    pushAttachment(chat, makeQuoteAtt(quote));
  }
  applySendChrome();
  input()?.focus();
}

function addSelToSideChat() {
  const quote = selHeld.trim();
  if (!quote) return;
  hideSelActions();
  window.getSelection()?.removeAllRanges();
  const main = activeChat();
  if (!main || !canUseSideChat(main)) {
    setStatus(
      !prefs.activeCwd
        ? "Open a project folder first."
        : "Send a message in the main chat first.",
    );
    return;
  }
  openSidePanel();
  const side = ensureFrontSide(main);
  panelOf(main.key).front = side.tabId ?? null;
  showPanelFor(main);
  if (!side.attachments.some((a) => a.kind === "quote" && a.quote === quote)) {
    side.attachments.push(makeQuoteAtt(quote));
  }
  renderSideAttachChips(side);
  applySideComposerLock(side);
  sideInput()?.focus();
}

function placeSelBar(rect: DOMRect) {
  if (!selBar) return;
  const top = Math.min(
    window.innerHeight - selBar.offsetHeight - 8,
    rect.bottom + 8,
  );
  const left = Math.min(
    window.innerWidth - selBar.offsetWidth - 8,
    Math.max(8, rect.left + rect.width / 2 - selBar.offsetWidth / 2),
  );
  selBar.style.top = `${Math.max(8, top)}px`;
  selBar.style.left = `${left}px`;
}

function ensureSelBar(): HTMLElement {
  if (selBar) return selBar;
  const bar = document.createElement("div");
  bar.className = "sel-actions";
  bar.setAttribute("role", "toolbar");

  const add = document.createElement("button");
  add.type = "button";
  add.className = "sel-act";
  add.append(
    iconEl(Ico.quote, { size: 16, className: "sel-act-ico" }),
    "Add to main chat",
  );
  add.addEventListener("mousedown", (e) => e.preventDefault());
  add.addEventListener("click", addSelToChat);

  const split = document.createElement("span");
  split.className = "sel-split";
  split.setAttribute("aria-hidden", "true");

  const more = document.createElement("button");
  more.type = "button";
  more.className = "sel-act";
  more.append(
    iconEl(Ico.addSide, { size: 16, className: "sel-act-ico" }),
    "Add to side chat",
  );
  more.addEventListener("mousedown", (e) => e.preventDefault());
  more.addEventListener("click", addSelToSideChat);

  bar.append(add, split, more);
  document.body.appendChild(bar);
  selBar = bar;
  return bar;
}

function transcriptAnswerBody(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement;
  const body = el?.closest<HTMLElement>(".assistant-body");
  if (!body || body.closest(".thought-block") || body.closest(".task-diff")) {
    return null;
  }
  if (!body.closest("#transcript, #side-transcript")) return null;
  return body;
}

let clampingSel = false;
let selPointerDown = false;
let selDidDrag = false;
let selDownX = 0;
let selDownY = 0;

function selDragQuoted(): boolean {
  if (!selDidDrag) return false;
  const text = window.getSelection()?.toString().trim() ?? "";
  return text.length >= 2;
}

function tableCellAt(n: Node | null): HTMLElement | null {
  const el = n instanceof Element ? n : n?.parentElement;
  return el?.closest("th, td") ?? null;
}

function textPointInCell(
  cell: HTMLElement,
  node: Node,
  offset: number,
  atStart: boolean,
): { node: Text; offset: number } | null {
  const md = cell.querySelector(":scope > .md-cell") ?? cell;
  if (md.contains(node) && node.nodeType === Node.TEXT_NODE) {
    return { node: node as Text, offset };
  }
  const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let cur: Node | null;
  while ((cur = walker.nextNode())) last = cur as Text;
  if (!last) return null;
  if (atStart) {
    const first = document.createTreeWalker(md, NodeFilter.SHOW_TEXT).nextNode() as Text | null;
    return first ? { node: first, offset: 0 } : null;
  }
  return { node: last, offset: last.data.length };
}

function clampSelToAnswer() {
  if (clampingSel) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  const body =
    transcriptAnswerBody(sel.anchorNode) ??
    transcriptAnswerBody(sel.focusNode) ??
    transcriptAnswerBody(range.startContainer);
  if (!body) return;
  const startCell = tableCellAt(range.startContainer);
  const endCell = tableCellAt(range.endContainer);
  if (startCell && endCell && body.contains(startCell) && body.contains(endCell)) {
    const start = textPointInCell(startCell, range.startContainer, range.startOffset, true);
    const end = textPointInCell(endCell, range.endContainer, range.endOffset, false);
    if (!start || !end) return;
    if (
      range.startContainer === start.node &&
      range.startOffset === start.offset &&
      range.endContainer === end.node &&
      range.endOffset === end.offset
    ) {
      return;
    }
    clampingSel = true;
    try {
      const next = document.createRange();
      next.setStart(start.node, start.offset);
      next.setEnd(end.node, end.offset);
      sel.removeAllRanges();
      sel.addRange(next);
    } finally {
      clampingSel = false;
    }
    return;
  }
  if (selPointerDown) return;
  const limit = document.createRange();
  limit.selectNodeContents(body);
  const before = range.compareBoundaryPoints(Range.START_TO_START, limit) < 0;
  const after = range.compareBoundaryPoints(Range.END_TO_END, limit) > 0;
  if (!before && !after) return;
  clampingSel = true;
  try {
    if (before) range.setStart(limit.startContainer, limit.startOffset);
    if (after) range.setEnd(limit.endContainer, limit.endOffset);
  } finally {
    clampingSel = false;
  }
}

function selEndRect(range: Range): DOMRect | null {
  const rects = range.getClientRects();
  for (let i = rects.length - 1; i >= 0; i--) {
    if (rects[i].width || rects[i].height) return rects[i];
  }
  const box = range.getBoundingClientRect();
  return box.width || box.height ? box : null;
}

function syncSelActions() {
  if (selPointerDown) return;
  if (selBar?.contains(document.activeElement)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideSelActions();
    return;
  }
  const text = sel.toString().trim();
  if (text.length < 2 || text.length > 2000) {
    hideSelActions();
    return;
  }
  const body = transcriptAnswerBody(sel.anchorNode);
  if (!body || !body.closest("#transcript, #side-transcript")) {
    hideSelActions();
    return;
  }
  const range = sel.getRangeAt(0);
  const rect = selEndRect(range);
  if (!rect) {
    hideSelActions();
    return;
  }
  selHeld = text;
  ensureSelBar();
  placeSelBar(rect);
}

function bindSelectionActions() {
  document.addEventListener("selectionchange", () => {
    if (!selPointerDown) clampSelToAnswer();
    window.clearTimeout(selTimer);
    selTimer = window.setTimeout(syncSelActions, 80);
  });
  document.addEventListener(
    "mousedown",
    (e) => {
      if (selBar && e.target instanceof Node && selBar.contains(e.target)) return;
      selPointerDown = true;
      selDidDrag = false;
      selDownX = e.clientX;
      selDownY = e.clientY;
      hideSelActions();
    },
    true,
  );
  window.addEventListener("mousemove", (e) => {
    if (!selPointerDown || selDidDrag) return;
    const dx = e.clientX - selDownX;
    const dy = e.clientY - selDownY;
    if (dx * dx + dy * dy >= 16) selDidDrag = true;
  });
  window.addEventListener("mouseup", () => {
    if (!selPointerDown) return;
    selPointerDown = false;
    clampSelToAnswer();
    window.clearTimeout(selTimer);
    syncSelActions();
  });
  document.addEventListener(
    "click",
    (e) => {
      if (!selDragQuoted()) return;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (selBar?.contains(t)) return;
      const el = t instanceof Element ? t : t.parentElement;
      if (!el?.closest("#transcript, #side-transcript")) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

function paintStoppedNow(chat: ChatRuntime) {
  chat.lastStopped = true;
  chat.status = "Stopped";
  const last = chat.lines[chat.lines.length - 1];
  if (last?.kind === "assistant") {
    last.stopped = true;
    last.error = false;
    last.meta = "Stopped";
    if (chatVisible(chat)) {
      if (chat.liveThoughtDetails?.isConnected) {
        syncWorkChrome(chat.liveThoughtDetails, {
          metaText: "Stopped",
          work: last.work ?? [],
          parts: last.parts,
          open: isWorkOpen(chat, last),
          live: false,
        });
      } else if (chat.liveMeta?.isConnected) {
        paintWorkMeta(chat.liveMeta, "Stopped");
      }
      if (!joinTextParts(last.parts).trim()) {
        chat.liveStream?.querySelector(":scope > .msg-answer-meta")?.remove();
      }
      chat.liveRow?.classList.remove("is-turn-fill");
      if (chat.liveRow) chat.liveRow.style.minHeight = "";
    }
  }
  if (!chatVisible(chat)) return;
  if (chat.surface === "panel") {
    setSideStatus(chat, "Stopped");
    applySideComposerLock(chat);
    refreshSideRetryChrome(chat);
    stampLastSideAnswer(chat);
  } else {
    setStatus("Stopped");
    applySendChrome();
    refreshUserEditChrome();
    refreshRetryChrome();
  }
}

async function stopTurn(chat: ChatRuntime) {
  if (!chat.runInFlight || chat.stopRequested) return;
  chat.stopRequested = true;
  paintStoppedNow(chat);
  try {
    await invoke("stop_turn", { chatKey: chat.key });
  } catch {
    /* hub may already be gone */
  }
}

/** Stop live turn (if any) and run this text next; other waiting stays. */
async function steerText(
  chat: ChatRuntime,
  text: string,
  attachments: Attachment[] = [],
) {
  const trimmed = text.trim();
  if (!trimmed && attachments.length === 0) return;
  if (trimmed) rememberPrompt(trimmed);
  chat.steerNext = trimmed;
  chat.steerNextAttachments = attachments;
  if (chat.runInFlight) {
    await stopTurn(chat);
    return;
  }
  void pumpQueue(chat);
}

async function steerWaitingItem(chat: ChatRuntime, id: string) {
  const idx = chat.waiting.findIndex((w) => w.id === id);
  if (idx < 0) return;
  const [item] = chat.waiting.splice(idx, 1);
  persistWaiting(chat);
  if (activeChatKey === chat.key) renderWaiting(chat);
  await steerText(chat, item.text, item.attachments ?? []);
}

function composerHasPayload(): boolean {
  const chat = activeChat();
  return !!composerText().trim() || (chat?.attachments.length ?? 0) > 0;
}

function steerFirstWaiting(chat: ChatRuntime): boolean {
  if (chat.waiting.length === 0) return false;
  void steerWaitingItem(chat, chat.waiting[0].id);
  return true;
}

/** Drain waiting only on normal finish. Stop parks the queue. */
async function pumpQueue(
  chat: ChatRuntime,
  opts?: { drainWaiting?: boolean },
) {
  if (chat.runInFlight) return;
  const drainWaiting = opts?.drainWaiting !== false;
  let next: string | null = null;
  let atts: Attachment[] = [];
  if (chat.steerNext != null) {
    next = chat.steerNext;
    atts = chat.steerNextAttachments ?? [];
    chat.steerNext = null;
    chat.steerNextAttachments = null;
  } else if (drainWaiting && chat.waiting.length > 0) {
    const item = chat.waiting.shift()!;
    next = item.text;
    atts = item.attachments ?? [];
    persistWaiting(chat);
    if (chat.surface === "panel") renderSideWaiting(chat);
    else if (activeChatKey === chat.key) renderWaiting(chat);
  }
  if (next != null && (next.trim() || atts.length > 0)) {
    await runPrompt(next, { fromQueue: true, attachments: atts, chat });
  }
}

function takeComposerText(): string {
  const field = input();
  const text = composerText(field).trim();
  const chat = activeChat();
  if (chat) {
    chat.pluginMarks = Object.fromEntries(pluginChipMeta);
    chat.draft = "";
  }
  lockedMarks.clear();
  if (field) {
    setComposerText("");
  }
  hideSuggest();
  applySendChrome();
  return text;
}

function takeComposerPayload(): { text: string; attachments: Attachment[] } {
  const chat = activeChat();
  const attachments = chat ? [...chat.attachments] : [];
  if (chat) {
    chat.attachments = [];
    renderAttachChips(chat);
  }
  const text = takeComposerText();
  return { text, attachments };
}

const MAX_ATTACH = 8;
const MAX_ATTACH_BYTES = 12 * 1024 * 1024;

type AttachInfo = {
  path: string;
  name: string;
  size: number;
  mime: string;
  isDir: boolean;
  isImage: boolean;
};

function attachLabel(atts: Attachment[] | undefined): string {
  if (!atts?.length) return "";
  if (atts.every((a) => a.kind === "quote")) return annotationLabel(atts.length);
  if (atts.length === 1) return atts[0].name;
  return `${atts.length} files`;
}

function hideQuoteChipCard() {
  quoteChipCard?.remove();
  quoteChipCard = null;
}

function showQuoteChipCard(
  chip: HTMLElement,
  quotes: Attachment[],
  liveNote = "",
) {
  hideQuoteChipCard();
  const card = document.createElement("div");
  card.className = "attach-quote-card";
  quotes.forEach((q) => {
    const k = document.createElement("p");
    k.className = "attach-quote-k";
    k.textContent = "Selected text";
    const v = document.createElement("p");
    v.className = "attach-quote-v";
    v.textContent = q.quote || q.name;
    card.append(k, v);
  });
  const note = (quotes.find((q) => q.comment)?.comment || liveNote).trim();
  if (note) {
    const ck = document.createElement("p");
    ck.className = "attach-quote-k";
    ck.textContent = "Comment";
    const cv = document.createElement("p");
    cv.className = "attach-quote-v";
    cv.textContent = note;
    card.append(ck, cv);
  }
  document.body.appendChild(card);
  quoteChipCard = card;
  const box = chip.getBoundingClientRect();
  const h = card.offsetHeight;
  const w = card.offsetWidth;
  let top = box.top - h - 8;
  if (top < 8) top = box.bottom + 8;
  let left = box.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;
}

function renderQuoteChip(
  quotes: Attachment[],
  removable: boolean,
  onRemove?: () => void,
  liveNote?: () => string,
): HTMLElement {
  const chip = document.createElement("div");
  chip.className = "attach-chip is-file is-quote";
  chip.title = quotes.map((q) => q.quote || q.name).join("\n\n");
  chip.appendChild(iconEl(Ico.quote, { size: 16, className: "attach-chip-ico" }));
  const name = document.createElement("span");
  name.className = "attach-chip-name";
  name.textContent = annotationLabel(quotes.length);
  chip.appendChild(name);
  if (removable) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "attach-chip-x";
    x.title = "Remove";
    x.setAttribute("aria-label", "Remove annotations");
    x.appendChild(iconEl(Ico.close, { size: 16, stroke: "2.2" }));
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      hideQuoteChipCard();
      onRemove?.();
    });
    chip.appendChild(x);
  }
  chip.addEventListener("pointerenter", () => {
    showQuoteChipCard(chip, quotes, liveNote?.() ?? composerText());
  });
  chip.addEventListener("pointerleave", hideQuoteChipCard);
  return chip;
}

function dtoForAttach(a: Attachment) {
  return {
    path: a.path ?? null,
    name: a.name,
    mime: a.mime,
    kind: a.kind,
    data: a.dataB64 ?? null,
    size: a.size ?? null,
  };
}

function renderAttachStrip(
  atts: Attachment[],
  removable: boolean,
  onRemove?: (id: string) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = removable ? "attach-chips" : "user-attach";
  const quotes = atts.filter((a) => a.kind === "quote");
  const rest = atts.filter((a) => a.kind !== "quote");
  if (quotes.length) {
    wrap.appendChild(
      renderQuoteChip(
        quotes,
        removable,
        removable
          ? () => {
              const chat = activeChat();
              if (!chat) return;
              chat.attachments = chat.attachments.filter((a) => a.kind !== "quote");
              renderAttachChips(chat);
              applySendChrome();
            }
          : undefined,
      ),
    );
  }
  for (const a of rest) {
    const chip = document.createElement("div");
    chip.className = `attach-chip ${a.kind === "image" ? "is-image" : "is-file"}`;
    chip.title = a.quote || a.path || a.name;
    if (a.snapTitle || a.snapIconUrl) {
      chip.className = "attach-chip is-snap";
      const shot = document.createElement("div");
      shot.className = "snap-shot";
      if (a.previewUrl) {
        const img = document.createElement("img");
        img.alt = a.snapTitle || a.name;
        img.src = a.previewUrl;
        shot.appendChild(img);
      }
      const fade = document.createElement("div");
      fade.className = "snap-fade";
      shot.appendChild(fade);
      chip.appendChild(shot);
      if (a.snapIconUrl) {
        const ico = document.createElement("img");
        ico.className = "snap-icon";
        ico.alt = "";
        ico.src = a.snapIconUrl;
        chip.appendChild(ico);
      }
      const title = document.createElement("div");
      title.className = "snap-title";
      title.textContent = a.snapTitle || a.name;
      chip.appendChild(title);
      if (!removable && a.previewUrl) {
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          openMediaViewer(a.previewUrl || "", a.snapTitle || a.name);
        });
      }
    } else if (a.kind === "image" && a.previewUrl) {
      const img = document.createElement("img");
      img.className = "attach-chip-thumb";
      img.alt = a.name;
      img.src = a.previewUrl;
      chip.appendChild(img);
      if (!removable) {
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          openMediaViewer(a.previewUrl || "", a.name);
        });
      }
    } else {
      chip.classList.add("is-file");
      chip.appendChild(iconEl(Ico.file, { size: 16, className: "attach-chip-ico" }));
      const name = document.createElement("span");
      name.className = "attach-chip-name";
      name.textContent = a.name;
      chip.appendChild(name);
    }
    if (removable) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "attach-chip-x";
      x.title = "Remove";
      x.setAttribute("aria-label", `Remove ${a.name}`);
      x.appendChild(iconEl(Ico.close, { size: 16, stroke: "2.2" }));
      x.addEventListener("click", () => {
        if (onRemove) onRemove(a.id);
        else removeAttachment(a.id);
      });
      chip.appendChild(x);
    }
    wrap.appendChild(chip);
  }
  return wrap;
}

function renderSideAttachChips(side: SideChat) {
  const box = sideAttachChips();
  if (!box) return;
  hideQuoteChipCard();
  const atts = side.attachments;
  box.replaceChildren();
  if (atts.length === 0) {
    box.hidden = true;
    box.setAttribute("hidden", "");
    return;
  }
  box.hidden = false;
  box.removeAttribute("hidden");
  const quotes = atts.filter((a) => a.kind === "quote");
  const files = atts.filter((a) => a.kind !== "quote");
  if (quotes.length) {
    box.appendChild(
      renderQuoteChip(
        quotes,
        true,
        () => {
          side.attachments = side.attachments.filter((a) => a.kind !== "quote");
          renderSideAttachChips(side);
          applySideComposerLock(side);
        },
        () => sideInput()?.value ?? "",
      ),
    );
  }
  if (files.length) {
    const strip = renderAttachStrip(files, true, (id) => {
      side.attachments = side.attachments.filter((a) => a.id !== id);
      renderSideAttachChips(side);
      applySideComposerLock(side);
    });
    box.append(...Array.from(strip.children));
  }
}

function renderAttachChips(chat: ChatRuntime | null = activeChat()) {
  const box = attachChips();
  if (!box) return;
  const atts = chat?.attachments ?? [];
  hideQuoteChipCard();
  box.replaceChildren();
  if (atts.length === 0) {
    box.hidden = true;
    box.setAttribute("hidden", "");
    return;
  }
  box.hidden = false;
  box.removeAttribute("hidden");
  const strip = renderAttachStrip(atts, true);
  box.append(...Array.from(strip.children));
}

function setDropOverlay(on: boolean) {
  const el = dropOverlay();
  if (!el) return;
  el.hidden = !on;
  if (on) el.removeAttribute("hidden");
  else el.setAttribute("hidden", "");
}

function ensureAttachChat(): ChatRuntime | null {
  if (!prefs.activeCwd) {
    setStatus("Open a project folder first.");
    return null;
  }
  let chat = activeChat();
  if (!chat || chat.cwd !== prefs.activeCwd) {
    chat = makeChat(prefs.activeCwd, { forceNew: true, title: "New chat" });
    focusChat(chat);
  }
  return chat;
}

function attachStatus(chat: ChatRuntime, text: string) {
  if (chat.surface === "panel") setSideStatus(chat, text);
  else setStatus(text);
}

function paintAttach(chat: ChatRuntime) {
  if (chat.surface === "panel") {
    renderSideAttachChips(chat);
    applySideComposerLock(chat);
  } else if (activeChatKey === chat.key) {
    renderAttachChips(chat);
    applySendChrome();
  }
}

function roomForAttach(chat: ChatRuntime, add: number): boolean {
  if (chat.attachments.length + add <= MAX_ATTACH) return true;
  attachStatus(chat, `Too many files (${MAX_ATTACH} max).`);
  return false;
}

function pushAttachment(chat: ChatRuntime, att: Attachment) {
  if (att.path && chat.attachments.some((a) => a.path === att.path)) return;
  if (!roomForAttach(chat, 1)) return;
  chat.attachments.push(att);
  paintAttach(chat);
}

type ScreenSnap = {
  path: string;
  title: string;
  icon: string | null;
};

async function addSnapshot(snap: ScreenSnap) {
  const chat = ensureAttachChat();
  if (!chat) return;
  let infos: AttachInfo[] = [];
  try {
    infos = await invoke<AttachInfo[]>("inspect_attach_paths", {
      paths: [snap.path],
    });
  } catch {
    setStatus("Could not read the snapshot.");
    return;
  }
  const info = infos[0];
  if (!info) {
    setStatus("Could not read the snapshot.");
    return;
  }
  if (info.isImage && info.size > MAX_ATTACH_BYTES) {
    setStatus(`${info.name} is too large (12 MB max).`);
    return;
  }
  const title = (snap.title || info.name).trim() || "Window";
  pushAttachment(chat, {
    id: crypto.randomUUID(),
    name: title,
    path: info.path,
    mime: info.mime,
    kind: "image",
    size: info.size,
    previewUrl: convertFileSrc(info.path),
    snapTitle: title,
    snapIconUrl: snap.icon ? convertFileSrc(snap.icon) : undefined,
  });
}

async function addPathsToChat(chat: ChatRuntime, paths: string[]) {
  if (paths.length === 0) return;
  let infos: AttachInfo[] = [];
  try {
    infos = await invoke<AttachInfo[]>("inspect_attach_paths", { paths });
  } catch {
    attachStatus(chat, "Could not read those files.");
    return;
  }
  let skippedDir = false;
  for (const info of infos) {
    if (info.isDir) {
      skippedDir = true;
      continue;
    }
    if (info.isImage && info.size > MAX_ATTACH_BYTES) {
      attachStatus(chat, `${info.name} is too large (12 MB max).`);
      continue;
    }
    pushAttachment(chat, {
      id: crypto.randomUUID(),
      name: info.name,
      path: info.path,
      mime: info.mime,
      kind: info.isImage ? "image" : "file",
      size: info.size,
      previewUrl: info.isImage ? convertFileSrc(info.path) : undefined,
    });
  }
  if (skippedDir) attachStatus(chat, "Folders are not attached. Use @ in the prompt.");
}

async function addPaths(paths: string[], target?: "main" | "side") {
  const side =
    target === "side" || (target !== "main" && isSidePanelOpen() && !!frontAgent())
      ? frontAgent()
      : null;
  if (side && target !== "main") {
    await addPathsToChat(side, paths);
    return;
  }
  const chat = ensureAttachChat();
  if (!chat) return;
  await addPathsToChat(chat, paths);
}

function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.onload = () => {
      const raw = String(reader.result ?? "");
      const i = raw.indexOf("base64,");
      resolve(i >= 0 ? raw.slice(i + 7) : raw);
    };
    reader.readAsDataURL(file);
  });
}

async function addPastedFileToChat(chat: ChatRuntime, file: File) {
  if (file.size > MAX_ATTACH_BYTES) {
    attachStatus(chat, `${file.name || "File"} is too large (12 MB max).`);
    return;
  }
  const mime = file.type || "application/octet-stream";
  const isImage = mime.startsWith("image/") && !mime.includes("svg");
  const name = file.name || (isImage ? "pasted-image.png" : "pasted-file");
  const pathOnFile = (file as File & { path?: string }).path;
  if (pathOnFile) {
    await addPathsToChat(chat, [pathOnFile]);
    return;
  }
  let dataB64 = "";
  try {
    dataB64 = await fileToB64(file);
  } catch {
    attachStatus(chat, "Could not read that file.");
    return;
  }
  if (isImage) {
    pushAttachment(chat, {
      id: crypto.randomUUID(),
      name,
      mime: mime || "image/png",
      kind: "image",
      size: file.size,
      previewUrl: `data:${mime || "image/png"};base64,${dataB64}`,
      dataB64,
    });
    return;
  }
  try {
    const saved = await invoke<string>("save_temp_attach", {
      name,
      data: dataB64,
    });
    pushAttachment(chat, {
      id: crypto.randomUUID(),
      name,
      path: saved,
      mime,
      kind: "file",
      size: file.size,
    });
  } catch (e) {
    attachStatus(chat, e instanceof Error ? e.message : String(e));
  }
}

async function pickSideAttachFiles(side: SideChat) {
  await pickAttachInto(side);
}

async function addPastedFile(file: File) {
  const chat = ensureAttachChat();
  if (!chat) return;
  await addPastedFileToChat(chat, file);
}

function removeAttachment(id: string) {
  const chat = activeChat();
  if (!chat) return;
  chat.attachments = chat.attachments.filter((a) => a.id !== id);
  renderAttachChips(chat);
  applySendChrome();
}

async function pickAttachInto(chat: ChatRuntime) {
  try {
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Attach files",
      defaultPath: prefs.activeCwd || undefined,
    });
    if (selected == null) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    await addPathsToChat(chat, paths.filter(Boolean));
  } catch {
    /* cancelled */
  }
}

async function pickAttachFiles() {
  if (!prefs.activeCwd) {
    setStatus("Open a project folder first.");
    return;
  }
  const chat = ensureAttachChat();
  if (chat) await pickAttachInto(chat);
}

function pathsFromUriList(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (!t.startsWith("file://")) continue;
    try {
      out.push(decodeURIComponent(t.replace(/^file:\/\//, "")));
    } catch {
      out.push(t.replace(/^file:\/\//, ""));
    }
  }
  return out;
}

function clipboardText(dt: DataTransfer): string {
  return (dt.getData("text/plain") ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function clipboardFiles(dt: DataTransfer): File[] {
  const files = Array.from(dt.files ?? []);
  if (files.length) return files;
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

function isFileClipboard(dt: DataTransfer): boolean {
  if (pathsFromUriList(dt.getData("text/uri-list") || "").length) return true;
  // An https uri-list or a rich-text image is not a file paste.
  return clipboardFiles(dt).length > 0 && !clipboardText(dt).trim();
}

function clearLiveDom(chat: ChatRuntime) {
  chat.liveStream?.querySelector(":scope > .live-work-caption")?.remove();
  chat.liveRow?.classList.remove("is-streaming", "is-turn-fill");
  if (chat.liveRow) chat.liveRow.style.minHeight = "";
  chat.liveMeta = null;
  chat.liveStream = null;
  chat.liveRow = null;
  chat.liveThoughtDetails = null;
}

function bindLiveAssistant(chat: ChatRuntime, shell: AssistantDom | null) {
  if (!shell) {
    clearLiveDom(chat);
    return;
  }
  const t = paintHostFor(chat) ?? transcript();
  t?.querySelectorAll(".msg-row.assistant.is-streaming").forEach((row) => {
    if (row !== shell.row) row.classList.remove("is-streaming");
  });
  chat.liveRow = shell.row;
  chat.liveMeta = shell.meta;
  chat.liveStream = shell.stream;
  chat.liveThoughtDetails = shell.thoughtDetails;
  shell.row.classList.add("is-streaming");
  syncLiveWorkCaption(chat);
}

function joinWorkThought(work: WorkStep[] | undefined): string {
  if (!work?.length) return "";
  return work
    .filter((s): s is { kind: "thought"; text: string } => s.kind === "thought")
    .map((s) => s.text)
    .join("\n\n")
    .trim();
}

function ensureWork(line: AssistantLine): WorkStep[] {
  if (!line.work) line.work = [];
  return line.work;
}

function appendThoughtToWork(line: AssistantLine, chunk: string) {
  if (!chunk) return;
  const work = ensureWork(line);
  const last = work[work.length - 1];
  if (last?.kind === "thought") last.text += chunk;
  else work.push({ kind: "thought", text: chunk });
  line.thought = joinWorkThought(work);
}

function isAnswerStep(text: string): boolean {
  return text.trim().length > 0;
}

function liveAnswerTyping(work: WorkStep[]): boolean {
  const lastI = work.length - 1;
  const last = work[lastI];
  if (last?.kind !== "text" || !isAnswerStep(last.text)) return false;
  const lastTool = lastToolIndex(work);
  return lastTool >= 0 && lastI > lastTool;
}

function isCompactPrompt(text: string): boolean {
  const t = text.trim();
  if (t === "/compact") return true;
  return t.startsWith("/compact ") || t.startsWith("/compact\n");
}

function liveWorkCaptionText(chat: ChatRuntime, line: AssistantLine): string {
  if (chat.compacting) return "Compacting the chat";
  if (!turnIsLive(chat)) return "";
  if (liveAnswerTyping(line.work ?? [])) return "";
  return "Currently working on it";
}

function syncLiveWorkCaption(chat: ChatRuntime, live = true) {
  const stream = chat.liveStream;
  if (!stream) return;
  const last = lastAssistantLine(chat);
  const text =
    live && last && (chat.compacting || turnIsLive(chat))
      ? liveWorkCaptionText(chat, last)
      : "";
  const existing = stream.querySelector<HTMLElement>(":scope > .live-work-caption");
  if (!text) {
    existing?.remove();
    return;
  }
  const el = existing ?? document.createElement("p");
  if (!existing) {
    el.className = "live-work-caption";
    el.setAttribute("aria-live", "polite");
  }
  if (el.textContent !== text) el.textContent = text;
  const meta = stream.querySelector(":scope > .msg-answer-meta");
  if (meta) stream.insertBefore(el, meta);
  else stream.appendChild(el);
}

function appendTextToWork(line: AssistantLine, chunk: string) {
  if (!chunk) return;
  const work = ensureWork(line);
  const last = work[work.length - 1];
  if (last?.kind === "text") {
    last.text = joinAnswerText(last.text, chunk);
    return;
  }
  if (!isAnswerStep(chunk)) return;
  // A chunk split by tool updates continues the earlier take, not a new one.
  for (let i = work.length - 1; i >= 0; i--) {
    const step = work[i];
    if (step.kind === "tool" || step.kind === "thought") continue;
    if (step.kind === "text" && chunkContinuesText(step.text, chunk)) {
      step.text = joinContinuedText(step.text, chunk);
      return;
    }
    break;
  }
  work.push({ kind: "text", text: chunk });
}

function ensureAssistantAnswers(line: AssistantLine, fallback = "") {
  const text = joinTextParts(line.parts).trim() || fallback.trim();
  if (!text) return;
  if (!line.parts.some((p) => p.kind === "text" && p.text.trim())) {
    line.parts = [
      { kind: "text", text },
      ...line.parts.filter((p) => p.kind !== "text"),
    ];
  }
  const work = ensureWork(line);
  const lastPart = [...line.parts]
    .reverse()
    .find(
      (p): p is { kind: "text"; text: string } =>
        p.kind === "text" && !!p.text.trim(),
    );
  const lastWork = work[work.length - 1];
  if (lastWork?.kind === "text") {
    if (!lastWork.text.trim() && lastPart) lastWork.text = lastPart.text;
    return;
  }
  if (!work.some((s) => s.kind === "text" && isAnswerStep(s.text))) {
    work.push({ kind: "text", text });
    return;
  }
  if (
    lastPart &&
    !work.some((s) => s.kind === "text" && s.text.trim() === lastPart.text.trim())
  ) {
    work.push({ kind: "text", text: lastPart.text });
  }
}

/** Insert text parts after matching tools when work has no text steps. */
function interleaveWorkAnswers(work: WorkStep[], parts: AssistantPart[]): WorkStep[] {
  if (work.some((s) => s.kind === "text" && isAnswerStep(s.text))) return work;
  const hasText = parts.some((p) => p.kind === "text" && p.text.trim());
  if (!hasText) return work;
  const out: WorkStep[] = [];
  let pi = 0;
  const takeText = () => {
    while (pi < parts.length) {
      const p = parts[pi];
      if (p.kind !== "text") break;
      if (p.text.trim()) out.push({ kind: "text", text: p.text });
      pi += 1;
    }
  };
  for (const step of work) {
    if (step.kind !== "tool") {
      out.push(step);
      continue;
    }
    takeText();
    while (pi < parts.length) {
      const p = parts[pi];
      if (p.kind !== "tool") break;
      pi += 1;
      if (p.chip.id === step.chip.id) break;
    }
    out.push(step);
    takeText();
  }
  takeText();
  return out;
}

function upsertWorkTool(line: AssistantLine, chip: ToolChip) {
  const work = ensureWork(line);
  for (const step of work) {
    if (step.kind !== "tool" || !step.chip.id || step.chip.id !== chip.id) continue;
    if (chip.todos?.length) {
      step.chip.todos = chip.todos;
      step.chip.todosMerge = chip.todosMerge;
    }
    mergeChipOnto(step.chip, chip);
    return;
  }
  work.push({ kind: "tool", chip: { ...chip } });
}

function rememberThought(chat: ChatRuntime, line: TranscriptLine | undefined) {
  if (line?.kind !== "assistant") return;
  const joined = joinWorkThought(line.work) || chat.thoughtBuf;
  if (joined) line.thought = joined;
}

function historyAttachments(msg: HistoryMessage): Attachment[] | undefined {
  const raw = msg.attachments;
  if (!raw?.length) return undefined;
  return raw.map((a, i) => ({
    id: `hist-${i}-${a.name}`,
    name: a.name,
    mime: a.mime || "image/png",
    kind: a.kind === "file" ? "file" : "image",
    path: a.path ?? undefined,
    previewUrl: a.path
      ? convertFileSrc(a.path)
      : a.url ?? undefined,
  }));
}

function historyToAssistant(msg: HistoryMessage): {
  parts: AssistantPart[];
  work: WorkStep[];
  thought: string;
} {
  const raw = Array.isArray(msg.parts) ? msg.parts : [];
  const parts: AssistantPart[] = [];
  const work: WorkStep[] = [];
  for (const part of raw) {
    if (part.kind === "thought" && part.text.trim()) {
      const last = work[work.length - 1];
      if (last?.kind === "thought") last.text += `\n\n${part.text}`;
      else work.push({ kind: "thought", text: part.text });
      continue;
    }
    if (part.kind === "tool") {
      const chip: ToolChip = {
        id: part.toolId || part.text || "tool",
        title: part.text || part.toolName || "Tool",
        status: "completed",
        kind: part.toolName || "",
        name: part.toolName || undefined,
        path: part.path || part.text.match(/`([^`]+)`/)?.[1] || undefined,
        query: part.query || queryFromWebTitle(part.text || "") || undefined,
        span: part.span || undefined,
        hits: (part.urls ?? []).map((u) => hitFromUrl(u)),
        todos: parseTodoItems(part.todos),
        todosMerge: part.todosMerge,
      };
      if (part.old != null || part.new != null) {
        chip.diff = {
          path: chip.path || "",
          old: part.old,
          new: part.new,
        };
      }
      if (!chip.hits?.length) delete chip.hits;
      work.push({ kind: "tool", chip });
      parts.push({ kind: "tool", chip });
      continue;
    }
    if (part.kind === "text" && part.text.trim()) {
      parts.push({ kind: "text", text: part.text });
      work.push({ kind: "text", text: part.text });
    }
  }
  if (parts.length === 0 && msg.text.trim()) {
    parts.push({ kind: "text", text: msg.text });
  }
  if (!work.some((s) => s.kind === "thought") && (msg.thought ?? "").trim()) {
    work.unshift({ kind: "thought", text: (msg.thought ?? "").trim() });
  }
  return { parts, work, thought: joinWorkThought(work) || (msg.thought ?? "").trim() };
}

function lastAssistantLine(chat: ChatRuntime): AssistantLine | null {
  for (let i = chat.lines.length - 1; i >= 0; i--) {
    const line = chat.lines[i];
    if (line.kind === "assistant") return line;
  }
  return null;
}

function lastLine(chat: ChatRuntime): TranscriptLine | undefined {
  return chat.lines[chat.lines.length - 1];
}

function pendingReviewCard(chat: ChatRuntime): boolean {
  if (chat.reviewWait) return true;
  const last = lastLine(chat);
  if (!last) return false;
  if (last.kind === "plan") return !last.resolved;
  if (last.kind === "question") return !last.resolved;
  return false;
}

/** ACP may still own the turn while a plan or question card waits. */
function turnIsLive(chat: ChatRuntime): boolean {
  return !!chat.runInFlight && !pendingReviewCard(chat);
}

function turnElapsedMs(line: AssistantLine): number {
  return line.at ? Math.max(0, Date.now() - line.at) : 0;
}

function paintAssistantClock(
  chat: ChatRuntime,
  last: AssistantLine,
  live: boolean,
) {
  const meta = live
    ? formatElapsed(turnElapsedMs(last), true, last.liveVerb)
    : formatElapsed(turnElapsedMs(last));
  last.meta = meta;
  if (chat.liveMeta?.isConnected) {
    paintWorkMeta(chat.liveMeta, meta, { live, loader: last.loader });
  }
}

function pauseTurnForCard(chat: ChatRuntime) {
  const last = lastAssistantLine(chat);
  if (last) paintAssistantClock(chat, last, false);
  syncLiveWorkCaption(chat, false);
  refreshLiveWorkFold(chat);
  if (activeChatKey === chat.key) syncWindowRunChrome();
}

/** Follow-up text after a question card is a new reply. */
function startAssistantAfterCard(chat: ChatRuntime): AssistantLine {
  const at = Date.now();
  const line: AssistantLine = {
    kind: "assistant",
    meta: "",
    thought: "",
    at,
    parts: [],
    work: [],
    loader: pickLoader(),
    liveVerb: pickLiveVerb(),
  };
  line.meta = formatElapsed(0, true, line.liveVerb);
  chat.lines.push(line);
  chat.thoughtBuf = "";
  if (chatVisible(chat)) {
    ignoreTranscriptScroll = true;
    bindLiveAssistant(
      chat,
      appendAssistantDom([], line.meta, {
        at,
        workOpen: true,
        line,
        enter: true,
        live: true,
        loader: line.loader,
        host: paintHostFor(chat),
      }),
    );
    foldOlderAssistantWork(chat);
    ignoreTranscriptScroll = false;
    if (chat.surface !== "panel") parkSentTurn(chat);
  } else {
    clearLiveDom(chat);
  }
  return line;
}

function liveAssistantForStream(chat: ChatRuntime): AssistantLine | null {
  const tail = lastLine(chat);
  if (tail?.kind === "question" && !tail.resolved) {
    return startAssistantAfterCard(chat);
  }
  if (tail?.kind === "plan" && tail.resolved) {
    return startAssistantAfterCard(chat);
  }
  return lastAssistantLine(chat);
}

function isWorkOpen(chat: ChatRuntime, line: AssistantLine | null | undefined): boolean {
  if (!line) return true;
  if (line.workOpen != null) return line.workOpen;
  return !!chat.runInFlight && lastAssistantLine(chat) === line;
}

function pushUniqueWrite(out: ToolChip[], seen: string[], chip: ToolChip) {
  const path = chip.diff?.path || chip.path || "";
  const n = normFsPath(path);
  if (!n) return;
  const i = seen.findIndex((s) => fsPathsMatch(s, n));
  if (i >= 0) {
    if (n.length > seen[i].length) {
      seen[i] = n;
      out[i] = chip;
    }
    return;
  }
  seen.push(n);
  out.push(chip);
}

function reviewWrites(line: AssistantLine): ToolChip[] {
  const out: ToolChip[] = [];
  const seen: string[] = [];
  for (const step of line.work ?? []) {
    if (step.kind !== "tool") continue;
    const chip = step.chip;
    const verb = shortToolName(chip);
    if (verb !== "Write" && verb !== "Edit") continue;
    if (chipStatusClass(chip.status) === "is-failed") continue;
    pushUniqueWrite(out, seen, chip);
  }
  return out;
}

/** A plan or question card starts a new assistant line; keep writes from that turn. */
function reviewWritesForTurn(chat: ChatRuntime): ToolChip[] {
  let start = 0;
  for (let i = chat.lines.length - 1; i >= 0; i--) {
    if (chat.lines[i].kind === "user") {
      start = i + 1;
      break;
    }
  }
  const out: ToolChip[] = [];
  const seen: string[] = [];
  for (let i = start; i < chat.lines.length; i++) {
    const line = chat.lines[i];
    if (line.kind !== "assistant") continue;
    for (const chip of reviewWrites(line)) pushUniqueWrite(out, seen, chip);
  }
  return out;
}

function fillReviewFiles(list: HTMLElement, files: ToolChip[]) {
  const paintFile = (chip: ToolChip) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "review-file";
    const name = document.createElement("span");
    name.className = "review-file-name";
    name.append(
      iconEl(Ico.file, { size: 16 }),
      document.createTextNode(shortPathName(chip.diff?.path || chip.path || "file")),
    );
    btn.append(name);
    if (chip.diff) {
      const stat = makeDiffStat(chip.diff);
      if (stat) btn.append(stat);
    }
    btn.addEventListener("click", () => {
      const open = btn.nextElementSibling;
      if (open?.classList.contains("review-diff")) {
        open.remove();
        return;
      }
      list.querySelector(".review-diff")?.remove();
      if (chip.diff) {
        const diff = makeDiffView(chip.diff);
        diff.classList.add("review-diff");
        btn.after(diff);
      }
    });
    list.appendChild(btn);
  };
  const preview = files.slice(0, 3);
  preview.forEach(paintFile);
  const extra = files.length - 3;
  if (extra > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "review-more";
    more.textContent = `+${extra} more`;
    more.addEventListener("click", () => {
      more.remove();
      files.slice(3).forEach(paintFile);
    });
    list.appendChild(more);
  }
}

function foldFinishedWork(chat: ChatRuntime) {
  if (chatVisible(chat)) {
    const t = paintHostFor(chat);
    if (t) {
      for (const row of t.querySelectorAll<HTMLElement>(
        ".msg-row.assistant[data-assistant-turn]",
      )) {
        const d = row.querySelector<HTMLDetailsElement>(
          ".thought-block.has-work",
        );
        if (!d || d.dataset.userWork === "open") continue;
        d.open = false;
      }
    }
  }
  for (const line of chat.lines) {
    if (line.kind !== "assistant") continue;
    if (line.workOpen === true) continue;
    line.workOpen = false;
  }
}

function chipPath(chip: ToolChip): string {
  return (chip.path || chip.diff?.path || "").trim();
}

function normFsPath(path: string): string {
  let n = path.trim().replace(/\\/g, "/");
  if (n.startsWith("file://")) n = n.slice(7);
  while (n.startsWith("./")) n = n.slice(2);
  return n.replace(/\/+$/, "");
}

function fsPathsMatch(a: string, b: string): boolean {
  const na = normFsPath(a).toLowerCase();
  const nb = normFsPath(b).toLowerCase();
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.endsWith("/" + nb) || nb.endsWith("/" + na);
}

function takeUniqueDocPath(seen: string[], path: string): boolean {
  const n = normFsPath(path);
  if (!n) return false;
  const key = shortPathName(n).toLowerCase(); // Write path and path chip often disagree.
  if (!key) return false;
  for (let i = 0; i < seen.length; i++) {
    const same =
      fsPathsMatch(seen[i], n) ||
      shortPathName(seen[i]).toLowerCase() === key;
    if (!same) continue;
    if (n.length > seen[i].length) seen[i] = n;
    return false;
  }
  seen.push(n);
  return true;
}

function skillRefFromPath(
  path: string,
): { skill: string; file: string | null } | null {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  const file = parts[parts.length - 1] || "";
  const skillsAt = parts.findIndex((p) => p.toLowerCase() === "skills");
  if (skillsAt >= 0 && parts[skillsAt + 1]) {
    const rest = parts.slice(skillsAt + 2);
    return {
      skill: parts[skillsAt + 1] || "",
      file: rest.length ? rest[rest.length - 1] || null : null,
    };
  }
  if (/^skill\.md$/i.test(file) && parts.length >= 2) {
    return { skill: parts[parts.length - 2] || "", file };
  }
  return null;
}

function skillNameFromPath(path: string): string | null {
  return skillRefFromPath(path)?.skill || null;
}

function isSkillRootFile(file: string | null): boolean {
  return !file || /^skill\.md$/i.test(file);
}

function makeSkillMark(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "mark mark-slash task-skill-chip";
  const ico = document.createElement("span");
  ico.className = "mark-ico";
  ico.setAttribute("aria-hidden", "true");
  ico.innerHTML = MARK_SLASH_SVG;
  const lab = document.createElement("span");
  lab.className = "mark-lab";
  lab.textContent = name;
  el.append(ico, lab);
  return el;
}

function isListChip(chip: ToolChip): boolean {
  if (isSpawnChip(chip) || isSubWaitChip(chip)) return false;
  const kind = chip.kind.trim().toLowerCase();
  const variant = (chip.variant ?? "").toLowerCase();
  const title = chip.title.trim().toLowerCase();
  return (
    kind.includes("list") ||
    variant.includes("list") ||
    title === "list_dir" ||
    /^list(\s|_)/.test(title)
  );
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|ico|bmp|heic|avif|tif?f)$/i.test(path);
}

function humanizeToolId(raw: string): string {
  return raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function mcpFamilyKey(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  for (const f of MCP_FAMILIES) {
    if (f.test.test(t)) return t;
  }
  return "";
}

const MCP_ACTION_WORD =
  /^(create|get|edit|update|delete|search|list|send|post|fetch|read|write|add|remove|publish|upload|download|set|call|open|close|query|duplicate|schedule|patch|move|share|reply|react|plan|archive|retrieve|lookup)$/i;

const MCP_ACCOUNT_WORD = /^(personal|plus)$/i;

function isMcpTagged(chip: ToolChip): boolean {
  if (isSpawnChip(chip) || isSubWaitChip(chip)) return false;
  if (isWebChip(chip) || isWebFetchChip(chip) || isXSearchChip(chip)) return false;
  if (chip.server && mcpFamilyKey(chip.server)) return true;
  const name = (chip.name ?? "").trim();
  if (name.includes("__")) return true;
  if (name && mcpFamilyKey(name)) return true;
  const variant = chip.variant ?? "";
  const kind = chip.kind.trim();
  if (/usetool|use_tool/i.test(variant) || /use_tool|search_tool/i.test(kind)) {
    return true;
  }
  const blob = [chip.server, chip.name, chip.title, chip.kind].filter(Boolean).join(" ");
  for (const t of humanizeToolId(blob).split(/\s+/).filter(Boolean)) {
    if (mcpFamilyKey(t)) return true;
  }
  return false;
}

function titleVerb(word: string): string {
  const w = word.trim();
  if (!w) return "";
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

function isCoreFileChip(chip: ToolChip): boolean {
  if (isMcpTagged(chip)) return false;
  const kind = chip.kind.trim().toLowerCase();
  const variant = (chip.variant ?? "").toLowerCase();
  const title = chip.title.trim().toLowerCase();
  if (kind === "read" || kind === "write" || kind === "edit") return true;
  if (kind === "execute" || kind === "bash" || kind === "shell") return true;
  if (kind.includes("terminal") || title.includes("run_terminal")) return true;
  if (kind === "grep" || kind === "delete") return true;
  if (kind.includes("replace") || variant === "write" || variant.includes("replace")) {
    return true;
  }
  if (isListChip(chip) && chipPath(chip)) return true;
  return false;
}

function mcpPaint(chip: ToolChip): { brand: string; action: string } | null {
  if (isSpawnChip(chip) || isSubWaitChip(chip)) return null;
  if (isCoreFileChip(chip)) return null;
  if (isWebChip(chip) || isWebFetchChip(chip) || isXSearchChip(chip)) return null;
  const blob = [chip.server, chip.name, chip.title, chip.kind]
    .filter(Boolean)
    .join(" ");
  const tokens = humanizeToolId(blob).split(" ").filter(Boolean);
  let brand = chip.server ? mcpFamilyKey(chip.server) : "";
  const rest: string[] = [];
  for (const t of tokens) {
    if (/^(use|tool|mcp|server|other)$/i.test(t)) continue;
    if (MCP_ACCOUNT_WORD.test(t)) continue;
    if (mcpFamilyKey(t)) {
      if (!brand) brand = t;
      continue;
    }
    rest.push(t);
  }
  const vi = rest.findIndex((t) => MCP_ACTION_WORD.test(t));
  const action = (vi >= 0 ? rest.slice(vi) : rest).join(" ").trim();
  const tagged =
    !!(chip.server && mcpFamilyKey(chip.server)) ||
    /usetool|use_tool/i.test(chip.variant ?? "") ||
    /use_tool|search_tool/i.test(chip.kind) ||
    !!brand;
  const loneAction =
    MCP_ACTION_WORD.test(chip.title.trim()) && !chipPath(chip) && !chip.query;
  if (!tagged && !loneAction) return null;
  const fallback = [chip.name, chip.title]
    .map((s) => (s ?? "").trim())
    .find(
      (s) =>
        s &&
        !isUseHostLabel(s) &&
        !MCP_ACCOUNT_WORD.test(s) &&
        !mcpFamilyKey(s),
    );
  return {
    brand,
    action: action || fallback || "call",
  };
}

function isUseHostLabel(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/[_-]+/g, " ");
  return t === "use" || t === "use tool" || t === "usetool";
}

function unwrapRunCommand(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  if (!s) return "";
  const wrapped = s.match(/^\((?:cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*)(.+)\)$/);
  if (wrapped) s = wrapped[1].trim();
  const andCd = s.match(/^(?:cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*)(.+)$/);
  if (andCd) s = andCd[1].trim();
  return s;
}

function fileDeleteTargets(raw: string): string[] {
  const s = unwrapRunCommand(raw.replace(/^execute\s*`/i, "").replace(/`$/, ""));
  if (!s) return [];
  const out: string[] = [];
  for (const part of s.split(/\s*&&\s*/)) {
    const tokens = part.trim().split(" ").filter(Boolean);
    const base = (tokens[0] || "").split("/").pop() || "";
    if (!/^(rm|unlink)$/i.test(base)) continue;
    for (const t of tokens.slice(1)) {
      if (!t || t.startsWith("-")) continue;
      out.push(t.replace(/^['"]|['"]$/g, ""));
    }
  }
  return out;
}

function looksLikeFileName(name: string): boolean {
  return /\.[A-Za-z0-9]{1,12}$/.test(name);
}

function deleteFileNames(chip: ToolChip, peers: ToolChip[] = []): string[] {
  const own = shortPathName(chipPath(chip));
  if (own && looksLikeFileName(own) && chip.kind.trim().toLowerCase() === "delete") {
    return [own];
  }
  const raw = (chip.query ?? "").trim() || chip.title.trim();
  const fromCmd = fileDeleteTargets(raw);
  const names = [...new Set(fromCmd.map((p) => shortPathName(p)).filter(Boolean))];
  const folderOnly = names.length === 1 && !looksLikeFileName(names[0] ?? "");
  if (folderOnly) {
    const dir = (fromCmd[0] || chipPath(chip)).replace(/\\/g, "/").replace(/\/$/, "");
    const folder = names[0] ?? "";
    const fromReads: string[] = [];
    for (const c of peers) {
      if (c.id === chip.id) continue;
      const p = chipPath(c).replace(/\\/g, "/");
      if (!p) continue;
      if (p === dir || p.endsWith(`/${folder}`)) continue;
      if (!p.startsWith(`${dir}/`) && !p.includes(`/${folder}/`)) continue;
      const n = shortPathName(p);
      if (looksLikeFileName(n)) fromReads.push(n);
    }
    const files = [...new Set(fromReads)];
    if (files.length) return files;
  }
  if (names.length) return names;
  const p = chipPath(chip);
  return p ? [shortPathName(p)] : [];
}

function isFileDeleteChip(chip: ToolChip): boolean {
  if (isMcpTagged(chip)) return false;
  if (chip.kind.trim().toLowerCase() === "delete") return true;
  const raw = (chip.query ?? "").trim() || chip.title.trim();
  return fileDeleteTargets(raw).length > 0;
}

function runSummary(raw: string): string {
  let s = unwrapRunCommand(raw);
  if (!s) return "";
  const broken = s.match(/^[^"\s]+"\s+(.+)$/);
  if (broken) s = broken[1].trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    const next = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s*/, "");
    if (next === s) break;
    s = next.trim();
  }
  s = s.replace(/^sleep\s+\d+\s+/, "");
  const npx = s.match(/^(npx|npm|pnpm|yarn|bunx)\s+([@\w.-]+)/i);
  if (npx) {
    const rest = s.slice(npx[0].length).trim();
    const sub = rest.split(/\s+/).find((t) => t && !t.startsWith("-"));
    return clipMeta([npx[1], npx[2], sub].filter(Boolean).join(" "));
  }
  const tokens = s.split(" ").filter(Boolean);
  const first =
    tokens.find((t) => !t.includes("=") && !t.startsWith("-")) || tokens[0] || "";
  const base = first.split("/").pop() || first;
  if (
    /^(npx|npm|pnpm|yarn|bun|bunx|node|python3?|pip|cargo|go|git|ls|cat|head|rg|grep|curl|mkdir|sleep|bash|sh|osascript|chmod|cp|mv|rm|open)$/i.test(
      base,
    )
  ) {
    const file = tokens.find((t) =>
      /\.[a-zA-Z][a-zA-Z0-9]{0,7}$/.test(t.replace(/['"]/g, "")),
    );
    if (file) return clipMeta(`${base} ${shortPathName(file.replace(/['"]/g, ""))}`);
    const next = tokens.find((t, i) => i > 0 && !t.startsWith("-") && !t.includes("="));
    return clipMeta([base, next].filter(Boolean).join(" "));
  }
  return clipMeta(s);
}

function shortToolName(chip: ToolChip): string {
  const kind = chip.kind.trim().toLowerCase();
  const variant = (chip.variant ?? "").toLowerCase();
  const title = chip.title.trim().toLowerCase();
  if (isSpawnChip(chip)) return "Spawn";
  if (isSubWaitChip(chip)) return "Wait";
  if (/kill_command|kill_subagent/.test(`${chipToolName(chip)} ${kind} ${variant} ${title}`)) {
    return "Kill";
  }
  if (!isMcpTagged(chip) && (kind === "write" || variant === "write")) return "Write";
  if (
    !isMcpTagged(chip) &&
    (kind.includes("replace") || variant.includes("replace") || kind === "edit")
  ) {
    return "Edit";
  }
  if (kind === "diagram") return "Diagram";
  if (!isMcpTagged(chip) && (kind === "read" || /^read\b/i.test(chip.title))) {
    return isImagePath(chipPath(chip)) ? "View" : "Read";
  }
  if (isFileDeleteChip(chip)) return "Delete";
  if (
    kind === "execute" ||
    kind === "bash" ||
    kind === "shell" ||
    kind.includes("terminal") ||
    title.includes("run_terminal")
  ) {
    return "Run";
  }
  if (
    variant.includes("todo") ||
    title.startsWith("todo") ||
    /\btodos?\b/.test(title)
  ) {
    return "Todos";
  }
  if (variant.includes("xsearch") || title.startsWith("x search")) return "X";
  if (
    kind === "search_tool" ||
    kind.includes("search_tool") ||
    (!isMcpTagged(chip) &&
      (kind === "search" || kind === "fetch" || kind === "grep"))
  ) {
    return "Search";
  }
  if (isListChip(chip)) return "List";
  if (isAskChip(chip)) return "Ask";
  const mcp = mcpPaint(chip);
  if (mcp) {
    const first =
      mcp.action
        .split(/\s+/)
        .find((t) => t && !MCP_ACCOUNT_WORD.test(t) && !mcpFamilyKey(t)) || "";
    const v = titleVerb(first);
    if (!v || isUseHostLabel(v) || MCP_ACCOUNT_WORD.test(v)) return "Call";
    if (v === "Query" || v === "Find") return "Search";
    if (v === "Get" || v === "Retrieve" || v === "Lookup") return "Read";
    if (v === "Patch") return "Edit";
    return v;
  }
  if (kind && /^[a-zA-Z][\w-]{0,30}$/.test(kind) && kind !== "other") {
    return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
  return "Call";
}

function isPainterChip(chip: ToolChip): boolean {
  if (chip.kind.trim().toLowerCase() === "diagram") return false;
  if (isPainterPath(chipPath(chip))) return true;
  const q = chipQuery(chip) || chip.title;
  if (/diagrams\.ts|parsediagram|drawdiagram|diagram_types/i.test(q)) {
    return true;
  }
  return isDiagramTypeHunt(q);
}

function isBuildPlumbingPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (!p) return false;
  if (p.includes("/node_modules/") || p.endsWith("/node_modules") || p.startsWith("node_modules/")) {
    return true;
  }
  const file = p.split("/").pop() || p;
  if (
    file === "package-lock.json" ||
    file === "pnpm-lock.yaml" ||
    file === "yarn.lock" ||
    file === "bun.lock" ||
    file === "bun.lockb" ||
    file === "npm-shrinkwrap.json"
  ) {
    return true;
  }
  return /^tsconfig(\.[a-z0-9_-]+)?\.json$/.test(file);
}

function isSkillInnerRead(chip: ToolChip): boolean {
  const skill = skillRefFromPath(chipPath(chip));
  if (!skill || isSkillRootFile(skill.file)) return false;
  const verb = shortToolName(chip);
  return verb === "Read" || verb === "View" || verb === "tool";
}

function isQuietToolChip(chip: ToolChip): boolean {
  if (isPainterChip(chip)) return true;
  if (isBuildPlumbingPath(chipPath(chip))) return true;
  if (isSkillInnerRead(chip)) return true;
  const verb = shortToolName(chip);
  if (verb === "Get" || verb === "Run" || verb === "List" || verb === "Todos") {
    return true;
  }
  const kind = chip.kind.trim().toLowerCase();
  const title = chip.title.trim().toLowerCase();
  const name = (chip.name ?? "").toLowerCase();
  const blob = `${kind} ${chip.variant ?? ""} ${title} ${name}`;
  if (verb === "Search" && (kind === "grep" || !!chipPath(chip))) return true;
  if (/search_tool|searchtool/i.test(blob) || /^search tools\b/i.test(title)) {
    return true;
  }
  if (/enter_plan|exit_plan|plan_mode/.test(blob)) return true;
  if (/\bscheduler[_ ]/.test(blob)) return true;
  if (/\bworkflow\b/.test(kind) || /run_workflow|workflow_host/.test(blob)) {
    return true;
  }
  if (isSubWaitChip(chip) || /get_command_or_subagent|subagent_output/.test(blob)) {
    return true;
  }
  if (kind === "monitor" || title === "monitor") return true;
  const host =
    verb === "Use" ||
    isUseHostLabel(chip.title) ||
    /use_tool|usetool/i.test(blob);
  if (host && (verb === "Use" || verb === "Call") && !mcpTargetText(chip)) {
    return true;
  }
  return false;
}

function makeDiagramChip(
  spec: { type: string; title: string },
  index: number,
): ToolChip {
  return {
    id: `diagram:${spec.type}:${spec.title}:${index}`,
    title: spec.title,
    status: "completed",
    kind: "diagram",
  };
}

function displayWorkSteps(work: WorkStep[]): WorkStep[] {
  const out: WorkStep[] = [];
  let pending: ToolChip[] = [];
  const flushTools = (figures: { type: string; title: string }[]) => {
    const kept = pending.filter((c) => !isPainterChip(c));
    pending = [];
    for (const chip of kept) out.push({ kind: "tool", chip });
    figures.forEach((fig, i) => {
      out.push({ kind: "tool", chip: makeDiagramChip(fig, i) });
    });
  };
  for (let i = 0; i < work.length; i++) {
    const step = work[i];
    if (step.kind === "thought") continue;
    if (step.kind === "tool") {
      // Hidden tools never split takes. They leave no visible burst.
      if (isQuietToolChip(step.chip)) continue;
      pending.push(step.chip);
      continue;
    }
    let text = step.text;
    let last = i;
    while (last + 1 < work.length) {
      const nxt = work[last + 1];
      if (nxt.kind === "thought") {
        last += 1;
        continue;
      }
      if (nxt.kind === "tool" && isQuietToolChip(nxt.chip)) {
        last += 1;
        continue;
      }
      if (nxt.kind === "text") {
        last += 1;
        text += `\n\n${nxt.text}`;
        continue;
      }
      break;
    }
    i = last;
    if (!isAnswerStep(text)) continue;
    const prev = out[out.length - 1];
    if (prev?.kind === "text" && chunkContinuesText(prev.text, text)) {
      // Split mid-sentence by tool updates. The take stays above its burst.
      flushTools(diagramFences(text));
      prev.text = joinContinuedText(prev.text, text);
      continue;
    }
    flushTools(diagramFences(text));
    out.push({ kind: "text", text });
  }
  flushTools([]);
  // Research evidence JSON is machine chatter. Drop it and its split shards.
  if (!out.some((s) => s.kind === "text" && isMachineJsonText(s.text))) {
    return out;
  }
  const mach = out.map((s) => s.kind === "text" && isMachineJsonText(s.text));
  const nearestTextMachine = (i: number, dir: 1 | -1): boolean | null => {
    for (let j = i + dir; j >= 0 && j < out.length; j += dir) {
      if (out[j].kind === "text") return mach[j];
    }
    return null;
  };
  const drop = new Array<boolean>(out.length).fill(false);
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.kind !== "text") continue;
    if (mach[i]) {
      drop[i] = true;
      continue;
    }
    const prevM = nearestTextMachine(i, -1);
    const nextM = nearestTextMachine(i, 1);
    if (looksLikeJsonShard(s.text) && (prevM || nextM)) {
      drop[i] = true;
      continue;
    }
    if (
      prevM === true &&
      nextM === true &&
      !/[.!?]["'”’)\]]?\s*$/.test(s.text.trim())
    ) {
      drop[i] = true;
    }
  }
  return out.filter((_, i) => !drop[i]);
}

function visibleToolChips(chips: ToolChip[]): ToolChip[] {
  const shown = chips.filter((c) => !isQuietToolChip(c));
  const have = new Set<string>();
  for (const c of shown) {
    const skill = skillRefFromPath(chipPath(c));
    if (!skill || !isSkillRootFile(skill.file)) continue;
    const verb = shortToolName(c);
    if (verb === "List" || verb === "Edit" || verb === "Write") continue;
    have.add(skill.skill);
  }
  const extra: ToolChip[] = [];
  const added = new Set<string>();
  for (const c of chips) {
    if (!isSkillInnerRead(c)) continue;
    const name = skillRefFromPath(chipPath(c))?.skill;
    if (!name || have.has(name) || added.has(name)) continue;
    added.add(name);
    extra.push(c);
  }
  return extra.length ? shown.concat(extra) : shown;
}

function pickLoader(): LoaderKind {
  return LOADER_KINDS[Math.floor(Math.random() * LOADER_KINDS.length)]!;
}

function pickLiveVerb(): string {
  return LIVE_VERBS[Math.floor(Math.random() * LIVE_VERBS.length)]!;
}

function formatClock(ms: number): string {
  const total = Math.max(0, ms / 1000);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  if (m >= 1) return `${m}m ${s.toFixed(1)}s`;
  return `${s.toFixed(1)}s`;
}

function formatWorkedSecs(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 1) return `${m}m ${r}s`;
  return `${s}s`;
}

function formatElapsed(ms: number, live = false, verb?: string): string {
  if (live) return `${verb || "Churning"} ${formatClock(ms)}`;
  return `Worked for ${formatWorkedSecs(ms / 1000)}`;
}

function displayWorkLabel(text: string): string {
  let t = text;
  if (t === "Thought") return "Worked";
  if (t.startsWith("Thought for ")) t = `Worked for ${t.slice("Thought for ".length)}`;
  const m = t.match(/^Worked for (\d+)s$/);
  if (m) return `Worked for ${formatWorkedSecs(Number(m[1]))}`;
  return t;
}

function workMetaLabel(secs?: number): string {
  if (secs != null && secs > 0) return `Worked for ${formatWorkedSecs(secs)}`;
  return "Worked";
}

function workMetaIsLive(text: string): boolean {
  return /^\S+ing\b/.test(text.trim());
}

const ORBIT_RING = [0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4];

function makeLoaderEl(kind: LoaderKind): HTMLElement {
  const el = document.createElement("span");
  el.className = `px-loader is-${kind}`;
  el.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 16; i++) {
    const cell = document.createElement("span");
    cell.style.setProperty("--i", String(i));
    if (kind === "dots") {
      const row = Math.floor(i / 4);
      const col = i % 4;
      cell.style.setProperty(
        "--d",
        String(Math.abs(row - 1.5) + Math.abs(col - 1.5) - 1),
      );
    }
    if (kind === "orbit") {
      const step = ORBIT_RING.indexOf(i);
      cell.style.setProperty("--o", String(step < 0 ? 99 : step));
    }
    el.appendChild(cell);
  }
  return el;
}

function paintWorkMeta(
  meta: HTMLElement | null,
  text: string,
  opts?: { live?: boolean; loader?: LoaderKind | null },
) {
  if (!meta) return;
  const live = !!opts?.live && !!opts.loader && workMetaIsLive(text);
  const labelText = displayWorkLabel(text);
  const want =
    live && opts?.loader ? `loader:${opts.loader}` : "plain";
  if (meta.dataset.workChrome !== want) {
    meta.dataset.workChrome = want;
    meta.replaceChildren();
    if (want.startsWith("loader:") && opts?.loader) {
      meta.appendChild(makeLoaderEl(opts.loader));
    }
    const label = document.createElement("span");
    label.className = "work-meta-text";
    meta.appendChild(label);
  }
  const label = meta.querySelector(".work-meta-text");
  if (label) label.textContent = labelText;
}

function shortPathName(path: string): string {
  const clean = path.replace(/\\/g, "/");
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function clipMeta(t: string): string {
  return t.length > 56 ? `${t.slice(0, 55)}…` : t;
}

function chipQuery(chip: ToolChip): string {
  if (isXSearchChip(chip)) return xSearchQuery(chip);
  const q = (chip.query ?? "").trim();
  if (q) return q;
  const kind = chip.kind.trim().toLowerCase();
  const title = chip.title.trim();
  const isSearch =
    kind === "search" || kind === "grep" || /^search\b|^grep\b/i.test(title);
  if (!isSearch) return "";
  const file = shortPathName(chipPath(chip));
  const tick = title.match(/`([^`]+)`/)?.[1]?.trim() || "";
  if (tick && tick !== file && !tick.includes("/")) return tick;
  if (
    title &&
    !title.includes("/") &&
    !/^search\b|^grep\b|^web\b/i.test(title) &&
    title !== file
  ) {
    return title;
  }
  return "";
}

function readSpanText(chip: ToolChip): string {
  if (isImagePath(chipPath(chip))) return "";
  if (chip.span) return chip.span;
  const kind = chip.kind.trim().toLowerCase();
  if (kind === "read" || /^read\b/i.test(chip.title)) return "all";
  return "";
}

function isToolSlug(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 64) return false;
  if (!/\s/.test(t) && t.includes("__")) return true;
  if (/\s/.test(t)) return false;
  if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t)) return false;
  return true;
}

// Slack C/F/U-style ids. A name always has a letter run with no digit.
function looksLikeHostId(s: string): boolean {
  const t = s.trim();
  if (t.length < 9 || t.length > 18) return false;
  return /^[CDGFUTW][A-Z0-9]*[0-9][A-Z0-9]*$/i.test(t);
}

function looksLikeUuid(s: string): boolean {
  const t = s.trim().replace(/-/g, "");
  return t.length === 32 && /^[0-9a-f]+$/i.test(t);
}

function looksLikeOpaqueTarget(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (t.toLowerCase() === "self") return true;
  if (looksLikeHostId(t) || looksLikeUuid(t)) return true;
  if (/^\d{6,}$/.test(t)) return true;
  return false;
}

function mcpKindNoun(chip: ToolChip): string {
  const raw = (chip.name || chip.title || chip.kind || "").trim();
  if (!raw) return "";
  const slug = raw.includes("__") ? (raw.split("__").pop() ?? raw) : raw;
  const out: string[] = [];
  for (const t of humanizeToolId(slug).split(/\s+/).filter(Boolean)) {
    if (/^(use|tool|mcp|server|other)$/i.test(t)) continue;
    if (MCP_ACCOUNT_WORD.test(t)) continue;
    if (mcpFamilyKey(t)) continue;
    if (MCP_ACTION_WORD.test(t)) continue;
    if (looksLikeOpaqueTarget(t)) continue;
    if (isToolSlug(t)) continue;
    out.push(t.toLowerCase());
  }
  if (out.length) {
    return out.join(" ").replace(/\bpages\b/g, "page");
  }
  if (/draft/i.test(slug)) return "draft";
  if (/folder/i.test(slug)) return "folder";
  if (/comment/i.test(slug)) return "comment";
  if (/transcript/i.test(slug)) return "transcript";
  if (/meeting/i.test(slug)) return "meeting";
  if (/page/i.test(slug) || /fetch/i.test(slug)) return "page";
  return "";
}

function searchQueryText(chip: ToolChip): string {
  const q = chipQuery(chip);
  if (!q || isToolSlug(q)) return "";
  const toks = q.split(/\s+/).filter((t) => !mcpFamilyKey(t));
  if (toks[0] && /^search$/i.test(toks[0])) toks.shift();
  return clipMeta(toks.join(" ") || q);
}

function mcpTargetText(chip: ToolChip): string {
  const q = (chip.query ?? "").trim();
  const named = (chip.name ?? "").trim();
  if (
    q &&
    !isToolSlug(q) &&
    !isUseHostLabel(q) &&
    q !== named &&
    q !== chip.title.trim() &&
    !looksLikeOpaqueTarget(q) &&
    !MCP_ACCOUNT_WORD.test(q)
  ) {
    return clipMeta(q);
  }
  const noun = mcpKindNoun(chip);
  if (!noun) return "";
  const verb = shortToolName(chip).toLowerCase();
  if (noun === verb) return "";
  return clipMeta(noun);
}

function taskMetaText(chip: ToolChip): string {
  const verb = shortToolName(chip);
  const mcp = mcpPaint(chip);
  if (mcp) return mcpTargetText(chip);
  if (verb === "Run") {
    const raw = (chip.query ?? "").trim() || chip.title.trim();
    return runSummary(raw);
  }
  if (verb === "Spawn") {
    const lab = (chip.description ?? "").trim();
    const title = chip.title.trim();
    if (lab && lab !== title) return clipMeta(lab);
    if (title && !/spawn/i.test(title)) return clipMeta(title);
    return "";
  }
  if (verb === "Ask") {
    const q = (chip.query ?? "").trim();
    return q ? clipMeta(q) : "";
  }
  if (verb === "Delete") {
    const names = deleteFileNames(chip);
    return names[0] && !/^(replace|edit|write|insert|patch|delete)$/i.test(names[0])
      ? names[0]
      : "";
  }
  if (verb === "Edit" || verb === "Write") {
    const p = chipPath(chip);
    if (!p) return "";
    const name = shortPathName(p);
    if (/^(replace|edit|write|insert|patch)$/i.test(name)) return "";
    return name;
  }
  const skill = skillNameFromPath(chipPath(chip));
  if (skill) return skill;
  const q = chipQuery(chip);
  if (q) return clipMeta(q);
  const raw = chipPath(chip) || chip.title.match(/`([^`]+)`/)?.[1] || "";
  const t = raw.trim();
  if (!t || t.length < 2) return "";
  if (t.includes("/") || t.includes(".")) return shortPathName(t);
  if (/^(replace|edit|write|insert|patch)$/i.test(t)) return "";
  if (t.toLowerCase() === verb.toLowerCase()) return "";
  return clipMeta(t);
}

type DiffLine = {
  kind: "eq" | "add" | "del";
  text: string;
  no: number;
};

function splitDiffLines(s: string | undefined | null): string[] {
  if (s == null || s === "") return [];
  return s.split("\n");
}

function lineDiff(oldText: string | undefined | null, newText: string | undefined | null): DiffLine[] {
  const a = splitDiffLines(oldText);
  const b = splitDiffLines(newText);
  const n = a.length;
  const m = b.length;
  const out: DiffLine[] = [];
  const push = (kind: DiffLine["kind"], text: string, no: number) => {
    out.push({ kind, text, no });
  };
  if (n * m > 120000) {
    // Skip LCS when the product is huge.
    for (let i = 0; i < n; i++) push("del", a[i]!, i + 1);
    for (let j = 0; j < m; j++) push("add", b[j]!, j + 1);
    return out;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  let oi = 1;
  let nj = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("eq", a[i]!, nj);
      i += 1;
      j += 1;
      oi += 1;
      nj += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      push("del", a[i]!, oi);
      i += 1;
      oi += 1;
    } else {
      push("add", b[j]!, nj);
      j += 1;
      nj += 1;
    }
  }
  while (i < n) {
    push("del", a[i]!, oi);
    i += 1;
    oi += 1;
  }
  while (j < m) {
    push("add", b[j]!, nj);
    j += 1;
    nj += 1;
  }
  return out;
}

function countDiffLines(rows: DiffLine[]): { add: number; del: number } | null {
  let add = 0;
  let del = 0;
  for (const r of rows) {
    if (r.kind === "add") add += 1;
    else if (r.kind === "del") del += 1;
  }
  if (!add && !del) return null;
  return { add, del };
}

function diffLineStats(diff: ToolDiff): { add: number; del: number } | null {
  return countDiffLines(lineDiff(diff.old, diff.new));
}

function makeDiffStatEl(stats: { add: number; del: number }): HTMLElement {
  const stat = document.createElement("span");
  stat.className = "task-diff-stat";
  if (stats.add) {
    const add = document.createElement("span");
    add.className = "task-diff-add";
    add.textContent = `+${stats.add}`;
    stat.appendChild(add);
  }
  if (stats.del) {
    const del = document.createElement("span");
    del.className = "task-diff-del";
    del.textContent = `−${stats.del}`;
    stat.appendChild(del);
  }
  return stat;
}

function makeDiffStat(diff: ToolDiff): HTMLElement | null {
  const stats = diffLineStats(diff);
  return stats ? makeDiffStatEl(stats) : null;
}

function makeDiffView(diff: ToolDiff): HTMLElement {
  const box = document.createElement("div");
  box.className = "task-diff";
  const head = document.createElement("div");
  head.className = "task-diff-head";
  const title = document.createElement("span");
  title.className = "task-diff-name";
  title.textContent = shortPathName(diff.path || "file");
  head.append(title);
  const rows = lineDiff(diff.old, diff.new);
  const stats = countDiffLines(rows);
  if (stats) head.append(makeDiffStatEl(stats));
  box.appendChild(head);
  const body = document.createElement("div");
  body.className = "task-diff-body";
  for (const r of rows) {
    const line = document.createElement("div");
    line.className = `task-diff-line is-${r.kind}`;
    const num = document.createElement("span");
    num.className = "task-diff-no";
    num.textContent = String(r.no);
    const text = document.createElement("span");
    text.className = "task-diff-text";
    text.textContent = r.text;
    line.append(num, text);
    body.appendChild(line);
  }
  box.appendChild(body);
  return box;
}

function makeTaskRow(chip: ToolChip): HTMLElement {
  const block = document.createElement("div");
  block.className = "task-block";
  const row = document.createElement(chip.diff ? "button" : "div");
  if (chip.diff) row.setAttribute("type", "button");
  row.className = "task-row";
  const statusClass = chipStatusClass(chip.status);
  if (statusClass) row.classList.add(statusClass);

  const fullPath = chipPath(chip);
  const bindPath = (el: HTMLElement, path: string) => {
    el.classList.add("task-path");
    el.title = `${path} (⌘-click to open)`;
    el.addEventListener("click", (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      void revealPath(path);
    });
  };

  const name = document.createElement("span");
  name.className = "task-name";
  const verb = shortToolName(chip);
  const file = fullPath ? shortPathName(fullPath) : "";
  const phrase = document.createElement("span");
  phrase.className = "task-phrase";
  const mcp = mcpPaint(chip);
  if (mcp) {
    const thumb = document.createElement("span");
    thumb.className = "task-brand source-thumb";
    thumb.setAttribute("aria-hidden", "true");
    paintMcpMark(thumb, mcp.brand || "mcp");
    row.append(thumb);
  }

  const skill = fullPath ? skillRefFromPath(fullPath) : null;
  if (skill) {
    const mark = makeSkillMark(skill.skill);
    bindPath(mark, fullPath);
    const listed = isListChip(chip);
    if (listed) {
      name.textContent = "List";
      const fileEl = document.createElement("span");
      fileEl.className = "task-path";
      fileEl.textContent = skill.file || "files";
      bindPath(fileEl, fullPath);
      const from = document.createElement("span");
      from.className = "task-from";
      from.textContent = "from";
      phrase.append(fileEl, from);
      row.append(name, phrase, mark);
    } else if (verb === "Edit" || verb === "Write") {
      name.textContent = verb;
      const fileEl = document.createElement("span");
      fileEl.className = "task-path";
      fileEl.textContent = skill.file || file;
      bindPath(fileEl, fullPath);
      const from = document.createElement("span");
      from.className = "task-from";
      from.textContent = "from";
      phrase.append(fileEl, from);
      row.append(name, phrase, mark);
    } else {
      name.textContent = "Skill";
      row.append(name, mark);
    }
  } else {
    name.textContent = verb;
    const q = chipQuery(chip);
    const span = verb === "Read" ? readSpanText(chip) : chip.span || "";
    if (mcp) {
      const target = mcpTargetText(chip);
      row.append(name);
      if (target) {
        const extra = document.createElement("span");
        extra.className = "task-extra";
        extra.textContent = target;
        row.append(extra);
      }
    } else if ((verb === "Read" || verb === "View") && file) {
      if (verb === "Read" && span) {
        const range = document.createElement("span");
        range.textContent = `${span} of`;
        phrase.append(range);
      }
      const pathEl = document.createElement("span");
      pathEl.className = "task-path";
      pathEl.textContent = file;
      bindPath(pathEl, fullPath);
      phrase.append(pathEl);
      row.append(name, phrase);
    } else if (verb === "Diagram") {
      const t = document.createElement("span");
      t.textContent = chip.title;
      phrase.append(t);
      row.append(name, phrase);
    } else if (verb === "Search" && q && !isToolSlug(q)) {
      const qEl = document.createElement("span");
      qEl.textContent = searchQueryText(chip) || clipMeta(q);
      phrase.append(qEl);
      if (file) {
        const inn = document.createElement("span");
        inn.textContent = "in";
        const pathEl = document.createElement("span");
        pathEl.className = "task-path";
        pathEl.textContent = file;
        bindPath(pathEl, fullPath);
        phrase.append(inn, pathEl);
      }
      row.append(name, phrase);
    } else {
      const extra = document.createElement("span");
      extra.className = "task-extra";
      extra.textContent = taskMetaText(chip);
      row.append(name);
      if (extra.textContent) {
        row.append(extra);
        if (fullPath) bindPath(extra, fullPath);
      }
      if (span && verb === "Edit" && !chip.diff) {
        const el = document.createElement("span");
        el.className = "task-span";
        el.textContent = span;
        row.appendChild(el);
      }
    }
  }
  if (chip.diff) {
    const stat = makeDiffStat(chip.diff);
    if (stat) row.appendChild(stat);
  }

  block.appendChild(row);

  if (chip.diff) {
    const detail = makeDiffView(chip.diff);
    detail.hidden = true;
    row.addEventListener("click", () => {
      const open = Boolean(detail.hidden); // HTML hidden is boolean | "until-found"
      detail.hidden = !open;
      block.classList.toggle("is-open", open);
    });
    block.appendChild(detail);
  }
  return block;
}

function makeBurstHead(title: string): HTMLButtonElement {
  const head = document.createElement("button");
  head.type = "button";
  head.className = "tool-burst-head";
  head.setAttribute("aria-expanded", "false");
  head.append(
    iconEl(Ico.thought, { size: 16, className: "work-sparkle" }),
    document.createTextNode(title),
  );
  return head;
}

function applyBurstOpen(wrap: HTMLElement, open: boolean) {
  wrap.classList.toggle("is-open", open);
  wrap
    .querySelector(":scope > .tool-burst-head")
    ?.setAttribute("aria-expanded", open ? "true" : "false");
  wrap
    .querySelector(":scope > .tool-burst-nest")
    ?.classList.toggle("is-collapsed", !open);
}

function makeBurstShell(
  title: string,
  extraClass?: string,
): { wrap: HTMLElement; list: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = extraClass ? `tool-burst ${extraClass}` : "tool-burst";
  const head = makeBurstHead(title);
  const nest = document.createElement("div");
  nest.className = "tool-burst-nest is-collapsed";
  const inner = document.createElement("div");
  inner.className = "tool-burst-inner";
  const list = document.createElement("div");
  list.className = "tool-burst-list";
  inner.appendChild(list);
  nest.appendChild(inner);
  wrap.append(head, nest);
  head.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const open = !wrap.classList.contains("is-open");
    wrap.classList.toggle("is-open", open);
    head.setAttribute("aria-expanded", open ? "true" : "false");
    const scroller = wrap.closest(".transcript, .side-transcript");
    animateWorkNest(
      nest,
      open,
      scroller instanceof HTMLElement ? scroller : null,
      wrap,
    );
  });
  return { wrap, list };
}

const WEB_HIT_PREVIEW = 3;

function makeXSearchRow(chip: ToolChip): HTMLElement | null {
  const query = xSearchQuery(chip);
  const hits = chip.hits ?? [];
  if (hits.length) {
    const next = { ...chip, query: query || chip.query };
    return makeWebBurst(next, { nested: true });
  }
  if (!query) return null;
  const row = document.createElement("div");
  row.className = "task-row";
  paintSourceThumb(row, { label: "X", href: "https://x.com", kind: "url" });
  const extra = document.createElement("span");
  extra.className = "task-extra";
  extra.textContent = clipMeta(query);
  row.append(extra);
  return row;
}

function makeWebBurst(chip: ToolChip, opts?: { nested?: boolean }): HTMLElement {
  const running = chipRunning(chip);
  const query = chip.query || queryFromWebTitle(chip.title);
  const nestedHead =
    query || (isWebFetchChip(chip) ? "Opened page" : "Search");
  const { wrap, list } = makeBurstShell(
    opts?.nested
      ? nestedHead
      : running
        ? "Searching the web"
        : "Searched the web",
    "is-web",
  );
  list.classList.add("web-burst-list");
  if (query && !opts?.nested) {
    const q = document.createElement("div");
    q.className = "web-query";
    q.append(
      iconEl(Ico.search, { size: 16, className: "web-query-ico" }),
      document.createTextNode(query),
    );
    list.appendChild(q);
  }
  const hits = chip.hits ?? [];
  const shown = hits.slice(0, WEB_HIT_PREVIEW);
  for (const hit of shown) list.appendChild(makeWebHitRow(hit));
  const extra = hits.length - shown.length;
  if (extra > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "web-more";
    more.textContent = `+${extra} more`;
    more.addEventListener("click", () => {
      more.replaceWith(
        ...hits.slice(WEB_HIT_PREVIEW).map((hit) => makeWebHitRow(hit)),
      );
    });
    list.appendChild(more);
  }
  return wrap;
}

function makeWebHitRow(hit: WebHit): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "web-hit";
  const name = document.createElement("span");
  name.className = "web-hit-name";
  name.textContent = hit.title;
  const host = document.createElement("span");
  host.className = "web-hit-host";
  host.textContent = hit.host;
  btn.append(name, host);
  paintSourceThumb(btn, { label: hit.title, href: hit.href, kind: "url" });
  btn.addEventListener("click", (e) => {
    void openHttpUrl(hit.href, e);
  });
  return btn;
}

type ToolKindGroup =
  | "file"
  | "view"
  | "skill"
  | "edit"
  | "write"
  | "delete"
  | "list"
  | "pattern"
  | "mcp"
  | "mcp-call"
  | "web"
  | "fetch"
  | "x"
  | "todo"
  | "ask"
  | "run"
  | "spawn"
  | "diagram"
  | "other";

function chipRunning(chip: ToolChip): boolean {
  return chipStatusClass(chip.status) === "is-running";
}

function isWebFetchChip(chip: ToolChip): boolean {
  const kind = chip.kind.trim().toLowerCase();
  const variant = (chip.variant ?? "").toLowerCase();
  const title = chip.title.trim().toLowerCase();
  return (
    kind === "web_fetch" ||
    kind === "web-fetch" ||
    variant.includes("openpage") ||
    variant.includes("webfetch") ||
    title.startsWith("opened page") ||
    title.startsWith("open page")
  );
}

function isXSearchChip(chip: ToolChip): boolean {
  const variant = (chip.variant ?? "").toLowerCase();
  const title = chip.title.trim().toLowerCase();
  return variant.includes("xsearch") || title.startsWith("x search");
}

function toolKindGroup(chip: ToolChip): ToolKindGroup {
  const kind = chip.kind.trim().toLowerCase();
  const verb = shortToolName(chip);
  if (isXSearchChip(chip)) return "x";
  if (isWebChip(chip) || isWebFetchChip(chip)) {
    return isWebFetchChip(chip) ? "fetch" : "web";
  }
  if (isMcpTagged(chip)) {
    return verb === "Search" ? "mcp" : "mcp-call";
  }
  const skill = skillRefFromPath(chipPath(chip));
  if (
    skill &&
    verb !== "List" &&
    verb !== "Edit" &&
    verb !== "Write" &&
    verb !== "Delete"
  ) {
    return "skill";
  }
  if (verb === "Write") return "write";
  if (verb === "Delete") return "delete";
  if (verb === "Edit" || kind.includes("replace")) return "edit";
  if (verb === "List" || isListChip(chip)) return "list";
  if (verb === "Todos") return "todo";
  if (verb === "Ask") return "ask";
  if (verb === "Spawn") return "spawn";
  if (verb === "Run") return "run";
  if (kind === "grep" || (verb === "Search" && chipPath(chip))) return "pattern";
  if (
    verb === "Search" ||
    kind === "search_tool" ||
    kind.includes("search_tool")
  ) {
    return mcpPaint(chip) || kind.includes("search_tool") ? "mcp" : "pattern";
  }
  if (mcpPaint(chip) || verb === "MCP") return "mcp-call";
  if (verb === "View") return "view";
  if (verb === "Read" || kind === "read") return "file";
  if (verb === "Diagram" || kind === "diagram") return "diagram";
  return "other";
}

function groupCountLabel(
  group: ToolKindGroup,
  n: number,
  live: boolean,
): string {
  const noun = (one: string, many: string) => (n === 1 ? one : many);
  switch (group) {
    case "file":
      return `${live ? "Reading" : "Read"} ${n} ${noun("file", "files")}`;
    case "view":
      return `${live ? "Viewing" : "Viewed"} ${n} ${noun("image", "images")}`;
    case "skill":
      return `${live ? "Reading" : "Read"} ${n} ${noun("skill", "skills")}`;
    case "edit":
      return `${live ? "Editing" : "Edited"} ${n} ${noun("file", "files")}`;
    case "write":
      return `${live ? "Writing" : "Wrote"} ${n} ${noun("file", "files")}`;
    case "delete":
      return `${live ? "Deleting" : "Deleted"} ${n} ${noun("file", "files")}`;
    case "list":
      return `${live ? "Listing" : "Listed"} ${n} ${noun("dir", "dirs")}`;
    case "todo":
      return live ? "Updating todos" : "Updated todos";
    case "ask":
      return live ? "Asking" : "Asked";
    case "spawn": {
      const who = n === 1 ? "an agent" : `${n} agents`;
      return `${live ? "Created" : "Closed"} ${who}`;
    }
    case "x":
      return live ? "Searching X" : "Searched X";
    case "mcp-call":
      return `${live ? "Calling" : "Called"} ${n} MCP ${noun("tool", "tools")}`;
    case "pattern":
      return `${live ? "Searching" : "Searched"} ${n} ${noun("pattern", "patterns")}`;
    case "mcp":
      return `${live ? "Searching" : "Searched"} ${n} MCP ${noun("tool", "tools")}`;
    case "web":
      return `${live ? "Searching" : "Searched"} ${n} ${noun("website", "websites")}`;
    case "fetch":
      return `${live ? "Fetching" : "Fetched"} ${n} ${noun("website", "websites")}`;
    case "run":
      return `${live ? "Running" : "Ran"} ${n} ${noun("command", "commands")}`;
    case "diagram":
      return `${live ? "Drawing" : "Drew"} ${n} ${noun("diagram", "diagrams")}`;
    default:
      return `${live ? "Running" : "Ran"} ${n} ${noun("tool", "tools")}`;
  }
}

function spawnChipLive(chip: ToolChip): boolean {
  const sub = liveSubForChip(chip);
  if (sub) return sub.status === "running";
  return chipRunning(chip);
}

function summarizeTools(chips: ToolChip[]): string {
  const order: ToolKindGroup[] = [];
  const counts = new Map<ToolKindGroup, { n: number; live: boolean }>();
  const shown = visibleToolChips(chips);
  for (const chip of shown) {
    const g = toolKindGroup(chip);
    const live = g === "spawn" ? spawnChipLive(chip) : chipRunning(chip);
    const add = g === "delete" ? Math.max(1, deleteFileNames(chip, shown).length) : 1;
    const cur = counts.get(g);
    if (!cur) {
      order.push(g);
      counts.set(g, { n: add, live });
    } else {
      cur.n += add;
      if (live) cur.live = true;
    }
  }
  const skip = new Set<ToolKindGroup>();
  const parts: string[] = [];
  for (const g of order) {
    if (skip.has(g)) continue;
    if (g === "skill" || g === "file") {
      const skill = counts.get("skill");
      const file = counts.get("file");
      if (skill && file) {
        skip.add("skill");
        skip.add("file");
        const live = skill.live || file.live;
        const skillBit = `${skill.n} ${skill.n === 1 ? "skill" : "skills"}`;
        const fileBit = `${file.n} ${file.n === 1 ? "file" : "files"}`;
        parts.push(`${live ? "Reading" : "Read"} ${skillBit} and ${fileBit}`);
        continue;
      }
    }
    const cur = counts.get(g)!;
    parts.push(groupCountLabel(g, cur.n, cur.live));
  }
  return parts.join(", ");
}

function toolGroups(chips: ToolChip[]): { group: ToolKindGroup; chips: ToolChip[] }[] {
  const order: ToolKindGroup[] = [];
  const buckets = new Map<ToolKindGroup, ToolChip[]>();
  for (const chip of visibleToolChips(chips)) {
    const g = toolKindGroup(chip);
    const bucket = buckets.get(g);
    if (!bucket) {
      order.push(g);
      buckets.set(g, [chip]);
    } else {
      bucket.push(chip);
    }
  }
  return order.map((g) => ({ group: g, chips: buckets.get(g) ?? [] }));
}

function liveSubForChip(chip: ToolChip): LiveSub | null {
  const chat = activeChat();
  if (!chat) return null;
  const sid = (chip.sessionId || "").trim();
  return (
    chat.liveSubs.find(
      (s) => s.toolId === chip.id || (sid && s.id === sid) || s.id === chip.id,
    ) ?? null
  );
}

function spawnChipName(chip: ToolChip): string {
  const sub = liveSubForChip(chip);
  if (sub?.name) return sub.name;
  const lab =
    (chip.description ?? "").trim() ||
    (!/spawn/i.test(chip.title) ? chip.title.trim() : "");
  return scientistName(lab || chip.id, new Set());
}

function makeSpawnLine(chips: ToolChip[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "spawn-line";
  const chat = activeChat();
  let running = false;
  for (const chip of chips) {
    const name = spawnChipName(chip);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sub-chip";
    const title = (chip.description || chip.title || name).trim() || name;
    btn.title = title;
    btn.append(subMarkEl(name), document.createTextNode(name));
    const sub =
      liveSubForChip(chip) ||
      chat?.liveSubs.find((s) => s.name === name) ||
      null;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!chat) return;
      openSubagentTab(
        chat,
        sub ?? {
          id: (chip.sessionId || chip.id).trim(),
          name,
          label: chip.description || chip.title || name,
          type: chip.subagentType || "general-purpose",
          status: chipRunning(chip) ? "running" : "done",
          toolId: chip.id,
        },
      );
    });
    if (spawnChipLive(chip)) running = true;
    row.appendChild(btn);
  }
  if (running) {
    const note = document.createElement("span");
    note.className = "spawn-note";
    note.textContent = "started working";
    row.appendChild(note);
  }
  return row;
}

function toolBurstTitle(chips: ToolChip[]): string {
  return summarizeTools(chips);
}

function viewThumbSrc(chip: ToolChip): string {
  const path = chipPath(chip);
  if (!path) return "";
  const cwd = prefs.activeCwd || activeChat()?.cwd || null;
  const local = resolveMediaPath(path, cwd);
  if (!local) return "";
  try {
    return convertFileSrc(local);
  } catch {
    return "";
  }
}

function makeViewThumb(chip: ToolChip): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "view-thumb";
  const path = chipPath(chip);
  const name = path ? shortPathName(path) : "Image";
  btn.title = path ? `${path} (⌘-click to open)` : name;
  const src = viewThumbSrc(chip);
  if (src) {
    const img = document.createElement("img");
    img.alt = name;
    img.src = src;
    img.addEventListener("error", () => {
      btn.classList.add("is-broken");
      img.remove();
      const lab = document.createElement("span");
      lab.className = "view-thumb-name";
      lab.textContent = name;
      btn.appendChild(lab);
    });
    btn.appendChild(img);
  } else {
    btn.classList.add("is-broken");
    const lab = document.createElement("span");
    lab.className = "view-thumb-name";
    lab.textContent = name;
    btn.appendChild(lab);
  }
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) {
      if (path) void revealPath(path);
      return;
    }
    if (src) openMediaViewer(src, name);
    else if (path) void openPath(path);
  });
  return btn;
}

function makeViewStrip(chips: ToolChip[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "view-strip";
  for (const chip of chips) row.appendChild(makeViewThumb(chip));
  return row;
}

function fillBurstList(list: HTMLElement, chips: ToolChip[]) {
  list.replaceChildren();
  const shown = visibleToolChips(chips);
  for (const g of toolGroups(shown)) {
    if (g.group === "spawn") {
      list.appendChild(makeSpawnLine(g.chips));
      continue;
    }
    if (g.group === "view") {
      list.appendChild(makeViewStrip(g.chips));
      continue;
    }
    if (g.group === "x") {
      const seen = new Set<string>();
      for (const chip of g.chips) {
        const row = makeXSearchRow(chip);
        if (!row) continue;
        const key = xSearchQuery(chip).toLowerCase();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        list.appendChild(row);
      }
      continue;
    }
    for (const chip of g.chips) {
      if (g.group === "delete") {
        const names = deleteFileNames(chip, shown);
        if (names.length > 1) {
          for (const name of names) {
            list.appendChild(
              makeTaskRow({ ...chip, kind: "delete", path: name }),
            );
          }
          continue;
        }
      }
      list.appendChild(
        isWebChip(chip) || isWebFetchChip(chip)
          ? makeWebBurst(chip, { nested: true })
          : makeTaskRow(chip),
      );
    }
  }
}

function burstDetailsKey(chips: ToolChip[]): string {
  return chips
    .map(
      (c) =>
        `${c.id}:${c.status}:${c.title}:${c.query ?? ""}:${c.span ?? ""}:${c.diff ? 1 : 0}`,
    )
    .join("|");
}

function makeToolBurst(chips: ToolChip[]): HTMLElement {
  const shown = visibleToolChips(chips);
  const { wrap, list } = makeBurstShell(toolBurstTitle(shown));
  fillBurstList(list, chips);
  wrap.dataset.chips = burstDetailsKey(chips);
  return wrap;
}

function refreshToolBurst(wrap: HTMLElement, chips: ToolChip[]) {
  const key = burstDetailsKey(chips);
  if (wrap.dataset.chips === key) return;
  const shown = visibleToolChips(chips);
  const head = wrap.querySelector<HTMLElement>(":scope > .tool-burst-head");
  if (head) {
    const label = toolBurstTitle(shown);
    for (const n of head.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) {
        n.textContent = label;
        break;
      }
    }
  }
  const nest = wrap.querySelector<HTMLElement>(":scope > .tool-burst-nest");
  if (nest?.classList.contains("is-motion")) return;
  const list = wrap.querySelector<HTMLElement>(".tool-burst-list");
  if (list) fillBurstList(list, chips);
  wrap.dataset.chips = key;
}

function workStructKey(steps: WorkStep[]): string {
  return steps
    .map((s) => {
      if (s.kind === "thought") return "r";
      if (s.kind === "text") return "x";
      const c = s.chip;
      const spawn = isSpawnChip(c)
        ? `${spawnChipName(c)}:${liveSubForChip(c)?.status ?? ""}`
        : "";
      return `t:${c.id}:${c.status}:${c.title}:${c.query ?? ""}:${c.server ?? ""}:${c.span ?? ""}:${c.diff ? 1 : 0}:${spawn}`;
    })
    .join("|");
}

function mdFenceMark(line: string): string | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  return m ? m[1] : null;
}

function mdFenceClose(line: string, open: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m || m[1][0] !== open[0] || m[1].length < open.length) return false;
  return !m[2].trim();
}

function mdProseBreakLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^#{1,6}(?:\s|$)/.test(t)) return true;
  if (/^>/.test(t)) return true;
  if (/^([-*_])\1{2,}$/.test(t.replace(/\s/g, ""))) return true;
  if (/^=+$/.test(t) || /^-{2,}$/.test(t)) return true;
  if (/^[-*+]\s/.test(t) || /^\d+[.)]\s/.test(t)) return true;
  if (/^\|/.test(t) || /\|$/.test(t)) return true;
  if (/^\[[^\]]+\]:\s/.test(t)) return true;
  return false;
}

function mdEndsSentence(line: string): boolean {
  return /[.!?。！？]['"”’)\]»]*\s*$/.test(line);
}

/** Next chunk is a new message, not the next token of the same sentence. */
function isNewTake(prev: string, chunk: string): boolean {
  if (!prev.trim() || !chunk) return false;
  if (/^\s/.test(chunk)) return false;
  if (!/^[A-ZÀ-ŽА-Я]/.test(chunk)) return false;
  if (!mdEndsSentence(prev.trimEnd())) return false;
  if (chunkContinuesText(prev, chunk)) return false;
  return true;
}

function joinAnswerText(prev: string, chunk: string): string {
  if (!prev) return chunk;
  if (isNewTake(prev, chunk)) return `${prev.replace(/\s*$/, "")}\n\n${chunk}`;
  return prev + chunk;
}

function mdContinuesWrap(line: string): boolean {
  return /^[a-z0-9([{]/.test(line.trimStart());
}

/** Research evidence JSON streamed as chat text. Never a user-facing answer. */
function stripCodeFenceTicks(text: string): string {
  return text.trim().replace(/^```[\w-]*\s*/, "").replace(/```\s*$/, "");
}

function isMachineJsonText(text: string): boolean {
  if (text.trim().length < 40) return false;
  const t = stripCodeFenceTicks(text);
  // Machine evidence only. Prose that merely ends with a fenced block stays.
  if (!/^\s*[{[]/.test(t)) return false;
  const evidence =
    /"source_locator"|"source_title"|"confidence"\s*:\s*"(high|medium|low)"|"questions"\s*:\s*\[/;
  return evidence.test(t);
}

/** Punctuation-led shard of a split JSON bundle. Quoted prose is not this. */
function looksLikeJsonShard(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 300) return false;
  if (/^["'“‘][A-ZÀ-ŽА-Я]/.test(t)) return false;
  if (/^["'`,}\]{_:;/]/.test(t) || /^-[A-Za-z]/.test(t)) return true;
  return /"[a-z_]+"\s*:|},\s*{/.test(t);
}

/** A streamed chunk that continues the previous sentence, not a new take. */
function chunkContinuesText(prev: string, chunk: string): boolean {
  if (!prev.trim() || !chunk.trim()) return false;
  const p = prev.trimEnd();
  if (mdEndsSentence(p)) return false;
  if (mdContinuesWrap(chunk)) return true;
  const c = chunk.trimStart();
  if (/^[,}\]"':;_/]/.test(c) || /^-[A-Za-z]/.test(c)) return true;
  if (/["'`([{]$/.test(p)) return true;
  return false;
}

/** Join a continuation chunk. Mid-word token splits rejoin without a space. */
function joinContinuedText(prev: string, chunk: string): string {
  if (!prev) return chunk;
  if (/\s$/.test(prev) || /^\s/.test(chunk)) return prev + chunk;
  if (/[A-Za-z0-9]$/.test(prev) && /^[a-z0-9]/.test(chunk)) return prev + chunk;
  const p = prev.trimEnd();
  const c = chunk.trimStart();
  if (/["'`([{]$/.test(p) || /^[,}\]"':;_/]/.test(c) || /^-[A-Za-z]/.test(c)) {
    return prev + chunk;
  }
  return `${prev} ${chunk}`;
}

/** Join wrapped prose. A leftover line break between sentences is a paragraph. */
function unwrapMdParagraphs(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (fence) {
      out.push(line);
      if (mdFenceClose(line, fence)) fence = null;
      continue;
    }
    const open = mdFenceMark(line);
    if (open) {
      fence = open;
      out.push(line);
      continue;
    }
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (mdFenceMark(next) || mdProseBreakLine(line) || mdProseBreakLine(next)) {
        break;
      }
      if (mdEndsSentence(line) || !mdContinuesWrap(next)) break;
      line = `${line.replace(/\s+$/, "")} ${next.replace(/^\s+/, "")}`;
      i += 1;
    }
    out.push(line);
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    if (
      next != null &&
      next.trim() &&
      !mdFenceMark(next) &&
      !mdProseBreakLine(line) &&
      !mdProseBreakLine(next)
    ) {
      out.push("");
    }
  }
  return out.join("\n");
}

/** Join a hyphen or path that wrapped onto the next line. Split packed 1. 2. 3. onto their own lines. */
function normalizeMdWraps(src: string): string {
  let s = src.replace(/\r\n/g, "\n");
  s = s.replace(/(\S)\n-([A-Za-z])/g, "$1-$2");
  s = s.replace(/(\/[\w.\-]+)\n([\w.\-]+)/g, "$1$2");
  s = s.replace(/`([^`\n]*)\n([^`\n]*)`/g, (full, a, b, idx, src) => {
    // Even ticks before this one: opener. Odd: closer of an earlier span.
    const ticks = (src.slice(0, idx).match(/`/g) || []).length;
    if (ticks % 2 === 1) return full;
    return `\`${a}${b}\``;
  });
  // Sentence then "3." on the same wrap: new item, not the same line.
  s = s.replace(/([.!?])[ \t]+(\d{1,2})\.(?:[ \t]+|(?=\n|$))/g, "$1\n$2. ");
  s = s.replace(/(^|\n)(\d{1,2}\.\s+)([^\n]+)/g, (full, lead, start, rest) => {
    if (!/\s\d{1,2}\.(?:\s|$)/.test(rest)) return full;
    return `${lead}${start}${rest.replace(/\s+(\d{1,2})\.(?:\s+|$)/g, "\n$1. ")}`;
  });
  // "3." at EOL, body on the next line.
  s = s.replace(/(^|\n)(\d{1,2}\.)[ \t]*\n(?=[^\s>#`|*+\-])/g, "$1$2 ");
  return unwrapMdParagraphs(s);
}

function closeOpenFences(text: string): string {
  const ticks = text.split("```").length - 1;
  return ticks % 2 === 1 ? `${text}\n\`\`\`` : text;
}

const liveMdTimers = new WeakMap<HTMLElement, number>();

function liveMdDelay(text: string): number {
  const n = text.length;
  if (n > 6000) return 48;
  if (n > 1800) return 32;
  return 16;
}

function streamIsMoving(el: HTMLElement | null): boolean {
  return !!el?.closest(".assistant-stream")?.querySelector(".is-motion");
}

function clearLiveMdTimer(body: HTMLElement | null) {
  if (!body) return;
  const t = liveMdTimers.get(body);
  if (!t) return;
  window.clearTimeout(t);
  liveMdTimers.delete(body);
}

function scheduleLiveMd(body: HTMLElement, delay: number) {
  clearLiveMdTimer(body);
  liveMdTimers.set(
    body,
    window.setTimeout(() => flushLiveMarkdown(body), delay),
  );
}

function flushLiveMarkdown(body: HTMLElement) {
  liveMdTimers.delete(body);
  if (!body.isConnected) return;
  const text = body.dataset.livePending ?? body.dataset.liveSrc ?? "";
  if (streamIsMoving(body)) {
    scheduleLiveMd(body, 80);
    return;
  }
  delete body.dataset.livePending;
  if (!body.dataset.liveNeedParse && body.dataset.liveSrc === text) return;
  delete body.dataset.liveNeedParse;
  body.dataset.liveSrc = text;
  body.dataset.mdSrc = text;
  body.classList.add("markdown");
  body.classList.remove("is-live-type");
  if (!text) {
    body.replaceChildren();
    return;
  }
  body.innerHTML = renderMarkdownHtml(closeOpenFences(text), { cache: false });
  hydrateMarkdown(body, { drawDiagrams: false, media: false, linkify: false });
}

function liveMdNeedsParse(prev: string, text: string): boolean {
  const delta = text.slice(prev.length);
  const inFence = (prev.split("```").length - 1) % 2 === 1;
  if (inFence) return delta.includes("```");
  return /[\n`]/.test(delta);
}

function lastLiveTextNode(root: HTMLElement): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest("button, .code-toolbar, .code-lang, .diagram-block, svg")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let last: Text | null = null;
  let n: Node | null;
  while ((n = walker.nextNode())) last = n as Text;
  return last;
}

function appendLiveMarkdown(body: HTMLElement, prev: string, text: string): boolean {
  if (!prev || !text.startsWith(prev) || !body.childNodes.length) return false;
  if (liveMdNeedsParse(prev, text)) return false;
  const last = lastLiveTextNode(body);
  if (!last) return false;
  last.nodeValue = (last.nodeValue || "") + text.slice(prev.length);
  body.dataset.liveSrc = text;
  body.dataset.mdSrc = text;
  body.dataset.liveNeedParse = "1";
  return true;
}

function paintLiveMarkdown(body: HTMLElement, text: string) {
  body.classList.add("markdown");
  body.classList.remove("is-live-type");
  body.dataset.livePending = text;
  if (body.dataset.liveSrc === text) return;
  const prev = body.dataset.liveSrc || "";
  if (prev && !streamIsMoving(body) && appendLiveMarkdown(body, prev, text)) {
    scheduleLiveMd(body, liveMdDelay(text));
    return;
  }
  if (!prev && !streamIsMoving(body)) {
    flushLiveMarkdown(body);
    return;
  }
  if (liveMdTimers.has(body)) return;
  scheduleLiveMd(body, liveMdDelay(text));
}

function fillLiveAnswer(
  body: HTMLElement,
  text: string,
  opts?: { cursor?: boolean; final?: boolean; live?: boolean },
) {
  if (opts?.final) body.classList.add("is-final");
  else body.classList.toggle("is-final", false);
  // Live markdown skips detached nodes; new burst answers are filled before insert.
  const stream = body.isConnected && (opts?.cursor || (opts?.live && !opts?.final));
  if (stream) {
    paintLiveMarkdown(body, text);
    return;
  }
  clearLiveMdTimer(body);
  delete body.dataset.livePending;
  const live = !!(opts?.live || opts?.cursor);
  fillAssistantBody(body, live ? closeOpenFences(text) : text, {
    drawDiagrams: !live,
  });
}

function paintAnswerStep(
  text: string,
  opts?: { cursor?: boolean; final?: boolean; live?: boolean },
): HTMLElement {
  const body = document.createElement("div");
  body.className = "assistant-body work-step-answer";
  fillLiveAnswer(body, text, opts);
  return body;
}

function lastToolIndex(work: WorkStep[]): number {
  for (let i = work.length - 1; i >= 0; i--) {
    if (work[i].kind === "tool") return i;
  }
  return -1;
}

function isFinalAnswerAt(
  work: WorkStep[],
  index: number,
  live = false,
): boolean {
  if (work[index]?.kind !== "text") return false;
  const lastTool = lastToolIndex(work);
  if (lastTool < 0) return true;
  if (index > lastTool) return true;
  // Live: keep a take above its tools. Done: a take with no later answer is the last answer.
  if (live) return false;
  for (let i = lastTool + 1; i < work.length; i++) {
    if (work[i].kind === "text") return false;
  }
  for (let i = work.length - 1; i >= 0; i--) {
    if (work[i].kind === "text") return i === index;
  }
  return false;
}

function workTimelinePane(details: HTMLDetailsElement | null): HTMLElement | null {
  if (!details) return null;
  const parent = details.parentElement;
  return (
    parent?.querySelector<HTMLElement>(".assistant-stream .work-timeline") ??
    details.querySelector<HTMLElement>(".work-timeline")
  );
}

function placeFinalWorkAnswer(pane: HTMLElement) {
  const stream = pane.closest(".assistant-stream");
  if (!stream) return;
  for (const old of [
    ...stream.querySelectorAll<HTMLElement>(":scope > .work-step-answer"),
  ]) {
    old.remove();
  }
  const final = pane.querySelector<HTMLElement>(":scope > .work-step-answer.is-final");
  const nest = stream.querySelector<HTMLElement>(":scope > .work-fold-nest");
  if (final) stream.appendChild(final);
  nest?.classList.toggle("has-final", !!final);
}

type WorkPaintItem =
  | { kind: "burst"; chips: ToolChip[] }
  | { kind: "text"; text: string; lastIndex: number };

function workPaintItems(work: WorkStep[]): { shown: WorkStep[]; items: WorkPaintItem[] } {
  const shown = displayWorkSteps(work);
  const items: WorkPaintItem[] = [];
  let burst: ToolChip[] = [];
  const flushBurst = () => {
    if (!burst.length) return;
    if (visibleToolChips(burst).length) items.push({ kind: "burst", chips: burst });
    burst = [];
  };
  for (let i = 0; i < shown.length; i++) {
    const step = shown[i];
    if (step.kind === "thought") continue;
    if (step.kind === "text") {
      let text = step.text;
      let last = i;
      while (last + 1 < shown.length) {
        const nxt = shown[last + 1];
        if (nxt.kind === "thought") {
          last += 1;
          continue;
        }
        if (nxt.kind === "text") {
          last += 1;
          text += `\n\n${nxt.text}`;
          continue;
        }
        break;
      }
      i = last;
      if (!isAnswerStep(text)) continue;
      flushBurst();
      items.push({ kind: "text", text, lastIndex: last });
      continue;
    }
    burst.push(step.chip);
  }
  flushBurst();
  return { shown, items };
}

function workPaintShape(items: WorkPaintItem[]): string {
  return items.map((it) => (it.kind === "burst" ? "b" : "x")).join("|");
}

function timelineKidKind(el: HTMLElement): "b" | "x" | null {
  if (el.classList.contains("tool-burst")) return "b";
  if (el.classList.contains("work-step-answer")) return "x";
  return null;
}

function syncLiveWorkTimeline(
  details: HTMLDetailsElement,
  work: WorkStep[],
  opts: { cursor?: boolean; live?: boolean },
): boolean {
  const pane = workTimelinePane(details);
  if (!pane) return false;
  const { shown, items } = workPaintItems(work);
  const kids = [...pane.children].filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && timelineKidKind(el) != null,
  );
  const want = workPaintShape(items);
  const have = kids
    .map((el) => timelineKidKind(el))
    .filter((k): k is "b" | "x" => k != null)
    .join("|");
  if (have && want !== have && !want.startsWith(`${have}|`)) return false;

  const liveTurn = !!(opts.live || opts.cursor);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const liveLast = i === items.length - 1 && liveTurn;
    const el = kids[i];
    if (el) {
      if (item.kind === "burst" && el.classList.contains("tool-burst")) {
        refreshToolBurst(el, item.chips);
        continue;
      }
      if (item.kind === "text" && el.classList.contains("work-step-answer")) {
        fillLiveAnswer(el, item.text, {
          cursor: liveLast && !!opts.cursor,
          live: !!opts.live,
          final: isFinalAnswerAt(shown, item.lastIndex, liveTurn),
        });
        continue;
      }
      return false;
    }
    if (item.kind === "burst") pane.appendChild(makeToolBurst(item.chips));
    else {
      pane.appendChild(
        paintAnswerStep(item.text, {
          cursor: liveLast && !!opts.cursor,
          live: !!opts.live,
          final: isFinalAnswerAt(shown, item.lastIndex, liveTurn),
        }),
      );
    }
  }
  pane.dataset.shape = want;
  placeFinalWorkAnswer(pane);
  return true;
}

function paintWorkTimeline(
  details: HTMLDetailsElement | null,
  work: WorkStep[],
  opts?: { cursor?: boolean; live?: boolean },
) {
  if (!details) return;
  const pane = workTimelinePane(details);
  if (!pane) return;
  if ((opts?.cursor || opts?.live) && syncLiveWorkTimeline(details, work, opts)) {
    return;
  }
  const shape = workStructKey(work);
  const { shown, items } = workPaintItems(work);
  const struct = workStructKey(shown);
  const wasOpen = [
    ...pane.querySelectorAll<HTMLElement>(":scope > .tool-burst"),
  ].map((d) => d.classList.contains("is-open"));
  const stream = pane.closest(".assistant-stream");
  const pinnedFinal = stream?.querySelector<HTMLElement>(
    ":scope > .work-step-answer.is-final",
  );
  const prevAnswers = [
    ...pane.querySelectorAll<HTMLElement>(":scope > .work-step-answer"),
  ];
  if (pinnedFinal && !pane.contains(pinnedFinal)) prevAnswers.push(pinnedFinal);
  pane.dataset.shape = shape;
  pane.dataset.struct = struct;
  pane.replaceChildren();
  let answerI = 0;
  const liveTurn = !!(opts?.live || opts?.cursor);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "burst") {
      pane.appendChild(makeToolBurst(item.chips));
      continue;
    }
    const prev = prevAnswers[answerI++];
    const prevSrc = prev?.dataset.liveSrc || prev?.dataset.mdSrc;
    const liveLast = i === items.length - 1 && liveTurn;
    if (prev && prevSrc === item.text) {
      if (!liveLast && prev.dataset.liveSrc) {
        fillLiveAnswer(prev, item.text, {
          final: isFinalAnswerAt(shown, item.lastIndex, liveTurn),
        });
      } else {
        prev.classList.toggle(
          "is-final",
          isFinalAnswerAt(shown, item.lastIndex, liveTurn),
        );
      }
      pane.appendChild(prev);
      continue;
    }
    pane.appendChild(
      paintAnswerStep(item.text, {
        cursor: liveLast,
        live: !!opts?.live,
        final: isFinalAnswerAt(shown, item.lastIndex, liveTurn),
      }),
    );
  }
  const bursts = [
    ...pane.querySelectorAll<HTMLElement>(":scope > .tool-burst"),
  ];
  bursts.forEach((d, i) => {
    applyBurstOpen(d, i < wasOpen.length ? wasOpen[i] : false);
  });
  placeFinalWorkAnswer(pane);
}

type SourceHit = { label: string; href: string; kind: "url" | "path" };

function queryFromWebTitle(title: string): string | undefined {
  const m = title.match(/^(?:web search|x search):\s*(.*?)\s*$/i);
  const q = m?.[1]?.trim();
  return q || undefined;
}

function xSearchQuery(chip: ToolChip): string {
  const raw = (chip.query ?? "").trim().replace(/^x search:\s*/i, "").trim();
  if (raw && !/^x search:?$/i.test(raw)) return raw;
  return queryFromWebTitle(chip.title) || "";
}

function prettyHostName(host: string): string {
  const base = host.split(".")[0] || host;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function hitFromUrl(href: string): WebHit {
  const host = hostnameOf(href);
  return { title: prettyHostName(host), host, href };
}

function mergeWebOntoChip(into: ToolChip, from: ToolChip) {
  if (from.query) into.query = from.query;
  if (from.path) into.path = from.path;
  if (from.span) into.span = from.span;
  if (from.variant) into.variant = from.variant;
  if (from.hits?.length) into.hits = from.hits;
  if (from.server) into.server = from.server;
}

function isWebChip(chip: ToolChip): boolean {
  if ((chip.variant ?? "").toLowerCase() === "websearch") return true;
  const title = chip.title.trim().toLowerCase();
  const kind = chip.kind.trim().toLowerCase();
  const name = (chip.kind || chip.title).toLowerCase();
  if (name.includes("web_search") || name === "web_fetch") return true;
  if (title === "web" || title.startsWith("web search") || title.startsWith("opened page")) {
    return true;
  }
  return kind === "search" && title.includes("web");
}

function hostnameOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "") || href;
  } catch {
    return href.replace(/^https?:\/\//, "").split("/")[0] || href;
  }
}

function looksLikeUrlText(text: string, href: string): boolean {
  const t = text.trim();
  if (!t || t === href) return true;
  return /^https?:\/\//i.test(t);
}

function familyForHost(host: string): (typeof MCP_FAMILIES)[number] | null {
  const lower = host.toLowerCase();
  const tokens = lower
    .split(".")
    .filter(
      (p) =>
        p &&
        p !== "www" &&
        p !== "com" &&
        p !== "io" &&
        p !== "dev" &&
        p !== "app" &&
        p !== "co" &&
        p !== "so" &&
        p !== "org" &&
        p !== "net" &&
        p !== "ai",
    );
  for (const token of [lower, ...tokens]) {
    for (const f of MCP_FAMILIES) {
      if (f.test.test(token)) return f;
    }
  }
  return null;
}

function linkPreviewLabel(href: string): string {
  const host = hostnameOf(href).toLowerCase();
  if (host === "docs.google.com" || host.endsWith(".docs.google.com")) {
    return "Google Docs";
  }
  if (host === "drive.google.com") return "Google Drive";
  if (host === "mail.google.com") return "Gmail";
  if (host === "calendar.google.com") return "Google Calendar";
  if (host === "sheets.google.com") return "Google Sheets";
  if (host === "x.com" || host === "twitter.com") return "X";
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
    return "YouTube";
  }
  const family = familyForHost(host);
  if (family) return family.label;
  const stem = host.split(".")[0] || host;
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function brandIconForHost(host: string): string {
  const lower = host.toLowerCase();
  if (lower.includes("google.")) return "/mcp-icons/google.png";
  const family = familyForHost(host);
  if (family?.icon) return `/mcp-icons/${family.icon}.png`;
  return "";
}

function paintSourceThumb(chip: HTMLElement, src: SourceHit) {
  const thumb = document.createElement("span");
  thumb.className = "source-thumb";
  thumb.setAttribute("aria-hidden", "true");
  if (src.kind === "path") {
    thumb.innerHTML = MARK_FILE_SVG;
    chip.prepend(thumb);
    return;
  }
  const host = hostnameOf(src.href);
  const local = brandIconForHost(host);
  const fav = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  const img = document.createElement("img");
  img.alt = "";
  img.src = local || fav;
  img.addEventListener("error", () => {
    if (local && img.dataset.stage !== "fav") {
      img.dataset.stage = "fav";
      img.src = fav;
      return;
    }
    img.remove();
    thumb.innerHTML = MARK_LINK_SVG;
  });
  thumb.appendChild(img);
  chip.prepend(thumb);
}

function deriveWebSources(parts: AssistantPart[]): SourceHit[] {
  const out: SourceHit[] = [];
  const seen = new Set<string>();
  const addHref = (href: string, label?: string) => {
    const key = href.replace(/[.,;:]+$/, "").trim();
    if (!key || !/^https?:\/\//i.test(key) || seen.has(key)) return;
    seen.add(key);
    out.push({
      label: (label || "").trim() || linkPreviewLabel(key),
      href: key,
      kind: "url",
    });
  };
  for (const p of parts) {
    if (p.kind !== "tool") continue;
    const chip = p.chip;
    if (!isWebChip(chip) && !isWebFetchChip(chip)) continue;
    for (const h of chip.hits ?? []) addHref(h.href, h.title);
    if (isWebFetchChip(chip)) {
      const u = (chip.path || chip.query || "").trim();
      if (/^https?:\/\//i.test(u)) addHref(u);
    }
  }
  return out.slice(0, 8);
}

function makeSourceRow(sources: SourceHit[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "source-row is-collapsed";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "source-toggle";
  toggle.setAttribute("aria-expanded", "false");
  const count = document.createElement("span");
  count.className = "source-count";
  count.textContent = `${sources.length} source${sources.length === 1 ? "" : "s"}`;
  const chev = document.createElement("span");
  chev.className = "source-chevron";
  chev.setAttribute("aria-hidden", "true");
  chev.appendChild(iconEl(Ico.forward, { size: 16 }));
  toggle.append(count, chev);
  const nest = document.createElement("div");
  nest.className = "source-chips";
  const inner = document.createElement("div");
  inner.className = "source-chips-inner";
  nest.appendChild(inner);
  for (const src of sources) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "source-chip";
    const name = document.createElement("span");
    name.className = "source-chip-name";
    name.textContent = src.label;
    btn.appendChild(name);
    paintSourceThumb(btn, src);
    btn.title = src.href;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (src.kind === "path") void openPath(src.href);
      else void openHttpUrl(src.href, e);
    });
    inner.appendChild(btn);
  }
  inner.addEventListener(
    "wheel",
    (e) => {
      if (inner.scrollWidth <= inner.clientWidth) return;
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!dx) return;
      const max = inner.scrollWidth - inner.clientWidth;
      const next = inner.scrollLeft + dx;
      if (next <= 0 && inner.scrollLeft <= 0) return;
      if (next >= max && inner.scrollLeft >= max) return;
      e.preventDefault();
      inner.scrollLeft = Math.max(0, Math.min(max, next));
    },
    { passive: false },
  );
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const shut = !row.classList.contains("is-collapsed");
    if (motionOk()) {
      row.classList.add("is-motion");
      const onEnd = (ev: TransitionEvent) => {
        if (ev.target !== nest || ev.propertyName !== "grid-template-columns") {
          return;
        }
        row.classList.remove("is-motion");
        nest.removeEventListener("transitionend", onEnd);
      };
      nest.addEventListener("transitionend", onEnd);
    }
    row.classList.toggle("is-collapsed", shut);
    toggle.setAttribute("aria-expanded", shut ? "false" : "true");
  });
  row.append(toggle, nest);
  return row;
}

function appendAnswerExtras(stream: HTMLElement, parts: AssistantPart[]) {
  const extra = docPathsFromParts(parts);
  if (extra.length) stream.dataset.docPaths = extra.join("\n");
  syncDocCards(stream, extra);
  const sources = deriveWebSources(parts);
  if (sources.length) stream.appendChild(makeSourceRow(sources));
}

const DOC_KIND: Record<string, string> = {
  pdf: "PDF",
  doc: "Word",
  docx: "Word",
  ppt: "PowerPoint",
  pptx: "PowerPoint",
  xls: "Excel",
  xlsx: "Excel",
  rtf: "RTF",
  pages: "Pages",
  key: "Keynote",
  numbers: "Numbers",
  epub: "EPUB",
  odt: "Document",
  html: "HTML",
  htm: "HTML",
};

function fileExt(path: string): string {
  const base = shortPathName(path);
  const i = base.lastIndexOf(".");
  if (i <= 0) return "";
  return base.slice(i + 1).toLowerCase();
}

function isDocPath(path: string): boolean {
  return !!DOC_KIND[fileExt(path)];
}

function docKindLabel(path: string): string {
  return `Document - ${DOC_KIND[fileExt(path)] || "File"}`;
}

function docPathsFromParts(parts: AssistantPart[]): string[] {
  const seen: string[] = [];
  for (const p of parts) {
    if (p.kind !== "tool") continue;
    const verb = shortToolName(p.chip);
    if (verb !== "Write" && verb !== "Edit") continue;
    const path = chipPath(p.chip);
    if (!path || !isDocPath(path)) continue;
    takeUniqueDocPath(seen, path);
  }
  return seen;
}

function collectDocPaths(stream: HTMLElement, extra: string[] = []): string[] {
  const seen: string[] = [];
  const add = (raw: string) => {
    const path = raw.trim();
    if (!path || !isDocPath(path)) return;
    takeUniqueDocPath(seen, path);
  };
  for (const p of extra) add(p);
  for (const p of (stream.dataset.docPaths || "").split("\n")) add(p);
  for (const a of stream.querySelectorAll<HTMLAnchorElement>("a.path-link")) {
    add(a.dataset.path || "");
  }
  return seen;
}

function placeDocCards(stream: HTMLElement, wrap: HTMLElement) {
  const sources = stream.querySelector(":scope > .source-row");
  const meta = stream.querySelector(":scope > .msg-answer-meta");
  if (sources) sources.before(wrap);
  else if (meta) meta.before(wrap);
  else stream.appendChild(wrap);
}

function docCardMatches(card: HTMLElement, path: string): boolean {
  const at = card.dataset.path || "";
  if (fsPathsMatch(at, path)) return true;
  const a = shortPathName(at).toLowerCase();
  const b = shortPathName(path).toLowerCase();
  return !!a && a === b;
}

function syncDocCards(stream: HTMLElement, extra: string[] = []) {
  const paths = collectDocPaths(stream, extra);
  const wraps = [...stream.querySelectorAll<HTMLElement>(".doc-cards")];
  let wrap = wraps.find((w) => w.parentElement === stream) ?? wraps[0] ?? null;
  if (!paths.length) {
    for (const w of wraps) w.remove();
    return;
  }
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "doc-cards";
    placeDocCards(stream, wrap);
  }
  for (const w of wraps) {
    if (w === wrap) continue;
    wrap.append(...w.querySelectorAll(".doc-card"));
    w.remove();
  }
  if (wrap.parentElement !== stream) placeDocCards(stream, wrap);
  const keep = new Set<HTMLElement>();
  for (const path of paths) {
    const cards = [...wrap.querySelectorAll<HTMLElement>(".doc-card")];
    const hit = cards.find((c) => !keep.has(c) && docCardMatches(c, path));
    if (hit) {
      if ((hit.dataset.path || "").length < path.length) hit.dataset.path = path;
      keep.add(hit);
      continue;
    }
    const card = makeDocCard(path);
    wrap.appendChild(card);
    keep.add(card);
  }
  for (const card of [...wrap.querySelectorAll<HTMLElement>(".doc-card")]) {
    if (!keep.has(card)) card.remove();
  }
}

function makeDocCard(path: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "doc-card";
  card.dataset.path = path;
  const tile = document.createElement("div");
  tile.className = "doc-tile";
  tile.setAttribute("aria-hidden", "true");
  tile.appendChild(iconEl(Ico.file, { size: 20 }));
  const copy = document.createElement("div");
  copy.className = "doc-copy";
  const name = document.createElement("div");
  name.className = "doc-name";
  name.textContent = shortPathName(path);
  name.title = path;
  const kind = document.createElement("div");
  kind.className = "doc-kind";
  kind.textContent = docKindLabel(path);
  copy.append(name, kind);
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "doc-open";
  openBtn.textContent = "Open in";
  openBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  openBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showDocOpenMenu(openBtn, path);
  });
  card.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".doc-open")) return;
    e.preventDefault();
    void openPath(path);
  });
  card.append(tile, copy, openBtn);
  return card;
}

let docOpenPath: string | null = null;

function hideDocOpenMenu() {
  const menu = docOpenMenu();
  if (menu) menu.hidden = true;
  docOpenPath = null;
}

function placeDocOpenMenu(menu: HTMLElement, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth || 180;
  const mh = menu.offsetHeight || 168;
  const gap = 6;
  let left = r.right - mw;
  left = Math.max(6, Math.min(left, window.innerWidth - mw - 6));
  const below = window.innerHeight - r.bottom - gap;
  const openDown = below >= mh || below >= r.top - gap;
  menu.style.left = `${Math.round(left)}px`;
  if (openDown) {
    menu.style.top = `${Math.round(r.bottom + gap)}px`;
    menu.style.bottom = "auto";
    menu.style.transformOrigin = "top right";
  } else {
    menu.style.top = "auto";
    menu.style.bottom = `${Math.round(window.innerHeight - r.top + gap)}px`;
    menu.style.transformOrigin = "bottom right";
  }
}

function showDocOpenMenu(anchor: HTMLElement, path: string) {
  hideChatContextMenu();
  hideMcpContextMenu();
  hideWaitingMenu();
  const menu = docOpenMenu();
  if (!menu) return;
  if (!menu.hidden && docOpenPath === path) {
    hideDocOpenMenu();
    return;
  }
  docOpenPath = path;
  menu.hidden = false;
  placeDocOpenMenu(menu, anchor);
}

async function openPathWith(path: string, app: string) {
  const target = path.trim();
  if (!target) return;
  try {
    await invoke("open_path_with", { path: target, app });
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

async function downloadPathCopy(path: string) {
  const target = path.trim();
  if (!target) return;
  const dest = await save({
    defaultPath: shortPathName(target),
    title: "Download a copy",
  });
  if (!dest) return;
  try {
    await invoke("copy_path", { from: target, to: dest });
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

type MacAppIcons = {
  preview?: string | null;
  browser?: string | null;
  browserName?: string | null;
  finder?: string | null;
  downloads?: string | null;
};

function setDocMenuIcon(
  action: string,
  path: string | null | undefined,
  fallback: typeof Ico.file,
) {
  const menu = docOpenMenu();
  const btn = menu?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
  if (!btn) return;
  btn.querySelector("svg, img.ctx-item-appico")?.remove();
  if (path) {
    const img = document.createElement("img");
    img.className = "ctx-item-appico";
    img.alt = "";
    img.src = convertFileSrc(path);
    btn.prepend(img);
    return;
  }
  btn.prepend(iconEl(fallback, { size: 16 }));
}

async function paintDocOpenIcons() {
  setDocMenuIcon("preview", null, Ico.file);
  setDocMenuIcon("browser", null, Ico.globe);
  setDocMenuIcon("finder", null, Ico.folder);
  setDocMenuIcon("copy", null, Ico.fileDown);
  try {
    const icons = await invoke<MacAppIcons>("mac_app_icons");
    setDocMenuIcon("preview", icons.preview, Ico.file);
    setDocMenuIcon("browser", icons.browser, Ico.globe);
    setDocMenuIcon("finder", icons.finder, Ico.folder);
    setDocMenuIcon("copy", icons.downloads, Ico.fileDown);
    const browserBtn = docOpenMenu()?.querySelector<HTMLButtonElement>(
      '[data-action="browser"]',
    );
    if (browserBtn && icons.browserName) {
      const ico = browserBtn.querySelector("svg, img.ctx-item-appico");
      browserBtn.textContent = icons.browserName;
      if (ico) browserBtn.prepend(ico);
    }
  } catch {
    /* keep Lucide if the Mac icons fail */
  }
}

function bindDocOpenMenu() {
  const menu = docOpenMenu();
  if (!menu) return;
  void paintDocOpenIcons();
  menu.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-action]",
    );
    const path = docOpenPath;
    const action = btn?.dataset.action;
    hideDocOpenMenu();
    if (!path || !action) return;
    if (action === "preview") void openPathWith(path, "Preview");
    if (action === "browser") void openPathWith(path, "browser");
    if (action === "finder") void revealPath(path);
    if (action === "copy") void downloadPathCopy(path);
  });
}

function syncWorkChrome(
  details: HTMLDetailsElement | null,
  opts: {
    metaText: string;
    work: WorkStep[];
    parts: AssistantPart[];
    open: boolean;
    live?: boolean;
    loader?: LoaderKind | null;
    cursor?: boolean;
  },
) {
  if (!details) return;
  const work = opts.work ?? [];
  const hasTools =
    work.some((s) => s.kind === "tool" && !isQuietToolChip(s.chip)) ||
    opts.parts.some((p) => p.kind === "tool" && !isQuietToolChip(p.chip));
  const hasWork =
    hasTools ||
    !!opts.live ||
    workMetaIsLive(opts.metaText || "") ||
    /^(Worked|Stopped)/.test((opts.metaText || "").trim());
  details.classList.toggle("has-thought", false);
  details.classList.toggle("has-work", hasWork);
  details.closest(".msg-row.assistant")?.classList.toggle("has-work-turn", hasWork);
  details.classList.toggle("is-live", !!opts.live);
  details.hidden = !hasWork;
  const meta = details.querySelector<HTMLElement>(":scope > .assistant-meta");
  if (meta && opts.metaText) {
    paintWorkMeta(meta, opts.metaText, {
      live: opts.live && workMetaIsLive(opts.metaText),
      loader: opts.loader,
    });
  }
  paintWorkTimeline(details, interleaveWorkAnswers(work, opts.parts), {
    cursor: opts.cursor,
    live: opts.live,
  });
  const pinned = details.dataset.userWork;
  const next = pinned ? pinned === "open" : hasWork && opts.open;
  if (details.open !== next) {
    details.dataset.syncing = "1";
    details.open = next;
    details.dataset.syncing = "0";
  }
  details.parentElement
    ?.querySelector(":scope > .assistant-stream > .work-fold-nest")
    ?.classList.toggle("is-collapsed", !details.open);
}

function foldOlderAssistantWork(chat: ChatRuntime) {
  const last = lastAssistantLine(chat);
  const t = paintHostFor(chat);
  if (!t) {
    for (const line of chat.lines) {
      if (line.kind !== "assistant" || line === last) continue;
      if (line.workOpen === true) continue;
      line.workOpen = false;
    }
    return;
  }
  const rows = [
    ...t.querySelectorAll<HTMLElement>(".msg-row.assistant[data-assistant-turn]"),
  ];
  const lastRow = rows[rows.length - 1];
  for (const row of rows) {
    if (row === lastRow) continue;
    const d = row.querySelector<HTMLDetailsElement>(".thought-block.has-work");
    if (!d) continue;
    if (d.dataset.userWork === "open") continue;
    d.open = false;
    row
      .querySelector(".work-fold-nest")
      ?.classList.add("is-collapsed");
  }
  for (const line of chat.lines) {
    if (line.kind !== "assistant" || line === last) continue;
    if (line.workOpen === true) continue;
    line.workOpen = false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type HljsApi = {
  getLanguage(name: string): unknown;
  highlight(
    code: string,
    opts: { language: string; ignoreIllegals: boolean },
  ): { value: string };
};

let hljsApi: HljsApi | null = null;
let hljsLoading: Promise<HljsApi> | null = null;
let codeHighlightRaf = 0;
const codeHighlightNodes: HTMLElement[] = [];
const HYDRATE_BUDGET_MS = 8;
// Huge fences stay as plain code so open does not hitch.
const CODE_HIGHLIGHT_MAX = 48_000;

function loadHljs(): Promise<HljsApi> {
  if (hljsApi) return Promise.resolve(hljsApi);
  if (!hljsLoading) {
    hljsLoading = import("highlight.js/lib/common").then((mod) => {
      hljsApi = mod.default;
      return hljsApi;
    });
  }
  return hljsLoading;
}

function codeLangOf(el: HTMLElement): string {
  const m = /(?:^|\s)language-([\w+-]+)/.exec(el.className);
  return (m?.[1] || "").toLowerCase();
}

function scheduleCodeHighlight(root: HTMLElement) {
  if (mdOpenLight) return;
  const gen = transcriptRestoreGen;
  for (const el of root.querySelectorAll<HTMLElement>("pre > code.hljs")) {
    if (el.dataset.hl !== "1") codeHighlightNodes.push(el);
  }
  if (!codeHighlightNodes.length) return;
  void loadHljs()
    .then((api) => {
      if (gen !== transcriptRestoreGen) return;
      if (codeHighlightRaf) return;
      const step = () => {
        codeHighlightRaf = 0;
        if (gen !== transcriptRestoreGen) {
          codeHighlightNodes.length = 0;
          return;
        }
        const t0 = performance.now();
        while (
          codeHighlightNodes.length &&
          performance.now() - t0 < HYDRATE_BUDGET_MS
        ) {
          const el = codeHighlightNodes.shift();
          if (!el?.isConnected || el.dataset.hl === "1") continue;
          const text = el.textContent ?? "";
          const name = codeLangOf(el);
          el.dataset.hl = "1";
          if (
            !text ||
            text.length > CODE_HIGHLIGHT_MAX ||
            !name ||
            !api.getLanguage(name)
          ) {
            continue;
          }
          try {
            el.innerHTML = api.highlight(text, {
              language: name,
              ignoreIllegals: true,
            }).value;
          } catch {
            /* keep escaped */
          }
        }
        if (codeHighlightNodes.length) {
          codeHighlightRaf = requestAnimationFrame(step);
          return;
        }
        if (findOpen) refreshFindHits({ scroll: false });
      };
      codeHighlightRaf = requestAnimationFrame(step);
    })
    .catch(() => {
      /* keep escaped code */
    });
}

function cancelDeferredHydrate() {
  codeHighlightNodes.length = 0;
  if (codeHighlightRaf) {
    cancelAnimationFrame(codeHighlightRaf);
    codeHighlightRaf = 0;
  }
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|aac|flac)(\?.*)?$/i;

function mediaKind(href: string): "video" | "audio" | "image" {
  if (VIDEO_EXT.test(href)) return "video";
  if (AUDIO_EXT.test(href)) return "audio";
  return "image";
}

function isRemoteMediaSrc(src: string): boolean {
  return /^(https?:|data:|blob:|asset:|tauri:|http:\/\/asset\.localhost|https:\/\/asset\.localhost)/i.test(
    src,
  );
}

function joinProjectPath(cwd: string, rel: string): string {
  const parts = `${cwd.replace(/\/$/, "")}/${rel}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || (part === "" && out.length > 0)) continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/") || "/";
}

function resolveMediaPath(src: string, cwd: string | null): string | null {
  let path = src.trim();
  if (!path || isRemoteMediaSrc(path)) return null;
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(path.replace(/^file:\/\//, ""));
    } catch {
      path = path.replace(/^file:\/\//, "");
    }
  }
  if (path.startsWith("~")) return null;
  if (!path.startsWith("/")) {
    if (!cwd) return null;
    path = joinProjectPath(cwd, path.replace(/^\.\//, ""));
  }
  return path;
}

function renderEditorialBlock(text: string): string {
  const spec = parseDiagram(text);
  const label = spec ? diagramTypeLabel(spec.type) : "diagram";
  return (
    `<div class="diagram-block is-pending" data-kind="editorial">` +
    `<div class="code-toolbar">` +
    `<span class="code-lang">${escapeHtml(label)}</span>` +
    `<div class="diagram-actions">` +
    `<button type="button" class="diagram-toggle">Source</button>` +
    `<button type="button" class="code-copy">Copy</button>` +
    `</div></div>` +
    `<pre class="diagram-source">${escapeHtml(text)}</pre>` +
    `<div class="diagram-preview" aria-busy="true"><span class="diagram-wait">Diagram</span></div>` +
    `</div>`
  );
}

function renderMediaHtml(href: string, alt: string, title?: string | null): string {
  const kind = mediaKind(href);
  const src = escapeHtml(href);
  const altEsc = escapeHtml(alt);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  const extra = ` referrerpolicy="no-referrer" data-src="${src}"`;
  if (kind === "video") {
    return (
      `<figure class="md-media md-media-video">` +
      `<video src="${src}" controls preload="metadata" playsinline${titleAttr}${extra}></video>` +
      `</figure>`
    );
  }
  if (kind === "audio") {
    return (
      `<figure class="md-media md-media-audio">` +
      `<audio src="${src}" controls preload="metadata"${titleAttr}${extra}></audio>` +
      `</figure>`
    );
  }
  return (
    `<figure class="md-media md-media-image">` +
    `<img src="${src}" alt="${altEsc}" loading="lazy"${titleAttr}${extra} />` +
    `</figure>`
  );
}

const mdRenderer = new Renderer();
mdRenderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  if (isEditorialLang(lang)) return renderEditorialBlock(text);
  const langLabel = (lang || "").trim();
  const langClass = langLabel ? ` language-${escapeHtml(langLabel)}` : "";
  const highlighted = escapeHtml(text);
  const label = langLabel || "code";
  return (
    `<div class="code-block">` +
    `<div class="code-toolbar">` +
    `<span class="code-lang">${escapeHtml(label)}</span>` +
    `<button type="button" class="code-copy">Copy</button>` +
    `</div>` +
    `<pre><code class="hljs${langClass}">${highlighted}</code></pre>` +
    `</div>`
  );
};
mdRenderer.image = ({
  href,
  title,
  text,
}: {
  href: string;
  title?: string | null;
  text: string;
}) => renderMediaHtml(href || "", text || "", title);

marked.setOptions({
  gfm: true,
  breaks: false,
  renderer: mdRenderer,
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node instanceof HTMLAnchorElement) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const mdHtmlCache = new Map<string, string>();
const MD_CACHE_MAX = 128;

function renderMarkdownHtml(source: string, opts?: { cache?: boolean }): string {
  const sourceNorm = normalizeMdWraps(source);
  const useCache = opts?.cache !== false;
  if (useCache) {
    const hit = mdHtmlCache.get(sourceNorm);
    if (hit) {
      mdHtmlCache.delete(sourceNorm);
      mdHtmlCache.set(sourceNorm, hit);
      return hit;
    }
  }
  const raw = marked.parse(sourceNorm, { async: false }) as string;
  const html = DOMPurify.sanitize(raw, {
    ADD_ATTR: [
      "target",
      "loading",
      "controls",
      "preload",
      "playsinline",
      "referrerpolicy",
    ],
    ADD_TAGS: ["button"],
  });
  if (useCache && sourceNorm.length > 40) {
    if (mdHtmlCache.size >= MD_CACHE_MAX) {
      const oldest = mdHtmlCache.keys().next().value;
      if (oldest != null) mdHtmlCache.delete(oldest);
    }
    mdHtmlCache.set(sourceNorm, html);
  }
  return html;
}

const MEDIA_ZOOM_MIN = 1;
const MEDIA_ZOOM_MAX = 8;

type GestureScaleEvent = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

let mediaScale = 1;
let mediaTx = 0;
let mediaTy = 0;
let mediaPinchBase = 1;
let mediaViewerGesturesBound = false;

function isMediaViewerOpen(): boolean {
  return mediaOverlay()?.hidden === false;
}

function resetMediaViewTransform() {
  mediaScale = 1;
  mediaTx = 0;
  mediaTy = 0;
  mediaPinchBase = 1;
  const img = mediaOverlayImg();
  if (img) img.style.transform = "";
}

function applyMediaViewTransform() {
  const img = mediaOverlayImg();
  if (!img) return;
  if (mediaScale <= 1.001 && Math.abs(mediaTx) < 0.5 && Math.abs(mediaTy) < 0.5) {
    mediaScale = 1;
    mediaTx = 0;
    mediaTy = 0;
    img.style.transform = "";
    return;
  }
  img.style.transform = `translate(${mediaTx}px, ${mediaTy}px) scale(${mediaScale})`;
}

function clampMediaPan() {
  if (mediaScale <= 1) {
    mediaTx = 0;
    mediaTy = 0;
    return;
  }
  const img = mediaOverlayImg();
  const overlay = mediaOverlay();
  if (!img || !overlay) return;
  const iw = img.offsetWidth * mediaScale;
  const ih = img.offsetHeight * mediaScale;
  const maxX = Math.max(0, (iw - overlay.clientWidth) / 2 + 48);
  const maxY = Math.max(0, (ih - overlay.clientHeight) / 2 + 48);
  mediaTx = Math.min(maxX, Math.max(-maxX, mediaTx));
  mediaTy = Math.min(maxY, Math.max(-maxY, mediaTy));
}

function zoomMediaAt(clientX: number, clientY: number, nextScale: number) {
  const img = mediaOverlayImg();
  if (!img) return;
  const next = Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, nextScale));
  if (next === mediaScale) return;
  const rect = img.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const ratio = next / mediaScale;
  mediaTx += dx - dx * ratio;
  mediaTy += dy - dy * ratio;
  mediaScale = next;
  clampMediaPan();
  applyMediaViewTransform();
}

function bindMediaViewerGestures() {
  if (mediaViewerGesturesBound) return;
  const overlay = mediaOverlay();
  if (!overlay) return;
  mediaViewerGesturesBound = true;

  overlay.addEventListener(
    "wheel",
    (e) => {
      if (!isMediaViewerOpen()) return;
      e.preventDefault();
      if (e.ctrlKey) {
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        zoomMediaAt(e.clientX, e.clientY, mediaScale * Math.exp(-dy * 0.01));
        return;
      }
      if (mediaScale <= 1) return;
      mediaTx -= e.deltaX;
      mediaTy -= e.deltaY;
      clampMediaPan();
      applyMediaViewTransform();
    },
    { passive: false },
  );

  overlay.addEventListener("gesturestart", (e) => {
    if (!isMediaViewerOpen()) return;
    e.preventDefault();
    mediaPinchBase = mediaScale;
  });
  overlay.addEventListener("gesturechange", (e) => {
    if (!isMediaViewerOpen()) return;
    e.preventDefault();
    const g = e as GestureScaleEvent;
    zoomMediaAt(g.clientX, g.clientY, mediaPinchBase * (g.scale || 1));
  });
  overlay.addEventListener("gestureend", (e) => {
    if (!isMediaViewerOpen()) return;
    e.preventDefault();
  });
}

function closeMediaViewer() {
  const overlay = mediaOverlay();
  const img = mediaOverlayImg();
  if (overlay) {
    overlay.hidden = true;
    overlay.setAttribute("hidden", "");
  }
  if (img) {
    img.removeAttribute("src");
    img.alt = "";
  }
  resetMediaViewTransform();
}

function openMediaViewer(src: string, alt: string) {
  const overlay = mediaOverlay();
  const img = mediaOverlayImg();
  if (!overlay || !img || !src) return;
  resetMediaViewTransform();
  img.src = src;
  img.alt = alt;
  overlay.hidden = false;
  overlay.removeAttribute("hidden");
  bindMediaViewerGestures();
}

function markMediaBroken(el: HTMLImageElement | HTMLVideoElement | HTMLAudioElement) {
  const fig = el.closest(".md-media") ?? el.parentElement;
  if (!fig || fig.classList.contains("is-broken")) return;
  fig.classList.add("is-broken");
  el.setAttribute("hidden", "");
  const note = document.createElement("span");
  note.className = "md-media-fallback";
  note.textContent = "Could not load media.";
  fig.appendChild(note);
}

const remoteMediaSrc = new Map<string, string>();
const remoteMediaWait = new Map<string, Promise<string | null>>();

async function resolveRemoteMedia(url: string): Promise<string | null> {
  const hit = remoteMediaSrc.get(url);
  if (hit) return hit;
  let wait = remoteMediaWait.get(url);
  if (!wait) {
    wait = invoke<string>("fetch_remote_media", { url })
      .then((path) => {
        const src = convertFileSrc(path);
        remoteMediaSrc.set(url, src);
        return src;
      })
      .catch(() => null)
      .finally(() => {
        remoteMediaWait.delete(url);
      });
    remoteMediaWait.set(url, wait);
  }
  return wait;
}

function bindMediaError(
  node: HTMLImageElement | HTMLVideoElement | HTMLAudioElement,
  raw: string,
) {
  if (node.dataset.mediaBound === "1") return;
  node.dataset.mediaBound = "1";
  const onFail = () => {
    void recoverRemoteMedia(node, raw);
  };
  node.addEventListener("error", onFail, { once: true });
  if (
    node instanceof HTMLImageElement &&
    node.complete &&
    node.naturalWidth === 0 &&
    (node.currentSrc || node.getAttribute("src"))
  ) {
    onFail();
  }
}

async function recoverRemoteMedia(
  node: HTMLImageElement | HTMLVideoElement | HTMLAudioElement,
  raw: string,
) {
  if (!node.isConnected) return;
  if (node.dataset.proxied === "1" || !/^https?:\/\//i.test(raw)) {
    markMediaBroken(node);
    return;
  }
  node.dataset.proxied = "1";
  const src = await resolveRemoteMedia(raw);
  if (!node.isConnected) return;
  if (!src) {
    markMediaBroken(node);
    return;
  }
  node.addEventListener("error", () => markMediaBroken(node), { once: true });
  node.src = src;
}

function hydrateMedia(root: HTMLElement) {
  const cwd = prefs.activeCwd || activeChat()?.cwd || null;
  const nodes = root.querySelectorAll<HTMLElement>("img, video, audio");
  for (const node of nodes) {
    if (
      !(
        node instanceof HTMLImageElement ||
        node instanceof HTMLVideoElement ||
        node instanceof HTMLAudioElement
      )
    ) {
      continue;
    }
    if (node.closest(".diagram-preview")) continue;
    const raw =
      node.dataset.src ||
      node.getAttribute("src") ||
      "";
    const local = resolveMediaPath(raw, cwd);
    if (local) {
      try {
        node.src = convertFileSrc(local);
      } catch {
        markMediaBroken(node);
        continue;
      }
    } else if (/^https?:\/\//i.test(raw) && remoteMediaSrc.has(raw)) {
      node.src = remoteMediaSrc.get(raw) || node.src;
    }
    bindMediaError(node, raw);
    bindMediaGrowth(node);
  }
}

function bindMediaGrowth(
  node: HTMLImageElement | HTMLVideoElement | HTMLAudioElement,
) {
  const bump = () => {
    if (!node.isConnected) return;
    onTranscriptContentGrew();
  };
  if (node instanceof HTMLImageElement) {
    if (node.complete && node.naturalWidth > 0) return;
    node.addEventListener("load", bump, { once: true });
    return;
  }
  if (node instanceof HTMLVideoElement && node.readyState < 1) {
    node.addEventListener("loadedmetadata", bump, { once: true });
  }
}

function paintDiagramBlock(block: HTMLElement) {
  const src = block.querySelector(".diagram-source")?.textContent ?? "";
  const preview = block.querySelector<HTMLElement>(".diagram-preview");
  if (!preview || !src.trim()) return;
  if (preview.querySelector("svg") && !block.classList.contains("is-pending")) {
    return;
  }
  const svg = drawDiagram(src);
  if (svg) {
    preview.innerHTML = svg;
    preview.removeAttribute("aria-busy");
    block.classList.remove("is-pending", "is-failed");
  } else {
    block.classList.add("is-failed");
    block.classList.remove("is-pending");
    preview.removeAttribute("aria-busy");
    preview.textContent = "Could not draw this diagram.";
  }
  onTranscriptContentGrew();
}

// Slash after + or − is math (`+/−`), not a path start.
const PATH_RE =
  /(?<![\w:/+\-\u2212])(?:~\/|\.\.\/|\.\/|\/)(?!\/)[^\s<>"'`]+/g;
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const HEX_RE =
  /(?<![A-Za-z0-9&#])#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})\b/g;
const MARK_SKIP_SEL =
  "a, pre, code, svg, button, .mark, .code-block, .diagram-block, .md-media";
const HEX_SKIP_SEL =
  "a, pre, svg, button, .mark, .code-block, .diagram-block, .md-media, .hex-swatch";

function isPathToken(raw: string): boolean {
  if (raw === "/" || raw === "./" || raw === "../") return false;
  if (raw.startsWith("//")) return false;
  if (/^\/\d+$/.test(raw)) return false;
  if (!/[A-Za-z0-9]/.test(raw)) return false;
  const body = raw.replace(/^(?:~\/|\.\.\/|\.\/|\/)/, "");
  const first = body.split("/").find(Boolean) ?? "";
  if (!/^[A-Za-z0-9._]/.test(first)) return false;
  return true;
}

function trimPathMatch(raw: string): string {
  return raw.replace(/[.,;:!?]+$/g, "").replace(/\)+$/g, "");
}

const MARK_TOKEN_RE = /(^|[\s])(\/[A-Za-z][\w-]*|@[^\s<>"'`]+)/g;

function markBasename(raw: string): string {
  const p = raw.replace(/\/+$/, "");
  return p.split("/").pop() || p;
}

function filesAbs(files: Map<string, string>, path: string): string | undefined {
  const hit = files.get(path);
  if (hit) return hit;
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed !== path) return files.get(trimmed);
  return files.get(`${path}/`);
}

function isFolderChipPath(raw: string): boolean {
  const p = raw.startsWith("@") ? raw.slice(1) : raw;
  return /\/$/.test(p);
}

function isKnownSlashMark(raw: string): boolean {
  if (!raw.startsWith("/")) return false;
  const name = raw.slice(1).toLowerCase();
  const hit = (c: SlashCmd) => c.name.toLowerCase() === name;
  if (slashCatalog(activeChat()).some(hit)) return true;
  return !!skillCache?.cmds.some(hit);
}

function wrapAtAndSlash(root: HTMLElement, files: Map<string, string>) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(MARK_SKIP_SEL)) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.textContent ?? "";
      MARK_TOKEN_RE.lastIndex = 0;
      return MARK_TOKEN_RE.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) wrapMarkTokens(node, files);
}

function wrapMarkTokens(textNode: Text, files: Map<string, string>) {
  const text = textNode.textContent ?? "";
  MARK_TOKEN_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = MARK_TOKEN_RE.exec(text))) {
    const lead = m[1] ?? "";
    const raw = trimPathMatch(m[2] ?? "");
    if (!raw) continue;
    const start = m.index + lead.length;
    const after = text[start + raw.length] ?? "";
    if (raw.startsWith("/") && after === "/") {
      MARK_TOKEN_RE.lastIndex = start + 1;
      continue;
    }
    if (raw.startsWith("/") && !isKnownSlashMark(raw)) {
      MARK_TOKEN_RE.lastIndex = start + 1;
      continue;
    }
    if (raw.startsWith("@")) {
      const path = raw.slice(1);
      const abs = filesAbs(files, path);
      if (!abs) {
        MARK_TOKEN_RE.lastIndex = start + 1;
        continue;
      }
      const end = start + raw.length;
      if (start > last) frag.append(text.slice(last, start));
      const a = document.createElement("a");
      a.className = "mark mark-at path-link";
      a.href = "#";
      a.dataset.path = abs;
      a.title = path;
      a.textContent = markBasename(path);
      frag.append(a);
      last = end;
      MARK_TOKEN_RE.lastIndex = end;
      continue;
    }
    const end = start + raw.length;
    if (start > last) frag.append(text.slice(last, start));
    const el = document.createElement("span");
    el.className = "mark mark-slash";
    el.textContent = raw.slice(1);
    frag.append(el);
    last = end;
    MARK_TOKEN_RE.lastIndex = end;
  }
  if (last === 0) return;
  if (last < text.length) frag.append(text.slice(last));
  textNode.replaceWith(frag);
}

function isLocalFileHref(href: string): boolean {
  if (!href || href === "#") return false;
  if (href.startsWith("file://")) return true;
  if (href.startsWith("~/")) return true;
  if (href.startsWith("/") && !href.startsWith("//")) return true;
  return false;
}

function promotePathAnchors(root: HTMLElement, files: Map<string, string>) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.classList.contains("path-link") || a.classList.contains("mark-at")) continue;
    const href = a.getAttribute("href") || "";
    if (!isLocalFileHref(href)) continue;
    const key = trimPathMatch(href.replace(/^file:\/\//, ""));
    const abs = filesAbs(files, key);
    if (!abs) {
      a.replaceWith(document.createTextNode(a.textContent ?? ""));
      continue;
    }
    const raw = (a.textContent || "").trim() || key;
    a.classList.add("path-link");
    a.dataset.path = abs;
    a.removeAttribute("target");
    a.href = "#";
    a.title = raw;
    a.textContent = markBasename(key);
  }
}

function paintMarkFavicon(ico: HTMLElement, href: string) {
  const host = hostnameOf(href);
  const local = brandIconForHost(host);
  const fav = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  const img = document.createElement("img");
  img.alt = "";
  img.src = local || fav;
  img.addEventListener("error", () => {
    if (local && img.dataset.stage !== "fav") {
      img.dataset.stage = "fav";
      img.src = fav;
      return;
    }
    ico.innerHTML = MARK_LINK_SVG;
  });
  ico.replaceChildren(img);
}

function fillLinkChip(el: HTMLElement, href: string, text = "") {
  const label = looksLikeUrlText(text, href) ? href : text.trim() || href;
  el.classList.add("mark", "mark-link");
  el.title = href;
  const ico = document.createElement("span");
  ico.className = "mark-ico";
  ico.setAttribute("aria-hidden", "true");
  paintMarkFavicon(ico, href);
  const lab = document.createElement("span");
  lab.className = "mark-lab";
  lab.textContent = label;
  // Word joiner: the favicon box is a wrap point; a long URL would drop under it.
  el.replaceChildren(ico, "\u2060", lab);
}

function stampHttpLinkIcons(root: HTMLElement) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.querySelector(".mark-ico")) continue;
    const href = a.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) {
      fillLinkChip(a, href, (a.textContent ?? "").trim());
    }
  }
}

function stampMarkIcons(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>("a, .mark-slash")) {
    if (el.querySelector(".mark-ico")) continue;
    const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") || "" : "";
    if (/^https?:\/\//i.test(href)) {
      fillLinkChip(el, href, (el.textContent ?? "").trim());
      continue;
    }
    const label = (el.textContent ?? "").trim();
    const ico = document.createElement("span");
    ico.className = "mark-ico";
    ico.setAttribute("aria-hidden", "true");
    if (el.classList.contains("mark-slash")) ico.innerHTML = MARK_SLASH_SVG;
    else if (el.classList.contains("mark-at") || el.classList.contains("path-link")) {
      const hint =
        (el instanceof HTMLAnchorElement && (el.title || el.dataset.path)) ||
        label;
      ico.innerHTML = isFolderChipPath(hint) ? MARK_FOLDER_SVG : MARK_FILE_SVG;
    } else {
      ico.innerHTML = MARK_LINK_SVG;
    }
    const lab = document.createElement("span");
    lab.className = "mark-lab";
    lab.textContent = label;
    if (!el.classList.contains("mark")) el.classList.add("mark");
    el.replaceChildren(ico, lab);
  }
}

function wrapUrlLinks(textNode: Text) {
  const text = textNode.textContent ?? "";
  URL_RE.lastIndex = 0;
  if (!URL_RE.test(text)) return;
  URL_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    const raw = trimPathMatch(m[0]);
    if (!raw) continue;
    const start = m.index;
    const end = start + raw.length;
    if (start > last) frag.append(text.slice(last, start));
    const a = document.createElement("a");
    a.href = raw;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    fillLinkChip(a, raw, raw);
    frag.append(a);
    last = end;
    URL_RE.lastIndex = end;
  }
  if (last === 0) return;
  if (last < text.length) frag.append(text.slice(last));
  textNode.replaceWith(frag);
}

function cssHex(raw: string): string {
  const h = raw.slice(1);
  if (h.length === 3 || h.length === 4) {
    return `#${[...h].map((c) => c + c).join("")}`;
  }
  return raw;
}

function wrapHexSwatches(textNode: Text) {
  const text = textNode.textContent ?? "";
  HEX_RE.lastIndex = 0;
  if (!HEX_RE.test(text)) return;
  HEX_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = HEX_RE.exec(text))) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    if (start > last) frag.append(text.slice(last, start));
    const wrap = document.createElement("span");
    wrap.className = "hex-swatch";
    wrap.append(raw);
    const chip = document.createElement("span");
    chip.className = "hex-swatch-chip";
    chip.style.background = cssHex(raw);
    chip.setAttribute("aria-hidden", "true");
    wrap.appendChild(chip);
    frag.appendChild(wrap);
    last = end;
    HEX_RE.lastIndex = end;
  }
  if (last === 0) return;
  if (last < text.length) frag.append(text.slice(last));
  textNode.replaceWith(frag);
}

function linkifyHexColors(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(HEX_SKIP_SEL)) return NodeFilter.FILTER_REJECT;
      const code = parent.closest("code");
      if (code && code.closest("pre, .code-block")) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.textContent ?? "";
      HEX_RE.lastIndex = 0;
      return HEX_RE.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) wrapHexSwatches(node);
}

function linkifyUrls(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(MARK_SKIP_SEL)) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.textContent ?? "";
      URL_RE.lastIndex = 0;
      return URL_RE.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) wrapUrlLinks(node);
}

function chipProjectCwd(): string | null {
  const cwd = activeChat()?.cwd || prefs.activeCwd || "";
  if (!cwd || isRecentsCwd(cwd)) return null;
  return cwd;
}

function paintUserText(el: HTMLElement, text: string) {
  el.replaceChildren();
  if (!text) return;
  const hits = collectPluginMarkHits(text, pluginChipMeta.keys());
  hits.sort((a, b) => a.start - b.start || b.raw.length - a.raw.length);
  let last = 0;
  let end = 0;
  for (const h of hits) {
    if (h.start < end) continue;
    if (h.start > last) el.append(text.slice(last, h.start));
    const chip = composerChip(h.raw);
    chip.removeAttribute("contenteditable");
    el.appendChild(chip);
    last = h.start + h.raw.length;
    end = last;
  }
  if (last < text.length) el.append(text.slice(last));
  linkifyUrls(el);
  stampHttpLinkIcons(el);
  linkifyHexColors(el);
  if (!mdOpenLight) void linkifyProjectFiles(el);
}

function wrapPathLinks(textNode: Text, files: Map<string, string>) {
  const text = textNode.textContent ?? "";
  PATH_RE.lastIndex = 0;
  if (!PATH_RE.test(text)) return;
  PATH_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text))) {
    const raw = trimPathMatch(m[0]);
    const abs = raw && isPathToken(raw) ? filesAbs(files, raw) : undefined;
    if (!raw || !abs) {
      PATH_RE.lastIndex = m.index + 1;
      continue;
    }
    const start = m.index;
    const end = start + raw.length;
    if (start > last) frag.append(text.slice(last, start));
    const a = document.createElement("a");
    a.className = "path-link";
    a.href = "#";
    a.dataset.path = abs;
    a.title = raw;
    a.textContent = markBasename(raw);
    frag.append(a);
    last = end;
    PATH_RE.lastIndex = end;
  }
  if (last === 0) return;
  if (last < text.length) frag.append(text.slice(last));
  textNode.replaceWith(frag);
}

function linkifyPaths(root: HTMLElement, files: Map<string, string>) {
  if (!files.size) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(MARK_SKIP_SEL)) {
        return NodeFilter.FILTER_REJECT;
      }
      const text = node.textContent ?? "";
      PATH_RE.lastIndex = 0;
      return PATH_RE.test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) wrapPathLinks(node, files);
}

function collectPathCandidates(root: HTMLElement): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const t = trimPathMatch(raw);
    if (!t || seen.has(t) || out.length >= 64) return;
    seen.add(t);
    out.push(t);
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(MARK_SKIP_SEL)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n.textContent ?? "";
    PATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PATH_RE.exec(text))) {
      const raw = trimPathMatch(m[0]);
      if (!raw || !isPathToken(raw)) {
        PATH_RE.lastIndex = m.index + 1;
        continue;
      }
      add(raw);
      PATH_RE.lastIndex = m.index + raw.length;
    }
    MARK_TOKEN_RE.lastIndex = 0;
    while ((m = MARK_TOKEN_RE.exec(text))) {
      const lead = m[1] ?? "";
      const raw = trimPathMatch(m[2] ?? "");
      if (!raw) continue;
      const start = m.index + lead.length;
      if (!raw.startsWith("@")) {
        MARK_TOKEN_RE.lastIndex = start + 1;
        continue;
      }
      const path = raw.slice(1);
      add(path);
      const trimmed = path.replace(/\/+$/, "");
      if (trimmed && trimmed !== path) add(trimmed);
      MARK_TOKEN_RE.lastIndex = start + raw.length;
    }
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.classList.contains("path-link") || a.classList.contains("mark-at")) continue;
    const href = a.getAttribute("href") || "";
    if (!isLocalFileHref(href)) continue;
    add(href.replace(/^file:\/\//, ""));
  }
  return out;
}

function linkifyTargets(root: HTMLElement): HTMLElement[] {
  if (
    root.classList.contains("user-bubble") ||
    root.classList.contains("assistant-body")
  ) {
    return [root];
  }
  const parts = [
    ...root.querySelectorAll<HTMLElement>(".user-bubble, .assistant-body"),
  ];
  return parts.length ? parts : [root];
}

async function linkifyProjectFilesNode(root: HTMLElement) {
  const seq = String(Number(root.dataset.pathChipSeq || "0") + 1);
  root.dataset.pathChipSeq = seq;
  const cwd = chipProjectCwd();
  const raws = cwd ? collectPathCandidates(root) : [];
  const files = new Map<string, string>();
  if (cwd && raws.length) {
    try {
      const hits = await invoke<Array<{ raw: string; path: string }>>(
        "project_paths_exist",
        { cwd, paths: raws },
      );
      for (const h of hits) {
        if (h?.raw && h.path) files.set(h.raw, h.path);
      }
    } catch {}
  }
  if (!root.isConnected || root.dataset.pathChipSeq !== seq) return;
  linkifyPaths(root, files);
  wrapAtAndSlash(root, files);
  promotePathAnchors(root, files);
  stampMarkIcons(root);
  const stream = root.closest(".assistant-stream");
  if (stream instanceof HTMLElement) syncDocCards(stream);
}

async function linkifyProjectFiles(root: HTMLElement) {
  const targets = linkifyTargets(root);
  if (targets.length === 1 && targets[0] === root) {
    await linkifyProjectFilesNode(root);
    return;
  }
  await Promise.all(targets.map((el) => linkifyProjectFilesNode(el)));
}

async function revealPath(path: string) {
  const target = path.trim();
  if (!target) return;
  try {
    await invoke("reveal_in_finder", { path: target });
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

async function openPath(path: string) {
  const target = path.trim();
  if (!target) return;
  try {
    await invoke("open_path", { path: target });
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

async function openHttpUrl(url: string, ev?: MouseEvent) {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) return;
  if (ev?.metaKey || ev?.ctrlKey) {
    try {
      await invoke("open_url", { url: target });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  const main = activeChat();
  if (main && canUseSideChat(main)) {
    addPageTab(target);
    return;
  }
  try {
    await invoke("open_url", { url: target });
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

function flattenLinks(root: HTMLElement) {
  for (const a of [...root.querySelectorAll("a")]) {
    a.replaceWith(document.createTextNode(a.textContent ?? ""));
  }
}

function wrapMarkdownTables(root: HTMLElement) {
  for (const table of [...root.querySelectorAll("table")]) {
    if (!table.parentElement?.classList.contains("md-table")) {
      const wrap = document.createElement("div");
      wrap.className = "md-table";
      table.replaceWith(wrap);
      wrap.appendChild(table);
    }
    for (const cell of table.querySelectorAll("th, td")) {
      if (cell.querySelector(":scope > .md-cell")) continue;
      const inner = document.createElement("span");
      inner.className = "md-cell";
      inner.append(...cell.childNodes);
      cell.appendChild(inner);
    }
  }
}

/** True while rebuilding a chat: first paint skips diagrams and path IPC. */
let mdOpenLight = false;

function splitMarkdownParagraphBreaks(root: HTMLElement) {
  for (const p of [...root.querySelectorAll("p")]) {
    const chunks: Node[][] = [[]];
    for (const n of [...p.childNodes]) {
      if (n instanceof HTMLBRElement) {
        chunks.push([]);
        continue;
      }
      chunks[chunks.length - 1]?.push(n);
    }
    if (chunks.length < 2) continue;
    const parent = p.parentNode;
    if (!parent) continue;
    for (const nodes of chunks) {
      const next = document.createElement("p");
      next.append(...nodes);
      if (!next.textContent?.trim() && !next.querySelector("img, video, audio, svg")) {
        continue;
      }
      parent.insertBefore(next, p);
    }
    p.remove();
  }
}

function hydrateMarkdown(
  root: HTMLElement,
  opts?: { drawDiagrams?: boolean; linkify?: boolean; media?: boolean },
) {
  splitMarkdownParagraphBreaks(root);
  wrapMarkdownTables(root);
  if (opts?.media !== false) hydrateMedia(root);
  if (opts?.linkify === false) flattenLinks(root);
  else {
    linkifyUrls(root);
    stampHttpLinkIcons(root);
    if (!mdOpenLight) void linkifyProjectFiles(root);
  }
  linkifyHexColors(root);
  if (opts?.drawDiagrams !== false && !mdOpenLight) {
    scheduleCodeHighlight(root);
  }
}

function hydrateTranscriptExtras(host: HTMLElement | null) {
  if (!host) return;
  void linkifyProjectFiles(host);
  scheduleCodeHighlight(host);
}

function setMarkdown(
  body: HTMLElement,
  text: string,
  opts?: { drawDiagrams?: boolean; linkify?: boolean; media?: boolean },
) {
  body.classList.add("markdown");
  body.classList.remove("is-live-type");
  delete body.dataset.liveSrc;
  body.dataset.mdSrc = text;
  if (!text) {
    body.replaceChildren();
    return;
  }
  body.innerHTML = renderMarkdownHtml(text);
  hydrateMarkdown(body, opts);
}

function fillAssistantBody(
  body: HTMLElement,
  text: string,
  opts?: { error?: boolean; drawDiagrams?: boolean },
) {
  if (opts?.error) {
    body.classList.add("error");
    body.textContent = text;
    return;
  }
  setMarkdown(body, text, { drawDiagrams: opts?.drawDiagrams });
}

function renderPartsInto(
  stream: HTMLElement,
  parts: AssistantPart[],
  opts?: { error?: boolean; cursor?: boolean },
) {
  const nest = stream.querySelector<HTMLElement>(":scope > .work-fold-nest");
  for (const child of [...stream.children]) {
    if (child === nest) continue;
    if (child.classList.contains("work-step-answer")) continue;
    if (child.classList.contains("live-work-caption")) continue;
    if (child.classList.contains("msg-answer-meta")) continue;
    child.remove();
  }

  if (opts?.error) {
    const body = document.createElement("div");
    body.className = "assistant-body error";
    fillAssistantBody(body, joinTextParts(parts), { error: true });
    stream.appendChild(body);
    return;
  }

  if (!opts?.cursor) appendAnswerExtras(stream, parts);
}

async function copyCodeBlock(btn: HTMLButtonElement) {
  const block = btn.closest(".code-block, .diagram-block");
  const code =
    block?.querySelector(".diagram-source")?.textContent ??
    block?.querySelector("code")?.textContent ??
    "";
  try {
    await navigator.clipboard.writeText(code);
    const prev = btn.textContent;
    btn.textContent = "Copied";
    btn.classList.add("is-copied");
    window.setTimeout(() => {
      btn.textContent = prev || "Copy";
      btn.classList.remove("is-copied");
    }, 1400);
  } catch {
    btn.textContent = "Failed";
    window.setTimeout(() => {
      btn.textContent = "Copy";
    }, 1400);
  }
}

function appendAssistantDom(
  parts: AssistantPart[],
  metaText: string,
  opts?: {
    error?: boolean;
    thought?: string;
    workOpen?: boolean;
    cursor?: boolean;
    at?: number;
    line?: AssistantLine;
    live?: boolean;
    loader?: LoaderKind | null;
    enter?: boolean;
    host?: HTMLElement | null;
  },
): AssistantDom {
  const t = opts?.host ?? transcript();
  const row = document.createElement("div");
  row.className = "msg-row assistant";
  row.dataset.assistantTurn = "1";
  if (opts?.enter) row.classList.add("msg-enter");

  const thoughtText = opts?.thought ?? "";
  const workOpen = opts?.workOpen ?? true;
  const loader = opts?.loader ?? opts?.line?.loader ?? null;
  const work = opts?.line?.work ?? (thoughtText.trim() ? [{ kind: "thought" as const, text: thoughtText }] : []);

  const thoughtDetails = document.createElement("details");
  thoughtDetails.className = "thought-block";

  const meta = document.createElement("summary");
  meta.className = "assistant-meta";
  paintWorkMeta(meta, metaText, {
    live: opts?.live && workMetaIsLive(metaText),
    loader,
  });

  // Header only. Answers live in the stream so fold-shut does not hide them.
  thoughtDetails.append(meta);
  const stream = document.createElement("div");
  stream.className = "assistant-stream";
  const nest = document.createElement("div");
  nest.className = "work-fold-nest";
  const inner = document.createElement("div");
  inner.className = "work-fold-inner";
  const timeline = document.createElement("div");
  timeline.className = "work-timeline";
  inner.appendChild(timeline);
  nest.appendChild(inner);
  stream.appendChild(nest);
  row.append(thoughtDetails, stream);

  syncWorkChrome(thoughtDetails, {
    metaText,
    work,
    parts,
    open: workOpen,
    live: opts?.live,
    loader,
    cursor: opts?.cursor,
  });
  meta.addEventListener("click", (e) => {
    if (!thoughtDetails.classList.contains("has-work")) return;
    e.preventDefault();
    const open = !thoughtDetails.open;
    thoughtDetails.dataset.syncing = "1";
    thoughtDetails.open = open;
    thoughtDetails.dataset.syncing = "0";
    if (opts?.line) {
      opts.line.workOpen = open;
      thoughtDetails.dataset.userWork = open ? "open" : "shut";
    }
    const scroller = thoughtDetails.closest(".transcript, .side-transcript");
    animateWorkNest(
      nest,
      open,
      scroller instanceof HTMLElement ? scroller : null,
      meta,
    );
  });

  renderPartsInto(stream, parts, {
    error: opts?.error,
    cursor: opts?.cursor,
  });
  if (!opts?.live) {
    stampAnswerMeta(answerMetaHost(stream, row), {
      at: opts?.at,
      markdown: joinTextParts(parts),
    });
  }
  t?.appendChild(row);
  if (!opts?.live) markLastAssistant(t);
  return { row, meta, stream, thoughtDetails };
}

function syncLiveWork(
  chat: ChatRuntime,
  parts: AssistantPart[],
  open: boolean,
  cursor?: boolean,
  live?: boolean,
) {
  const last = lastAssistantLine(chat);
  const metaText =
    last?.meta ||
    chat.liveMeta?.querySelector(".work-meta-text")?.textContent ||
    chat.liveMeta?.textContent ||
    "";
  const isLive =
    live ?? !!(turnIsLive(chat) && last && last === lastAssistantLine(chat));
  syncWorkChrome(chat.liveThoughtDetails, {
    metaText,
    work: last?.work ?? [],
    parts,
    open,
    live: isLive,
    loader: last?.loader,
    cursor,
  });
  syncLiveWorkCaption(chat, isLive);
}

let streamPaintRaf = 0;
const streamPaintPend = new Map<
  string,
  { chat: ChatRuntime; parts: AssistantPart[] | null; thought: boolean }
>();

function cancelStreamPaint(chat?: ChatRuntime) {
  if (chat) {
    streamPaintPend.delete(chat.key);
    if (streamPaintPend.size) return;
  } else {
    streamPaintPend.clear();
  }
  if (streamPaintRaf) {
    cancelAnimationFrame(streamPaintRaf);
    streamPaintRaf = 0;
  }
}

function flushStreamPaint() {
  streamPaintRaf = 0;
  const batch = [...streamPaintPend.values()];
  streamPaintPend.clear();
  for (const { chat, parts, thought } of batch) {
    if (!chatVisible(chat)) continue;
    if (parts) paintPartsNow(chat, parts, { cursor: true });
    else if (thought) {
      paintThoughtNow(chat, { open: isWorkOpen(chat, lastAssistantLine(chat)) });
    }
  }
}

function armStreamPaint() {
  if (!streamPaintRaf) streamPaintRaf = requestAnimationFrame(flushStreamPaint);
}

function scheduleStreamParts(chat: ChatRuntime, parts: AssistantPart[]) {
  const cur = streamPaintPend.get(chat.key) ?? {
    chat,
    parts: null,
    thought: false,
  };
  cur.chat = chat;
  cur.parts = parts;
  streamPaintPend.set(chat.key, cur);
  armStreamPaint();
}

function scheduleStreamThought(chat: ChatRuntime) {
  const cur = streamPaintPend.get(chat.key) ?? {
    chat,
    parts: null,
    thought: false,
  };
  cur.chat = chat;
  cur.thought = true;
  streamPaintPend.set(chat.key, cur);
  armStreamPaint();
}

function paintThoughtNow(
  chat: ChatRuntime,
  opts: { open?: boolean; meta?: string },
) {
  const last = lastAssistantLine(chat);
  if (!last || !chat.liveThoughtDetails?.isConnected) return;
  syncLiveWork(chat, last.parts, opts.open ?? isWorkOpen(chat, last));
  if (opts.meta != null && chat.liveMeta) {
    paintWorkMeta(chat.liveMeta, opts.meta, {
      live: workMetaIsLive(opts.meta),
      loader: last.loader,
    });
  }
}

function paintThought(
  chat: ChatRuntime,
  opts: { open?: boolean; meta?: string },
) {
  if (chat.runInFlight && opts.meta == null) {
    scheduleStreamThought(chat);
    return;
  }
  cancelStreamPaint(chat);
  paintThoughtNow(chat, opts);
}

function stampAssistantTime(chat: ChatRuntime) {
  const last = lastAssistantLine(chat);
  const stream = chat.liveStream;
  if (!last || !stream?.isConnected) return;
  if (!last.at) last.at = Date.now();
  stampAnswerMeta(answerMetaHost(stream, chat.liveRow), {
    at: last.at,
    markdown: joinTextParts(last.parts),
  });
  markLastAssistant(transcript());
}

function paintPartsNow(
  chat: ChatRuntime,
  parts: AssistantPart[],
  opts?: { error?: boolean; cursor?: boolean },
) {
  if (!chat.liveStream?.isConnected) return;
  const last = lastAssistantLine(chat);
  syncLiveWork(
    chat,
    parts,
    isWorkOpen(chat, last),
    opts?.cursor,
    opts?.cursor && !opts.error ? undefined : false,
  );
  if (!opts?.cursor || opts.error) {
    renderPartsInto(chat.liveStream, parts, opts);
    if (!opts?.cursor) {
      stampAssistantTime(chat);
      refreshLastJumpAnswer(chat);
    }
  }
  if (chat.surface === "panel") scrollSideTranscript();
  else scrollTranscript();
}

function paintParts(
  chat: ChatRuntime,
  parts: AssistantPart[],
  opts?: { error?: boolean; cursor?: boolean },
) {
  if (opts?.cursor && !opts.error) {
    scheduleStreamParts(chat, parts);
    return;
  }
  cancelStreamPaint(chat);
  paintPartsNow(chat, parts, opts);
}

function parkChatPane(chat: ChatRuntime | null) {
  if (!chat || chat.surface !== "main") return;
  const t = transcript();
  if (!t) return;
  saveTranscriptScroll(chat);
  clearFindMarks(t);
  const frag = document.createDocumentFragment();
  while (t.firstChild) frag.appendChild(t.firstChild);
  chat.pane = frag;
  chat.paneLines = chat.lines.length;
  chat.paneLive = chat.runInFlight;
}

function restoreChatPane(chat: ChatRuntime): boolean {
  if (chat.surface !== "main") return false;
  const t = transcript();
  const pane = chat.pane;
  if (!t || !pane?.childNodes.length) return false;
  if (chat.paneLines !== chat.lines.length) return false;
  if (chat.paneLive !== chat.runInFlight) return false;
  t.append(pane);
  chat.pane = null;
  return true;
}

function applyParkedTranscript(chat: ChatRuntime) {
  const t = transcript();
  ignoreTranscriptScroll = true;
  restoreTranscriptScroll(chat);
  if (chat.runInFlight) {
    const last = lastAssistantLine(chat);
    if (last && chat.liveStream?.isConnected) {
      paintPartsNow(chat, last.parts, { cursor: turnIsLive(chat) });
      fillLiveTurn(chat);
    } else {
      rebuildTranscript(chat);
      return;
    }
  }
  markLastAssistant(t);
  setStatus(chat.status);
  ignoreTranscriptScroll = false;
  syncJumpLatest();
  paintPromptJumps(chat);
  refreshFindHits({ scroll: false });
}

function rebuildTranscript(chat: ChatRuntime, host?: HTMLElement | null) {
  cancelStreamPaint(chat);
  cancelDeferredHydrate();
  chat.pane = null;
  ignoreTranscriptScroll = true;
  const restoreGen = ++transcriptRestoreGen;
  const t = host ?? paintHostFor(chat) ?? transcript();
  clearTranscriptDom(t);
  clearLiveDom(chat);

  mdOpenLight = true;
  try {
    for (const line of chat.lines) {
      if (line.kind === "user") {
        appendUserDom(line.text, line.at, line.attachments, t);
      } else if (line.kind === "assistant") {
        const streaming =
          !!chat.runInFlight && lastAssistantLine(chat) === line;
        const live = streaming && turnIsLive(chat);
        const shell = appendAssistantDom(line.parts, line.meta, {
          error: line.error,
          thought: line.thought,
          at: line.at,
          line,
          workOpen: isWorkOpen(chat, line),
          live,
          cursor: live,
          loader: line.loader,
          host: t,
        });
        if (streaming) {
          bindLiveAssistant(chat, shell);
        }
      } else if (line.kind === "question") {
        renderQuestionDom(line.req, chat, line.resolved);
      } else if (line.kind === "plan") {
        renderPlanDom(line.req, chat, line.resolved);
      }
    }
  } finally {
    mdOpenLight = false;
  }
  markLastAssistant(t);
  const finishHydrate = () => {
    if (restoreGen !== transcriptRestoreGen) return;
    ignoreTranscriptScroll = true;
    if (t) hydrateTranscriptExtras(t);
    ignoreTranscriptScroll = false;
    if (chat.surface !== "panel") restoreTranscriptScroll(chat);
    refreshFindHits({ scroll: false });
  };
  if (chat.surface === "panel") {
    paintSideEmpty(chat);
    refreshSideRetryChrome(chat);
    refreshSideEditChrome(chat);
    renderSideWaiting(chat);
    ignoreTranscriptScroll = false;
    refreshFindHits({ scroll: false });
    requestAnimationFrame(finishHydrate);
    return;
  }
  setStatus(chat.status);
  syncEmptyMain(chat);
  setChatName(
    chat.sessionId
      ? displayTitle(chat.cwd, chat.sessionId, chat.title)
      : chat.title,
  );
  paintTopbarTitle();
  refreshUserEditChrome();
  refreshRetryChrome();
  if (chat.runInFlight) fillLiveTurn(chat);
  restoreTranscriptScroll(chat);
  requestAnimationFrame(() => {
    if (restoreGen !== transcriptRestoreGen) return;
    restoreTranscriptScroll(chat);
    ignoreTranscriptScroll = false;
    syncJumpLatest();
    paintPromptJumps(chat);
    finishHydrate();
  });
  refreshFindHits({ scroll: false });
}

let findOpen = false;
let findSide = false;
type FindSpot = { root: HTMLElement; nth: number };
let findSpots: FindSpot[] = [];
let findMark: HTMLElement | null = null;
let findIndex = 0;

function findHostRoot(): HTMLElement | null {
  return findSide ? sideTranscript() : transcript();
}

function clearFindMarks(root: ParentNode | null) {
  if (!root) return;
  root.querySelectorAll("mark.find-hit").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    if (parent instanceof HTMLElement) parent.normalize();
  });
}

function unwrapAllFindMarks() {
  clearFindMarks(transcript());
  clearFindMarks(sideTranscript());
  findSpots = [];
  findMark = null;
}

function findSkipNode(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  if (!el) return true;
  return !!el.closest(
    "mark.find-hit, .is-live-type, .live-type, .work-timeline, .assistant-meta, .msg-time, .msg-answer-meta, .live-work-caption, button, textarea, input, svg",
  );
}

function countFindMatches(root: HTMLElement, needle: string): number {
  const n = needle.toLowerCase();
  if (!n) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (findSkipNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let count = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const lower = (node.nodeValue ?? "").toLowerCase();
    let from = 0;
    while (from <= lower.length - n.length) {
      const i = lower.indexOf(n, from);
      if (i < 0) break;
      count += 1;
      from = i + n.length;
    }
  }
  return count;
}

function wrapNthFindMatch(
  root: HTMLElement,
  needle: string,
  nth: number,
): HTMLElement | null {
  const n = needle.toLowerCase();
  if (!n || nth < 0) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (findSkipNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let seen = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const raw = textNode.nodeValue ?? "";
    const lower = raw.toLowerCase();
    let from = 0;
    while (from <= lower.length - n.length) {
      const i = lower.indexOf(n, from);
      if (i < 0) break;
      if (seen === nth) {
        const hit = i > 0 ? textNode.splitText(i) : textNode;
        hit.splitText(n.length);
        const mark = document.createElement("mark");
        mark.className = "find-hit is-cur";
        hit.parentNode?.insertBefore(mark, hit);
        mark.appendChild(hit);
        return mark;
      }
      seen += 1;
      from = i + n.length;
    }
  }
  return null;
}

function paintFindCount() {
  const el = findCountEl();
  if (!el) return;
  const total = findSpots.length;
  const cur = total === 0 ? 0 : findIndex + 1;
  el.textContent = `${cur} of ${total}`;
}

function setFindCurrent(i: number, scroll = true) {
  if (findMark) {
    const root = findMark.parentNode;
    while (findMark.firstChild) root?.insertBefore(findMark.firstChild, findMark);
    findMark.remove();
    if (root instanceof HTMLElement) root.normalize();
    findMark = null;
  }
  if (findSpots.length === 0) {
    findIndex = 0;
    paintFindCount();
    return;
  }
  findIndex = ((i % findSpots.length) + findSpots.length) % findSpots.length;
  const spot = findSpots[findIndex];
  const needle = (findInput()?.value ?? "").trim();
  findMark = spot ? wrapNthFindMatch(spot.root, needle, spot.nth) : null;
  paintFindCount();
  if (scroll && findMark) {
    findMark.scrollIntoView({ block: "center", inline: "nearest" });
  }
}

let findHitsTimer = 0;

function refreshFindHits(opts?: { scroll?: boolean }) {
  if (findHitsTimer) {
    window.clearTimeout(findHitsTimer);
    findHitsTimer = 0;
  }
  if (!findOpen) return;
  unwrapAllFindMarks();
  const q = findInput()?.value ?? "";
  const needle = q.trim();
  const root = findHostRoot();
  if (!needle || !root) {
    paintFindCount();
    return;
  }
  const roots = [
    ...root.querySelectorAll<HTMLElement>(".user-bubble"),
    ...root.querySelectorAll<HTMLElement>(".assistant-body"),
  ];
  for (const el of roots) {
    if (el.classList.contains("is-live-type")) continue;
    const n = countFindMatches(el, needle);
    for (let i = 0; i < n; i++) findSpots.push({ root: el, nth: i });
  }
  setFindCurrent(0, opts?.scroll !== false);
}

function placeFindBar() {
  const bar = findBar();
  const host = findSide ? panelBody() ?? sidePane() : mainPane();
  if (!bar || !host) return;
  if (bar.parentElement !== host) host.prepend(bar);
  mainPane()?.classList.toggle("find-open", findOpen && !findSide);
  sidePane()?.classList.toggle("find-open", findOpen && findSide);
}

function scheduleFindHits(opts?: { scroll?: boolean }) {
  if (!findOpen) return;
  const q = findInput()?.value ?? "";
  if (!q.trim()) {
    refreshFindHits(opts);
    return;
  }
  if (findHitsTimer) window.clearTimeout(findHitsTimer);
  findHitsTimer = window.setTimeout(() => {
    findHitsTimer = 0;
    refreshFindHits(opts);
  }, 80);
}

function closeFind() {
  if (!findOpen) return;
  findOpen = false;
  findSide = false;
  if (findHitsTimer) {
    window.clearTimeout(findHitsTimer);
    findHitsTimer = 0;
  }
  unwrapAllFindMarks();
  findIndex = 0;
  const bar = findBar();
  const field = findInput();
  if (bar) {
    bar.hidden = true;
    bar.setAttribute("hidden", "");
  }
  if (field) field.value = "";
  paintFindCount();
  placeFindBar();
}

function canFind(): boolean {
  if (pageOpen()) return false;
  return !isCenteredComposer(activeChat());
}

function openFind() {
  if (!canFind()) return;
  findSide =
    isSidePanelOpen() &&
    !!frontAgent() &&
    !!sidePane()?.contains(document.activeElement);
  findOpen = true;
  const bar = findBar();
  if (bar) {
    bar.hidden = false;
    bar.removeAttribute("hidden");
  }
  placeFindBar();
  refreshFindHits();
  const field = findInput();
  field?.focus();
  field?.select();
}

function stepFind(delta: number) {
  if (!findOpen || findSpots.length === 0) return;
  setFindCurrent(findIndex + delta);
}

/** Unused New chat with no session, lines, draft text, or waiting — hide and prune. */
function isEmptyNewChatDraft(c: ChatRuntime): boolean {
  return (
    !c.sessionId &&
    !c.runInFlight &&
    c.lines.length === 0 &&
    !c.draft.trim() &&
    c.attachments.length === 0 &&
    c.waiting.length === 0 &&
    (c.forceNew || isDefaultChatTitle(c.title))
  );
}

function hasUnsentDraft(c: ChatRuntime): boolean {
  return (
    !c.sessionId &&
    !runtimeHasUserText(c) &&
    (!!c.draft.trim() || c.attachments.length > 0 || c.waiting.length > 0)
  );
}

function showDraftInList(c: ChatRuntime): boolean {
  if (isPinnedKey(pinKey(c.cwd, null, c.key))) return true;
  if (c.sessionId || c.runInFlight || runtimeHasUserText(c)) return true;
  return c.listedDraft && hasUnsentDraft(c);
}

function runtimeHasUserText(c: ChatRuntime): boolean {
  return c.lines.some(
    (l) =>
      l.kind === "user" &&
      (!!l.text.trim() || (l.attachments?.length ?? 0) > 0),
  );
}

/** Drop unused empty drafts so they only appear via the New chat button flow. */
function pruneEmptyDrafts(keepKey: string | null) {
  for (const [key, c] of [...chats.entries()]) {
    if (key === keepKey) continue;
    if (isPinnedKey(pinKey(c.cwd, null, c.key))) continue;
    if (!isEmptyNewChatDraft(c)) continue;
    void discardSideForMainKey(key);
    void invoke("reset_session", { chatKey: key }).catch(() => {});
    chats.delete(key);
  }
}

function unreadFinishCount(): number {
  let n = 0;
  for (const c of chats.values()) {
    if (!c.runInFlight && c.doneUnread) n += 1;
  }
  return n;
}

function syncDockBadge() {
  const n = unreadFinishCount();
  void getCurrentWindow()
    .setBadgeCount(n > 0 ? n : undefined)
    .catch(() => {});
}

// Ask while a turn still runs so the finish notice is not the permission dialog.
let noticePerm: boolean | null = null;

async function ensureNoticePermission(): Promise<boolean> {
  if (noticePerm != null) return noticePerm;
  try {
    if (await isPermissionGranted()) {
      noticePerm = true;
      return true;
    }
    noticePerm = (await requestPermission()) === "granted";
    return noticePerm;
  } catch {
    noticePerm = false;
    return false;
  }
}

async function windowIsFocused(): Promise<boolean> {
  try {
    return await getCurrentWindow().isFocused();
  } catch {
    return true; // unknown: treat as focused so we do not spam
  }
}

function finishVerb(chat: ChatRuntime): string {
  if (chat.lastStopped) return "stopped";
  const last = lastAssistantLine(chat);
  if (last?.error) return "failed";
  return "finished";
}

// Plugin ids are 32-bit integers.
function noticeIdFor(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return h === 0 ? 1 : h;
}

function extraStr(extra: Record<string, unknown> | undefined, key: string): string {
  const v = extra?.[key];
  return typeof v === "string" ? v : "";
}

async function hideGrotesqueWindow() {
  try {
    await getCurrentWindow().hide();
  } catch {
    /* stay */
  }
}

async function bringGrotesqueForward() {
  try {
    const win = getCurrentWindow();
    await win.show();
    await win.unminimize();
    await win.setFocus();
    pinTrafficLights();
  } catch {
    /* ignore */
  }
}

async function openFromFinishNotice(extra: Record<string, unknown> | undefined) {
  await bringGrotesqueForward();
  const chatKey = extraStr(extra, "chatKey");
  const cwd = extraStr(extra, "cwd");
  const sessionId = extraStr(extra, "sessionId");
  const title = extraStr(extra, "title") || "Chat";
  const live =
    (chatKey && chats.get(chatKey)) ||
    [...chats.values()].find((c) => c.cwd === cwd && !!sessionId && c.sessionId === sessionId);
  if (live) {
    focusChat(live);
    return;
  }
  if (cwd && sessionId && isArchived(cwd, sessionId)) {
    const entry = prefs.archive.find((a) => a.cwd === cwd && a.sessionId === sessionId);
    if (entry) await restoreArchived(entry);
    return;
  }
  if (cwd && sessionId) await openSession(sessionId, title, cwd);
}

async function announceChatFinish(chat: ChatRuntime) {
  const viewing = activeChatKey === chat.key;
  const focused = await windowIsFocused();
  syncDockBadge();
  if (viewing && focused) return;
  if (!(await ensureNoticePermission())) return;
  const title = (chat.title || "Chat").trim() || "Chat";
  const folder = folderName(chat.cwd);
  const body = `${folder} - ${title} ${finishVerb(chat)}`;
  try {
    sendNotification({
      id: noticeIdFor(chat.key),
      title: "Grotesque",
      body,
      extra: {
        chatKey: chat.key,
        cwd: chat.cwd,
        sessionId: chat.sessionId ?? "",
        title,
      },
    });
  } catch {
    /* ignore */
  }
}

function focusChat(chat: ChatRuntime) {
  if (pageOpen()) {
    navSilent = true;
    setMainPage(null);
    navSilent = false;
  }
  const prev = activeChat();
  if (prev) {
    flushPlanEdit(prev);
    prev.draft = composerText();
    prev.lockedMarks = [...lockedMarks];
    prev.pluginMarks = Object.fromEntries(pluginChipMeta);
    if (hasUnsentDraft(prev)) {
      prev.listedDraft = true;
      touchLastActive(prev.cwd, prev.sessionId, prev.key);
    }
    saveTranscriptScroll(prev);
    persistChatTimes(prev);
    if (prev.runInFlight) void ensureNoticePermission();
  }
  activeChatKey = chat.key;
  lockedMarks.clear();
  pluginChipMeta.clear();
  for (const m of chat.lockedMarks) lockedMarks.add(m);
  for (const [raw, meta] of Object.entries(chat.pluginMarks)) {
    pluginChipMeta.set(raw, meta);
  }
  chat.doneUnread = false;
  syncDockBadge();
  pruneEmptyDrafts(chat.key);
  syncEmptyMain(chat);
  restorePanel(chat);
  const switched = prev?.key !== chat.key;
  if (switched && prev) parkChatPane(prev);
  let restored = false;
  if (switched) {
    restored = restoreChatPane(chat);
    if (restored) applyParkedTranscript(chat);
    else rebuildTranscript(chat);
  }
  if (!restored && !isCenteredComposer(chat) && motionOk()) {
    const t = transcript();
    t?.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 180, easing: EASE_OUT },
    );
  }
  paintOutputs(chat);
  paintComposerFrom(chat);
  touchProjectSeed(chat);
  const field = input();
  if (field) {
    setComposerText(chat.draft);
  }
  renderWaiting(chat);
  renderAttachChips(chat);
  applySendChrome();
  refreshUserEditChrome();
  refreshRetryChrome();
  syncSidePanelForMain(chat);
  renderProjects();
  paintTopbarTitle();
  hideSuggest();
  field?.focus();
  recordCurrentNav();
}

function paintQuestionResolved(
  row: HTMLElement,
  req: QuestionRequest,
  resolved: string,
) {
  const card = row.querySelector(".ask-card") ?? row;
  const title = document.createElement("div");
  title.className = "approval-title";
  title.textContent =
    req.questions.length > 1
      ? `${req.questions.length} questions`
      : "Grok has a question";
  const done = document.createElement("div");
  done.className = "approval-detail";
  done.textContent = resolved;
  card.replaceChildren(title, done);
}

function renderQuestionDom(
  req: QuestionRequest,
  chat: ChatRuntime,
  resolved?: string,
) {
  if (activeChatKey !== chat.key) return;
  const t = transcript();
  if (!t) return;

  const row = document.createElement("div");
  row.className = "msg-row assistant";
  row.dataset.cardId = `ask-${req.id}`;
  row.dataset.chatKey = chat.key;

  const card = document.createElement("div");
  card.className = "approval-card ask-card";

  const title = document.createElement("div");
  title.className = "approval-title";
  title.textContent =
    req.questions.length > 1
      ? `${req.questions.length} questions`
      : "Grok has a question";
  card.appendChild(title);

  if (resolved) {
    const done = document.createElement("div");
    done.className = "approval-detail";
    done.textContent = resolved;
    card.append(done);
    row.appendChild(card);
    placeCardRow(chat, row);
    scrollTranscript();
    return;
  }

  const picks = new Map<number, string[]>();
  const others = new Map<number, string>();

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "btn-allow-strong";
  submit.textContent = "Submit";
  submit.disabled = true;

  const syncSubmit = () => {
    submit.disabled = !req.questions.every((_, i) => {
      const sel = picks.get(i) ?? [];
      const extra = (others.get(i) ?? "").trim();
      return sel.length > 0 || extra.length > 0;
    });
  };

  req.questions.forEach((q, qi) => {
    const block = document.createElement("div");
    block.className = "ask-q";
    const qTitle = document.createElement("div");
    qTitle.className = "ask-q-title";
    qTitle.textContent = q.question;
    block.appendChild(qTitle);

    const list = document.createElement("div");
    list.className = "ask-opts";
    q.options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ask-opt";
      const lab = document.createElement("span");
      lab.className = "ask-opt-label";
      lab.textContent = opt.label;
      btn.appendChild(lab);
      if (opt.description) {
        const d = document.createElement("span");
        d.className = "ask-opt-desc";
        d.textContent = opt.description;
        btn.appendChild(d);
      }
      btn.addEventListener("click", () => {
        const cur = picks.get(qi) ?? [];
        if (q.multiSelect) {
          const next = cur.includes(opt.label)
            ? cur.filter((x) => x !== opt.label)
            : [...cur, opt.label];
          picks.set(qi, next);
        } else {
          picks.set(qi, [opt.label]);
        }
        list.querySelectorAll(".ask-opt").forEach((el) => {
          const on = (picks.get(qi) ?? []).includes(
            el.querySelector(".ask-opt-label")?.textContent || "",
          );
          el.classList.toggle("is-on", on);
        });
        syncSubmit();
      });
      list.appendChild(btn);
    });
    block.appendChild(list);

    const other = document.createElement("input");
    other.type = "text";
    other.className = "ask-other";
    other.placeholder = "Other…";
    other.setAttribute("aria-label", "Other answer");
    other.addEventListener("input", () => {
      others.set(qi, other.value);
      syncSubmit();
    });
    block.appendChild(other);
    card.appendChild(block);
  });

  submit.addEventListener("click", () => {
    const answers: Record<string, string | string[]> = {};
    req.questions.forEach((q, i) => {
      const sel = [...(picks.get(i) ?? [])];
      const extra = (others.get(i) ?? "").trim();
      if (extra) sel.push(extra);
      if (q.multiSelect) answers[q.question] = sel;
      else answers[q.question] = sel[0] ?? extra;
    });
    void answerQuestion(chat, req, answers, row);
  });

  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "btn-ghost";
  skip.textContent = "Skip";
  skip.addEventListener("click", () => {
    void answerQuestion(chat, req, null, row);
  });

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  actions.append(skip, submit);
  card.appendChild(actions);
  row.appendChild(card);
  placeCardRow(chat, row);
  scrollTranscript();
}

function planLineOf(chat: ChatRuntime, id: number) {
  const line = chat.lines.find((l) => l.kind === "plan" && l.req.id === id);
  return line && line.kind === "plan" ? line : null;
}

function planTextOf(chat: ChatRuntime, req: PlanRequest): string {
  return planLineOf(chat, req.id)?.edited ?? req.planContent;
}

function planTitleOf(md: string): string {
  for (const line of md.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(\S.*)$/.exec(line);
    if (m) return m[1].trim();
  }
  return "Plan ready";
}

function planExcerptOf(md: string, title: string): string {
  const skip = title === "Plan ready" ? "" : title.toLowerCase();
  const out: string[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const t = raw
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .trim();
    if (!t) continue;
    if (skip && out.length === 0 && t.toLowerCase() === skip) continue;
    out.push(t);
    if (out.length >= 3) break;
  }
  return out.join("\n");
}

function renderPlanDom(
  req: PlanRequest,
  chat: ChatRuntime,
  resolved?: "approved" | "keep" | "change",
) {
  if (activeChatKey !== chat.key) return;
  const t = transcript();
  if (!t) return;

  const id = `plan-${req.id}`;
  let row = t.querySelector<HTMLElement>(`[data-card-id="${id}"]`);
  const fresh = !row;
  if (!row) {
    row = document.createElement("div");
    row.className = "msg-row assistant";
    row.dataset.cardId = id;
    row.dataset.chatKey = chat.key;
  }

  const card = document.createElement("div");
  card.className = "approval-card plan-card";

  const md = planTextOf(chat, req);
  const heading = planTitleOf(md);
  const title = document.createElement("div");
  title.className = "approval-title";
  title.textContent = heading;

  const excerpt = planExcerptOf(md, heading);
  if (!md.trim()) {
    const body = document.createElement("div");
    body.className = "approval-detail";
    body.textContent = "No plan written yet.";
    card.append(title, body);
  } else if (excerpt) {
    const body = document.createElement("div");
    body.className = "plan-excerpt";
    body.textContent = excerpt;
    card.append(title, body);
  } else {
    card.append(title);
  }

  if (!resolved) {
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "btn-ghost";
    keep.append(iconEl(Ico.planKeep, { size: 16 }), "Keep planning");
    keep.addEventListener("click", () => {
      void answerPlan(chat, req, "keep", row!);
    });
    const change = document.createElement("button");
    change.type = "button";
    change.className = "btn-ghost";
    change.append(iconEl(Ico.planChange, { size: 16 }), "Change something");
    change.addEventListener("click", () => {
      void answerPlan(chat, req, "change", row!);
    });
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn-ghost";
    accept.append(iconEl(Ico.planAccept, { size: 16 }), "Accept plan");
    accept.addEventListener("click", () => {
      void answerPlan(chat, req, "approved", row!);
    });
    const actions = document.createElement("div");
    actions.className = "approval-actions";
    actions.append(keep, change, accept);
    card.appendChild(actions);
  }

  card.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    openPlanTab(chat, req, !resolved);
  });

  row.replaceChildren(card);
  if (fresh) {
    placeCardRow(chat, row);
    scrollTranscript();
  }
}

async function answerQuestion(
  chat: ChatRuntime,
  req: QuestionRequest,
  answers: Record<string, string | string[]> | null,
  row: HTMLElement,
) {
  row.querySelectorAll("button, input").forEach((el) => {
    (el as HTMLButtonElement | HTMLInputElement).disabled = true;
  });
  const payload = answers
    ? { outcome: "accepted", answers, partial_answers: {} }
    : { outcome: "skip_interview" };
  const resolved = answers
    ? Object.entries(answers)
        .map(([q, a]) => `${q} → ${Array.isArray(a) ? a.join(", ") : a}`)
        .join("; ")
    : "Skipped";
  try {
    await invoke("respond_card", {
      chatKey: chat.key,
      id: req.id,
      payload: JSON.stringify(payload),
    });
    const line = chat.lines.find(
      (l) => l.kind === "question" && l.req.id === req.id,
    );
    if (line && line.kind === "question") line.resolved = resolved;
    chat.reviewWait = false;
    paintQuestionResolved(row, req, resolved);
    renderProjects();
  } catch (e) {
    const status = row.querySelector(".approval-title");
    if (status) {
      status.textContent = `Could not send answer: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  } finally {
    if (row.isConnected) {
      row.querySelectorAll("button, input").forEach((el) => {
        (el as HTMLButtonElement | HTMLInputElement).disabled = false;
      });
    }
  }
}

async function answerPlan(
  chat: ChatRuntime,
  req: PlanRequest,
  verdict: "approved" | "keep" | "change",
  row: HTMLElement,
) {
  row.querySelectorAll("button").forEach((b) => {
    (b as HTMLButtonElement).disabled = true;
  });
  flushPlanEdit(chat);
  const line = planLineOf(chat, req.id);
  const text = planTextOf(chat, req);
  if (line) line.resolved = verdict;
  chat.reviewWait = false;
  clearLiveDom(chat);
  renderPlanDom(req, chat, verdict);
  const panel = panelOf(chat.key);
  if (panel.plan?.reqId === req.id) {
    panel.plan.text = text;
    panel.plan.editable = false;
    if (frontTabOf(panel)?.kind === "plan" && activeChatKey === chat.key) {
      paintPlanPane(panel);
    }
    persistPanel(chat);
  }
  // Cancelled always tells Grok the user wants to revise. Feedback is the split.
  const payload =
    verdict === "approved"
      ? { outcome: "approved", planContent: text }
      : verdict === "keep"
        ? {
            outcome: "cancelled",
            feedback:
              "Keep planning. Continue improving the plan yourself. Do not ask what should change.",
          }
        : {
            outcome: "cancelled",
            feedback: "Ask what should change.",
          };
  try {
    await invoke("respond_card", {
      chatKey: chat.key,
      id: req.id,
      payload: JSON.stringify(payload),
    });
  } catch (e) {
    if (line) line.resolved = undefined;
    chat.reviewWait = true;
    pauseTurnForCard(chat);
    if (panel.plan?.reqId === req.id) {
      panel.plan.editable = true;
      if (frontTabOf(panel)?.kind === "plan" && activeChatKey === chat.key) {
        paintPlanPane(panel);
      }
    }
    if (activeChatKey === chat.key) renderPlanDom(req, chat);
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

function onQuestionEvent(req: QuestionRequest) {
  if (req.chatKey.startsWith("side:")) return;
  const chat = chats.get(req.chatKey);
  if (!chat) return;
  rememberThought(chat, lastAssistantLine(chat) ?? undefined);
  chat.lines.push({ kind: "question", req });
  chat.reviewWait = true;
  pauseTurnForCard(chat);
  clearLiveDom(chat);
  chat.status = "Waiting for your answer…";
  renderProjects();
  if (activeChatKey === chat.key) {
    renderQuestionDom(req, chat);
    setStatus(chat.status);
  }
}

function onPlanEvent(req: PlanRequest) {
  if (req.chatKey.startsWith("side:")) return;
  const chat = chats.get(req.chatKey);
  if (!chat) return;
  rememberThought(chat, lastAssistantLine(chat) ?? undefined);
  chat.lines.push({ kind: "plan", req });
  chat.reviewWait = true;
  chat.status = "Plan ready for review…";
  pauseTurnForCard(chat);
  if (activeChatKey === chat.key) {
    renderPlanDom(req, chat);
    setStatus(chat.status);
  }
}

async function refreshSessionsFor(
  cwd: string | null,
  opts?: { paint?: boolean },
) {
  if (!cwd) return;
  try {
    const list = await invoke<SessionInfo[]>("list_project_sessions", { cwd });
    sessionsCache[cwd] = list;
  } catch {
    sessionsCache[cwd] = sessionsCache[cwd] ?? [];
  }
  if (opts?.paint !== false) renderProjects();
}

/** One sidebar row: open runtime and/or disk session. */
type SidebarEntry = {
  id: string;
  sessionId: string | null;
  runtime: ChatRuntime | null;
  label: string;
  running: boolean;
  done: boolean;
  active: boolean;
  answer: boolean;
  plan: boolean;
  pinned: boolean;
  lastActive: number;
};

function waitFlags(runtime: ChatRuntime | null): {
  answer: boolean;
} {
  if (!runtime) return { answer: false };
  let answer = false;
  for (const l of runtime.lines) {
    if (l.kind === "question" && !l.resolved) answer = true;
  }
  return { answer };
}

function chatIsPlan(
  cwd: string,
  sessionId: string | null,
  runtime: ChatRuntime | null,
): boolean {
  if (runtime) return runtime.mode === "plan";
  if (!sessionId) return false;
  return prefs.chatSettings[titleKey(cwd, sessionId)]?.mode === "plan";
}

function buildSidebarEntries(
  path: string,
  focus: ChatRuntime | null,
): SidebarEntry[] {
  const runtimeBySid = new Map<string, ChatRuntime>();
  const drafts: ChatRuntime[] = [];

  for (const c of chats.values()) {
    if (c.cwd !== path) continue;
    if (c.sessionId) {
      if (isHiddenChat(path, c.sessionId)) continue;
      runtimeBySid.set(c.sessionId, c);
    } else {
      drafts.push(c);
    }
  }

  const entries: SidebarEntry[] = [];

  for (const c of drafts) {
    if (!showDraftInList(c)) continue;
    const raw = c.title || "New chat";
    entries.push({
      id: c.key,
      sessionId: null,
      runtime: c,
      label: shortTitle(raw),
      running: c.runInFlight,
      done: !c.runInFlight && c.doneUnread,
      active: focus?.key === c.key,
      ...waitFlags(c),
      plan: chatIsPlan(path, null, c),
      pinned: isPinnedKey(pinKey(path, null, c.key)),
      lastActive: lastActiveAt(path, null, c),
    });
  }

  for (const s of sessionsCache[path] ?? []) {
    if (isHiddenChat(path, s.sessionId)) continue;
    const c = runtimeBySid.get(s.sessionId) ?? null;
    if (c) runtimeBySid.delete(s.sessionId);
    if (c && !c.runInFlight && !runtimeHasUserText(c) && isDefaultChatTitle(c.title)) {
      continue;
    }
    const raw = displayTitle(
      path,
      s.sessionId,
      c?.title || s.title || "Chat",
    );
    entries.push({
      id: c?.key ?? `disk:${s.sessionId}`,
      sessionId: s.sessionId,
      runtime: c,
      label: shortTitle(raw),
      running: !!c?.runInFlight,
      done: !!(c && !c.runInFlight && c.doneUnread),
      active: c
        ? focus?.key === c.key
        : !!(
            focus &&
            !focus.forceNew &&
            focus.sessionId === s.sessionId
          ),
      ...waitFlags(c),
      plan: chatIsPlan(path, s.sessionId, c),
      pinned: isPinnedKey(pinKey(path, s.sessionId, c?.key)),
      lastActive: lastActiveAt(path, s.sessionId, c, s.updatedAt),
    });
  }

  // Live sessions not yet in the disk list (rare race)
  for (const c of runtimeBySid.values()) {
    if (!c.runInFlight && !runtimeHasUserText(c)) continue;
    const raw = displayTitle(path, c.sessionId!, c.title || "Chat");
    entries.push({
      id: c.key,
      sessionId: c.sessionId,
      runtime: c,
      label: shortTitle(raw),
      running: c.runInFlight,
      done: !c.runInFlight && c.doneUnread,
      active: focus?.key === c.key,
      ...waitFlags(c),
      plan: chatIsPlan(path, c.sessionId, c),
      pinned: isPinnedKey(pinKey(path, c.sessionId, c.key)),
      lastActive: lastActiveAt(path, c.sessionId, c),
    });
  }

  const rank = (e: SidebarEntry) => {
    if (e.running) return 0;
    if (e.done) return 1;
    return 2;
  };

  return entries
    .map((e, i) => ({ e, i, r: rank(e) }))
    .sort((a, b) => a.r - b.r || b.e.lastActive - a.e.lastActive || a.i - b.i)
    .map((x) => x.e);
}

function spokenTexts(chat: ChatRuntime): string[] {
  const out: string[] = [];
  for (const line of chat.lines) {
    if (line.kind === "user") {
      const t = line.text.trim();
      if (t) out.push(line.text);
      continue;
    }
    if (line.kind !== "assistant") continue;
    for (const p of line.parts) {
      if (p.kind === "text" && p.text.trim()) out.push(p.text);
    }
  }
  return out;
}

function liveTextsForEntry(e: SidebarEntry): string[] {
  return e.runtime ? spokenTexts(e.runtime) : [];
}

function entryFullTitle(path: string, e: SidebarEntry): string {
  if (e.sessionId) {
    const disk = (sessionsCache[path] ?? []).find(
      (s) => s.sessionId === e.sessionId,
    );
    return displayTitle(
      path,
      e.sessionId,
      e.runtime?.title || disk?.title || e.label,
    );
  }
  return e.runtime?.title || e.label;
}

function clipAround(s: string, index: number, nlen: number, max: number): string {
  if (s.length <= max) return s;
  const extra = Math.max(0, max - nlen);
  const left = Math.floor(extra / 2);
  let start = Math.max(0, index - left);
  let end = start + max;
  if (end > s.length) {
    end = s.length;
    start = Math.max(0, end - max);
  }
  let out = s.slice(start, end).trim();
  if (start > 0) out = `…${out}`;
  if (end < s.length) out = `${out}…`;
  return out;
}

function matchingLine(text: string, needle: string): string | null {
  const n = needle.toLowerCase();
  for (const raw of text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const i = line.toLowerCase().indexOf(n);
    if (i < 0) continue;
    return clipAround(line, i, n.length, 72);
  }
  return null;
}

function findSnippet(texts: string[], needle: string): string | null {
  for (const text of texts) {
    const found = matchingLine(text, needle);
    if (found) return found;
  }
  return null;
}

function kickSearchIndex() {
  if (searchIndexRunning) return;
  searchIndexRunning = true;
  void (async () => {
    try {
      for (const cwd of searchFolderPaths()) {
        try {
          await invoke("build_session_search_index", { cwds: [cwd] });
        } catch {
          /* next folder */
        }
        if (chatSearchOpen && chatSearch.trim()) {
          await applyDiskSearch(chatSearch.trim().toLowerCase(), searchQueryGen);
        }
      }
    } finally {
      searchIndexRunning = false;
    }
  })();
}

async function applyDiskSearch(needle: string, gen: number) {
  if (!needle || gen !== searchQueryGen) return;
  try {
    const hits = await invoke<SessionSearchHit[]>("search_session_texts", {
      cwds: searchFolderPaths(),
      query: needle,
    });
    if (gen !== searchQueryGen) return;
    for (const key of Object.keys(diskSnippets)) delete diskSnippets[key];
    for (const h of hits) {
      diskSnippets[titleKey(h.cwd, h.sessionId)] = h.snippet;
    }
    diskSnippetsQ = needle;
    if (chatSearchOpen) paintSpot();
  } catch {
    /* keep last snippets */
  }
}

async function refreshDiskSnippets(q: string) {
  const needle = q.trim().toLowerCase();
  const gen = ++searchQueryGen;
  if (!needle) {
    for (const key of Object.keys(diskSnippets)) delete diskSnippets[key];
    diskSnippetsQ = "";
    return;
  }
  kickSearchIndex();
  await applyDiskSearch(needle, gen);
}

function searchFolderPaths(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  add(prefs.activeCwd || "");
  add(recentsCwd);
  for (const p of prefs.recent) add(p);
  return out;
}

function collectSpotHits(q: string): SpotHit[] {
  const needle = q.trim().toLowerCase();
  const hits: SpotHit[] = [];
  const seen = new Set<string>();
  const focus = activeChat();
  const cap = 80;
  const perFolder = needle ? 80 : 12;
  for (const path of searchFolderPaths()) {
    let fromFolder = 0;
    const entries = buildSidebarEntries(
      path,
      path === prefs.activeCwd ? focus : null,
    );
    for (const e of entries) {
      const titleHit =
        !needle || entryFullTitle(path, e).toLowerCase().includes(needle);
      const liveSnip = needle ? findSnippet(liveTextsForEntry(e), needle) : null;
      const diskSnip =
        needle && e.sessionId && diskSnippetsQ === needle
          ? (diskSnippets[titleKey(path, e.sessionId)] ?? null)
          : null;
      const snippet = liveSnip || diskSnip;
      if (needle && !titleHit && !snippet) continue;
      const id = e.sessionId
        ? titleKey(path, e.sessionId)
        : e.runtime?.key || e.id;
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push({
        cwd: path,
        sessionId: e.sessionId,
        runtime: e.runtime,
        label: e.label,
        project: projectLabel(path),
        snippet,
      });
      fromFolder += 1;
      if (hits.length >= cap) return hits;
      if (fromFolder >= perFolder) break;
    }
  }
  return hits;
}

function paintSpot() {
  const chatsUl = spotChatList();
  const suggestUl = spotSuggestList();
  const chatsBlock = spotChatsBlock();
  const suggestBlock = spotSuggestBlock();
  const empty = spotEmpty();
  if (!chatsUl || !suggestUl) return;

  const querying = chatSearch.trim().length > 0;
  const hits = collectSpotHits(chatSearch);
  const suggestItems: SpotItem[] = querying
    ? []
    : [{ kind: "new" }, { kind: "folder" }];
  spotItems = [
    ...suggestItems,
    ...hits.map((hit): SpotItem => ({ kind: "chat", hit })),
  ];
  if (spotIndex >= spotItems.length) spotIndex = Math.max(0, spotItems.length - 1);

  suggestUl.replaceChildren();
  if (suggestBlock) suggestBlock.hidden = querying;
  if (!querying) {
    const suggest: Array<{
      kind: "new" | "folder";
      label: string;
      kbd: string;
      ico: string;
    }> = [
      {
        kind: "new",
        label: "New chat",
        kbd: "⌘N",
        ico: iconHtml(Ico.newChat, { size: 16, className: "spot-row-ico" }),
      },
      {
        kind: "folder",
        label: "Open folder",
        kbd: "⌘O",
        ico: iconHtml(Ico.folder, { size: 16, className: "spot-row-ico" }),
      },
    ];
    for (const [i, item] of suggest.entries()) {
      const li = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "spot-row" + (spotIndex === i ? " is-on" : "");
      row.innerHTML = item.ico;
      const title = document.createElement("span");
      title.className = "spot-row-title";
      title.textContent = item.label;
      const kbd = document.createElement("span");
      kbd.className = "spot-kbd";
      kbd.textContent = item.kbd;
      row.append(title, kbd);
      row.addEventListener("mouseenter", () => setSpotIndex(i));
      row.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        void runSpotItem({ kind: item.kind });
      });
      li.appendChild(row);
      suggestUl.appendChild(li);
    }
  }

  chatsUl.replaceChildren();
  const chatOffset = suggestItems.length;
  for (const [i, hit] of hits.entries()) {
    const idx = chatOffset + i;
    const li = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "spot-row" + (spotIndex === idx ? " is-on" : "");
    if (hit.snippet) row.classList.add("has-snip");
    const main = document.createElement("span");
    main.className = "spot-row-main";
    const title = document.createElement("span");
    title.className = "spot-row-title";
    title.textContent = hit.label;
    main.appendChild(title);
    if (hit.snippet) {
      const snip = document.createElement("span");
      snip.className = "spot-row-snip";
      snip.textContent = hit.snippet;
      main.appendChild(snip);
    }
    const meta = document.createElement("span");
    meta.className = "spot-row-meta";
    meta.textContent = hit.project;
    row.append(main, meta);
    if (i < 9) {
      const kbd = document.createElement("span");
      kbd.className = "spot-kbd";
      kbd.textContent = `⌘${i + 1}`;
      row.appendChild(kbd);
    }
    row.addEventListener("mouseenter", () => setSpotIndex(idx));
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void runSpotItem({ kind: "chat", hit });
    });
    li.appendChild(row);
    chatsUl.appendChild(li);
  }
  if (chatsBlock) chatsBlock.hidden = hits.length === 0;
  if (empty) empty.hidden = hits.length > 0;

  queueMicrotask(() => {
    chatSearchOverlay()
      ?.querySelector(".spot-row.is-on")
      ?.scrollIntoView({ block: "nearest" });
  });
}

function setSpotIndex(i: number) {
  spotIndex = i;
  const rows = [
    ...Array.from(spotSuggestList()?.querySelectorAll(".spot-row") ?? []),
    ...Array.from(spotChatList()?.querySelectorAll(".spot-row") ?? []),
  ];
  rows.forEach((row, idx) => {
    row.classList.toggle("is-on", idx === i);
  });
  rows[i]?.scrollIntoView({ block: "nearest" });
}

async function activateProjectFolder(path: string) {
  if (prefs.activeCwd === path) return;
  prefs.activeCwd = path;
  rememberFolder(path);
  savePrefs();
  chatsShown = CHAT_LIST_CAP;
  updatePlaceholder();
  await refreshSessionsFor(path);
  renderProjects();
}

async function runSpotItem(item: SpotItem) {
  setChatSearchOpen(false, true);
  if (item.kind === "new") {
    await startNewChat();
    return;
  }
  if (item.kind === "folder") {
    await pickProjectFolder();
    return;
  }
  const hit = item.hit;
  if (hit.cwd !== prefs.activeCwd) {
    await activateProjectFolder(hit.cwd);
    setProjectExpanded(hit.cwd, true);
  }
  const live =
    hit.runtime && chats.has(hit.runtime.key) ? hit.runtime : undefined;
  if (live) {
    focusChat(live);
    return;
  }
  if (hit.sessionId) await openSession(hit.sessionId, hit.label, hit.cwd);
}

function onSpotKey(e: KeyboardEvent): boolean {
  if (!chatSearchOpen) return false;
  if (e.key === "Escape") {
    e.preventDefault();
    setChatSearchOpen(false, true);
    return true;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (spotItems.length === 0) return true;
    setSpotIndex((spotIndex + 1) % spotItems.length);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (spotItems.length === 0) return true;
    setSpotIndex((spotIndex - 1 + spotItems.length) % spotItems.length);
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const item = spotItems[spotIndex];
    if (item) void runSpotItem(item);
    return true;
  }
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? "";
  if (e.metaKey && digit) {
    const item = spotItems.filter((it) => it.kind === "chat")[Number(digit) - 1];
    if (item?.kind === "chat") {
      e.preventDefault();
      void runSpotItem(item);
    }
    return true;
  }
  if (e.metaKey && (e.key === "n" || e.key === "N")) {
    e.preventDefault();
    void runSpotItem({ kind: "new" });
    return true;
  }
  if (e.metaKey && (e.key === "o" || e.key === "O")) {
    e.preventDefault();
    void runSpotItem({ kind: "folder" });
    return true;
  }
  return false;
}

function setChatSearchOpen(open: boolean, instant = false) {
  chatSearchOpen = open;
  const overlay = chatSearchOverlay();
  const btn = chatSearchBtn();
  const field = chatSearchInput();
  if (overlay) {
    overlay.classList.toggle("is-instant", instant);
    overlay.hidden = !open;
  }
  if (btn) {
    btn.classList.toggle("is-on", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (!open) {
    chatSearch = "";
    spotIndex = 0;
    if (field) field.value = "";
    return;
  }
  spotIndex = 0;
  if (field) field.value = "";
  paintSpot();
  field?.focus();
  field?.select();
  void Promise.all(searchFolderPaths().map((p) => refreshSessionsFor(p))).then(() => {
    if (chatSearchOpen) paintSpot();
  });
  kickSearchIndex();
}

function collectPinnedEntries(
  focus: ChatRuntime | null,
): Array<SidebarEntry & { cwd: string; pinKey: string }> {
  const out: Array<SidebarEntry & { cwd: string; pinKey: string }> = [];
  for (const key of prefs.pinned) {
    const parsed = parsePinKey(key);
    if (!parsed) continue;
    const { cwd, sessionId, draftKey } = parsed;
    const entries = buildSidebarEntries(
      cwd,
      focus && focus.cwd === cwd ? focus : null,
    );
    const found = sessionId
      ? entries.find((en) => en.sessionId === sessionId)
      : entries.find((en) => en.runtime?.key === draftKey);
    if (found) {
      out.push({ ...found, cwd, pinned: true, pinKey: key });
      continue;
    }
    if (sessionId && !(cwd in sessionsCache)) {
      const runtime =
        [...chats.values()].find(
          (c) => c.cwd === cwd && c.sessionId === sessionId,
        ) ?? null;
      out.push({
        id: runtime?.key ?? `disk:${sessionId}`,
        sessionId,
        runtime,
        label: shortTitle(displayTitle(cwd, sessionId, runtime?.title || "Chat")),
        running: !!runtime?.runInFlight,
        done: !!(runtime && !runtime.runInFlight && runtime.doneUnread),
        active: !!(focus && runtime && focus.key === runtime.key),
        ...waitFlags(runtime),
        plan: chatIsPlan(cwd, sessionId, runtime),
        pinned: true,
        lastActive: lastActiveAt(cwd, sessionId, runtime),
        cwd,
        pinKey: key,
      });
    }
  }
  return out;
}

function appendSidebarChat(
  host: HTMLElement,
  path: string,
  e: SidebarEntry,
) {
  const cli = document.createElement("li");
  const rawTitle = e.sessionId
    ? displayTitle(path, e.sessionId, e.label)
    : e.label;
  const ctx: CtxTarget = e.sessionId
    ? {
        kind: "session",
        cwd: path,
        sessionId: e.sessionId,
        title: rawTitle,
      }
    : {
        kind: "draft",
        cwd: path,
        runtimeKey: e.runtime?.key ?? e.id,
      };
  const pin = pinKeyForCtx(ctx);
  if (pin) cli.dataset.pinKey = pin;
  cli.dataset.dragLabel = e.label;
  if (e.runtime?.key) cli.dataset.key = e.runtime.key;
  if (e.sessionId) cli.dataset.sid = e.sessionId;
  cli.appendChild(
    makeChatRow(e.label, {
      active: e.active,
      running: e.running,
      done: e.done,
      answer: e.answer,
      plan: e.plan,
      pinned: e.pinned,
      lastActive: e.lastActive,
      title: e.sessionId ?? e.label,
      ctx,
      chatIco: host.id === "pinned-list",
      onOpen: () => {
        void (async () => {
          if (path !== prefs.activeCwd) await activateProjectFolder(path);
          if (e.runtime) {
            focusChat(e.runtime);
            return;
          }
          if (e.sessionId) await openSession(e.sessionId, rawTitle);
        })();
      },
      onTrash: () => {
        if (e.sessionId) {
          void archiveSession(path, e.sessionId, rawTitle);
          return;
        }
        if (e.runtime) {
          void invoke("reset_session", {
            chatKey: e.runtime.key,
          }).catch(() => {});
          chats.delete(e.runtime.key);
          if (activeChatKey === e.runtime.key) activeChatKey = null;
          syncDockBadge();
          void startNewChat();
        }
      },
    }),
  );
  host.appendChild(cli);
}

function appendChatMore(
  host: HTMLElement,
  label: string,
  onClick: () => void,
) {
  const more = document.createElement("li");
  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "chat-item chat-more";
  moreBtn.textContent = label;
  moreBtn.addEventListener("click", onClick);
  more.appendChild(moreBtn);
  host.appendChild(more);
}

function renderPinnedSection(focus: ChatRuntime | null) {
  const head = $<HTMLElement>("#pinned-head");
  const list = pinnedList();
  if (!head || !list) return;
  prefs.pinnedMix = reconcilePinnedMix(
    prefs.pinnedMix,
    prefs.pinned,
    prefs.pinnedProjects,
    prefs.recent,
  );
  const chats = new Map(
    collectPinnedEntries(focus).map((e) => [e.pinKey, e] as const),
  );
  const show = prefs.pinnedMix.length > 0;
  list.replaceChildren();
  const sec = head.closest<HTMLElement>(".nav-section");
  if (sec) sec.hidden = !show;
  if (!show) return;
  for (const id of prefs.pinnedMix) {
    if (id.startsWith("p:")) {
      const path = id.slice(2);
      if (prefs.pinnedProjects[path]) {
        appendProjectBlock(list, path, focus);
      }
      continue;
    }
    if (id.startsWith("c:")) {
      const e = chats.get(id.slice(2));
      if (e) appendSidebarChat(list, e.cwd, e);
    }
  }
}

function projectBlockEls(): HTMLElement[] {
  const pinned = pinnedList();
  const rest = projectList();
  const out: HTMLElement[] = [];
  for (const host of [pinned, rest]) {
    if (!host) continue;
    for (const child of host.children) {
      if (child instanceof HTMLElement && child.classList.contains("project-block")) {
        out.push(child);
      }
    }
  }
  return out;
}

function pointInEl(el: HTMLElement | null, x: number, y: number): boolean {
  if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function pinnedSlotRects(): DOMRect[] {
  const list = pinnedList();
  if (!list) return [];
  const out: DOMRect[] = [];
  for (const child of list.children) {
    if (!(child instanceof HTMLElement)) continue;
    const row = child.classList.contains("project-block")
      ? child.querySelector(".project-row")
      : child.querySelector(".chat-row");
    if (row instanceof HTMLElement) out.push(row.getBoundingClientRect());
  }
  return out;
}

function unpinnedProjectRowRects(): DOMRect[] {
  const out: DOMRect[] = [];
  for (const block of projectBlockEls()) {
    if (!block.closest("#project-list")) continue;
    const row = block.querySelector(".project-row");
    if (row instanceof HTMLElement) out.push(row.getBoundingClientRect());
  }
  return out;
}

function resolveProjectDrop(
  x: number,
  y: number,
): { insert: number; pin: boolean } {
  const pinnedHead = $<HTMLElement>("#pinned-head");
  const projectsHead = $<HTMLElement>("#projects-head");
  if (pointInEl(pinnedHead, x, y) || pointInEl(pinnedList(), x, y)) {
    return { insert: insertIndexAt(y, pinnedSlotRects()), pin: true };
  }
  if (pointInEl(projectsHead, x, y) || pointInEl(projectList(), x, y)) {
    return { insert: insertIndexAt(y, unpinnedProjectRowRects()), pin: false };
  }
  const scroll = $<HTMLElement>(".sidebar-scroll");
  if (
    pointInEl(scroll, x, y) &&
    projectsHead &&
    y >= projectsHead.getBoundingClientRect().top
  ) {
    return { insert: insertIndexAt(y, unpinnedProjectRowRects()), pin: false };
  }
  return { insert: insertIndexAt(y, pinnedSlotRects()), pin: true };
}

function insertIndexAt(y: number, rows: { top: number; height: number }[]): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (y < r.top + r.height / 2) return i;
  }
  return rows.length;
}

function commitProjectInsert(from: string, insert: number, pin: boolean) {
  if (pin) {
    prefs.pinnedProjects[from] = true;
    moveMixId(mixProjectId(from), insert);
    pruneProjectMeta();
    savePrefs();
    return;
  }
  delete prefs.pinnedProjects[from];
  removeMixId(mixProjectId(from));
  const rest = prefs.recent.filter((p) => p !== from);
  const pinned = rest.filter((p) => prefs.pinnedProjects[p]);
  const loose = rest.filter((p) => !prefs.pinnedProjects[p]);
  const dest = Math.max(0, Math.min(insert, loose.length));
  loose.splice(dest, 0, from);
  prefs.recent = [...pinned, ...loose];
  pruneProjectMeta();
  savePrefs();
}

function endProjectDrag(commit: boolean) {
  const drag = projectDrag;
  projectDrag = null;
  clearAxisShifts(drag?.shiftHost ?? null);
  if (drag?.handle) drag.handle.style.removeProperty("touch-action");
  const first = new Map<string, DOMRect>();
  if (commit && drag?.live && motionOk()) {
    const host = drag.pin ? pinnedList() : projectList();
    if (host) {
      for (const el of host.querySelectorAll<HTMLElement>(":scope > *")) {
        const id = el.dataset.path || el.dataset.pinKey || "";
        if (id) first.set(id, el.getBoundingClientRect());
      }
    }
    if (drag.pill) first.set(drag.from, drag.pill.getBoundingClientRect());
  }
  drag?.pill?.remove();
  document.body.classList.remove("is-project-dragging");
  document
    .querySelector(".project-block.is-drag-source")
    ?.classList.remove("is-drag-source");
  if (drag?.handle.hasPointerCapture(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }
  window.setTimeout(() => {
    projectDragged = false;
  }, 0);
  if (!drag?.live) return;
  if (commit) commitProjectInsert(drag.from, drag.insert, drag.pin);
  renderProjects();
  if (commit && first.size) {
    const host = drag.pin ? pinnedList() : projectList();
    if (host) {
      flipFromFirst(
        [...host.querySelectorAll<HTMLElement>(":scope > *")],
        first,
        (el) => el.dataset.path || el.dataset.pinKey || "",
      );
    }
  }
}

// WKWebView file-drop swallows HTML5 drop. Reorder with pointers.
function onProjectPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (t.closest(".chat-action")) return;
  const item = t.closest<HTMLElement>(".project-item");
  const block = t.closest<HTMLElement>(".project-block");
  const from = block?.dataset.path;
  if (!item || !block || !from) return;
  projectDrag = {
    pointerId: e.pointerId,
    from,
    x: e.clientX,
    y: e.clientY,
    live: false,
    insert: 0,
    pin: isProjectPinned(from),
    handle: item,
    pill: null,
    grabX: 0,
    grabY: 0,
    shiftHost: null,
  };
  item.style.touchAction = "none";
  try {
    item.setPointerCapture(e.pointerId);
  } catch {
    /* capture optional */
  }
}

function onProjectPointerMove(e: PointerEvent) {
  const drag = projectDrag;
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.live) {
    if (dx * dx + dy * dy < PROJECT_DRAG_PX * PROJECT_DRAG_PX) return;
    drag.live = true;
    projectDragged = true;
    document.body.classList.add("is-project-dragging");
    const block = drag.handle.closest(".project-block");
    block?.classList.add("is-drag-source");
    const origin = (block ?? drag.handle).getBoundingClientRect();
    drag.grabX = drag.x - origin.left;
    drag.grabY = drag.y - origin.top;
    const prow = block?.querySelector<HTMLElement>(".project-row");
    drag.pill = liftClone(prow ?? drag.handle);
    positionGrabPill(drag.pill, e.clientX, e.clientY, drag.grabX, drag.grabY);
  }
  e.preventDefault();
  if (drag.pill) {
    positionGrabPill(drag.pill, e.clientX, e.clientY, drag.grabX, drag.grabY);
  }
  const drop = resolveProjectDrop(e.clientX, e.clientY);
  drag.insert = drop.insert;
  drag.pin = drop.pin;
  const host = drop.pin ? pinnedList() : projectList();
  if (drag.shiftHost && drag.shiftHost !== host) clearAxisShifts(drag.shiftHost);
  drag.shiftHost = host;
  if (host && motionOk()) host.classList.add("is-shifting");
  if (host) {
    const items = [...host.querySelectorAll<HTMLElement>(":scope > *")];
    const from = items.findIndex((el) => el.dataset.path === drag.from);
    applyAxisShifts(items, from, drop.insert, "y", 2);
  }
}

function onProjectPointerUp(e: PointerEvent) {
  if (!projectDrag || e.pointerId !== projectDrag.pointerId) return;
  endProjectDrag(e.type === "pointerup");
}

function onProjectPointerKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !projectDrag?.live) return;
  e.preventDefault();
  endProjectDrag(false);
}

function resolveChatDrop(x: number, y: number): { insert: number; pin: boolean } {
  const pinnedHead = $<HTMLElement>("#pinned-head");
  const projectsHead = $<HTMLElement>("#projects-head");
  if (pointInEl(pinnedHead, x, y) || pointInEl(pinnedList(), x, y)) {
    return { insert: insertIndexAt(y, pinnedSlotRects()), pin: true };
  }
  if (pointInEl(projectsHead, x, y) || pointInEl(projectList(), x, y)) {
    return { insert: 0, pin: false };
  }
  const scroll = $<HTMLElement>(".sidebar-scroll");
  if (
    pointInEl(scroll, x, y) &&
    projectsHead &&
    y >= projectsHead.getBoundingClientRect().top
  ) {
    return { insert: 0, pin: false };
  }
  return { insert: insertIndexAt(y, pinnedSlotRects()), pin: true };
}

function commitChatInsert(from: string, insert: number, pin: boolean) {
  if (!pin) {
    setPinnedKey(from, false);
    return;
  }
  if (!prefs.pinned.includes(from)) prefs.pinned.push(from);
  moveMixId(mixChatId(from), insert);
  savePrefs();
}

function endChatDrag(commit: boolean) {
  const drag = chatDrag;
  chatDrag = null;
  clearAxisShifts(drag?.shiftHost ?? null);
  if (drag?.handle) drag.handle.style.removeProperty("touch-action");
  const first = new Map<string, DOMRect>();
  if (commit && drag?.live && motionOk()) {
    const host = drag.pin ? pinnedList() : projectList();
    if (host) {
      for (const el of host.querySelectorAll<HTMLElement>(":scope > *")) {
        const id = el.dataset.path || el.dataset.pinKey || "";
        if (id) first.set(id, el.getBoundingClientRect());
      }
    }
    if (drag.pill) first.set(drag.from, drag.pill.getBoundingClientRect());
  }
  drag?.pill?.remove();
  document.body.classList.remove("is-chat-dragging");
  document
    .querySelector(".is-drag-source")
    ?.classList.remove("is-drag-source");
  if (drag?.handle.hasPointerCapture(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }
  window.setTimeout(() => {
    projectDragged = false;
  }, 0);
  window.setTimeout(() => {
    skipChatOpen = false;
  }, 320);
  if (!drag?.live) return;
  if (commit) commitChatInsert(drag.from, drag.insert, drag.pin);
  renderProjects();
  if (commit && first.size) {
    const host = drag.pin ? pinnedList() : projectList();
    if (host) {
      flipFromFirst(
        [...host.querySelectorAll<HTMLElement>(":scope > *")],
        first,
        (el) => el.dataset.path || el.dataset.pinKey || "",
      );
    }
  }
}

function onChatPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (t.closest(".chat-action, input, .project-item")) return;
  const item = t.closest<HTMLElement>(".chat-item");
  const row = t.closest<HTMLElement>(".chat-row");
  const li = t.closest("li");
  const from = li?.dataset.pinKey;
  if (!item || !row || !from || !li?.closest("#pinned-list, .project-list")) {
    return;
  }
  chatDrag = {
    pointerId: e.pointerId,
    from,
    label: li.dataset.dragLabel || row.textContent?.trim() || "Chat",
    active: row.classList.contains("active"),
    x: e.clientX,
    y: e.clientY,
    live: false,
    insert: 0,
    pin: isPinnedKey(from),
    handle: item,
    pill: null,
    grabX: 0,
    grabY: 0,
    shiftHost: null,
  };
  item.style.touchAction = "none";
  try {
    item.setPointerCapture(e.pointerId);
  } catch {
    /* capture optional */
  }
}

function onChatPointerMove(e: PointerEvent) {
  const drag = chatDrag;
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.live) {
    if (dx * dx + dy * dy < PROJECT_DRAG_PX * PROJECT_DRAG_PX) return;
    drag.live = true;
    projectDragged = true;
    skipChatOpen = true;
    document.body.classList.add("is-chat-dragging");
    const row = drag.handle.closest<HTMLElement>(".chat-row");
    const li = drag.handle.closest("li");
    (li ?? row)?.classList.add("is-drag-source");
    const origin = (li ?? row ?? drag.handle).getBoundingClientRect();
    drag.grabX = drag.x - origin.left;
    drag.grabY = drag.y - origin.top;
    drag.pill = liftClone(row ?? drag.handle);
    positionGrabPill(drag.pill, e.clientX, e.clientY, drag.grabX, drag.grabY);
  }
  e.preventDefault();
  if (drag.pill) {
    positionGrabPill(drag.pill, e.clientX, e.clientY, drag.grabX, drag.grabY);
  }
  const drop = resolveChatDrop(e.clientX, e.clientY);
  drag.insert = drop.insert;
  drag.pin = drop.pin;
  const host = drop.pin ? pinnedList() : null;
  if (drag.shiftHost && drag.shiftHost !== host) clearAxisShifts(drag.shiftHost);
  drag.shiftHost = host;
  if (host && motionOk()) host.classList.add("is-shifting");
  if (host) {
    const items = [...host.querySelectorAll<HTMLElement>(":scope > *")];
    const from = items.findIndex((el) => el.dataset.pinKey === drag.from);
    applyAxisShifts(items, from, drop.insert, "y", 2);
  }
}

function onChatPointerUp(e: PointerEvent) {
  if (!chatDrag || e.pointerId !== chatDrag.pointerId) return;
  endChatDrag(e.type === "pointerup");
}

function onChatPointerKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !chatDrag?.live) return;
  e.preventDefault();
  endChatDrag(false);
}

function commitWaitingInsert(chat: ChatRuntime, fromId: string, insert: number) {
  const from = chat.waiting.findIndex((w) => w.id === fromId);
  if (from < 0) return;
  let dest = Math.max(0, Math.min(insert, chat.waiting.length));
  if (dest === from || dest === from + 1) return;
  const [moved] = chat.waiting.splice(from, 1);
  if (from < dest) dest -= 1;
  chat.waiting.splice(dest, 0, moved);
}

function endWaitingDrag(commit: boolean) {
  const drag = waitingDrag;
  waitingDrag = null;
  uiDragActive = false;
  if (drag?.handle) drag.handle.style.removeProperty("touch-action");
  const first = new Map<string, DOMRect>();
  if (commit && drag?.live && motionOk()) {
    for (const el of drag.list.querySelectorAll<HTMLElement>(".waiting-item")) {
      const id = el.dataset.id;
      if (id) first.set(id, el.getBoundingClientRect());
    }
    if (drag.pill) first.set(drag.from, drag.pill.getBoundingClientRect());
  }
  drag?.pill?.remove();
  document.body.classList.remove("is-waiting-dragging");
  document
    .querySelector(".waiting-item.is-drag-source")
    ?.classList.remove("is-drag-source");
  if (drag?.handle.hasPointerCapture(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }
  if (!drag?.live) {
    drag?.list.classList.remove("is-shifting");
    return;
  }
  if (commit) commitWaitingInsert(drag.chat, drag.from, drag.insert);
  if (drag.side) renderSideWaiting(drag.chat);
  else {
    persistWaiting(drag.chat);
    renderWaiting(drag.chat);
  }
  if (commit && first.size) {
    const list = drag.list;
    list.classList.add("is-shifting");
    flipFromFirst(
      [...list.querySelectorAll<HTMLElement>(".waiting-item")],
      first,
      (el) => el.dataset.id || "",
    );
    window.setTimeout(() => list.classList.remove("is-shifting"), 220);
  } else {
    drag.list.classList.remove("is-shifting");
  }
}

function onWaitingPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  const handle = t.closest<HTMLElement>(".waiting-handle");
  const row = t.closest<HTMLElement>(".waiting-item");
  const list = t.closest<HTMLElement>(".waiting-list");
  const from = row?.dataset.id;
  if (!handle || !row || !list || !from || row.classList.contains("is-editing")) {
    return;
  }
  const side = list.id === "side-waiting-list";
  const chat = side ? frontAgent() : activeChat();
  if (!chat) return;
  waitingDrag = {
    pointerId: e.pointerId,
    from,
    chat,
    side,
    label: row.querySelector(".waiting-text")?.textContent?.trim() || "Waiting",
    x: e.clientX,
    y: e.clientY,
    live: false,
    insert: 0,
    handle,
    row,
    list,
    pill: null,
    grabX: 0,
    grabY: 0,
  };
  handle.style.touchAction = "none";
  try {
    handle.setPointerCapture(e.pointerId);
  } catch {
    /* capture optional */
  }
}

function onWaitingPointerMove(e: PointerEvent) {
  const drag = waitingDrag;
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.live) {
    if (dx * dx + dy * dy < PROJECT_DRAG_PX * PROJECT_DRAG_PX) return;
    drag.live = true;
    uiDragActive = true;
    setDropOverlay(false);
    hideWaitingMenu();
    document.body.classList.add("is-waiting-dragging");
    drag.row.classList.add("is-drag-source");
    const origin = drag.row.getBoundingClientRect();
    drag.grabX = drag.x - origin.left;
    drag.grabY = drag.y - origin.top;
    drag.pill = liftClone(drag.row);
    positionGrabPill(drag.pill, e.clientX, e.clientY, drag.grabX, drag.grabY);
    if (motionOk()) drag.list.classList.add("is-shifting");
  }
  e.preventDefault();
  if (drag.pill) {
    positionGrabPill(drag.pill, e.clientX, e.clientY, drag.grabX, drag.grabY);
  }
  const items = [...drag.list.querySelectorAll<HTMLElement>(".waiting-item")];
  const from = items.findIndex((el) => el.dataset.id === drag.from);
  const box = drag.list.getBoundingClientRect();
  const slots = items.map((el) => ({
    top: box.top + el.offsetTop - drag.list.scrollTop,
    height: el.offsetHeight,
  }));
  drag.insert = insertIndexAt(e.clientY, slots);
  applyAxisShifts(items, from, drag.insert, "y", 0);
}

function onWaitingPointerUp(e: PointerEvent) {
  if (!waitingDrag || e.pointerId !== waitingDrag.pointerId) return;
  endWaitingDrag(e.type === "pointerup");
}

function onWaitingPointerKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !waitingDrag?.live) return;
  e.preventDefault();
  endWaitingDrag(false);
}

function visibleChatWindow(
  entries: SidebarEntry[],
  shown: number,
): SidebarEntry[] {
  if (entries.length <= shown) return entries;
  const active = entries.findIndex((e) => e.active);
  const n = Math.max(shown, active >= 0 ? active + 1 : shown);
  const slice = entries.slice(0, n);
  const ids = new Set(slice.map((e) => e.id));
  const extra = entries.filter(
    (e) =>
      !ids.has(e.id) && (e.running || e.done || e.answer),
  );
  return extra.length ? [...extra, ...slice] : slice;
}

type ProjectChatView = {
  isActiveProject: boolean;
  expanded: boolean;
  entries: SidebarEntry[];
  visible: SidebarEntry[];
  folderOpen: boolean;
};

function projectChatView(
  path: string,
  focus: ChatRuntime | null,
): ProjectChatView {
  const isActiveProject = path === prefs.activeCwd;
  const entries = isActiveProject
    ? buildSidebarEntries(path, focus).filter((e) => !e.pinned)
    : [];
  const expanded = isActiveProject && isProjectExpanded(path);
  return {
    isActiveProject,
    expanded,
    entries,
    visible: expanded ? visibleChatWindow(entries, chatsShown) : [],
    folderOpen: expanded,
  };
}

const projectListAnims = new WeakMap<HTMLElement, Animation>();

function stickFoldHead(
  scroller: HTMLElement | null,
  head: HTMLElement,
  top: number,
) {
  if (!scroller || !head.isConnected) return;
  const dy = head.getBoundingClientRect().top - top;
  if (Math.abs(dy) < 0.5) return;
  scroller.scrollTop += dy;
}

function animateWorkNest(
  nest: HTMLElement,
  open: boolean,
  scroller: HTMLElement | null,
  head: HTMLElement,
) {
  if (!motionOk()) {
    nest.classList.remove("is-motion");
    nest.classList.toggle("is-collapsed", !open);
    return;
  }
  const top = head.getBoundingClientRect().top;
  ignoreTranscriptScroll = true;
  nest.classList.add("is-motion");
  if (open) nest.getBoundingClientRect();
  nest.classList.toggle("is-collapsed", !open);
  let running = true;
  const tick = () => {
    if (!running) return;
    stickFoldHead(scroller, head, top);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const finish = () => {
    if (!running) return;
    running = false;
    nest.classList.remove("is-motion");
    stickFoldHead(scroller, head, top);
    ignoreTranscriptScroll = false;
    if (scroller && scroller === transcript()) {
      const chat = activeChat();
      if (chat) {
        chat.scrollTop = scroller.scrollTop;
        chat.scrollPinned = isTranscriptNearBottom(scroller);
      }
      syncJumpLatest();
    }
  };
  const onEnd = (ev: TransitionEvent) => {
    if (ev.target !== nest || ev.propertyName !== "grid-template-rows") return;
    nest.removeEventListener("transitionend", onEnd);
    finish();
  };
  nest.addEventListener("transitionend", onEnd);
  window.setTimeout(finish, DUR_SHELL + 40);
}

function animateChatListHeight(
  ul: HTMLElement,
  fromH: number,
  toH: number,
  opts?: { remove?: boolean },
) {
  const clear = () => {
    ul.style.removeProperty("height");
    ul.style.removeProperty("overflow");
    ul.style.removeProperty("opacity");
  };
  if (!motionOk() || Math.abs(toH - fromH) <= 2) {
    if (opts?.remove) ul.remove();
    else clear();
    return;
  }
  projectListAnims.get(ul)?.cancel();
  ul.style.overflow = "hidden";
  ul.style.height = `${fromH}px`;
  if (fromH < 2) ul.style.opacity = "0";
  void ul.offsetHeight;
  const fade = fromH < 2 || toH < 2;
  const anim = ul.animate(
    [
      { height: `${fromH}px`, opacity: fade && fromH < 2 ? 0 : 1 },
      { height: `${toH}px`, opacity: fade && toH < 2 ? 0 : 1 },
    ],
    { duration: DUR_SHELL, easing: EASE_SHELL },
  );
  projectListAnims.set(ul, anim);
  void anim.finished.finally(() => {
    if (projectListAnims.get(ul) !== anim) return;
    projectListAnims.delete(ul);
    if (opts?.remove) ul.remove();
    else clear();
  });
}

function fillProjectChatList(
  ul: HTMLUListElement,
  path: string,
  view: ProjectChatView,
  block: HTMLElement,
) {
  const want = view.visible.map((e) => e.sessionId || e.id);
  const have = [
    ...ul.querySelectorAll<HTMLElement>(":scope > li[data-sid], :scope > li[data-key]"),
  ].map((el) => el.dataset.sid || el.dataset.key || "");
  const needMore = view.expanded && view.visible.length < view.entries.length;
  const hasMore = !!ul.querySelector(":scope > li .chat-more");
  if (
    want.length === have.length &&
    want.length > 0 &&
    want.every((k, i) => k === have[i]) &&
    needMore === hasMore
  ) {
    for (const e of view.visible) {
      const li = e.sessionId
        ? ul.querySelector(`:scope > li[data-sid="${CSS.escape(e.sessionId)}"]`)
        : ul.querySelector(`:scope > li[data-key="${CSS.escape(e.id)}"]`);
      const row = li?.querySelector<HTMLElement>(":scope > .chat-row");
      if (!row) continue;
      row.classList.toggle("active", e.active);
      row.querySelector(".chat-item")?.classList.toggle("active", e.active);
    }
    return;
  }
  ul.replaceChildren();
  for (const e of view.visible) appendSidebarChat(ul, path, e);
  if (needMore) {
    appendChatMore(ul, "Show more", () => {
      chatsShown += CHAT_LIST_CAP;
      paintProjectChatList(block, path);
    });
  }
}

function paintProjectChatList(block: HTMLElement, path: string) {
  // In place — a full sidebar rebuild is the expand flash.
  const view = projectChatView(path, activeChat());
  block
    .querySelector(":scope > .project-row > .project-item")
    ?.classList.toggle("active", view.isActiveProject);
  const icon = block.querySelector<HTMLElement>(".folder-icon");
  if (icon) {
    const prev = folderOpenSeen.get(path);
    folderOpenSeen.set(path, view.folderOpen);
    syncFolderIcon(icon, view.folderOpen, prev);
  }

  let ul = block.querySelector<HTMLUListElement>(":scope > .chat-list");
  const fromH = ul?.getBoundingClientRect().height ?? 0;
  const hasRows =
    view.visible.length > 0 ||
    (view.expanded && view.entries.length > CHAT_LIST_CAP);

  if (!hasRows) {
    if (!ul) return;
    const gone = ul;
    if (motionOk() && fromH > 2) {
      animateChatListHeight(gone, fromH, 0, { remove: true });
    } else {
      gone.remove();
    }
    return;
  }

  if (!ul) {
    ul = document.createElement("ul");
    ul.className = "chat-list";
    if (motionOk()) {
      ul.style.overflow = "hidden";
      ul.style.height = "0px";
      ul.style.opacity = "0";
    }
    block.appendChild(ul);
  }
  const list = ul;
  const first = fromH > 2 ? captureChatFirst(list) : new Map();
  fillProjectChatList(list, path, view, block);
  const toH = list.scrollHeight;
  if (Math.abs(toH - fromH) > 2) {
    animateChatListHeight(list, fromH, toH);
  } else {
    list.style.removeProperty("height");
    list.style.removeProperty("overflow");
    list.style.removeProperty("opacity");
    flipChatFirst(list, first);
  }
}

function appendProjectBlock(
  host: HTMLElement,
  path: string,
  focus: ChatRuntime | null,
) {
  const li = document.createElement("li");
  li.className = "project-block";
  li.dataset.path = path;

  const row = document.createElement("div");
  row.className = "project-row";
  const pinned = isProjectPinned(path);
  if (pinned) row.classList.add("is-pinned");

  const { isActiveProject, folderOpen } = projectChatView(
    path,
    focus,
  );

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "project-item" + (isActiveProject ? " active" : "");

  const icon = document.createElement("span");
  icon.className = "folder-icon";
  const prevOpen = folderOpenSeen.get(path);
  folderOpenSeen.set(path, folderOpen);
  syncFolderIcon(icon, folderOpen, prevOpen);

  const projectCtx: CtxTarget = { kind: "project", cwd: path };
  const renaming =
    !!renameTarget &&
    renameSource === "list" &&
    matchesCtx(renameTarget, projectCtx);

  if (renaming) {
    row.classList.add("renaming");
    const field = document.createElement("input");
    field.type = "text";
    field.className = "chat-rename-input";
    field.value = projectLabel(path);
    field.setAttribute("aria-label", "Rename project");
    field.addEventListener("click", (e) => e.stopPropagation());
    field.addEventListener("pointerdown", (e) => e.stopPropagation());
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      if (save) commitRename(projectCtx, field.value);
      else cancelRename();
    };
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    field.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (!done && renameTarget && matchesCtx(renameTarget, projectCtx)) {
          finish(true);
        }
      }, 0);
    });
    btn.append(icon, field);
    queueMicrotask(() => {
      field.focus();
      field.select();
    });
  } else {
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = projectLabel(path);
    btn.append(icon, name);
    btn.addEventListener("click", () => {
      if (projectDragged) return;
      if (prefs.activeCwd === path) {
        setProjectExpanded(path, !isProjectExpanded(path));
        paintProjectChatList(li, path);
        return;
      }
      pendingExpandPath = path;
      void setActiveProject(path);
    });
  }
  row.appendChild(btn);

  const actions = document.createElement("div");
  actions.className = "chat-actions project-actions";
  const shown = projectLabel(path);
  const pinBtn = document.createElement("button");
  pinBtn.type = "button";
  pinBtn.draggable = false;
  pinBtn.className = "chat-action chat-pin" + (pinned ? " is-on" : "");
  pinBtn.setAttribute(
    "aria-label",
    pinned ? `Unpin ${shown}` : `Pin ${shown}`,
  );
  pinBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
  pinBtn.innerHTML = pinHtml(pinned);
  pinBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setProjectPinned(path, !pinned);
    renderProjects();
  });
  actions.appendChild(pinBtn);
  if (isObsidianVault(path)) {
    const vaultBtn = document.createElement("button");
    vaultBtn.type = "button";
    vaultBtn.draggable = false;
    vaultBtn.className = "chat-action project-vault";
    vaultBtn.setAttribute("aria-label", `Open ${shown} in Obsidian`);
    vaultBtn.innerHTML = OBSIDIAN_SVG;
    vaultBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void openProjectInObsidian(path);
    });
    vaultBtn.addEventListener("contextmenu", (e) => {
      showChatContextMenu(e, projectCtx);
    });
    actions.appendChild(vaultBtn);
  }
  row.appendChild(actions);
  const openProjectMenu = (e: MouseEvent) => {
    showChatContextMenu(e, projectCtx);
  };
  row.addEventListener("contextmenu", openProjectMenu);
  btn.addEventListener("contextmenu", openProjectMenu);
  pinBtn.addEventListener("contextmenu", openProjectMenu);
  li.appendChild(row);

  if (isActiveProject) {
    const chatsUl = document.createElement("ul");
    chatsUl.className = "chat-list";
    fillProjectChatList(chatsUl, path, projectChatView(path, focus), li);
    if (chatsUl.childElementCount > 0) {
      if (pendingExpandPath === path && motionOk()) {
        chatsUl.style.overflow = "hidden";
        chatsUl.style.height = "0px";
        chatsUl.style.opacity = "0";
      }
      li.appendChild(chatsUl);
      if (pendingExpandPath === path) {
        pendingExpandPath = null;
        if (motionOk()) {
          animateChatListHeight(chatsUl, 0, chatsUl.scrollHeight);
        }
      }
    }
  }

  host.appendChild(li);
}

function renderRecentsSection(focus: ChatRuntime | null) {
  const head = $<HTMLElement>("#recents-head");
  const list = recentsList();
  if (!head || !list) return;
  const path = recentsCwd;
  if (!path) {
    const sec = head.closest<HTMLElement>(".nav-section");
    if (sec) sec.hidden = true;
    list.replaceChildren();
    return;
  }
  const entries = buildSidebarEntries(path, focus).filter((e) => !e.pinned);
  const show = entries.length > 0;
  const sec = head.closest<HTMLElement>(".nav-section");
  if (sec) sec.hidden = !show;
  list.replaceChildren();
  if (!show) return;
  const capped = visibleChatWindow(entries, recentsShown);
  for (const e of capped) appendSidebarChat(list, path, e);
  if (capped.length < entries.length) {
    appendChatMore(list, "Show more", () => {
      recentsShown += CHAT_LIST_CAP;
      renderProjects();
    });
  }
}

function chatRowFor(chat: ChatRuntime): HTMLElement | null {
  const root = document.getElementById("sidebar");
  if (!root) return null;
  if (chat.sessionId) {
    const bySid = root.querySelector<HTMLElement>(
      `li[data-sid="${CSS.escape(chat.sessionId)}"] .chat-row`,
    );
    if (bySid) return bySid;
  }
  return root.querySelector<HTMLElement>(
    `li[data-key="${CSS.escape(chat.key)}"] .chat-row`,
  );
}

function paintChatRunRow(chat: ChatRuntime): boolean {
  const row = chatRowFor(chat);
  if (!row) return false;
  const btn = row.querySelector<HTMLButtonElement>(":scope > .chat-item");
  const mark = btn?.querySelector<HTMLElement>(":scope > .chat-item-mark");
  if (!btn || !mark) return false;
  const running = chat.runInFlight;
  const done = !running && chat.doneUnread;
  row.classList.toggle("running", running);
  row.classList.toggle("done", done);
  if (running) {
    mark.hidden = false;
    mark.classList.add("is-spinner");
    mark.classList.remove("is-done");
    mark.innerHTML = SPINNER_SVG;
    btn.setAttribute("aria-busy", "true");
  } else if (done) {
    mark.hidden = false;
    mark.classList.remove("is-spinner");
    mark.classList.add("is-done");
    mark.innerHTML = CHECK_SVG;
    btn.removeAttribute("aria-busy");
  } else {
    mark.hidden = true;
    mark.classList.remove("is-spinner", "is-done");
    mark.replaceChildren();
    btn.removeAttribute("aria-busy");
  }
  return true;
}

function paintRunChrome(chat: ChatRuntime) {
  if (!paintChatRunRow(chat)) renderProjects();
}

function bindNavSections() {
  document.querySelectorAll<HTMLElement>(".nav-section[data-nav]").forEach((sec) => {
    const id = sec.dataset.nav;
    const btn = sec.querySelector<HTMLButtonElement>(".section-toggle");
    const nest = sec.querySelector<HTMLElement>(".nav-nest");
    const chev = sec.querySelector<HTMLElement>(".section-chevron");
    if (!id || !btn || !nest) return;
    if (chev && !chev.childElementCount) {
      chev.appendChild(iconEl(Ico.forward, { size: 16 }));
    }
    const shut = !!prefs.navCollapsed[id];
    sec.classList.toggle("is-collapsed", shut);
    btn.setAttribute("aria-expanded", shut ? "false" : "true");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const next = !sec.classList.contains("is-collapsed");
      if (motionOk()) {
        sec.classList.add("is-motion");
        const onEnd = (ev: TransitionEvent) => {
          if (ev.target !== nest || ev.propertyName !== "grid-template-rows") return;
          sec.classList.remove("is-motion");
          nest.removeEventListener("transitionend", onEnd);
        };
        nest.addEventListener("transitionend", onEnd);
        window.setTimeout(() => sec.classList.remove("is-motion"), DUR_SHELL + 80);
      }
      sec.classList.toggle("is-collapsed", next);
      btn.setAttribute("aria-expanded", next ? "false" : "true");
      if (next) prefs.navCollapsed[id] = true;
      else delete prefs.navCollapsed[id];
      savePrefs();
    });
  });
}

function renderProjects() {
  const list = projectList();
  const hint = projectsHint();
  if (!list) return;

  const focus = activeChat();
  renderPinnedSection(focus);
  renderRecentsSection(focus);

  const folders = unpinnedProjectPaths();
  if (hint) hint.hidden = folders.length > 0;
  const blocks = [
    ...list.querySelectorAll<HTMLElement>(":scope > .project-block"),
  ];
  const same =
    !renameTarget &&
    blocks.length === folders.length &&
    blocks.every((el, i) => el.dataset.path === folders[i]);
  const vaultsOk =
    same &&
    blocks.every((el, i) => {
      const path = folders[i];
      if (!path) return true;
      return isObsidianVault(path) === !!el.querySelector(".project-vault");
    });
  if (same && vaultsOk && folders.length > 0) {
    pendingExpandPath = null;
    for (const block of blocks) {
      const path = block.dataset.path;
      if (path) paintProjectChatList(block, path);
    }
    void scanObsidianVaults();
    return;
  }

  const first = captureChatFirst(document.getElementById("sidebar") ?? list);
  const expanding = pendingExpandPath;
  list.replaceChildren();
  for (const path of folders) {
    appendProjectBlock(list, path, focus);
  }
  pendingExpandPath = null;
  if (!expanding) {
    flipChatFirst(document.getElementById("sidebar") ?? list, first);
  }

  void scanObsidianVaults();
}

function lastLiveChatFor(cwd: string): ChatRuntime | undefined {
  const sid = prefs.sessionByCwd[cwd];
  if (sid && !isHiddenChat(cwd, sid)) {
    const hit = [...chats.values()].find(
      (c) => c.cwd === cwd && c.sessionId === sid,
    );
    if (hit) return hit;
  }
  let best: ChatRuntime | undefined;
  let bestAt = -1;
  for (const c of chats.values()) {
    if (c.cwd !== cwd) continue;
    if (c.sessionId && isHiddenChat(cwd, c.sessionId)) continue;
    const at = c.sessionId
      ? (prefs.lastActive[titleKey(cwd, c.sessionId)] ?? 0)
      : 0;
    if (!best || at > bestAt) {
      best = c;
      bestAt = at;
    }
  }
  return best;
}

async function restoreProjectChat(cwd: string) {
  const live = lastLiveChatFor(cwd);
  if (live) {
    focusChat(live);
    return;
  }
  const sid = prefs.sessionByCwd[cwd];
  if (sid && !isHiddenChat(cwd, sid)) {
    const s = (sessionsCache[cwd] ?? []).find((x) => x.sessionId === sid);
    if (s) {
      await openSession(s.sessionId, s.title, cwd);
      return;
    }
  }
  const chat = makeChat(cwd, { forceNew: true, title: "New chat" });
  focusChat(chat);
}

async function setActiveProject(path: string) {
  const changed = prefs.activeCwd !== path;
  const gen = ++projectSwitchGen;
  prefs.activeCwd = path;
  rememberFolder(path);
  savePrefs();
  updatePlaceholder();

  if (changed) {
    chatsShown = CHAT_LIST_CAP;
    setProjectExpanded(path, true);
  }

  // List first so the main column does not flash an empty New chat.
  await refreshSessionsFor(path, { paint: false });
  if (gen !== projectSwitchGen) return;
  if (changed) await restoreProjectChat(path);
  else renderProjects();
}

async function pickProjectFolder() {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open project folder",
  });
  if (selected === null) return;
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (path) await setActiveProject(path);
}

function scrollActiveChatIntoView() {
  queueMicrotask(() => {
    document
      .querySelector<HTMLElement>(".chat-row.active")
      ?.scrollIntoView({ block: "nearest" });
  });
}

async function startNewChat() {
  const cwd = prefs.activeCwd || (await ensureRecentsCwd());
  if (!cwd) {
    setStatus("Open a project folder first.");
    return;
  }
  const existing = [...chats.values()].find(
    (c) => c.cwd === cwd && isEmptyNewChatDraft(c),
  );
  if (existing) {
    focusChat(existing);
    scrollActiveChatIntoView();
    return;
  }
  const chat = makeChat(cwd, { forceNew: true, title: "New chat" });
  if (isRecentsCwd(cwd)) {
    prefs.activeCwd = cwd;
    savePrefs();
  }
  focusChat(chat);
  scrollActiveChatIntoView();
}

async function restoreLastSession() {
  const cwd = prefs.activeCwd;
  if (!cwd) return;
  await refreshSessionsFor(cwd, { paint: false });
  await restoreProjectChat(cwd);
}

async function openSession(
  sessionId: string,
  title: string,
  cwd = prefs.activeCwd || "",
) {
  if (!cwd) return;
  if (prefs.activeCwd !== cwd) {
    await activateProjectFolder(cwd);
    setProjectExpanded(cwd, true);
  }

  let chat = [...chats.values()].find(
    (c) => c.cwd === cwd && c.sessionId === sessionId,
  );

  if (!chat) {
    const labeled = displayTitle(
      cwd,
      sessionId,
      title || "Chat",
    );
    chat = makeChat(cwd, {
      sessionId,
      forceNew: false,
      title: shortTitle(labeled),
    });
    try {
      const history = await invoke<HistoryMessage[]>("load_session_history", {
        cwd,
        sessionId,
      });
      for (const msg of history) {
        if (msg.role === "user") {
          const attachments = historyAttachments(msg);
          if (!msg.text.trim() && !attachments?.length) continue;
          chat.lines.push({
            kind: "user",
            text: msg.text,
            at: msg.at,
            attachments,
          });
          continue;
        }
        if (msg.role !== "assistant") continue;
        const replay = historyToAssistant(msg);
        if (!replay.thought && replay.parts.length === 0 && replay.work.length === 0) {
          continue;
        }
        for (const step of replay.work) {
          if (step.kind === "tool") {
            applyTodosFromChip(chat, step.chip);
            applySpawnFromChip(chat, step.chip);
            applyReviewFromChip(chat, step.chip);
          }
        }
        chat.lines.push({
          kind: "assistant",
          meta: workMetaLabel(msg.workedSecs),
          thought: replay.thought || undefined,
          parts: replay.parts,
          work: replay.work,
          at: msg.at,
        });
      }
      applyStoredTimes(chat);
      applyStoredQuotes(chat);
      fillMissingWorkMeta(chat);
      await refreshContextUsage(chat);
      if (history.length === 0) {
        chat.status = "Empty history — send a message to continue.";
      }
    } catch (e) {
      chat.status = `Could not load history: ${
        e instanceof Error ? e.message : String(e)
      }`;
    }
  }

  await hydrateSubsFromDisk(chat);
  focusChat(chat);
}

async function checkGrokReady(): Promise<string | null> {
  try {
    await invoke("check_grok");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

type CliUpdate = {
  current: string;
  latest: string;
  available: boolean;
};

const CLI_CHECK_MS = 4 * 60 * 60 * 1000;
const APP_CHECK_MS = 60 * 1000;
const APP_FOCUS_GAP_MS = 60 * 1000;
const CLI_DONE_MS = 4000;
// Survives a reload while grok update replaces the binary.
const CLI_DONE_KEY = "grok-desk.cli-updated";
const APP_DONE_KEY = "grok-desk.app-updated";
let cliUpdating = false;
let appUpdating = false;
let cliLatest = "";
let appLatest = "";
let lastAppPollAt = 0;

function updateBannerBtns(kind: "app" | "cli"): HTMLButtonElement[] {
  if (kind === "app") {
    return [appUpdateBtn(), aboutAppUpdateBtn()].filter(
      (b): b is HTMLButtonElement => !!b,
    );
  }
  return [cliUpdateBtn(), aboutCliUpdateBtn()].filter(
    (b): b is HTMLButtonElement => !!b,
  );
}

function setUpdateBanner(
  kind: "app" | "cli",
  opts: {
    show: boolean;
    label: string;
    title?: string;
    disabled?: boolean;
  },
) {
  for (const btn of updateBannerBtns(kind)) {
    btn.hidden = !opts.show;
    if (!opts.show) continue;
    btn.disabled = !!opts.disabled;
    const lab = btn.querySelector(".update-banner-label");
    if (lab) lab.textContent = opts.label;
    if (opts.title) btn.title = opts.title;
    else btn.removeAttribute("title");
  }
}

function paintCliUpdate(info: CliUpdate | null) {
  if (cliUpdating) return;
  if (!info?.available) {
    setUpdateBanner("cli", {
      show: false,
      label: "Update Grok CLI",
    });
    return;
  }
  cliLatest = info.latest;
  setUpdateBanner("cli", {
    show: true,
    label: "Update Grok CLI",
    title: `Grok CLI ${info.latest} is available`,
  });
}

function paintAppUpdate(available: boolean, version = "") {
  if (appUpdating) return;
  if (!available) {
    setUpdateBanner("app", {
      show: false,
      label: "Update Grotesque",
    });
    return;
  }
  appLatest = version;
  setUpdateBanner("app", {
    show: true,
    label: "Update Grotesque",
    title: version ? `Grotesque ${version} is available` : "A newer Grotesque is available",
  });
}

function showCliUpdated(ver: string) {
  cliUpdating = true;
  setUpdateBanner("cli", {
    show: true,
    label: ver ? `Updated to ${ver}` : "Updated",
    disabled: true,
  });
}

function showAppUpdated(ver: string) {
  appUpdating = true;
  setUpdateBanner("app", {
    show: true,
    label: ver ? `Updated to ${ver}` : "Updated",
    disabled: true,
  });
}

function rememberCliUpdated(ver: string) {
  try {
    sessionStorage.setItem(
      CLI_DONE_KEY,
      JSON.stringify({ ver, at: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

function rememberAppUpdated(ver: string) {
  try {
    sessionStorage.setItem(
      APP_DONE_KEY,
      JSON.stringify({ ver, at: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

function restoreDoneBanner(
  key: string,
  show: (ver: string) => void,
  clear: () => void,
): boolean {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { ver?: string; at?: number };
    const ver = typeof parsed.ver === "string" ? parsed.ver : "";
    const at = typeof parsed.at === "number" ? parsed.at : 0;
    const left = CLI_DONE_MS - (Date.now() - at);
    if (left <= 0) {
      sessionStorage.removeItem(key);
      return false;
    }
    show(ver);
    window.setTimeout(() => {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      clear();
    }, left);
    return true;
  } catch {
    return false;
  }
}

function restoreCliUpdated(): boolean {
  return restoreDoneBanner(
    CLI_DONE_KEY,
    showCliUpdated,
    () => {
      cliUpdating = false;
      void pollCliUpdate();
    },
  );
}

function restoreAppUpdated(): boolean {
  return restoreDoneBanner(
    APP_DONE_KEY,
    showAppUpdated,
    () => {
      appUpdating = false;
      void pollAppUpdate();
    },
  );
}

async function pollCliUpdate() {
  if (cliUpdating) return;
  try {
    const info = await invoke<CliUpdate | null>("check_cli_update");
    paintCliUpdate(info);
  } catch {
    /* quiet */
  }
}

async function pollAppUpdate() {
  if (appUpdating) return;
  lastAppPollAt = Date.now();
  try {
    const update = await checkAppUpdate();
    paintAppUpdate(!!update, update?.version ?? "");
  } catch {
    paintAppUpdate(false);
  }
}

function scheduleAppPoll() {
  if (appUpdating) return;
  if (Date.now() - lastAppPollAt < APP_FOCUS_GAP_MS) return;
  void pollAppUpdate();
}

function waitFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function runCliUpdate() {
  if (cliUpdating) return;
  cliUpdating = true;
  setUpdateBanner("cli", {
    show: true,
    label: "Updating…",
    disabled: true,
  });
  await waitFrame();
  const want = cliLatest;
  try {
    const info = await invoke<CliUpdate>("install_cli_update");
    const ver = (info.current || want).trim();
    if (!info.available) {
      rememberCliUpdated(ver);
      showCliUpdated(ver);
      window.setTimeout(() => {
        try {
          sessionStorage.removeItem(CLI_DONE_KEY);
        } catch {
          /* ignore */
        }
        cliUpdating = false;
        paintCliUpdate(info);
      }, CLI_DONE_MS);
      return;
    }
    cliUpdating = false;
    paintCliUpdate(info);
  } catch {
    cliUpdating = false;
    setUpdateBanner("cli", {
      show: true,
      label: "Update failed",
    });
    window.setTimeout(() => {
      void pollCliUpdate();
    }, CLI_DONE_MS);
  }
}

async function runAppUpdate() {
  if (appUpdating) return;
  if (!(await confirmIfBusy("update"))) return;
  appUpdating = true;
  setUpdateBanner("app", {
    show: true,
    label: "Updating…",
    disabled: true,
  });
  await waitFrame();
  try {
    const update = await checkAppUpdate();
    if (!update) {
      appUpdating = false;
      paintAppUpdate(false);
      return;
    }
    await update.downloadAndInstall();
    const ver = (update.version || appLatest).trim();
    rememberAppUpdated(ver);
    showAppUpdated(ver);
    await relaunch();
  } catch {
    appUpdating = false;
    setUpdateBanner("app", {
      show: true,
      label: "Update failed",
    });
    window.setTimeout(() => {
      void pollAppUpdate();
    }, CLI_DONE_MS);
  }
}

// data-tauri-drag-region does not cover children. Drag after a 4px move.
function bindWinbarDrag() {
  const bind = (el: HTMLElement | null) => {
    if (!el) return;
    let down: { x: number; y: number } | null = null;
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || e.detail >= 2) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("button, input, textarea, select, a")) return;
      down = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("mousemove", (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (dx * dx + dy * dy < 16) return;
      down = null;
      void getCurrentWindow().startDragging();
    });
    window.addEventListener("mouseup", () => {
      down = null;
    });
  };
  bind(document.querySelector(".winbar-main"));
  bind(document.querySelector(".winbar-side"));
}

function chatVisible(chat: ChatRuntime): boolean {
  if (chat.surface === "panel") return frontAgent()?.key === chat.key;
  return activeChatKey === chat.key;
}

let frontAgentCached: ChatRuntime | null = null;
let frontAgentAt = "";

function frontAgent(): ChatRuntime | null {
  const main = activeChat();
  if (!main) {
    frontAgentCached = null;
    frontAgentAt = "";
    return null;
  }
  const tab = frontTabOf(panelOf(main.key));
  if (!tab || tab.kind === "page" || tab.kind === "plan") {
    frontAgentCached = null;
    frontAgentAt = "";
    return null;
  }
  const at = `${main.key}:${tab.id}`;
  if (frontAgentCached && frontAgentAt === at) return frontAgentCached;
  frontAgentCached = sideForTab(tab.id);
  frontAgentAt = at;
  return frontAgentCached;
}

function paintHostFor(chat: ChatRuntime): HTMLElement | null {
  if (chat.surface === "panel") {
    return frontAgent()?.key === chat.key ? sideTranscript() : null;
  }
  return activeChatKey === chat.key ? transcript() : null;
}

function panelStoreKey(chat: ChatRuntime): string {
  return waitStoreKey(chat.cwd, chat.sessionId, chat.key);
}

function persistPanel(main: ChatRuntime) {
  const panel = panels.get(main.key);
  const key = panelStoreKey(main);
  const draftKey = waitStoreKey(main.cwd, null, main.key);
  if (draftKey !== key && prefs.panels[draftKey]) {
    prefs.panels[key] = prefs.panels[draftKey];
    delete prefs.panels[draftKey];
  }
  if (!panel) {
    delete prefs.panels[key];
    savePrefs();
    return;
  }
  const pagesOut: string[] = [];
  let sideCount = 0;
  let planText: string | undefined;
  for (const tab of panel.tabs) {
    if (tab.kind === "side") sideCount += 1;
    if (tab.kind === "page") {
      const page = pageForTab(tab.id);
      if (page?.url) pagesOut.push(page.url);
    }
    if (tab.kind === "plan") planText = panel.plan?.text ?? "";
  }
  const next: StoredPanel = {
    open: panel.open,
    pages: pagesOut,
    sideCount,
    ...(planText != null ? { planText } : {}),
  };
  const prev = prefs.panels[key];
  if (
    prev &&
    prev.open === next.open &&
    prev.sideCount === next.sideCount &&
    prev.pages.length === next.pages.length &&
    prev.pages.every((u, i) => u === next.pages[i]) &&
    (prev.planText ?? "") === (next.planText ?? "")
  ) {
    return;
  }
  prefs.panels[key] = next;
  savePrefs();
}

function restorePanel(main: ChatRuntime) {
  const stored = prefs.panels[panelStoreKey(main)];
  if (!stored) return;
  const panel = panelOf(main.key);
  if (panel.tabs.length) {
    panel.open = stored.open || panel.open;
    return;
  }
  for (const url of stored.pages) {
    const page = makePageTab();
    page.url = url;
    page.title = hostnameOf(url);
    page.history = [url];
    page.histIndex = 0;
    panel.tabs.push({ id: page.id, kind: "page" });
  }
  if (typeof stored.planText === "string") {
    panel.plan = { reqId: null, text: stored.planText, editable: false };
    panel.tabs.push({ id: PLAN_TAB_ID, kind: "plan" });
  }
  for (let i = 0; i < stored.sideCount; i++) {
    const side = makeSideTab(main);
    panel.tabs.push({ id: side.tabId || side.key, kind: "side" });
  }
  panel.front = panel.tabs[0]?.id ?? null;
  panel.open = stored.open;
}

function panelOf(mainKey: string): RightPanel {
  let p = panels.get(mainKey);
  if (p) return p;
  p = { open: false, tabs: [], front: null };
  panels.set(mainKey, p);
  return p;
}

function frontTabOf(p: RightPanel): PanelTab | null {
  if (!p.front) return null;
  return p.tabs.find((t) => t.id === p.front) ?? null;
}

function sideForTab(tabId: string): SideChat | null {
  return tabAgents.get(tabId) ?? null;
}

function pageForTab(tabId: string): PageTab | null {
  return pages.get(tabId) ?? null;
}

function hideEl(el: HTMLElement | null, hidden: boolean) {
  if (!el) return;
  el.hidden = hidden;
  if (hidden) el.setAttribute("hidden", "");
  else el.removeAttribute("hidden");
}

function makePickRow(kind: PanelTabKind): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "panel-pick";
  btn.role = "menuitem";
  const mark = document.createElement("span");
  mark.className = "panel-pick-mark";
  mark.appendChild(iconEl(kind === "page" ? Ico.globe : Ico.sidePick, { size: 16 }));
  const lab = document.createElement("span");
  lab.textContent = kind === "page" ? "Browser" : "Side chat";
  btn.append(mark, lab);
  btn.addEventListener("click", () => {
    hidePlusMenu();
    if (kind === "page") addPageTab();
    else addSideTab();
  });
  return btn;
}

function paintPanelPicks(host: HTMLElement | null) {
  if (!host) return;
  host.replaceChildren(makePickRow("page"), makePickRow("side"));
}

let plusOverlayOpen = false;

function plusMenuIsOpen(): boolean {
  return plusOverlayOpen || panelPlusMenu()?.hidden === false;
}

function browserCoversPanel(): boolean {
  const main = activeChat();
  const tab = main ? frontTabOf(panelOf(main.key)) : null;
  const page = tab?.kind === "page" ? pageForTab(tab.id) : null;
  const stage = browserStage();
  return (
    isSidePanelOpen() &&
    !pageOpen() &&
    !!page?.url &&
    !page.error &&
    !!stage &&
    !stage.hidden
  );
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function titlebarH(): number {
  return parseFloat(cssVar("--titlebar-h")) || 52;
}

function plusCardHtml(): string {
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  const font = cssVar("--font") || "system-ui, sans-serif";
  const pop = cssVar("--pop-solid");
  const border = cssVar("--border-strong");
  const text = cssVar("--text");
  const fill = cssVar("--fill-mid");
  const radius = cssVar("--radius-pop");
  const radiusSm = cssVar("--radius-sm");
  const globe = iconHtml(Ico.globe, { size: 16 });
  const side = iconHtml(Ico.sidePick, { size: 16 });
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:${pop};overflow:hidden;height:100%;font:16px/1.5 ${font};color:${text};-webkit-user-select:none;user-select:none}
.menu{margin:0;width:100%;height:100%;padding:6px;display:flex;flex-direction:column;gap:2px;border-radius:${radius};background:${pop};border:1px solid ${border}}
.pick{display:flex;align-items:center;flex:0 0 auto;gap:8px;width:100%;padding:8px 10px;border:none;border-radius:${radiusSm};background:transparent;color:${text};font-size:14px;line-height:1.5;text-align:left;cursor:default}
.pick.is-hover{background:${fill}}
.mark{width:16px;height:16px;flex-shrink:0;display:grid;place-items:center}
.mark svg{width:16px;height:16px;display:block}
</style></head><body>
<div class="menu" role="menu" aria-label="Add tab">
<button type="button" class="pick" role="menuitem" data-pick="pick/page"><span class="mark">${globe}</span><span>Browser</span></button>
<button type="button" class="pick" role="menuitem" data-pick="pick/side"><span class="mark">${side}</span><span>Side chat</span></button>
</div>
<script>
document.addEventListener('click', function (e) {
  var a = e.target.closest('[data-pick]');
  if (!a) return;
  e.preventDefault();
  var pick = a.getAttribute('data-pick');
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.plus) {
    window.webkit.messageHandlers.plus.postMessage(pick);
  }
});
</script></body></html>`;
}

function hidePlusMenu() {
  plusOverlayOpen = false;
  hideEl(panelPlusMenu(), true);
  panelAddBtn()?.setAttribute("aria-expanded", "false");
  void invoke("plus_menu_set", {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    visible: false,
    html: null,
  }).catch(() => {});
}

function measurePlusMenu(): { w: number; h: number } {
  const menu = panelPlusMenu();
  if (!menu) return { w: 220, h: 90 };
  paintPanelPicks(menu);
  menu.style.visibility = "hidden";
  hideEl(menu, false);
  placePlusMenu();
  const box = menu.getBoundingClientRect();
  const w = box.width > 1 ? box.width : 220;
  const h = box.height > 1 ? box.height : 90;
  hideEl(menu, true);
  menu.style.visibility = "";
  return { w, h };
}

async function openPlusOverlay() {
  const add = panelAddBtn()?.getBoundingClientRect();
  const pane = document.getElementById("side-pane")?.getBoundingClientRect();
  const stage = browserStage()?.getBoundingClientRect();
  if (!add || !pane || !stage) return;
  const { w, h } = measurePlusMenu();
  let left = add.left;
  if (left + w > pane.right - 8) left = pane.right - w - 8;
  if (left < pane.left + 8) left = pane.left + 8;
  const top = add.bottom + 4;
  plusOverlayOpen = true;
  panelAddBtn()?.setAttribute("aria-expanded", "true");
  hideEl(panelPlusMenu(), true);
  try {
    await invoke("plus_menu_set", {
      x: left - stage.left,
      y: top - stage.top,
      w,
      h,
      visible: true,
      html: plusCardHtml(),
    });
  } catch (e) {
    plusOverlayOpen = false;
    panelAddBtn()?.setAttribute("aria-expanded", "false");
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(msg);
    const st = sideStatus();
    if (st) st.textContent = msg;
  }
}

function placePlusMenu() {
  const menu = panelPlusMenu();
  const add = panelAddBtn();
  const pane = document.getElementById("side-pane");
  if (!menu || !add || !pane) return;
  const ar = add.getBoundingClientRect();
  const pr = pane.getBoundingClientRect();
  const w = Math.min(220, pr.width - 20);
  let left = ar.left - pr.left;
  if (left + w > pr.width - 8) left = pr.width - w - 8;
  menu.style.top = `${Math.max(titlebarH() + 4, ar.bottom - pr.top + 4)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.right = "auto";
  menu.style.width = `${w}px`;
}

function showPlusMenu() {
  panelAddBtn()?.setAttribute("aria-expanded", "true");
  if (browserCoversPanel()) {
    void openPlusOverlay();
    return;
  }
  const menu = panelPlusMenu();
  if (!menu) return;
  paintPanelPicks(menu);
  placePlusMenu();
  hideEl(menu, false);
}

function togglePlusMenu() {
  if (plusMenuIsOpen()) hidePlusMenu();
  else showPlusMenu();
}

function makeSideTab(main: ChatRuntime): SideChat {
  const tabId = crypto.randomUUID();
  const side = makeChat(main.cwd, {
    key: `side:${main.key}:${tabId}`,
    forceNew: true,
    title: "Side chat",
    model: main.model,
    effort: main.effort,
    mode: "auto",
    surface: "panel",
    mainKey: main.key,
    tabId,
    seeded: false,
  });
  inheritSideFromMain(side, main);
  tabAgents.set(tabId, side);
  return side;
}

function makeSubTab(main: ChatRuntime, sub: LiveSub): ChatRuntime {
  const tabId = crypto.randomUUID();
  const agent = makeChat(main.cwd, {
    key: `sub:${main.key}:${sub.id}`,
    sessionId: sub.id,
    forceNew: false,
    title: sub.label || sub.name || "Subagent",
    model: main.model,
    effort: main.effort,
    mode: main.mode,
    surface: "panel",
    mainKey: main.key,
    tabId,
    subLabel: sub.name || sub.label,
  });
  tabAgents.set(tabId, agent);
  return agent;
}

function makePageTab(): PageTab {
  const page: PageTab = {
    id: crypto.randomUUID(),
    url: "",
    title: "",
    loading: false,
    error: "",
    history: [],
    histIndex: -1,
    scrollY: 0,
  };
  pages.set(page.id, page);
  return page;
}

function applyHistoryToAgent(agent: ChatRuntime, history: HistoryMessage[]) {
  agent.lines = [];
  // Sub tabs lead with the prose answer. The machine prompt stays out.
  const hideMachine = !!agent.subLabel;
  for (const msg of history) {
    if (msg.role === "user") {
      let text = msg.text;
      if (hideMachine && isSpawnPrompt(text)) text = formatSpawnPrompt(text);
      const attachments = historyAttachments(msg);
      if (!text.trim() && !attachments?.length) continue;
      agent.lines.push({
        kind: "user",
        text,
        at: msg.at,
        attachments,
      });
      continue;
    }
    if (msg.role !== "assistant") continue;
    const replay = historyToAssistant(msg);
    if (hideMachine) {
      for (const p of replay.parts) {
        if (p.kind === "text") p.text = stripEvidenceFences(p.text);
      }
      for (const s of replay.work) {
        if (s.kind === "text") s.text = stripEvidenceFences(s.text);
      }
      replay.parts = replay.parts.filter((p) => p.kind !== "text" || p.text.trim());
      replay.work = replay.work.filter((s) => s.kind !== "text" || s.text.trim());
    }
    for (const step of replay.work) {
      if (step.kind === "tool") {
        applyTodosFromChip(agent, step.chip);
        applySpawnFromChip(agent, step.chip);
        applyReviewFromChip(agent, step.chip);
      }
    }
    if (!replay.thought && replay.parts.length === 0 && replay.work.length === 0) {
      continue;
    }
    agent.lines.push({
      kind: "assistant",
      meta: workMetaLabel(msg.workedSecs),
      thought: replay.thought || undefined,
      at: msg.at,
      parts: replay.parts,
      work: replay.work,
    });
  }
  fillMissingWorkMeta(agent);
  applyStoredQuotes(agent);
}

async function fillSubHistory(main: ChatRuntime, agent: ChatRuntime) {
  if (!agent.sessionId) return;
  let history: HistoryMessage[] = [];
  try {
    if (main.sessionId) {
      history = await invoke<HistoryMessage[]>("load_subagent_history", {
        cwd: agent.cwd,
        parentId: main.sessionId,
        subId: agent.sessionId,
        label:
          agent.title !== agent.subLabel
            ? agent.title
            : agent.subLabel || "",
      });
    } else {
      history = await invoke<HistoryMessage[]>("load_session_history", {
        cwd: agent.cwd,
        sessionId: agent.sessionId,
      });
    }
  } catch {
    history = [];
  }
  applyHistoryToAgent(agent, history);
  if (frontAgent()?.key === agent.key) showPanelFor(main);
}

function openSubagentTab(main: ChatRuntime | null, sub: LiveSub) {
  if (!main) return;
  if (!canUseSideChat(main)) {
    setStatus("Send a message in the main chat first.");
    return;
  }
  void (async () => {
    await hydrateSubsFromDisk(main);
    const current =
      main.liveSubs.find((s) => s.id === sub.id || s.name === sub.name) ?? sub;
    openSubagentTabNow(main, current);
  })();
}

function openSubagentTabNow(main: ChatRuntime, sub: LiveSub) {
  const named = nameSub(main, sub);
  sub.name = named.name;
  const panel = panelOf(main.key);
  const existing = [...agents.values()].find(
    (a) =>
      a.mainKey === main.key &&
      (a.sessionId === sub.id || a.key === `sub:${main.key}:${sub.id}`),
  );
  if (existing?.tabId && panel.tabs.some((t) => t.id === existing.tabId)) {
    existing.subLabel = named.name;
    existing.title = sub.label || existing.title;
    existing.sessionId = sub.id;
    panel.front = existing.tabId;
    panel.open = true;
    showPanelFor(main);
    void fillSubHistory(main, existing);
    return;
  }
  const agent = existing ?? makeSubTab(main, named);
  agent.subLabel = named.name;
  agent.title = sub.label || agent.title;
  agent.sessionId = sub.id;
  if (!agent.tabId) agent.tabId = crypto.randomUUID();
  if (!panel.tabs.some((t) => t.id === agent.tabId)) {
    panel.tabs.push({ id: agent.tabId, kind: "sub" });
  }
  panel.front = agent.tabId;
  panel.open = true;
  void fillSubHistory(main, agent);
  showPanelFor(main);
  persistPanel(main);
}

function addSideTab(main = activeChat()) {
  if (!main || !canUseSideChat(main)) {
    setStatus(
      !prefs.activeCwd
        ? "Open a project folder first."
        : "Send a message in the main chat first.",
    );
    return;
  }
  const panel = panelOf(main.key);
  const side = makeSideTab(main);
  panel.tabs.push({ id: side.tabId!, kind: "side" });
  panel.front = side.tabId!;
  panel.open = true;
  showPanelFor(main);
  persistPanel(main);
}

function addPageTab(url = "") {
  const main = activeChat();
  if (!main || !canUseSideChat(main)) {
    setStatus(
      !prefs.activeCwd
        ? "Open a project folder first."
        : "Send a message in the main chat first.",
    );
    return;
  }
  const panel = panelOf(main.key);
  const page = makePageTab();
  panel.tabs.push({ id: page.id, kind: "page" });
  panel.front = page.id;
  panel.open = true;
  showPanelFor(main);
  if (url.trim()) void navigatePage(page, url);
  persistPanel(main);
}

function selectPanelTab(tabId: string) {
  const main = activeChat();
  if (!main) return;
  const panel = panelOf(main.key);
  if (!panel.tabs.some((t) => t.id === tabId)) return;
  const prev = frontTabOf(panel);
  if (prev?.kind === "side") {
    const side = sideForTab(prev.id);
    if (side) side.draft = sideInput()?.value ?? side.draft;
  } else if (prev?.kind === "plan") {
    flushPlanEdit(main);
  }
  panel.front = tabId;
  frontAgentCached = null;
  frontAgentAt = "";
  showPanelFor(main);
}

async function closePanelTab(tabId: string) {
  const main = activeChat();
  if (!main) return;
  const panel = panelOf(main.key);
  const idx = panel.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = panel.tabs[idx];
  if (tab.kind === "side" || tab.kind === "sub") {
    const side = sideForTab(tab.id);
    if (side) {
      try {
        await invoke("reset_session", { chatKey: side.key });
      } catch {
        /* ok */
      }
      agents.delete(side.key);
      if (side.tabId) tabAgents.delete(side.tabId);
    }
  } else if (tab.kind === "page") {
    pages.delete(tab.id);
  } else if (tab.kind === "plan") {
    flushPlanEdit(main);
    panel.plan = undefined;
  }
  frontAgentCached = null;
  frontAgentAt = "";
  panel.tabs.splice(idx, 1);
  if (panel.front === tabId) {
    const next = panel.tabs[idx] ?? panel.tabs[idx - 1] ?? null;
    panel.front = next?.id ?? null;
  }
  showPanelFor(main);
  persistPanel(main);
}

let tabStripSig = "";
let tabDragged = false;
let tabDrag: {
  pointerId: number;
  from: string;
  main: ChatRuntime;
  panel: RightPanel;
  x: number;
  y: number;
  live: boolean;
  insert: number;
  handle: HTMLElement;
  pill: HTMLElement | null;
  line: HTMLElement | null;
  grabX: number;
  grabY: number;
  bases: { id: string; left: number; width: number }[];
  scroll0: number;
} | null = null;

const TAB_STRIP_GAP = 2;

function tabStripCols(
  bases: { left: number; width: number }[],
  scroll0: number,
  scroll: number,
): { left: number; width: number }[] {
  const d = scroll - scroll0;
  return bases.map((b) => ({ left: b.left - d, width: b.width }));
}

function insertIndexAtX(x: number, cols: { left: number; width: number }[]): number {
  for (let i = 0; i < cols.length; i++) {
    const r = cols[i];
    if (x < r.left + r.width / 2) return i;
  }
  return cols.length;
}

function applyTabShifts(row: HTMLElement, fromId: string, insert: number) {
  const tabs = [...row.querySelectorAll<HTMLElement>(".panel-tab")];
  const from = tabs.findIndex((t) => t.dataset.id === fromId);
  applyAxisShifts(tabs, from, insert, "x", TAB_STRIP_GAP);
}

function flipPanelTabs(first: Map<string, DOMRect>) {
  const row = panelTabsRow();
  if (!row || !motionOk()) return;
  const tabs = [...row.querySelectorAll<HTMLElement>(".panel-tab")];
  for (const el of tabs) {
    const a = first.get(el.dataset.id || "");
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    if (Math.abs(dx) < 1) continue;
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
  }
  row.getBoundingClientRect();
  for (const el of tabs) {
    el.style.transition = `transform var(--dur-enter) ${EASE_OUT}`;
    el.style.transform = "";
  }
  const clear = () => {
    for (const el of tabs) {
      el.style.transition = "";
      el.style.transform = "";
    }
    row.removeEventListener("transitionend", onEnd);
  };
  const onEnd = (ev: TransitionEvent) => {
    if (ev.propertyName !== "transform") return;
    clear();
  };
  row.addEventListener("transitionend", onEnd);
  window.setTimeout(clear, 220);
}

function positionTabPill(
  pill: HTMLElement,
  x: number,
  y: number,
  grabX: number,
  grabY: number,
) {
  pill.style.transform = `translate3d(${Math.round(x - grabX)}px, ${Math.round(y - grabY)}px, 0)`;
}

function makeTabPill(src: HTMLElement, x: number, y: number, grabX: number, grabY: number): HTMLElement {
  const pill = document.createElement("div");
  pill.className = "panel-tab-drag-pill";
  pill.setAttribute("aria-hidden", "true");
  const mark = src.querySelector(".panel-tab-mark");
  if (mark) pill.appendChild(mark.cloneNode(true));
  const lab = document.createElement("span");
  lab.className = "panel-tab-name";
  lab.textContent =
    src.querySelector(".panel-tab-name")?.textContent?.trim() || "Tab";
  pill.append(lab);
  pill.style.width = `${src.offsetWidth}px`;
  document.body.appendChild(pill);
  positionTabPill(pill, x, y, grabX, grabY);
  return pill;
}

function commitTabInsert(panel: RightPanel, fromId: string, insert: number) {
  const from = panel.tabs.findIndex((t) => t.id === fromId);
  if (from < 0) return;
  let dest = Math.max(0, Math.min(insert, panel.tabs.length));
  if (dest === from || dest === from + 1) return;
  const [moved] = panel.tabs.splice(from, 1);
  if (from < dest) dest -= 1;
  panel.tabs.splice(dest, 0, moved);
}

function endTabDrag(commit: boolean) {
  const drag = tabDrag;
  tabDrag = null;
  uiDragActive = false;
  const row = panelTabsRow();
  row?.classList.remove("is-shifting");
  if (drag?.handle) drag.handle.style.removeProperty("touch-action");
  const first = new Map<string, DOMRect>();
  if (commit && drag?.live && motionOk() && row) {
    for (const el of row.querySelectorAll<HTMLElement>(".panel-tab")) {
      const id = el.dataset.id;
      if (id) first.set(id, el.getBoundingClientRect());
    }
    if (drag.pill) first.set(drag.from, drag.pill.getBoundingClientRect());
  }
  drag?.pill?.remove();
  drag?.line?.remove();
  document.body.classList.remove("is-tab-dragging");
  document
    .querySelector(".panel-tab.is-drag-source")
    ?.classList.remove("is-drag-source");
  if (drag?.handle.hasPointerCapture(drag.pointerId)) {
    drag.handle.releasePointerCapture(drag.pointerId);
  }
  window.setTimeout(() => {
    tabDragged = false;
  }, 0);
  if (!drag?.live) return;
  if (commit) {
    commitTabInsert(drag.panel, drag.from, drag.insert);
    persistPanel(drag.main);
  }
  tabStripSig = "";
  paintPanelTabs();
  if (commit && first.size) flipPanelTabs(first);
}

function onTabPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  const t = e.target as HTMLElement;
  if (t.closest(".panel-tab-x")) return;
  const btn = t.closest<HTMLElement>(".panel-tab");
  const row = panelTabsRow();
  const from = btn?.dataset.id;
  if (!btn || !row || !from) return;
  const main = activeChat();
  const panel = main ? panelOf(main.key) : null;
  if (!main || !panel || panel.tabs.length < 2) return;
  tabDrag = {
    pointerId: e.pointerId,
    from,
    main,
    panel,
    x: e.clientX,
    y: e.clientY,
    live: false,
    insert: 0,
    handle: btn,
    pill: null,
    line: null,
    grabX: 0,
    grabY: 0,
    bases: [],
    scroll0: 0,
  };
  btn.style.touchAction = "none";
  try {
    btn.setPointerCapture(e.pointerId);
  } catch {
    /* capture optional */
  }
}

function onTabPointerMove(e: PointerEvent) {
  const drag = tabDrag;
  if (!drag || e.pointerId !== drag.pointerId) return;
  const row = panelTabsRow();
  if (!row) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.live) {
    if (dx * dx + dy * dy < PROJECT_DRAG_PX * PROJECT_DRAG_PX) return;
    drag.live = true;
    tabDragged = true;
    uiDragActive = true;
    setDropOverlay(false);
    document.body.classList.add("is-tab-dragging");
    drag.handle.classList.add("is-drag-source");
    const origin = drag.handle.getBoundingClientRect();
    drag.grabX = drag.x - origin.left;
    drag.grabY = drag.y - origin.top;
    drag.pill = makeTabPill(drag.handle, e.clientX, e.clientY, drag.grabX, drag.grabY);
    drag.bases = [...row.querySelectorAll<HTMLElement>(".panel-tab")].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.id || "", left: r.left, width: r.width };
    });
    drag.scroll0 = row.scrollLeft;
    if (motionOk()) row.classList.add("is-shifting");
  }
  e.preventDefault();
  if (drag.pill) {
    positionTabPill(drag.pill, e.clientX, e.clientY, drag.grabX, drag.grabY);
  }
  const box = row.getBoundingClientRect();
  if (e.clientX < box.left + 24) row.scrollLeft -= 12;
  else if (e.clientX > box.right - 24) row.scrollLeft += 12;
  const cols = tabStripCols(drag.bases, drag.scroll0, row.scrollLeft);
  drag.insert = insertIndexAtX(e.clientX, cols);
  applyTabShifts(row, drag.from, drag.insert);
}

function onTabPointerUp(e: PointerEvent) {
  if (!tabDrag || e.pointerId !== tabDrag.pointerId) return;
  endTabDrag(e.type === "pointerup");
}

function onTabPointerKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !tabDrag?.live) return;
  e.preventDefault();
  endTabDrag(false);
}

function panelTabSig(panel: RightPanel): string {
  let s = panel.front || "";
  for (const tab of panel.tabs) {
    s += `|${tab.kind}:${tab.id}`;
    if (tab.kind === "page") {
      const page = pageForTab(tab.id);
      s += `:${page?.title || ""}:${page?.loading ? 1 : 0}:${page?.url || ""}`;
    } else if (tab.kind === "plan") {
      s += ":Plan";
    } else {
      const side = sideForTab(tab.id);
      s += `:${side?.runInFlight ? 1 : 0}:${side?.subLabel || ""}`;
    }
  }
  return s;
}

function paintPanelTabs() {
  const row = panelTabsRow();
  const strip = panelTabs();
  const main = activeChat();
  const panel = main ? panelOf(main.key) : null;
  const tabs = panel?.tabs ?? [];
  hideEl(strip, tabs.length === 0);
  if (!row) return;
  if (!panel || !main) {
    if (tabStripSig) {
      row.replaceChildren();
      tabStripSig = "";
    }
    return;
  }
  const sig = panelTabSig(panel);
  if (sig === tabStripSig && row.childElementCount === tabs.length) return;
  tabStripSig = sig;
  row.replaceChildren();
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "panel-tab" + (panel.front === tab.id ? " is-on" : "");
    btn.role = "tab";
    btn.setAttribute("aria-selected", panel.front === tab.id ? "true" : "false");
    btn.dataset.id = tab.id;
    const mark = document.createElement("span");
    mark.className = "panel-tab-mark";
    const name = document.createElement("span");
    name.className = "panel-tab-name";
    const spin = document.createElement("span");
    spin.className = "panel-tab-spin";
    hideEl(spin, true);
    if (tab.kind === "side" || tab.kind === "sub") {
      const side = sideForTab(tab.id);
      if (tab.kind === "sub") {
        const subName = side?.subLabel || side?.title || "Subagent";
        name.textContent = subName;
        mark.appendChild(subMarkEl(subName));
      } else {
        mark.appendChild(iconEl(Ico.sidePick, { size: 16 }));
        name.textContent = "Side chat";
      }
      btn.title = name.textContent;
      if (side?.runInFlight) {
        spin.innerHTML = SPINNER_SVG;
        hideEl(spin, false);
      }
    } else if (tab.kind === "plan") {
      mark.appendChild(iconEl(Ico.modePlan, { size: 16 }));
      name.textContent = "Plan";
      btn.title = "Plan";
    } else {
      const page = pageForTab(tab.id);
      const title = page?.title.trim() || (page?.url ? hostnameOf(page.url) : "New tab");
      name.textContent = title;
      btn.title = page?.url || "New tab";
      if (page?.url) paintMarkFavicon(mark, page.url);
      else mark.appendChild(iconEl(Ico.globe, { size: 16 }));
      if (page?.loading) {
        spin.innerHTML = SPINNER_SVG;
        hideEl(spin, false);
      }
    }
    const x = document.createElement("button");
    x.type = "button";
    x.className = "panel-tab-x";
    x.title = "Close tab";
    x.setAttribute("aria-label", "Close tab");
    x.appendChild(iconEl(Ico.close, { size: 12 }));
    x.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void closePanelTab(tab.id);
    });
    btn.append(mark, name, spin, x);
    btn.addEventListener("click", () => {
      if (tabDragged) return;
      selectPanelTab(tab.id);
    });
    row.appendChild(btn);
  }
}

function paintBrowserChrome(page: PageTab | null) {
  hideEl(browserChrome(), !page);
  hideEl(browserEmpty(), !(page && !page.url && !page.error));
  hideEl(browserError(), !(page && !!page.error));
  hideEl(browserStage(), !(page && !!page.url && !page.error));
  const err = browserError();
  if (err) err.textContent = page?.error ?? "";
  const field = browserUrl();
  if (field && document.activeElement !== field) {
    field.value = page?.url ?? "";
  }
  const back = browserBackBtn();
  const fwd = browserForwardBtn();
  const reload = browserReloadBtn();
  if (back) back.disabled = !page || page.histIndex <= 0;
  if (fwd) fwd.disabled = !page || page.histIndex >= page.history.length - 1;
  if (reload) {
    const stop = !!page?.loading;
    if (reload.dataset.stop !== String(stop)) {
      reload.dataset.stop = String(stop);
      reload.title = stop ? "Stop" : "Reload";
      reload.setAttribute("aria-label", reload.title);
      replaceIcon(reload, stop ? Ico.stop : Ico.retry, { size: 16 });
    }
  }
}

let browserBoundsRaf = 0;
let browserBoundsBusy = false;
let lastBrowserBox = "";

function syncBrowserBounds() {
  // One frame so a live divider drag keeps the native page in sync.
  if (browserBoundsRaf) return;
  browserBoundsRaf = requestAnimationFrame(() => {
    browserBoundsRaf = 0;
    void applyBrowserBounds();
  });
}

function hideNativeBrowser() {
  if (lastBrowserBox === "hide") return;
  lastBrowserBox = "hide";
  browserBoundsBusy = true;
  void invoke("browser_set_bounds", {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    visible: false,
  })
    .catch(() => {
      /* ok */
    })
    .finally(() => {
      browserBoundsBusy = false;
    });
}

async function applyBrowserBounds() {
  if (browserBoundsBusy) {
    syncBrowserBounds();
    return;
  }
  const stage = browserStage();
  const pane = sidePane();
  const main = activeChat();
  const tab = main ? frontTabOf(panelOf(main.key)) : null;
  const page = tab?.kind === "page" ? pageForTab(tab.id) : null;
  const show =
    isSidePanelOpen() &&
    !pageOpen() &&
    !!page?.url &&
    !page.error &&
    !!stage &&
    !stage.hidden &&
    !!pane;
  if (!show) {
    hideNativeBrowser();
    return;
  }
  const r = stage.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  // Inner chrome keeps --side-open-w while the pane eases from 0; CSS overflow
  // does not clip this native page, so wait until the pane has width.
  if (p.width <= 2 || r.width <= 2 || r.height <= 2) {
    hideNativeBrowser();
    return;
  }
  const box = `${r.left | 0},${r.top | 0},${r.width | 0},${r.height | 0}`;
  if (box === lastBrowserBox) return;
  const appeared = lastBrowserBox === "hide";
  lastBrowserBox = box;
  browserBoundsBusy = true;
  try {
    await invoke("browser_set_bounds", {
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      visible: true,
    });
  } catch (e) {
    lastBrowserBox = "";
    if (page) page.error = e instanceof Error ? e.message : String(e);
    paintBrowserChrome(page);
    return;
  } finally {
    browserBoundsBusy = false;
  }
  if (appeared) {
    lastBrowserBox = "";
    syncBrowserBounds();
  }
}

function pushPageHistory(page: PageTab, url: string) {
  const href = url.trim();
  if (!href) return;
  if (page.history[page.histIndex] === href) return;
  page.history = page.history.slice(0, page.histIndex + 1);
  page.history.push(href);
  page.histIndex = page.history.length - 1;
}

async function navigatePage(page: PageTab, raw: string) {
  const href = raw.trim();
  if (!href) return;
  page.error = "";
  page.loading = true;
  paintBrowserChrome(page);
  paintPanelTabs();
  try {
    const opened = await invoke<string>("browser_navigate", { url: href });
    page.url = opened;
    pushPageHistory(page, opened);
    if (!page.title) page.title = hostnameOf(opened);
  } catch (e) {
    page.loading = false;
    page.error = e instanceof Error ? e.message : String(e);
    if (!page.url) page.url = href;
  }
  paintBrowserChrome(page);
  paintPanelTabs();
  syncBrowserBounds();
  const owner = activeChat();
  if (owner) persistPanel(owner);
}

async function reloadOrStopPage() {
  const page = frontPage();
  if (!page) return;
  if (page.loading) {
    try {
      await invoke("browser_stop");
    } catch {
      /* ok */
    }
    page.loading = false;
    paintBrowserChrome(page);
    paintPanelTabs();
    return;
  }
  if (!page.url) return;
  page.loading = true;
  page.error = "";
  paintBrowserChrome(page);
  try {
    await invoke("browser_reload");
  } catch (e) {
    page.loading = false;
    page.error = e instanceof Error ? e.message : String(e);
  }
  paintBrowserChrome(page);
  paintPanelTabs();
}

async function stepPage(delta: number) {
  const page = frontPage();
  if (!page) return;
  const next = page.histIndex + delta;
  if (next < 0 || next >= page.history.length) return;
  page.histIndex = next;
  const url = page.history[next];
  if (!url) return;
  page.error = "";
  page.loading = true;
  paintBrowserChrome(page);
  try {
    const opened = await invoke<string>("browser_navigate", { url });
    page.url = opened;
  } catch (e) {
    page.loading = false;
    page.error = e instanceof Error ? e.message : String(e);
  }
  paintBrowserChrome(page);
  paintPanelTabs();
  syncBrowserBounds();
}

function frontPage(): PageTab | null {
  const main = activeChat();
  if (!main) return null;
  const tab = frontTabOf(panelOf(main.key));
  if (tab?.kind !== "page") return null;
  return pageForTab(tab.id);
}

function onBrowserNav(ev: { url?: string; title?: string; loading?: boolean }) {
  const page = frontPage();
  if (!page) return;
  if (ev.url && ev.url !== "about:blank") {
    page.url = ev.url;
    pushPageHistory(page, ev.url);
    if (!page.title || page.title === hostnameOf(page.url)) {
      page.title = hostnameOf(ev.url);
    }
    if (typeof ev.loading === "boolean") page.loading = ev.loading;
    page.error = "";
  }
  if (ev.title?.trim()) page.title = ev.title.trim();
  paintBrowserChrome(page);
  paintPanelTabs();
}

function planInlineMarkdown(el: Node): string {
  if (el.nodeType === Node.TEXT_NODE) return el.textContent ?? "";
  if (!(el instanceof HTMLElement)) return "";
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || el.classList.contains("code-toolbar")) return "";
  if (tag === "br") return "\n";
  const inner = [...el.childNodes].map(planInlineMarkdown).join("");
  if (tag === "strong" || tag === "b") return `**${inner}**`;
  if (tag === "em" || tag === "i") return `*${inner}*`;
  if (tag === "code") return `\`${inner}\``;
  if (tag === "a") {
    const href = el.getAttribute("href") || "";
    if (!href || href.startsWith("javascript:")) return inner;
    return inner && inner !== href ? `[${inner}](${href})` : href;
  }
  return inner;
}

function planListMarkdown(list: HTMLElement, ordered: boolean, indent: number): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  let n = 1;
  for (const child of list.children) {
    if (!(child instanceof HTMLElement) || child.tagName !== "LI") continue;
    const nested: string[] = [];
    const bits: string[] = [];
    for (const node of child.childNodes) {
      if (
        node instanceof HTMLElement &&
        (node.tagName === "UL" || node.tagName === "OL")
      ) {
        nested.push(planListMarkdown(node, node.tagName === "OL", indent + 1));
      } else {
        bits.push(planInlineMarkdown(node));
      }
    }
    const prefix = ordered ? `${n}. ` : "- ";
    n += 1;
    const line = `${pad}${prefix}${bits.join("").trim()}`;
    lines.push(nested.length ? `${line}\n${nested.join("\n")}` : line);
  }
  return lines.join("\n");
}

function planBlocksMarkdown(root: HTMLElement): string {
  const parts: string[] = [];
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").trim();
      if (t) parts.push(t);
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === "button" || node.classList.contains("code-toolbar")) continue;
    if (/^h[1-6]$/.test(tag)) {
      parts.push(`${"#".repeat(Number(tag[1]))} ${planInlineMarkdown(node).trim()}`);
      continue;
    }
    if (tag === "p") {
      const t = planInlineMarkdown(node).trim();
      if (t) parts.push(t);
      continue;
    }
    if (tag === "ul") {
      parts.push(planListMarkdown(node, false, 0));
      continue;
    }
    if (tag === "ol") {
      parts.push(planListMarkdown(node, true, 0));
      continue;
    }
    if (tag === "pre" || node.classList.contains("code-block")) {
      const code = node.querySelector("code") ?? node.querySelector("pre");
      const lang =
        node.querySelector(".code-lang")?.textContent?.trim() ||
        (code instanceof HTMLElement
          ? [...code.classList]
              .find((c) => c.startsWith("language-"))
              ?.slice("language-".length)
          : "") ||
        "";
      const body = (code?.textContent ?? node.textContent ?? "").replace(/\n$/, "");
      parts.push(`\`\`\`${lang === "code" ? "" : lang}\n${body}\n\`\`\``);
      continue;
    }
    if (tag === "blockquote") {
      const inner = planBlocksMarkdown(node) || planInlineMarkdown(node).trim();
      parts.push(
        inner
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
      );
      continue;
    }
    if (tag === "hr") {
      parts.push("---");
      continue;
    }
    const nested = planBlocksMarkdown(node);
    if (nested) parts.push(nested);
    else {
      const t = planInlineMarkdown(node).trim();
      if (t) parts.push(t);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

function planViewToMarkdown(view: HTMLElement): string {
  return planBlocksMarkdown(view).trim();
}

function flushPlanEdit(main: ChatRuntime) {
  const panel = panelOf(main.key);
  const view = planView();
  if (!panel.plan?.editable || !view) return;
  const text = planViewToMarkdown(view);
  panel.plan.text = text;
  const id = panel.plan.reqId;
  if (id != null) {
    const line = planLineOf(main, id);
    if (line) line.edited = text;
  }
  const copy = planCopyBtn();
  if (copy) copy.dataset.markdown = text;
}

function paintPlanPane(panel: RightPanel) {
  const view = planView();
  const copy = planCopyBtn();
  const plan = panel.plan;
  const text = plan?.text ?? "";
  if (copy) {
    copy.dataset.markdown = text;
    copy.dataset.copyLabel = "Copy";
  }
  if (!view) return;
  const editing = !!plan?.editable;
  view.spellcheck = false;
  view.setAttribute("aria-label", "Plan");
  if (editing && view.contains(document.activeElement)) return;
  view.contentEditable = editing ? "true" : "false";
  if (text.trim()) {
    view.className = "plan-pane-view plan-body";
    setMarkdown(view, text, {
      drawDiagrams: false,
      linkify: true,
      media: false,
    });
    view.querySelectorAll<HTMLElement>("button, .code-toolbar").forEach((el) => {
      el.contentEditable = "false";
    });
  } else if (editing) {
    view.className = "plan-pane-view plan-body markdown";
    view.replaceChildren();
  } else {
    view.className = "plan-pane-view";
    view.contentEditable = "false";
    view.replaceChildren();
    view.textContent = "No plan written yet.";
  }
}

function openPlanTab(chat: ChatRuntime, req: PlanRequest, editable: boolean) {
  flushPlanEdit(chat);
  const panel = panelOf(chat.key);
  let tab = panel.tabs.find((t) => t.kind === "plan");
  if (!tab) {
    tab = { id: PLAN_TAB_ID, kind: "plan" };
    panel.tabs.push(tab);
  }
  panel.plan = {
    reqId: req.id,
    text: planTextOf(chat, req),
    editable,
  };
  panel.front = tab.id;
  panel.open = true;
  showPanelFor(chat);
  persistPanel(chat);
}

function showPanelFor(main: ChatRuntime) {
  const panel = panelOf(main.key);
  applySideWidth(prefs.sideWidth || DEFAULT_SIDE_W);
  setSideChromeOpen(true);
  hideEl(panelEmpty(), panel.tabs.length > 0);
  hideEl(panelBody(), panel.tabs.length === 0);
  if (panel.tabs.length === 0) {
    paintPanelPicks(panelEmpty());
    hideEl(sideTranscript(), true);
    hideEl(sideComposerDock(), true);
    hideEl(planPane(), true);
    paintBrowserChrome(null);
    paintPanelTabs();
    const st = sideStatus();
    if (st) st.textContent = "";
    hidePlusMenu();
    syncBrowserBounds();
    return;
  }
  paintPanelTabs();
  const tab = frontTabOf(panel);
  hidePlusMenu();
  if (tab?.kind === "side" || tab?.kind === "sub") {
    const side = sideForTab(tab.id);
    paintBrowserChrome(null);
    hideEl(planPane(), true);
    hideEl(sideTranscript(), false);
    hideEl(sideComposerDock(), false);
    if (side) {
      if (tab.kind === "side") inheritSideFromMain(side, main);
      else side.mode = main.mode;
      rebuildSideTranscript(side);
      setSideStatus(side, side.status);
      setSideBusy(side, side.runInFlight);
      const field = sideInput();
      if (field) field.value = side.draft;
      updatePlaceholder();
      renderSideAttachChips(side);
      renderSideWaiting(side);
    }
  } else if (tab?.kind === "plan") {
    hideEl(sideTranscript(), true);
    hideEl(sideComposerDock(), true);
    paintBrowserChrome(null);
    hideEl(planPane(), false);
    paintPlanPane(panel);
  } else {
    hideEl(sideTranscript(), true);
    hideEl(sideComposerDock(), true);
    hideEl(planPane(), true);
    paintBrowserChrome(tab ? pageForTab(tab.id) : null);
  }
  if (findOpen && findSide && tab?.kind !== "side") {
    closeFind();
  }
  syncBrowserBounds();
}

function paintChromeIcons() {
  mountMorph(toggleSidebarBtn(), Ico.sidebar, { size: 16 });
  replaceIcon(chatSearchBtn(), Ico.search, { size: 16 });
  replaceIcon($<HTMLElement>("#find-ico"), Ico.find, { size: 14 });
  replaceIcon(findPrevBtn(), Ico.back, { size: 14 });
  replaceIcon(findNextBtn(), Ico.forward, { size: 14 });
  replaceIcon(findCloseBtn(), Ico.close, { size: 14 });
  replaceIcon(navBackBtn(), Ico.back, { size: 16 });
  replaceIcon(navForwardBtn(), Ico.forward, { size: 16 });
  replaceIcon(topbarNewChatBtn(), Ico.newChat, { size: 16 });
  replaceIcon(openSideBtn(), Ico.sideChat, { size: 16 });
  replaceIcon(tasksPinBtn(), Ico.tasks, { size: 16 });
  replaceIcon(panelAddBtn(), Ico.plus, { size: 16 });
  replaceIcon(browserBackBtn(), Ico.back, { size: 16 });
  replaceIcon(browserForwardBtn(), Ico.forward, { size: 16 });
  replaceIcon(browserReloadBtn(), Ico.retry, { size: 16 });
  replaceIcon($<HTMLElement>("#browser-empty-mark"), Ico.globe, { size: 16 });
  replaceIcon($<HTMLElement>("#side-empty-mark"), Ico.sidePick, { size: 16 });
  replaceIcon(planCopyBtn(), Ico.copy, { size: 16 });
  replaceIcon(sideAttachBtn(), Ico.plus, { size: 16 });
  replaceIcon($<HTMLButtonElement>("#new-chat-btn"), Ico.newChat, {
    size: 16,
    className: "new-chat-icon",
  });
  replaceIcon(pluginsNavBtn(), Ico.plugins, {
    size: 16,
    className: "new-chat-icon",
  });
  replaceIcon(settingsNavBtn(), Ico.settings, {
    size: 16,
    className: "new-chat-icon",
  });
  replaceIcon($<HTMLElement>("#app-update-ico"), Ico.download, { size: 16 });
  replaceIcon($<HTMLElement>("#cli-update-ico"), Ico.cli, { size: 16 });
  replaceIcon($<HTMLElement>("#about-app-update-ico"), Ico.download, { size: 16 });
  replaceIcon($<HTMLElement>("#about-cli-update-ico"), Ico.cli, { size: 16 });
  replaceIcon(openFolderBtn(), Ico.plus, { size: 16 });
  replaceIcon($<HTMLButtonElement>("#type-smaller"), Ico.minus, { size: 16 });
  replaceIcon($<HTMLButtonElement>("#type-larger"), Ico.plus, { size: 16 });
  replaceIcon(attachBtn(), Ico.plus, { size: 16 });
  replaceIcon(jumpLatestBtn(), Ico.jumpLatest, { size: 16 });
  const send = runBtn();
  if (send) {
    send.replaceChildren(
      iconEl(Ico.send, { size: 16, className: "send-icon" }),
      iconEl(Ico.stop, { size: 16, className: "stop-icon" }),
    );
  }
  const sideSend = sideSendBtn();
  if (sideSend) {
    sideSend.replaceChildren(
      iconEl(Ico.send, { size: 16, className: "send-icon" }),
      iconEl(Ico.stop, { size: 16, className: "stop-icon" }),
    );
  }
  const close = closeSideBtn();
  if (close) close.replaceChildren(iconEl(Ico.close, { size: 16 }));
}

function setSidebarOpen(open: boolean, persist = true) {
  if (persist) armShellMotion();
  const bar = sidebarEl();
  const shell = document.getElementById("shell");
  const toggle = toggleSidebarBtn();
  if (bar) {
    if (open) {
      if (!bar.classList.contains("is-open")) {
        bar.classList.remove("is-open");
        void bar.offsetWidth;
        bar.classList.add("is-open");
      }
    } else {
      bar.classList.remove("is-open");
    }
    bar.setAttribute("aria-hidden", open ? "false" : "true");
    if (open) bar.removeAttribute("inert");
    else bar.setAttribute("inert", "");
  }
  shell?.classList.toggle("sidebar-open", open);
  const split = sidebarSplitter();
  if (split) {
    split.classList.toggle("is-open", open);
    split.setAttribute("aria-hidden", open ? "false" : "true");
  }
  if (toggle) {
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    const label = open ? "Hide sidebar" : "Show sidebar";
    toggle.title = label;
    toggle.setAttribute("aria-label", label);
  }
  const topNew = topbarNewChatBtn();
  if (topNew) {
    if (open) {
      topNew.hidden = true;
      topNew.setAttribute("hidden", "");
    } else {
      topNew.hidden = false;
      topNew.removeAttribute("hidden");
    }
  }
  if (persist) {
    prefs.sidebarOpen = open;
    savePrefs();
  }
  syncBrowserBounds();
}

function applySidebarWidth(px: number) {
  const w = clampSidebarWidth(px);
  document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
  prefs.sidebarWidth = w;
  syncBrowserBounds();
}

function applySideWidth(px: number) {
  const w = clampSideWidth(px);
  document.documentElement.style.setProperty("--side-w", `${w}px`);
  prefs.sideWidth = w;
  syncBrowserBounds();
}

function isSidePanelOpen(): boolean {
  return !!sidePane()?.classList.contains("is-open");
}

function setSideChromeOpen(open: boolean) {
  armShellMotion();
  const pane = sidePane();
  const split = sideSplitter();
  const openBtn = openSideBtn();
  const w = prefs.sideWidth || DEFAULT_SIDE_W;
  document.documentElement.style.setProperty("--side-w", `${w}px`);

  if (pane) {
    pane.setAttribute("aria-hidden", open ? "false" : "true");
    if (!pane.classList.contains("is-resizing")) {
      pane.style.removeProperty("width");
    }
    if (open) {
      if (!pane.classList.contains("is-open")) {
        pane.classList.remove("is-open");
        void pane.offsetWidth;
        pane.classList.add("is-open");
      }
    } else {
      pane.classList.remove("is-open");
    }
  }
  if (split) {
    split.classList.toggle("is-open", open);
    split.setAttribute("aria-hidden", open ? "false" : "true");
  }
  if (openBtn) {
    const show = !open && canUseSideChat(activeChat());
    if (!show) {
      openBtn.hidden = true;
      openBtn.setAttribute("hidden", "");
      openBtn.disabled = true;
    } else {
      openBtn.hidden = false;
      openBtn.removeAttribute("hidden");
      openBtn.disabled = false;
    }
    openBtn.setAttribute("aria-expanded", open ? "true" : "false");
    const label = open ? "Close panel" : "Open panel";
    openBtn.title = label;
    openBtn.setAttribute("aria-label", label);
  }
  const sideChrome = winbarSide();
  if (sideChrome) {
    sideChrome.hidden = false;
    sideChrome.removeAttribute("hidden");
    sideChrome.setAttribute("aria-hidden", open ? "false" : "true");
  }
  document.getElementById("shell")?.classList.toggle("side-open", open);
  if (!open) hidePlusMenu();
  syncBrowserBounds();
}

function setSideBusy(side: SideChat, busy: boolean) {
  side.runInFlight = busy;
  if (!busy) side.stopRequested = false;
  applySideComposerLock(side);
  paintPanelTabs();
}

function applySideComposerLock(side: SideChat) {
  const field = sideInput();
  const hasPrompt =
    !!(field?.value ?? "").trim() || side.attachments.length > 0;
  if (field) field.disabled = false;
  const busy = side.runInFlight;
  paintStopSend(sideSendBtn(), {
    busy,
    enabled: busy || hasPrompt,
    stopTitle: "Stop",
    sendTitle: "Send",
  });
}

function paintSideEmpty(side: SideChat) {
  const empty = sideEmpty();
  if (!empty) return;
  const show = side.lines.length === 0 && !side.runInFlight;
  hideEl(empty, !show);
  const title = empty.querySelector<HTMLElement>(".panel-blank-title");
  const line = empty.querySelector<HTMLElement>(".panel-blank-line");
  if (title && line) {
    if (side.subLabel) {
      title.textContent = side.subLabel;
      line.textContent = side.title && side.title !== side.subLabel
        ? side.title
        : "Still working…";
      line.hidden = false;
      line.removeAttribute("hidden");
    } else {
      title.textContent = "Side chat";
      line.textContent = "";
      line.hidden = true;
      line.setAttribute("hidden", "");
    }
  }
  applySideComposerLock(side);
}

function drainSideWaiting(side: SideChat) {
  if (side.runInFlight || side.waiting.length === 0) return;
  const next = side.waiting.shift();
  if (!next) return;
  persistWaiting(side);
  renderSideWaiting(side);
  void runSidePrompt(next.text, {
    chat: side,
    displayText: next.text,
    attachments: next.attachments,
  });
}

function renderSideWaiting(side: SideChat | null) {
  renderWaitingOn(side, sideWaitingBlock(), sideWaitingList(), true);
}

function refreshSideRetryChrome(side: SideChat | null) {
  refreshRetryOn(side, sideTranscript(), () => {
    if (side) void retryLast(side);
  });
}

function editUserBubble(
  bubble: HTMLElement,
  original: string,
  allowEmpty: boolean,
  onSave: (next: string) => Promise<void>,
  onCancel?: () => void,
) {
  if (bubble.isContentEditable) return;
  let finished = false;
  bubble.replaceChildren();
  bubble.textContent = original;
  bubble.contentEditable = "true";
  bubble.classList.add("is-editing", "can-edit");
  bubble.focus();
  const range = document.createRange();
  range.selectNodeContents(bubble);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const stack = bubble.closest(".user-stack");
  const bar = document.createElement("div");
  bar.className = "user-edit-bar";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "user-edit-cancel";
  cancel.textContent = "Cancel";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "user-edit-send";
  send.textContent = "Send";
  bar.append(cancel, send);
  const meta = stack?.querySelector(".user-meta");
  if (stack && meta) stack.insertBefore(bar, meta);
  else stack?.append(bar);
  const restore = () => {
    paintUserText(bubble, original);
    onCancel?.();
  };
  const finish = async (save: boolean) => {
    if (finished) return;
    finished = true;
    bubble.contentEditable = "false";
    bubble.classList.remove("is-editing");
    bubble.removeEventListener("keydown", onKey);
    bar.remove();
    if (!save) {
      restore();
      return;
    }
    const next = (bubble.textContent ?? "").trim();
    if (!next && !allowEmpty) {
      restore();
      return;
    }
    if (next === original) {
      restore();
      return;
    }
    await onSave(next);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void finish(true);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      void finish(false);
    }
  };
  bubble.addEventListener("keydown", onKey);
  cancel.addEventListener("mousedown", (e) => e.preventDefault());
  send.addEventListener("mousedown", (e) => e.preventDefault());
  cancel.addEventListener("click", () => void finish(false));
  send.addEventListener("click", () => void finish(true));
}

async function beginEditSideLast(side: SideChat, bubble: HTMLElement) {
  if (side.runInFlight) return;
  const idx = lastUserLineIndex(side);
  if (idx < 0) return;
  const line = side.lines[idx];
  if (line.kind !== "user") return;
  editUserBubble(bubble, line.text, !!(line.attachments?.length), async (next) => {
    line.text = next;
    side.lines = side.lines.slice(0, idx + 1);
    rebuildSideTranscript(side);
    await runSidePrompt(next, {
      chat: side,
      displayText: next,
      attachments: line.attachments,
    });
  });
}

async function retryLast(chat: ChatRuntime) {
  if (!canRetry(chat)) return;
  const prompt = chat.lastUserPrompt ?? "";
  const atts = chat.lastUserAttachments;
  const idx = lastUserLineIndex(chat);
  if (idx >= 0) chat.lines = chat.lines.slice(0, idx + 1);
  chat.lastStopped = false;
  if (chat.surface === "panel") {
    if (chatVisible(chat)) rebuildSideTranscript(chat);
    await runSidePrompt(prompt, {
      chat,
      displayText: prompt,
      attachments: atts,
    });
    return;
  }
  if (activeChatKey === chat.key) rebuildTranscript(chat);
  await runPrompt(prompt, {
    replaceUser: true,
    attachments: atts,
  });
}

function refreshSideEditChrome(side: SideChat | null) {
  refreshEditChrome(side, sideTranscript());
}

function setSideStatus(side: SideChat, text: string) {
  side.status = text;
  const el = sideStatus();
  if (el && chatVisible(side) && isSidePanelOpen()) {
    el.textContent = text;
  }
}

function scrollSideTranscript() {
  const t = sideTranscript();
  if (t) t.scrollTop = t.scrollHeight;
}

function buildMainContextText(main: ChatRuntime): string {
  const chunks: string[] = [];
  for (const line of main.lines) {
    if (line.kind === "user") {
      chunks.push(`User: ${line.text}`);
    } else if (line.kind === "assistant") {
      let text = joinTextParts(line.parts).trim();
      if (!text && main.runInFlight && lastAssistantLine(main) === line) {
        text =
          main.liveStream?.querySelector(".live-type")?.textContent?.trim() ||
          "";
      }
      if (text) chunks.push(`Assistant: ${text}`);
    }
  }
  let out = chunks.join("\n\n");
  if (out.length > 12000) out = `${out.slice(0, 12000)}\n\n[…truncated]`;
  return out || "(Main chat has no text yet.)";
}

function rebuildSideTranscript(side: SideChat) {
  const t = sideTranscript();
  if (!t) return;
  rebuildTranscript(side, t);
  paintSideEmpty(side);
  scrollSideTranscript();
}

function lastSideAssistantRow(): HTMLElement | null {
  const rows = sideTranscript()?.querySelectorAll(".msg-row.assistant");
  if (!rows?.length) return null;
  return rows[rows.length - 1] as HTMLElement;
}

function stampLastSideAnswer(side: SideChat) {
  const last = [...side.lines].reverse().find((l) => l.kind === "assistant");
  if (!last || last.kind !== "assistant") return;
  stampAnswerMeta(lastSideAssistantRow(), {
    at: last.at,
    markdown: joinTextParts(last.parts),
  });
  markLastAssistant(sideTranscript());
}

function inheritSideFromMain(side: SideChat, main: ChatRuntime) {
  if (side.seeded || side.sessionId || side.runInFlight) return;
  side.model = main.model;
  side.effort = main.effort;
}

function ensureFrontSide(main: ChatRuntime): SideChat {
  const live = activeSide();
  if (live && live.mainKey === main.key) return live;
  const panel = panelOf(main.key);
  const front = frontTabOf(panel);
  if (front?.kind === "side") {
    const side = sideForTab(front.id);
    if (side) return side;
  }
  const existing = panel.tabs.find((t) => t.kind === "side");
  if (existing) {
    const side = sideForTab(existing.id);
    if (side) {
      panel.front = existing.id;
      return side;
    }
  }
  const side = makeSideTab(main);
  panel.tabs.push({ id: side.tabId!, kind: "side" });
  panel.front = side.tabId!;
  return side;
}

function openSidePanel() {
  const main = activeChat();
  if (!main || !canUseSideChat(main)) {
    setStatus(
      !prefs.activeCwd
        ? "Open a project folder first."
        : "Send a message in the main chat first.",
    );
    return;
  }
  const panel = panelOf(main.key);
  panel.open = true;
  showPanelFor(main);
  if (frontTabOf(panel)?.kind === "side") sideInput()?.focus();
}

function hideSidePanel() {
  const main = activeChat();
  if (main) {
    const panel = panelOf(main.key);
    panel.open = false;
    persistPanel(main);
    const tab = frontTabOf(panel);
    if (tab?.kind === "side") {
      const side = sideForTab(tab.id);
      if (side) side.draft = sideInput()?.value ?? side.draft;
    } else if (tab?.kind === "plan") {
      flushPlanEdit(main);
    }
  }
  hidePlusMenu();
  setSideChromeOpen(false);
  syncBrowserBounds();
  if (findSide) {
    findSide = false;
    if (findOpen) {
      placeFindBar();
      refreshFindHits();
    }
  }
  const st = sideStatus();
  if (st) st.textContent = "";
}

function syncSidePanelForMain(main: ChatRuntime | null) {
  const openBtn = openSideBtn();
  if (pageOpen() || !main || !canUseSideChat(main)) {
    setSideChromeOpen(false);
    if (openBtn) {
      openBtn.hidden = true;
      openBtn.setAttribute("hidden", "");
    }
    syncBrowserBounds();
    return;
  }
  const panel = panelOf(main.key);
  if (panel.open) showPanelFor(main);
  else setSideChromeOpen(false);
}

async function discardSideForMainKey(mainKey: string) {
  const panel = panels.get(mainKey);
  const doomed = [...sides.values()].filter((s) => s.mainKey === mainKey);
  for (const side of doomed) {
    try {
      await invoke("reset_session", { chatKey: side.key });
    } catch {
      /* ok */
    }
    sides.delete(side.key);
    if (side.tabId) tabAgents.delete(side.tabId);
  }
  frontAgentCached = null;
  frontAgentAt = "";
  if (panel) {
    for (const tab of panel.tabs) {
      if (tab.kind === "page") pages.delete(tab.id);
    }
    panel.tabs = [];
    panel.front = null;
    panel.open = false;
    panel.plan = undefined;
  }
  if (activeChatKey === mainKey && isSidePanelOpen()) {
    hideSidePanel();
  }
}

const SIDE_VAULT_FILES = ["AGENTS.md", "ME.md", "SOUL.md", "TREE.md"] as const;

function sideVaultNamesAsked(text: string): string[] {
  return SIDE_VAULT_FILES.filter((name) => {
    const stem = name.replace(/\.md$/i, "");
    return new RegExp(`\\b${stem}(?:\\.md)?\\b`, "i").test(text);
  });
}

async function loadAskedVaultFiles(cwd: string, text: string): Promise<string> {
  const names = sideVaultNamesAsked(text);
  if (!names.length) return "";
  const parts: string[] = [];
  for (const name of names) {
    try {
      const body = (await invoke<string>("read_project_text", { cwd, name })).trim();
      parts.push(body ? `--- ${name} ---\n${body}` : `--- ${name} ---\n(empty)`);
    } catch {
      parts.push(`--- ${name} ---\n(not on disk)`);
    }
  }
  return parts.join("\n\n");
}

function sideDirectPrompt(
  text: string,
  opts?: { files?: string; context?: string },
): string {
  const files = opts?.files?.trim()
    ? `\n\nThe user asked for these project files:\n\n${opts.files}`
    : "";
  const context = opts?.context?.trim()
    ? `\n\nMain chat (as is):\n\n${opts.context}`
    : "";
  return (
    "Answer this side-chat request only. Continue from the main chat if it appears below. Do not load project bootstrap files unless they appear below. Do not narrate loading context. Reply with the answer.\n\n" +
    text +
    context +
    files
  );
}

async function stopSideTurn(side: SideChat) {
  if (!side.runInFlight || side.stopRequested) return;
  side.stopRequested = true;
  paintStoppedNow(side);
  try {
    await invoke("stop_turn", { chatKey: side.key });
  } catch {
    /* hub may already be gone */
  }
}

function activeSide(): SideChat | null {
  const main = activeChat();
  if (!main) return null;
  const tab = frontTabOf(panelOf(main.key));
  if (tab?.kind !== "side") return null;
  return sideForTab(tab.id);
}

async function runSidePrompt(
  text: string,
  opts?: { displayText?: string; attachments?: Attachment[]; chat?: ChatRuntime },
) {
  const main = activeChat();
  if (!main || !prefs.activeCwd) {
    const el = sideStatus();
    if (el) el.textContent = "Open a project first.";
    return;
  }
  const side = opts?.chat ?? frontAgent() ?? ensureFrontSide(main);
  const trimmed = text.trim();
  const atts = opts?.attachments ?? [];
  const fileAtts = atts.filter((a) => a.kind !== "quote");
  if (!trimmed && fileAtts.length === 0) return;
  if (side.runInFlight) {
    enqueueWaiting(side, trimmed, atts);
    return;
  }
  const display = opts?.displayText ?? trimmed;
  const context = side.seeded ? "" : buildMainContextText(main);
  const sendText =
    side.surface === "panel" && !side.key.startsWith("sub:")
      ? sideDirectPrompt(trimmed, {
          files: await loadAskedVaultFiles(main.cwd, trimmed),
          context,
        })
      : trimmed;
  await runPrompt(sendText, {
    chat: side,
    attachments: atts,
    replaceUser: false,
    displayText: display,
  });
  if (context) side.seeded = true;
}

async function submitSideComposer() {
  const field = sideInput();
  const text = (field?.value ?? "").trim();
  const main = activeChat();
  if (!main) return;
  const side = frontAgent() ?? ensureFrontSide(main);
  const quotes = side.attachments.filter((a) => a.kind === "quote");
  const quoteBlock = quotes
    .map((a) => (a.quote ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  const sendText = quoteBlock
    ? text
      ? `${quoteBlock}\n\n${text}`
      : quoteBlock
    : text;
  const atts = [...side.attachments];
  if (!sendText && atts.length === 0) {
    if (!side.runInFlight && side.waiting.length) drainSideWaiting(side);
    return;
  }
  if (text) {
    for (const a of quotes) a.comment = text;
  }
  side.attachments = [];
  renderSideAttachChips(side);
  if (field) {
    field.value = "";
    side.draft = "";
  }
  applySideComposerLock(side);
  await runSidePrompt(sendText, { chat: side, displayText: text, attachments: atts });
}

function bindSidebarResize() {
  const split = sidebarSplitter();
  if (!split) return;
  let dragging = false;
  let moved = false;
  let collapsed = false;
  let lastPx = prefs.sidebarWidth || DEFAULT_SIDEBAR_W;
  let startW = 0;
  let widthRaf = 0;
  const pauseLiveWidth = () => {
    if (widthRaf) {
      cancelAnimationFrame(widthRaf);
      widthRaf = 0;
    }
    clearWidthPreview();
    sidebarEl()?.classList.remove("is-resizing");
    document.getElementById("shell")?.classList.remove("is-sidebar-resizing");
  };
  const flushWidth = () => {
    widthRaf = 0;
    if (!dragging || collapsed) return;
    previewSidebarWidth(lastPx);
  };
  const release = (e: PointerEvent) => {
    try {
      split.releasePointerCapture(e.pointerId);
    } catch {
      /* ok */
    }
  };
  const haltDrag = () => {
    dragging = false;
    dividerDragging = false;
    if (widthRaf) {
      cancelAnimationFrame(widthRaf);
      widthRaf = 0;
    }
    split.classList.remove("is-dragging");
    document.getElementById("shell")?.classList.remove("is-sidebar-resizing");
    sidebarEl()?.classList.remove("is-resizing");
  };
  split.addEventListener("pointerdown", (e) => {
    if (prefs.sidebarOpen === false) return;
    const bar = sidebarEl();
    if (!bar) return;
    dragging = true;
    moved = false;
    collapsed = false;
    lastPx = prefs.sidebarWidth || DEFAULT_SIDEBAR_W;
    startW = Math.round(bar.getBoundingClientRect().width);
    split.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  split.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    lastPx = e.clientX;
    if (!moved) {
      if (Math.abs(lastPx - startW) < 2) return;
      moved = true;
      dividerDragging = true;
      split.classList.add("is-dragging");
      sidebarEl()?.classList.add("is-resizing");
      document.getElementById("shell")?.classList.add("is-sidebar-resizing");
    }
    const bar = sidebarEl();
    const shell = document.getElementById("shell");
    if (!collapsed && lastPx < COLLAPSE_SIDEBAR_W) {
      collapsed = true;
      pauseLiveWidth();
      armShellMotion();
      setSidebarOpen(false, false);
      return;
    }
    if (collapsed) {
      if (lastPx < MIN_SIDEBAR_W) return;
      // Pointer keeps driving width. Do not wait for the shell spring.
      collapsed = false;
      bar?.classList.add("is-resizing");
      shell?.classList.add("is-sidebar-resizing");
      previewSidebarWidth(lastPx);
      setSidebarOpen(true, false);
      return;
    }
    if (!widthRaf) widthRaf = requestAnimationFrame(flushWidth);
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    const didMove = moved;
    const shut = collapsed;
    haltDrag();
    release(e);
    if (!didMove) {
      clearWidthPreview();
      return;
    }
    if (shut || lastPx < COLLAPSE_SIDEBAR_W) {
      clearWidthPreview();
      setSidebarOpen(false);
      afterDividerDrag();
      return;
    }
    applySidebarWidth(lastPx);
    clearWidthPreview();
    savePrefs();
    afterDividerDrag();
  };
  split.addEventListener("pointerup", endDrag);
  split.addEventListener("pointercancel", endDrag);
}

function bindSideResize() {
  const pane = sidePane();
  if (pane) {
    new ResizeObserver(() => {
      if (plusOverlayOpen) void openPlusOverlay();
      else if (plusMenuIsOpen()) placePlusMenu();
      syncBrowserBounds();
    }).observe(pane);
  }
  const stage = browserStage();
  if (stage) new ResizeObserver(() => syncBrowserBounds()).observe(stage);
  const split = sideSplitter();
  if (!split) return;
  let dragging = false;
  let moved = false;
  let lastW = prefs.sideWidth || DEFAULT_SIDE_W;
  let startW = 0;
  let edge = 0;
  let widthRaf = 0;
  const flushWidth = () => {
    widthRaf = 0;
    if (!dragging) return;
    previewSideWidth(lastW);
  };
  split.addEventListener("pointerdown", (e) => {
    if (!isSidePanelOpen()) return;
    const pane = sidePane();
    if (!pane) return;
    dragging = true;
    moved = false;
    lastW = prefs.sideWidth || DEFAULT_SIDE_W;
    const rect = pane.getBoundingClientRect();
    startW = Math.round(rect.width);
    edge = rect.right;
    split.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  split.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    lastW = edge - e.clientX;
    if (!moved) {
      if (Math.abs(lastW - startW) < 2) return;
      moved = true;
      dividerDragging = true;
      split.classList.add("is-dragging");
      sidePane()?.classList.add("is-resizing");
      document.getElementById("shell")?.classList.add("is-side-resizing");
    }
    if (!widthRaf) widthRaf = requestAnimationFrame(flushWidth);
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    const didMove = moved;
    dragging = false;
    dividerDragging = false;
    if (widthRaf) {
      cancelAnimationFrame(widthRaf);
      widthRaf = 0;
    }
    split.classList.remove("is-dragging");
    document.getElementById("shell")?.classList.remove("is-side-resizing");
    sidePane()?.classList.remove("is-resizing");
    try {
      split.releasePointerCapture(e.pointerId);
    } catch {
      /* ok */
    }
    if (!didMove) {
      clearWidthPreview();
      return;
    }
    applySideWidth(lastW);
    clearWidthPreview();
    savePrefs();
    afterDividerDrag();
  };
  split.addEventListener("pointerup", endDrag);
  split.addEventListener("pointercancel", endDrag);
}

async function submitComposer() {
  const text = composerText().trim();
  const pending = activeChat()?.attachments ?? [];
  if (!text && pending.length === 0) return;

  if (!prefs.activeCwd) {
    setStatus("Open a project folder first.");
    return;
  }

  let chat = activeChat();
  if (!chat || chat.cwd !== prefs.activeCwd) {
    chat = makeChat(prefs.activeCwd, { forceNew: true, title: "New chat" });
    focusChat(chat);
  }

  if (text) rememberPrompt(text);
  if (chat.runInFlight) {
    const payload = takeComposerPayload();
    enqueueWaiting(chat, payload.text, payload.attachments);
    return;
  }

  const payload = takeComposerPayload();
  await runPrompt(payload.text, { attachments: payload.attachments });
}

async function retryLastPrompt() {
  const chat = activeChat();
  if (chat) await retryLast(chat);
}

async function beginEditLastUser() {
  const chat = activeChat();
  if (!chat || chat.runInFlight) return;
  const idx = lastUserLineIndex(chat);
  if (idx < 0) return;
  const line = chat.lines[idx];
  if (line.kind !== "user") return;
  refreshUserEditChrome();
  const bubble = lastUserBubbleEl();
  if (!bubble) return;
  editUserBubble(
    bubble,
    line.text,
    !!(line.attachments?.length),
    async (next) => {
      chat.lines = chat.lines.slice(0, idx);
      line.text = next;
      line.at = Date.now();
      chat.lines.push(line);
      persistChatTimes(chat);
      if (activeChatKey === chat.key) rebuildTranscript(chat);
      await runPrompt(next, {
        replaceUser: true,
        attachments: line.attachments ?? [],
      });
    },
    () => refreshUserEditChrome(),
  );
}

async function runPrompt(
  prompt: string,
  opts?: {
    fromQueue?: boolean;
    replaceUser?: boolean;
    attachments?: Attachment[];
    chat?: ChatRuntime;
    displayText?: string;
  },
) {
  const trimmed = prompt.trim();
  const attachments = opts?.attachments ?? [];
  if (!trimmed && attachments.length === 0) return;
  const quoteAtts = attachments.filter((a) => a.kind === "quote");
  const fileAtts = attachments.filter((a) => a.kind !== "quote");
  const quoteBlock = quoteAtts
    .map((a) => (a.quote ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  const sendText = quoteBlock
    ? trimmed
      ? `${quoteBlock}\n\n${trimmed}`
      : quoteBlock
    : trimmed;
  if (trimmed) {
    for (const a of quoteAtts) a.comment = trimmed;
  }

  let chat = opts?.chat ?? activeChat();
  if (!chat || (!opts?.chat && chat.cwd !== prefs.activeCwd)) {
    if (!prefs.activeCwd) {
      setStatus("Open a project folder first.");
      return;
    }
    chat = makeChat(prefs.activeCwd, { forceNew: true, title: "New chat" });
    focusChat(chat);
  }
  if (chat.runInFlight) {
    if (!opts?.fromQueue) enqueueWaiting(chat, trimmed, attachments);
    return;
  }

  chat.runInFlight = true;
  chat.doneUnread = false;
  if (chat.surface === "main") {
    touchLastActive(chat.cwd, chat.sessionId, chat.key);
  }
  syncDockBadge();
  if (activeChatKey !== chat.key) void ensureNoticePermission();
  chat.stopRequested = false;
  chat.lastStopped = false;
  const vis = () => chatVisible(chat);
  const hostOf = () => paintHostFor(chat);
  const compactTurn = isCompactPrompt(trimmed);
  const userText = opts?.displayText ?? trimmed;
  if (!compactTurn) {
    chat.lastUserPrompt = userText;
    chat.lastUserAttachments = attachments;
  }
  if (compactTurn) chat.compacting = true;
  if (chat.surface === "panel") paintPanelTabs();
  if (vis() && chat.surface !== "panel") {
    pinTranscriptToLatest(chat);
    syncEmptyMain(chat);
    syncSidePanelForMain(chat);
  }
  if (chat.surface !== "panel") {
    applySendChrome();
    renderProjects();
    refreshUserEditChrome();
  } else {
    applySideComposerLock(chat);
    renderSideWaiting(chat);
    paintSideEmpty(chat);
  }

  const readyErr = await checkGrokReady();
  if (readyErr) {
    chat.runInFlight = false;
    chat.stopRequested = false;
    chat.compacting = false;
    setStatus(readyErr);
    if (!opts?.replaceUser && !compactTurn) {
      const at = Date.now();
      chat.lines.push({ kind: "user", text: userText, at, attachments });
      if (vis()) appendUserDom(userText, at, attachments, hostOf());
    }
    const errAt = Date.now();
    chat.lines.push({
      kind: "assistant",
      meta: "Error",
      error: true,
      at: errAt,
      parts: [{ kind: "text", text: readyErr }],
    });
    if (vis()) {
      if (opts?.replaceUser) rebuildTranscript(chat, hostOf());
      else {
        appendAssistantDom([{ kind: "text", text: readyErr }], "Error", {
          error: true,
          at: errAt,
          host: hostOf(),
        });
        if (chat.surface === "panel") scrollSideTranscript();
        else pinTranscriptToLatest(chat);
      }
    }
    if (chat.surface !== "panel") applySendChrome();
    else applySideComposerLock(chat);
    paintRunChrome(chat);
    return;
  }
  if (chat.stopRequested) {
    chat.runInFlight = false;
    chat.compacting = false;
    if (!opts?.replaceUser && !compactTurn) {
      const at = Date.now();
      chat.lines.push({ kind: "user", text: userText, at, attachments });
      if (vis()) appendUserDom(userText, at, attachments, hostOf());
    }
    if (chat.surface !== "panel") applySendChrome();
    else applySideComposerLock(chat);
    paintRunChrome(chat);
    return;
  }

  if (!opts?.replaceUser && !compactTurn) {
    const at = Date.now();
    chat.lines.push({ kind: "user", text: userText, at, attachments });
    persistChatTimes(chat);
    if (vis()) {
      appendUserDom(userText, at, attachments, hostOf());
      hostOf()
        ?.querySelector(".msg-row.user:last-child")
        ?.classList.add("msg-enter");
    }
  }

  if (chat.surface !== "panel" && !compactTurn) {
    applyAutoTitle(chat, trimmed, attachments[0]?.name);
  }

  const asstAt = Date.now();
  const started = performance.now();
  const loader = pickLoader();
  const liveVerb = pickLiveVerb();
  const startMeta = formatElapsed(0, true, liveVerb);
  chat.thoughtBuf = "";
  chat.lines.push({
    kind: "assistant",
    meta: startMeta,
    thought: "",
    at: asstAt,
    parts: [],
    work: [],
    loader,
    liveVerb,
  });
  if (vis()) {
    ignoreTranscriptScroll = true;
    bindLiveAssistant(
      chat,
      appendAssistantDom([], startMeta, {
        at: asstAt,
        workOpen: true,
        live: true,
        loader,
        enter: true,
        line: lastAssistantLine(chat) ?? undefined,
        host: hostOf(),
      }),
    );
    foldOlderAssistantWork(chat);
    ignoreTranscriptScroll = false;
    if (chat.surface === "panel") scrollSideTranscript();
    else {
      parkSentTurn(chat);
      paintOutputs(chat);
    }
  } else {
    clearLiveDom(chat);
  }
  chat.status = "Connecting…";
  if (vis()) {
    if (chat.surface === "panel") setSideStatus(chat, chat.status);
    else setStatus(chat.status);
  }

  let sawError = false;
  let sawStopped = false;
  let sawText = false;
  let clockLive = true;
  let finishedPaint = false;
  const useForceNew = chat.forceNew || !chat.sessionId;
  const chatKey = chat.key;

  const paintMeta = (last: AssistantLine, meta: string, live: boolean) => {
    last.meta = meta;
    if (vis() && chat.liveMeta?.isConnected) {
      paintWorkMeta(chat.liveMeta, meta, {
        live: live && workMetaIsLive(meta),
        loader: last.loader,
      });
    }
  };

  const updateElapsed = () => {
    if (!clockLive || sawError || sawStopped || chat.stopRequested || chat.lastStopped) {
      return;
    }
    if (pendingReviewCard(chat)) return;
    const last = lastAssistantLine(chat);
    if (!last) return;
    paintMeta(last, formatElapsed(performance.now() - started, true, last.liveVerb), true);
  };
  const tick = window.setInterval(updateElapsed, 100);

  const setMeta = (last: AssistantLine, meta: string) => {
    const live = workMetaIsLive(meta) && turnIsLive(chat);
    if (!live && !pendingReviewCard(chat)) clockLive = false;
    paintMeta(last, meta, live);
  };

  const finishTurn = (last: AssistantLine | null, fallback = "") => {
    if (finishedPaint || sawError || sawStopped || !last) return;
    finishedPaint = true;
    if (!last.at) last.at = Date.now();
    if (compactTurn && !hasVisibleParts(last.parts) && !(fallback || "").trim()) {
      const idx = chat.lines.lastIndexOf(last);
      if (idx >= 0) chat.lines.splice(idx, 1);
      chat.liveRow?.remove();
      clearLiveDom(chat);
      chat.status = "";
      if (vis()) {
        if (chat.surface === "panel") setSideStatus(chat, "");
        else setStatus("");
      }
      persistChatTimes(chat);
      return;
    }
    if (!hasVisibleParts(last.parts)) {
      const fb = (fallback || "").trim();
      if (fb) last.parts = [{ kind: "text", text: fb }];
    }
    ensureAssistantAnswers(last, fallback);
    setMeta(last, formatElapsed(performance.now() - started));
    if (vis()) {
      chat.liveRow?.classList.remove("is-turn-fill");
      if (chat.liveRow) chat.liveRow.style.minHeight = "";
    }
    finishLiveSubs(chat);
    void hydrateSubsFromDisk(chat);
    rememberThought(chat, last);
    if (vis()) paintParts(chat, last.parts);
    persistChatTimes(chat);
    updateElapsed();
    chat.status = "";
    if (vis()) {
      if (chat.surface === "panel") setSideStatus(chat, "");
      else setStatus("");
    }
  };

  const markStopped = (last: AssistantLine | null) => {
    clockLive = false;
    sawStopped = true;
    chat.lastStopped = true;
    if (last) {
      last.stopped = true;
      last.error = false;
      ensureAssistantAnswers(last);
      setMeta(last, "Stopped");
      rememberThought(chat, last);
    }
    chat.status = "Stopped";
    if (vis()) {
      if (last) paintParts(chat, last.parts);
      if (chat.surface === "panel") {
        setSideStatus(chat, "Stopped");
        applySideComposerLock(chat);
        refreshSideRetryChrome(chat);
      } else {
        setStatus("Stopped");
        applySendChrome();
        refreshUserEditChrome();
        refreshRetryChrome();
      }
    }
  };

  const onEvent = new Channel<StreamEvent>();
  onEvent.onmessage = (event) => {
    const { kind, data } = event;
    if (
      (chat.stopRequested || chat.lastStopped) &&
      kind !== "error" &&
      kind !== "done"
    ) {
      return;
    }
    const last =
      kind === "text" || kind === "tool" || kind === "error"
        ? liveAssistantForStream(chat)
        : lastAssistantLine(chat);
    const focused = vis();

    switch (kind) {
      case "compact":
        chat.compacting = data === "start";
        syncLiveWorkCaption(chat);
        break;
      case "text":
        if (chat.compacting) break;
        if (!last) break;
        appendTextPart(last.parts, data);
        appendTextToWork(last, data);
        sawText = true;
        updateElapsed();
        rememberThought(chat, last);
        if (focused) {
          paintParts(chat, last.parts, { cursor: true });
        }
        if (chat.status !== "Streaming…") {
          chat.status = "Streaming…";
          if (focused) {
            if (chat.surface === "panel") setSideStatus(chat, chat.status);
            else setStatus(chat.status);
          }
        }
        break;
      case "thought":
        chat.thoughtBuf += data;
        if (last) appendThoughtToWork(last, data);
        if (!sawText) updateElapsed();
        if (focused) {
          paintThought(chat, {
            open: isWorkOpen(chat, last),
          });
        }
        if (!sawText) {
          chat.status = "Thinking…";
          if (focused) {
            if (chat.surface === "panel") setSideStatus(chat, chat.status);
            else setStatus(chat.status);
          }
        }
        break;
      case "commands": {
        try {
          const cmds = JSON.parse(data) as SlashCmd[];
          if (Array.isArray(cmds)) {
            chat.slashCommands = cmds.filter((c) => c && c.name);
          }
        } catch {
          /* ignore */
        }
        break;
      }
      case "usage": {
        try {
          const u = JSON.parse(data) as { used?: number; size?: number | null };
          applyUsage(chat, Number(u.used) || 0, u.size ?? undefined);
        } catch {
          /* ignore */
        }
        break;
      }
      case "status":
        if (data === "Stopped" || isStopError(data)) {
          markStopped(last);
          break;
        }
        chat.status = data;
        if (focused) {
          if (chat.surface === "panel") setSideStatus(chat, data);
          else setStatus(data);
          if (!sawText && !sawError && !sawStopped && last && !hasVisibleParts(last.parts)) {
            if (chat.liveThoughtDetails) chat.liveThoughtDetails.hidden = false;
          }
        }
        break;
      case "tool": {
        const chip = parseToolEvent(data);
        if (!last || !chip) break;
        upsertWorkTool(last, chip);
        upsertToolPart(last.parts, chip);
        applyTodosFromChip(chat, chip);
        applySpawnFromChip(chat, chip);
        applyReviewFromChip(chat, chip);
        rememberThought(chat, last);
        chat.status = chipLabel(chip);
        if (focused) {
          if (chat.surface === "panel") setSideStatus(chat, chat.status);
          else setStatus(chat.status);
          paintParts(chat, last.parts, { cursor: sawText });
        }
        break;
      }
      case "sub":
        applySubEvent(chat, data);
        break;
      case "error":
        if (isStopError(data) || chat.stopRequested) {
          markStopped(last);
          break;
        }
        sawError = true;
        if (last) {
          last.parts = [{ kind: "text", text: data }];
          last.error = true;
          setMeta(last, "Error");
          rememberThought(chat, last);
        }
        if (focused) {
          paintParts(chat, last?.parts ?? [{ kind: "text", text: data }], {
            error: true,
          });
        }
        chat.status = "Error";
        if (focused) {
          if (chat.surface === "panel") setSideStatus(chat, "Error");
          else setStatus("Error");
        }
        break;
      case "done":
        if (data === "stopped" || chat.stopRequested) {
          markStopped(last);
          break;
        }
        finishTurn(last);
        break;
    }
  };

  try {
    const result = await invoke<GrokRunResult>("run_grok_stream", {
      chatKey,
      prompt: sendText,
      onEvent,
      model: chat.model,
      effort: chat.effort,
      cwd: chat.cwd,
      mode: chat.mode,
      sessionId: useForceNew ? null : chat.sessionId,
      forceNew: useForceNew,
      attachments: fileAtts.map(dtoForAttach),
    });

    if (result.session_id) {
      const prevWait = waitStoreKey(chat.cwd, null, chat.key);
      chat.sessionId = result.session_id;
      chat.forceNew = false;
      if (prefs.waiting[prevWait]) delete prefs.waiting[prevWait];
      persistWaiting(chat);
      if (chat.surface !== "panel" && prefs.activeCwd === chat.cwd) {
        prefs.sessionByCwd[chat.cwd] = result.session_id;
      }
      if (chat.surface !== "panel") {
        persistSessionTrio(chat);
        persistDeskTitle(chat);
        migrateDraftPin(chat);
        touchLastActive(chat.cwd, chat.sessionId, chat.key);
        if (chat.key === activeChatKey) touchProjectSeed(chat);
        persistChatTimes(chat);
        await refreshSessionsFor(chat.cwd);
        await refreshContextUsage(chat);
        persistPanel(chat);
      }
    }

    const last = lastAssistantLine(chat);
    if (!result.ok && result.error) {
      if (isStopError(result.error) || chat.stopRequested) {
        markStopped(last);
        if (last && !hasVisibleParts(last.parts) && result.text?.trim()) {
          last.parts = [{ kind: "text", text: result.text.trim() }];
          if (vis()) paintParts(chat, last.parts);
        }
      } else {
        const hasText = last ? joinTextParts(last.parts) : "";
        if (!hasText || sawError) {
          if (last) {
            last.parts = [{ kind: "text", text: result.error }];
            last.error = true;
            setMeta(last, "Error");
            rememberThought(chat, last);
          }
          if (vis()) {
            paintParts(chat, last?.parts ?? [{ kind: "text", text: result.error }], {
              error: true,
            });
          }
          chat.status = "Error";
          if (vis()) {
            if (chat.surface === "panel") setSideStatus(chat, "Error");
            else setStatus("Error");
          }
        }
      }
    } else if (
      result.ok &&
      last &&
      !sawStopped &&
      !chat.stopRequested &&
      !chat.lastStopped
    ) {
      finishTurn(last, result.text?.trim() || "");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const last = lastAssistantLine(chat);
    if (isStopError(msg) || chat.stopRequested) {
      markStopped(last);
    } else {
      if (last) {
        last.parts = [{ kind: "text", text: msg }];
        last.error = true;
        setMeta(last, "Error");
        rememberThought(chat, last);
      }
      if (vis()) {
        paintParts(chat, last?.parts ?? [{ kind: "text", text: msg }], {
          error: true,
        });
      }
      chat.status = "Error";
      if (vis()) {
        if (chat.surface === "panel") setSideStatus(chat, "Error");
        else setStatus("Error");
      }
    }
  } finally {
    window.clearInterval(tick);
    chat.runInFlight = false;
    chat.stopRequested = false;
    chat.compacting = false;
    if (vis()) syncLiveWorkCaption(chat, false);
    const willContinue =
      chat.steerNext != null ||
      (!sawStopped && !chat.lastStopped && chat.waiting.length > 0);
    if (chat.surface === "panel") {
      paintPanelTabs();
      applySideComposerLock(chat);
      if (vis()) {
        refreshSideRetryChrome(chat);
        renderSideWaiting(chat);
        setSideStatus(chat, chat.status === "Error" ? "Error" : "");
      }
    } else {
      chat.doneUnread = activeChatKey !== chat.key && !willContinue;
      if (!willContinue) void announceChatFinish(chat);
      else syncDockBadge();
      applySendChrome();
      paintRunChrome(chat);
      refreshUserEditChrome();
      refreshRetryChrome();
      persistChatTimes(chat);
      if (activeChatKey === chat.key) {
        renderWaiting(chat);
        input()?.focus();
      }
    }
    foldFinishedWork(chat);
    clearLiveDom(chat);
    useStatsDirty = true;
    void pumpQueue(chat, { drainWaiting: !sawStopped && !chat.lastStopped });
  }
}

function applyChatMode(chat: ChatRuntime, mode: string) {
  const next = canonicalMode(mode);
  if (!MODES.has(next)) return;
  chat.mode = next;
  persistSessionTrio(chat);
  if (chat.key === activeChatKey) {
    touchProjectSeed(chat);
    paintComposerFrom(chat);
  }
  renderProjects();
}

function onModeEvent(change: ModeChange) {
  const chat = chats.get(change.chatKey);
  if (!chat) return;
  applyChatMode(chat, change.mode);
}

async function onModeChange(mode: string) {
  const chat = activeChat();
  if (!chat) {
    if (MODES.has(canonicalMode(mode))) {
      prefs.mode = canonicalMode(mode);
      savePrefs();
    }
    return;
  }
  const prev = chat.mode;
  applyChatMode(chat, mode);
  try {
    await invoke("set_run_mode", { chatKey: chat.key, mode: chat.mode });
  } catch (e) {
    applyChatMode(chat, prev);
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

window.addEventListener("DOMContentLoaded", () => {
  prefs = loadPrefs();
  paintChromeIcons();
  bindNavSections();
  applyAppearance();
  pruneArchive();
  if (prefs.activeCwd && !prefs.recent.includes(prefs.activeCwd)) {
    rememberFolder(prefs.activeCwd);
    savePrefs();
  }

  void ensureRecentsCwd().then(async () => {
    if (prefs.recent.some((p) => isRecentsCwd(p))) {
      prefs.recent = prefs.recent.filter((p) => !isRecentsCwd(p));
      savePrefs();
    }
    if (prefs.activeCwd) {
      await restoreLastSession();
    } else {
      setChatName("New chat");
    }
    updatePlaceholder();
    renderProjects();
    applySendChrome();
    syncEmptyMain(activeChat());
    paintNewProjectBar();
  });
  newProjectChip()?.addEventListener("click", (e) => {
    e.preventDefault();
    toggleNewProjectMenu();
  });
  newProjectQ()?.addEventListener("input", () => {
    paintNewProjectMenu();
  });
  newProjectNew()?.addEventListener("click", () => {
    closeNewProjectMenu();
    void pickFolderForNewChat();
  });
  newProjectNone()?.addEventListener("click", () => {
    closeNewProjectMenu();
    void unbindEmptyChatProject();
  });
  const projectSearchIco = newProjectMenu()?.querySelector(".new-project-search-ico");
  if (projectSearchIco) projectSearchIco.replaceChildren(iconEl(Ico.search, { size: 16 }));
  newProjectMenu()?.querySelectorAll<HTMLElement>(".new-project-ico[data-ico]").forEach((el) => {
    const kind = el.dataset.ico;
    if (kind === "plus") el.replaceChildren(iconEl(Ico.plus, { size: 16 }));
    if (kind === "close") el.replaceChildren(iconEl(Ico.close, { size: 16 }));
  });
  newProjectPlugins()?.addEventListener("click", () => {
    togglePluginPicker();
  });
  pluginPickerConnect()?.addEventListener("click", () => {
    closePluginPicker();
    setPluginsTab("mcp");
    setMainPage("plugins");
  });
  pluginPicker()?.addEventListener("keydown", (e) => {
    if (onPluginPickerKey(e)) e.stopPropagation();
  });
  document.addEventListener("pointerdown", (e) => {
    const bar = newProjectBar();
    if (!bar || bar.hidden) return;
    if (bar.contains(e.target as Node)) return;
    closeNewChatMenus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!isComposerPickOpen()) return;
    const t = e.target as Node;
    if (composerPickEl()?.contains(t)) return;
    if (modelEffortBtn()?.contains(t) || modeBtn()?.contains(t)) return;
    closeComposerPick();
  });
  window.addEventListener("resize", () => {
    layoutSegThumbs();
    if (isPluginPickerOpen()) placePluginPicker();
    if (isNewProjectMenuOpen()) placeNewProjectMenu();
    if (isComposerPickOpen()) placeComposerPick();
    if (suggestKind) pinSuggestToComposer();
  });
  bindTranscriptScroll();
  jumpLatestBtn()?.addEventListener("click", () => {
    const chat = activeChat();
    if (chat?.liveRow) fillLiveTurn(chat);
    pinTranscriptToLatest(chat, { ease: true });
  });
  tasksPinBtn()?.addEventListener("click", () => {
    prefs.tasksPinned = prefs.tasksPinned === false;
    savePrefs();
    lastOutputsSig = "";
    paintOutputs(activeChat());
  });
  void checkGrokReady().then((err) => {
    if (err) setStatus(err);
  });
  if (!restoreCliUpdated()) void pollCliUpdate();
  if (!restoreAppUpdated()) void pollAppUpdate();
  window.setInterval(() => {
    void pollCliUpdate();
  }, CLI_CHECK_MS);
  window.setInterval(() => {
    void pollAppUpdate();
  }, APP_CHECK_MS);
  const onCliUpdateClick = () => {
    void runCliUpdate();
  };
  const onAppUpdateClick = () => {
    void runAppUpdate();
  };
  cliUpdateBtn()?.addEventListener("click", onCliUpdateClick);
  aboutCliUpdateBtn()?.addEventListener("click", onCliUpdateClick);
  appUpdateBtn()?.addEventListener("click", onAppUpdateClick);
  aboutAppUpdateBtn()?.addEventListener("click", onAppUpdateClick);

  void listen<QuestionRequest>("grok-question", (event) => {
    onQuestionEvent(event.payload);
  });
  void listen<PlanRequest>("grok-plan", (event) => {
    onPlanEvent(event.payload);
  });
  void listen<ModeChange>("grok-mode", (event) => {
    onModeEvent(event.payload);
  });
  void onAction((n) => {
    void openFromFinishNotice(n.extra);
  }).catch(() => {});
  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (focused) {
        scheduleAppPoll();
        return;
      }
      for (const c of chats.values()) {
        if (c.runInFlight) {
          void ensureNoticePermission();
          break;
        }
      }
    })
    .catch(() => {});
  void getCurrentWindow()
    .onCloseRequested(async (event) => {
      event.preventDefault();
      void hideGrotesqueWindow();
    })
    .catch(() => {});
  void getCurrentWindow()
    .onResized(() => schedulePersistWindowBounds())
    .catch(() => {});
  void getCurrentWindow()
    .onMoved(() => schedulePersistWindowBounds())
    .catch(() => {});
  void listen("quit-requested", () => {
    void requestQuit();
  });
  void listen("settings-requested", () => {
    toggleSettings();
  });
  void listen("zoom-in-requested", () => {
    bumpTypeScale(1);
  });
  void listen("zoom-out-requested", () => {
    bumpTypeScale(-1);
  });
  void listen("zoom-reset-requested", () => {
    resetTypeScale();
  });
  void listen<ScreenSnap>("screen-snapshot", (e) => {
    const p = e.payload;
    if (!p || typeof p.path !== "string" || !p.path.trim()) return;
    if (pageOpen()) setMainPage(null);
    void addSnapshot(p);
  });
  void listen<string>("screen-snapshot-error", (e) => {
    const msg = typeof e.payload === "string" ? e.payload : "Cannot capture screen.";
    setStatus(msg);
  });

  const onTranscriptClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    const answerCopy = t.closest<HTMLButtonElement>("button.msg-copy");
    if (answerCopy) {
      e.preventDefault();
      void copyAnswerMarkdown(answerCopy);
      return;
    }
    const copyBtn = t.closest<HTMLButtonElement>("button.code-copy");
    if (copyBtn) {
      e.preventDefault();
      void copyCodeBlock(copyBtn);
      return;
    }
    const toggle = t.closest<HTMLButtonElement>("button.diagram-toggle");
    if (toggle) {
      e.preventDefault();
      const block = toggle.closest(".diagram-block");
      if (!(block instanceof HTMLElement)) return;
      const open = block.classList.toggle("is-source");
      toggle.textContent = open ? "Preview" : "Source";
      if (!open) paintDiagramBlock(block);
      return;
    }
    const diagramPreview = t.closest<HTMLElement>(".diagram-preview");
    if (diagramPreview) {
      const block = diagramPreview.closest(".diagram-block");
      if (block instanceof HTMLElement && block.classList.contains("is-pending")) {
        e.preventDefault();
        paintDiagramBlock(block);
        return;
      }
    }
    const webLink = t.closest<HTMLAnchorElement>("a.mark-link, a[href^='http']");
    if (webLink) {
      e.preventDefault();
      const href = webLink.getAttribute("href") || webLink.href;
      if (/^https?:\/\//i.test(href)) void openHttpUrl(href, e);
      return;
    }
    const pathLink = t.closest<HTMLAnchorElement>("a.path-link");
    if (pathLink) {
      e.preventDefault();
      const path = pathLink.dataset.path || "";
      if (e.metaKey || e.ctrlKey) void revealPath(path);
      else void openPath(path);
      return;
    }
    const pic = t.closest<HTMLImageElement>("figure.md-media img");
    if (!pic || pic.closest(".md-media.is-broken")) return;
    const src = pic.currentSrc || pic.src;
    if (!src) return;
    e.preventDefault();
    openMediaViewer(src, pic.alt || "");
  };
  transcript()?.addEventListener("click", onTranscriptClick);
  sideTranscript()?.addEventListener("click", onTranscriptClick);
  mediaOverlay()?.addEventListener("click", (e) => {
    if (e.target === mediaOverlay()) closeMediaViewer();
  });

  attachBtn()?.addEventListener("click", () => {
    // Finder dialog can stall while a grok turn holds a blocking thread.
    if (activeChat()?.runInFlight) {
      attachFileInput()?.click();
      return;
    }
    void pickAttachFiles();
  });
  attachFileInput()?.addEventListener("change", () => {
    const inputEl = attachFileInput();
    const files = Array.from(inputEl?.files ?? []);
    if (inputEl) inputEl.value = "";
    void (async () => {
      for (const f of files) await addPastedFile(f);
    })();
  });

  window.addEventListener("paste", (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest("#side-input")) return;
    const field = input();
    const inComposer = !!(field && t && (t === field || field.contains(t)));
    if (t?.closest("input, [contenteditable='true']") && !inComposer) return;
    if (mainPage === "settings") return;
    const dt = e.clipboardData;
    if (!dt || !isFileClipboard(dt)) return;
    e.preventDefault();
    void (async () => {
      const uriPaths = pathsFromUriList(dt.getData("text/uri-list") || "");
      if (uriPaths.length) {
        await addPaths(uriPaths);
        return;
      }
      for (const f of clipboardFiles(dt)) await addPastedFile(f);
    })();
  });

  document.addEventListener("pointerdown", onProjectPointerDown);
  document.addEventListener("pointermove", onProjectPointerMove);
  document.addEventListener("pointerup", onProjectPointerUp);
  document.addEventListener("pointercancel", onProjectPointerUp);
  document.addEventListener("keydown", onProjectPointerKey);
  document.addEventListener("pointerdown", onChatPointerDown);
  document.addEventListener("pointermove", onChatPointerMove);
  document.addEventListener("pointerup", onChatPointerUp);
  document.addEventListener("pointercancel", onChatPointerUp);
  document.addEventListener("keydown", onChatPointerKey);
  document.addEventListener("pointerdown", onWaitingPointerDown);
  document.addEventListener("pointermove", onWaitingPointerMove);
  document.addEventListener("pointerup", onWaitingPointerUp);
  document.addEventListener("pointercancel", onWaitingPointerUp);
  document.addEventListener("keydown", onWaitingPointerKey);
  document.addEventListener("pointerdown", onTabPointerDown);
  document.addEventListener("pointermove", onTabPointerMove);
  document.addEventListener("pointerup", onTabPointerUp);
  document.addEventListener("pointercancel", onTabPointerUp);
  document.addEventListener("keydown", onTabPointerKey);

  document.addEventListener("dragstart", () => {
    uiDragActive = true;
    setDropOverlay(false);
  });
  document.addEventListener("dragend", () => {
    uiDragActive = false;
    setDropOverlay(false);
  });

  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (uiDragActive) {
        setDropOverlay(false);
        return;
      }
      if (event.payload.type === "enter") {
        const hasFiles = event.payload.paths.length > 0;
        setDropOverlay(hasFiles);
        return;
      }
      if (event.payload.type === "over") {
        return;
      }
      setDropOverlay(false);
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        const pane = sidePane();
        const pos = event.payload.position;
        if (isSidePanelOpen() && pane && pos) {
          const r = pane.getBoundingClientRect();
          const x = pos.x / (window.devicePixelRatio || 1);
          if (x >= r.left) {
            if (frontPage()) return;
            if (frontAgent()) {
              void addPaths(event.payload.paths, "side");
              return;
            }
          }
        }
        void addPaths(event.payload.paths, "main");
      }
    })
    .catch(() => {
      /* webview drag-drop not available */
    });

  form()?.addEventListener("submit", (e) => {
    e.preventDefault();
    const chat = activeChat();
    if (chat?.runInFlight) {
      void stopTurn(chat);
      return;
    }
    void submitComposer();
  });

  runBtn()?.addEventListener("click", (e) => {
    const chat = activeChat();
    if (chat?.runInFlight) {
      e.preventDefault();
      void stopTurn(chat);
    }
  });

  input()?.addEventListener("mousedown", (e) => {
    const field = input();
    if (!field) return;
    const fromTarget = (e.target as HTMLElement).closest<HTMLElement>(".mark");
    const chip =
      fromTarget && field.contains(fromTarget) && fromTarget.dataset.raw != null
        ? fromTarget
        : null;
    if (chip) {
      e.preventDefault();
      field.focus();
      placeComposerChipCaret(field, chip, e.clientX);
      return;
    }
    if (e.target !== field) return;
    const hit = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!hit || !field.contains(hit.startContainer)) {
      e.preventDefault();
      field.focus();
      setComposerCaret(field, composerText(field).length);
      return;
    }
    const hitEl =
      hit.startContainer instanceof HTMLElement
        ? hit.startContainer
        : hit.startContainer.parentElement;
    const hitChip = hitEl?.closest<HTMLElement>(".mark");
    if (hitChip && field.contains(hitChip) && hitChip.dataset.raw != null) {
      e.preventDefault();
      field.focus();
      placeComposerChipCaret(field, hitChip, e.clientX);
      return;
    }
    if (
      hit.startContainer.nodeType === Node.TEXT_NODE &&
      !(hit.startContainer.textContent ?? "").replace(/\u200b/g, "")
    ) {
      e.preventDefault();
      field.focus();
      setComposerCaret(field, composerOffsetOfNode(field, hit.startContainer));
    }
  });
  input()?.addEventListener("keydown", (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !e.altKey
    ) {
      e.preventDefault();
      const field = input();
      if (!field) return;
      const text = composerText(field);
      const pos = e.shiftKey ? composerSelEnd(field) : composerCaret(field);
      const dest =
        e.key === "ArrowLeft" ? composerLineStart(text, pos) : composerLineEnd(text, pos);
      if (e.shiftKey) setComposerRange(field, composerCaret(field), dest);
      else setComposerCaret(field, dest);
      scrollComposerCaret(field);
      return;
    }
    if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      const field = input();
      if (!field) return;
      if (e.key === "ArrowRight") {
        const hop = chipAfterCaret();
        if (hop) {
          e.preventDefault();
          const end = composerOffsetOfNode(field, hop) + (hop.dataset.raw?.length ?? 0);
          if (e.shiftKey) setComposerRange(field, composerCaret(field), end);
          else setComposerCaret(field, end);
          return;
        }
      } else {
        const hop = chipBeforeCaret();
        if (hop) {
          e.preventDefault();
          const start = composerOffsetOfNode(field, hop);
          if (e.shiftKey) setComposerRange(field, start, composerSelEnd(field));
          else setComposerCaret(field, start);
          return;
        }
      }
    }
    if (e.key === "Backspace" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.isComposing) {
      e.preventDefault();
      deleteComposerToLineStart();
      return;
    }
    if (e.key === "Backspace" && !e.metaKey && !e.altKey && !e.isComposing) {
      // WebKit backspace after a chip and a break inserts a line.
      e.preventDefault();
      if (deleteComposerSelection()) return;
      const field = input();
      if (!field) return;
      const selectedChip = chipInSelection();
      if (selectedChip) {
        removeComposerChip(selectedChip);
        return;
      }
      const chip = chipBeforeCaret();
      if (chip) {
        const start = composerOffsetOfNode(field, chip);
        const end = start + (chip.dataset.raw?.length ?? 0);
        if (composerCaret(field) === end) {
          removeComposerChip(chip);
          return;
        }
      }
      deleteComposerCharBefore();
      return;
    }
    if (e.key === "Delete" && !e.metaKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      if (deleteComposerSelection()) return;
      const field = input();
      if (!field) return;
      const selectedChip = chipInSelection();
      if (selectedChip) {
        removeComposerChip(selectedChip);
        return;
      }
      const chip = chipAfterCaret();
      if (chip) {
        const start = composerOffsetOfNode(field, chip);
        if (composerCaret(field) === start) {
          removeComposerChip(chip);
          return;
        }
      }
      deleteComposerCharAfter();
      return;
    }
    if (suggestKind) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSuggest(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSuggest(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          applySuggest();
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (findOpen) {
          closeFind();
          return;
        }
        hideSuggest();
        return;
      }
    } else if (
      e.key === "ArrowUp" &&
      !composerText().trim() &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      e.preventDefault();
      void openRecentSuggest();
      return;
    }
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const field = input();
      if (!field) return;
      const text = composerText(field);
      const a = composerCaret(field);
      const b = composerSelEnd(field);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const next = text.slice(0, lo) + "\n" + text.slice(hi);
      setComposerText(next, lo + 1);
      const chat = activeChat();
      if (chat) {
        chat.draft = next;
        chat.lockedMarks = [...lockedMarks];
      }
      applySendChrome();
      syncSuggest();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const chat = activeChat();
      if (!chat) return;
      if (!composerHasPayload()) {
        steerFirstWaiting(chat);
        return;
      }
      const payload = takeComposerPayload();
      void steerText(chat, payload.text, payload.attachments);
      return;
    }
    e.preventDefault();
    const chat = activeChat();
    if (chat && !composerHasPayload() && steerFirstWaiting(chat)) return;
    void submitComposer();
  });

  input()?.addEventListener("input", (e) => {
    if (isComposerPickOpen()) closeComposerPick();
    const field = input();
    if (!field) return;
    if ((e as InputEvent).isComposing) {
      autoGrowTextarea();
      return;
    }
    const text = composerText(field);
    const empty = !text.trim();
    field.classList.toggle("is-empty", empty);
    const it = (e as InputEvent).inputType;
    if (empty) {
      lockedMarks.clear();
      paintComposer(field, "");
    } else if (it !== "insertLineBreak" && it !== "insertParagraph") {
      trimComposerZwsp(field);
      const next = composerText(field);
      const hexHits = collectChipHits(next).filter((h) => isHexMark(h.raw)).length;
      if (hexHits !== field.querySelectorAll(".mark-hex").length) {
        setComposerText(next, composerCaret(field));
      }
    }
    autoGrowTextarea();
    const chat = activeChat();
    if (chat) chat.draft = text;
    applySendChrome();
    syncSuggest();
  });
  input()?.addEventListener("paste", (e) => {
    const dt = e.clipboardData;
    if (!dt) return;
    if (isFileClipboard(dt)) {
      e.preventDefault();
      return;
    }
    const clip = clipboardText(dt);
    if (!clip) return;
    e.preventDefault();
    const field = input();
    if (!field) return;
    const before = composerText(field);
    const a = composerCaret(field);
    const b = composerSelEnd(field);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    lockUrlMarks(clip);
    const next = before.slice(0, lo) + clip + before.slice(hi);
    setComposerText(next, lo + clip.length);
    const chat = activeChat();
    if (chat) {
      chat.draft = next;
      chat.lockedMarks = [...lockedMarks];
    }
    applySendChrome();
    syncSuggest();
  });

  transcript()?.addEventListener("dblclick", (e) => {
    const bubble = (e.target as HTMLElement).closest<HTMLElement>(".user-bubble");
    if (!bubble) return;
    const chat = activeChat();
    if (!chat || chat.runInFlight) return;
    const last = lastUserBubbleEl();
    if (!last || bubble !== last) return;
    e.preventDefault();
    e.stopPropagation();
    window.getSelection()?.removeAllRanges();
    void beginEditLastUser();
  });

  waitingCtxMenu()?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
    const at = waitingMenuAt;
    if (!btn || !at) return;
    hideWaitingMenu();
    if (btn.dataset.action === "edit") {
      beginEditWaiting(at.chat, at.id, at.textEl);
      return;
    }
    if (btn.dataset.action === "side" && !at.side) {
      const item = at.chat.waiting.find((w) => w.id === at.id);
      if (item) openWaitingInSide(at.chat, item);
    }
  });

  $("#new-chat-btn")?.addEventListener("click", () => {
    void startNewChat();
  });
  navBackBtn()?.addEventListener("click", () => goNav(-1));
  navForwardBtn()?.addEventListener("click", () => goNav(1));
  pluginsNavBtn()?.addEventListener("click", () => {
    setMainPage("plugins");
  });
  settingsNavBtn()?.addEventListener("click", () => {
    openSettings();
  });
  pluginsTabMcp()?.addEventListener("click", () => setPluginsTab("mcp"));
  pluginsTabMarket()?.addEventListener("click", () => setPluginsTab("market"));
  pluginsTabSkills()?.addEventListener("click", () => setPluginsTab("skills"));
  pluginsAddBtn()?.addEventListener("click", () => openAddPluginCard());
  addPluginCancel()?.addEventListener("click", () => closeAddPluginCard());
  addPluginCard()?.addEventListener("click", (e) => {
    if (e.target === addPluginCard()) closeAddPluginCard();
  });
  addPluginForm()?.addEventListener("submit", (e) => {
    void onAddPluginSubmit(e);
  });
  topbarNewChatBtn()?.addEventListener("click", () => {
    void startNewChat();
  });
  topbarTitleWrap()?.addEventListener("dblclick", (e) => {
    if (pageOpen()) return;
    if ((e.target as HTMLElement).closest("input")) return;
    const chat = activeChat();
    if (!chat) return;
    e.preventDefault();
    e.stopPropagation();
    beginRename(ctxForChat(chat), "topbar");
  });
  openFolderBtn()?.addEventListener("click", () => {
    void pickProjectFolder();
  });

  settingsPage()?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const themeBtn = t.closest<HTMLButtonElement>("[data-theme].appear-opt");
    if (themeBtn?.dataset.theme) {
      setThemePref(parseThemePref(themeBtn.dataset.theme));
      return;
    }
    const accentBtn = t.closest<HTMLButtonElement>("[data-accent].appear-swatch");
    if (accentBtn?.dataset.accent) {
      setAccentId(parseAccentId(accentBtn.dataset.accent));
      return;
    }
    if (t.closest("#type-smaller")) {
      setTypeScale(prefs.typeScale - TYPE_SCALE_STEP);
      return;
    }
    if (t.closest("#type-larger")) {
      setTypeScale(prefs.typeScale + TYPE_SCALE_STEP);
      return;
    }
    if (t.closest("#type-scale-value")) {
      setTypeScale(TYPE_SCALE_DEFAULT);
      return;
    }
    if (t.closest("#archive-empty-btn")) {
      onEmptyArchiveClick();
      return;
    }
    if (t.closest("#about-open-log")) {
      void openAppLog();
      return;
    }
    const viewBtn = t.closest<HTMLButtonElement>("[data-use-view]");
    if (viewBtn?.dataset.useView === "daily"
      || viewBtn?.dataset.useView === "weekly"
      || viewBtn?.dataset.useView === "cumulative") {
      setUseView(viewBtn.dataset.useView);
    }
  });
  archiveEmptyBtn()?.addEventListener("mouseleave", () => {
    if (emptyArchiveArmed) setEmptyArchiveArmed(false);
  });
  window
    .matchMedia("(prefers-color-scheme: light)")
    .addEventListener("change", () => {
      if (prefs.theme === "system") withoutThemeMotion(applyAppearance);
    });

  bindDocOpenMenu();
  chatCtxMenu()?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-action]",
    );
    if (!btn) return;
    if (btn.dataset.action === "rename") runCtxRename();
    if (btn.dataset.action === "pin") runCtxPin();
    if (btn.dataset.action === "archive") runCtxArchive();
    if (btn.dataset.action === "remove") void runCtxRemove();
  });

  mcpCtxMenu()?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-action]",
    );
    const action = btn?.dataset.action;
    const name = mcpCtxName;
    const rowEl = mcpCtxRow;
    hideMcpContextMenu();
    if (action === "rename" && name && rowEl) beginMcpRename(name, rowEl);
    if (action === "remove" && name) void onRemoveMcp(name);
  });

  window.addEventListener("pointerdown", (e) => {
    const menu = chatCtxMenu();
    if (menu && !menu.hidden && !menu.contains(e.target as Node)) {
      hideChatContextMenu();
    }
    const mcpMenu = mcpCtxMenu();
    if (mcpMenu && !mcpMenu.hidden && !mcpMenu.contains(e.target as Node)) {
      hideMcpContextMenu();
    }
    const waitMenu = waitingCtxMenu();
    if (
      waitMenu &&
      !waitMenu.hidden &&
      !waitMenu.contains(e.target as Node) &&
      !(e.target as HTMLElement).closest(".waiting-ico")
    ) {
      hideWaitingMenu();
    }
    const docs = docOpenMenu();
    if (
      docs &&
      !docs.hidden &&
      !docs.contains(e.target as Node) &&
      !(e.target as HTMLElement).closest(".doc-open")
    ) {
      hideDocOpenMenu();
    }
    if (suggestKind) {
      const box = suggestBox();
      const t = e.target as Node;
      if (box && !box.contains(t) && t !== input()) hideSuggest();
    }
  });
  window.addEventListener("blur", () => {
    hideChatContextMenu();
    hideMcpContextMenu();
    hideWaitingMenu();
    hideDocOpenMenu();
  });
  window.addEventListener("resize", () => {
    hideChatContextMenu();
    hideMcpContextMenu();
    hideWaitingMenu();
    hideDocOpenMenu();
    if (activeChat()?.scrollPinned) scrollTranscript();
    else syncJumpLatest();
  });
  window.addEventListener("scroll", () => {
    hideChatContextMenu();
    hideMcpContextMenu();
    hideDocOpenMenu();
  }, true);

  bindSelectionActions();
  window.addEventListener("keydown", (e) => {
    if (chatSearchOpen && onSpotKey(e)) return;
    if (e.metaKey && e.key === ",") {
      e.preventDefault();
      toggleSettings();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      if ((e.key === "w" || e.key === "W") && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void hideGrotesqueWindow();
        return;
      }
      if ((e.key === "s" || e.key === "S") && !e.shiftKey && !e.altKey) {
        // Webview Save page. Find is ⌘S.
        e.preventDefault();
        if (findOpen) closeFind();
        else if (canFind()) openFind();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        setChatSearchOpen(!chatSearchOpen, true);
        return;
      }
      if (e.key === "[" || e.code === "BracketLeft") {
        e.preventDefault();
        goNav(-1);
        return;
      }
      if (e.key === "]" || e.code === "BracketRight") {
        e.preventDefault();
        goNav(1);
        return;
      }
      if (e.key === "." || e.key === "=" || e.key === "+") {
        e.preventDefault();
        bumpTypeScale(1);
        return;
      }
      if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") {
        e.preventDefault();
        bumpTypeScale(-1);
        return;
      }
      if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        resetTypeScale();
        return;
      }
    }
    if (e.key === "Escape" && addPluginCard() && !addPluginCard()?.hidden) {
      e.preventDefault();
      closeAddPluginCard();
      return;
    }
    if (e.key === "Escape" && findOpen) {
      e.preventDefault();
      closeFind();
      return;
    }
    if (onComposerPickKey(e)) return;
    if (e.key === "Escape") {
      const docs = docOpenMenu();
      if (docs && !docs.hidden) {
        e.preventDefault();
        hideDocOpenMenu();
        return;
      }
      if (plusMenuIsOpen()) {
        e.preventDefault();
        hidePlusMenu();
        return;
      }
      if (isPluginPickerOpen()) {
        e.preventDefault();
        closePluginPicker();
        input()?.focus();
        return;
      }
      if (isNewProjectMenuOpen()) {
        e.preventDefault();
        closeNewProjectMenu();
        input()?.focus();
        return;
      }
      if (suggestKind) {
        e.preventDefault();
        hideSuggest();
        return;
      }
      if (selActionsOpen()) {
        e.preventDefault();
        hideSelActions();
        return;
      }
      if (isMediaViewerOpen()) {
        e.preventDefault();
        closeMediaViewer();
        return;
      }
      if (chatCtxMenu()?.hidden === false) {
        e.preventDefault();
        hideChatContextMenu();
        return;
      }
      if (mcpCtxMenu()?.hidden === false) {
        e.preventDefault();
        hideMcpContextMenu();
        return;
      }
      if (renameTarget) {
        e.preventDefault();
        cancelRename();
        return;
      }
      if (pageOpen()) {
        e.preventDefault();
        setMainPage(null);
        return;
      }
      if (chatSearchOpen && onSpotKey(e)) return;
      const panelChat = isSidePanelOpen() ? frontAgent() : null;
      if (panelChat?.runInFlight) {
        e.preventDefault();
        hideSuggest();
        hideSelActions();
        void stopSideTurn(panelChat);
        return;
      }
      const chat = activeChat();
      if (chat?.runInFlight) {
        e.preventDefault();
        hideSuggest();
        hideSelActions();
        void stopTurn(chat);
      }
    }
  });

  modelEffortBtn()?.addEventListener("click", () => {
    toggleComposerPick("model");
  });
  modeBtn()?.addEventListener("click", () => {
    toggleComposerPick("mode");
  });

  paintComposerFrom(activeChat());

  void loadModels();
  autoGrowTextarea();
  renderWaiting(activeChat());
  renderAttachChips(activeChat());
  applySendChrome();
  applySideWidth(prefs.sideWidth || DEFAULT_SIDE_W);
  applySidebarWidth(prefs.sidebarWidth || DEFAULT_SIDEBAR_W);
  setSideChromeOpen(false);
  setSidebarOpen(prefs.sidebarOpen !== false);
  bindSideResize();
  bindSidebarResize();
  bindWinbarDrag();

  toggleSidebarBtn()?.addEventListener("click", () => {
    setSidebarOpen(!prefs.sidebarOpen);
  });
  chatSearchBtn()?.addEventListener("click", () => {
    setChatSearchOpen(!chatSearchOpen);
  });
  chatSearchInput()?.addEventListener("input", () => {
    chatSearch = chatSearchInput()?.value ?? "";
    spotIndex = 0;
    paintSpot();
    void refreshDiskSnippets(chatSearch);
  });
  chatSearchInput()?.addEventListener("keydown", (e) => {
    if (onSpotKey(e)) e.stopPropagation();
  });
  chatSearchOverlay()?.addEventListener("mousedown", (e) => {
    if (e.target === chatSearchOverlay()) setChatSearchOpen(false);
  });
  findInput()?.addEventListener("input", () => {
    if (findOpen) scheduleFindHits();
  });
  findInput()?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      stepFind(e.shiftKey ? -1 : 1);
      return;
    }
    if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown"
    ) {
      // WKWebView can insert a glyph into this field on arrow keys.
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLInputElement;
      const val = el.value;
      const a = el.selectionStart ?? 0;
      const b = el.selectionEnd ?? 0;
      const toStart =
        e.key === "ArrowUp" || (e.key === "ArrowLeft" && (e.metaKey || e.ctrlKey));
      const toEnd =
        e.key === "ArrowDown" || (e.key === "ArrowRight" && (e.metaKey || e.ctrlKey));
      let dest: number;
      if (toStart) dest = 0;
      else if (toEnd) dest = val.length;
      else if (e.key === "ArrowLeft") dest = !e.shiftKey && a !== b ? a : Math.max(0, a - 1);
      else dest = !e.shiftKey && a !== b ? b : Math.min(val.length, b + 1);
      if (e.shiftKey) {
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") el.setSelectionRange(dest, b);
        else el.setSelectionRange(a, dest);
      } else el.setSelectionRange(dest, dest);
    }
  });
  findPrevBtn()?.addEventListener("click", () => stepFind(-1));
  findNextBtn()?.addEventListener("click", () => stepFind(1));
  findCloseBtn()?.addEventListener("click", () => closeFind());
  openSideBtn()?.addEventListener("click", () => {
    openSidePanel();
  });
  closeSideBtn()?.addEventListener("click", () => {
    hideSidePanel();
  });
  panelAddBtn()?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlusMenu();
  });
  planCopyBtn()?.addEventListener("click", (e) => {
    e.preventDefault();
    const btn = planCopyBtn();
    if (btn) void copyAnswerMarkdown(btn);
  });
  planView()?.addEventListener("input", () => {
    const main = activeChat();
    if (!main) return;
    if (!panelOf(main.key).plan?.editable) return;
    flushPlanEdit(main);
    persistPanel(main);
  });
  planView()?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const copyBtn = t.closest<HTMLButtonElement>("button.code-copy");
    if (copyBtn) {
      e.preventDefault();
      void copyCodeBlock(copyBtn);
      return;
    }
    const view = planView();
    if (view?.isContentEditable && t.closest("a")) e.preventDefault();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!plusMenuIsOpen()) return;
    const t = e.target as Node;
    if (panelPlusMenu()?.contains(t) || panelAddBtn()?.contains(t)) return;
    hidePlusMenu();
  });

  sideAttachBtn()?.addEventListener("click", () => {
    const side = frontAgent();
    if (!side) return;
    if (side.runInFlight) {
      sideAttachFileInput()?.click();
      return;
    }
    void pickSideAttachFiles(side);
  });
  sideAttachFileInput()?.addEventListener("change", () => {
    const inputEl = sideAttachFileInput();
    const files = Array.from(inputEl?.files ?? []);
    if (inputEl) inputEl.value = "";
    const side = frontAgent();
    if (!side) return;
    void (async () => {
      for (const f of files) await addPastedFileToChat(side, f);
    })();
  });
  browserBackBtn()?.addEventListener("click", () => {
    void stepPage(-1);
  });
  browserForwardBtn()?.addEventListener("click", () => {
    void stepPage(1);
  });
  browserReloadBtn()?.addEventListener("click", () => {
    void reloadOrStopPage();
  });
  browserUrl()?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const page = frontPage();
    if (!page) return;
    void navigatePage(page, browserUrl()?.value ?? "");
  });
  window.addEventListener("resize", () => {
    if (plusOverlayOpen) void openPlusOverlay();
    else if (plusMenuIsOpen()) placePlusMenu();
    syncBrowserBounds();
  });
  void listen<BrowserNavDto>("browser-nav", (e) => {
    onBrowserNav(e.payload ?? {});
  });
  void listen<string>("plus-pick", (e) => {
    const route = e.payload ?? "";
    plusOverlayOpen = false;
    panelAddBtn()?.setAttribute("aria-expanded", "false");
    if (route === "pick/page") addPageTab();
    else if (route === "pick/side") addSideTab();
  });
  sideForm()?.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitSideComposer();
  });
  sideSendBtn()?.addEventListener("click", (e) => {
    const side = frontAgent();
    if (side?.runInFlight) {
      e.preventDefault();
      void stopSideTurn(side);
    }
  });
  sideInput()?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (findOpen) {
        e.preventDefault();
        closeFind();
        return;
      }
      const live = frontAgent();
      if (live?.runInFlight) {
        e.preventDefault();
        void stopSideTurn(live);
        return;
      }
    }
    if (e.key !== "Enter" || e.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    void submitSideComposer();
  });
  sideInput()?.addEventListener("paste", (e) => {
    const side = frontAgent();
    if (!side) return;
    const dt = e.clipboardData;
    if (!dt || !isFileClipboard(dt)) return;
    e.preventDefault();
    void (async () => {
      const uriPaths = pathsFromUriList(dt.getData("text/uri-list") || "");
      if (uriPaths.length) {
        await addPathsToChat(side, uriPaths);
        return;
      }
      for (const f of clipboardFiles(dt)) await addPastedFileToChat(side, f);
    })();
  });
  sideInput()?.addEventListener("input", () => {
    const side = frontAgent();
    if (side) {
      side.draft = sideInput()?.value ?? "";
      applySideComposerLock(side);
    }
    const el = sideInput();
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  });
  sideTranscript()?.addEventListener("dblclick", (e) => {
    const side = frontAgent();
    if (!side || side.runInFlight) return;
    const bubble = (e.target as HTMLElement).closest(".user-bubble");
    const rows = sideTranscript()?.querySelectorAll(".msg-row.user");
    const last = rows?.[rows.length - 1]?.querySelector(".user-bubble");
    if (!bubble || bubble !== last) return;
    void beginEditSideLast(side, bubble as HTMLElement);
  });
});

type BrowserNavDto = { url?: string; title?: string; loading?: boolean };
