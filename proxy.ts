import { NextRequest, NextResponse } from "next/server";

// default 모드는 iframe 안에서 사이트 경로를 깨끗하게 보이려고
// history.replaceState로 URL을 `/blog?__pxorigin=https://site.com` 형태로 정규화한다.
// 뒤로가기/새로고침으로 그 경로가 서버에 다시 들어오면(=__pxorigin 마커 존재)
// 우리 Next.js 앱이 아니라 프록시로 다시 태워야 한다.
export function proxy(req: NextRequest) {
  const { searchParams, pathname } = req.nextUrl;
  const pxorigin = searchParams.get("__pxorigin");
  if (!pxorigin) return NextResponse.next();

  const rest = new URLSearchParams(searchParams);
  rest.delete("__pxorigin");
  const restStr = rest.toString();
  const target = pxorigin + pathname + (restStr ? `?${restStr}` : "");

  const url = req.nextUrl.clone();
  url.pathname = "/api/proxy";
  url.search = `?url=${encodeURIComponent(target)}`;
  return NextResponse.rewrite(url);
}

// /api, /_next, 정적 파일은 건너뜀. 나머지 경로만 __pxorigin 여부로 분기.
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
