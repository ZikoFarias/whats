"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyRound, Plus, Copy, Ban, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/components/dashboard/session-provider";

interface ApiKeyItem {
    id: string;
    name: string;
    prefix: string;
    scopes: string[];
    sessionIds: string[] | null;
    lastUsedAt: string | null;
    expiresAt: string | null;
    revokedAt: string | null;
    createdAt: string;
    active: boolean;
}

const formatDate = (d: string | null) => (d ? new Date(d).toLocaleString() : "—");

export default function ApiKeysPage() {
    const { sessions } = useSession();
    const [keys, setKeys] = useState<ApiKeyItem[]>([]);
    const [scopeInfo, setScopeInfo] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);

    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState("");
    const [scopes, setScopes] = useState<string[]>(["read", "send"]);
    const [allSessions, setAllSessions] = useState(true);
    const [selectedSessions, setSelectedSessions] = useState<string[]>([]);
    const [expiresInDays, setExpiresInDays] = useState("");
    const [creating, setCreating] = useState(false);
    const [newKey, setNewKey] = useState<string | null>(null);

    const fetchKeys = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/api-keys");
            const data = await res.json();
            if (res.ok) {
                setKeys(data.data.keys);
                setScopeInfo(data.data.scopes);
            } else {
                toast.error(data.message || "Failed to load API keys");
            }
        } catch {
            toast.error("Failed to load API keys");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchKeys(); }, [fetchKeys]);

    const toggle = (list: string[], value: string) =>
        list.includes(value) ? list.filter(v => v !== value) : [...list, value];

    const resetForm = () => {
        setName("");
        setScopes(["read", "send"]);
        setAllSessions(true);
        setSelectedSessions([]);
        setExpiresInDays("");
    };

    const handleCreate = async () => {
        if (!name.trim()) return toast.error("Give the key a name (e.g. CRM, n8n)");
        if (scopes.length === 0) return toast.error("Select at least one scope");
        if (!allSessions && selectedSessions.length === 0) return toast.error("Select at least one number");
        setCreating(true);
        try {
            const res = await fetch("/api/api-keys", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name.trim(),
                    scopes,
                    ...(allSessions ? {} : { sessionIds: selectedSessions }),
                    ...(expiresInDays ? { expiresInDays: parseInt(expiresInDays, 10) } : {}),
                }),
            });
            const data = await res.json();
            if (res.ok) {
                setNewKey(data.data.key);
                setCreateOpen(false);
                resetForm();
                fetchKeys();
            } else {
                toast.error(typeof data.message === "string" ? data.message : "Failed to create key");
            }
        } catch {
            toast.error("Failed to create key");
        } finally {
            setCreating(false);
        }
    };

    const handleRevoke = async (key: ApiKeyItem) => {
        if (!confirm(`Revoke "${key.name}"? Systems using it will stop working immediately.`)) return;
        const res = await fetch(`/api/api-keys/${key.id}`, { method: "DELETE" });
        const data = await res.json();
        if (res.ok) {
            toast.success("API key revoked");
            fetchKeys();
        } else {
            toast.error(data.message || "Failed to revoke");
        }
    };

    const copy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            toast.success("Copied");
        } catch {
            toast.error("Copy failed, select the key and copy it manually");
        }
    };

    const sessionName = (sid: string) => sessions.find(s => s.sessionId === sid)?.name || sid;

    return (
        <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h2 className="text-xl sm:text-3xl font-bold tracking-tight">API Keys</h2>
                    <p className="text-muted-foreground text-sm mt-1">
                        One key per integrated system, each with its own permissions and numbers. Send it in the <code>x-api-key</code> header.
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={fetchKeys} disabled={loading}>
                        <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
                    </Button>
                    <Button onClick={() => setCreateOpen(true)}>
                        <Plus className="h-4 w-4 mr-2" /> New key
                    </Button>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> Keys</CardTitle>
                    <CardDescription>The full key is shown only once, when created. Revoked keys are kept for reference.</CardDescription>
                </CardHeader>
                <CardContent>
                    {loading ? (
                        <div className="flex justify-center py-8"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                    ) : keys.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-8">No keys yet. Create one for each system that will use this hub.</p>
                    ) : (
                        <div className="space-y-2">
                            {keys.map(k => (
                                <div key={k.id} className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border ${k.active ? "" : "opacity-60"}`}>
                                    <div className="flex-1 min-w-0 space-y-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-medium">{k.name}</span>
                                            <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{k.prefix}…</code>
                                            {!k.active && (
                                                <span className="text-xs text-red-500">{k.revokedAt ? "revoked" : "expired"}</span>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                            {k.scopes.map(s => (
                                                <span key={s} className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">{s === "*" ? "all scopes" : s}</span>
                                            ))}
                                        </div>
                                        <p className="text-xs text-muted-foreground">
                                            Numbers: {k.sessionIds ? k.sessionIds.map(sessionName).join(", ") : "all"} · Last used: {formatDate(k.lastUsedAt)}
                                            {k.expiresAt && <> · Expires: {formatDate(k.expiresAt)}</>}
                                        </p>
                                    </div>
                                    {k.active && (
                                        <Button variant="outline" size="sm" onClick={() => handleRevoke(k)}>
                                            <Ban className="h-4 w-4 mr-1" /> Revoke
                                        </Button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Create */}
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                    <DialogHeader><DialogTitle>New API key</DialogTitle></DialogHeader>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label>Name (which system will use it)</Label>
                            <Input placeholder="CRM, n8n, Lovable app..." value={name} onChange={e => setName(e.target.value)} maxLength={60} />
                        </div>

                        <div className="space-y-2">
                            <Label>Permissions</Label>
                            <div className="space-y-2">
                                {Object.entries(scopeInfo).map(([scope, description]) => (
                                    <label key={scope} className="flex items-start gap-2 text-sm cursor-pointer">
                                        <input type="checkbox" className="mt-1" checked={scopes.includes(scope)} onChange={() => setScopes(toggle(scopes, scope))} />
                                        <span><span className="font-medium">{scope}</span> — <span className="text-muted-foreground">{description}</span></span>
                                    </label>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label>WhatsApp numbers</Label>
                            <label className="flex items-center gap-2 text-sm cursor-pointer">
                                <input type="checkbox" checked={allSessions} onChange={() => setAllSessions(!allSessions)} />
                                All numbers I can access
                            </label>
                            {!allSessions && (
                                <div className="space-y-1 pl-6">
                                    {sessions.map(s => (
                                        <label key={s.sessionId} className="flex items-center gap-2 text-sm cursor-pointer">
                                            <input type="checkbox" checked={selectedSessions.includes(s.sessionId)} onChange={() => setSelectedSessions(toggle(selectedSessions, s.sessionId))} />
                                            {s.name} <span className="text-xs text-muted-foreground">({s.sessionId})</span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label>Expires in (days, optional)</Label>
                            <Input type="number" min={1} placeholder="Never" value={expiresInDays} onChange={e => setExpiresInDays(e.target.value)} />
                        </div>

                        <Button className="w-full" onClick={handleCreate} disabled={creating}>
                            {creating ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />}
                            Create key
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Show once */}
            <Dialog open={!!newKey} onOpenChange={open => { if (!open) setNewKey(null); }}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-green-500" /> Key created</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <p className="text-sm text-muted-foreground">Copy it now and store it in the other system. It will not be shown again.</p>
                        <div className="flex gap-2">
                            <Input readOnly value={newKey || ""} className="font-mono text-xs" onFocus={e => e.target.select()} />
                            <Button variant="outline" onClick={() => newKey && copy(newKey)}><Copy className="h-4 w-4" /></Button>
                        </div>
                        <Button className="w-full" onClick={() => setNewKey(null)}>Done</Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
