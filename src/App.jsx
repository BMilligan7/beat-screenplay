import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { ProjectLibrary } from "./ProjectLibrary.jsx";
import { createProject, projectRequest } from "./projects-api.js";
import { ScreenplayEditor } from "./ScreenplayEditor.jsx";
import { paginateEditorBlocks } from "./editor-pagination.js";
import { WebrtcProvider } from "y-webrtc";
import { createDeviceCache, getDeviceItem, setDeviceItem } from "./device-storage.js";
import { parseRoomLink, hasRoomLinkParameters, buildRoomLink } from "./room-link.js";
import { applyReviewFixes, blocksToFountain, classifyLines, createReviewFixes, reclassifyBlocks } from "./screenplay.js";
import { buildScreenplayPdf, paginateScreenplayForPdf, screenplayPdfFilename } from "./pdf.js";
import { createRoomSync } from "./room-sync.js";
import { createWorkspaceApi } from "./workspace-api.js";
import { readRoomDocument } from "../shared/room-document.js";
import { SessionStartDialog, SessionReviewDialog, SharedHistoryDialog } from "./WorkspacePanels.jsx";
import {
  ArrowClockwise, ArrowCounterClockwise, ArrowRight, ArrowSquareOut, BracketsRound, CaretDown, ChatCircle,
  Check, CheckCircle, Circle, Copy, DownloadSimple, FileArrowUp,
  ClockCounterClockwise, FileText, List, MagicWand, Minus, PaperPlaneTilt, Plus, Quotes,
  SidebarSimple, SkipForward, TextAlignCenter, TextAlignLeft,
  TextAlignRight, UploadSimple, User, Users, X,
} from "@phosphor-icons/react";

const ELEMENTS = [
  { type: "scene", label: "Scene", help: "INT. / EXT. location and time", icon: FileText },
  { type: "action", label: "Action", help: "Describe what's happening", icon: TextAlignLeft },
  { type: "character", label: "Character", help: "Character who speaks", icon: User },
  { type: "dialogue", label: "Dialogue", help: "What the character says", icon: Quotes },
  { type: "parenthetical", label: "Parenthetical", help: "How the line is delivered", icon: BracketsRound },
  { type: "transition", label: "Transition", help: "Move to the next scene", icon: Minus },
  { type: "title", label: "Title", help: "Title page heading", icon: FileText },
  { type: "centered", label: "Centered", help: "Credits, cast, place, or time", icon: TextAlignCenter },
  { type: "section", label: "Section", help: "Title-page or outline heading", icon: List },
];

// Fictional sample used only when the writer opens the import dialog.
const IMPORT_EXAMPLE = `int. test lab - day

A robot checks a blinking console.

ROBOT
The test is ready.

cut to:`;

function encodeSeed(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSeed(value) {
  if (!value) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function readRoomHash() {
  return parseRoomLink(window.location.href);
}

function reviewStorageKey(roomConfig) {
  return roomConfig ? `beat-screenplay-review-v3-${roomConfig.roomId}` : "beat-screenplay-review-v3";
}

function readDismissedFixes(roomConfig) {
  try {
    const stored = JSON.parse(getDeviceItem(reviewStorageKey(roomConfig)) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

function versionStorageKey(roomConfig) {
  return roomConfig ? `beat-screenplay-versions-v1-${roomConfig.roomId}` : "beat-screenplay-versions-v1";
}

function readVersionHistory(roomConfig) {
  try {
    const stored = JSON.parse(getDeviceItem(versionStorageKey(roomConfig)) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch { return []; }
}

function cloneBlocks(blocks) {
  return blocks.map((block) => ({ ...block }));
}

function formatVersionTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

function randomToken(bytes = 16) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function draftStorageKey(roomConfig) {
  return roomConfig ? `beat-drafts-v3-${roomConfig.roomId}` : "beat-drafts-v3-local";
}

function readDraftCache(roomConfig) {
  try {
    const cached = JSON.parse(getDeviceItem(draftStorageKey(roomConfig)) || "null");
    if (cached) return cached;
    // Import the former device-only drafts only when this device has this room's script.
    if (!roomConfig || getDeviceItem(`beat-screenplay-room-${roomConfig.roomId}`)) {
      return { name: getDeviceItem("beat-draft-name") || "Draft 1", drafts: JSON.parse(getDeviceItem("beat-draft-snapshots") || "[]"), legacy: true };
    }
  } catch { /* A damaged cache must not prevent loading the shared document. */ }
  return { name: "Draft 1", drafts: [] };
}

function saveStatusText(status) {
  return { loading: "Connecting…", saving: "Saving…", saved: "Saved", offline: "Offline · reconnecting", error: "Save needs attention", local: "Saved on this device" }[status] || "Connecting…";
}

function updateSharedText(sharedText, nextValue) {
  const currentValue = sharedText.toString();
  if (currentValue === nextValue) return;
  let prefix = 0;
  while (prefix < currentValue.length && prefix < nextValue.length && currentValue[prefix] === nextValue[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < currentValue.length - prefix && suffix < nextValue.length - prefix && currentValue[currentValue.length - 1 - suffix] === nextValue[nextValue.length - 1 - suffix]) suffix += 1;
  const deleteCount = currentValue.length - prefix - suffix;
  if (deleteCount) sharedText.delete(prefix, deleteCount);
  const insertion = nextValue.slice(prefix, nextValue.length - suffix);
  if (insertion) sharedText.insert(prefix, insertion);
}

function IconButton({ label, children, className = "", ...props }) {
  return <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

function Modal({ title, subtitle, onClose, children, className = "" }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <header className="modal-header">
          <div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
          <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

export function App() {
  const [blocks, setBlocks] = useState(() => {
    try {
      const room = readRoomHash();
      const saved = getDeviceItem(room ? `beat-screenplay-room-${room.roomId}` : "beat-screenplay-blocks");
      return saved ? JSON.parse(saved) : decodeSeed(room?.seed) || [];
    } catch { return []; }
  });
  const [roomConfig, setRoomConfig] = useState(readRoomHash);
  const [localDraftOpen, setLocalDraftOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectMetadata, setProjectMetadata] = useState(null);
  const [projectNameInput, setProjectNameInput] = useState("");
  const [projectEditRevision, setProjectEditRevision] = useState(null);
  const [projectSaving, setProjectSaving] = useState(false);
  const [openLinkError, setOpenLinkError] = useState(() => hasRoomLinkParameters(window.location.href) && !parseRoomLink(window.location.href) ? "This link is incomplete. Paste the full collaboration link, including everything after #." : "");
  const [roomHydrated, setRoomHydrated] = useState(() => !readRoomHash());
  const [onlineCount, setOnlineCount] = useState(1);
  const [workspaceData, setWorkspaceData] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [writerName, setWriterName] = useState(() => getDeviceItem("beat-writer-name") || "");
  const [sessionStart, setSessionStart] = useState(null);
  const [sessionReview, setSessionReview] = useState(null);
  const [sharedHistory, setSharedHistory] = useState(null);
  const [historyDetail, setHistoryDetail] = useState(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  const workspaceApi = useMemo(() => roomConfig ? createWorkspaceApi({roomConfig}) : null, [roomConfig?.roomId, roomConfig?.key]);

  const workspaceRefresh = useRef(null);
  const latestMainRevision = useRef(0);
  const latestProjectRevision = useRef(0);
  const roomIdentity = `${roomConfig?.roomId || ""}:${roomConfig?.key || ""}`;
  const currentRoomIdentity = useRef(roomIdentity); currentRoomIdentity.current = roomIdentity;
  const [unpublishedRecovery, setUnpublishedRecovery] = useState(null);
  const selectedSessionRef = useRef(null);
  const readOnly = !!roomConfig && (!roomHydrated || !activeSession || !activeSession.token || activeSession.status !== "active");
  const [saveError, setSaveError] = useState("");
  const [saveStatus, setSaveStatus] = useState(roomConfig ? "loading" : "local");
  const [selectedId, setSelectedId] = useState("b6");
  const [activeLeftTab, setActiveLeftTab] = useState("scenes");
  const [activeRightTab, setActiveRightTab] = useState("format");
  const [dismissedFixes, setDismissedFixes] = useState(() => readDismissedFixes(roomConfig));
  const detectedFixes = useMemo(() => createReviewFixes(blocks), [blocks]);
  const fixes = useMemo(() => detectedFixes.filter((fix) => !dismissedFixes.includes(fix.fingerprint)), [detectedFixes, dismissedFixes]);
  const fixTotal = detectedFixes.length;
  const [noticeVisible, setNoticeVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [draftPanelOpen, setDraftPanelOpen] = useState(false);
  const [projectName, setProjectName] = useState(() => getDeviceItem(`beat-project-name-${readRoomHash()?.roomId || "local"}`) || "Screenplay");
  const [draftName, setDraftName] = useState(() => readDraftCache(roomConfig).name);
  const [draftNameInput, setDraftNameInput] = useState(draftName);
  const [draftSnapshots, setDraftSnapshots] = useState(() => readDraftCache(roomConfig).drafts);
  const [importOpen, setImportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versionHistory, setVersionHistory] = useState(() => readVersionHistory(roomConfig));
  const [historyStatus, setHistoryStatus] = useState({ undo: 0, redo: 0 });
  const [importText, setImportText] = useState(IMPORT_EXAMPLE);
  const [toast, setToast] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [access, setAccess] = useState("Can write in sessions");
  const [zoom, setZoom] = useState(100);
  const [dualDialogue, setDualDialogue] = useState(false);
  const [alignment, setAlignment] = useState("left");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const fileInput = useRef(null);
  const shareLinkInput = useRef(null);
  const editorRef = useRef(null);
  const [editorLayout, setEditorLayout] = useState(null);
  const saveTimer = useRef(null);
  const collabRef = useRef(null);
  const fixesPanelRef = useRef(null);
  const blocksRef = useRef(blocks);
  const draftNameRef = useRef(draftName);
  const editHistory = useRef({ undo: [], redo: [], lastKey: "", lastAt: 0 });
  const previousFixFingerprints = useRef(new Set(fixes.map((fix) => fix.fingerprint)));
  const selected = blocks.find((block) => block.id === selectedId) || blocks[0];
  const wordCount = useMemo(() => blocks.reduce((sum, block) => sum + block.text.trim().split(/\s+/).filter(Boolean).length, 0), [blocks]);
  const screenplayScenes = useMemo(() => blocks.filter((block) => block.type === "scene"), [blocks]);
  const paginatedBlocks = useMemo(() => paginateEditorBlocks(blocks, editorLayout), [blocks, editorLayout]);
  const hasTitlePage = paginatedBlocks[0]?.[0]?.block.type === "title";

  useEffect(() => {
    const changeRoom = () => {
      const next = readRoomHash();
      if (next?.roomId === roomConfig?.roomId && next?.key === roomConfig?.key) {
        if (next && !parseRoomLink(window.location.href)) window.history.replaceState(null, "", buildRoomLink(window.location.href, next));
        return;
      }
      currentRoomIdentity.current = `${next?.roomId || ""}:${next?.key || ""}`;
      editHistory.current = { undo: [], redo: [], lastKey: "", lastAt: 0 };
      setHistoryStatus({ undo: 0, redo: 0 });
      setSelectedId("");
      setEditorLayout(null);
      setOnlineCount(1);
      setDismissedFixes(readDismissedFixes(next));
      let nextBlocks = [];
      try {
        const saved = getDeviceItem(next ? `beat-screenplay-room-${next.roomId}` : "beat-screenplay-blocks");
        nextBlocks = saved ? JSON.parse(saved) : decodeSeed(next?.seed) || [];
      } catch { /* Load the shared document after reconnecting. */ }
      const cache = readDraftCache(next);
      blocksRef.current = nextBlocks;
      draftNameRef.current = cache.name;
      setBlocks(nextBlocks);
      setDraftName(cache.name);
      setDraftSnapshots(cache.drafts);
      setRoomHydrated(!next);
      setSaveStatus(next ? "loading" : "local");
      setActiveSession(null); selectedSessionRef.current = null; latestMainRevision.current = 0; pendingRecovery.current = null;
      setWorkspaceData(null); setUnpublishedRecovery(null); setWorkspaceBusy(false); setSharedHistory(null); setSessionReview(null); setSessionStart(null);
      setProjectName(getDeviceItem(`beat-project-name-${next?.roomId || "local"}`) || "Screenplay");
      latestProjectRevision.current = 0; setProjectSaving(false);
      setProjectMetadata(null); setProjectPanelOpen(false); setDraftPanelOpen(false); setMenuOpen(false);
      setShareOpen(false); setImportOpen(false); setHistoryOpen(false); setDownloadOpen(false);
      setRoomConfig(next);
      setLocalDraftOpen(false);
      setOpenLinkError(hasRoomLinkParameters(window.location.href) && !parseRoomLink(window.location.href) ? "This link is incomplete. Paste the full collaboration link." : "");
    };
    window.addEventListener("hashchange", changeRoom);
    return () => window.removeEventListener("hashchange", changeRoom);
  }, [roomConfig?.roomId, roomConfig?.key]);

  useEffect(() => {
    blocksRef.current = blocks;
    window.clearTimeout(saveTimer.current);
    if (roomConfig && !roomHydrated) return;
    const storageKey = roomConfig ? (activeSession ? `beat-session-blocks-${roomConfig.roomId}-${activeSession.id}` : `beat-screenplay-room-${roomConfig.roomId}`) : "beat-screenplay-blocks";
    saveTimer.current = window.setTimeout(() => {
      if (!setDeviceItem(storageKey, JSON.stringify(blocks)) && !roomConfig && blocks.length) {
        setSaveStatus("error");
        setSaveError("Device storage is unavailable. Use Share to save online or download a backup.");
        setToast("Device storage is unavailable. Use Share to save online or download a backup.");
      }
    }, 300);
    return () => window.clearTimeout(saveTimer.current);
  }, [blocks, roomConfig, activeSession?.id, roomHydrated]);

  useEffect(() => {
    setVersionHistory(readVersionHistory(roomConfig));
  }, [roomConfig?.roomId]);

  useEffect(() => {
    if (roomConfig && !roomHydrated) return;
    const timer = window.setTimeout(() => recordVersion("Automatic recovery point"), 2500);
    return () => window.clearTimeout(timer);
  }, [blocks, draftName, roomConfig?.roomId, roomHydrated]);

  useEffect(() => {
    setDeviceItem(reviewStorageKey(roomConfig), JSON.stringify(dismissedFixes));
  }, [dismissedFixes, roomConfig?.roomId]);

  useEffect(() => {
    const current = new Set(fixes.map((fix) => fix.fingerprint));
    if (fixes.some((fix) => !previousFixFingerprints.current.has(fix.fingerprint))) setNoticeVisible(true);
    previousFixFingerprints.current = current;
  }, [fixes]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (projectName !== "Screenplay") setDeviceItem(`beat-project-name-${roomConfig?.roomId || "local"}`, projectName);
    document.title = roomConfig || localDraftOpen ? `Beat — ${projectName}` : "Beat — Projects";
  }, [projectName, roomConfig?.roomId, localDraftOpen]);

  useEffect(() => {
    draftNameRef.current = draftName;
    setDraftNameInput(draftName);
    if (roomConfig && !roomHydrated) return;
    if (activeSession) return;
    try { setDeviceItem(draftStorageKey(roomConfig), JSON.stringify({ name: draftName, drafts: draftSnapshots })); }
    catch { /* The shared document and IndexedDB retain the drafts if this cache is full. */ }
  }, [draftName, draftSnapshots, roomConfig?.roomId, roomHydrated]);

  useEffect(() => {
    if (roomConfig || getDeviceItem("beat-screenplay-parser-version") === "2") return;
    const looksLikeBrokenTitlePage = blocks.length > 10 && blocks[0]?.type === "character" && blocks.some((block) => /^CAST(?: OF CHARACTERS)?$/i.test(block.text));
    if (looksLikeBrokenTitlePage) {
      const repaired = reclassifyBlocks(blocks);
      commitBlocks(repaired);
      setSelectedId(repaired[0]?.id || "");
      setDismissedFixes([]);
      setToast("Title page and screenplay formatting repaired");
    }
    setDeviceItem("beat-screenplay-parser-version", "2");
  }, []);

  // Current is loaded from the server only. Old device caches remain recovery copies.
  useEffect(() => {
    if (!roomConfig) return undefined;
    let cancelled = false;
    let inFlight = false;
    let provider;
    let presenceDoc;
    const initialSnapshot = { draftName: draftNameRef.current, blocks: cloneBlocks(blocksRef.current), drafts: draftSnapshots };
    if (initialSnapshot.blocks.length) recordVersion("Before writing-session upgrade", initialSnapshot.blocks);
    setRoomHydrated(false);
    setSaveStatus("loading");
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        let data;
        try { data = await roomRequest("/workspace"); }
        catch (error) {
          if (error.status !== 404 || roomConfig.joined || !initialSnapshot.blocks.length) throw error;
          await roomRequest("", { method: "PUT", body: initialSnapshot });
          data = await roomRequest("/workspace");
        }
        if (cancelled || currentRoomIdentity.current !== roomIdentity) return;
        if (data.main.revision < latestMainRevision.current) return;
        latestMainRevision.current = data.main.revision;
        setWorkspaceData(data);
        if ((data.project?.revision || 0) >= latestProjectRevision.current) {
          latestProjectRevision.current = data.project?.revision || 0;
          setProjectMetadata(data.project || null);
          setProjectName(data.project?.name || data.main.blocks.find(block => block.type === "title" && block.text.trim())?.text.trim().slice(0, 120) || "Untitled screenplay");
        }
        setDeviceItem("beat-last-room-v1", JSON.stringify({ roomId: roomConfig.roomId, key: roomConfig.key }));
        if (!parseRoomLink(window.location.href)) window.history.replaceState(null, "", buildRoomLink(window.location.href, roomConfig));
        if (!selectedSessionRef.current) {
          showSnapshot(data.main);
          setRoomHydrated(true); setSaveStatus("saved"); setSaveError("");
        }
      } catch (error) {
        if (!cancelled && currentRoomIdentity.current === roomIdentity && !selectedSessionRef.current) { setSaveStatus("error"); setSaveError(error.message); }
      } finally { inFlight = false; }
    };
    workspaceRefresh.current = refresh;
    void refresh();
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    try {
      presenceDoc = new Y.Doc();
      provider = new WebrtcProvider(`beat-presence-v3-${roomConfig.roomId}`, presenceDoc, { password: roomConfig.key });
      provider.awareness.setLocalStateField("user", { name: writerName.trim() || "Reader" });
      provider.awareness.on("change", () => { if (!cancelled) setOnlineCount(Math.max(1, provider.awareness.getStates().size)); });
    } catch { /* Presence is optional. */ }
    return () => {
      cancelled = true; window.clearInterval(timer);
      window.removeEventListener("online", refresh); window.removeEventListener("focus", refresh);
      if (workspaceRefresh.current === refresh) workspaceRefresh.current = null;
      provider?.destroy(); presenceDoc?.destroy();
    };
  }, [roomConfig?.roomId, roomConfig?.key]);

  useEffect(() => {
    if (!roomConfig || !activeSession) return undefined;
    let cancelled = false;
    let sync;
    const ydoc = new Y.Doc();
    const root = ydoc.getMap("screenplay");
    const metadata = ydoc.getMap("metadata");
    const drafts = ydoc.getMap("drafts");
    const writable = activeSession.token && activeSession.status === "active";
    const persistence = writable ? createDeviceCache(`beat-session-v1-${roomConfig.roomId}-${activeSession.id}`, ydoc) : null;
    setRoomHydrated(false); setSaveStatus("loading");
    const syncFromRoom = () => { if (!cancelled && currentRoomIdentity.current === roomIdentity && root.size) showSnapshot(readRoomDocument(ydoc)); };
    ydoc.on("afterTransaction", syncFromRoom);
    const flush = () => { void sync?.flush(); };
    const beforeClose = (event) => {
      if (sync?.hasPendingChanges()) { flush(); event.preventDefault(); event.returnValue = ""; }
    };
    const initialize = async () => {
      await persistence?.ready;
      if (cancelled || currentRoomIdentity.current !== roomIdentity) return;
      collabRef.current = { ydoc, root, metadata, drafts, status: "loading" };
      sync = createRoomSync({
        doc: ydoc, roomConfig, endpoint: `/api/rooms/${roomConfig.roomId}/sessions/${activeSession.id}/sync`,
        sessionToken: activeSession.token, readOnly: !writable,
        onStatus: (status, info) => {
          if (cancelled || currentRoomIdentity.current !== roomIdentity) return;
          setSaveStatus(status); setSaveError(info?.error || "");
          if (collabRef.current?.ydoc === ydoc) collabRef.current.status = status;
          if (info?.session?.status === "applied") {
            if (info.hasUnpublishedChanges) {
              const recovery = readRoomDocument(ydoc);
              recordVersion("Unpublished changes after session was made current", recovery.blocks);
              setUnpublishedRecovery({ blocks: cloneBlocks(recovery.blocks), name: recovery.draftName });
            }
            setActiveSession((current) => current?.id === activeSession.id ? { ...current, status: "applied" } : current);
          }
        },
        onReady: () => { if (!cancelled && currentRoomIdentity.current === roomIdentity) { syncFromRoom(); setRoomHydrated(true); } },
      });
      collabRef.current.sync = sync;
      window.addEventListener("online", flush); window.addEventListener("focus", flush);
      window.addEventListener("pagehide", flush); window.addEventListener("beforeunload", beforeClose);
      await sync.start();
    };
    void initialize().catch((error) => { if (!cancelled && currentRoomIdentity.current === roomIdentity) { setSaveStatus("error"); setSaveError(error.message); } });
    return () => {
      cancelled = true; sync?.stop();
      window.removeEventListener("online", flush); window.removeEventListener("focus", flush);
      window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", beforeClose);
      ydoc.off("afterTransaction", syncFromRoom);
      if (collabRef.current?.ydoc === ydoc) collabRef.current = null;
      void persistence?.destroy(); ydoc.destroy();
    };
  }, [roomConfig?.roomId, roomConfig?.key, activeSession?.id, activeSession?.status]);

  useEffect(() => {
    if (roomConfig || localDraftOpen) return undefined;
    let cancelled = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try { const data = await projectRequest(); if (!cancelled) { setProjects(data.projects); setProjectsError(""); } }
      catch (error) { if (!cancelled) setProjectsError(error.message); }
      finally { fetching = false; if (!cancelled) setProjectsLoading(false); }
    };
    setProjectsLoading(true); void refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [roomConfig?.roomId, localDraftOpen]);
  async function refreshProjects() {
    setProjectsLoading(true);
    try { const data = await projectRequest(); setProjects(data.projects); setProjectsError(""); }
    catch (error) { setProjectsError(error.message); }
    finally { setProjectsLoading(false); }
  }
  async function openProject(project) {
    try {
      await finishPendingSave();
      window.location.hash = new URL(buildRoomLink(window.location.href, project)).hash;
      setOpenLinkError("");
    } catch (error) { setProjectsError(error.message); setToast(error.message); }
  }
  async function showProjects() {
    try {
      await finishPendingSave();
      if (!roomConfig && localDraftOpen) recordVersion("Before opening project library");
      setLocalDraftOpen(false);
      window.location.hash = "projects";
      setMenuOpen(false); setProjectPanelOpen(false);
    } catch (error) { setToast(error.message); }
  }
  async function createLibraryProject(name) {
    const startingHash = window.location.hash;
    setCreatingProject(true); setProjectsError("");
    try { const project = await createProject(name); if (window.location.hash === startingHash) await openProject(project); return true; }
    catch (error) { setProjectsError(error.message); return false; }
    finally { setCreatingProject(false); }
  }
  async function saveProjectName(event) {
    event.preventDefault();
    if (!roomConfig) { setProjectName(projectNameInput.trim() || "Untitled screenplay"); setProjectPanelOpen(false); return; }
    const identity = roomIdentity;
    setProjectSaving(true);
    try {
      const data = await projectRequest(`/${roomConfig.roomId}`, {method: "PATCH", key: roomConfig.key, body: {name: projectNameInput, revision: projectEditRevision}});
      if (currentRoomIdentity.current !== identity) return;
      latestProjectRevision.current = data.project.revision;
      setProjectMetadata(data.project); setProjectName(data.project.name); setProjectPanelOpen(false); setToast("Project title saved for everyone");
    } catch (error) { if (currentRoomIdentity.current === identity) { setToast(error.message); if (error.status === 409) { setProjectPanelOpen(false); void workspaceRefresh.current?.(); } } }
    finally { if (currentRoomIdentity.current === identity) setProjectSaving(false); }
  }
  async function addCurrentToLibrary() {
    if (!roomConfig) return;
    const identity = roomIdentity;
    setProjectSaving(true);
    try {
      const data = await projectRequest(`/${roomConfig.roomId}`, {method: "POST",key:roomConfig.key,body:{name: projectNameInput.trim() || projectName}});
      if (currentRoomIdentity.current !== identity) return;
      latestProjectRevision.current = data.project.revision;
      setProjectMetadata(data.project); setProjectName(data.project.name); setProjectPanelOpen(false); setToast("Project added to the shared library");
    } catch (error) { if (currentRoomIdentity.current === identity) setToast(error.message); }
    finally { if (currentRoomIdentity.current === identity) setProjectSaving(false); }
  }

  function roomRequest(path, options) { return workspaceApi.request(path, options); }

  function showSnapshot(snapshot) {
    if (JSON.stringify(blocksRef.current) !== JSON.stringify(snapshot.blocks)) {
      blocksRef.current = cloneBlocks(snapshot.blocks); setBlocks(blocksRef.current);
    }
    draftNameRef.current = snapshot.draftName; setDraftName(snapshot.draftName);
    if (snapshot.drafts) setDraftSnapshots(snapshot.drafts);
  }
  function resetEditingView() {
    editHistory.current = { undo: [], redo: [], lastKey: "", lastAt: 0 };
    setHistoryStatus({ undo: 0, redo: 0 }); setEditorLayout(null); setSelectedId(""); setDismissedFixes([]);
    setDraftPanelOpen(false);
  }
  async function finishPendingSave() {
    const sync = collabRef.current?.sync;
    await sync?.flush();
    if (sync?.hasPendingChanges()) throw new Error("This session still has unsaved changes. Reconnect and save before leaving or reviewing it.");
  }
  async function selectSession(session) {
    const requestRoom = roomIdentity;
    const stillHere = () => currentRoomIdentity.current === requestRoom;
    setWorkspaceError("");
    try {
      await finishPendingSave(); if (!stillHere()) return; resetEditingView();
      const next = session ? { ...session, token: workspaceApi.getSessionToken(session.id) } : null;
      selectedSessionRef.current = next;
      setActiveSession(next); setRoomHydrated(!next && !!workspaceData);
      if (!next && workspaceData) { showSnapshot(workspaceData.main); setSaveStatus("saved"); }
    } catch (error) { setToast(error.message); }
  }
  function requestSession(source = null) {
    const sourceName = source?.historyId ? historyDetail?.snapshot?.draftName : source?.draftId ? draftSnapshots.find(draft => draft.id === source.draftId)?.name : source?.blocks ? "the selected recovery copy" : null;
    setSessionStart({ source, sourceName }); setWorkspaceError("");
    setSharedHistory(null); setHistoryOpen(false);
    setDraftPanelOpen(false);
  }
  async function startSession() {
    const requestRoom = roomIdentity;
    const stillHere = () => currentRoomIdentity.current === requestRoom;
    if (!writerName.trim()) return;
    setWorkspaceBusy(true); setWorkspaceError("");
    try {
      await finishPendingSave();
      if (!stillHere()) return;
      const source = sessionStart?.source;
      const serverSource = source?.historyId ? { historyId: source.historyId } : source?.draftId ? { draftId: source.draftId } : undefined;
      const data = await workspaceApi.createSession({authorName: writerName.trim(), source: serverSource});
      if (!stillHere()) return;
      const token = data.sessionToken;
      setDeviceItem("beat-writer-name", writerName.trim());
      const localSource = sessionStart?.source?.blocks;
      resetEditingView();
      const next = { ...data.session, token };
      selectedSessionRef.current = next; setActiveSession(next); setRoomHydrated(false);
      showSnapshot(data); setSessionStart(null); setHistoryOpen(false); setSharedHistory(null);
      // Local recovery copies are applied only after the new session is connected.
      pendingRecovery.current = localSource ? { sessionId: data.session.id, blocks: cloneBlocks(localSource) } : null;
      void workspaceRefresh.current?.(); setToast(`${data.session.draftName} started. Current stays unchanged.`);
    } catch (error) { if (stillHere()) setWorkspaceError(error.message); }
    finally { if (stillHere()) setWorkspaceBusy(false); }
  }
  const pendingRecovery = useRef(null);
  useEffect(() => {
    if (roomHydrated && activeSession?.token && pendingRecovery.current?.sessionId === activeSession.id) {
      const recovered = pendingRecovery.current.blocks; pendingRecovery.current = null;
      commitBlocks(recovered);
    }
  }, [roomHydrated, activeSession?.id]);
  async function reviewSession() {
    const requestRoom = roomIdentity;
    const stillHere = () => currentRoomIdentity.current === requestRoom;
    setWorkspaceBusy(true); setWorkspaceError("");
    try { await finishPendingSave(); const data = await roomRequest(`/sessions/${activeSession.id}/review`); if (stillHere()) setSessionReview(data); }
    catch (error) { setToast(error.message); }
    finally { if (stillHere()) setWorkspaceBusy(false); }
  }
  async function promoteSession() {
    const requestRoom = roomIdentity;
    const stillHere = () => currentRoomIdentity.current === requestRoom;
    if (!sessionReview || !writerName.trim()) return;
    setWorkspaceBusy(true); setWorkspaceError("");
    try {
      await finishPendingSave();
      if (!stillHere()) return;
      const data = await workspaceApi.promoteSession(sessionReview.session.id, { expectedMainRevision: sessionReview.main.revision, reviewedSessionRevision: sessionReview.draft.revision, authorName: writerName.trim() });
      if (!stillHere()) return;
      setDeviceItem("beat-writer-name", writerName.trim());
      selectedSessionRef.current = null; setActiveSession(null); resetEditingView();
      latestMainRevision.current = data.main.revision;
      showSnapshot(data.main); setRoomHydrated(true); setSessionReview(null); setSaveStatus("saved");
      setWorkspaceData((current) => ({ ...current, main: data.main }));
      void workspaceRefresh.current?.(); setToast(`${data.main.draftName} is now current. The previous version is in History.`);
    } catch (error) {
      if (!stillHere()) return;
      if (error.status === 409) {
        try { setSessionReview(await roomRequest(`/sessions/${sessionReview.session.id}/review`)); }
        catch { /* Retain the reviewed version; server will still reject stale promotion. */ }
        setWorkspaceError("The current version or session changed. Review the refreshed comparison before making it current.");
      } else setWorkspaceError(error.message);
    } finally { if (stillHere()) setWorkspaceBusy(false); }
  }
  async function loadSharedHistory(cursor) {
    const requestRoom = roomIdentity;
    const stillHere = () => currentRoomIdentity.current === requestRoom;
    setWorkspaceBusy(true); setWorkspaceError("");
    try {
      const data = await roomRequest(`/history?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!stillHere()) return;
      setSharedHistory((current) => ({ ...data, events: cursor ? [...(current?.events || []), ...data.events] : data.events }));
    } catch (error) { if (stillHere()) setWorkspaceError(error.message); }
    finally { if (stillHere()) setWorkspaceBusy(false); }
  }
  async function selectHistoryEvent(id) {
    const requestRoom = roomIdentity;
    const stillHere = () => currentRoomIdentity.current === requestRoom;
    setWorkspaceBusy(true); setWorkspaceError("");
    try { const detail = await roomRequest(`/history/${id}`); if (stillHere()) setHistoryDetail(detail); }
    catch (error) { if (stillHere()) setWorkspaceError(error.message); }
    finally { if (stillHere()) setWorkspaceBusy(false); }
  }

  function commitBlocks(nextBlocks, { recordHistory = true, historyKey = "" } = {}) {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    const previousBlocks = blocksRef.current;
    if (JSON.stringify(previousBlocks) === JSON.stringify(nextBlocks)) return;
    if (recordHistory) {
      const history = editHistory.current;
      const now = Date.now();
      const coalescedTyping = historyKey && history.lastKey === historyKey && (historyKey.startsWith("composition:") || now - history.lastAt < 900);
      if (!coalescedTyping) history.undo = [...history.undo.slice(-99), { blocks: cloneBlocks(previousBlocks), selection: editorRef.current?.getSelection() }];
      history.redo = [];
      history.lastKey = historyKey;
      history.lastAt = now;
      setHistoryStatus({ undo: history.undo.length, redo: 0 });
    }
    blocksRef.current = nextBlocks;
    setBlocks(nextBlocks);
    const collaboration = collabRef.current;
    if (!collaboration) { setBlocks(nextBlocks); return; }
    collaboration.ydoc.transact(() => {
      const wantedIds = new Set(nextBlocks.map((block) => block.id));
      Array.from(collaboration.root.keys()).forEach((id) => {
        if (!wantedIds.has(id)) collaboration.root.delete(id);
      });
      nextBlocks.forEach((block, order) => {
        let sharedBlock = collaboration.root.get(block.id);
        if (!(sharedBlock instanceof Y.Map)) {
          sharedBlock = new Y.Map();
          collaboration.root.set(block.id, sharedBlock);
        }
        if (sharedBlock.get("type") !== block.type) sharedBlock.set("type", block.type);
        if (sharedBlock.get("order") !== order) sharedBlock.set("order", order);
        let sharedText = sharedBlock.get("text");
        if (!(sharedText instanceof Y.Text)) {
          sharedText = new Y.Text();
          sharedBlock.set("text", sharedText);
        }
        updateSharedText(sharedText, block.text);
      });
    }, "screenplay-edit");
  }

  function queueEditorFocus(id) {
    if (id) editorRef.current?.restoreSelection({ anchor: { id, offset: 0 }, focus: { id, offset: 0 } });
  }
  function undo() {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    const history = editHistory.current;
    if (!history.undo.length) return;
    const previous = history.undo.pop();
    history.redo = [...history.redo.slice(-99), { blocks: cloneBlocks(blocksRef.current), selection: editorRef.current?.getSelection() }];
    history.lastKey = "";
    setHistoryStatus({ undo: history.undo.length, redo: history.redo.length });
    editorRef.current?.restoreSelection(previous.selection);
    commitBlocks(cloneBlocks(previous.blocks), { recordHistory: false });
    setSelectedId(previous.selection?.focus.id || previous.blocks[0]?.id || "");
    setToast("Undid last change");
  }
  function redo() {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    const history = editHistory.current;
    if (!history.redo.length) return;
    const next = history.redo.pop();
    history.undo = [...history.undo.slice(-99), { blocks: cloneBlocks(blocksRef.current), selection: editorRef.current?.getSelection() }];
    history.lastKey = "";
    setHistoryStatus({ undo: history.undo.length, redo: history.redo.length });
    editorRef.current?.restoreSelection(next.selection);
    commitBlocks(cloneBlocks(next.blocks), { recordHistory: false });
    setSelectedId(next.selection?.focus.id || next.blocks[0]?.id || "");
    setToast("Redid last change");
  }
  function recordVersion(reason, snapshotBlocks = blocksRef.current) {
    if (!snapshotBlocks.length) return;
    const snapshot = cloneBlocks(snapshotBlocks);
    const signature = JSON.stringify({ draftName: draftNameRef.current, blocks: snapshot });
    setVersionHistory((current) => {
      if (JSON.stringify({ draftName: current[0]?.draftName, blocks: current[0]?.blocks || [] }) === signature) return current;
      const next = [{ id: `version-${Date.now()}-${crypto.randomUUID()}`, timestamp: new Date().toISOString(), reason, draftName: draftNameRef.current, blocks: snapshot }, ...current].slice(0, 30);
      try { setDeviceItem(versionStorageKey(roomConfig), JSON.stringify(next)); }
      catch { /* Keep the in-memory history available if browser storage is full. */ }
      return next;
    });
  }
  function openVersionHistory() {
    if (roomConfig) { setSharedHistory({ events: [], nextCursor: null }); setHistoryDetail(null); void loadSharedHistory(); setMenuOpen(false); setDraftPanelOpen(false); return; }
    recordVersion("Current version");
    setHistoryOpen(true);
    setMenuOpen(false); setProjectPanelOpen(false); setDraftPanelOpen(false); setDownloadOpen(false);
  }
  function restoreVersion(version) {
    if (roomConfig) { requestSession({ blocks: version.blocks }); return; }
    recordVersion("Before restore");
    queueEditorFocus(version.blocks[0]?.id);
    commitBlocks(cloneBlocks(version.blocks));
    setSelectedId(version.blocks[0]?.id || "");
    setDismissedFixes([]);
    setHistoryOpen(false);
    setToast(`Restored ${formatVersionTime(version.timestamp)}`);
  }
  function chooseElement(type) {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    editorRef.current?.format(type);
    setToast(`Formatted as ${ELEMENTS.find((element) => element.type === type)?.label}`);
  }
  function applyImport() {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    const parsed = classifyLines(importText);
    if (!parsed.length) { setToast("Paste some script text first"); return; }
    queueEditorFocus(parsed[0].id);
    commitBlocks(parsed); setSelectedId(parsed[0].id);
    setDeviceItem("beat-screenplay-parser-version", "2");
    setDismissedFixes([]);
    setImportOpen(false); setNoticeVisible(true); setActiveRightTab("fixes"); setToast("Draft imported and formatted");
  }
  function handleFile(file) {
    if (!file) return;
    const reader = new FileReader(); reader.onload = () => setImportText(String(reader.result || "")); reader.readAsText(file);
  }
  function applyFix(id) {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    const fix = fixes.find((item) => item.id === id);
    if (!fix) return;
    queueEditorFocus(fix.blockId);
    commitBlocks(applyReviewFixes(blocks, [fix]));
    setSelectedId(fix.blockId);
    window.setTimeout(() => document.querySelector(`[data-block-id="${fix.blockId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 20);
    setToast("Formatting fix applied to the screenplay");
  }
  function skipFix(id) {
    const fix = fixes.find((item) => item.id === id);
    if (!fix) return;
    setDismissedFixes((current) => [...new Set([...current, fix.fingerprint])]);
    setToast("Formatting fix skipped");
  }
  function applyAllFixes() {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    if (!fixes.length) return;
    commitBlocks(applyReviewFixes(blocks, fixes));
    setToast(`Applied ${fixes.length} formatting ${fixes.length === 1 ? "fix" : "fixes"} to the screenplay`);
  }
  function scrollToScene(id) {
    const matching = blocks.find((block) => block.id === id);
    if (matching) { editorRef.current?.focusBlock(matching.id); setSelectedId(matching.id); document.querySelector(`[data-block-id="${matching.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }
    else setToast("That scene is outside this page preview");
  }
  function addScene() {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    const next = { id: `scene-${Date.now()}`, type: "scene", text: "INT. NEW LOCATION — DAY" };
    queueEditorFocus(next.id);
    commitBlocks([...blocks, next]); setSelectedId(next.id);
    window.setTimeout(() => document.querySelector(`[data-block-id="${next.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 20);
  }
  function downloadTextFile(contents, extension, label) {
    const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    const filename = [projectName, draftName].filter(Boolean).join("-").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "Screenplay";
    anchor.href = href;
    anchor.download = `${filename}.${extension}`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
    setMenuOpen(false); setProjectPanelOpen(false); setDraftPanelOpen(false); setDownloadOpen(false); setToast(`${label} downloaded`);
  }
  function downloadFountain() {
    downloadTextFile(blocksToFountain(blocks), "fountain", "Screenplay file");
  }
  function downloadPlainText() {
    downloadTextFile(blocks.map((block) => block.text).join("\n\n"), "txt", "Plain-text script");
  }
  function downloadPdf() {
    const pdfLayout = paginateScreenplayForPdf(blocks);
    const bytes = buildScreenplayPdf(pdfLayout.pages, { hasTitlePage: pdfLayout.hasTitlePage });
    const href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = screenplayPdfFilename(projectName, draftName);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
    setMenuOpen(false);
    setDownloadOpen(false);
    setToast("PDF downloaded");
  }
  function reformatCurrentDraft() {
    const reviewFixes = createReviewFixes(blocks);
    setDismissedFixes([]);
    setProjectPanelOpen(false);
    setMenuOpen(false);
    setNoticeVisible(true);
    openFixesInspector();
    setToast(reviewFixes.length ? `Found ${reviewFixes.length} formatting ${reviewFixes.length === 1 ? "fix" : "fixes"}` : "Your screenplay formatting is already consistent");
  }
  function openFixesInspector() {
    setActiveRightTab("fixes");
    setInspectorOpen(true);
    window.setTimeout(() => {
      const panel = fixesPanelRef.current;
      panel?.scrollTo({ top: 0, behavior: "smooth" });
      panel?.focus({ preventScroll: true });
    }, 20);
  }
  function archiveDraft(name = draftNameRef.current, snapshotBlocks = blocksRef.current) {
    const existing = draftSnapshots.find((draft) => draft.name === name && JSON.stringify(draft.blocks) === JSON.stringify(snapshotBlocks));
    if (existing) return existing;
    if (draftSnapshots.length >= 50) { setToast("The saved-draft archive is full. Your current script continues to save."); return null; }
    const saved = { id: `draft-${Date.now()}-${crypto.randomUUID()}`, name, blocks: cloneBlocks(snapshotBlocks) };
    const collaboration = collabRef.current;
    if (collaboration) {
      // Each checkpoint is immutable, so another writer's saved draft cannot be overwritten.
      collaboration.drafts.set(saved.id, saved);
    } else {
      setDraftSnapshots((current) => [...current, saved]);
    }
    return saved;
  }
  function renameDraft(name) {
    if (readOnly) { setToast("Start a writing session to make changes."); return; }
    const nextName = name.trim().slice(0, 120);
    if (!nextName || nextName === draftNameRef.current) return;
    if (roomConfig && !roomHydrated) return;
    recordVersion("Before draft rename");
    draftNameRef.current = nextName;
    const collaboration = collabRef.current;
    if (collaboration) collaboration.metadata.set("draftName", nextName);
    else setDraftName(nextName);
    recordVersion("Draft renamed");
  }
  function duplicateDraft() {
    if (roomConfig) { requestSession(); return; }
    if (roomConfig && !roomHydrated) return;
    const number = Math.max(1, ...[draftName, ...draftSnapshots.map((draft) => draft.name)].map((name) => Number(name.match(/\d+/)?.[0] || 0))) + 1;
    if (!archiveDraft()) return;
    renameDraft(`Draft ${number}`);
    setDraftPanelOpen(false);
    setToast(`Created Draft ${number}. Your collaboration link stays the same.`);
  }
  function openDraft(snapshot) {
    if (roomConfig) { requestSession({ draftId: snapshot.id }); return; }
    if (roomConfig && !roomHydrated) return;
    if (!archiveDraft()) return;
    queueEditorFocus(snapshot.blocks[0]?.id);
    commitBlocks(cloneBlocks(snapshot.blocks));
    setDismissedFixes([]);
    renameDraft(snapshot.name);
    setSelectedId(snapshot.blocks[0]?.id || "");
    setDraftPanelOpen(false);
    setToast(`Opened ${snapshot.name} on the same collaboration link`);
  }
  function ensureRoom() {
    if (roomConfig) return { link: buildRoomLink(window.location.href, roomConfig), room: roomConfig };
    const roomId = randomToken(10);
    const key = randomToken(16);
    const seed = encodeSeed(blocks);
    const params = new URLSearchParams({ room: roomId, key });
    if (seed.length < 24000) params.set("seed", seed);
    const link = `${window.location.origin}${window.location.pathname}#${params.toString()}`;
    window.history.replaceState(null, "", link);
    const room = { roomId, key, seed: params.get("seed") || "", joined: false };
    setRoomConfig(room);
    setRoomHydrated(false);
    setSaveStatus("loading");
    return { link, room };
  }
  async function copyShareLink() {
    const { link } = ensureRoom();
    // Copying an existing link never writes an older snapshot over the shared document.
    void collabRef.current?.sync?.flush();
    try { await navigator.clipboard.writeText(link); setToast("Collaboration link copied"); }
    catch {
      const input = shareLinkInput.current;
      if (input) {
        input.value = link;
        input.focus();
        input.select();
        try { if (document.execCommand("copy")) { setToast("Collaboration link copied"); return; } } catch { /* Leave the full link selected for manual copying. */ }
      }
      setToast("The full script link is selected. Copy it with Command+C or Control+C.");
    }
  }
  async function sendInvite(event) {
    event.preventDefault();
    if (!inviteEmail.trim()) return;
    await copyShareLink();
    setToast(`Link copied for ${inviteEmail.trim()}`);
    setInviteEmail("");
  }

  function openSharedScript(value) {
    let target;
    try { target = new URL(value.trim(), window.location.href); } catch { /* Show invalid-link message below. */ }
    const room = target && parseRoomLink(target.href);
    if (!room) { setOpenLinkError("Paste the complete collaboration link, including everything after #."); return; }
    if (target.origin !== window.location.origin) { setOpenLinkError("This link belongs to another Beat site. Open that full link in your browser."); return; }
    void openProject(room);
  }

  function startNewScript() {
    recordVersion("Before starting a new screenplay");
    const next = [{ id: `block-${crypto.randomUUID()}`, type: "scene", text: "" }];
    blocksRef.current = next;
    draftNameRef.current = "Draft 1";
    editHistory.current = { undo: [], redo: [], lastKey: "", lastAt: 0 };
    setHistoryStatus({ undo: 0, redo: 0 });
    setBlocks(next);
    setDraftName("Draft 1");
    setLocalDraftOpen(true);
  }

  if (!roomConfig && !localDraftOpen) return <ProjectLibrary projects={projects} loading={projectsLoading} error={projectsError} onRefresh={refreshProjects} onOpen={openProject} onCreate={createLibraryProject} onImportLink={openSharedScript} linkError={openLinkError} creating={creatingProject} onResumeLocal={blocks.length ? () => setLocalDraftOpen(true) : null} localTitle={blocks[0]?.text}/>;

  return (
    <div className={`app-shell ${roomConfig ? "with-session-bar" : ""}`}>
      <header className="topbar">
        <div className="brand-group">
          <button className="wordmark" aria-label="Beat project library" onClick={showProjects}>Beat</button>
          <button className="library-button" onClick={showProjects}>Projects</button>
          <div className="menu-anchor">
            <IconButton label="Open project menu" className={menuOpen ? "is-active" : ""} onClick={() => { setMenuOpen((open) => !open); setDownloadOpen(false); }}><List size={23} /></IconButton>
            {menuOpen && <div className="project-menu">
              <button onClick={showProjects}><FileText size={18}/> All projects</button>
              <button disabled={readOnly} onClick={() => { setImportOpen(true); setMenuOpen(false); }}><FileArrowUp size={18} /> Paste or import draft</button>
              <button onClick={undo} disabled={readOnly || !historyStatus.undo}><ArrowCounterClockwise size={18} /> Undo</button>
              <button onClick={redo} disabled={readOnly || !historyStatus.redo}><ArrowClockwise size={18} /> Redo</button>
              <button onClick={openVersionHistory}><ClockCounterClockwise size={18} /> Version history</button>
              <span />
              <button onClick={downloadFountain}><DownloadSimple size={18} /> Export Fountain</button>
              <button onClick={downloadPdf}><FileText size={18} /> Download PDF</button>
              <span />
              <button onClick={() => { setToast("Formatting guide opened"); setMenuOpen(false); }}><ArrowSquareOut size={18} /> Formatting guide</button>
            </div>}
          </div>
          <span className="toolbar-divider" />
          <div className="menu-anchor toolbar-menu-anchor">
            <button className={`project-title ${projectPanelOpen ? "is-active" : ""}`} aria-expanded={projectPanelOpen} onClick={() => { setProjectNameInput(projectName); setProjectEditRevision(projectMetadata?.revision); setProjectPanelOpen((open) => !open); setDraftPanelOpen(false); setMenuOpen(false); setDownloadOpen(false); }}>{projectName} <CaretDown size={15} /></button>
            {projectPanelOpen && <div className="toolbar-popover project-popover">
              <form onSubmit={saveProjectName}><label htmlFor="project-name">Project title</label><div><input id="project-name" value={projectNameInput} maxLength={120} disabled={projectSaving} onChange={event => setProjectNameInput(event.target.value)} /><button disabled={projectSaving || !projectNameInput.trim() || (!!roomConfig && !projectMetadata)}>Save</button></div></form>
              {!!roomConfig && !projectMetadata && <button disabled={projectSaving || !roomHydrated} onClick={addCurrentToLibrary}>Add to shared project library</button>}
              <button onClick={showProjects}><FileText size={17}/> All projects</button>
              <span />
              <button disabled={readOnly} onClick={() => { setImportOpen(true); setProjectPanelOpen(false); }}><FileArrowUp size={17} /> Paste or import draft</button>
              <button onClick={reformatCurrentDraft}><MagicWand size={17} /> Repair current formatting</button>
              <button onClick={openVersionHistory}><ClockCounterClockwise size={17} /> Version history</button>
              <button onClick={downloadFountain}><DownloadSimple size={17} /> Export Fountain</button>
            </div>}
          </div>
          <div className="menu-anchor toolbar-menu-anchor">
            <button className={`draft-selector ${draftPanelOpen ? "is-active" : ""}`} aria-expanded={draftPanelOpen} onClick={() => { setDraftPanelOpen((open) => !open); setProjectPanelOpen(false); setMenuOpen(false); setDownloadOpen(false); }}>{draftName} <CaretDown size={14} /></button>
            {draftPanelOpen && <div className="toolbar-popover draft-popover session-draft-menu">
              {!readOnly && <form onSubmit={(event) => { event.preventDefault(); renameDraft(draftNameInput); setDraftPanelOpen(false); }}><label htmlFor="draft-name">Draft name</label><div><input id="draft-name" value={draftNameInput} maxLength={120} onChange={(event) => setDraftNameInput(event.target.value)} /><button>Save</button></div></form>}
              {roomConfig && <><p>Current version</p><button onClick={() => selectSession(null)}><FileText size={17}/><span><strong>{workspaceData?.main.draftName || "Connecting…"}</strong><small>Reviewed version shared by everyone</small></span></button><p>Writing sessions</p>{workspaceData?.sessions.map((session) => <button key={session.id} onClick={() => selectSession(session)}><FileText size={17}/><span><strong>{session.draftName}</strong><small>{session.authorName} · {session.status === "applied" ? "Made current" : workspaceApi.getSessionToken(session.id) ? "Resume your session" : "Review session"}</small></span></button>)}</>}
              {draftSnapshots.length > 0 && <><p>Earlier saved drafts · start a session to open</p>{draftSnapshots.toReversed().map((draft) => <button key={draft.id} onClick={() => openDraft(draft)}><FileText size={17}/><span><strong>{draft.name}</strong><small>{draft.blocks.length} elements · writer not recorded</small></span></button>)}</>}
              <span/><button disabled={!!roomConfig && !roomHydrated} onClick={duplicateDraft}><Plus size={17}/>{roomConfig ? "Start writing session" : "Duplicate as new draft"}</button>
              <button onClick={openVersionHistory}><ClockCounterClockwise size={17}/>Shared history</button>
              <button onClick={() => { setHistoryOpen(true); setDraftPanelOpen(false); }}>Recovery copies on this device</button>
            </div>}
          </div>
        </div>

        {noticeVisible && <div className="fix-notice" aria-live="polite">
          <CheckCircle size={22} /><span>{fixes.length ? <><strong>{fixes.length}</strong> formatting {fixes.length === 1 ? "fix" : "fixes"} ready</> : "Formatting check complete"}</span>
          <button onClick={openFixesInspector}>{fixes.length ? "Review fixes" : "View status"}</button>
          <IconButton label="Dismiss formatting notice" onClick={() => setNoticeVisible(false)}><X size={18} /></IconButton>
        </div>}

        <div className="collaboration-actions">
          <button className={`live-status status-${saveStatus}`} aria-label={`Save status: ${saveStatusText(saveStatus)}`} title={saveError || (roomConfig ? "Your edits and draft name save to this collaboration link. Click to reconnect." : "Use Share to save online and invite collaborators.")} onClick={() => { if (roomConfig) { void collabRef.current?.sync?.flush(); void workspaceRefresh.current?.(); } else setShareOpen(true); }}><Circle size={8} weight="fill" />{saveStatusText(saveStatus)}</button>
          <span className="writer-presence" title="Writers viewing this room"><Users size={18}/>{onlineCount}</span>
          <div className="menu-anchor download-anchor">
            <button className={`download-button ${downloadOpen ? "is-active" : ""}`} aria-expanded={downloadOpen} aria-haspopup="menu" title="Download current draft" onClick={() => { setDownloadOpen((open) => !open); setCommentsOpen(false); }}><DownloadSimple size={19} /><span>Download</span><CaretDown className="download-caret" size={13} /></button>
            {downloadOpen && <div className="toolbar-popover download-popover" role="menu">
              <p>Download current draft</p>
              <button role="menuitem" onClick={downloadFountain}><FileText size={18} /><span><strong>Screenplay file</strong><small>.fountain — opens in screenplay apps</small></span></button>
              <button role="menuitem" onClick={downloadPlainText}><DownloadSimple size={18} /><span><strong>Plain text</strong><small>.txt — easy to share anywhere</small></span></button>
              <span />
              <button role="menuitem" onClick={downloadPdf}><FileText size={18} /><span><strong>PDF</strong><small>Ready-to-share .pdf file</small></span></button>
            </div>}
          </div>
          <button className="share-button" onClick={() => { setShareOpen(true); setDownloadOpen(false); }}><Users size={19} /> Share</button>
        </div>
      </header>

      {roomConfig && <section className="session-bar" aria-label="Writing session">
        <div><strong>{activeSession ? `${draftName} · ${activeSession.status === "applied" ? "Completed session" : activeSession.token ? "Your writing session" : "Session preview"}` : `${draftName} · Current version`}</strong><small>{activeSession ? `By ${activeSession.authorName} · Started from ${activeSession.baseDraftName || "current"}, revision ${activeSession.baseMainRevision}. ${readOnly ? "Read only." : "Changes save to this separate draft."}` : "Read only. Start a separate session to write; review it before making it current."}</small></div>
        <div className="session-bar-actions">{unpublishedRecovery && <button className="secondary-button" onClick={() => requestSession({blocks: unpublishedRecovery.blocks})}>Recover unpublished changes</button>}{activeSession && <button className="secondary-button" onClick={() => selectSession(null)}>View current</button>}{activeSession?.status === "active" && <button className="secondary-button" disabled={workspaceBusy || !roomHydrated} onClick={reviewSession}>Review changes</button>}<button className="primary-button" disabled={workspaceBusy || !roomHydrated} onClick={() => requestSession()}>Start writing session</button></div>
      </section>}
      <div className="workspace">
        <aside className="left-panel">
          <div className="panel-tabs left-tabs">
            <button className={activeLeftTab === "scenes" ? "active" : ""} onClick={() => setActiveLeftTab("scenes")}>Scenes</button>
            <button className={activeLeftTab === "outline" ? "active" : ""} onClick={() => setActiveLeftTab("outline")}>Outline</button>
          </div>
          {activeLeftTab === "scenes" ? <div className="scene-list">
            <section className="act-group">
              <h3><CaretDown size={13} /> {screenplayScenes.length ? `${screenplayScenes.length} SCENES` : "NO SCENES YET"}</h3>
              {screenplayScenes.map((scene, index) => <button key={scene.id} className={`scene-row ${selected?.id === scene.id || (!selected && index === 0) ? "active" : ""}`} onClick={() => scrollToScene(scene.id)}><span>{index + 1}</span><strong>{scene.text}</strong></button>)}
            </section>
          </div> : <div className="outline-view">
            <p className="eyebrow">Story outline</p><h3>{projectName}</h3>
            <p>{screenplayScenes.length} scene{screenplayScenes.length === 1 ? "" : "s"} detected in {draftName}. Select Scenes to jump through the script.</p>
            <button onClick={() => setActiveLeftTab("scenes")}><SidebarSimple size={18} /> Return to scenes</button>
          </div>}
          <button className="add-scene" disabled={readOnly} onClick={addScene}><Plus size={18} /> Add scene</button>
          <div className="left-status"><span>{zoom}%</span><span /><span>{selected?.type === "scene" ? selected.text : screenplayScenes[0]?.text || "No scene selected"}</span></div>
        </aside>

        <main className="editor-area">
          <ScreenplayEditor ref={editorRef} blocks={blocks} pages={paginatedBlocks} hasTitlePage={hasTitlePage} selectedId={selectedId} onSelect={setSelectedId} onChange={commitBlocks} onLayout={setEditorLayout} onUndo={undo} onRedo={redo} elementTypes={ELEMENTS.map((element) => element.type)} zoom={zoom} waiting={!!roomConfig && !roomHydrated} readOnly={readOnly} />
          <footer className="editor-footer">
            <div className="zoom-control"><button onClick={() => setZoom((value) => Math.max(75, value - 10))} aria-label="Zoom out"><Minus size={14} /></button><span>{zoom}%</span><button onClick={() => setZoom((value) => Math.min(125, value + 10))} aria-label="Zoom in"><Plus size={14} /></button></div>
            <div className="editor-history-actions" aria-label="Editing history"><button aria-label="Undo" disabled={readOnly || !historyStatus.undo} onClick={undo}><ArrowCounterClockwise size={15} /><span>Undo</span></button><button aria-label="Redo" disabled={readOnly || !historyStatus.redo} onClick={redo}><ArrowClockwise size={15} /><span>Redo</span></button><button aria-label="Version history" onClick={openVersionHistory}><ClockCounterClockwise size={15} /><span>History</span></button></div>
            <button className="compact-format-button" onClick={() => setInspectorOpen(true)}><SidebarSimple size={15} /> Format</button><span>Words: {wordCount}</span><span>Pages: {paginatedBlocks.length}</span>
          </footer>
        </main>

        <aside className={`right-panel ${inspectorOpen ? "compact-open" : ""}`}>
          <IconButton label="Close formatting panel" className="inspector-close" onClick={() => setInspectorOpen(false)}><X size={18} /></IconButton>
          <div className="panel-tabs right-tabs"><button className={activeRightTab === "format" ? "active" : ""} onClick={() => setActiveRightTab("format")}>Format</button><button className={activeRightTab === "fixes" ? "active" : ""} onClick={() => setActiveRightTab("fixes")}>Fixes {fixes.length > 0 && <span>{fixes.length}</span>}</button></div>
          {activeRightTab === "format" ? <div className="format-panel">
            <p className="section-label">Element type</p>
            <div className="element-list">{ELEMENTS.map(({ type, label, help, icon: ElementIcon }) => <button key={type} className={selected?.type === type ? "active" : ""} onMouseDown={(event) => event.preventDefault()} disabled={readOnly} onClick={() => chooseElement(type)}><span className="element-icon"><ElementIcon size={21} /></span><span><strong>{label}</strong><small>{help}</small></span></button>)}</div>
            <p className="format-tip">Select across lines to copy, cut, paste, or change their format. Press Enter for a new element, then choose its type.</p>
            <div className="settings-divider" /><p className="section-label">Dialogue settings</p>
            <div className="setting-row"><label>Alignment</label><div className="segmented-control"><IconButton label="Align left" className={alignment === "left" ? "active" : ""} onClick={() => setAlignment("left")}><TextAlignLeft size={18} /></IconButton><IconButton label="Align center" className={alignment === "center" ? "active" : ""} onClick={() => setAlignment("center")}><TextAlignCenter size={18} /></IconButton><IconButton label="Align right" className={alignment === "right" ? "active" : ""} onClick={() => setAlignment("right")}><TextAlignRight size={18} /></IconButton></div></div>
            <div className="setting-row"><label>Parenthetical position</label><div className="segmented-control two"><IconButton label="Standard position" className="active"><TextAlignLeft size={18} /></IconButton><IconButton label="Centered position"><TextAlignCenter size={18} /></IconButton></div></div>
            <div className="setting-row"><label htmlFor="dialogue-spacing">Dialogue spacing</label><select id="dialogue-spacing" defaultValue="Single"><option>Single</option><option>1.5 lines</option><option>Double</option></select></div>
            <label className="checkbox-row"><input type="checkbox" checked={dualDialogue} onChange={(event) => setDualDialogue(event.target.checked)} /><span><strong>Dual dialogue</strong><small>Two characters, same time</small></span></label>
          </div> : <div className="fixes-panel" ref={fixesPanelRef} tabIndex={-1}>{fixes.length ? <>
            <div className="fix-progress"><span>{fixes.length} formatting {fixes.length === 1 ? "issue" : "issues"} remaining · checks update as you type</span><div><i style={{ width: "100%" }} /></div></div>
            <div className="current-fix"><div className="fix-heading"><span><MagicWand size={18} /></span><p>Current suggestion</p></div><h3>{fixes[0].title}</h3><p>{fixes[0].detail}</p><div className="fix-diff"><small>Before</small><del>{fixes[0].before}</del><ArrowRight size={16} /><small>After</small><ins>{fixes[0].after}</ins></div><button className="apply-fix" disabled={readOnly} onClick={() => applyFix(fixes[0].id)}><Check size={17} weight="bold" /> Apply fix</button><button className="skip-fix" onClick={() => skipFix(fixes[0].id)}><SkipForward size={17} /> Skip for now</button></div>
            <button className="apply-all" disabled={readOnly} onClick={applyAllFixes}>Apply all {fixes.length} fixes</button>
          </> : <div className="all-fixed"><CheckCircle size={42} weight="light" /><h3>{fixTotal ? "No active fixes" : "Your formatting is consistent"}</h3><p>{fixTotal ? "Skipped issues will return if the affected text changes." : "Beat is continuously checking the full draft for screenplay formatting problems."}</p><button onClick={() => setActiveRightTab("format")}>Back to formatting</button></div>}</div>}
          <div className="right-help"><span>Need help?</span><button onClick={() => setToast("Formatting guide opened")}>See formatting guide <ArrowSquareOut size={15} /></button></div>
        </aside>
      </div>

      {commentsOpen && <aside className="comments-popover"><header><div><strong>Comments</strong><span>Scene 1</span></div><IconButton label="Close comments" onClick={() => setCommentsOpen(false)}><X size={18} /></IconButton></header><div className="comment"><span className="fictional-avatar" aria-hidden="true">W</span><div><strong>Fictional reviewer</strong><p>Sample comment: clarify the action before the test begins.</p><small>Demo only; comments are not synchronized</small></div></div><form onSubmit={(event) => { event.preventDefault(); setToast("Comment added"); setCommentsOpen(false); }}><input aria-label="Add a comment" placeholder="Add a comment…" /><button aria-label="Send comment"><PaperPlaneTilt size={18} /></button></form></aside>}

      {importOpen && <Modal title="Paste or import your draft" subtitle="Beat recognizes common screenplay patterns, then lets you review every change." onClose={() => setImportOpen(false)} className="import-modal"><div className="import-options"><button className="upload-zone" onClick={() => fileInput.current?.click()}><UploadSimple size={24} /><strong>Choose a text or Fountain file</strong><span>.txt, .md, and .fountain</span></button><input ref={fileInput} type="file" hidden accept=".txt,.md,.fountain,text/plain" onChange={(event) => handleFile(event.target.files?.[0])} /><div className="or-divider"><span>or paste below</span></div><label htmlFor="draft-paste">Draft text</label><textarea id="draft-paste" value={importText} onChange={(event) => setImportText(event.target.value)} /></div><footer className="modal-actions"><button className="secondary-button" onClick={() => setImportOpen(false)}>Cancel</button><button className="primary-button" onClick={applyImport}><MagicWand size={18} /> Format draft</button></footer></Modal>}

      {shareOpen && <Modal title={`Share “${projectName}”`} subtitle="Keep this link. It always opens the current reviewed version, with separate writing sessions and shared history." onClose={() => setShareOpen(false)} className="share-modal"><form className="invite-form" onSubmit={sendInvite}><label htmlFor="invite-email">Prepare a link for a collaborator</label><div><input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="name@example.com" /><select value={access} onChange={(event) => setAccess(event.target.value)}><option>Can write in sessions</option></select><button>Copy link</button></div></form><div className="visible-share-link"><label htmlFor="script-share-link">Full script link</label><input id="script-share-link" ref={shareLinkInput} readOnly value={roomConfig ? buildRoomLink(window.location.href, roomConfig) : ""} placeholder="Choose Copy collaboration link to create a link" onFocus={(event) => event.currentTarget.select()} /><small>Keep the whole link, including everything after #.</small></div><div className="link-sharing"><span><Circle size={10} weight="fill"/><span><strong>One link for every draft</strong><small>Anyone with the full link can start a separate writing session, review changes, and make a session current. Names in history are entered by each writer.</small></span></span></div><footer className="modal-actions"><button className="copy-link" onClick={copyShareLink}><Copy size={18} /> Copy collaboration link</button><button className="primary-button" onClick={() => setShareOpen(false)}>Done</button></footer></Modal>}
      {historyOpen && <Modal title="Recovery copies on this device" subtitle="These local backups have no recorded writer. Opening one starts a separate session." onClose={() => setHistoryOpen(false)} className="history-modal"><div className="version-list">{versionHistory.map((version, index) => {
        const versionWords = version.blocks.reduce((sum, block) => sum + block.text.trim().split(/\s+/).filter(Boolean).length, 0);
        return <div className={`version-row ${index === 0 ? "current" : ""}`} key={version.id}><span className="version-icon"><ClockCounterClockwise size={19} /></span><span><strong>{version.reason}</strong><small>{version.draftName || draftName} · {formatVersionTime(version.timestamp)} · {versionWords} words</small></span><button onClick={() => restoreVersion(version)}>{roomConfig ? "Start session" : "Restore"}</button></div>;
      })}{versionHistory.length < 2 && <p className="version-empty">Earlier versions will appear here automatically after you make changes.</p>}</div><footer className="modal-actions"><button className="secondary-button" onClick={() => setHistoryOpen(false)}>Done</button></footer></Modal>}
      {sessionStart && <SessionStartDialog sourceName={sessionStart.sourceName} writerName={writerName} setWriterName={setWriterName} onStart={startSession} onClose={() => { if (!workspaceBusy) setSessionStart(null); }} busy={workspaceBusy} error={workspaceError}/>}
      {sessionReview && <SessionReviewDialog review={sessionReview} writerName={writerName} setWriterName={setWriterName} onPromote={promoteSession} onClose={() => { if (!workspaceBusy) setSessionReview(null); }} busy={workspaceBusy} error={workspaceError}/>}
      {sharedHistory && <SharedHistoryDialog events={sharedHistory.events} nextCursor={sharedHistory.nextCursor} detail={historyDetail} onSelect={selectHistoryEvent} onLoadMore={() => loadSharedHistory(sharedHistory.nextCursor)} onFork={(historyId) => requestSession({historyId})} onClose={() => setSharedHistory(null)} busy={workspaceBusy} error={workspaceError}/>}
      {toast && <div className="toast" role="status"><CheckCircle size={18} weight="fill" /> {toast}</div>}
    </div>
  );
}
