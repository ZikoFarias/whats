"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Link2, Plus, Copy, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, splitList, type GroupRow } from "./api";

interface LinkRow {
    id: string; slug: string; name: string; url: string; active: boolean; clicks: number;
    maxMembers: number; strategy: string; autoCreate: boolean; fallbackUrl: string | null;
    groups: { jid: string; subject: string | null; size: number | null; full: boolean; usable: boolean; clicks: number }[];
    clicksBySource: { source: string; clicks: number }[];
}

export function GroupLinks({ sessionId, groups }: { sessionId: string; groups: GroupRow[] }) {
    const [links, setLinks] = useState<LinkRow[] | null>(null);
    const [creating, setCreating] = useState(false);
    const base = `/api/groups/${sessionId}/links`;
    const load = useCallback(async () => setLinks(await api<LinkRow[]>(base) ?? []), [base]);
    useEffect(() => { queueMicrotask(load); }, [load]);

    const patch = async (l: LinkRow, json: Record<string, unknown>) => { if (await api(`${base}/${l.id}`, { method: "PATCH", json })) load(); };
    const remove = async (l: LinkRow) => { if (confirm(`Excluir o link "${l.name}"?`) && await api(`${base}/${l.id}`, { method: "DELETE" })) load(); };
    const copy = (t: string) => { navigator.clipboard.writeText(t); toast.success("Link copiado"); };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2"><Link2 className="h-5 w-5" />Links inteligentes</CardTitle>
                <CardDescription>
                    Um link só para divulgar (anúncios, bio, e-mail). Cada pessoa vai para o próximo grupo com vaga e, se todos lotarem, um novo grupo pode ser criado sozinho.
                    Adicione <code>?utm_source=instagram</code> no link para saber de onde vieram os cliques.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" />Novo link</Button>
                {!links ? <div className="flex justify-center py-6"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div> : links.map(l => (
                    <div key={l.id} className={`border rounded p-3 space-y-2 ${l.active ? "" : "opacity-60"}`}>
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{l.name}</span>
                            <Badge variant="secondary">{l.clicks} cliques</Badge>
                            <Badge variant="outline">{l.strategy === "balance" ? "equilibrar" : "encher em ordem"} · até {l.maxMembers}</Badge>
                            {l.autoCreate && <Badge variant="outline">cria grupos</Badge>}
                            <div className="ml-auto flex items-center gap-2">
                                <Switch checked={l.active} onCheckedChange={v => patch(l, { active: v })} />
                                <Button variant="ghost" size="sm" onClick={() => remove(l)}><Trash2 className="h-4 w-4" /></Button>
                            </div>
                        </div>
                        <div className="flex gap-2"><Input readOnly value={l.url} className="font-mono text-xs" /><Button variant="outline" onClick={() => copy(l.url)}><Copy className="h-4 w-4" /></Button></div>
                        <div className="grid sm:grid-cols-2 gap-1 text-sm">
                            {l.groups.map(g => (
                                <div key={g.jid} className="flex justify-between border rounded px-2 py-1">
                                    <span className="truncate">{g.subject || g.jid}</span>
                                    <span className={`text-xs ${g.full ? "text-red-500" : !g.usable ? "text-yellow-600" : "text-muted-foreground"}`}>
                                        {g.size ?? "?"}/{l.maxMembers}{g.full ? " cheio" : !g.usable ? " (não sou admin)" : ""} · {g.clicks} cliques
                                    </span>
                                </div>
                            ))}
                        </div>
                        {l.clicksBySource.length > 0 && <p className="text-xs text-muted-foreground">Origem: {l.clicksBySource.map(s => `${s.source} ${s.clicks}`).join(" · ")}</p>}
                    </div>
                ))}
                {links && !links.length && <p className="text-sm text-muted-foreground">Nenhum link ainda.</p>}
            </CardContent>
            <NewLink open={creating} groups={groups} base={base} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />
        </Card>
    );
}

function NewLink({ open, groups, base, onClose, onSaved }: { open: boolean; groups: GroupRow[]; base: string; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [picked, setPicked] = useState<string[]>([]);
    const [maxMembers, setMax] = useState(1000);
    const [strategy, setStrategy] = useState("fill");
    const [autoCreate, setAutoCreate] = useState(false);
    const [autoCreateName, setAutoCreateName] = useState("{{name}} #{{n}}");
    const [autoTags, setAutoTags] = useState("");
    const [fallbackUrl, setFallback] = useState("");
    const adminGroups = groups.filter(g => g.isAdmin);

    const save = async () => {
        if (!name.trim()) return toast.error("Dê um nome ao link");
        if (!picked.length && !autoCreate) return toast.error("Escolha pelo menos um grupo ou ative a criação automática");
        const r = await api(base, { method: "POST", json: {
            name, ...(slug ? { slug } : {}), groupJids: picked, maxMembers, strategy, autoCreate,
            ...(autoCreate ? { autoCreateName, autoCreateTags: splitList(autoTags) } : {}),
            ...(fallbackUrl ? { fallbackUrl } : {}),
        } });
        if (r) { toast.success("Link criado"); onSaved(); }
    };

    return (
        <Dialog open={open} onOpenChange={o => !o && onClose()}>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Novo link inteligente</DialogTitle></DialogHeader>
                <div className="space-y-3">
                    <div className="space-y-1"><Label>Nome</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Lançamento de outubro" /></div>
                    <div className="space-y-1"><Label>Endereço (opcional)</Label><Input value={slug} onChange={e => setSlug(e.target.value.toLowerCase())} placeholder="lancamento-out" /><p className="text-xs text-muted-foreground">Fica /g/endereço. Vazio = gerado a partir do nome.</p></div>
                    <div className="space-y-1">
                        <Label>Grupos, na ordem de preenchimento ({picked.length})</Label>
                        <div className="max-h-48 overflow-y-auto border rounded divide-y">
                            {adminGroups.map(g => (
                                <label key={g.jid} className="flex items-center gap-2 p-2 text-sm cursor-pointer">
                                    <input type="checkbox" checked={picked.includes(g.jid)} onChange={() => setPicked(picked.includes(g.jid) ? picked.filter(j => j !== g.jid) : [...picked, g.jid])} />
                                    <span className="flex-1 truncate">{g.subject}</span><span className="text-xs text-muted-foreground">{g.size ?? "?"} membros</span>
                                </label>
                            ))}
                            {!adminGroups.length && <p className="p-2 text-sm text-muted-foreground">Só grupos em que este número é admin podem entrar no link.</p>}
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1"><Label>Lotação por grupo</Label><Input type="number" min={2} max={1024} value={maxMembers} onChange={e => setMax(Number(e.target.value))} /></div>
                        <div className="space-y-1"><Label>Estratégia</Label>
                            <select className="h-9 w-full rounded border bg-background px-2 text-sm" value={strategy} onChange={e => setStrategy(e.target.value)}>
                                <option value="fill">Encher um por vez</option><option value="balance">Equilibrar entre grupos</option>
                            </select>
                        </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm"><Switch checked={autoCreate} onCheckedChange={setAutoCreate} />Criar novo grupo quando todos lotarem</label>
                    {autoCreate && (
                        <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1"><Label>Nome dos novos</Label><Input value={autoCreateName} onChange={e => setAutoCreateName(e.target.value)} /></div>
                            <div className="space-y-1"><Label>Tags dos novos</Label><Input value={autoTags} onChange={e => setAutoTags(e.target.value)} placeholder="lancamento" /></div>
                        </div>
                    )}
                    <div className="space-y-1"><Label>Se não houver vaga, mandar para (opcional)</Label><Input value={fallbackUrl} onChange={e => setFallback(e.target.value)} placeholder="https://seusite.com/lista-de-espera" /></div>
                    <Button className="w-full" onClick={save}>Criar link</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
