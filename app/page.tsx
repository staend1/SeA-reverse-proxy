"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type HistoryEntry = {
  url: string;
  code: string;
  env: string;
  mode: "default" | "compat";
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
  const [widgetEnv, setWidgetEnv] = useState("dev");
  const [proxyMode, setProxyMode] = useState<"default" | "compat">("default");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

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
            {(["default", "compat"] as const).map((m) => (
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
                {m === "default" ? "기본" : "SPA 호환 (Wix 등)"}
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
