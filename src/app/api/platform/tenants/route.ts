import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

const tenantSchema = z.object({
    saasId: z.string().trim().min(2).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i),
    externalTenantId: z.string().trim().min(1).max(191),
    displayName: z.string().trim().min(1).max(120).optional(),
});

function authorized(request: NextRequest): boolean {
    const expected = Buffer.from(process.env.WA_AKG_PLATFORM_API_KEY || "");
    const received = Buffer.from(request.headers.get("x-platform-api-key") || "");
    return expected.length >= 32
        && received.length === expected.length
        && timingSafeEqual(received, expected);
}

function tenantEmail(saasId: string, externalTenantId: string): string {
    const digest = createHash("sha256")
        .update(`${saasId}\0${externalTenantId}`)
        .digest("hex");
    return `tenant-${digest}@wa-akg.invalid`;
}

export async function POST(request: NextRequest) {
    if (!authorized(request)) {
        return NextResponse.json({ status: false, error: "Unauthorized" }, { status: 401 });
    }

    let input: z.infer<typeof tenantSchema> | null = null;
    try {
        const parsed = tenantSchema.safeParse(await request.json());
        if (!parsed.success) {
            return NextResponse.json({ status: false, error: parsed.error.flatten() }, { status: 400 });
        }

        input = parsed.data;
        const { saasId, externalTenantId } = parsed.data;
        const displayName = parsed.data.displayName || `${saasId} / ${externalTenantId}`;
        const unique = { saasId_externalTenantId: { saasId, externalTenantId } };

        const prior = await prisma.platformTenant.findUnique({
            where: unique,
            include: { user: { select: { id: true, apiKey: true } } },
        });
        if (prior) {
            const apiKey = prior.user.apiKey || generateApiKey();
            await prisma.$transaction([
                prisma.user.update({ where: { id: prior.userId }, data: { apiKey } }),
                prisma.platformTenant.update({ where: unique, data: { displayName } }),
            ]);
            return NextResponse.json({
                status: true,
                data: { accountId: prior.userId, apiKey, sessionsEndpoint: "/api/sessions" },
            });
        }

        const email = tenantEmail(saasId, externalTenantId);
        const collision = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (collision) {
            return NextResponse.json({ status: false, error: "Tenant identity conflict" }, { status: 409 });
        }

        const apiKey = generateApiKey();
        const password = await bcrypt.hash(randomBytes(48).toString("base64url"), 12);
        const created = await prisma.$transaction(async (tx) => {
            const user = await tx.user.create({
                data: { email, name: displayName, password, role: "OWNER", apiKey },
                select: { id: true },
            });
            await tx.platformTenant.create({ data: { saasId, externalTenantId, displayName, userId: user.id } });
            return user;
        });

        return NextResponse.json({
            status: true,
            data: { accountId: created.id, apiKey, sessionsEndpoint: "/api/sessions" },
        }, { status: 201 });
    } catch (error) {
        // A retry after a concurrent first provision returns the same scoped key.
        if (input) {
            const { saasId, externalTenantId } = input;
            const prior = await prisma.platformTenant.findUnique({
                where: { saasId_externalTenantId: { saasId, externalTenantId } },
                include: { user: { select: { id: true, apiKey: true } } },
            }).catch(() => null);
            if (prior?.user.apiKey) {
                return NextResponse.json({ status: true, data: {
                    accountId: prior.userId,
                    apiKey: prior.user.apiKey,
                    sessionsEndpoint: "/api/sessions",
                } });
            }
        }
        console.error("WA-AKG tenant provisioning failed:", error);
        return NextResponse.json({ status: false, error: "Tenant provisioning failed" }, { status: 500 });
    }
}
