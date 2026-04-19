"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Search, Send, Phone, Tag, Calendar, RefreshCw, UserCheck, Bot, User,
  Pencil, Check, X, Paperclip, FileText, Image as ImageIcon, ChevronDown,
  MessageSquare, Clock, AlertCircle, CheckCheck, WifiOff
} from "lucide-react";
import type { InstanceSummary } from "@infracode/types";
import { requestClientApi } from "../../lib/client-api";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CrmContact {
  conversationId: string;
  contactId: string;
  jid?: string;           // JID original armazenado (pode ser @lid) — opcional por compatibilidade
  phoneNumber: string;
  displayName: string | null;
  isBlacklisted: boolean;
  conversationStatus: "OPEN" | "CLOSED";
  humanTakeover: boolean;
  lastMessageAt: string | null;
  tags: string[];
  leadStatus: string | null;
  serviceInterest: string | null;
  scheduledAt: string | null;
  notes: string | null;
}

interface CrmMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  text: string;
  mediaUrl?: string;
  fileName?: string;
  status: string;
  createdAt: string;
}

interface ContactMemory {
  name: string | null;
  serviceInterest: string | null;
  status: string | null;
  scheduledAt: string | null;
  notes: string | null;
}

interface ContactDetail {
  id: string;
  phoneNumber: string;
  displayName: string;
  isBlacklisted: boolean;
  notes: string | null;
  leadStatus: string | null;
  serviceInterest: string | null;
  scheduledAt: string | null;
  isExistingClient: boolean;
  memory?: ContactMemory | null;
}

interface ConversationDetail {
  id: string;
  status: "OPEN" | "CLOSED";
  humanTakeover: boolean;
  tags: string[];
  lastMessageAt: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Garante que o número enviado tem só dígitos, sem JID e com DDI 55 para números BR. */
const toPhone = (raw: string) => raw.replace(/@[^@]*$/, "").replace(/\D/g, "");

const isLidJid = (jid?: string) => jid?.endsWith("@lid") ?? false;

const normalizePhoneForSend = (raw: string): string => {
  const digits = toPhone(raw);
  // Números BR sem código de país: 10 ou 11 dígitos → adiciona 55
  if (!digits.startsWith("55") && (digits.length === 10 || digits.length === 11)) {
    return `55${digits}`;
  }
  return digits;
};

/** Formata número BR para exibição: "556892549342" → "(68) 9254-9342" */
const formatPhone = (raw: string): string => {
  const digits = toPhone(raw);
  const local = digits.startsWith("55") ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0,2)}) ${local.slice(2,7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0,2)}) ${local.slice(2,6)}-${local.slice(6)}`;
  if (digits.length > 13) return digits; // LID / número estranho — exibe cru
  return digits;
};

const formatTime = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

const formatDateTime = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

const LEAD_LABEL: Record<string, string> = {
  lead_frio: "Lead Frio", lead_quente: "Lead Quente", cliente_ativo: "Cliente",
  aguardando_retorno: "Aguardando", closed: "Fechado", client: "Cliente"
};
const LEAD_COLOR: Record<string, string> = {
  lead_frio: "bg-blue-500/15 text-blue-400",
  lead_quente: "bg-orange-500/15 text-orange-400",
  cliente_ativo: "bg-green-500/15 text-green-400",
  client: "bg-green-500/15 text-green-400",
  aguardando_retorno: "bg-yellow-500/15 text-yellow-400",
  closed: "bg-[var(--bg-hover)] text-[var(--text-tertiary)]"
};

const SUGGESTED_TAGS = ["follow_up", "vip", "urgente", "cliente_antigo", "sem_resposta", "proposta_enviada"];

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(",")[1] ?? "");
    r.onerror = rej;
    r.readAsDataURL(file);
  });

const mediaMsgType = (mime: string): "image" | "video" | "audio" | "document" => {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
};

// ─── Toast ───────────────────────────────────────────────────────────────────

function Toast({ msg, kind, onClose }: { msg: string; kind: "ok" | "err"; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-2.5 rounded-[var(--radius-md)] shadow-lg text-sm font-medium animate-fade-in
      ${kind === "ok" ? "bg-green-600 text-white" : "bg-red-600 text-white"}`}>
      {kind === "ok" ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
      {msg}
    </div>
  );
}

// ─── Contact Card ─────────────────────────────────────────────────────────────

function ContactCard({ c, selected, onClick }: { c: CrmContact; selected: boolean; onClick: () => void }) {
  const lid = isLidJid(c.jid);
  const name = c.displayName || (lid ? "Contato WhatsApp" : formatPhone(c.phoneNumber)) || "(sem nome)";
  const sub  = lid ? "ID WhatsApp" : formatPhone(c.phoneNumber);
  return (
    <button onClick={onClick} className={[
      "w-full text-left px-4 py-3 border-b border-[var(--border-subtle)] transition-colors cursor-pointer",
      selected ? "bg-[var(--bg-active)] border-l-[3px] border-l-[var(--accent-blue)] pl-[13px]" : "hover:bg-[var(--bg-hover)]"
    ].join(" ")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{name}</p>
          <p className="text-xs text-[var(--text-tertiary)] truncate">{sub}</p>
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          <span className="text-[10px] text-[var(--text-tertiary)] whitespace-nowrap">{formatTime(c.lastMessageAt)}</span>
          {c.humanTakeover && <span className="text-[10px] bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded-full">Humano</span>}
          {c.conversationStatus === "CLOSED" && <span className="text-[10px] bg-[var(--bg-hover)] text-[var(--text-tertiary)] px-1.5 py-0.5 rounded-full">Fechado</span>}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {c.leadStatus && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${LEAD_COLOR[c.leadStatus] ?? "bg-[var(--bg-hover)] text-[var(--text-tertiary)]"}`}>{LEAD_LABEL[c.leadStatus] ?? c.leadStatus}</span>}
        {c.serviceInterest && <span className="text-[10px] bg-[var(--bg-hover)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded-full truncate max-w-[130px]">{c.serviceInterest}</span>}
        {c.tags.slice(0, 2).map(t => <span key={t} className="text-[10px] bg-[var(--bg-hover)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded-full">{t}</span>)}
      </div>
    </button>
  );
}

// ─── Message Bubble ───────────────────────────────────────────────────────────

function MsgStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "QUEUED":
    case "SCHEDULED":
      return <Clock className="h-2.5 w-2.5 opacity-50" />;
    case "SENT":
      return <Check className="h-2.5 w-2.5 opacity-70" />;
    case "DELIVERED":
      return <CheckCheck className="h-2.5 w-2.5 opacity-70" />;
    case "READ":
      return <CheckCheck className="h-2.5 w-2.5 text-sky-300" />;
    case "FAILED":
      return <AlertCircle className="h-2.5 w-2.5 text-red-300" />;
    default:
      return null;
  }
}

function Bubble({ msg }: { msg: CrmMessage }) {
  const out = msg.direction === "OUTBOUND";
  const failed = out && msg.status === "FAILED";
  const hasText = !!msg.text;
  const isMedia = ["image","video","audio","document"].includes(msg.type) && !hasText;

  return (
    <div className={`flex items-end gap-1.5 mb-2 ${out ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`h-5 w-5 rounded-full flex-shrink-0 flex items-center justify-center ${out ? "bg-[var(--accent-blue)]/20" : "bg-[var(--bg-hover)]"}`}>
        {out ? <Bot className="h-3 w-3 text-[var(--accent-blue)]" /> : <User className="h-3 w-3 text-[var(--text-tertiary)]" />}
      </div>
      <div className={[
        "max-w-[72%] px-3 py-2 rounded-2xl text-sm break-words",
        out
          ? failed
            ? "bg-red-700/80 text-white rounded-br-sm"
            : "bg-[var(--accent-blue)] text-white rounded-br-sm"
          : "bg-[var(--bg-secondary)] text-[var(--text-primary)] rounded-bl-sm border border-[var(--border-subtle)]"
      ].join(" ")}>
        {isMedia && msg.type === "image" && msg.mediaUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={msg.mediaUrl} alt="imagem" className="rounded-lg max-w-full mb-1 max-h-48 object-contain" />
        )}
        {isMedia && msg.type !== "image" && (
          <div className="flex items-center gap-2">
            {msg.type === "document" ? <FileText className="h-4 w-4 opacity-70" /> : <ImageIcon className="h-4 w-4 opacity-70" />}
            <span className="text-xs opacity-80">{msg.fileName ?? msg.type}</span>
          </div>
        )}
        {hasText && <p className="whitespace-pre-wrap">{msg.text}</p>}
        {!hasText && !isMedia && <p className="italic opacity-60 text-xs">[{msg.type}]</p>}
        {failed && <p className="text-[10px] text-red-200 mt-0.5">Falha no envio</p>}
        <p className={`text-[10px] mt-0.5 flex items-center gap-0.5 ${out ? "text-white/60 justify-end" : "text-[var(--text-tertiary)]"}`}>
          {formatTime(msg.createdAt)}
          {out && <MsgStatusIcon status={msg.status} />}
        </p>
      </div>
    </div>
  );
}

// ─── Tag Manager ──────────────────────────────────────────────────────────────

function TagManager({ tags, onSave }: { tags: string[]; onSave: (tags: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const current = new Set(tags);

  const toggle = (t: string) => {
    const next = current.has(t) ? tags.filter(x => x !== t) : [...tags, t];
    onSave(next);
  };
  const addCustom = () => {
    const t = custom.trim().toLowerCase().replace(/\s+/g, "_");
    if (t && !current.has(t)) { onSave([...tags, t]); }
    setCustom(""); setOpen(false);
  };

  return (
    <div className="relative">
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer">
        <Tag className="h-3 w-3" /> Tags <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute top-6 left-0 z-20 w-56 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-lg p-2">
          <div className="flex flex-wrap gap-1 mb-2">
            {SUGGESTED_TAGS.map(t => (
              <button key={t} onClick={() => toggle(t)}
                className={`text-[10px] px-2 py-0.5 rounded-full border cursor-pointer transition-colors
                  ${current.has(t) ? "bg-[var(--accent-blue)] text-white border-[var(--accent-blue)]" : "border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-blue)]"}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            <input value={custom} onChange={e => setCustom(e.target.value)}
              onKeyDown={e => e.key === "Enter" && addCustom()}
              placeholder="tag personalizada..."
              className="flex-1 h-7 px-2 text-xs rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]" />
            <button onClick={addCustom} className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent-blue)] text-white cursor-pointer hover:opacity-90">
              <Check className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function CrmScreen({ initialInstances }: { initialInstances: InstanceSummary[] }) {
  const [instanceId, setInstanceId] = useState(initialInstances[0]?.id ?? "");
  const [instanceStatuses, setInstanceStatuses] = useState<Record<string, string>>(
    () => Object.fromEntries(initialInstances.map(i => [i.id, i.status]))
  );

  // contacts
  const [contacts, setContacts]           = useState<CrmContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [search, setSearch]               = useState("");
  const [statusFilter, setStatusFilter]   = useState<"all" | "OPEN" | "CLOSED">("all");

  // conversation
  const [selected, setSelected]           = useState<CrmContact | null>(null);
  const [detail, setDetail]               = useState<ContactDetail | null>(null);
  const [conv, setConv]                   = useState<ConversationDetail | null>(null);
  const [messages, setMessages]           = useState<CrmMessage[]>([]);
  const [loadingMsgs, setLoadingMsgs]     = useState(false);

  // editing name
  const [editingName, setEditingName]     = useState(false);
  const [nameInput, setNameInput]         = useState("");

  // editing notes
  const [editingNotes, setEditingNotes]   = useState(false);
  const [notesInput, setNotesInput]       = useState("");

  // send
  const [input, setInput]                 = useState("");
  const [sending, setSending]             = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);

  // toast
  const [toast, setToast]                 = useState<{ msg: string; kind: "ok" | "err" } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRef        = useRef<HTMLInputElement>(null);

  const showToast = (msg: string, kind: "ok" | "err" = "ok") => setToast({ msg, kind });

  // ── Poll instance statuses every 30s ─────────────────────────────────────
  useEffect(() => {
    const refresh = async () => {
      try {
        const list = await requestClientApi<InstanceSummary[]>("/instances");
        setInstanceStatuses(Object.fromEntries(list.map(i => [i.id, i.status])));
      } catch { /* ignore */ }
    };
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── Load contacts ──────────────────────────────────────────────────────────

  const loadContacts = useCallback(async (q: string, st: string, iid: string) => {
    if (!iid) return;
    setLoadingContacts(true);
    try {
      const p = new URLSearchParams({ pageSize: "50", status: st });
      if (q) p.set("search", q);
      const res = await requestClientApi<{ contacts: CrmContact[] }>(`/instances/${iid}/crm/contacts?${p}`);
      setContacts(res.contacts);
    } catch { /* silent */ } finally { setLoadingContacts(false); }
  }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void loadContacts(search, statusFilter, instanceId), 300);
  }, [search, statusFilter, instanceId, loadContacts]);

  // ── Load messages ──────────────────────────────────────────────────────────

  const loadMessages = useCallback(async (contactId: string, iid: string, silent = false) => {
    if (!silent) setLoadingMsgs(true);
    try {
      const res = await requestClientApi<{ contact: ContactDetail; conversation: ConversationDetail | null; messages: CrmMessage[] }>(
        `/instances/${iid}/crm/contacts/${contactId}/messages`
      );
      setDetail(res.contact);
      setConv(res.conversation);
      setMessages(res.messages);
    } catch { /* silent */ } finally { if (!silent) setLoadingMsgs(false); }
  }, []);

  useEffect(() => {
    if (!selected) return;
    void loadMessages(selected.contactId, instanceId);
  }, [selected, instanceId, loadMessages]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Poll every 5s
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!selected) return;
    pollRef.current = setInterval(() => void loadMessages(selected.contactId, instanceId, true), 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [selected, instanceId, loadMessages]);

  // ── Send text ─────────────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !selected || sending) return;
    setSending(true);
    try {
      await requestClientApi(`/instances/${instanceId}/messages/send`, {
        method: "POST",
        body: {
          type: "text",
          to: normalizePhoneForSend(selected.phoneNumber),
          ...(selected.jid ? { targetJid: selected.jid } : {}),
          text
        }
      });
      setInput("");
      await loadMessages(selected.contactId, instanceId, true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Falha ao enviar.", "err");
    } finally { setSending(false); }
  };

  // ── Send file ──────────────────────────────────────────────────────────────

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selected) return;
    e.target.value = "";
    setUploadingFile(true);
    try {
      const base64 = await fileToBase64(file);
      const type   = mediaMsgType(file.type);
      await requestClientApi(`/instances/${instanceId}/messages/send`, {
        method: "POST",
        body: {
          type,
          to: normalizePhoneForSend(selected.phoneNumber),
          ...(selected.jid ? { targetJid: selected.jid } : {}),
          media: { mimeType: file.type, fileName: file.name, base64 }
        }
      });
      showToast("Arquivo enviado!");
      await loadMessages(selected.contactId, instanceId, true);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Falha ao enviar arquivo.", "err");
    } finally { setUploadingFile(false); }
  };

  // ── Rename contact ────────────────────────────────────────────────────────

  const startRename = () => { setNameInput(detail?.displayName ?? ""); setEditingName(true); };
  const saveName = async () => {
    if (!selected || !detail) return;
    const name = nameInput.trim();
    if (!name) { setEditingName(false); return; }
    try {
      await requestClientApi(`/instances/${instanceId}/crm/contacts/${selected.contactId}`, {
        method: "PATCH", body: { displayName: name }
      });
      setDetail(d => d ? { ...d, displayName: name } : d);
      setContacts(cs => cs.map(c => c.contactId === selected.contactId ? { ...c, displayName: name } : c));
      showToast("Nome atualizado!");
    } catch { showToast("Falha ao salvar.", "err"); }
    setEditingName(false);
  };

  // ── Save notes ────────────────────────────────────────────────────────────

  const saveNotes = async () => {
    if (!selected) return;
    try {
      await requestClientApi(`/instances/${instanceId}/crm/contacts/${selected.contactId}`, {
        method: "PATCH", body: { notes: notesInput.trim() || null }
      });
      setDetail(d => d ? { ...d, notes: notesInput.trim() || null } : d);
      showToast("Anotação salva!");
    } catch { showToast("Falha ao salvar.", "err"); }
    setEditingNotes(false);
  };

  // ── Save tags ──────────────────────────────────────────────────────────────

  const saveTags = async (tags: string[]) => {
    if (!conv) return;
    try {
      const updated = await requestClientApi<ConversationDetail>(
        `/instances/${instanceId}/crm/conversations/${conv.id}`,
        { method: "PATCH", body: { tags } }
      );
      setConv(updated);
      setContacts(cs => cs.map(c => c.conversationId === conv.id ? { ...c, tags } : c));
    } catch { showToast("Falha ao salvar tags.", "err"); }
  };

  // ── Toggle human takeover ─────────────────────────────────────────────────

  const toggleHumanTakeover = async () => {
    if (!conv) return;
    const next = !conv.humanTakeover;
    try {
      const updated = await requestClientApi<ConversationDetail>(
        `/instances/${instanceId}/crm/conversations/${conv.id}`,
        { method: "PATCH", body: { humanTakeover: next } }
      );
      setConv(updated);
      setContacts(cs => cs.map(c => c.conversationId === conv.id ? { ...c, humanTakeover: next } : c));
      showToast(next ? "Bot pausado — você assume o atendimento." : "Bot reativado.");
    } catch { showToast("Falha.", "err"); }
  };

  // ── Toggle conversation status ─────────────────────────────────────────────

  const toggleStatus = async () => {
    if (!conv) return;
    const next = conv.status === "OPEN" ? "CLOSED" : "OPEN";
    try {
      const updated = await requestClientApi<ConversationDetail>(
        `/instances/${instanceId}/crm/conversations/${conv.id}`,
        { method: "PATCH", body: { status: next } }
      );
      setConv(updated);
      setContacts(cs => cs.map(c => c.conversationId === conv.id ? { ...c, conversationStatus: next } : c));
      showToast(next === "CLOSED" ? "Conversa encerrada." : "Conversa reaberta.");
    } catch { showToast("Falha.", "err"); }
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-88px)]">
      {toast && <Toast msg={toast.msg} kind={toast.kind} onClose={() => setToast(null)} />}

      {/* Instance selector + status */}
      <div className="flex-shrink-0 flex items-center gap-3">
        {initialInstances.length > 1 && (
          <select value={instanceId} onChange={e => { setInstanceId(e.target.value); setSelected(null); }}
            className="h-9 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]">
            {initialInstances.map(inst => <option key={inst.id} value={inst.id}>{inst.name}</option>)}
          </select>
        )}
        {instanceId && (() => {
          const st = instanceStatuses[instanceId];
          if (st === "CONNECTED") return (
            <span className="flex items-center gap-1 text-xs text-green-400">
              <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />Conectado
            </span>
          );
          if (st === "QR_PENDING" || st === "INITIALIZING") return (
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <span className="h-2 w-2 rounded-full bg-yellow-400" />{st === "QR_PENDING" ? "Aguardando QR" : "Iniciando"}
            </span>
          );
          return (
            <span className="flex items-center gap-1 text-xs text-red-400">
              <WifiOff className="h-3 w-3" />{st === "PAUSED" ? "Pausada" : st === "BANNED" ? "Banida" : "Desconectada"} — envios podem falhar
            </span>
          );
        })()}
      </div>

      <div className="flex-1 min-h-0 flex rounded-[var(--radius-lg)] border border-[var(--border-subtle)] overflow-hidden">

        {/* ── Left: contacts ─────────────────────────────────────────────── */}
        <div className="w-[280px] flex-shrink-0 flex flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          <div className="flex-shrink-0 p-3 border-b border-[var(--border-subtle)] space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
              <input type="text" placeholder="Buscar..." value={search} onChange={e => setSearch(e.target.value)}
                className="w-full h-8 pl-8 pr-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]" />
            </div>
            <div className="flex gap-1">
              {(["all","OPEN","CLOSED"] as const).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`flex-1 text-[10px] py-1 rounded-[var(--radius-md)] font-medium transition-colors cursor-pointer
                    ${statusFilter === s ? "bg-[var(--accent-blue)] text-white" : "bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                  {s === "all" ? "Todos" : s === "OPEN" ? "Abertos" : "Fechados"}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingContacts && contacts.length === 0
              ? <p className="p-4 text-center text-xs text-[var(--text-tertiary)]">Carregando...</p>
              : contacts.length === 0
              ? <p className="p-4 text-center text-xs text-[var(--text-tertiary)]">Nenhum contato.</p>
              : contacts.map(c => (
                  <ContactCard key={c.contactId} c={c} selected={selected?.contactId === c.contactId}
                    onClick={() => { setSelected(c); setEditingName(false); setEditingNotes(false); }} />
                ))}
          </div>
        </div>

        {/* ── Right: conversation ────────────────────────────────────────── */}
        {!selected ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--text-tertiary)]">
            <MessageSquare className="h-10 w-10 opacity-20" />
            <p className="text-sm">Selecione um contato para abrir a conversa</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-w-0">

            {/* Header */}
            <div className="flex-shrink-0 px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <div className="flex items-center justify-between gap-3">
                {/* Name */}
                <div className="flex items-center gap-2 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-1">
                      <input autoFocus value={nameInput} onChange={e => setNameInput(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") void saveName(); if (e.key === "Escape") setEditingName(false); }}
                        className="h-7 px-2 text-sm rounded-[var(--radius-md)] border border-[var(--accent-blue)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none w-48" />
                      <button onClick={() => void saveName()} className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent-blue)] text-white cursor-pointer hover:opacity-90"><Check className="h-3.5 w-3.5" /></button>
                      <button onClick={() => setEditingName(false)} className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] hover:bg-[var(--bg-hover)] text-[var(--text-tertiary)] cursor-pointer"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-sm font-semibold text-[var(--text-primary)] truncate">{detail?.displayName ?? selected.displayName}</p>
                      <button onClick={startRename} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] cursor-pointer flex-shrink-0"><Pencil className="h-3 w-3" /></button>
                      {detail?.isExistingClient && <span className="text-[10px] bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded-full flex-shrink-0">Cliente</span>}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {conv && (
                    <>
                      <button onClick={() => void toggleHumanTakeover()}
                        className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-colors
                          ${conv.humanTakeover ? "bg-purple-500/20 text-purple-400 hover:bg-purple-500/30" : "bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                        <UserCheck className="h-3 w-3" />
                        {conv.humanTakeover ? "Pausar bot" : "Assumir"}
                      </button>
                      <button onClick={() => void toggleStatus()}
                        className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-colors
                          ${conv.status === "OPEN" ? "bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" : "bg-green-500/15 text-green-400 hover:bg-green-500/25"}`}>
                        {conv.status === "OPEN" ? "Encerrar" : "Reabrir"}
                      </button>
                    </>
                  )}
                  <button onClick={() => void loadMessages(selected.contactId, instanceId)}
                    className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] cursor-pointer">
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingMsgs ? "animate-spin" : ""}`} />
                  </button>
                </div>
              </div>

              {/* Sub-header: phone, interest, schedule, tags */}
              <div className="mt-1.5 flex flex-wrap items-center gap-3">
                <span className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                  <Phone className="h-3 w-3" />
                  {isLidJid(selected.jid ?? "") ? "ID WhatsApp" : formatPhone(selected.phoneNumber)}
                </span>
                {detail?.serviceInterest && (
                  <span className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                    <Tag className="h-3 w-3" />{detail.serviceInterest}
                  </span>
                )}
                {detail?.scheduledAt && (
                  <span className="flex items-center gap-1 text-[11px] text-amber-400">
                    <Calendar className="h-3 w-3" />{formatDateTime(detail.scheduledAt)}
                  </span>
                )}
                {detail?.leadStatus && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${LEAD_COLOR[detail.leadStatus] ?? ""}`}>
                    {LEAD_LABEL[detail.leadStatus] ?? detail.leadStatus}
                  </span>
                )}
                {/* Tag manager */}
                {conv && <TagManager tags={conv.tags} onSave={tags => void saveTags(tags)} />}
                {/* Current tags */}
                {conv && conv.tags.map(t => (
                  <span key={t} className="flex items-center gap-0.5 text-[10px] bg-[var(--bg-hover)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded-full">
                    {t}
                    <button onClick={() => void saveTags(conv.tags.filter(x => x !== t))} className="cursor-pointer hover:text-red-400 ml-0.5"><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>

              {/* AI-captured client data — read-only display */}
              {(detail?.memory?.name || detail?.memory?.serviceInterest || detail?.memory?.status || detail?.memory?.scheduledAt || detail?.leadStatus || detail?.serviceInterest || detail?.scheduledAt) ? (
                <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                  <p className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wide mb-1.5">
                    Dados capturados
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {detail?.memory?.name && (
                      <div>
                        <span className="text-[10px] text-[var(--text-tertiary)]">Nome</span>
                        <p className="text-xs text-[var(--text-primary)]">{detail.memory.name}</p>
                      </div>
                    )}
                    {(detail?.memory?.serviceInterest ?? detail?.serviceInterest) && (
                      <div>
                        <span className="text-[10px] text-[var(--text-tertiary)]">Interesse</span>
                        <p className="text-xs text-[var(--text-primary)]">{detail.memory?.serviceInterest ?? detail.serviceInterest}</p>
                      </div>
                    )}
                    {(detail?.memory?.status ?? detail?.leadStatus) && (
                      <div>
                        <span className="text-[10px] text-[var(--text-tertiary)]">Status</span>
                        <p className="text-xs text-[var(--text-primary)]">
                          {(() => { const s = detail.memory?.status ?? detail.leadStatus ?? ""; return LEAD_LABEL[s] ?? s; })()}
                        </p>
                      </div>
                    )}
                    {(detail?.memory?.scheduledAt ?? detail?.scheduledAt) && (
                      <div>
                        <span className="text-[10px] text-[var(--text-tertiary)]">Agendamento</span>
                        <p className="text-xs text-[var(--text-primary)]">
                          {new Date((detail.memory?.scheduledAt ?? detail.scheduledAt)!).toLocaleString("pt-BR")}
                        </p>
                      </div>
                    )}
                    {detail?.memory?.notes && (
                      <div>
                        <span className="text-[10px] text-[var(--text-tertiary)]">Observações</span>
                        <p className="text-xs text-[var(--text-primary)]">{detail.memory.notes}</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-xs text-[var(--text-tertiary)] italic">
                  Nenhum dado capturado ainda
                </p>
              )}

              {/* Notes */}
              <div className="mt-1.5">
                {editingNotes ? (
                  <div className="flex gap-1">
                    <textarea rows={2} autoFocus value={notesInput} onChange={e => setNotesInput(e.target.value)}
                      placeholder="Anotação sobre este contato..."
                      className="flex-1 resize-none text-xs px-2 py-1 rounded-[var(--radius-md)] border border-[var(--accent-blue)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] focus:outline-none" />
                    <div className="flex flex-col gap-1">
                      <button onClick={() => void saveNotes()} className="h-6 px-2 text-[10px] rounded-[var(--radius-md)] bg-[var(--accent-blue)] text-white cursor-pointer">Salvar</button>
                      <button onClick={() => setEditingNotes(false)} className="h-6 px-2 text-[10px] rounded-[var(--radius-md)] bg-[var(--bg-hover)] text-[var(--text-secondary)] cursor-pointer">Cancelar</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setNotesInput(detail?.notes ?? ""); setEditingNotes(true); }}
                    className="text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] flex items-center gap-1 cursor-pointer">
                    <Clock className="h-3 w-3" />
                    {detail?.notes ? <span className="truncate max-w-[300px]">{detail.notes}</span> : "Adicionar anotação..."}
                  </button>
                )}
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {loadingMsgs && messages.length === 0
                ? <p className="text-center text-xs text-[var(--text-tertiary)] pt-10">Carregando mensagens...</p>
                : messages.length === 0
                ? <p className="text-center text-xs text-[var(--text-tertiary)] pt-10">Nenhuma mensagem encontrada.</p>
                : messages.map(m => <Bubble key={m.id} msg={m} />)}
              <div ref={messagesEndRef} />
            </div>

            {/* Send area */}
            <div className="flex-shrink-0 p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              <input ref={fileRef} type="file" className="hidden"
                accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.zip"
                onChange={e => void handleFile(e)} />
              <div className="flex gap-2 items-end">
                <button onClick={() => fileRef.current?.click()} disabled={uploadingFile}
                  title="Enviar arquivo ou imagem"
                  className="h-[58px] w-9 flex-shrink-0 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer">
                  {uploadingFile ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                </button>
                <textarea value={input} onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
                  placeholder="Digite uma mensagem... (Enter envia · Shift+Enter = nova linha)"
                  rows={2}
                  className="flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]" />
                <button onClick={() => void handleSend()} disabled={!input.trim() || sending}
                  className={`h-[58px] w-10 flex-shrink-0 flex items-center justify-center rounded-[var(--radius-md)] transition-colors cursor-pointer
                    ${input.trim() && !sending ? "bg-[var(--accent-blue)] text-white hover:opacity-90" : "bg-[var(--bg-hover)] text-[var(--text-tertiary)] cursor-not-allowed"}`}>
                  {sending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
