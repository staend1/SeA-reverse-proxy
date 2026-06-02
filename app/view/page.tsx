"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, Suspense } from "react";

function ViewInner() {
  const params = useSearchParams();
  const targetUrl = params.get("url") || "";
  const dataCode = params.get("code") || "";
  const widgetEnv = params.get("env") || "dev";
  const proxyMode = params.get("mode") === "compat" ? "compat" : "default";
  const [widgetLoaded, setWidgetLoaded] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(targetUrl);
  const [urlInput, setUrlInput] = useState(targetUrl);
  const [resetFlash, setResetFlash] = useState(false);
  const scriptInjected = useRef(false);
  const resetChannel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    setUrlInput(currentUrl);
  }, [currentUrl]);

  // Reset the widget that lives in THIS window only.
  const resetLocalWidget = () => {
    window.postMessage({ type: "sdr-reset", code: dataCode }, window.location.origin);
  };

  // The conversation state lives in the salesmap.kr chat iframe, whose storage is
  // shared across every proxy tab on the same origin. Resetting one window reloads
  // its own iframe, but any other open tab with the same code re-syncs the old
  // conversation back. So fan the reset out to all tabs (same code) via a
  // BroadcastChannel and reload every chat iframe at once — leaving no live tab
  // to restore the conversation.
  useEffect(() => {
    if (!dataCode || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(`sdr-reset-${dataCode}`);
    ch.onmessage = (e) => {
      if (e.data?.type === "sdr-reset" && e.data.code === dataCode) {
        resetLocalWidget();
      }
    };
    resetChannel.current = ch;
    return () => {
      ch.close();
      resetChannel.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataCode]);

  const handleReset = () => {
    // Reset this tab immediately (BroadcastChannel never echoes to the sender)…
    resetLocalWidget();
    // …and tell every other proxy tab with the same code to reset simultaneously.
    resetChannel.current?.postMessage({ type: "sdr-reset", code: dataCode });
    setResetFlash(true);
    setTimeout(() => setResetFlash(false), 1500);
  };

  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    const normalized = trimmed.startsWith("http") ? trimmed : "https://" + trimmed;
    window.location.href = `/view?url=${encodeURIComponent(normalized)}&code=${encodeURIComponent(dataCode)}&env=${widgetEnv}&mode=${proxyMode}`;
  };

  // prod salesmap API rejects pageUrl that isn't https (400 Validation failed).
  // Widget uses __sdrPageUrl only as an opaque string (API arg, postMessage payload,
  // tracking key) — never to fetch — so forcing https here is safe.
  const toHttpsPageUrl = (raw: string): string => {
    try {
      const u = new URL(raw);
      u.protocol = "https:";
      return u.toString();
    } catch {
      return raw;
    }
  };

  // Track page URL for widget context
  useEffect(() => {
    if (!targetUrl) return;
    Object.defineProperty(window, "__sdrPageUrl", {
      get: () => toHttpsPageUrl(currentUrl),
      configurable: true,
    });
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "proxy-navigation" && e.data.url) {
        setCurrentUrl(e.data.url);
        Object.defineProperty(window, "__sdrPageUrl", {
          get: () => toHttpsPageUrl(e.data.url),
          configurable: true,
        });
        // Trigger widget's replaceState hook so it detects page navigation
        // (fires trackPageView → resets nudge timers → enables proactive nudge)
        history.replaceState({}, "", window.location.href);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [targetUrl, currentUrl]);

  // Inject widget via proxy so location.href gets patched to __sdrPageUrl
  useEffect(() => {
    if (!targetUrl || !dataCode || scriptInjected.current) return;
    scriptInjected.current = true;

    // Set __sdrPageUrl before widget loads
    Object.defineProperty(window, "__sdrPageUrl", {
      get: () => toHttpsPageUrl(currentUrl),
      configurable: true,
    });

    const widgetHost =
      widgetEnv === "prod"
        ? "https://salesmap.kr"
        : "https://dev.salesmap.kr";
    const widgetSrc = `/api/proxy?url=${encodeURIComponent(`${widgetHost}/sdr-widget-v1-2.js`)}`;
    const script = document.createElement("script");
    script.src = widgetSrc;
    script.setAttribute("data-code", dataCode);
    script.async = true;
    script.onload = () => {
      // Detect widget by its DOM elements (iframe with class sm-sdr-btn-frame)
      const wait = setInterval(() => {
        if (document.querySelector(".sm-sdr-btn-frame")) {
          setWidgetLoaded(true);
          clearInterval(wait);
        }
      }, 300);
      setTimeout(() => clearInterval(wait), 10000);
    };
    document.body.appendChild(script);
  }, [targetUrl, dataCode, widgetEnv, currentUrl]);

  if (!targetUrl || !dataCode) {
    return (
      <div className="min-h-screen flex items-center justify-center text-zinc-500">
        url, code 파라미터 필요
      </div>
    );
  }

  const proxyUrl = (() => {
    if (proxyMode === "compat") {
      try {
        const u = new URL(targetUrl);
        return `/api/proxy/c/${encodeURIComponent(u.host)}${u.pathname}${u.search}${u.hash}`;
      } catch {
        return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
      }
    }
    return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
  })();

  return (
    <div className="w-screen h-screen flex flex-col">
      {/* Top bar */}
      <div className="h-10 bg-zinc-900 border-b border-zinc-800 flex items-center px-4 gap-3 shrink-0">
        <button
          type="button"
          onClick={() => window.history.back()}
          className="text-zinc-500 hover:text-white text-sm px-1"
          title="사이트 안에서 이전 페이지로"
        >
          &larr;
        </button>
        <form onSubmit={handleUrlSubmit} className="flex-1">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            spellCheck={false}
            className="w-full bg-zinc-800 rounded px-3 py-1 text-sm text-zinc-300 font-mono focus:outline-none focus:ring-1 focus:ring-violet-500/50"
          />
        </form>
        <button
          onClick={handleReset}
          className="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-300 transition"
          title="대화/넛지 상태를 초기화하고 새 방문자처럼 다시 시작"
        >
          {resetFlash ? "✓ 초기화됨" : "대화 초기화"}
        </button>
        <span
          className={`text-xs ${widgetLoaded ? "text-emerald-500" : "text-yellow-500"}`}
        >
          {widgetLoaded ? "● SDR 활성" : "위젯 로딩..."}
        </span>
      </div>

      {/* Proxied site */}
      <iframe
        src={proxyUrl}
        className="flex-1 w-full border-none bg-white"
        sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
      />
    </div>
  );
}

export default function ViewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-zinc-500">
          로딩...
        </div>
      }
    >
      <ViewInner />
    </Suspense>
  );
}
