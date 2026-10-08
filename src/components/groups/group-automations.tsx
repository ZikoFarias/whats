"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, Plus, Trash2, Pencil, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, fmtDate, splitList } from "./api";

interface Rule {
    id?: string; key?: string; description?: string;
    name: string; active?: boolean; priority?: number;
    scope: { all?: boolean; tags?: string[]; jids?: string[] };
    trigger: string;
    triggerConfig: { match?: string; keywords?: string[]; pattern?: string; maxMessages?: number; perSeconds?: number; cron?: string };
    actions: Record<string, unknown>[];
    ignoreAdmins?: boolean; cooldownSec?: number;
    runs?: number; lastRunAt?: string | null;
}

const TRIGGERS: Record<string, string> = { member_join: "Alguém entrou", member_leave: "Alguém saiu", message: "Mensagem recebida", schedule: "Horário (cron)" };
const MATCHES: Record<string, string> = { contains: "contém palavra", exact: "é exatamente", starts_with: "começa com", regex: "expressão regular", link: "tem link", invite_link: "convite de outro grupo", flood: "flood (muitas msgs)", any: "qualquer mensagem" };
const ACTIONS: Record<string, string> = { send_message: "enviar mensagem", reply: "responder", delete_message: "apagar mensagem", warn: "advertir", remove_member: "remover membro", set_announce: "abrir/fechar grupo", notify: "webhook", stop: "parar" };

function describe(r: Rule): string {
    const t = TRIGGERS[r.trigger] ?? r.trigger;
    const cfg = r.triggerConfig || {};
    const when = r.trigger === "message" ? `${t} que ${MATCHES[cfg.match ?? "contains"] ?? cfg.match}${cfg.keywords?.length ? `: ${cfg.keywords.slice(0, 4).join(", ")}${cfg.keywords.length > 4 ? "…" : ""}` : ""}`
        : r.trigger === "schedule" ? `${t}: ${cfg.cron}` : t;
    return `${when} → ${r.actions.map(a => ACTIONS[a.type as string] ?? a.type).join(" → ")}`;
}

export function GroupAutomations({ sessionId }: { sessionId: string }) {
    const [rules, setRules] = useState<Rule[] | null>(null);
    const [templates, setTemplates] = useState<Rule[]>([]);
    const [editing, setEditing] = useState<Rule | null>(null);
    const base = `/api/groups/${sessionId}/automations`;

    const load = useCallback(async () => {
        setRules(await api<Rule[]>(base) ?? []);
        setTemplates(await api<Rule[]>(`${base}/templates`, { quiet: true }) ?? []);
    }, [base]);
    useEffect(() => { queueMicrotask(load); }, [load]);

    const toggle = async (r: Rule) => { if (await api(`${base}/${r.id}`, { method: "PATCH", json: { active: !r.active } })) load(); };
    const remove = async (r: Rule) => { if (confirm(`Excluir "${r.name}"?`) && await api(`${base}/${r.id}`, { method: "DELETE" })) { toast.success("Excluída"); load(); } };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" />Automações e moderação</CardTitle>
                <CardDescription>Regras que rodam sozinhas nos grupos: boas-vindas, anti-link, anti-flood, comandos, abrir/fechar por horário e alertas.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div>
                    <p className="text-sm font-medium mb-2">Começar de um modelo</p>
                    <div className="flex flex-wrap gap-2">
                        {templates.map(t => <Button key={t.key} variant="outline" size="sm" title={t.description} onClick={() => setEditing({ ...t, scope: { all: true }, active: true })}><Plus className="h-3 w-3 mr-1" />{t.name}</Button>)}
                        <Button variant="outline" size="sm" onClick={() => setEditing({ name: "Nova regra", scope: { all: true }, trigger: "message", triggerConfig: { match: "contains", keywords: [] }, actions: [{ type: "reply", text: "" }], active: true })}><Plus className="h-3 w-3 mr-1" />Em branco</Button>
                    </div>
                </div>
                {!rules ? <div className="flex justify-center py-6"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div> : (
                    <div className="divide-y border rounded">
                        {rules.map(r => (
                            <div key={r.id} className={`flex items-center gap-3 p-3 ${r.active ? "" : "opacity-60"}`}>
                                <Switch checked={!!r.active} onCheckedChange={() => toggle(r)} />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-medium">{r.name}</span>
                                        <Badge variant="outline">{r.scope.all ? "todos os grupos" : r.scope.tags?.length ? `tags: ${r.scope.tags.join(", ")}` : `${r.scope.jids?.length ?? 0} grupo(s)`}</Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground truncate">{describe(r)}</p>
                                    <p className="text-[11px] text-muted-foreground">{r.runs ?? 0} execuções · última {fmtDate(r.lastRunAt)}</p>
                                </div>
                                <Button variant="ghost" size="sm" onClick={() => setEditing(r)}><Pencil className="h-4 w-4" /></Button>
                                <Button variant="ghost" size="sm" onClick={() => remove(r)}><Trash2 className="h-4 w-4" /></Button>
                            </div>
                        ))}
                        {!rules.length && <p className="p-4 text-sm text-center text-muted-foreground">Nenhuma automação ainda. Comece por um modelo acima.</p>}
                    </div>
                )}
            </CardContent>
            <RuleEditor rule={editing} base={base} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        </Card>
    );
}

function RuleEditor({ rule, base, onClose, onSaved }: { rule: Rule | null; base: string; onClose: () => void; onSaved: () => void }) {
    const [r, setR] = useState<Rule | null>(rule);
    const [actionsJson, setActionsJson] = useState("");
    const [scopeMode, setScopeMode] = useState<"all" | "tags">("all");
    const [scopeTags, setScopeTags] = useState("");

    // recarrega o formulário quando outra regra é aberta
    const [loadedRule, setLoadedRule] = useState<Rule | null>(null);
    if (loadedRule !== rule) {
        setLoadedRule(rule);
        setR(rule);
        if (rule) {
            setActionsJson(JSON.stringify(rule.actions, null, 2));
            setScopeMode(rule.scope.all ? "all" : "tags");
            setScopeTags((rule.scope.tags || []).join(", "));
        }
    }
    if (!r) return null;

    const cfg = r.triggerConfig || {};
    const setCfg = (patch: Rule["triggerConfig"]) => setR({ ...r, triggerConfig: { ...cfg, ...patch } });

    const save = async () => {
        let actions: Record<string, unknown>[];
        try { actions = JSON.parse(actionsJson); } catch { return toast.error("Ações: JSON inválido"); }
        const body = {
            name: r.name, active: r.active ?? true, priority: r.priority ?? 100,
            scope: scopeMode === "all" ? { all: true } : { tags: splitList(scopeTags) },
            trigger: r.trigger, triggerConfig: cfg, actions,
            ignoreAdmins: r.ignoreAdmins ?? true, cooldownSec: r.cooldownSec ?? 0,
        };
        const res = r.id ? await api(`${base}/${r.id}`, { method: "PATCH", json: body }) : await api(base, { method: "POST", json: body });
        if (res) { toast.success("Automação salva"); onSaved(); }
    };

    return (
        <Dialog open={!!rule} onOpenChange={o => !o && onClose()}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader><DialogTitle>{r.id ? "Editar automação" : "Nova automação"}</DialogTitle></DialogHeader>
                <div className="space-y-3">
                    {r.description && <p className="text-sm text-muted-foreground">{r.description}</p>}
                    <div className="space-y-1"><Label>Nome</Label><Input value={r.name} onChange={e => setR({ ...r, name: e.target.value })} /></div>
                    <div className="space-y-1">
                        <Label>Onde vale</Label>
                        <div className="flex gap-2 items-center">
                            <select className="h-9 rounded border bg-background px-2 text-sm" value={scopeMode} onChange={e => setScopeMode(e.target.value as "all" | "tags")}>
                                <option value="all">Todos os grupos</option><option value="tags">Grupos com as tags</option>
                            </select>
                            {scopeMode === "tags" && <Input placeholder="lancamento, clientes" value={scopeTags} onChange={e => setScopeTags(e.target.value)} />}
                        </div>
                    </div>
                    <div className="space-y-1">
                        <Label>Quando</Label>
                        <select className="h-9 w-full rounded border bg-background px-2 text-sm" value={r.trigger} onChange={e => setR({ ...r, trigger: e.target.value })}>
                            {Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </div>
                    {r.trigger === "message" && (
                        <div className="space-y-2 border rounded p-3">
                            <select className="h-9 w-full rounded border bg-background px-2 text-sm" value={cfg.match ?? "contains"} onChange={e => setCfg({ match: e.target.value })}>
                                {Object.entries(MATCHES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                            </select>
                            {["contains", "exact", "starts_with"].includes(cfg.match ?? "contains") && <Textarea rows={2} placeholder="palavras ou frases, separadas por vírgula" value={(cfg.keywords || []).join(", ")} onChange={e => setCfg({ keywords: splitList(e.target.value) })} />}
                            {cfg.match === "regex" && <Input placeholder="ex.: cupom\s*\w+" value={cfg.pattern || ""} onChange={e => setCfg({ pattern: e.target.value })} />}
                            {cfg.match === "flood" && (
                                <div className="flex gap-2 items-center text-sm">mais de <Input type="number" className="w-20" value={cfg.maxMessages ?? 6} onChange={e => setCfg({ maxMessages: Number(e.target.value) })} /> mensagens em <Input type="number" className="w-20" value={cfg.perSeconds ?? 10} onChange={e => setCfg({ perSeconds: Number(e.target.value) })} /> segundos</div>
                            )}
                            <label className="flex items-center gap-2 text-sm"><Switch checked={r.ignoreAdmins ?? true} onCheckedChange={v => setR({ ...r, ignoreAdmins: v })} />Ignorar mensagens de admins</label>
                        </div>
                    )}
                    {r.trigger === "schedule" && (
                        <div className="space-y-1 border rounded p-3">
                            <Input placeholder="0 22 * * *" value={cfg.cron || ""} onChange={e => setCfg({ cron: e.target.value })} />
                            <p className="text-xs text-muted-foreground">Formato cron (minuto hora dia mês dia-da-semana), no fuso das configurações. Ex.: <code>0 22 * * *</code> = todo dia às 22h; <code>0 9 * * 1-5</code> = dias úteis às 9h.</p>
                        </div>
                    )}
                    <div className="space-y-1">
                        <Label>Ações (em ordem)</Label>
                        <Textarea rows={8} className="font-mono text-xs" value={actionsJson} onChange={e => setActionsJson(e.target.value)} />
                        <p className="text-xs text-muted-foreground">
                            Tipos: send_message {"{text, mentionAll, mentionMember, media}"}, reply {"{text}"}, delete_message, warn {"{text, max, then}"}, remove_member, set_announce {"{value}"}, notify, stop.
                            Variáveis: {"{{nome}} {{grupo}} {{membros}} {{mencao}} {{advertencias}} {{max}} {{data}} {{hora}}"}.
                        </p>
                    </div>
                    <div className="space-y-1"><Label>Intervalo mínimo entre execuções (segundos, por pessoa e grupo)</Label><Input type="number" value={r.cooldownSec ?? 0} onChange={e => setR({ ...r, cooldownSec: Number(e.target.value) })} /></div>
                    <Button className="w-full" onClick={save}>Salvar</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
