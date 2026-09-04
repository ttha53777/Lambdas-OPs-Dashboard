"use client";

// "Ask Chapt" — the Spotlight. A floating launcher opens a centered spotlight
// modal over a blurred scrim (⌘K / Ctrl-K toggles, Esc closes). Streams from
// /api/ai/chat (SSE — protocol documented in the route): the thinking state
// renders as a REASONING LEDGER (steps posting findings + Consulted chips)
// that collapses into an auditable trace above the answer; answers are hybrid
// (serif verdict + tappable result rows + Sources + follow-ups + feedback);
// writes surface as permission-gated writ cards (Approve / Discard, or a
// blocked gate naming who holds the authority). History is localStorage-only.
// The launcher hides itself when the server reports no OPENAI_API_KEY.
//
// Visual language: the warm dusk vocabulary of _design/Ask Chapt Spotlight
// v3.html — Fraunces serif counsel voice, ONE violet accent, zero gradients.
// Styling in chat-spotlight.css; fonts come from next/font vars on <html>.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { orgFetch } from "../lib/api";
import { iterSSE } from "../lib/sse";
import { useChapter } from "../context/ChapterContext";
import { IcCal, IcCoin, IcSend, IcStop, IcUsers } from "./chat/icons";
import { MarkdownLite } from "./chat/MarkdownLite";
import { LedgerHandoff, ReasoningLedger, TraceBlock } from "./chat/ReasoningLedger";
import { AnswerBlock } from "./chat/AnswerBlock";
import { PeekSheet, type PeekSeed } from "./chat/PeekSheet";
import { EventIdeaPanel, type EventIdeaSeed } from "./chat/EventIdeaPanel";
import { WritCard } from "./chat/WritCard";
import { ApprovalsView } from "./chat/ApprovalsView";
import { dropProvisional, intentFor, planFor, reconcileStep, settleLedger } from "./chat/intent";
import {
  newId,
  rowAction,
  stepRow,
  timeStamp,
  type AnswerData,
  type AnswerRow,
  type ChatMessage,
  type EntityRef,
  type LedgerStep,
  type ProposalCard,
} from "./chat/types";
import "./chat-spotlight.css";

const STORAGE_KEY = "chaptos_chat_v2";
const LEGACY_STORAGE_KEY = "chaptos_chat_v1";
const PULSE_SEEN_KEY = "chaptos_chat_seen_v1";
const MAX_HISTORY = 50;
// Only the most recent turns keep their ledger steps in storage — traces on
// old turns are rarely reopened and steps are the bulky part of a message.
const STEPS_KEPT = 10;

// A curated three, not a directory — each maps to a real answer flow.
const STARTERS = [
  { icon: <IcCoin size={14} />, label: "Outstanding dues", q: "How are we doing on dues?" },
  { icon: <IcUsers size={14} />, label: "Attendance gaps", q: "Who missed the last two meetings?" },
  { icon: <IcCal size={14} />, label: "This week", q: "Summarize what's happening this week." },
] as const;

type Scene = "briefing" | "thread" | "approvals";

// What the settled bar says, by the surface the action wrote to.
const APPROVED_TEXT: Record<string, string> = {
  dues: "Approved — posted to the ledger.",
  treasury: "Approved — posted to the ledger.",
  timeline: "Approved — added to the timeline.",
  events: "Approved — added to the calendar.",
  programming: "Approved — added to the board.",
  instagram: "Approved — added to the queue.",
};

function approvedText(kind: string): string {
  return APPROVED_TEXT[kind] ?? "Approved.";
}

/** Text a message contributes to the request history (the server wants prose). */
function messageText(m: ChatMessage): string {
  if (m.content.trim()) return m.content;
  if (m.answer) {
    return [
      m.answer.verdict.replace(/\*/g, ""),
      ...m.answer.rows.map(r => [r.title, r.subtitle, r.value].filter(Boolean).join(" — ")),
    ].join("\n");
  }
  return "";
}

function loadHistory(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY); // pre-Spotlight shape — drop silently
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(parsed)) return [];
    // An in-flight confirm that lost its page can't resolve — surface as error.
    // Likewise a turn interrupted mid-ledger: settle its steps so reopening the
    // trace shows a record rather than a spinner that will never resolve, and
    // drop any guessed step the model never got round to corroborating.
    return parsed.slice(-MAX_HISTORY).map(m => ({
      ...m,
      steps: m.steps
        ?.filter(s => !s.provisional)
        .map(s => (s.status === "done" ? s : { ...s, status: "done" as const })),
      composing: undefined,
      proposals: m.proposals?.map(p =>
        p.state === "confirming" ? { ...p, state: "error" as const, resultMessage: "Interrupted — not approved." } : p,
      ),
    }));
  } catch { return []; }
}

function saveHistory(msgs: ChatMessage[]) {
  if (typeof window === "undefined") return;
  try {
    // An empty thread never overwrites a stored one. ChatWidgetGate renders the
    // widget only once currentUser.org has resolved off /api/auth/me, so on a
    // fresh page load this component mounts, unmounts and mounts again while
    // that settles — and every mount runs this effect once with `messages`
    // still at its initial []. That wiped the stored thread before the mount
    // that would have loaded it got there, so NOTHING survived a reload:
    // answers, traces, and — the part that actually costs something — proposals
    // left pending. A card you hadn't approved yet was destroyed by a refresh,
    // which makes the pending state's implicit promise ("decide later") false.
    // The only legitimate way to reach an empty thread is clearing it, which
    // removes the key outright rather than saving [] over it.
    if (msgs.length === 0) return;
    const trimmed = msgs.slice(-MAX_HISTORY).map((m, i, all) =>
      all.length - i > STEPS_KEPT ? { ...m, steps: undefined } : m,
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch { /* localStorage full — silently drop */ }
}

// Launcher sparkle — outlined, matches the app's heroicons-style SVG language.
// Deliberately not the solid `IcSpark` the spotlight panel's chrome uses.
function SparkleIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
      <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />
      <path d="M5 15l.6 1.6L7.2 17l-1.6.6L5 19l-.6-1.6L2.8 17l1.6-.4L5 15z" />
    </svg>
  );
}

export function ChatWidget() {
  const { currentUser } = useChapter();
  const router = useRouter();
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = unknown
  const [open, setOpen] = useState(false);
  const [scene, setScene] = useState<Scene>("briefing");
  const [pulse, setPulse] = useState(false); // first-run nudge on the launcher
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [selRow, setSelRow] = useState(-1); // keyboard-selected result row on the last answer
  // The open peek, if any — a tapped answer row's record. Layered OVER the
  // thread, which keeps its scroll position underneath.
  const [peek, setPeek] = useState<{ refr: EntityRef; seed: PeekSeed } | null>(null);
  // The open event-idea panel, if any — a tapped programming suggestion, opened
  // into an explanation plus a prefilled proposal. Rides over the thread the
  // same way the peek does, and is mutually exclusive with it.
  const [idea, setIdea] = useState<EventIdeaSeed | null>(null);
  // Mirror of `messages` for synchronous reads in sendMessage — building the
  // request body inside a setMessages updater isn't reliable under React 18
  // batching (could read stale/empty state and POST {messages: []} → 400).
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Guards the persist effect until loadHistory has run — see below.
  const loadedRef = useRef(false);

  const actorName = currentUser?.name ?? "you";

  // Probe whether the chat is enabled (key configured). Hide the launcher if not.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ai/chat", { method: "GET" })
      .then(r => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled?: boolean }) => { if (!cancelled) setEnabled(d.enabled === true); })
      .catch(() => { if (!cancelled) setEnabled(false); });
    return () => { cancelled = true; };
  }, []);

  // Load persisted history once on mount. Show the first-run pulse only when the
  // member has never opened the spotlight before (no seen-flag, no history).
  useEffect(() => {
    setMessages(loadHistory());
    loadedRef.current = true;
    try {
      if (!localStorage.getItem(PULSE_SEEN_KEY) && !localStorage.getItem(STORAGE_KEY)) setPulse(true);
    } catch { /* ignore */ }
  }, []);

  // Persist on every change — but never before the load above has run. Both
  // effects fire on mount, and this one used to win with `messages` still at its
  // initial [], overwriting the stored thread with an empty array before the
  // loaded one was committed. Every past turn was destroyed on every reload,
  // pending proposals included: a card left unapproved could not survive a
  // refresh, so the "approve it later" the pending state promises was a lie.
  useEffect(() => {
    if (!loadedRef.current) return;
    saveHistory(messages);
  }, [messages]);

  // Auto-scroll the thread to the newest turn.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, streaming, scene]);

  const openSpotlight = useCallback(() => {
    setOpen(true);
    setScene(messagesRef.current.length > 0 ? "thread" : "briefing");
  }, []);

  const closeSpotlight = useCallback(() => {
    setOpen(false);
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }, []);

  const openPeek = useCallback((row: AnswerRow) => {
    if (!row.ref) return;
    setPeek({
      refr: row.ref,
      // The row's own text carries the sheet until the fetch lands.
      seed: { title: row.title, subtitle: row.subtitle, kind: row.kind, ask: row.ask },
    });
  }, []);

  // A suggested event opens the idea panel instead of navigating: the row IS
  // the idea, and the Events screen is where it would otherwise be forgotten.
  // The question that produced the answer rides along so the explanation can be
  // about this chapter's problem rather than the event in the abstract.
  const openIdea = useCallback((row: AnswerRow) => {
    const all = messagesRef.current;
    let question = "";
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].role === "user" && all[i].content.trim()) { question = all[i].content.trim(); break; }
    }
    setPeek(null);
    setIdea({ title: row.title, subtitle: row.subtitle, ...(question ? { question } : {}) });
  }, []);

  // Advisory rows leave for a screen. The path arrives relative to the org (the
  // server resolved it from a closed enum, so it's never model-authored text)
  // and the slug is prefixed here, where the active org is already known — the
  // answer payload stays tenant-free. Closing first means returning by Back
  // lands on the page, not on a stale open spotlight.
  const navRow = useCallback((row: AnswerRow) => {
    const slug = currentUser?.org?.slug;
    if (!row.screen || !slug) return;
    closeSpotlight();
    router.push(`/${slug}${row.screen.path}`);
  }, [currentUser?.org?.slug, closeSpotlight, router]);

  /**
   * A confirmed idea became a real event. Close the spotlight and land on the
   * screen the event now lives on, so the officer sees the thing they just
   * created rather than being returned to the chat that described it.
   *
   * That screen is /events. The feature brief calls this "the Timeline", but in
   * this app Timeline is /tasks (deadlines) — a CalendarEvent renders on the
   * Events page (SCREEN_PATHS.events), so that is where a newly booked event is
   * actually visible.
   */
  const onIdeaCreated = useCallback((_eventId: number | null, _payload: Record<string, unknown>) => {
    const slug = currentUser?.org?.slug;
    setIdea(null);
    closeSpotlight();
    if (slug) router.push(`/${slug}/events`);
  }, [currentUser?.org?.slug, closeSpotlight, router]);

  // ⌘K / Ctrl-K toggles; Esc closes. This is the app's one global Cmd+K owner.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // Esc unwinds one layer at a time — an open panel before the spotlight.
      if (e.key === "Escape" && open && idea) { setIdea(null); return; }
      if (e.key === "Escape" && open && peek) { setPeek(null); return; }
      if (e.key === "Escape" && open) { closeSpotlight(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) closeSpotlight(); else openSpotlight();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, peek, idea, openSpotlight, closeSpotlight]);

  // On open: dismiss the pulse for good; focus the composer.
  useEffect(() => {
    if (!open) return;
    if (pulse) { setPulse(false); try { localStorage.setItem(PULSE_SEEN_KEY, "1"); } catch { /* ignore */ } }
    const t = setTimeout(() => textareaRef.current?.focus(), 80);
    return () => clearTimeout(t);
  }, [open, pulse, scene]);

  // ── The ask flow ───────────────────────────────────────────────────────────

  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage> | ((m: ChatMessage) => ChatMessage)) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== id) return m;
      return typeof patch === "function" ? patch(m) : { ...m, ...patch };
    }));
  }, []);

  // ── Ledger staging ─────────────────────────────────────────────────────────
  // Tool calls arrive in bursts — several names land in one delta chunk, and
  // parallel tools finish within milliseconds of each other. Applied raw, a
  // batch pops onto screen in a single frame instead of posting like a ledger.
  // So ledger mutations queue and apply a beat apart, spending ONLY the slack
  // we're already waiting through.
  //
  // The queue can never delay an answer, because every terminal event flushes it
  // first. `flushStage` is deliberately synchronous — DO NOT put an `await`
  // between a flush and the patch that follows it, or the answer waits on the
  // animation instead of the other way round. Flushed mutations and the terminal
  // patch land in one React commit, so there is no extra frame either.
  const stageRef = useRef<{ q: Array<() => void>; timer: ReturnType<typeof setTimeout> | null }>({ q: [], timer: null });
  const reducedRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const sync = () => { reducedRef.current = mq.matches; };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const flushStage = useCallback(() => {
    const s = stageRef.current;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    while (s.q.length) s.q.shift()!();
  }, []);

  const enqueueStage = useCallback((mutation: () => void) => {
    const s = stageRef.current;
    if (reducedRef.current) { mutation(); return; }
    s.q.push(mutation);
    const pump = () => {
      s.timer = null;
      const next = s.q.shift();
      if (!next) return;
      next();
      if (s.q.length === 0) return;
      // Tighten as the queue deepens so a three-tool batch still cascades
      // instead of collapsing, while total staged delay stays bounded.
      const gap = s.q.length > 6 ? 0 : s.q.length > 3 ? 45 : 90;
      s.timer = setTimeout(pump, gap);
    };
    if (!s.timer) s.timer = setTimeout(pump, 0);
  }, []);

  // A queued mutation that outlives its turn would patch the wrong message.
  useEffect(() => () => {
    const s = stageRef.current;
    if (s.timer) clearTimeout(s.timer);
    s.q.length = 0;
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;

    // A new turn supersedes whatever record was open.
    setPeek(null);
    // Any mutation still queued belongs to the turn we're replacing.
    flushStage();
    stageRef.current.q.length = 0;

    const userMsg: ChatMessage = { id: newId(), role: "user", content: trimmed };
    // Seed the ledger with what the question is plainly about, so the wait while
    // the model decides isn't a blank panel. These rows are pending-only guesses
    // (see chat/intent.ts) — the real steps replace or evict them.
    const assistantMsg: ChatMessage = {
      id: newId(),
      role: "assistant",
      content: "",
      steps: planFor(trimmed),
      intent: intentFor(trimmed),
    };
    const payloadHistory = [...messagesRef.current, userMsg]
      .map(m => ({ role: m.role, content: messageText(m) }))
      .filter(m => m.content.trim().length > 0)
      .slice(-12);
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setScene("thread");
    setInput("");
    setSelRow(-1);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const aid = assistantMsg.id;

    try {
      const res = await orgFetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payloadHistory }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errText = res.status === 429 ? "Slow down — too many messages." : `Sorry, the chat failed (HTTP ${res.status}).`;
        patchMessage(aid, { content: errText });
        setStreaming(false);
        return;
      }

      for await (const { event, data } of iterSSE(res.body)) {
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { continue; }

        // Ledger events stage; everything terminal flushes first (see enqueueStage).
        if (event === "step") {
          const s = parsed as { id?: string; verb?: string; source?: string };
          if (s.id && s.verb) {
            // Named, not yet running — a pending node on the margin.
            const step: LedgerStep = { id: s.id, verb: s.verb, ...(s.source ? { source: s.source } : {}), status: "pending" };
            enqueueStage(() => patchMessage(aid, m => ({
              ...m,
              steps: reconcileStep(m.steps ?? [], step),
              composing: false,
            })));
          }
        } else if (event === "step_start") {
          const s = parsed as { id?: string };
          if (s.id) {
            enqueueStage(() => patchMessage(aid, m => ({
              ...m,
              // The batch is known now, so any guess it didn't corroborate goes.
              steps: dropProvisional(m.steps ?? []).map(st =>
                st.id === s.id ? { ...st, status: "active" as const } : st,
              ),
            })));
          }
        } else if (event === "step_done") {
          const s = parsed as { id?: string; finding?: string };
          if (s.id) {
            enqueueStage(() => patchMessage(aid, m => ({
              ...m,
              steps: (m.steps ?? []).map(st => st.id === s.id
                ? { ...st, status: "done" as const, ...(s.finding ? { finding: s.finding } : {}) }
                : st),
            })));
          }
        } else if (event === "step_drop") {
          const s = parsed as { ids?: string[] };
          const ids = new Set(Array.isArray(s.ids) ? s.ids : []);
          if (ids.size > 0) {
            enqueueStage(() => patchMessage(aid, m => ({
              ...m,
              steps: (m.steps ?? []).filter(st => !ids.has(st.id)),
            })));
          }
        } else if (event === "composing") {
          // The model is writing, so anything we guessed it would read is
          // settled as wrong — drop it now rather than let it sit there pending
          // until the answer lands.
          enqueueStage(() => patchMessage(aid, m => ({
            ...m,
            steps: dropProvisional(m.steps ?? []),
            composing: true,
          })));
        } else if (event === "answer") {
          flushStage();
          const a = parsed as Partial<AnswerData>;
          if (typeof a.verdict === "string") {
            const answer: AnswerData = {
              verdict: a.verdict,
              rows: Array.isArray(a.rows) ? a.rows : [],
              follows: Array.isArray(a.follows) ? a.follows : [],
              sources: Array.isArray(a.sources) ? a.sources : [],
              ...(a.askback && Array.isArray(a.askback.questions) && a.askback.questions.length > 0
                ? { askback: a.askback }
                : {}),
            };
            patchMessage(aid, m => ({ ...m, answer, steps: settleLedger(m.steps) }));
          }
        } else if (event === "text") {
          flushStage();
          const delta = (parsed as { delta?: string }).delta ?? "";
          patchMessage(aid, m => ({ ...m, content: m.content + delta, steps: settleLedger(m.steps) }));
        } else if (event === "proposal") {
          flushStage();
          const p = parsed as Omit<ProposalCard, "id" | "state"> & Record<string, unknown>;
          if (p.action && p.endpoint && p.method && p.payload && p.display && p.perm) {
            const card: ProposalCard = {
              id: newId(),
              action: String(p.action),
              endpoint: String(p.endpoint),
              method: p.method as "POST" | "PATCH",
              payload: p.payload as Record<string, unknown>,
              summary: String(p.summary ?? ""),
              display: p.display as ProposalCard["display"],
              perm: p.perm as ProposalCard["perm"],
              sig: typeof p.sig === "string" ? p.sig : null,
              iat: typeof p.iat === "number" ? p.iat : Date.now(),
              state: "pending",
            };
            patchMessage(aid, m => ({ ...m, proposals: [...(m.proposals ?? []), card] }));
          }
        } else if (event === "done") {
          flushStage();
          patchMessage(aid, m => ({ ...m, steps: settleLedger(m.steps), composing: false }));
          break;
        }
      }
    } catch (e) {
      flushStage();
      if ((e as { name?: string })?.name === "AbortError") {
        // Stopped by the user — keep whatever arrived, mark the turn stopped.
        patchMessage(aid, m => ({ ...m, stopped: true, steps: settleLedger(m.steps), composing: false }));
      } else {
        console.error("chat stream failed:", e);
        patchMessage(aid, m => ({ ...m, content: m.content || "(network error)", steps: settleLedger(m.steps), composing: false }));
      }
    } finally {
      flushStage();
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming, patchMessage, enqueueStage, flushStage]);

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Proposal approve / discard ─────────────────────────────────────────────

  function updateProposal(msgId: string, cardId: string, patch: Partial<ProposalCard>) {
    patchMessage(msgId, m => ({
      ...m,
      proposals: (m.proposals ?? []).map(p => (p.id === cardId ? { ...p, ...patch } : p)),
    }));
  }

  async function approveProposal(msgId: string, card: ProposalCard) {
    if (!card.perm.canApprove) return;
    updateProposal(msgId, card.id, { state: "confirming" });
    try {
      const res = await orgFetch(card.endpoint, {
        method: card.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(card.payload),
      });
      if (res.ok) {
        const stamp = `${timeStamp()} · ${actorName}`;
        updateProposal(msgId, card.id, { state: "approved", resultMessage: approvedText(card.display.kind), stamp });
        // Record the approval (fire-and-forget — the domain write already
        // happened; a missing audit row must not un-settle the card). The
        // server verifies the signed blob before writing anything.
        let subjectId: number | null = null;
        try {
          const body = await res.clone().json() as { id?: unknown };
          if (typeof body?.id === "number") subjectId = body.id;
        } catch { /* endpoint returned no JSON id — record without a link */ }
        if (card.sig) {
          void orgFetch("/api/ai/approvals", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: card.action,
              endpoint: card.endpoint,
              method: card.method,
              payload: card.payload,
              display: card.display,
              iat: card.iat,
              sig: card.sig,
              ...(subjectId !== null ? { subjectId } : {}),
            }),
          }).catch(() => { /* audit record is best-effort */ });
        }
      } else {
        const errBody = await res.json().catch(() => ({})) as { error?: string };
        const msg = res.status === 403
          ? "Your account can't approve this."
          : (errBody.error ?? `Failed (HTTP ${res.status}).`);
        updateProposal(msgId, card.id, { state: "error", resultMessage: msg, stamp: timeStamp() });
      }
    } catch (e) {
      updateProposal(msgId, card.id, { state: "error", resultMessage: e instanceof Error ? e.message : "Network error.", stamp: timeStamp() });
    }
  }

  function discardProposal(msgId: string, card: ProposalCard) {
    const blocked = !card.perm.canApprove;
    updateProposal(msgId, card.id, {
      state: blocked ? "dismissed" : "discarded",
      resultMessage: blocked ? "Dismissed — you can't approve this." : "Discarded — no changes made.",
      stamp: `${timeStamp()} · ${actorName}`,
    });
  }

  // ── Feedback ───────────────────────────────────────────────────────────────

  function giveFeedback(msg: ChatMessage, value: "up" | "down") {
    patchMessage(msg.id, { feedback: value });
    const idx = messagesRef.current.findIndex(m => m.id === msg.id);
    const question = idx > 0 ? messagesRef.current[idx - 1]?.content ?? "" : "";
    void orgFetch("/api/ai/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        helpful: value === "up",
        question: question.slice(0, 300),
        answerKind: msg.answer ? "structured" : "text",
      }),
    }).catch(() => { /* telemetry is best-effort */ });
  }

  // ── Keyboard: ↑↓ row selection, ⏎ approve / ⌫ discard the visible writ ─────

  const lastAnswer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.answer) return m;
    }
    return null;
  }, [messages]);

  const pendingWrit = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const card = m.proposals?.find(p => p.state === "pending");
      if (card) return { msgId: m.id, card };
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = document.activeElement === textareaRef.current;
      if (typing || scene !== "thread") return;
      const rows = lastAnswer?.answer?.rows ?? [];
      // Row navigation belongs to the thread; an open panel owns the keyboard.
      // The idea panel especially — it is a form, so Enter and the arrows must
      // reach its inputs rather than moving the selection in the thread behind.
      if (peek || idea) return;
      if (e.key === "ArrowDown" && rows.length > 0) {
        e.preventDefault();
        setSelRow(i => stepRow(rows, i, 1));
      } else if (e.key === "ArrowUp" && rows.length > 0) {
        e.preventDefault();
        setSelRow(i => stepRow(rows, i, -1));
      } else if (e.key === "Enter" && selRow >= 0 && rowAction(rows[selRow])) {
        // Dispatch through rowAction so Enter and the click handler can't drift
        // apart — the row's affordance already promised one of these three.
        e.preventDefault();
        const act = rowAction(rows[selRow]);
        if (act === "peek") openPeek(rows[selRow]);
        else if (act === "idea") openIdea(rows[selRow]);
        else if (act === "nav") navRow(rows[selRow]);
        else if (act === "ask") void sendMessage(rows[selRow].ask!);
      } else if (e.key === "Enter" && pendingWrit && pendingWrit.card.perm.canApprove) {
        e.preventDefault();
        void approveProposal(pendingWrit.msgId, pendingWrit.card);
      } else if (e.key === "Backspace" && pendingWrit) {
        e.preventDefault();
        discardProposal(pendingWrit.msgId, pendingWrit.card);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scene, peek, idea, lastAnswer, pendingWrit, selRow, sendMessage, openPeek, navRow, openIdea]);

  // ── Composer plumbing ──────────────────────────────────────────────────────

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (streaming) stopStreaming();
    else void sendMessage(input);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) void sendMessage(input);
    }
  }

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function handleNew() {
    if (streaming) stopStreaming();
    // Starting a new thread is the one legitimate way to an empty one, so it
    // clears the key itself — saveHistory deliberately won't write [] over a
    // stored thread (see there for why an empty save is always a mount artifact).
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    setMessages([]);
    setInput("");
    setSelRow(-1);
    setPeek(null);
    setIdea(null);
    setScene("briefing");
    textareaRef.current?.focus();
  }

  const isMac = useMemo(() => typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform), []);
  const shortcut = isMac ? "⌘K" : "Ctrl K";

  // Hide entirely when AI isn't enabled (no API key configured), and while the
  // enabled probe is in flight (avoids a flash of the launcher).
  if (enabled !== true) return null;

  const lastMsg = messages[messages.length - 1];

  return (
    <div className="chat-root" data-scene={open ? scene : "closed"}>
      {/* Launcher — visible only when the spotlight is closed */}
      {!open && (
        <button onClick={openSpotlight} aria-label="Ask Chapt" className={`chat-launcher${pulse ? " pulse" : ""}`}>
          <SparkleIcon className="spark" />
          <span>Ask Chapt</span>
          <kbd className="hint">{shortcut}</kbd>
        </button>
      )}

      {open && (
        <div className="cs-overlay" onClick={e => { if (e.target === e.currentTarget) closeSpotlight(); }}>
          <div className="cs-spot" role="dialog" aria-label="Ask Chapt">
            {/* Header bar */}
            <div className="cs-bar">
              <span className="tick" aria-hidden />
              <span className="title">Ask Chapt</span>
              <span className="spacer" />
              <button
                type="button"
                className="apprchip"
                onClick={() => {
                  setPeek(null);
                  setIdea(null);
                  setScene(s => (s === "approvals" ? (messages.length ? "thread" : "briefing") : "approvals"));
                }}
              >
                Approvals
              </button>
              {scene !== "briefing" && (
                <button type="button" className="newq" onClick={handleNew}>← New</button>
              )}
            </div>

            <div className="cs-body">
              {/* Briefing — a calm, centered invitation */}
              {scene === "briefing" && (
                <div className="cs-welcome">
                  <div className="wl">
                    <h2 className="in in-1">What do you want to <em>know?</em></h2>
                    <p className="in in-2">
                      Dues, attendance, events, the treasury — ask, and I&apos;ll read the chapter&apos;s records and answer.
                    </p>
                    <div className="starters in in-3">
                      {STARTERS.map(s => (
                        <button key={s.label} type="button" className="starter" onClick={() => void sendMessage(s.q)}>
                          <i>{s.icon}</i>{s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Thread */}
              {scene === "thread" && (
                <div className="cs-thread" aria-live="polite">
                  {messages.map(m => {
                    if (m.role === "user") {
                      return <div key={m.id} className="msg user send-in">{m.content}</div>;
                    }
                    const isLive = streaming && m === lastMsg;
                    const showLedgerLive = isLive && !m.answer && !m.content && (!m.proposals || m.proposals.length === 0);
                    return (
                      <div key={m.id} className="msg ai think-in">
                        <div className="who"><i />Ask Chapt</div>
                        {/* The deliberation lifts away first; the answer mounts
                            into the space it left, never on top of it. */}
                        <LedgerHandoff
                          showLedger={showLedgerLive}
                          ledger={
                            <ReasoningLedger
                              steps={m.steps ?? []}
                              intent={m.intent ?? "Consulting the records…"}
                              composing={m.composing}
                            />
                          }
                          body={
                            <>
                              {m.answer && (
                                <AnswerBlock
                                  answer={m.answer}
                                  steps={m.steps ?? []}
                                  selectedRow={m === lastAnswer ? selRow : -1}
                                  feedback={m.feedback}
                                  onAsk={q => void sendMessage(q)}
                                  onPeek={openPeek}
                                  onNav={navRow}
                                  onIdea={openIdea}
                                  onFeedback={v => giveFeedback(m, v)}
                                />
                              )}
                              {!m.answer && m.content && (
                                <>
                                  {(m.steps?.length ?? 0) > 0 && <TraceBlock steps={m.steps!} />}
                                  <MarkdownLite
                                    text={m.content}
                                    trailing={isLive ? <span className="cs-caret" aria-hidden /> : undefined}
                                  />
                                </>
                              )}
                              {!m.answer && !m.content && !isLive && (
                                <>
                                  {(m.steps?.length ?? 0) > 0 && <TraceBlock steps={m.steps!} />}
                                  {m.stopped && <div className="note"><em>Stopped.</em></div>}
                                </>
                              )}
                              {m.proposals?.map(card => (
                                <WritCard
                                  key={card.id}
                                  card={card}
                                  onApprove={c => void approveProposal(m.id, c)}
                                  onDiscard={c => discardProposal(m.id, c)}
                                />
                              ))}
                            </>
                          }
                        />
                      </div>
                    );
                  })}
                  <div ref={endRef} />
                </div>
              )}

              {/* Approvals — the approval record */}
              {scene === "approvals" && <ApprovalsView />}

              {/* The peek rides OVER the body: the thread it came from stays
                  mounted underneath, scroll position and all, so Back is a
                  return rather than a re-render of the conversation. */}
              {peek && (
                <PeekSheet
                  refr={peek.refr}
                  seed={peek.seed}
                  slug={currentUser?.org?.slug}
                  onBack={() => setPeek(null)}
                  onAsk={q => void sendMessage(q)}
                />
              )}

              {/* The idea panel rides over the body on the same terms as the
                  peek — the thread stays mounted, so Back is a return. */}
              {idea && (
                <EventIdeaPanel
                  seed={idea}
                  onBack={() => setIdea(null)}
                  onCreated={onIdeaCreated}
                />
              )}
            </div>

            {/* Dock / composer */}
            <div className="cs-dock">
              <form className="composer" onSubmit={handleSubmit}>
                <textarea
                  ref={textareaRef}
                  value={input}
                  rows={1}
                  placeholder={scene === "approvals" ? "Ask about an approval…" : scene === "briefing" ? "Ask the chapter anything…" : "Ask a follow-up…"}
                  onChange={e => { setInput(e.target.value); autosize(e.target); }}
                  onKeyDown={handleKeyDown}
                />
                <button
                  type="submit"
                  className={`send${streaming ? " stop" : ""}`}
                  disabled={!streaming && !input.trim()}
                  aria-label={streaming ? "Stop" : "Ask"}
                >
                  {streaming ? <IcStop /> : <IcSend />}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
