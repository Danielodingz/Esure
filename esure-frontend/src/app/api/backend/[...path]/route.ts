import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const backendUrl = process.env.ESURE_BACKEND_URL ?? "http://127.0.0.1:3001";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  return forward(request, context, "GET");
}

export async function POST(request: NextRequest, context: RouteContext) {
  return forward(request, context, "POST");
}

async function forward(request: NextRequest, context: RouteContext, method: "GET" | "POST") {
  const { path } = await context.params;
  if (!isAllowedPath(path, method)) {
    return NextResponse.json({ error: { code: "PROXY_ROUTE_DENIED", message: "Route is not available." } }, { status: 404 });
  }

  const target = new URL(path.map(encodeURIComponent).join("/"), `${backendUrl.replace(/\/$/, "")}/`);
  const response = await fetch(target, {
    method,
    headers: { accept: "application/json", ...(method === "POST" && { "content-type": "application/json" }) },
    body: method === "POST" ? await request.text() : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);

  if (!response) {
    return NextResponse.json(
      { error: { code: "BACKEND_UNAVAILABLE", message: "Esure Backend is unavailable. Start it and try again." } },
      { status: 503 },
    );
  }

  const body = await response.text();
  const contentDisposition = response.headers.get("content-disposition");
  const retryAfter = response.headers.get("retry-after");
  return new NextResponse(body, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      ...(contentDisposition && { "content-disposition": contentDisposition }),
      ...(retryAfter && { "retry-after": retryAfter }),
    },
  });
}

export function isAllowedPath(path: string[], method: "GET" | "POST"): boolean {
  if (path.some((part) => !/^[a-zA-Z0-9-]+$/.test(part))) return false;
  if (method === "POST") return path.length === 3 && path.join("/") === "api/v1/runs";
  if (path.join("/") === "health" || path.join("/") === "api/v1/scenarios") return true;
  if (method === "GET" && path.length === 4 && path.slice(0, 3).join("/") === "api/v1/scenarios") return true;
  const isRunPath = path.slice(0, 3).join("/") === "api/v1/runs";
  return isRunPath && (path.length === 4 || (path.length === 5 && path[4] === "report"));
}
