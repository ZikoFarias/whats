"use client";

import { toast } from "sonner";

export interface GroupRow {
    jid: string;
    subject: string | null;
    description: string | null;
    size: number | null;
    myRole: string | null;
    isAdmin: boolean;
    tags: string[];
    notes: string | null;
    announce: boolean | null;
    restrict: boolean | null;
    memberAddMode: boolean | null;
    joinApprovalMode: boolean | null;
    ephemeralDuration: number | null;
    isCommunity: boolean;
    lastActivityAt: string | null;
}

export interface MemberRow {
    memberJid: string;
    phone: string | null;
    name: string | null;
    role: string;
    isActive: boolean;
    joinedAt: string | null;
    leftAt: string | null;
    messageCount: number;
    lastMessageAt: string | null;
    warnings: number;
}

/** fetch JSON from the WA-AKG API; shows a toast and returns null on error */
export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown; quiet?: boolean }): Promise<T | null> {
    try {
        const res = await fetch(url, {
            ...init,
            headers: { ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
            body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.status === false) {
            const msg = typeof data.message === "string" ? data.message : `Erro ${res.status}`;
            if (!init?.quiet) toast.error(msg);
            return null;
        }
        return (data.data ?? data) as T;
    } catch (e) {
        if (!init?.quiet) toast.error(e instanceof Error ? e.message : "Erro de rede");
        return null;
    }
}

export const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

export const roleLabel: Record<string, string> = { superadmin: "Criador", admin: "Admin", member: "Membro" };

export function phoneLabel(jid: string, phone?: string | null): string {
    const p = phone || (jid.endsWith("@s.whatsapp.net") ? jid.split("@")[0] : null);
    if (!p) return jid.split("@")[0];
    return p.startsWith("55") && p.length >= 12 ? `+55 (${p.slice(2, 4)}) ${p.slice(4, -4)}-${p.slice(-4)}` : `+${p}`;
}

/** "a, b , c" -> ["a","b","c"] */
export const splitList = (s: string) => s.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
