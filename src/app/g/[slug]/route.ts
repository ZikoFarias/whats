import { NextRequest, NextResponse } from "next/server";
import { resolveLinkClick } from "@/modules/groups/links";

export const dynamic = "force-dynamic";

function page(title: string, text: string, status: number) {
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f5f5f5;color:#222}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:22px}p{color:#555;line-height:1.5}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
    return new NextResponse(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/** Public smart link: /g/{slug}?utm_source=... -> next WhatsApp group with room */
export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    const q = request.nextUrl.searchParams;
    const result = await resolveLinkClick(slug.toLowerCase(), {
        utmSource: q.get("utm_source"), utmMedium: q.get("utm_medium"),
        utmCampaign: q.get("utm_campaign"), utmContent: q.get("utm_content"),
        referrer: request.headers.get("referer"),
    });
    if (!result) return page("Link não encontrado", "Este link de grupo não existe ou foi desativado.", 404);
    if (!result.url) return page("Grupos lotados", "Todos os grupos estão cheios no momento. Tente novamente mais tarde.", 503);
    return NextResponse.redirect(result.url, { status: 302, headers: { "Cache-Control": "no-store" } });
}
