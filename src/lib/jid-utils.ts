import { prisma } from "./prisma";
import { logger } from "./logger";

/**
 * Check if a JID is in @lid format (WhatsApp Linked ID)
 */
export function isLidJid(jid: string | undefined | null): boolean {
    if (!jid) return false;
    return jid.endsWith("@lid");
}

/**
 * Normalize a JID to standard format.
 * Primarily ensures that @c.us is converted to @s.whatsapp.net.
 * Does not touch @g.us or @broadcast.
 */
export function normalizeJid(jid: string | undefined | null): string {
    if (!jid) return "";
    if (jid.endsWith("@c.us")) {
        return jid.replace("@c.us", "@s.whatsapp.net");
    }
    return jid;
}

/**
 * Resolve a @lid JID to @s.whatsapp.net phone number JID.
 * 
 * Resolution strategy:
 *   1. Inline remoteJidAlt (from Baileys message key) if provided
 *   2. DB Contact lookup (contact.remoteJidAlt or matching by lid field)
 *   3. Falls back to the original JID if no resolution is found
 *
 * For non-LID JIDs: returns the original JID unchanged.
 * For group JIDs (@g.us) or broadcast: returns unchanged.
 */
export async function resolveToPhoneJid(
    jid: string,
    dbSessionId: string,
    inlineAlt?: string | null
): Promise<string> {
    if (!jid) return jid;

    // Only resolve if it's a @lid JID
    if (!isLidJid(jid)) return jid;

    // 1. Use inline remoteJidAlt if provided
    if (inlineAlt && !isLidJid(inlineAlt)) {
        return inlineAlt;
    }

    // 2. Try DB lookup
    try {
        const contact = await prisma.contact.findFirst({
            where: {
                sessionId: dbSessionId,
                OR: [
                    { jid: jid },
                    { lid: jid }
                ]
            },
            select: { jid: true, remoteJidAlt: true, lid: true }
        });

        if (contact) {
            // If remoteJidAlt is a phone JID, use it
            if (contact.remoteJidAlt && !isLidJid(contact.remoteJidAlt)) {
                return contact.remoteJidAlt;
            }
            // If the primary jid is a phone JID, use it
            if (contact.jid && !isLidJid(contact.jid)) {
                return contact.jid;
            }
        }
    } catch (e) {
        logger.error("JID", `resolveToPhoneJid: DB lookup failed for ${jid}`, e);
    }

    // 3. Fallback: return original JID
    return jid;
}

/**
 * Resolve a @lid JID using sessionId (string, e.g., "session-01") instead of dbSessionId (cuid).
 * This is a convenience wrapper that first looks up the DB session ID.
 */
export async function resolveToPhoneJidBySessionId(
    jid: string,
    sessionId: string,
    inlineAlt?: string | null
): Promise<string> {
    if (!jid || !isLidJid(jid)) return jid;

    // 1. Use inline remoteJidAlt if provided
    if (inlineAlt && !isLidJid(inlineAlt)) {
        return inlineAlt;
    }

    try {
        const session = await prisma.session.findUnique({
            where: { sessionId },
            select: { id: true }
        });

        if (session) {
            return resolveToPhoneJid(jid, session.id, inlineAlt);
        }
    } catch (e) {
        logger.error("JID", `resolveToPhoneJidBySessionId: Session lookup failed for ${sessionId}`, e);
    }

    return jid;
}

/**
 * Batch resolve multiple JIDs at once (efficient for lists).
 * Builds a LID→Phone lookup map from the Contact table in a single query,
 * then applies it to all provided JIDs.
 */
export async function batchResolveToPhoneJid(
    jids: string[],
    dbSessionId: string
): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const lids = jids.filter(j => isLidJid(j));

    // No LIDs to resolve, return identity map
    if (lids.length === 0) {
        jids.forEach(j => result.set(j, j));
        return result;
    }

    // Batch query: find contacts that match any of the LID JIDs
    try {
        const contacts = await prisma.contact.findMany({
            where: {
                sessionId: dbSessionId,
                OR: [
                    { jid: { in: lids } },
                    { lid: { in: lids } }
                ]
            },
            select: { jid: true, lid: true, remoteJidAlt: true }
        });

        // Build lookup map
        for (const c of contacts) {
            const phoneJid = (c.remoteJidAlt && !isLidJid(c.remoteJidAlt))
                ? c.remoteJidAlt
                : (!isLidJid(c.jid) ? c.jid : null);

            if (phoneJid) {
                // Map by jid (if it's a LID)
                if (isLidJid(c.jid)) {
                    result.set(c.jid, phoneJid);
                }
                // Map by lid field
                if (c.lid && isLidJid(c.lid)) {
                    result.set(c.lid, phoneJid);
                }
            }
        }
    } catch (e) {
        logger.error("JID", `batchResolveToPhoneJid: DB query failed`, e);
    }

    // Fill in any un-resolved JIDs with themselves
    for (const jid of jids) {
        if (!result.has(jid)) {
            result.set(jid, jid);
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Recipient resolution (phone number -> real WhatsApp JID)
// ---------------------------------------------------------------------------

const recipientCache = new Map<string, { jid: string; expiresAt: number }>();
const RECIPIENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Digits of a phone number, with the default country code added to numbers
 * typed in national format. Only raw input (no "@") is treated as national:
 * full JIDs come from WhatsApp itself and are already international.
 *
 * With DEFAULT_COUNTRY_CODE=55 (default), 10-11 digits = DDD + number, so
 * "61985850383" becomes "5561985850383" instead of being read as +61 (Australia).
 */
export function normalizePhoneDigits(input: string): string {
    const raw = (input || "").trim();
    const digits = raw.split("@")[0].split(":")[0].replace(/\D/g, "").replace(/^0+/, "");
    const countryCode = (process.env.DEFAULT_COUNTRY_CODE ?? "55").replace(/\D/g, "");
    if (!raw.includes("@") && countryCode === "55" && (digits.length === 10 || digits.length === 11)) {
        return `55${digits}`;
    }
    return digits;
}

/**
 * Brazilian mobile numbers may be registered on WhatsApp with or without the
 * extra "9" digit. Returns both variants so we can ask WhatsApp which exists.
 */
function brazilianVariants(digits: string): string[] {
    if (!digits.startsWith("55")) return [digits];
    const ddd = digits.slice(2, 4);
    const local = digits.slice(4);
    if (local.length === 9 && local.startsWith("9")) {
        return [digits, `55${ddd}${local.slice(1)}`];
    }
    if (local.length === 8 && /^[6-9]/.test(local)) {
        return [digits, `55${ddd}9${local}`];
    }
    return [digits];
}

/**
 * Resolve any recipient input ("5561999999999", "+55 (61) 99999-9999",
 * "5561999999999@s.whatsapp.net", "...@c.us") to the JID WhatsApp really uses.
 * Groups, LIDs, broadcast and newsletter JIDs are returned unchanged.
 * Throws if the number is not on WhatsApp.
 */
export async function resolveRecipientJid(
    socket: { onWhatsApp: (...jids: string[]) => Promise<any> },
    input: string
): Promise<string> {
    const raw = (input || "").trim();
    if (/@(g\.us|lid|broadcast|newsletter)$/.test(raw)) return raw;

    const digits = normalizePhoneDigits(raw);
    if (digits.length < 8) {
        throw new Error(`Invalid recipient: "${input}"`);
    }

    const cached = recipientCache.get(digits);
    if (cached && cached.expiresAt > Date.now()) return cached.jid;

    for (const candidate of brazilianVariants(digits)) {
        const result = await socket.onWhatsApp(candidate);
        const hit = Array.isArray(result) ? result.find((r: any) => r?.exists && r?.jid) : null;
        if (hit) {
            const jid = normalizeJid(hit.jid);
            recipientCache.set(digits, { jid, expiresAt: Date.now() + RECIPIENT_CACHE_TTL_MS });
            return jid;
        }
    }

    throw new Error(`Number ${digits} is not on WhatsApp`);
}
