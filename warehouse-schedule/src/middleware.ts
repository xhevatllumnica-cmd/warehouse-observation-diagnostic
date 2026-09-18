import { NextResponse, type NextRequest } from "next/server";

/**
 * Mbrojtje opsionale me HTTP Basic Auth.
 *
 * Aktivizohet vetëm kur vendosen BASIC_AUTH_USER dhe BASIC_AUTH_PASSWORD.
 * Është një hap i thjeshtë para se të shtohet autentikim i plotë
 * (Supabase Auth / NextAuth) me role për menaxherët.
 */
export function middleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;
  if (!user || !password) return NextResponse.next();

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const [u, ...rest] = atob(header.slice(6)).split(":");
    if (safeEqual(u, user) && safeEqual(rest.join(":"), password)) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Kërkohet autentikimi.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Orari i Warehouse", charset="UTF-8"' },
  });
}

/** Krahasim me kohë konstante, që të mos zbulohet fjalëkalimi nga koha e përgjigjes. */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
