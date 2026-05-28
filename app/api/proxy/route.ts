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
  const encodedHost = encodeURIComponent(fullUrl.host);
  // Route relative resources through the same-origin compat path. Without this,
  // base href="http://..." causes Mixed Content blocks on HTTPS deployments
  // (sea-reverse-proxy.vercel.app is HTTPS) and HTTPS-upgraded fetches fail on
  // self-signed upstream certs (ERR_CERT_AUTHORITY_INVALID). The compat route
  // already does HTTP fallback per host.
  const compatBase = `${proxyOrigin}/api/proxy/c/${encodedHost}/`;
  const compatPrefix = `${proxyOrigin}/api/proxy/c/${encodedHost}`;

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
})();\n`;
      js = js.replace(
        /location\.href/g,
        "(window.__sdrPageUrl||location.href)"
      );

      // Strip cookies from all server requests so salesmap treats every page as a new visitor.
      // Combined with the sdr-reset hook below, this lets the demo fire fresh nudges on demand.
      js = js.split("credentials: 'include'").join("credentials: 'omit'");

      // Reset hook: postMessage {type:'sdr-reset', code} to current window resets widget state.
      // Injected inside the existing message listener so it shares the closure with all state vars.
      js = js.replace(
        "if (data.code && data.code !== code) return;",
        `if (data.code && data.code !== code) return;
        if (data.type === 'sdr-reset') {
          conversationStartedEver = false;
          nudgeFiredForPage = false;
          nudgeSuppressedForPage = false;
          lastUrl = null;
          isOpen = false;
          nudgePending = false;
          if (nudgeFrame) { try { nudgeFrame.remove(); } catch (e) {} nudgeFrame = null; }
          if (chatFrame) { chatFrame.style.display = 'none'; try { chatFrame.src = baseUrl; } catch (e) {} }
          resetEngagedTime();
          resetScrollDepth();
          trackPageView();
          return;
        }`
      );

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
var targetUrl=new URLSearchParams(location.search).get('url')||ORIGIN;
try{var t=new URL(targetUrl);history.replaceState({},'',t.pathname+t.search+t.hash)}catch(e){}
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
try{var p=new URL(u);if(p.origin!==location.origin){return p.pathname+p.search+p.hash;}}catch(e){}
return u;
};
history.replaceState=function(s,t,u){try{_origReplaceState(s,t,u!=null?_safeUrl(u):u);}catch(e){}};
history.pushState=function(s,t,u){try{_origPushState(s,t,u!=null?_safeUrl(u):u);}catch(e){}};
// Route fetch/XHR through proxy (not directly to origin) to avoid CORS blocking
var PROXY_ORIGIN=location.origin;
var PROXY_PREFIX=PROXY_ORIGIN+'/api/proxy?url=';
var COMPAT_PREFIX=${JSON.stringify(compatPrefix)};
var _toProxy=function(u){
if(typeof u!=='string')return u;
if(u.indexOf('/api/proxy?url=')>=0)return u;
if(u.indexOf(COMPAT_PREFIX)===0)return u;
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
// Next.js webpack chunk loader creates <script src="/_next/..."> at runtime.
// HTML rewrite only catches the initial markup, so patch attribute setters too.
var COMPAT_BASE='/api/proxy/c/${encodedHost}';
function _rewriteRoot(v){
if(typeof v!=='string')return v;
if(v.charAt(0)!=='/'||v.charAt(1)==='/')return v;
if(v.indexOf('/api/proxy')===0)return v;
return COMPAT_BASE+v;
}
var _origSetAttr=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(name,value){
if(name==='src'||name==='href'||name==='action'||name==='poster'){value=_rewriteRoot(value);}
return _origSetAttr.call(this,name,value);
};
['HTMLScriptElement','HTMLImageElement','HTMLLinkElement','HTMLIFrameElement','HTMLSourceElement'].forEach(function(t){
var proto=window[t]&&window[t].prototype;if(!proto)return;
['src','href'].forEach(function(prop){
var d=Object.getOwnPropertyDescriptor(proto,prop);
if(!d||!d.set)return;
try{Object.defineProperty(proto,prop,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,_rewriteRoot(v));}});}catch(e){}
});
});
})();</script>`;

    // Remove only ChannelTalk + SDR widget scripts (keep all other scripts for UI interactions)
    html = html.replace(/<script[^>]*sdr-widget[^"']*\.js[^>]*><\/script>/gi, "");
    html = html.replace(/<script[^>]*channel\.io[^>]*><\/script>/gi, "");
    html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, body) => {
      if (/ChannelIO/i.test(body)) return "";
      return match;
    });
    // Rewrite root-relative href/src/action so they hit the compat route instead
    // of the proxy origin. `base href` only fixes RELATIVE paths — root-relative
    // `/foo` always resolves against page origin, ignoring base's path. Without
    // this, Next.js sites (e.g. data.vaiv.kr) 404 on every `/_next/static/...`.
    html = html.replace(
      /\b(href|src|action|poster)=(["'])\/(?!\/|api\/proxy\b)([^"'\s]*)\2/g,
      `$1=$2/api/proxy/c/${encodedHost}/$3$2`
    );
    // Inject our script (AFTER removing ChannelIO scripts, since ours contains the keyword)
    html = html.replace(/<head([^>]*)>/i, `<head$1>${injectedScripts}<base href="${compatBase}">`);
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
