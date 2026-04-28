import { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(
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
  const targetOrigin = `https://${host}`;
  const targetUrl = `${targetOrigin}/${rest}${search}`;

  let fullUrl: URL;
  try {
    fullUrl = new URL(targetUrl);
  } catch {
    return new Response("Invalid url", { status: 400 });
  }

  const proxyOrigin = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const encodedHost = encodeURIComponent(host);
  const proxyPrefix = `/api/proxy/c/${encodedHost}`;

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

    // If upstream redirected to a different host (e.g. iocrops.com → www.iocrops.com),
    // redirect the iframe to the new proxy URL so TARGET_HOST stays in sync with the actual host.
    // Without this, the widget sends pageUrl with the wrong host (→ 403) and Wix's _api calls
    // hit a different origin than what proxify() knows about (→ CORS).
    try {
      const respUrl = new URL(resp.url);
      if (respUrl.host !== host && contentType.includes("text/html")) {
        const newPath = `/api/proxy/c/${encodeURIComponent(respUrl.host)}${respUrl.pathname}${respUrl.search}`;
        return Response.redirect(`${proxyOrigin}${newPath}`, 302);
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

    const injectedScripts = `<script data-proxy-compat="1">(function(){
var TARGET_ORIGIN=${JSON.stringify(targetOrigin)};
var TARGET_HOST=${JSON.stringify(host)};
var ENCODED_HOST=${JSON.stringify(encodedHost)};
var PROXY_ORIGIN=location.origin;
var PROXY_PREFIX='/api/proxy/c/'+ENCODED_HOST;
var PROXY_FULL=PROXY_ORIGIN+PROXY_PREFIX;
function proxify(u){
if(typeof u!=='string')return u;
if(u.indexOf(PROXY_FULL)===0)return u;
if(u.indexOf(PROXY_ORIGIN+'/api/proxy')===0)return u;
if(u===TARGET_ORIGIN)return PROXY_FULL+'/';
if(u.indexOf(TARGET_ORIGIN+'/')===0)return PROXY_FULL+u.slice(TARGET_ORIGIN.length);
if(u.indexOf('//'+TARGET_HOST+'/')===0)return PROXY_FULL+u.slice(('//'+TARGET_HOST).length);
if(u==='//'+TARGET_HOST)return PROXY_FULL+'/';
if(u.charAt(0)==='/'&&u.charAt(1)!=='/'){
if(u.indexOf(PROXY_PREFIX+'/')===0||u===PROXY_PREFIX)return u;
if(u.indexOf('/api/proxy')===0)return u;
return PROXY_PREFIX+u;
}
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
locProto.assign=function(u){return origAssign.call(this,proxify(u));};
locProto.replace=function(u){return origReplace.call(this,proxify(u));};
var hrefDesc=Object.getOwnPropertyDescriptor(locProto,'href');
if(hrefDesc&&hrefDesc.set){
try{
Object.defineProperty(locProto,'href',{
configurable:true,
enumerable:hrefDesc.enumerable,
get:hrefDesc.get,
set:function(v){hrefDesc.set.call(this,proxify(v));}
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
var noop=function(){};noop.q=[];noop.c=noop;window.ChannelIO=noop;window.ChannelIOInitialized=true;
new MutationObserver(function(){
document.querySelectorAll('#ch-plugin,[id^="ch-plugin"],iframe[src*="channel.io"],[class*="ch-desk"],[id*="channel"]').forEach(function(el){el.remove()});
}).observe(document.documentElement,{childList:true,subtree:true});
try{
var subPath=location.pathname.indexOf(PROXY_PREFIX)===0?location.pathname.slice(PROXY_PREFIX.length):'/';
parent.postMessage({type:'proxy-navigation',url:TARGET_ORIGIN+(subPath||'/')+location.search+location.hash},'*');
}catch(e){}
document.addEventListener('click',function(e){
var a=e.target&&e.target.closest&&e.target.closest('a');
if(!a||!a.href)return;
var raw=a.getAttribute('href')||'';
if(raw.charAt(0)==='#')return;
var pu=proxify(a.href);
if(pu!==a.href){
e.preventDefault();
e.stopImmediatePropagation();
location.assign(pu);
}
},true);
})();</script>`;

    html = html.replace(/<script[^>]*sdr-widget[^"']*\.js[^>]*><\/script>/gi, "");
    html = html.replace(/<script[^>]*channel\.io[^>]*><\/script>/gi, "");
    html = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (match, body) => {
      if (/ChannelIO/i.test(body)) return "";
      return match;
    });
    html = html.replace(
      /<head([^>]*)>/i,
      `<head$1>${injectedScripts}<base href="${proxyOrigin}${proxyPrefix}/">`
    );
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
