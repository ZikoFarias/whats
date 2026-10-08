"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Copy, RefreshCw, Send, UserPlus, Shield, ShieldOff, UserMinus, Check, X, LogOut, Link2 } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, phoneLabel, roleLabel, splitList, type GroupRow, type MemberRow } from "./api";

type Detail = GroupRow & { counts: { active: number; admins: number }; members: MemberRow[]; inviteCode: string | null };
interface Analytics {
    growth: { joins: number; leaves: number; net: number };
    messages: { total: number; fromMembers: number; uniqueSenders: number; perDay: number };
    members: { active: number; inactive: number; activeRate: number; inactiveDays: number };
    bestHoursToPost: number[];
    byHour: { hour: number; messages: number }[];
    topMembers: { jid: string; name: string | null; messages: number }[];
    daily: { date: string; joins: number; leaves: number; messages: number }[];
}
interface JoinRequest { jid: string; phone: string | null; requestedAt: string | null; method: string | null }

const TABS = [["overview", "Visão geral"], ["members", "Membros"], ["requests", "Pedidos"], ["send", "Enviar"], ["analytics", "Analytics"]] as const;

export function GroupDetail({ sessionId, jid, onClose, onChanged }: { sessionId: string; jid: string | null; onClose: () => void; onChanged: () => void }) {
    const [tab, setTab] = useState<(typeof TABS)[number][0]>("overview");
    const [detail, setDetail] = useState<Detail | null>(null);
    const [busy, setBusy] = useState(false);
    const base = `/api/groups/${sessionId}/${encodeURIComponent(jid || "")}`;

    const load = useCallback(async (memberStatus = "active") => {
        if (!jid) return;
        const d = await api<Detail>(`${base}/info?members=${memberStatus}&sort=activity`);
        if (d) setDetail(d);
    }, [base, jid]);

    const [openedJid, setOpenedJid] = useState(jid);
    if (openedJid !== jid) { setOpenedJid(jid); setTab("overview"); setDetail(null); }
    useEffect(() => { if (jid) queueMicrotask(() => load()); }, [jid, load]);

    const manage = async (json: Record<string, unknown>, ok: string) => {
        setBusy(true);
        const r = await api(`${base}/manage`, { method: "POST", json });
        setBusy(false);
        if (r) { toast.success(ok); await load(); onChanged(); }
        return r;
    };

    return (
        <Dialog open={!!jid} onOpenChange={o => !o && onClose()}>
            <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 flex-wrap">
                        {detail?.subject || "Grupo"}
                        {detail && <Badge variant="secondary">{detail.counts.active} membros</Badge>}
                        {detail?.myRole && <Badge variant={detail.isAdmin ? "default" : "outline"}>{roleLabel[detail.myRole] ?? detail.myRole}</Badge>}
                    </DialogTitle>
                </DialogHeader>
                <div className="flex gap-1 border-b overflow-x-auto">
                    {TABS.map(([id, label]) => (
                        <button key={id} onClick={() => setTab(id)} className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${tab === id ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}>{label}</button>
                    ))}
                </div>
                <div className="overflow-y-auto flex-1 pr-1">
                    {!detail ? <div className="flex justify-center py-10"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div> : (
                        <>
                            {tab === "overview" && <Overview detail={detail} busy={busy} manage={manage} sessionId={sessionId} reload={load} onChanged={onChanged} onClose={onClose} />}
                            {tab === "members" && <Members detail={detail} busy={busy} manage={manage} reload={load} />}
                            {tab === "requests" && <Requests base={base} isAdmin={detail.isAdmin} />}
                            {tab === "send" && <SendBox base={base} />}
                            {tab === "analytics" && <GroupAnalytics base={base} />}
                        </>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Overview({ detail, busy, manage, sessionId, reload, onChanged, onClose }: { detail: Detail; busy: boolean; manage: (j: Record<string, unknown>, ok: string) => Promise<unknown>; sessionId: string; reload: () => Promise<void>; onChanged: () => void; onClose: () => void }) {
    const [subject, setSubject] = useState(detail.subject || "");
    const [description, setDescription] = useState(detail.description || "");
    const [tags, setTags] = useState(detail.tags.join(", "));
    const [notes, setNotes] = useState(detail.notes || "");
    const [invite, setInvite] = useState<string | null>(detail.inviteCode ? `https://chat.whatsapp.com/${detail.inviteCode}` : null);
    const admin = detail.isAdmin;

    const saveLocal = async () => {
        const r = await api(`/api/groups/${sessionId}/${encodeURIComponent(detail.jid)}/info`, { method: "PATCH", json: { tags: splitList(tags), notes } });
        if (r) { toast.success("Organização salva"); await reload(); onChanged(); }
    };
    const toggle = (key: string, value: unknown, label: string) => manage({ action: "settings", [key]: value }, label);

    return (
        <div className="space-y-5 py-3">
            {!admin && <p className="text-sm text-yellow-700 bg-yellow-500/10 rounded p-2">Este número não é admin deste grupo: só dá para organizar (tags/notas), enviar mensagens e ver dados.</p>}

            <section className="space-y-3">
                <h4 className="font-semibold text-sm">Configurações do WhatsApp</h4>
                <div className="grid sm:grid-cols-2 gap-3">
                    {[
                        ["announce", "Só admins enviam mensagens (fechado)", detail.announce],
                        ["restrict", "Só admins editam dados do grupo", detail.restrict],
                        ["joinApprovalMode", "Aprovar quem entra pelo link", detail.joinApprovalMode],
                    ].map(([key, label, val]) => (
                        <label key={key as string} className="flex items-center justify-between gap-3 border rounded p-2 text-sm">
                            <span>{label as string}</span>
                            <Switch checked={!!val} disabled={!admin || busy} onCheckedChange={v => toggle(key as string, v, "Configuração atualizada")} />
                        </label>
                    ))}
                    <label className="flex items-center justify-between gap-3 border rounded p-2 text-sm">
                        <span>Membros podem adicionar pessoas</span>
                        <Switch checked={!!detail.memberAddMode} disabled={!admin || busy} onCheckedChange={v => toggle("memberAddMode", v ? "all_member_add" : "admin_add", "Configuração atualizada")} />
                    </label>
                </div>
                <div className="flex items-center gap-2 text-sm">
                    <span>Mensagens temporárias:</span>
                    <select className="h-8 rounded border bg-background px-2" disabled={!admin || busy} value={detail.ephemeralDuration ?? 0}
                        onChange={e => toggle("ephemeralSeconds", Number(e.target.value), "Mensagens temporárias atualizadas")}>
                        <option value={0}>Desativadas</option><option value={86400}>24 horas</option><option value={604800}>7 dias</option><option value={7776000}>90 dias</option>
                    </select>
                </div>
                <div className="space-y-2">
                    <Label>Nome</Label>
                    <div className="flex gap-2">
                        <Input value={subject} onChange={e => setSubject(e.target.value)} disabled={!admin} maxLength={100} />
                        <Button variant="outline" disabled={!admin || busy || subject === detail.subject} onClick={() => manage({ action: "settings", subject }, "Nome atualizado")}>Salvar</Button>
                    </div>
                    <Label>Descrição</Label>
                    <Textarea value={description} onChange={e => setDescription(e.target.value)} disabled={!admin} rows={3} maxLength={2048} />
                    <Button variant="outline" size="sm" disabled={!admin || busy || description === (detail.description || "")} onClick={() => manage({ action: "settings", description }, "Descrição atualizada")}>Salvar descrição</Button>
                </div>
            </section>

            <section className="space-y-2">
                <h4 className="font-semibold text-sm">Link de convite</h4>
                <div className="flex gap-2 flex-wrap">
                    {invite && <Input readOnly value={invite} className="flex-1 min-w-[220px] font-mono text-xs" />}
                    {invite && <Button variant="outline" onClick={() => { navigator.clipboard.writeText(invite); toast.success("Copiado"); }}><Copy className="h-4 w-4" /></Button>}
                    <Button variant="outline" disabled={!admin || busy} onClick={async () => { const r = await manage({ action: "invite_link" }, "Link obtido") as { link?: string } | null; if (r?.link) setInvite(r.link); }}><Link2 className="h-4 w-4 mr-1" />{invite ? "Atualizar" : "Obter link"}</Button>
                    <Button variant="outline" disabled={!admin || busy} onClick={async () => { if (!confirm("Revogar o link atual? Quem tiver o link antigo não conseguirá entrar.")) return; const r = await manage({ action: "invite_link", revoke: true }, "Link revogado, novo link gerado") as { link?: string } | null; if (r?.link) setInvite(r.link); }}>Revogar</Button>
                </div>
            </section>

            <section className="space-y-2">
                <h4 className="font-semibold text-sm">Organização (só no sistema)</h4>
                <Label>Tags (separadas por vírgula)</Label>
                <Input value={tags} onChange={e => setTags(e.target.value)} placeholder="lancamento, clientes, turma-out" />
                <Label>Notas</Label>
                <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
                <Button size="sm" onClick={saveLocal}>Salvar organização</Button>
            </section>

            <section className="flex gap-2 flex-wrap border-t pt-3">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => manage({ action: "sync" }, "Grupo sincronizado")}><RefreshCw className="h-4 w-4 mr-1" />Sincronizar</Button>
                <Button variant="outline" size="sm" className="text-red-600" disabled={busy} onClick={async () => { if (!confirm(`Sair do grupo "${detail.subject}"?`)) return; if (await manage({ action: "leave" }, "Você saiu do grupo")) onClose(); }}><LogOut className="h-4 w-4 mr-1" />Sair do grupo</Button>
            </section>
        </div>
    );
}

function Members({ detail, busy, manage, reload }: { detail: Detail; busy: boolean; manage: (j: Record<string, unknown>, ok: string) => Promise<unknown>; reload: (status?: string) => Promise<void> }) {
    const [filter, setFilter] = useState("");
    const [status, setStatus] = useState("active");
    const [toAdd, setToAdd] = useState("");
    const admin = detail.isAdmin;
    const list = detail.members.filter(m => !filter || (m.name || "").toLowerCase().includes(filter.toLowerCase()) || (m.phone || m.memberJid).includes(filter.replace(/\D/g, "") || filter));
    const act = (action: string, m: MemberRow, label: string) => {
        if (action === "remove" && !confirm(`Remover ${m.name || phoneLabel(m.memberJid, m.phone)} do grupo?`)) return;
        manage({ action, participants: [m.memberJid] }, label);
    };

    return (
        <div className="space-y-3 py-3">
            {admin && (
                <div className="flex gap-2">
                    <Input placeholder="Adicionar: números separados por vírgula (ex.: 61999998888)" value={toAdd} onChange={e => setToAdd(e.target.value)} />
                    <Button disabled={busy || !toAdd.trim()} onClick={async () => { if (await manage({ action: "add", participants: splitList(toAdd) }, "Pedido de inclusão enviado")) setToAdd(""); }}><UserPlus className="h-4 w-4" /></Button>
                </div>
            )}
            <div className="flex gap-2">
                <Input placeholder="Buscar por nome ou número" value={filter} onChange={e => setFilter(e.target.value)} />
                <select className="h-9 rounded border bg-background px-2 text-sm" value={status} onChange={e => { setStatus(e.target.value); reload(e.target.value); }}>
                    <option value="active">Ativos</option><option value="left">Saíram</option><option value="all">Todos</option>
                </select>
            </div>
            <p className="text-xs text-muted-foreground">{list.length} pessoas · ordenado por última mensagem</p>
            <div className="divide-y border rounded">
                {list.map(m => (
                    <div key={m.memberJid} className="flex items-center gap-2 p-2 text-sm">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-medium truncate">{m.name || phoneLabel(m.memberJid, m.phone)}</span>
                                {m.role !== "member" && <Badge variant="secondary">{roleLabel[m.role]}</Badge>}
                                {m.warnings > 0 && <Badge variant="destructive">{m.warnings} adv.</Badge>}
                                {!m.isActive && <Badge variant="outline">saiu {fmtDate(m.leftAt)}</Badge>}
                            </div>
                            <p className="text-xs text-muted-foreground">{m.name ? phoneLabel(m.memberJid, m.phone) + " · " : ""}{m.messageCount} msgs · última {fmtDate(m.lastMessageAt)}</p>
                        </div>
                        {admin && m.isActive && m.role !== "superadmin" && (
                            <div className="flex gap-1">
                                {m.role === "member"
                                    ? <Button variant="ghost" size="sm" title="Tornar admin" disabled={busy} onClick={() => act("promote", m, "Promovido a admin")}><Shield className="h-4 w-4" /></Button>
                                    : <Button variant="ghost" size="sm" title="Remover admin" disabled={busy} onClick={() => act("demote", m, "Admin removido")}><ShieldOff className="h-4 w-4" /></Button>}
                                <Button variant="ghost" size="sm" title="Remover do grupo" className="text-red-600" disabled={busy} onClick={() => act("remove", m, "Removido do grupo")}><UserMinus className="h-4 w-4" /></Button>
                            </div>
                        )}
                    </div>
                ))}
                {!list.length && <p className="p-4 text-center text-sm text-muted-foreground">Ninguém aqui.</p>}
            </div>
        </div>
    );
}

function Requests({ base, isAdmin }: { base: string; isAdmin: boolean }) {
    const [list, setList] = useState<JoinRequest[] | null>(null);
    const load = useCallback(async () => setList(await api<JoinRequest[]>(`${base}/requests`) ?? []), [base]);
    useEffect(() => { if (isAdmin) queueMicrotask(load); }, [isAdmin, load]);
    const answer = async (action: "approve" | "reject", participants?: string[]) => {
        if (await api(`${base}/requests`, { method: "POST", json: { action, participants } })) { toast.success(action === "approve" ? "Aprovado" : "Recusado"); load(); }
    };
    if (!isAdmin) return <p className="py-6 text-sm text-muted-foreground text-center">Só admins veem pedidos de entrada.</p>;
    if (!list) return <div className="flex justify-center py-10"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
    return (
        <div className="space-y-3 py-3">
            <div className="flex gap-2 justify-between items-center">
                <p className="text-sm text-muted-foreground">{list.length} pedido(s) pendente(s)</p>
                {list.length > 0 && <div className="flex gap-2"><Button size="sm" onClick={() => answer("approve")}>Aprovar todos</Button><Button size="sm" variant="outline" onClick={() => answer("reject")}>Recusar todos</Button></div>}
            </div>
            <div className="divide-y border rounded">
                {list.map(r => (
                    <div key={r.jid} className="flex items-center gap-2 p-2 text-sm">
                        <div className="flex-1">{phoneLabel(r.phone || r.jid)}<p className="text-xs text-muted-foreground">{fmtDate(r.requestedAt)} · {r.method === "invite_link" ? "pelo link" : r.method || ""}</p></div>
                        <Button size="sm" variant="ghost" onClick={() => answer("approve", [r.jid])}><Check className="h-4 w-4" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => answer("reject", [r.jid])}><X className="h-4 w-4" /></Button>
                    </div>
                ))}
            </div>
        </div>
    );
}

function SendBox({ base }: { base: string }) {
    const [text, setText] = useState("");
    const [mediaUrl, setMediaUrl] = useState("");
    const [mediaType, setMediaType] = useState("image");
    const [mentionAll, setMentionAll] = useState(false);
    const [sending, setSending] = useState(false);
    const send = async () => {
        setSending(true);
        const r = await api<{ mentioned: number }>(`${base}/send`, { method: "POST", json: { text: text || undefined, mentionAll, ...(mediaUrl ? { media: { type: mediaType, url: mediaUrl } } : {}) } });
        setSending(false);
        if (r) { toast.success(r.mentioned ? `Enviado, mencionando ${r.mentioned} pessoas` : "Enviado"); setText(""); setMediaUrl(""); }
    };
    return (
        <div className="space-y-3 py-3">
            <Textarea rows={5} placeholder="Mensagem para o grupo" value={text} onChange={e => setText(e.target.value)} />
            <div className="flex gap-2">
                <select className="h-9 rounded border bg-background px-2 text-sm" value={mediaType} onChange={e => setMediaType(e.target.value)}>
                    <option value="image">Imagem</option><option value="video">Vídeo</option><option value="document">Documento</option><option value="audio">Áudio</option>
                </select>
                <Input placeholder="URL da mídia (opcional)" value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm"><Switch checked={mentionAll} onCheckedChange={setMentionAll} />Mencionar todos (notifica cada membro, sem poluir o texto)</label>
            <Button onClick={send} disabled={sending || (!text.trim() && !mediaUrl.trim())}><Send className="h-4 w-4 mr-2" />Enviar agora</Button>
        </div>
    );
}

function GroupAnalytics({ base }: { base: string }) {
    const [days, setDays] = useState(30);
    const [a, setA] = useState<Analytics | null>(null);
    useEffect(() => {
        let stale = false;
        api<Analytics>(`${base}/analytics?days=${days}`).then(d => { if (!stale) setA(d); });
        return () => { stale = true; };
    }, [base, days]);
    if (!a) return <div className="flex justify-center py-10"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
    const maxHour = Math.max(1, ...a.byHour.map(h => h.messages));
    const maxDay = Math.max(1, ...a.daily.map(d => d.messages));
    const stat = (label: string, value: string | number, hint?: string) => (
        <div className="border rounded p-3"><div className="text-xl font-bold">{value}</div><div className="text-xs text-muted-foreground">{label}</div>{hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}</div>
    );
    return (
        <div className="space-y-4 py-3">
            <select className="h-8 rounded border bg-background px-2 text-sm" value={days} onChange={e => setDays(Number(e.target.value))}>
                <option value={7}>Últimos 7 dias</option><option value={30}>Últimos 30 dias</option><option value={90}>Últimos 90 dias</option>
            </select>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {stat("Entraram", a.growth.joins)}
                {stat("Saíram", a.growth.leaves)}
                {stat("Saldo", (a.growth.net > 0 ? "+" : "") + a.growth.net)}
                {stat("Mensagens", a.messages.total, `${a.messages.perDay}/dia · ${a.messages.uniqueSenders} pessoas`)}
                {stat("Ativos", `${a.members.activeRate}%`, `${a.members.inactive} sem falar há ${a.members.inactiveDays}d`)}
                {stat("Melhor horário", a.bestHoursToPost.length ? a.bestHoursToPost.map(h => `${h}h`).join(", ") : "—", "maior atividade dos membros")}
            </div>
            <div>
                <h4 className="text-sm font-semibold mb-2">Mensagens por dia</h4>
                <div className="flex items-end gap-[2px] h-24">
                    {a.daily.map(d => <div key={d.date} title={`${d.date}: ${d.messages} msgs, +${d.joins} / -${d.leaves}`} className="flex-1 bg-primary/70 rounded-t min-h-[1px]" style={{ height: `${(d.messages / maxDay) * 100}%` }} />)}
                </div>
            </div>
            <div>
                <h4 className="text-sm font-semibold mb-2">Atividade por hora</h4>
                <div className="flex items-end gap-[2px] h-20">
                    {a.byHour.map(h => <div key={h.hour} title={`${h.hour}h: ${h.messages}`} className="flex-1 bg-emerald-500/70 rounded-t min-h-[1px]" style={{ height: `${(h.messages / maxHour) * 100}%` }} />)}
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
            </div>
            <div>
                <h4 className="text-sm font-semibold mb-2">Quem mais participa</h4>
                <div className="divide-y border rounded text-sm">
                    {a.topMembers.map(m => <div key={m.jid} className="flex justify-between p-2"><span>{m.name || phoneLabel(m.jid)}</span><span className="text-muted-foreground">{m.messages} msgs</span></div>)}
                    {!a.topMembers.length && <p className="p-3 text-muted-foreground text-center">Sem mensagens no período.</p>}
                </div>
            </div>
        </div>
    );
}
