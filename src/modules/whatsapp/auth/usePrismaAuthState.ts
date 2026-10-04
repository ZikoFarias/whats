import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { AuthenticationCreds, AuthenticationState, BufferJSON, initAuthCreds, SignalDataTypeMap } from "@whiskeysockets/baileys";
import { logger } from "@/lib/logger";

const ENCRYPTED_AUTH_MARKER = "__waAkgAuthState";

function getAuthStateEncryptionKey(): Buffer {
    const encodedKey = process.env.WA_AKG_AUTH_STATE_ENCRYPTION_KEY;
    if (!encodedKey) {
        throw new Error("WA_AKG_AUTH_STATE_ENCRYPTION_KEY is required to persist WhatsApp credentials");
    }

    const key = Buffer.from(encodedKey, "base64url");
    if (key.length !== 32) {
        throw new Error("WA_AKG_AUTH_STATE_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }
    return key;
}

function encryptAuthState(serialized: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", getAuthStateEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
    return {
        [ENCRYPTED_AUTH_MARKER]: 1,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        data: ciphertext.toString("base64url"),
    };
}

function decryptAuthState(value: unknown): unknown {
    if (!value || typeof value !== "object" || (value as Record<string, unknown>)[ENCRYPTED_AUTH_MARKER] !== 1) {
        // Keep existing plaintext records readable while they are upgraded on the next write.
        return value;
    }

    const encrypted = value as { iv: string; tag: string; data: string };
    const decipher = createDecipheriv(
        "aes-256-gcm",
        getAuthStateEncryptionKey(),
        Buffer.from(encrypted.iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
    return Buffer.concat([
        decipher.update(Buffer.from(encrypted.data, "base64url")),
        decipher.final(),
    ]).toString("utf8");
}

export const usePrismaAuthState = async (sessionId: string): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> => {
    
    // Helper to read JSON with Buffer handling
    const readData = async (type: string, id: string) => {
        try {
            const key = `${type}-${id}`;
            const data = await prisma.authState.findUnique({
                where: { sessionId_key: { sessionId, key } }
            });
            if (data && data.value) {
                const value = decryptAuthState(data.value);
                if (typeof value === "string") {
                    return JSON.parse(value, BufferJSON.reviver);
                }
                return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            logger.error("Auth", 'Error reading auth state:', error);
            return null;
        }
    };

    // Helper to write data
    const writeData = async (type: string, id: string, data: any) => {
        try {
            const key = `${type}-${id}`;
            const value = encryptAuthState(JSON.stringify(data, BufferJSON.replacer));
            
            await prisma.authState.upsert({
                where: { sessionId_key: { sessionId, key } },
                create: { sessionId, key, value },
                update: { value }
            });
        } catch (error) {
             logger.error("Auth", 'Error writing auth state:', error);
        }
    };

    const removeData = async (type: string, id: string) => {
        try {
            const key = `${type}-${id}`;
             await prisma.authState.deleteMany({
                where: { sessionId, key }
            });
        } catch (error) {
            // ignore
        }
    }


    const creds: AuthenticationCreds = (await readData('creds', 'me')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [key: string]: SignalDataTypeMap[typeof type] } = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(type, id);
                        if (type === 'app-state-sync-key' && value) {
                            value = BufferJSON.reviver(null, value);
                        }
                        if (value) {
                            data[id] = value;
                        }
                    }));
                    return data;
                },
                set: async (data) => {
                     const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        const categoryData = data[category as keyof typeof data];
                        if (!categoryData) continue;
                        
                        for (const id in categoryData) {
                            const value = categoryData[id];
                             if (value) {
                                tasks.push(writeData(category, id, value));
                            } else {
                                tasks.push(removeData(category, id));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            await writeData('creds', 'me', creds);
        }
    }
}
