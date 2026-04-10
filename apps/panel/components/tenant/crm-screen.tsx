"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Send, Phone, Tag, Calendar, RefreshCw, UserCheck, Bot, User } from "lucide-react";
import type { InstanceSummary } from "@infracode/types";
import { requestClientApi } from "../../lib/client-api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrmContact {
  conversationId: string;
  contactId: string;
  phoneNumber: string;
  displayName: string;
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
  status: string;
  createdAt: string;
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatTime = (iso: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};

const formatDateTime = (iso: string | null): string => {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const leadStatusLabel: Record<string, string> = {
  lead_frio: "Lead Frio",
  lead_quente: "Lead Quente",
  cliente_ativo: "Cliente Ativo",
  aguardando_retorno: "Aguardando",
  closed: "Fechado",
  client: "Cliente"
};

const leadStatusColor: Record<string, string> = {
  lead_frio: "bg-blue-500/15 text-blue-400",
  lead_quente: "bg-orange-500/15 text-orange-400",
  cliente_ativo: "bg-green-500/15 text-green-400",
  aguardando_retorno: "bg-yellow-500/15 text-yellow-400",
  closed: "bg-[var(--bg-hover)] text-[var(--text-tertiary)]",
  client: "bg-green-500/15 text-green-400"
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ContactCard({
  contact,
  selected,
  onClick
}: {
  contact: CrmContact;
  selected: boolean;
  onClick: () => void;
}) {
  const statusColor = contact.leadStatus ? (leadStatusColor[contact.leadStatus] ?? "bg-[var(--bg-hover)] text-[var(--text-tertiary)]") : "";

  return (
    <button
      onClick={onClick}
      className={[
        "w-full text-left px-4 py-3 border-b border-[var(--border-subtle)] transition-colors cursor-pointer",
        selected
          ? "bg-[var(--bg-active)] border-l-2 border-l-[var(--accent-blue)]"
          : "hover:bg-[var(--bg-hover)]"
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--text-primary)] truncate">{contact.displayName}</p>
          <p className="text-xs text-[var(--text-tertiary)] truncate">{contact.phoneNumber}</p>
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-1">
          <span className="text-[10px] text-[var(--text-tertiary)]">{formatTime(contact.lastMessageAt)}</span>
          {contact.humanTakeover && (
            <span className="text-[10px] bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded-full">Humano</span>
          )}
        </div>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {contact.leadStatus && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusColor}`}>
            {leadStatusLabel[contact.leadStatus] ?? contact.leadStatus}
          </span>
        )}
        {contact.serviceInterest && (
          <span className="text-[10px] bg-[var(--bg-hover)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded-full truncate max-w-[120px]">
            {contact.serviceInterest}
          </span>
        )}
      </div>
    </button>
  );
}

function MessageBubble({ msg }: { msg: CrmMessage }) {
  const isOut = msg.direction === "OUTBOUND";
  if (!msg.text && msg.type !== "text") {
    return (
      <div className={`flex ${isOut ? "justify-end" : "justify-start"} mb-1`}>
        <div className={`max-w-[75%] px-3 py-2 rounded-2xl text-xs italic text-[var(--text-tertiary)] bg-[var(--bg-hover)]`}>
          [{msg.type}]
        </div>
      </div>
    );
  }
  return (
    <div className={`flex items-end gap-1.5 mb-1 ${isOut ? "flex-row-reverse" : "flex-row"}`}>
      <div className={`h-5 w-5 rounded-full flex-shrink-0 flex items-center justify-center ${isOut ? "bg-[var(--accent-blue)]/20" : "bg-[var(--bg-hover)]"}`}>
        {isOut
          ? <Bot className="h-3 w-3 text-[var(--accent-blue)]" />
          : <User className="h-3 w-3 text-[var(--text-tertiary)]" />}
      </div>
      <div
        className={[
          "max-w-[75%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words",
          isOut
            ? "bg-[var(--accent-blue)] text-white rounded-br-sm"
            : "bg-[var(--bg-secondary)] text-[var(--text-primary)] rounded-bl-sm border border-[var(--border-subtle)]"
        ].join(" ")}
      >
        <p>{msg.text}</p>
        <p className={`text-[10px] mt-0.5 ${isOut ? "text-white/60 text-right" : "text-[var(--text-tertiary)]"}`}>
          {formatTime(msg.createdAt)}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function CrmScreen({ initialInstances }: { initialInstances: InstanceSummary[] }) {
  const [instanceId, setInstanceId] = useState(initialInstances[0]?.id ?? "");
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "OPEN" | "CLOSED">("all");

  const [selectedContact, setSelectedContact] = useState<CrmContact | null>(null);
  const [contactDetail, setContactDetail] = useState<ContactDetail | null>(null);
  const [messages, setMessages] = useState<CrmMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Load contacts
  // ---------------------------------------------------------------------------

  const loadContacts = useCallback(async (q: string, status: string, iid: string) => {
    if (!iid) return;
    setLoadingContacts(true);
    try {
      const params = new URLSearchParams({ pageSize: "50", status });
      if (q) params.set("search", q);
      const res = await requestClientApi<{ contacts: CrmContact[] }>(
        `/instances/${iid}/crm/contacts?${params.toString()}`
      );
      setContacts(res.contacts);
    } catch {
      // silently ignore
    } finally {
      setLoadingContacts(false);
    }
  }, []);

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      void loadContacts(search, statusFilter, instanceId);
    }, 300);
  }, [search, statusFilter, instanceId, loadContacts]);

  // ---------------------------------------------------------------------------
  // Load messages for selected contact
  // ---------------------------------------------------------------------------

  const loadMessages = useCallback(async (contactId: string, iid: string) => {
    setLoadingMessages(true);
    try {
      const res = await requestClientApi<{ contact: ContactDetail; messages: CrmMessage[] }>(
        `/instances/${iid}/crm/contacts/${contactId}/messages`
      );
      setContactDetail(res.contact);
      setMessages(res.messages);
    } catch {
      // silently ignore
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedContact) return;
    void loadMessages(selectedContact.contactId, instanceId);
  }, [selectedContact, instanceId, loadMessages]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Polling: atualiza mensagens a cada 5s enquanto um contato está selecionado
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!selectedContact) return;
    pollRef.current = setInterval(() => {
      void loadMessages(selectedContact.contactId, instanceId);
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [selectedContact, instanceId, loadMessages]);

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  const handleSend = async () => {
    const text = input.trim();
    if (!text || !selectedContact || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await requestClientApi(`/instances/${instanceId}/messages/send`, {
        method: "POST",
        body: { type: "text", to: selectedContact.phoneNumber, text }
      });
      setInput("");
      // Recarrega mensagens após envio
      await loadMessages(selectedContact.contactId, instanceId);
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Falha ao enviar.");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-88px)]">
      {/* Instance selector */}
      {initialInstances.length > 1 && (
        <div className="flex-shrink-0">
          <select
            value={instanceId}
            onChange={(e) => { setInstanceId(e.target.value); setSelectedContact(null); }}
            className="h-9 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent-blue)]"
          >
            {initialInstances.map((inst) => (
              <option key={inst.id} value={inst.id}>{inst.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Main CRM layout */}
      <div className="flex-1 min-h-0 flex rounded-[var(--radius-lg)] border border-[var(--border-subtle)] overflow-hidden">

        {/* ---- Left: contact list ---- */}
        <div className="w-72 flex-shrink-0 flex flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
          {/* Search */}
          <div className="flex-shrink-0 p-3 border-b border-[var(--border-subtle)]">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-tertiary)]" />
              <input
                type="text"
                placeholder="Buscar por nome ou número..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full h-8 pl-8 pr-3 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]"
              />
            </div>
            {/* Status filter */}
            <div className="flex gap-1 mt-2">
              {(["all", "OPEN", "CLOSED"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={[
                    "flex-1 text-[10px] py-1 rounded-[var(--radius-md)] font-medium transition-colors cursor-pointer",
                    statusFilter === s
                      ? "bg-[var(--accent-blue)] text-white"
                      : "bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  ].join(" ")}
                >
                  {s === "all" ? "Todos" : s === "OPEN" ? "Abertos" : "Fechados"}
                </button>
              ))}
            </div>
          </div>

          {/* Contacts */}
          <div className="flex-1 overflow-y-auto">
            {loadingContacts && contacts.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--text-tertiary)]">Carregando...</div>
            ) : contacts.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--text-tertiary)]">Nenhum contato encontrado.</div>
            ) : (
              contacts.map((c) => (
                <ContactCard
                  key={c.contactId}
                  contact={c}
                  selected={selectedContact?.contactId === c.contactId}
                  onClick={() => setSelectedContact(c)}
                />
              ))
            )}
          </div>
        </div>

        {/* ---- Right: conversation ---- */}
        {!selectedContact ? (
          <div className="flex-1 flex items-center justify-center text-[var(--text-tertiary)] text-sm">
            Selecione um contato para ver a conversa
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-w-0">

            {/* Header */}
            <div className="flex-shrink-0 px-5 py-3 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                    {contactDetail?.displayName ?? selectedContact.displayName}
                  </p>
                  {contactDetail?.isExistingClient && (
                    <span className="text-[10px] bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded-full flex-shrink-0">Cliente</span>
                  )}
                  {selectedContact.humanTakeover && (
                    <span className="text-[10px] bg-purple-500/15 text-purple-400 px-1.5 py-0.5 rounded-full flex-shrink-0 flex items-center gap-1">
                      <UserCheck className="h-2.5 w-2.5" /> Humano
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  <span className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                    <Phone className="h-3 w-3" />
                    {selectedContact.phoneNumber}
                  </span>
                  {contactDetail?.serviceInterest && (
                    <span className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                      <Tag className="h-3 w-3" />
                      {contactDetail.serviceInterest}
                    </span>
                  )}
                  {contactDetail?.scheduledAt && (
                    <span className="flex items-center gap-1 text-[11px] text-amber-400">
                      <Calendar className="h-3 w-3" />
                      {formatDateTime(contactDetail.scheduledAt)}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => void loadMessages(selectedContact.contactId, instanceId)}
                className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                title="Atualizar"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingMessages ? "animate-spin" : ""}`} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-0.5">
              {loadingMessages && messages.length === 0 ? (
                <div className="text-center text-xs text-[var(--text-tertiary)] pt-8">Carregando mensagens...</div>
              ) : messages.length === 0 ? (
                <div className="text-center text-xs text-[var(--text-tertiary)] pt-8">Nenhuma mensagem encontrada.</div>
              ) : (
                messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Send input */}
            <div className="flex-shrink-0 p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
              {sendError && (
                <p className="text-xs text-red-400 mb-1.5">{sendError}</p>
              )}
              <div className="flex gap-2 items-end">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Digite uma mensagem... (Enter para enviar, Shift+Enter para nova linha)"
                  rows={2}
                  className="flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent-blue)]"
                />
                <button
                  onClick={() => void handleSend()}
                  disabled={!input.trim() || sending}
                  className={[
                    "h-[58px] w-10 flex-shrink-0 flex items-center justify-center rounded-[var(--radius-md)] transition-colors cursor-pointer",
                    input.trim() && !sending
                      ? "bg-[var(--accent-blue)] text-white hover:opacity-90"
                      : "bg-[var(--bg-hover)] text-[var(--text-tertiary)] cursor-not-allowed"
                  ].join(" ")}
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
