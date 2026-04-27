"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [dataCode, setDataCode] = useState(
    "019d8a93-e7e6-7bb5-99a2-b82dbcf21006"
  );
  const [widgetEnv, setWidgetEnv] = useState("dev");
  const [proxyMode, setProxyMode] = useState<"default" | "compat">("default");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    let target = url.trim();
    if (!target.startsWith("http")) target = "https://" + target;
    router.push(
      `/view?url=${encodeURIComponent(target)}&code=${encodeURIComponent(dataCode)}&env=${widgetEnv}&mode=${proxyMode}`
    );
  };

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
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="example.com"
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/50 text-white placeholder:text-zinc-600 font-mono"
          />
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
            value={dataCode}
            onChange={(e) => setDataCode(e.target.value)}
            placeholder="019cdd37-..."
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500/50 text-white placeholder:text-zinc-600 font-mono text-sm"
          />
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
