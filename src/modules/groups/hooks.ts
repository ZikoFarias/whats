import type { WAMessage, WASocket } from "@whiskeysockets/baileys";
import { recordGroupMessage } from "./sync";
import { runMessageAutomations } from "./automations";

/**
 * Called for every new (notify) group message after it is stored.
 * Updates member activity; automations plug in here as well.
 */
export async function onGroupMessage(sock: WASocket, sessionId: string, dbSessionId: string, msg: WAMessage) {
    const groupJid = msg.key.remoteJid!;
    if (msg.key.fromMe) {
        await recordGroupMessage(dbSessionId, groupJid, null, null, new Date());
        return;
    }
    // Use the participant id exactly as WhatsApp reports it, so it matches GroupMember.memberJid
    const participant = msg.key.participant || msg.participant || null;
    const at = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();
    await recordGroupMessage(dbSessionId, groupJid, participant, msg.pushName, at);
    await runMessageAutomations(sock, sessionId, dbSessionId, msg);
}
