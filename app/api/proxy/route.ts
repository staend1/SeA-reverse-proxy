import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
  const targetUrl = request.nextUrl.searchParams.get("url");
  if (!targetUrl) {
    return new Response("Missing url param", { status: 400 });
  }

  let fullUrl: URL;
  try {
    fullUrl = new URL(targetUrl);
  } catch {
    return new Response("Invalid url", { status: 400 });
  }

  const origin = fullUrl.origin;
  const proxyOrigin = `${request.nextUrl.protocol}//${request.nextUrl.host}`;

  try {
    const resp = await fetch(fullUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });

    const contentType = resp.headers.get("content-type") || "";

    // Patch sdr-widget.js (any version: sdr-widget.js, sdr-widget-v1-1.js, sdr-widget-v2.js, ...)
    if (/\/sdr-widget[^/]*\.js$/.test(fullUrl.pathname)) {
      let js = await resp.text();
      const targetOrigin = fullUrl.origin;

      // Patch origin extraction for both v1 and v2
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
  // Proxied page path: the widget keys nudge re-fire off location.pathname,
  // but the top window pathname is always /view. Derive it from __sdrPageUrl so
  // navigating between proxied pages is detected as a real page change.
  window.__sdrPath = function(){
    try { return new URL(window.__sdrPageUrl, window.location.href).pathname; }
    catch(e){ return window.location.pathname; }
  };
})();\n`;
      js = js.replace(
        /location\.href/g,
        "(window.__sdrPageUrl||location.href)"
      );
      js = js.replace(
        /location\.pathname/g,
        "(window.__sdrPath?window.__sdrPath():location.pathname)"
      );

      // Strip cookies from all server requests so salesmap treats every page as a new visitor.
      js = js.split("credentials: 'include'").join("credentials: 'omit'");

      return new Response(locationPatch + js, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
        },
      });
    }

    // JS/CSS → proxy directly (redirect fails for dynamically injected scripts)
    if (contentType.includes("javascript") || contentType.includes("text/css")) {
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: {
          "content-type": contentType,
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    }

    // Other non-HTML (JSON, images, fonts, etc.) → proxy directly with CORS headers
    // fetch/XHR from the iframe goes through here, so CORS must be open
    if (!contentType.includes("text/html")) {
      const buf = await resp.arrayBuffer();
      return new Response(buf, {
        status: resp.status,
        headers: {
          "content-type": contentType || "application/octet-stream",
          "access-control-allow-origin": "*",
          "cache-control": resp.headers.get("cache-control") || "public, max-age=3600",
        },
      });
    }

    // HTML → strip frame-busting, remove original widgets, inject <base>
    let html = await resp.text();

    // Proxy script: replaceState for hydration + URL notification + link intercept + ChannelTalk kill
    // + fetch/XHR interceptor to fix SPA relative-path API calls
    const injectedScripts = `<script data-proxy="1">(function(){
var ORIGIN='${origin}';
var PROXY=location.origin+'/api/proxy?url=';
var targetUrl=${JSON.stringify(fullUrl.toString())};
// Tag the normalized (clean-path) URL with the origin so back/forward reloads
// re-proxy via middleware instead of hitting our own Next.js app at that bare path.
var _mark=function(path){
try{
if(path.indexOf('__pxorigin=')>=0)return path;
var hash='';var hi=path.indexOf('#');if(hi>=0){hash=path.slice(hi);path=path.slice(0,hi);}
var sep=path.indexOf('?')>=0?'&':'?';
return path+sep+'__pxorigin='+encodeURIComponent(ORIGIN)+hash;
}catch(e){return path;}
};
try{var t=new URL(targetUrl);history.replaceState({},'',_mark(t.pathname+t.search+t.hash))}catch(e){}
try{parent.postMessage({type:'proxy-navigation',url:targetUrl},'*')}catch(e){}
var noop=function(){};noop.q=[];noop.c=noop;window.ChannelIO=noop;window.ChannelIOInitialized=true;
new MutationObserver(function(){
document.querySelectorAll('#ch-plugin,[id^="ch-plugin"],iframe[src*="channel.io"],[class*="ch-desk"],[id*="channel"]').forEach(function(el){el.remove()});
}).observe(document.documentElement,{childList:true,subtree:true});
document.addEventListener('click',function(e){
var a=e.target.closest('a');
if(!a||!a.href)return;
var h=a.href;
if(h.startsWith(ORIGIN)){
e.preventDefault();
e.stopImmediatePropagation();
location.assign(PROXY+encodeURIComponent(h));
}
},true);
// Intercept fetch/XHR: relative paths + proxy-origin absolute URLs → original server
// Next.js uses absolute URLs with the current page origin for /_next/data/ and RSC fetches
// Override history API: Next.js router tries replaceState/pushState with cross-origin URLs → SecurityError
// Strip origin so only path+search+hash is used
var _origReplaceState=history.replaceState.bind(history);
var _origPushState=history.pushState.bind(history);
var _safeUrl=function(u){
try{var p=new URL(u,location.href);return _mark(p.pathname+p.search+p.hash);}catch(e){}
return u;
};
history.replaceState=function(s,t,u){try{_origReplaceState(s,t,u!=null?_safeUrl(u):u);}catch(e){}};
history.pushState=function(s,t,u){try{_origPushState(s,t,u!=null?_safeUrl(u):u);}catch(e){}};
// Route fetch/XHR through proxy (not directly to origin) to avoid CORS blocking
var PROXY_ORIGIN=location.origin;
var PROXY_PREFIX=PROXY_ORIGIN+'/api/proxy?url=';
var _toProxy=function(u){
if(typeof u!=='string')return u;
if(u.indexOf('/api/proxy?url=')>=0)return u;
var abs=null;
if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){abs=ORIGIN+u;}
else if(u.startsWith(PROXY_ORIGIN+'/')){abs=ORIGIN+u.slice(PROXY_ORIGIN.length);}
else if(u.startsWith(ORIGIN)){abs=u;}
if(!abs)return u;
return PROXY_PREFIX+encodeURIComponent(abs);
};
var _origFetch=window.fetch;
window.fetch=function(resource,opts){
if(typeof resource==='string'){resource=_toProxy(resource);}
else if(resource&&typeof resource==='object'&&resource.url){
var u2=_toProxy(resource.url);
if(u2!==resource.url){resource=new Request(u2,resource);}
}
return _origFetch.call(this,resource,opts);
};
var _origOpen=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
var args=Array.prototype.slice.call(arguments);
args[1]=_toProxy(url);
return _origOpen.apply(this,args);
};
})();</script>`;

    // Remove only ChannelTalk + SDR widget scripts (keep all other scripts for UI interactions)
    html = html.replace(/<script[^>]*sdr-widget[^"']*\.js[^>]*><\/script>/gi, "");
    html = html.replace(/<script[^>]*channel\.io[^>]*><\/script>/gi, "");
    html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, body) => {
      if (/ChannelIO/i.test(body)) return "";
      return match;
    });
    // Inject our script (AFTER removing ChannelIO scripts, since ours contains the keyword)
    html = html.replace(/<head([^>]*)>/i, `<head$1>${injectedScripts}<base href="${origin}/">`);
    // Remove frame-busting patterns
    html = html.replace(
      /if\s*\(\s*(?:top|window\.top|parent)\s*!==?\s*(?:self|window\.self|window)\s*\)[^}]*}/gi,
      ""
    );

    return new Response(html, {
      status: 200,
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
