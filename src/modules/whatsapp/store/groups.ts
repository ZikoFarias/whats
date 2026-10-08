import type { WASocket } from "@whiskeysockets/baileys";
import { logger } from "@/lib/logger";
import { syncAllGroups } from "@/modules/groups/sync";

/** Initial group sync on connect (members, roles, our role). See modules/groups/sync.ts */
export async function syncGroups(sock: WASocket, sessionId: string) {
    try {
        await syncAllGroups(sock, sessionId, false);
    } catch (e) {
        logger.error("Store", "Failed to sync groups", e);
    }
}
