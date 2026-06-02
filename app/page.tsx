"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type HistoryEntry = {
  url: string;
  code: string;
  env: string;
  mode: "default" | "compat" | "auto";
  ts: number;
};

const STORAGE_KEY = "sea-proxy-history";
const MAX_HISTORY = 20;

const normalizeUrl = (u: string) => {
  const trimmed = u.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("http") ? trimmed : "https://" + trimmed;
};

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [dataCode, setDataCode] = useState("");
  const [widgetEnv, setWidgetEnv] = useState("prod");
  const [proxyMode, setProxyMode] = useState<"default" | "compat" | "auto">(
    "auto"
  );
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // True when this home page is rendering INSIDE the demo iframe due to an auto-mode
  // escape — we then hide our own UI/title so the proxied frame never shows our branding.
  // Computed synchronously on the client's first render (before paint) so the branded
  // form/title never flashes; document.title is blanked here too because Next's static
  // <title> metadata would otherwise win over a useEffect-only clear.
  const [autoEscape, setAutoEscape] = useState<boolean>(() => {
    if (typeof window === "undefined" || window.self === window.top) return false;
    try {
      if (!sessionStorage.getItem("__seaAutoHost")) return false;
    } catch {
      return false;
    }
    try { document.title = ""; } catch {}
    return true;
  });

  // AUTO escape recovery for the root path. A proxied site can hard-navigate the iframe
  // to bare "/" (e.g. its SPA router redirects to its own home after we normalized the URL
  // to "/"), landing on THIS page inside the iframe → looks like our app. not-found.tsx
  // can't catch "/" (it's a real route), so recover here: only when we're inside an iframe
  // (the demo's proxied frame) and the auto marker is set. A top-window visitor to "/" has
  // window.self === window.top, so the real home UI is untouched.
  useEffect(() => {
    if (typeof window === "undefined" || window.self === window.top) return;
    let host: string | null = null;
    try {
      host = sessionStorage.getItem("__seaAutoHost");
    } catch {}
    if (!host) return;
    const { pathname, search, hash } = window.location;
    if (pathname.startsWith("/api/") || pathname.startsWith("/view")) return;
    // Inside the demo iframe with the auto marker: never show our branded home UI.
    setAutoEscape(true);
    try { document.title = ""; } catch {}
    // Guard scoped to host:path — a bare pathname would mis-trigger across different
    // proxied sites in the same session (sessionStorage persists between navigations).
    const guardKey = "__seaAutoRecover";
    const guardVal = host + ":" + pathname;
    let prev = "";
    try {
      prev = sessionStorage.getItem(guardKey) || "";
    } catch {}
    if (prev === guardVal) {
      // Loop: the proxied page keeps re-escaping (hard Next.js App Router case). Stop
      // bouncing and leave a neutral blank — NOT our 404/home — so it's never a regression.
      try { sessionStorage.removeItem(guardKey); } catch {}
      return;
    }
    try { sessionStorage.setItem(guardKey, guardVal); } catch {}
    window.location.replace(
      `/api/proxy/a/${encodeURIComponent(host)}${pathname}${search}${hash}`
    );
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setHistory(JSON.parse(raw));
    } catch {}
  }, []);

  const handleUrlChange = (newUrl: string) => {
    setUrl(newUrl);
    const normalized = normalizeUrl(newUrl);
    const match = history.find((h) => h.url === normalized);
    if (match) {
      setDataCode(match.code);
      setWidgetEnv(match.env);
      setProxyMode(match.mode);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    const target = normalizeUrl(url);

    const entry: HistoryEntry = {
      url: target,
      code: dataCode,
      env: widgetEnv,
      mode: proxyMode,
      ts: Date.now(),
    };
    const filtered = history.filter(
      (h) => !(h.url === entry.url && h.code === entry.code)
    );
    const next = [entry, ...filtered].slice(0, MAX_HISTORY);
    setHistory(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}

    router.push(
      `/view?url=${encodeURIComponent(target)}&code=${encodeURIComponent(dataCode)}&env=${widgetEnv}&mode=${proxyMode}`
    );
  };

  const uniqueUrls = Array.from(new Set(history.map((h) => h.url)));
  const uniqueCodes = Array.from(new Set(history.map((h) => h.code)));

  // Inside the demo iframe after an auto-mode escape: render a neutral blank instead of
  // our branded home, so the proxied frame never displays our app's UI/404.
  if (autoEscape) {
    return <div className="min-h-screen bg-white" />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <form onSubmit={handleSubmit} className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-bold mb-6">SeA Proxy Demo</h1>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            대상 사이트 URL
          </label>
          <input
            type="text"
            list="url-history"
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder="example.com"
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/50 text-white placeholder:text-zinc-600 font-mono"
          />
          <datalist id="url-history">
            {uniqueUrls.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            위젯 환경
          </label>
          <div className="flex gap-2">
            {(["dev", "prod"] as const).map((env) => (
              <button
                key={env}
                type="button"
                onClick={() => setWidgetEnv(env)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                  widgetEnv === env
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {env === "dev" ? "dev.salesmap.kr" : "salesmap.kr"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            프록시 모드
          </label>
          <div className="flex gap-2">
            {(["default", "compat", "auto"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setProxyMode(m)}
                className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                  proxyMode === m
                    ? "bg-violet-600 text-white"
                    : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                }`}
              >
                {m === "default"
                  ? "기본"
                  : m === "compat"
                    ? "SPA 호환 (Wix 등)"
                    : "auto"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">
            위젯 data-code
          </label>
          <input
            type="text"
            list="code-history"
            value={dataCode}
            onChange={(e) => setDataCode(e.target.value)}
            placeholder="019cdd37-..."
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/50 text-white placeholder:text-zinc-600 font-mono text-sm"
          />
          <datalist id="code-history">
            {uniqueCodes.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>

        <button
          type="submit"
          disabled={!url}
          className="w-full py-3 rounded-lg bg-violet-600 text-white font-semibold hover:bg-violet-500 disabled:bg-zinc-800 disabled:text-zinc-600 transition"
        >
          실행
        </button>
      </form>
    </div>
  );
}
