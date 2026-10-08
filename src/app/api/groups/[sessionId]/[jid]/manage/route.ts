import { NextRequest } from "next/server";
import { z } from "zod";
import { withSession, readJson } from "@/lib/route-helpers";
import { updateGroupSettings, updateMembers, getInviteLink, resync, leaveGroup, getGroup, assertGroupJid } from "@/modules/groups/service";

const schema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("settings"),
        subject: z.string().min(1).max(100).optional(),
        description: z.string().max(2048).optional(),
        announce: z.boolean().optional(),          // only admins can send
        restrict: z.boolean().optional(),          // only admins can edit info
        memberAddMode: z.enum(["admin_add", "all_member_add"]).optional(),
        joinApprovalMode: z.boolean().optional(),  // admins approve join requests
        ephemeralSeconds: z.number().int().min(0).optional(), // 0 = off, 86400, 604800, 7776000
    }),
    z.object({ action: z.enum(["add", "remove", "promote", "demote"]), participants: z.array(z.string().min(3)).min(1).max(200) }),
    z.object({ action: z.literal("invite_link"), revoke: z.boolean().optional() }),
    z.object({ action: z.literal("sync") }),
    z.object({ action: z.literal("leave") }),
]);

/**
 * POST /api/groups/{sessionId}/{jid}/manage — one endpoint for every admin action:
 * settings | add | remove | promote | demote (phones or JIDs) | invite_link | sync | leave
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ sessionId: string; jid: string }> }) {
    const { sessionId, jid } = await params;
    return withSession(request, sessionId, async () => {
        const groupJid = assertGroupJid(jid);
        const body = schema.parse(await readJson(request));
        switch (body.action) {
            case "settings": {
                const { action: _a, ...settings } = body;
                await updateGroupSettings(sessionId, groupJid, settings);
                return getGroup(sessionId, groupJid);
            }
            case "invite_link": return getInviteLink(sessionId, groupJid, body.revoke);
            case "sync": await resync(sessionId, groupJid); return getGroup(sessionId, groupJid);
            case "leave": await leaveGroup(sessionId, groupJid); return { left: true };
            default: return updateMembers(sessionId, groupJid, body.action, body.participants);
        }
    });
}
