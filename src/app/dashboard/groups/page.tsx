"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Users, Plus, RefreshCw, Send, Bot, Link2, BarChart3, Tag, Lock, ShieldCheck, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/dashboard/session-provider";
import { SessionGuard } from "@/components/dashboard/session-guard";
import { api, fmtDate, roleLabel, splitList, type GroupRow } from "@/components/groups/api";
import { GroupDetail } from "@/components/groups/group-detail";
import { GroupBroadcast } from "@/components/groups/group-broadcast";
import { GroupAutomations } from "@/components/groups/group-automations";
import { GroupLinks } from "@/components/groups/group-links";

const TABS = [
    { id: "groups", label: "Grupos", icon: Users },
    { id: "broadcast", label: "Disparos", icon: Send },
    { id: "automations", label: "Automações", icon: Bot },
    { id: "links", label: "Links inteligentes", icon: Link2 },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function GroupsPage() {
    const { sessionId } = useSession();
    const [tab, setTab] = useState<TabId>("groups");
    const [groups, setGroups] = useState<GroupRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [search, setSearch] = useState("");
    const [tagFilter, setTagFilter] = useState("");
    const [adminOnly, setAdminOnly] = useState(false);
    const [sort, setSort] = useState("name");
    const [selected, setSelected] = useState<string[]>([]);
    const [openJid, setOpenJid] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [bulk, setBulk] = useState<null | "tag" | "remove">(null);

    const load = useCallback(async () => {
        if (!sessionId) return;
        setLoading(true);
        const data = await api<GroupRow[]>(`/api/groups/${sessionId}?view=summary&sort=${sort}`);
        setLoading(false);
        if (data) setGroups(data);
    }, [sessionId, sort]);
    useEffect(() => { queueMicrotask(load); }, [load]);
    // limpa a seleção ao trocar de sessão
    const [selectionFor, setSelectionFor] = useState(sessionId);
    if (selectionFor !== sessionId) { setSelectionFor(sessionId); setSelected([]); }

    const sync = async () => {
        setLoading(true);
        const r = await api<{ synced: number }>(`/api/groups/${sessionId}/sync`, { method: "POST" });
        setLoading(false);
        if (r) { toast.success(`${r.synced} grupos sincronizados`); load(); }
    };

    const allTags = useMemo(() => [...new Set(groups.flatMap(g => g.tags))].sort(), [groups]);
    const visible = groups.filter(g =>
        (!search || (g.subject || "").toLowerCase().includes(search.toLowerCase())) &&
        (!tagFilter || g.tags.includes(tagFilter)) &&
        (!adminOnly || g.isAdmin));
    const totals = { groups: groups.length, admin: groups.filter(g => g.isAdmin).length, members: groups.reduce((a, g) => a + (g.size || 0), 0) };
    const toggleSel = (jid: string) => setSelected(selected.includes(jid) ? selected.filter(j => j !== jid) : [...selected, jid]);
    const allVisibleSelected = visible.length > 0 && visible.every(g => selected.includes(g.jid));

    return (
        <SessionGuard>
            <div className="space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                        <h1 className="text-xl sm:text-3xl font-bold flex items-center gap-2"><Users className="h-6 w-6" />Grupos</h1>
                        <p className="text-sm text-muted-foreground">{totals.groups} grupos · admin em {totals.admin} · {totals.members.toLocaleString("pt-BR")} participantes</p>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={sync} disabled={loading || !sessionId}><RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />Sincronizar</Button>
                        <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!sessionId}><Plus className="h-4 w-4 mr-1" />Novo grupo</Button>
                    </div>
                </div>

                <div className="flex gap-1 bg-muted/50 p-1 rounded-lg w-full overflow-x-auto">
                    {TABS.map(t => (
                        <button key={t.id} onClick={() => setTab(t.id)} className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md whitespace-nowrap ${tab === t.id ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                            <t.icon className="h-4 w-4" />{t.label}
                        </button>
                    ))}
                </div>

                {tab === "groups" && (
                    <Card>
                        <CardContent className="pt-6 space-y-3">
                            <div className="flex gap-2 flex-wrap">
                                <Input className="max-w-xs" placeholder="Buscar grupo" value={search} onChange={e => setSearch(e.target.value)} />
                                <select className="h-9 rounded border bg-background px-2 text-sm" value={tagFilter} onChange={e => setTagFilter(e.target.value)}>
                                    <option value="">Todas as tags</option>{allTags.map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <select className="h-9 rounded border bg-background px-2 text-sm" value={sort} onChange={e => setSort(e.target.value)}>
                                    <option value="name">Nome</option><option value="size">Tamanho</option><option value="activity">Atividade</option>
                                </select>
                                <label className="flex items-center gap-2 text-sm"><Switch checked={adminOnly} onCheckedChange={setAdminOnly} />Só onde sou admin</label>
                            </div>

                            {selected.length > 0 && (
                                <div className="flex items-center gap-2 flex-wrap bg-primary/5 border rounded p-2 text-sm">
                                    <span className="font-medium">{selected.length} selecionado(s)</span>
                                    <Button size="sm" onClick={() => setTab("broadcast")}><Send className="h-4 w-4 mr-1" />Enviar mensagem</Button>
                                    <Button size="sm" variant="outline" onClick={() => setBulk("tag")}><Tag className="h-4 w-4 mr-1" />Adicionar tag</Button>
                                    <Button size="sm" variant="outline" onClick={() => setBulk("remove")}><UserMinus className="h-4 w-4 mr-1" />Remover pessoa</Button>
                                    <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Limpar</Button>
                                </div>
                            )}

                            <div className="border rounded divide-y">
                                <label className="flex items-center gap-3 p-2 text-xs text-muted-foreground bg-muted/30">
                                    <input type="checkbox" checked={allVisibleSelected} onChange={() => setSelected(allVisibleSelected ? selected.filter(j => !visible.some(g => g.jid === j)) : [...new Set([...selected, ...visible.map(g => g.jid)])])} />
                                    Selecionar todos os {visible.length} visíveis
                                </label>
                                {visible.map(g => (
                                    <div key={g.jid} className="flex items-center gap-3 p-3 hover:bg-muted/30">
                                        <input type="checkbox" checked={selected.includes(g.jid)} onChange={() => toggleSel(g.jid)} />
                                        <button className="flex-1 min-w-0 text-left" onClick={() => setOpenJid(g.jid)}>
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="font-medium truncate">{g.subject || g.jid}</span>
                                                {g.isAdmin && <ShieldCheck className="h-4 w-4 text-green-600" aria-label="admin" />}
                                                {g.announce && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="fechado" />}
                                                {g.isCommunity && <Badge variant="outline">comunidade</Badge>}
                                                {g.tags.map(t => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
                                            </div>
                                            <p className="text-xs text-muted-foreground">{g.size ?? "?"} membros · {g.myRole ? roleLabel[g.myRole] : "fora do grupo"} · última atividade {fmtDate(g.lastActivityAt)}</p>
                                        </button>
                                    </div>
                                ))}
                                {!visible.length && <p className="p-6 text-center text-sm text-muted-foreground">{loading ? "Carregando…" : groups.length ? "Nenhum grupo com esses filtros." : "Nenhum grupo. Clique em Sincronizar."}</p>}
                            </div>
                        </CardContent>
                    </Card>
                )}

                {tab === "broadcast" && sessionId && <GroupBroadcast sessionId={sessionId} groups={groups} selected={selected} onSent={() => {}} />}
                {tab === "automations" && sessionId && <GroupAutomations sessionId={sessionId} />}
                {tab === "links" && sessionId && <GroupLinks sessionId={sessionId} groups={groups} />}
                {tab === "analytics" && sessionId && <Overview sessionId={sessionId} onOpen={setOpenJid} />}

                {sessionId && <GroupDetail sessionId={sessionId} jid={openJid} onClose={() => setOpenJid(null)} onChanged={load} />}
                {sessionId && <CreateGroup sessionId={sessionId} open={createOpen} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); load(); }} />}
                {sessionId && <BulkDialog sessionId={sessionId} mode={bulk} groups={groups.filter(g => selected.includes(g.jid))} onClose={() => setBulk(null)} onDone={() => { setBulk(null); load(); }} />}
            </div>
        </SessionGuard>
    );
}

function CreateGroup({ sessionId, open, onClose, onCreated }: { sessionId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
    const [subject, setSubject] = useState("");
    const [participants, setParticipants] = useState("");
    const [description, setDescription] = useState("");
    const [tags, setTags] = useState("");
    const [announce, setAnnounce] = useState(false);
    const [busy, setBusy] = useState(false);
    const create = async () => {
        if (!subject.trim() || !splitList(participants).length) return toast.error("Informe o nome e pelo menos um participante");
        setBusy(true);
        const r = await api(`/api/groups/${sessionId}/create`, { method: "POST", json: { subject, participants: splitList(participants), description: description || undefined, tags: splitList(tags), announce } });
        setBusy(false);
        if (r) { toast.success("Grupo criado"); setSubject(""); setParticipants(""); setDescription(""); setTags(""); onCreated(); }
    };
    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent className="max-w-lg">
                <DialogHeader><DialogTitle>Novo grupo</DialogTitle></DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1"><Label>Nome</Label><Input value={subject} onChange={e => setSubject(e.target.value)} maxLength={100} /></div>
                    <div className="space-y-1"><Label>Participantes (números, um por linha ou separados por vírgula)</Label><Textarea rows={3} value={participants} onChange={e => setParticipants(e.target.value)} placeholder={"61999998888\n11988887777"} /></div>
                    <div className="space-y-1"><Label>Descrição (opcional)</Label><Textarea rows={2} value={description} onChange={e => setDescription(e.target.value)} /></div>
                    <div className="space-y-1"><Label>Tags (opcional)</Label><Input value={tags} onChange={e => setTags(e.target.value)} placeholder="lancamento" /></div>
                    <label className="flex items-center gap-2 text-sm"><Switch checked={announce} onCheckedChange={setAnnounce} />Começar fechado (só admins enviam)</label>
                    <Button className="w-full" disabled={busy} onClick={create}>Criar grupo</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function BulkDialog({ sessionId, mode, groups, onClose, onDone }: { sessionId: string; mode: null | "tag" | "remove"; groups: GroupRow[]; onClose: () => void; onDone: () => void }) {
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const run = async () => {
        const items = splitList(value);
        if (!items.length) return;
        if (mode === "remove" && !confirm(`Remover ${items.length} pessoa(s) de ${groups.length} grupo(s)?`)) return;
        setBusy(true);
        if (mode === "tag") {
            for (const g of groups) await api(`/api/groups/${sessionId}/${encodeURIComponent(g.jid)}/info`, { method: "PATCH", json: { tags: [...new Set([...g.tags, ...items.map(t => t.toLowerCase())])] }, quiet: true });
            toast.success(`Tag adicionada em ${groups.length} grupo(s)`);
        } else {
            const r = await api<{ group: string; error?: string }[]>(`/api/groups/${sessionId}/bulk-members`, { method: "POST", json: { action: "remove", participants: items, target: { jids: groups.map(g => g.jid) } } });
            if (r) toast.success(`Concluído em ${r.filter(x => !x.error).length} grupo(s) (só onde sou admin)`);
        }
        setBusy(false);
        setValue("");
        onDone();
    };
    return (
        <Dialog open={!!mode} onOpenChange={o => !o && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader><DialogTitle>{mode === "tag" ? `Adicionar tag em ${groups.length} grupo(s)` : `Remover pessoa de ${groups.length} grupo(s)`}</DialogTitle></DialogHeader>
                <div className="space-y-3">
                    <Input value={value} onChange={e => setValue(e.target.value)} placeholder={mode === "tag" ? "lancamento, clientes" : "números, ex.: 61999998888"} />
                    <Button className="w-full" disabled={busy} onClick={run}>{mode === "tag" ? "Adicionar" : "Remover"}</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

interface OverviewData {
    totals: { groups: number; members: number; adminIn: number; joins: number; leaves: number; messages: number };
    groups: { jid: string; subject: string | null; size: number; joins: number; leaves: number; net: number; messages: number; lastActivityAt: string | null }[];
}

function Overview({ sessionId, onOpen }: { sessionId: string; onOpen: (jid: string) => void }) {
    const [days, setDays] = useState(7);
    const [data, setData] = useState<OverviewData | null>(null);
    useEffect(() => {
        let stale = false;
        api<OverviewData>(`/api/groups/${sessionId}/analytics?days=${days}`).then(d => { if (!stale) setData(d); });
        return () => { stale = true; };
    }, [sessionId, days]);
    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5" />Visão geral dos grupos</CardTitle>
                <select className="h-8 rounded border bg-background px-2 text-sm" value={days} onChange={e => setDays(Number(e.target.value))}>
                    <option value={1}>Hoje</option><option value={7}>7 dias</option><option value={30}>30 dias</option><option value={90}>90 dias</option>
                </select>
            </CardHeader>
            <CardContent className="space-y-4">
                {!data ? <div className="flex justify-center py-6"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div> : (
                    <>
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                            {([["Grupos", data.totals.groups], ["Participantes", data.totals.members.toLocaleString("pt-BR")], ["Entraram", `+${data.totals.joins}`], ["Saíram", `-${data.totals.leaves}`], ["Mensagens", data.totals.messages]] as const).map(([l, v]) => (
                                <div key={l} className="border rounded p-3"><div className="text-xl font-bold">{v}</div><div className="text-xs text-muted-foreground">{l}</div></div>
                            ))}
                        </div>
                        <div className="border rounded overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr><th className="text-left p-2">Grupo</th><th className="p-2">Membros</th><th className="p-2">Entraram</th><th className="p-2">Saíram</th><th className="p-2">Saldo</th><th className="p-2">Mensagens</th><th className="p-2 text-left">Última atividade</th></tr></thead>
                                <tbody className="divide-y">
                                    {data.groups.map(g => (
                                        <tr key={g.jid} className="hover:bg-muted/30 cursor-pointer" onClick={() => onOpen(g.jid)}>
                                            <td className="p-2">{g.subject}</td><td className="p-2 text-center">{g.size}</td>
                                            <td className="p-2 text-center text-green-600">+{g.joins}</td><td className="p-2 text-center text-red-500">-{g.leaves}</td>
                                            <td className="p-2 text-center font-medium">{g.net > 0 ? "+" : ""}{g.net}</td><td className="p-2 text-center">{g.messages}</td>
                                            <td className="p-2 text-xs text-muted-foreground">{fmtDate(g.lastActivityAt)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-xs text-muted-foreground">Clique num grupo para ver o detalhe: crescimento por dia, melhores horários para postar e quem mais participa.</p>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
