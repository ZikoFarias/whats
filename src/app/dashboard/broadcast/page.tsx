"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@/components/ui/dialog";
import { RefreshCw, Send, CheckCircle2, XCircle, Radio, Clock, AlertTriangle, History, Eye, Calendar, Pause, Play, Ban, PauseCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useSession } from "@/components/dashboard/session-provider";
import { SessionGuard } from "@/components/dashboard/session-guard";
import { useSocket } from "@/components/chat/socket-context";

interface BroadcastProgress {
    broadcastId: string;
    sessionId?: string;
    status: "running" | "paused" | "completed" | "cancelled";
    total: number;
    pending?: number;
    cancelled?: number;
    pauseReason?: string | null;
    note?: string;
    sent: number;
    failed: number;
    current?: string | null;
    progress?: number;
    errors?: { jid: string; error: string }[];
    startedAt?: string;
    completedAt?: string;
}

interface BroadcastLog {
    id: string;
    sessionId: string;
    message: string;
    total: number;
    sent: number;
    failed: number;
    status: string;
    pauseReason?: string | null;
    waitingReason?: string | null;
    delay: number;
    startedAt: string;
    completedAt: string | null;
    _count?: { recipients: number };
    recipients?: BroadcastRecipient[];
}

interface BroadcastRecipient {
    id: string;
    jid: string;
    status: string;
    error: string | null;
    sentAt: string | null;
}

export default function BroadcastPage() {
    const { sessionId } = useSession();
    const [contacts, setContacts] = useState("");
    const [message, setMessage] = useState("");
    const [delay, setDelay] = useState([12000]);
    const [mediaUrl, setMediaUrl] = useState("");
    const [mediaType, setMediaType] = useState<"image" | "video" | "document">("image");
    const [loading, setLoading] = useState(false);
    const [broadcastProgress, setBroadcastProgress] = useState<BroadcastProgress | null>(null);
    const [activeTab, setActiveTab] = useState<"new" | "history">("new");

    // History
    const [history, setHistory] = useState<BroadcastLog[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [selectedLog, setSelectedLog] = useState<BroadcastLog | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);

    const { getSocket, joinSession } = useSocket();

    // Socket for progress updates
    useEffect(() => {
        const socket = getSocket();
        if (!socket || !sessionId) return;

        const onConnect = () => joinSession(sessionId);
        if (socket.connected) joinSession(sessionId);
        socket.on("connect", onConnect);

        const handler = (data: BroadcastProgress) => {
            // The socket stays in rooms of previously selected numbers: ignore their campaigns
            if (data.sessionId && data.sessionId !== sessionId) return;
            setBroadcastProgress(prev => (prev && prev.broadcastId === data.broadcastId && !data.note && prev.note && data.status === "running")
                ? { ...data, note: undefined }
                : data);
            if (data.status === "paused" || data.status === "cancelled") {
                setLoading(false);
                fetchHistory();
                if (data.status === "paused" && data.pauseReason) toast.warning(`Broadcast paused: ${data.pauseReason}`);
            }
            if (data.status === "completed") {
                setLoading(false);
                // Refresh history after completion
                fetchHistory();
                if (data.failed === 0) {
                    toast.success(`Broadcast complete! ${data.sent} sent.`);
                } else {
                    toast.warning(`Broadcast complete. ${data.sent} sent, ${data.failed} failed.`);
                }
            }
        };

        socket.on("broadcast.progress", handler);
        return () => { socket.off("connect", onConnect); socket.off("broadcast.progress", handler); };
    }, [sessionId, getSocket, joinSession]);

    // Fetch history
    const fetchHistory = useCallback(async () => {
        if (!sessionId) return;
        setHistoryLoading(true);
        try {
            const res = await fetch(`/api/messages/${sessionId}/broadcast/history?limit=20`);
            if (res.ok) {
                const data = await res.json();
                setHistory(data.data || []);
            }
        } catch (e) {
            console.error("Failed to fetch broadcast history", e);
        } finally {
            setHistoryLoading(false);
        }
    }, [sessionId]);

    // Load history on mount & tab switch
    useEffect(() => {
        if (activeTab === "history" && sessionId) {
            fetchHistory();
        }
    }, [activeTab, sessionId, fetchHistory]);

    // Open detail modal
    const openDetail = async (log: BroadcastLog) => {
        setSelectedLog(log);
        setDetailOpen(true);
        setDetailLoading(true);
        try {
            const res = await fetch(`/api/messages/${sessionId}/broadcast/history/${log.id}`);
            if (res.ok) {
                const data = await res.json();
                setSelectedLog(data.data);
            }
        } catch (e) {
            console.error("Failed to fetch broadcast detail", e);
        } finally {
            setDetailLoading(false);
        }
    };

    const handleSend = async () => {
        if (!sessionId) return toast.error("No active session found");
        if (!message.trim() && !mediaUrl.trim()) return toast.error("Message cannot be empty");
        setLoading(true);
        setBroadcastProgress(null);

        try {
            // Send numbers as typed: the server adds the country code and resolves the real WhatsApp JID
            const recipients = contacts.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);

            if (recipients.length === 0) {
                toast.error("No recipients specified");
                setLoading(false);
                return;
            }

            const res = await fetch(`/api/messages/${sessionId}/broadcast`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    recipients,
                    message,
                    delay: delay[0],
                    ...(mediaUrl.trim() ? { media: { type: mediaType, url: mediaUrl.trim() } } : {})
                })
            });

            const data = await res.json();

            if (res.ok) {
                toast.info(`Broadcast queued for ${data.data?.total ?? recipients.length} recipients (${data.data?.withExistingChat ?? 0} with existing chat)`);
                if (data.data?.notice) toast.warning(data.data.notice, { duration: 10000 });
            } else {
                toast.error(data.message || "Failed to start broadcast");
                setLoading(false);
            }
        } catch (e) {
            console.error(e);
            toast.error("Error sending broadcast");
            setLoading(false);
        }
    };

    const campaignAction = async (broadcastId: string, action: "pause" | "resume" | "cancel") => {
        if (action === "cancel" && !confirm("Cancel this broadcast? Pending recipients will not be sent.")) return;
        try {
            const res = await fetch(`/api/messages/${sessionId}/broadcast/${broadcastId}/${action}`, { method: "POST" });
            const data = await res.json();
            if (res.ok) {
                toast.success(data.message);
                if (action === "resume") setLoading(true);
                fetchHistory();
            } else {
                toast.error(data.message || `Failed to ${action}`);
            }
        } catch {
            toast.error(`Failed to ${action}`);
        }
    };

    const recipientCount = contacts.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean).length;
    const formatJid = (jid: string) => {
        if (!jid) return "-";
        return jid.replace("@s.whatsapp.net", "").replace("@g.us", " (Group)");
    };

    const formatTime = (ts: string) => {
        const d = new Date(ts);
        return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const tabs = [
        { id: "new" as const, label: "New Broadcast", icon: Send },
        { id: "history" as const, label: "History", icon: History },
    ];

    return (
        <SessionGuard>
            <div className="space-y-6">
                <div>
                    <h2 className="text-xl sm:text-3xl font-bold tracking-tight">Broadcast / Blast</h2>
                    <p className="text-muted-foreground text-sm mt-1">Send bulk messages to multiple recipients at once.</p>
                </div>

                {/* Tabs */}
                <div className="flex gap-1 bg-muted/50 p-1 rounded-lg w-fit">
                    {tabs.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-all ${
                                activeTab === tab.id
                                    ? "bg-background shadow-sm text-foreground"
                                    : "text-muted-foreground hover:text-foreground"
                            }`}
                        >
                            <tab.icon className="h-4 w-4" />
                            {tab.label}
                        </button>
                    ))}
                </div>

                {activeTab === "new" && (
                    <>
                        <div className="grid gap-4 sm:gap-6 grid-cols-1 md:grid-cols-2">
                            {/* Recipients Card */}
                            <Card>
                                <CardHeader>
                                    <CardTitle>Recipients</CardTitle>
                                    <CardDescription>One number per line (or comma separated). Numbers without country code are treated as Brazilian (DDD + number).</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-2">
                                        <Label>Target Numbers (e.g., 61999998888 or 5561999998888)</Label>
                                        <Textarea
                                            placeholder={"61999998888\n5511988887777"}
                                            className="min-h-[200px] font-mono text-sm"
                                            value={contacts}
                                            onChange={e => setContacts(e.target.value)}
                                            disabled={loading}
                                        />
                                        <p className="text-xs text-muted-foreground">{recipientCount} numbers identified</p>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Message Card */}
                            <Card>
                                <CardHeader>
                                    <CardTitle>Message Content</CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-2">
                                        <Label>Message</Label>
                                        <Textarea
                                            placeholder="Type your message here..."
                                            className="min-h-[150px]"
                                            value={message}
                                            onChange={e => setMessage(e.target.value)}
                                            disabled={loading}
                                        />
                                        <p className="text-xs text-muted-foreground">Use {"{{nome}}"} style variables when sending via API with per-recipient variables.</p>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>Media URL (optional)</Label>
                                        <div className="flex gap-2">
                                            <select
                                                className="h-9 rounded-md border bg-background px-2 text-sm"
                                                value={mediaType}
                                                onChange={e => setMediaType(e.target.value as "image" | "video" | "document")}
                                                disabled={loading}
                                            >
                                                <option value="image">Image</option>
                                                <option value="video">Video</option>
                                                <option value="document">Document</option>
                                            </select>
                                            <Input
                                                placeholder="https://..."
                                                value={mediaUrl}
                                                onChange={e => setMediaUrl(e.target.value)}
                                                disabled={loading}
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-4 pt-4">
                                        <div className="space-y-2">
                                            <Label>Delay: {(delay[0] / 1000).toFixed(1)}s</Label>
                                            <Slider
                                                defaultValue={[12000]}
                                                min={5000}
                                                max={60000}
                                                step={1000}
                                                value={delay}
                                                onValueChange={setDelay}
                                                disabled={loading}
                                            />
                                            <p className="text-xs text-muted-foreground">Delay between messages (randomized up to 2x). Daily limits and sending hours are enforced per number.</p>
                                        </div>

                                        <Button
                                            className="w-full"
                                            onClick={handleSend}
                                            disabled={loading || !sessionId || recipientCount === 0 || (!message.trim() && !mediaUrl.trim())}
                                        >
                                            {loading ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                                            {loading ? "Broadcasting..." : "Queue Broadcast"}
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        {/* Live Progress */}
                        {broadcastProgress && (
                            <Card className={`border-2 transition-colors ${
                                broadcastProgress.status === "completed"
                                    ? (broadcastProgress.failed === 0 ? "border-green-500/30 bg-green-50/30 dark:bg-green-950/10" : "border-yellow-500/30 bg-yellow-50/30 dark:bg-yellow-950/10")
                                    : "border-blue-500/30 bg-blue-50/30 dark:bg-blue-950/10"
                            }`}>
                                <CardHeader className="pb-3">
                                    <CardTitle className="flex items-center gap-2 text-lg">
                                        {broadcastProgress.status === "running" ? (
                                            <><Radio className="h-5 w-5 text-blue-500 animate-pulse" /><span>Broadcast In Progress</span></>
                                        ) : broadcastProgress.status === "paused" ? (
                                            <><PauseCircle className="h-5 w-5 text-yellow-500" /><span>Broadcast Paused</span></>
                                        ) : broadcastProgress.status === "cancelled" ? (
                                            <><Ban className="h-5 w-5 text-muted-foreground" /><span>Broadcast Cancelled</span></>
                                        ) : broadcastProgress.failed === 0 ? (
                                            <><CheckCircle2 className="h-5 w-5 text-green-500" /><span>Broadcast Completed</span></>
                                        ) : (
                                            <><AlertTriangle className="h-5 w-5 text-yellow-500" /><span>Broadcast Completed with Errors</span></>
                                        )}
                                    </CardTitle>
                                    <CardDescription>ID: {broadcastProgress.broadcastId}</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="space-y-2">
                                        <div className="flex justify-between text-sm">
                                            <span className="text-muted-foreground">Progress</span>
                                            <span className="font-mono font-medium">
                                                {broadcastProgress.sent + broadcastProgress.failed} / {broadcastProgress.total} ({broadcastProgress.progress || 0}%)
                                            </span>
                                        </div>
                                        <Progress value={broadcastProgress.progress || 0} className="h-3" />
                                    </div>

                                    <div className="grid grid-cols-3 gap-3">
                                        <div className="bg-background rounded-lg p-3 text-center border">
                                            <div className="text-2xl font-bold text-green-600">{broadcastProgress.sent}</div>
                                            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1 mt-1">
                                                <CheckCircle2 className="h-3 w-3" /> Sent
                                            </div>
                                        </div>
                                        <div className="bg-background rounded-lg p-3 text-center border">
                                            <div className="text-2xl font-bold text-red-500">{broadcastProgress.failed}</div>
                                            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1 mt-1">
                                                <XCircle className="h-3 w-3" /> Failed
                                            </div>
                                        </div>
                                        <div className="bg-background rounded-lg p-3 text-center border">
                                            <div className="text-2xl font-bold text-muted-foreground">
                                                {broadcastProgress.pending ?? (broadcastProgress.total - broadcastProgress.sent - broadcastProgress.failed)}
                                            </div>
                                            <div className="text-xs text-muted-foreground flex items-center justify-center gap-1 mt-1">
                                                <Clock className="h-3 w-3" /> Pending
                                            </div>
                                        </div>
                                    </div>

                                    {broadcastProgress.status === "paused" && broadcastProgress.pauseReason && (
                                        <div className="flex items-center gap-2 text-sm px-3 py-2 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 rounded-lg">
                                            <AlertTriangle className="h-4 w-4 shrink-0" />
                                            <span>{broadcastProgress.pauseReason}</span>
                                        </div>
                                    )}

                                    {broadcastProgress.status === "running" && broadcastProgress.note && (
                                        <div className="flex items-center gap-2 text-sm px-3 py-2 bg-muted/50 rounded-lg">
                                            <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                                            <span className="text-muted-foreground">{broadcastProgress.note}</span>
                                        </div>
                                    )}

                                    {(broadcastProgress.status === "running" || broadcastProgress.status === "paused") && (
                                        <div className="flex gap-2">
                                            {broadcastProgress.status === "running" ? (
                                                <Button variant="outline" size="sm" onClick={() => campaignAction(broadcastProgress.broadcastId, "pause")}>
                                                    <Pause className="h-4 w-4 mr-1" /> Pause
                                                </Button>
                                            ) : (
                                                <Button variant="outline" size="sm" onClick={() => campaignAction(broadcastProgress.broadcastId, "resume")}>
                                                    <Play className="h-4 w-4 mr-1" /> Resume
                                                </Button>
                                            )}
                                            <Button variant="outline" size="sm" onClick={() => campaignAction(broadcastProgress.broadcastId, "cancel")}>
                                                <Ban className="h-4 w-4 mr-1" /> Cancel
                                            </Button>
                                        </div>
                                    )}

                                    {broadcastProgress.status === "running" && broadcastProgress.current && !broadcastProgress.note && (
                                        <div className="flex items-center gap-2 text-sm px-3 py-2 bg-muted/50 rounded-lg">
                                            <RefreshCw className="h-3.5 w-3.5 animate-spin text-blue-500" />
                                            <span className="text-muted-foreground">Now sending:</span>
                                            <span className="font-mono font-medium">{formatJid(broadcastProgress.current)}</span>
                                        </div>
                                    )}

                                    {broadcastProgress.status === "completed" && broadcastProgress.errors && broadcastProgress.errors.length > 0 && (
                                        <div className="space-y-2">
                                            <h4 className="text-sm font-semibold text-red-600 flex items-center gap-1.5">
                                                <XCircle className="h-4 w-4" /> Failed ({broadcastProgress.errors.length})
                                            </h4>
                                            <div className="max-h-40 overflow-y-auto bg-red-50 dark:bg-red-950/30 rounded-lg p-2 space-y-1">
                                                {broadcastProgress.errors.map((err, i) => (
                                                    <div key={i} className="flex justify-between items-center text-xs py-1 px-2 bg-background/60 rounded">
                                                        <span className="font-mono">{formatJid(err.jid)}</span>
                                                        <span className="text-red-500 truncate ml-2 max-w-[200px]">{err.error}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>
                        )}
                    </>
                )}

                {activeTab === "history" && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <History className="h-5 w-5" />
                                Broadcast History
                            </CardTitle>
                            <CardDescription>History of sent broadcasts, stored permanently.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {historyLoading ? (
                                <div className="flex items-center justify-center py-8">
                                    <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                                </div>
                            ) : history.length === 0 ? (
                                <div className="text-center py-8 text-muted-foreground">
                                    <p className="text-sm">Belum ada broadcast.</p>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {history.map(log => (
                                        <div key={log.id}
                                            className="flex items-center gap-4 p-3 rounded-lg border hover:bg-muted/30 transition-colors"
                                        >
                                            {/* Status icon */}
                                            <div className="shrink-0">
                                                {log.status === "completed" ? (
                                                    log.failed === 0
                                                        ? <CheckCircle2 className="h-8 w-8 text-green-500" />
                                                        : <AlertTriangle className="h-8 w-8 text-yellow-500" />
                                                ) : log.status === "paused" ? (
                                                    <PauseCircle className="h-8 w-8 text-yellow-500" />
                                                ) : log.status === "cancelled" ? (
                                                    <Ban className="h-8 w-8 text-muted-foreground" />
                                                ) : (
                                                    <Radio className="h-8 w-8 text-blue-500 animate-pulse" />
                                                )}
                                            </div>

                                            {/* Info */}
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-medium truncate">{log.message}</p>
                                                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                                                    <span className="flex items-center gap-1">
                                                        <CheckCircle2 className="h-3 w-3 text-green-500" /> {log.sent}
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <XCircle className="h-3 w-3 text-red-500" /> {log.failed}
                                                    </span>
                                                    <span className="flex items-center gap-1">
                                                        <Calendar className="h-3 w-3" /> {formatTime(log.startedAt)}
                                                    </span>
                                                </div>
                                                {log.status === "paused" && log.pauseReason && (
                                                    <p className="text-xs text-yellow-600 mt-1 truncate">{log.pauseReason}</p>
                                                )}
                                                {log.status === "running" && log.waitingReason && (
                                                    <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1 truncate">
                                                        <Clock className="h-3 w-3 shrink-0" /> Waiting: {log.waitingReason}
                                                    </p>
                                                )}
                                            </div>

                                            {/* Campaign controls */}
                                            {log.status === "running" && (
                                                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => campaignAction(log.id, "pause")} title="Pause">
                                                    <Pause className="h-4 w-4" />
                                                </Button>
                                            )}
                                            {log.status === "paused" && (
                                                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => campaignAction(log.id, "resume")} title="Resume">
                                                    <Play className="h-4 w-4" />
                                                </Button>
                                            )}
                                            {(log.status === "running" || log.status === "paused") && (
                                                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => campaignAction(log.id, "cancel")} title="Cancel">
                                                    <Ban className="h-4 w-4" />
                                                </Button>
                                            )}

                                            {/* View button */}
                                            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => openDetail(log)}>
                                                <Eye className="h-4 w-4 mr-1" /> Detail
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}

                {/* Detail Modal */}
                <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
                    <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
                        <DialogHeader>
                            <DialogTitle className="flex items-center gap-2">
                                {selectedLog?.status === "completed"
                                    ? <CheckCircle2 className="h-5 w-5 text-green-500" />
                                    : <Radio className="h-5 w-5 text-blue-500 animate-pulse" />
                                }
                                Broadcast Detail
                            </DialogTitle>
                        </DialogHeader>

                        {detailLoading ? (
                            <div className="flex items-center justify-center py-8">
                                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
                            </div>
                        ) : selectedLog ? (
                            <div className="flex flex-col gap-4 overflow-hidden min-h-0">
                                {/* Summary */}
                                <div className="grid grid-cols-3 gap-3">
                                    <div className="bg-muted/30 rounded-lg p-3 text-center">
                                        <div className="text-xl font-bold text-green-600">{selectedLog.sent}</div>
                                        <div className="text-xs text-muted-foreground">Sent</div>
                                    </div>
                                    <div className="bg-muted/30 rounded-lg p-3 text-center">
                                        <div className="text-xl font-bold text-red-500">{selectedLog.failed}</div>
                                        <div className="text-xs text-muted-foreground">Failed</div>
                                    </div>
                                    <div className="bg-muted/30 rounded-lg p-3 text-center">
                                        <div className="text-xl font-bold">{selectedLog.total}</div>
                                        <div className="text-xs text-muted-foreground">Total</div>
                                    </div>
                                </div>

                                {/* Message */}
                                <div className="bg-muted/30 rounded-lg p-3">
                                    <p className="text-xs text-muted-foreground mb-1">Message:</p>
                                    <p className="text-sm whitespace-pre-wrap break-words">{selectedLog.message}</p>
                                </div>

                                {/* Time */}
                                <div className="flex gap-4 text-xs text-muted-foreground">
                                    <span>Started: {formatTime(selectedLog.startedAt)}</span>
                                    {selectedLog.completedAt && <span>Completed: {formatTime(selectedLog.completedAt)}</span>}
                                </div>

                                {/* Recipients list */}
                                {selectedLog.recipients && selectedLog.recipients.length > 0 && (
                                    <div className="flex-1 overflow-y-auto min-h-0">
                                        <h4 className="text-sm font-semibold mb-2">Recipients ({selectedLog.recipients.length})</h4>
                                        <div className="space-y-1">
                                            {selectedLog.recipients.map(r => (
                                                <div key={r.id}
                                                    className={`flex items-center justify-between gap-2 text-xs py-1.5 px-2 rounded ${
                                                        r.status === "sent" ? "bg-green-500/5" :
                                                        r.status === "failed" ? "bg-red-500/5" : "bg-muted/30"
                                                    }`}
                                                >
                                                    <span className="font-mono truncate">{formatJid(r.jid)}</span>
                                                    <div className="flex items-center gap-2 shrink-0">
                                                        <span className={`px-1.5 py-0.5 rounded font-medium ${
                                                            r.status === "sent" ? "text-green-600 bg-green-500/10" :
                                                            r.status === "failed" ? "text-red-500 bg-red-500/10" : "text-muted-foreground bg-muted/50"
                                                        }`}>
                                                            {r.status}
                                                        </span>
                                                        {r.error && (
                                                            <span className="text-red-500 max-w-[200px] truncate" title={r.error}>{r.error}</span>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : null}
                    </DialogContent>
                </Dialog>
            </div>
        </SessionGuard>
    );
}
