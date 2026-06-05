import { NextRequest } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";

// nodejs 런타임 필수: edge fetch는 TLS cert 검증을 우회할 수 없다. 일부 사이트
// (spidercore.io, bigtech.co.kr 등)는 intermediate CA를 안 보내 undici가
// UNABLE_TO_VERIFY_LEAF_SIGNATURE로 연결 실패(curl/브라우저는 AIA/시스템 CA로 보완).
// 아래 tlsFetch가 cert 실패 시에만 검증을 완화해 재시도한다. default/compat은 무변경.
export const runtime = "nodejs";

// === auto mode ===
// compat 라우트를 베이스로 한 "보강 누적" 모드. default/compat은 건드리지 않고
// auto 라우트에만 추가 처리를 쌓아 가장 강력한 호환 모드로 운영한다.
// 경로 prefix는 /api/proxy/a/{encodedHost}/...

// cert 검증을 끈 dispatcher — 정상 사이트는 절대 타지 않고, 일반 fetch가
// cert 에러로 throw할 때만 폴백으로 사용한다(데모 프록시: 공개 마케팅 사이트만 fetch).
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

// 일반 fetch 우선 → cert/연결 실패 시 검증 완화 dispatcher로 1회 재시도.
// 폴백은 undici fetch를 직접 호출(Next가 래핑한 global fetch는 dispatcher 옵션을 무시함).
async function tlsFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const r = await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      dispatcher: insecureAgent,
    });
    return r as unknown as Response;
  }
}

type Proto = "http" | "https";
const PROTO_CACHE_KEY = "__seaProxyAutoProtoCache";
const protoCache: Map<string, Proto> =
  ((globalThis as unknown as Record<string, unknown>)[PROTO_CACHE_KEY] as
    | Map<string, Proto>
    | undefined) ??
  ((globalThis as unknown as Record<string, unknown>)[PROTO_CACHE_KEY] =
    new Map());

async function fetchWithProtocolFallback(
  host: string,
  pathAndSearch: string,
  init: RequestInit
): Promise<{ response: Response; protocol: Proto; finalUrl: string }> {
  const cached = protoCache.get(host);
  const order: Proto[] = cached
    ? [cached, cached === "https" ? "http" : "https"]
    : ["https", "http"];
  let lastErr: unknown = null;
  // A connection that "succeeds" can still be the wrong protocol: e.g. an HTTP-only
  // site whose https vhost answers 406/4xx — reachable only via the insecure-cert
  // tlsFetch fallback (jireheng: https→406, http→200). Before that fallback existed,
  // the https attempt THREW (cert error) and we naturally tried http; now it returns
  // a Response, so an error status must also trigger the other protocol. Keep the
  // first error response as a candidate in case both protocols fail.
  let badCandidate: { response: Response; protocol: Proto; finalUrl: string } | null =
    null;
  for (const proto of order) {
    const url = `${proto}://${host}${pathAndSearch}`;
    try {
      let response = await tlsFetch(url, init);
      // Some CDNs (e.g. static.wixstatic.com) intermittently 403/429 a burst of
      // edge-runtime fetches (bot/fingerprint heuristics). A single retry usually
      // clears the transient block.
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        try {
          const retry = await tlsFetch(url, init);
          if (retry.ok) response = retry;
        } catch {}
      }
      if (response.status >= 400) {
        // Keep only the FIRST error response (preferred protocol order) — if the
        // second protocol also errors we must not return/cache the second one
        // (e.g. asset 404 on http must win over the https vhost's blanket 406).
        if (!badCandidate) badCandidate = { response, protocol: proto, finalUrl: url };
        continue;
      }
      protoCache.set(host, proto);
      return { response, protocol: proto, finalUrl: url };
    } catch (e) {
      lastErr = e;
    }
  }
  if (badCandidate) {
    protoCache.set(host, badCandidate.protocol);
    return badCandidate;
  }
  throw lastErr;
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  return handleProxy(request, ctx);
}

// Sites XHR-POST to their own endpoints (e.g. unipromotion's module/site/site.php
// for menu/session state). Without a POST handler Next answers 405 and the site's
// init JS breaks. Forward method + body + content-type through the same pipeline.
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  return handleProxy(request, ctx);
}

async function handleProxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  if (!path || path.length === 0) {
    return new Response("Missing host segment", { status: 400 });
  }

  const host = decodeURIComponent(path[0]);
  const rest = path.slice(1).map(decodeURIComponent).join("/");
  // Next.js catch-all routes inject the dynamic segment value as `?path=...`
  // into nextUrl.search. Strip it so we don't forward it to upstream.
  const cleanParams = new URLSearchParams(request.nextUrl.search);
  cleanParams.delete("path");
  const searchStr = cleanParams.toString();
  const search = searchStr ? `?${searchStr}` : "";
  const pathAndSearch = `/${rest}${search}`;

  const proxyOrigin = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const encodedHost = encodeURIComponent(host);
  const proxyPrefix = `/api/proxy/a/${encodedHost}`;

  // Host variants we treat as "same site" → routed through the proxy. The browser
  // runs on a secure context (https in prod, http://localhost in dev, also secure),
  // so any absolute http:// (or even https:// to a host the page can't reach) subresource
  // is blocked as mixed content. Rewriting same-site absolute URLs to the proxy makes
  // them same-origin over the page's own protocol → no mixed content, no CORS.
  const hostLower = host.toLowerCase();
  const hostNoWww = hostLower.replace(/^www\./, "");
  const hostSet = new Set([hostLower, hostNoWww, "www." + hostNoWww]);
  // The final document URL (after redirects) — used to resolve RELATIVE urls server-side.
  // Assigned after the fetch. Relative "../" urls can't be fixed by <base href> alone:
  // under the proxy prefix, ".." climbs past the host path segment (e.g. "../inc/x" →
  // /api/proxy/a/inc/x, host "inc"), whereas the real site clamps ".." at the domain root.
  let docHref = "";
  const resolveRel = (u: string): string => {
    if (!docHref) return u;
    try {
      const abs = new URL(u, docHref);
      if (abs.protocol === "http:" || abs.protocol === "https:") {
        return `/api/proxy/a/${encodeURIComponent(abs.host)}${abs.pathname}${abs.search}${abs.hash}`;
      }
    } catch {}
    return u;
  };
  // Rewrite a single URL string (used for HTML attrs, srcset entries, CSS url()).
  // Leaves cross-origin URLs and relative URLs untouched.
  const toProxy = (u: string): string => {
    if (!u) return u;
    const t = u.trim();
    if (t.startsWith("data:") || t.startsWith("#") || t.startsWith("mailto:") || t.startsWith("tel:")) return u;
    // root-relative
    if (t.startsWith("/") && !t.startsWith("//")) {
      if (t.startsWith("/api/proxy")) return u;
      return proxyPrefix + t;
    }
    // absolute or protocol-relative to a same-site host
    const m = t.match(/^(?:https?:)?\/\/([^/?#]+)([/?#][^]*|)$/i);
    if (m) {
      const h = m[1].replace(/:\d+$/, "").toLowerCase();
      if (hostSet.has(h)) return proxyPrefix + (m[2] && m[2].startsWith("/") ? m[2] : "/" + (m[2] || ""));
      return u; // cross-origin absolute → leave for navigation/asset rules elsewhere
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return u; // other scheme (mailto already handled)
    // relative (e.g. ../inc/x, ./x, x) → resolve against the real doc URL → proxy path
    return resolveRel(t);
  };
  // For ASSETS (images, fonts, background-images): proxy only what MUST be proxied —
  //   • same-site (root-relative / same-host absolute): required for path-based proxying.
  //   • cross-origin http://: required, else mixed-content blocked on a secure-context page.
  // Cross-origin https:// is LEFT DIRECT: the browser loads it itself. Funneling every
  // cross-origin image through our single server IP triggers CDN burst rate-limits
  // (e.g. static.wixstatic.com 403s ~half of an 18-image burst — verified it's pure
  // rate-limit, not hotlink: it 200s any single cross-site request). Direct load spreads
  // across real user IPs in prod and avoids mixed content (https on https).
  const toProxyAsset = (u: string): string => {
    if (!u) return u;
    const t = u.trim();
    if (t.startsWith("data:") || t.startsWith("#") || t.startsWith("blob:")) return u;
    // root-relative → same site
    if (t.startsWith("/") && !t.startsWith("//")) {
      if (t.startsWith("/api/proxy")) return u;
      return proxyPrefix + t;
    }
    // protocol-relative //host (https on secure page): same-site → proxy, else direct
    if (t.startsWith("//")) {
      const m = t.match(/^\/\/([^/?#]+)([/?#][^]*|)$/);
      if (m && hostSet.has(m[1].replace(/:\d+$/, "").toLowerCase())) {
        return proxyPrefix + (m[2] && m[2].startsWith("/") ? m[2] : "/" + (m[2] || ""));
      }
      return u;
    }
    // http:// (any host) → must proxy (mixed content on secure-context page)
    const mh = t.match(/^http:\/\/([^/?#]+)([/?#][^]*|)$/i);
    if (mh) return `/api/proxy/a/${encodeURIComponent(mh[1].replace(/:\d+$/, ""))}${mh[2] && mh[2].startsWith("/") ? mh[2] : "/" + (mh[2] || "")}`;
    // https:// → same-site proxy; cross-origin left direct (browser loads it)
    const ms = t.match(/^https:\/\/([^/?#]+)([/?#][^]*|)$/i);
    if (ms) {
      if (hostSet.has(ms[1].replace(/:\d+$/, "").toLowerCase())) {
        return proxyPrefix + (ms[2] && ms[2].startsWith("/") ? ms[2] : "/" + (ms[2] || ""));
      }
      return u; // cross-origin https asset → load direct
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return u;
    // relative (e.g. ../img/x.png) → resolve server-side against the real doc URL so ".."
    // clamps at the site root (a path-prefixed <base href> would let it over-climb).
    return resolveRel(t);
  };
  // srcset is image assets → use the asset rewriter (cross-origin allowed).
  const rewriteSrcset = (val: string): string =>
    val
      .split(",")
      .map((part) => {
        const t = part.trim();
        const i = t.search(/\s/);
        const url = i === -1 ? t : t.slice(0, i);
        const rest = i === -1 ? "" : t.slice(i);
        return toProxyAsset(url) + rest;
      })
      .join(", ");
  // url(...) in CSS is images/fonts → asset rewriter (cross-origin allowed, fixes CORS fonts).
  // Relative url() is left alone — it resolves against the CSS file's own proxied URL.
  // LESS interpolation (url(@{var}/x)) is left untouched — rewriting would corrupt the
  // variable reference before client-side less.js compiles it.
  const rewriteCssUrls = (css: string): string =>
    css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) =>
      (u as string).includes("@{") ? m : `url(${q}${toProxyAsset(u)}${q})`);

  try {
    // POST: buffer the body up-front so the protocol-fallback can re-send it on a
    // second attempt (a consumed stream can't be replayed). Forward content-type
    // so form/JSON bodies parse upstream.
    const method = request.method === "POST" ? "POST" : "GET";
    const fetchHeaders: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    };
    // Forward the browser's cookies to upstream. Anti-bot JS challenges (e.g.
    // jireheng's CUPID/slowAES page, served to datacenter IPs like Vercel's) set a
    // cookie via document.cookie on OUR origin and re-enter with ?ckattempt=1 — the
    // challenge only clears if that cookie reaches the upstream server. Sites ignore
    // unknown cookies, so the shared demo-origin jar is harmless to forward.
    const cookie = request.headers.get("cookie");
    if (cookie) fetchHeaders["Cookie"] = cookie;
    let bodyBuf: ArrayBuffer | undefined;
    if (method === "POST") {
      bodyBuf = await request.arrayBuffer();
      const ct = request.headers.get("content-type");
      if (ct) fetchHeaders["Content-Type"] = ct;
      const xrw = request.headers.get("x-requested-with");
      if (xrw) fetchHeaders["X-Requested-With"] = xrw;
    }
    const { response: resp, protocol, finalUrl } = await fetchWithProtocolFallback(
      host,
      pathAndSearch,
      {
        method,
        headers: fetchHeaders,
        redirect: "follow",
        ...(bodyBuf !== undefined ? { body: bodyBuf } : {}),
      }
    );
    const targetOrigin = `${protocol}://${host}`;
    const fullUrl = new URL(finalUrl);
    // Base for resolving relative URLs: the final document URL (after redirects) when it's
    // the same host, else the requested URL.
    try {
      const ru = new URL(resp.url);
      docHref = ru.host === host ? ru.href : fullUrl.href;
    } catch {
      docHref = fullUrl.href;
    }

    const contentType = resp.headers.get("content-type") || "";

    // If upstream redirected to a different host (e.g. iocrops.com → www.iocrops.com),
    // redirect the iframe to the new proxy URL so TARGET_HOST stays in sync with the actual host.
    try {
      const respUrl = new URL(resp.url);
      if (respUrl.host !== host && contentType.includes("text/html")) {
        const newPath = `/api/proxy/a/${encodeURIComponent(respUrl.host)}${respUrl.pathname}${respUrl.search}`;
        // NB: do NOT use Response.redirect() — its headers are immutable and the
        // Next.js edge runtime throws "TypeError: immutable" while post-processing
        // them. Build the redirect manually so the headers stay mutable.
        return new Response(null, {
          status: 302,
          headers: { location: `${proxyOrigin}${newPath}` },
        });
      }
    } catch {}

    if (/\/sdr-widget[^/]*\.js$/.test(fullUrl.pathname)) {
      let js = await resp.text();
      js = js.replace(
        /var origin\s*=\s*script\.src\.replace\(.+?\);/,
        `var origin = '${targetOrigin}';`
      );
      js = js.replace(
        "if (event.origin !== origin) return;",
        `if (event.origin !== origin && event.origin !== '${proxyOrigin}') return;`
      );
      const locationPatch = `;(function(){
  if (typeof window.__sdrPageUrl !== 'string') {
    window.__sdrPageUrl = window.location.href;
  }
})();\n`;
      js = js.replace(
        /location\.href/g,
        "(window.__sdrPageUrl||location.href)"
      );
      return new Response(locationPatch + js, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        },
      });
    }

    // .less stylesheets compiled client-side by less.js (e.g. unipromotion). Upstream
    // often mislabels them text/html — without this branch they'd fall into the HTML
    // path, get the inject script + <base> prepended, and less.js would fail to compile
    // (silently dropping the site's entire generated layout CSS). Serve the raw source
    // with url() rewriting; less.js fetches via XHR and ignores content-type.
    if (/\.less$/i.test(fullUrl.pathname)) {
      const body = await resp.text();
      return new Response(rewriteCssUrls(body), {
        status: resp.status,
        headers: {
          "content-type": "text/css; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        },
      });
    }

    if (contentType.includes("javascript") || contentType.includes("text/css")) {
      let body = await resp.text();
      if (contentType.includes("text/css")) body = rewriteCssUrls(body);
      return new Response(body, {
        status: resp.status,
        headers: {
          "content-type": contentType,
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (!contentType.includes("text/html")) {
      const buf = await resp.arrayBuffer();
      return new Response(buf, {
        status: resp.status,
        headers: {
          "content-type": contentType || "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control":
            resp.headers.get("cache-control") || "public, max-age=3600",
        },
      });
    }

    let html = await resp.text();

    // Distinguish real DOCUMENT loads (top/iframe navigation) from XHR/fetch/etc that
    // happen to return text/html — via the browser's sec-fetch-dest header. Injecting
    // <head><script>+<base> into a non-document breaks consumers: less.js gets our
    // inject prepended to a .less mislabeled as text/html (compile error → site-wide
    // layout CSS lost), HTML fragments get a rogue <base>. Non-documents still get the
    // URL rewrites (fragments are inserted into the proxied DOM and need proxied URLs)
    // but no script/base injection, and keep the upstream status code.
    // No header (server-side tools, old browsers) → treat as document (old behavior).
    const fetchDest = request.headers.get("sec-fetch-dest");
    const isDocument =
      !fetchDest ||
      ["document", "iframe", "frame", "embed", "object"].includes(fetchDest);

    const injectedScripts = `<script data-proxy-auto="1">(function(){
var TARGET_ORIGIN=${JSON.stringify(targetOrigin)};
var TARGET_HOST=${JSON.stringify(host)};
var ENCODED_HOST=${JSON.stringify(encodedHost)};
var PROXY_ORIGIN=location.origin;
var PROXY_PREFIX='/api/proxy/a/'+ENCODED_HOST;
var PROXY_FULL=PROXY_ORIGIN+PROXY_PREFIX;
// Escape recovery: stash the proxied host (same-origin sessionStorage survives a hard
// navigation that escapes the proxy — e.g. a Next.js client router redirect whose route
// chunk 404s at bare origin and falls back to window.location). If the iframe ends up on
// our own app at a bare path, not-found.tsx reads this and re-enters via the proxy.
try{sessionStorage.setItem('__seaAutoHost',TARGET_HOST);}catch(e){}
function proxify(u){
if(typeof u!=='string')return u;
if(u.indexOf(PROXY_FULL)===0)return u;
if(u.indexOf(PROXY_ORIGIN+'/api/proxy')===0)return u;
if(u===TARGET_ORIGIN)return PROXY_FULL+'/';
if(u.indexOf(TARGET_ORIGIN+'/')===0)return PROXY_FULL+u.slice(TARGET_ORIGIN.length);
if(u.indexOf('//'+TARGET_HOST+'/')===0)return PROXY_FULL+u.slice(('//'+TARGET_HOST).length);
if(u==='//'+TARGET_HOST)return PROXY_FULL+'/';
// Page-origin absolute URL — e.g. webpack runtime builds chunk URLs as
// location.origin + '/_next/...' after we strip the proxy prefix from
// location.pathname. Route those through auto too.
if(u.indexOf(PROXY_ORIGIN+'/')===0)return PROXY_FULL+u.slice(PROXY_ORIGIN.length);
if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){
if(u.indexOf(PROXY_PREFIX+'/')===0||u===PROXY_PREFIX)return u;
if(u.indexOf('/api/proxy')===0)return u;
return PROXY_PREFIX+u;
}
return u;
}
// proxifyAsset (assets only: img/source/poster). Mirrors the server toProxyAsset rule:
// proxy same-site (any scheme) + cross-origin http:// (mixed content). Leave cross-origin
// https:// direct — funneling every image through our one IP trips CDN burst rate-limits
// (e.g. wixstatic), and direct https load has no mixed-content issue.
function proxifyAsset(u){
if(typeof u!=='string'||!u)return u;
if(u.indexOf('data:')===0||u.charAt(0)==='#'||u.indexOf('blob:')===0)return u;
if(u.indexOf('/api/proxy')===0||u.indexOf(PROXY_ORIGIN+'/api/proxy')===0)return u;
if(u.indexOf(PROXY_ORIGIN+'/')===0)u=u.slice(PROXY_ORIGIN.length);
// protocol-relative //host (https on secure page): same-site → proxy, else direct
if(u.indexOf('//')===0){var mm=u.match(/^\\/\\/([^\\/?#]+)([\\/?#][\\s\\S]*|)$/);if(mm&&(mm[1].replace(/:\\d+$/,'').toLowerCase()===TARGET_HOST||mm[1].replace(/:\\d+$/,'').toLowerCase()==='www.'+TARGET_HOST.replace(/^www\\./,'')))return PROXY_PREFIX+(mm[2]&&mm[2].charAt(0)==='/'?mm[2]:'/'+(mm[2]||''));return u;}
if(u.charAt(0)==='/')return PROXY_PREFIX+u;
// http:// (any host) → proxy (mixed content)
var mh=u.match(/^http:\\/\\/([^\\/?#]+)([\\/?#][\\s\\S]*|)$/i);
if(mh)return '/api/proxy/a/'+encodeURIComponent(mh[1].replace(/:\\d+$/,''))+(mh[2]&&mh[2].charAt(0)==='/'?mh[2]:'/'+(mh[2]||''));
// https:// → same-site proxy; cross-origin direct
var ms=u.match(/^https:\\/\\/([^\\/?#]+)([\\/?#][\\s\\S]*|)$/i);
if(ms){var h=ms[1].replace(/:\\d+$/,'').toLowerCase();if(h===TARGET_HOST.toLowerCase()||h===('www.'+TARGET_HOST.replace(/^www\\./,'')).toLowerCase())return PROXY_PREFIX+(ms[2]&&ms[2].charAt(0)==='/'?ms[2]:'/'+(ms[2]||''));return u;}
return u;
}
// proxifyNav: for NAVIGATIONS (location assign/replace/href, link clicks). Same-site via
// proxify; cross-origin absolute routed to /api/proxy/a/<host> so a programmatic redirect
// to another domain (e.g. a SPA that sends you to its app subdomain) stays wrapped in the
// proxy instead of escaping the iframe. NOT used for fetch/XHR (those keep direct CORS).
function proxifyNav(u){
if(typeof u!=='string'||!u)return u;
// Already-proxied URLs (server rewrites <a href> to /api/proxy/a/... so a.href
// resolves to PROXY_ORIGIN/api/proxy/...) must pass through UNTOUCHED — proxify()
// returns them unchanged, and without this guard the cross-origin branch below
// would see the proxy origin as a foreign host and double-wrap:
// /api/proxy/a/localhost/api/proxy/a/site/... (404/502 inside our own app).
if(u.indexOf('/api/proxy')===0)return u;
if(u.indexOf(PROXY_ORIGIN+'/api/proxy')===0)return u;
var p=proxify(u);
if(p!==u)return p;
var m=u.match(/^https?:\\/\\/([^\\/?#]+)([\\/?#][\\s\\S]*|)$/i);
if(m){var h=m[1].replace(/:\\d+$/,'').toLowerCase();if(h!==TARGET_HOST.toLowerCase())return '/api/proxy/a/'+encodeURIComponent(h)+(m[2]&&m[2].charAt(0)==='/'?m[2]:'/'+(m[2]||''));}
return u;
}
var _OrigURL=window.URL;
function PatchedURL(input,base){
var resolved;
try{resolved=arguments.length>1?new _OrigURL(input,base):new _OrigURL(input);}catch(e){throw e;}
if(resolved.origin===PROXY_ORIGIN&&(resolved.pathname===PROXY_PREFIX||resolved.pathname.indexOf(PROXY_PREFIX+'/')===0)){
var rest=resolved.pathname.slice(PROXY_PREFIX.length)||'/';
return new _OrigURL(rest+resolved.search+resolved.hash,TARGET_ORIGIN);
}
return resolved;
}
PatchedURL.prototype=_OrigURL.prototype;
['canParse','parse','createObjectURL','revokeObjectURL'].forEach(function(k){
if(typeof _OrigURL[k]==='function')PatchedURL[k]=_OrigURL[k].bind(_OrigURL);
});
try{Object.setPrototypeOf(PatchedURL,_OrigURL);}catch(e){}
try{window.URL=PatchedURL;}catch(e){}
var locProto=Location.prototype;
var origAssign=locProto.assign;
var origReplace=locProto.replace;
locProto.assign=function(u){return origAssign.call(this,proxifyNav(u));};
locProto.replace=function(u){return origReplace.call(this,proxifyNav(u));};
var hrefDesc=Object.getOwnPropertyDescriptor(locProto,'href');
if(hrefDesc&&hrefDesc.set){
try{
Object.defineProperty(locProto,'href',{
configurable:true,
enumerable:hrefDesc.enumerable,
get:hrefDesc.get,
set:function(v){hrefDesc.set.call(this,proxifyNav(v));}
});
}catch(e){}
}
var _origReplaceState=history.replaceState.bind(history);
var _origPushState=history.pushState.bind(history);
function safeHist(u){
if(u==null)return u;
try{
var s=String(u);
if(s===TARGET_ORIGIN||s.indexOf(TARGET_ORIGIN+'/')===0){
var pu=new _OrigURL(s);
return PROXY_PREFIX+pu.pathname+pu.search+pu.hash;
}
var p=new _OrigURL(s,location.href);
if(p.origin!==location.origin)return p.pathname+p.search+p.hash;
}catch(e){}
return u;
}
history.replaceState=function(s,t,u){try{_origReplaceState(s,t,safeHist(u));}catch(e){}};
history.pushState=function(s,t,u){try{_origPushState(s,t,safeHist(u));}catch(e){}};
var _origFetch=window.fetch;
window.fetch=function(resource,opts){
if(typeof resource==='string')resource=proxify(resource);
else if(resource&&typeof resource==='object'&&resource.url){
var u2=proxify(resource.url);
if(u2!==resource.url)resource=new Request(u2,resource);
}
return _origFetch.call(this,resource,opts);
};
var _origOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
var args=Array.prototype.slice.call(arguments);
args[1]=proxify(url);
return _origOpen.apply(this,args);
};
// ServiceWorker registration can't work through the proxy: the SW script URL resolves
// against our bare origin (404) and even proxied its scope wouldn't match. Sites
// (e.g. inupt's cafe24 sw.php) log a console TypeError on the failed registration.
// Return a forever-pending promise: no error, no unhandled rejection, demo needs no SW.
try{if(navigator.serviceWorker&&navigator.serviceWorker.register){navigator.serviceWorker.register=function(){return new Promise(function(){});};}}catch(e){}
var noop=function(){};noop.q=[];noop.c=noop;window.ChannelIO=noop;window.ChannelIOInitialized=true;
new MutationObserver(function(){
document.querySelectorAll('#ch-plugin,[id^="ch-plugin"],iframe[src*="channel.io"],[class*="ch-desk"],[id*="channel"]').forEach(function(el){el.remove()});
}).observe(document.documentElement,{childList:true,subtree:true});
// SPAs (Wix etc.) inject <img> via innerHTML, which bypasses setAttribute/src-setter
// patches. Observe the tree and re-route asset URLs through the proxy as elements appear,
// so cross-origin/hotlink-blocked images load. proxifyAsset is idempotent → no loop.
function _fixAssetEl(el){
if(!el||el.nodeType!==1)return;
var tn=el.tagName;if(tn!=='IMG'&&tn!=='SOURCE')return;
var s=el.getAttribute('src');if(s){var ns=proxifyAsset(s);if(ns!==s)el.setAttribute('src',ns);}
var ss=el.getAttribute('srcset');if(ss){var nss=proxifyAssetSrcset(ss);if(nss!==ss)el.setAttribute('srcset',nss);}
}
function _scanAssets(root){try{if(root.nodeType!==1)return;_fixAssetEl(root);if(root.querySelectorAll)Array.prototype.forEach.call(root.querySelectorAll('img,source'),_fixAssetEl);}catch(e){}}
new MutationObserver(function(muts){
for(var i=0;i<muts.length;i++){var m=muts[i];
if(m.type==='attributes')_fixAssetEl(m.target);
else for(var j=0;j<m.addedNodes.length;j++)_scanAssets(m.addedNodes[j]);}
}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','srcset']});
try{_scanAssets(document.documentElement);}catch(e){}
try{
var subPath=location.pathname.indexOf(PROXY_PREFIX)===0?location.pathname.slice(PROXY_PREFIX.length):'/';
if(!subPath)subPath='/';
// Strip the proxy prefix from location.pathname so client routers (Next.js etc.)
// see the same path the SSR rendered against.
history.replaceState(history.state,'',subPath+location.search+location.hash);
parent.postMessage({type:'proxy-navigation',url:TARGET_ORIGIN+subPath+location.search+location.hash},'*');
}catch(e){}
document.addEventListener('click',function(e){
var a=e.target&&e.target.closest&&e.target.closest('a');
if(!a||!a.href)return;
var raw=a.getAttribute('href')||'';
if(raw.charAt(0)==='#')return;
var pu=proxifyNav(a.href);
if(pu!==a.href||a.href.indexOf(PROXY_FULL)===0){
e.preventDefault();
e.stopImmediatePropagation();
location.assign(pu);
}
},true);
function proxifySrcset(s){
if(typeof s!=='string')return s;
return s.split(',').map(function(p){
var t=p.trim();var i=t.search(/\\s/);
if(i===-1)return proxify(t);
return proxify(t.slice(0,i))+t.slice(i);
}).join(', ');
}
function proxifyAssetSrcset(s){
if(typeof s!=='string')return s;
return s.split(',').map(function(p){
var t=p.trim();var i=t.search(/\\s/);
if(i===-1)return proxifyAsset(t);
return proxifyAsset(t.slice(0,i))+t.slice(i);
}).join(', ');
}
var _origSetAttr=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
var n=typeof name==='string'?name.toLowerCase():name;
var tn=this&&this.tagName;var asset=(tn==='IMG'||tn==='SOURCE');
if(n==='srcset'){value=asset?proxifyAssetSrcset(value):proxifySrcset(value);}
else if(typeof value==='string'){
if(n==='src'){value=asset?proxifyAsset(value):proxify(value);}
else if(n==='poster'){value=proxifyAsset(value);}
else if(n==='href'||n==='action'){value=proxify(value);}
}
return _origSetAttr.call(this,name,value);
};
[['HTMLScriptElement',0],['HTMLImageElement',1],['HTMLLinkElement',0],['HTMLIFrameElement',0],['HTMLSourceElement',1]].forEach(function(pair){
var t=pair[0],isAsset=pair[1];
var proto=window[t]&&window[t].prototype;if(!proto)return;
var fn=isAsset?proxifyAsset:proxify;var sfn=isAsset?proxifyAssetSrcset:proxifySrcset;
['src','href'].forEach(function(prop){
var d=Object.getOwnPropertyDescriptor(proto,prop);
if(!d||!d.set)return;
try{Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,fn(v));}});}catch(e){}
});
var ds=Object.getOwnPropertyDescriptor(proto,'srcset');
if(ds&&ds.set){try{Object.defineProperty(proto,'srcset',{configurable:true,enumerable:ds.enumerable,get:ds.get,set:function(v){ds.set.call(this,sfn(v));}});}catch(e){}}
});
})();</script>`;

    html = html.replace(/<script[^>]*sdr-widget[^"']*\.js[^>]*><\/script>/gi, "");
    html = html.replace(/<script[^>]*channel\.io[^>]*><\/script>/gi, "");
    html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, body) => {
      if (/ChannelIO/i.test(body)) return "";
      return match;
    });
    // <meta http-equiv="refresh" content="0;url=..."> escapes the proxy: its URL
    // resolves oddly under the proxy prefix (e.g. econanu's "url=default/" lands on
    // host "default"). Resolve it against the real document URL and route via proxy.
    html = html.replace(/<meta\b[^>]*http-equiv=(["'])refresh\1[^>]*>/gi, (tag) =>
      tag.replace(/content=(["'])([^"']*)\1/i, (_m, q, content) => {
        const mm = content.match(/^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i);
        if (!mm) return _m;
        let url = mm[2].trim().replace(/^["']|["']$/g, "");
        // Resolve against the real doc URL, then route through the proxy — INCLUDING
        // cross-origin targets (a meta-refresh to another domain, e.g. neostack→emblaze,
        // is a real navigation; keep it inside the proxy instead of escaping the iframe).
        let proxied: string;
        try {
          const abs = new URL(url, fullUrl.href);
          proxied = `/api/proxy/a/${encodeURIComponent(abs.host)}${abs.pathname}${abs.search}${abs.hash}`;
        } catch {
          proxied = toProxy(url);
        }
        return `content=${q}${mm[1]}${proxied}${q}`;
      })
    );
    // Images/<source> assets: route ANY src/srcset/poster (incl. cross-origin CDNs)
    // through the proxy. Done as a dedicated pass because the generic same-site rewrite
    // below leaves cross-origin URLs alone — but cross-origin image CDNs hotlink-block
    // cross-site browser fetches (403) and http:// images are mixed-content blocked.
    html = html.replace(/<(?:img|source)\b[^>]*>/gi, (tag) => {
      tag = tag.replace(/\b(src|data-src|data-original|poster)=(["'])([^"']*)\2/gi,
        (_m, a, q, v) => `${a}=${q}${toProxyAsset(v)}${q}`);
      tag = tag.replace(/\b(srcset|data-srcset)=(["'])([^"']*)\2/gi,
        (_m, a, q, v) => `${a}=${q}${rewriteSrcset(v)}${q}`);
      return tag;
    });
    // Rewrite href/src/action/poster in static HTML: root-relative AND same-site
    // absolute URLs (http://host, https://host, //host) → proxy. Absolute same-site
    // URLs must be rewritten here because the HTML parser fetches them before our
    // inject script's setter patches install, and a raw http:// subresource on a
    // secure-context page is mixed-content blocked.
    html = html.replace(
      /\b(href|src|action|poster)=(["'])([^"']*)\2/gi,
      (_m, attr, q, val) => `${attr}=${q}${toProxy(val)}${q}`
    );
    html = html.replace(
      /\bsrcset=(["'])([^"']*)\1/gi,
      (_m, q, val) => `srcset=${q}${rewriteSrcset(val)}${q}`
    );
    // Inline style="...url(...)..." and <style> blocks reference images/fonts too.
    html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs, css) => `<style${attrs}>${rewriteCssUrls(css)}</style>`);
    // style ATTRIBUTES with url(...) — e.g. unipromotion's hero
    // style="background: url(&quot;/img/x.jpg&quot;) ...". CSS in a style attribute
    // resolves root-relative urls against the page ORIGIN (ignores <base> path), so
    // /img/x lands on our bare origin → 404. Attribute values are HTML-escaped:
    // unescape quotes for the css rewriter, re-escape after.
    const rewriteStyleAttr = (css: string): string => {
      const unescaped = css
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'");
      return rewriteCssUrls(unescaped)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    };
    html = html.replace(/\bstyle="([^"]*url\([^"]*)"/gi, (_m, css) => `style="${rewriteStyleAttr(css)}"`);
    html = html.replace(/\bstyle='([^']*url\([^']*)'/gi, (_m, css) => `style='${rewriteStyleAttr(css)}'`);
    // <base href> must point at the FINAL document's directory (after server-side
    // redirects), not the host root. e.g. greeneple.net/ → /main/main.php uses "../img/..";
    // with base at host root, ".." over-climbs past the host segment and breaks. The real
    // site clamps ".." at the domain root, so base must mirror the final doc directory.
    if (isDocument) {
      let finalDocPath = fullUrl.pathname;
      try {
        const ru = new URL(resp.url);
        if (ru.host === host) finalDocPath = ru.pathname;
      } catch {}
      const finalDir = finalDocPath.replace(/[^/]*$/, "") || "/";
      const baseHref = `${proxyOrigin}/api/proxy/a/${encodedHost}${finalDir}`;
      const headInject = `${injectedScripts}<base href="${baseHref}">`;
      // Next.js App Router streaming responses often have NO literal <head>/<html>/<body>
      // tags — they start straight with <script>/<meta>. Our inject (marker, proxify,
      // URL normalization, click intercept) MUST still be added, or the site has no proxy
      // behavior at all (no escape recovery, cross-origin nav escapes, blank hydration).
      // Fall back to <html>, else prepend at the very top so it parses into <head> first.
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>${headInject}`);
      } else if (/<html[^>]*>/i.test(html)) {
        html = html.replace(/<html([^>]*)>/i, `<html$1><head>${headInject}</head>`);
      } else {
        html = `<head>${headInject}</head>` + html;
      }
      html = html.replace(
        /if\s*\(\s*(?:top|window\.top|parent)\s*!==?\s*(?:self|window\.self|window)\s*\)[^}]*}/gi,
        ""
      );
    }

    return new Response(html, {
      status: isDocument ? 200 : resp.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": "no-cache",
        "x-frame-options": "ALLOWALL",
      },
    });
  } catch (err) {
    return new Response(`Proxy error: ${err}`, { status: 502 });
  }
}
