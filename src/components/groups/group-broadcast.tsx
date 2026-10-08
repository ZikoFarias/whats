"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, Send, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { api, splitList, type GroupRow } from "./api";

interface Step { message: string; mediaUrl: string; mediaType: string; mentionAll: boolean; sendAt: string }
const emptyStep = (): Step => ({ message: "", mediaUrl: "", mediaType: "image", mentionAll: false, sendAt: "" });

/** datetime-local value -> ISO with the browser's offset */
const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

export function GroupBroadcast({ sessionId, groups, selected, onSent }: { sessionId: string; groups: GroupRow[]; selected: string[]; onSent: () => void }) {
    const [mode, setMode] = useState<"selected" | "all" | "tags">(selected.length ? "selected" : "all");
    const [tags, setTags] = useState("");
    const [adminOnly, setAdminOnly] = useState(false);
    const [steps, setSteps] = useState<Step[]>([emptyStep()]);
    const [delay, setDelay] = useState(12);
    const [name, setName] = useState("");
    const [sending, setSending] = useState(false);

    const allTags = [...new Set(groups.flatMap(g => g.tags))].sort();
    const targetCount = mode === "all" ? groups.filter(g => !adminOnly || g.isAdmin).length
        : mode === "selected" ? selected.length
        : groups.filter(g => g.tags.some(t => splitList(tags).includes(t)) && (!adminOnly || g.isAdmin)).length;

    const update = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));

    const send = async () => {
        if (steps.some(s => !s.message.trim() && !s.mediaUrl.trim())) return toast.error("Cada mensagem precisa de texto ou mídia");
        if (!targetCount) return toast.error("Nenhum grupo no alvo");
        const target = mode === "all" ? { all: true, adminOnly } : mode === "tags" ? { tags: splitList(tags), adminOnly } : { jids: selected };
        const toBody = (s: Step) => ({ message: s.message, mentionAll: s.mentionAll, ...(s.mediaUrl ? { media: { type: s.mediaType, url: s.mediaUrl } } : {}) });
        const body = steps.length === 1
            ? { target, ...toBody(steps[0]), scheduledAt: toIso(steps[0].sendAt), delaySeconds: delay, name: name || undefined }
            : { target, sequence: steps.map(s => ({ ...toBody(s), sendAt: toIso(s.sendAt) })), delaySeconds: delay, name: name || undefined };
        setSending(true);
        const r = await api<{ groups: unknown[]; campaigns: { notice?: string }[] }>(`/api/groups/${sessionId}/broadcast`, { method: "POST", json: body });
        setSending(false);
        if (r) {
            toast.success(`${r.campaigns.length > 1 ? `Sequência de ${r.campaigns.length} mensagens` : "Disparo"} na fila para ${r.groups.length} grupos`);
            const notice = r.campaigns.find(c => c.notice)?.notice;
            if (notice) toast.info(notice);
            setSteps([emptyStep()]);
            onSent();
        }
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2"><Send className="h-5 w-5" />Disparo para grupos</CardTitle>
                <CardDescription>Usa a fila de campanhas: intervalo entre grupos, agendamento, pausa e cancelamento em Broadcast → History.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="space-y-2">
                    <Label>Para quais grupos</Label>
                    <div className="flex gap-2 flex-wrap text-sm">
                        {([["selected", `Selecionados (${selected.length})`], ["all", "Todos"], ["tags", "Por tag"]] as const).map(([v, l]) => (
                            <button key={v} onClick={() => setMode(v)} className={`px-3 py-1.5 rounded border ${mode === v ? "bg-primary text-primary-foreground" : ""}`}>{l}</button>
                        ))}
                    </div>
                    {mode === "tags" && (
                        <div className="space-y-1">
                            <Input placeholder="lancamento, clientes" value={tags} onChange={e => setTags(e.target.value)} />
                            {allTags.length > 0 && <p className="text-xs text-muted-foreground">Tags em uso: {allTags.map(t => <button key={t} className="underline mr-2" onClick={() => setTags(splitList(tags).includes(t) ? tags : [...splitList(tags), t].join(", "))}>{t}</button>)}</p>}
                        </div>
                    )}
                    {mode !== "selected" && <label className="flex items-center gap-2 text-sm"><Switch checked={adminOnly} onCheckedChange={setAdminOnly} />Só grupos em que sou admin</label>}
                    <p className="text-sm font-medium">{targetCount} grupo(s) no alvo</p>
                </div>

                {steps.map((s, i) => (
                    <div key={i} className="border rounded p-3 space-y-2">
                        <div className="flex justify-between items-center">
                            <span className="text-sm font-semibold">{steps.length > 1 ? `Mensagem ${i + 1}` : "Mensagem"}</span>
                            {steps.length > 1 && <Button variant="ghost" size="sm" onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
                        </div>
                        <Textarea rows={4} placeholder="Texto (ou legenda da mídia)" value={s.message} onChange={e => update(i, { message: e.target.value })} />
                        <div className="flex gap-2">
                            <select className="h-9 rounded border bg-background px-2 text-sm" value={s.mediaType} onChange={e => update(i, { mediaType: e.target.value })}>
                                <option value="image">Imagem</option><option value="video">Vídeo</option><option value="document">Documento</option>
                            </select>
                            <Input placeholder="URL da mídia (opcional)" value={s.mediaUrl} onChange={e => update(i, { mediaUrl: e.target.value })} />
                        </div>
                        <div className="flex gap-4 flex-wrap items-center">
                            <label className="flex items-center gap-2 text-sm"><Switch checked={s.mentionAll} onCheckedChange={v => update(i, { mentionAll: v })} />Mencionar todos</label>
                            <label className="flex items-center gap-2 text-sm"><CalendarClock className="h-4 w-4" />Enviar em
                                <input type="datetime-local" className="h-8 rounded border bg-background px-2" value={s.sendAt} onChange={e => update(i, { sendAt: e.target.value })} />
                            </label>
                            {!s.sendAt && <span className="text-xs text-muted-foreground">(vazio = agora)</span>}
                        </div>
                    </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setSteps([...steps, emptyStep()])}><Plus className="h-4 w-4 mr-1" />Adicionar mensagem à sequência</Button>

                <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-1"><Label>Nome da campanha (opcional)</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="Live de quinta" /></div>
                    <div className="space-y-1"><Label>Intervalo entre grupos: {delay}s</Label><input type="range" min={5} max={120} value={delay} onChange={e => setDelay(Number(e.target.value))} className="w-full" /></div>
                </div>
                <Button className="w-full" disabled={sending} onClick={send}><Send className="h-4 w-4 mr-2" />{steps.length > 1 ? `Agendar sequência (${steps.length})` : "Enviar / agendar"}</Button>
            </CardContent>
        </Card>
    );
}
