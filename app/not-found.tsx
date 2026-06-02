"use client";

import { useEffect, useState } from "react";

// Escape recovery for AUTO proxy mode.
// A proxied site can hard-navigate the iframe to a bare same-origin path (e.g. a Next.js
// client-router redirect whose route chunk 404s at bare origin → window.location fallback).
// That lands on OUR app at an unknown path → this 404 page. The auto inject stashed the
// proxied host in sessionStorage (same-origin, survives the navigation); recover it and
// re-enter via the proxy so the demo never shows our own 404 inside the iframe.
// Only acts when the auto marker is present (default/compat never set it).
export default function NotFound() {
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    let host: string | null = null;
    try {
      host = sessionStorage.getItem("__seaAutoHost");
    } catch {}
    const { pathname, search, hash } = window.location;
    // Never recover our own real routes.
    if (
      !host ||
      pathname === "/" ||
      pathname.startsWith("/view") ||
      pathname.startsWith("/api/")
    ) {
      return;
    }
    // In the demo iframe with the auto marker → blank our branding/title so the proxied
    // frame never shows our 404 ("SeA Proxy Demo") even if recovery later gives up.
    setRecovering(true);
    try { document.title = ""; } catch {}
    // Loop guard: if we just recovered this exact path, don't bounce again.
    // Guard scoped to host:path so it doesn't mis-trigger across different proxied
    // sites sharing this session's sessionStorage.
    const guardKey = "__seaAutoRecover";
    const guardVal = host + ":" + pathname;
    let prev = "";
    try {
      prev = sessionStorage.getItem(guardKey) || "";
    } catch {}
    if (prev === guardVal) {
      try {
        sessionStorage.removeItem(guardKey);
      } catch {}
      return; // already tried — neutral blank (title already cleared) instead of looping
    }
    try {
      sessionStorage.setItem(guardKey, guardVal);
    } catch {}
    window.location.replace(
      `/api/proxy/a/${encodeURIComponent(host)}${pathname}${search}${hash}`
    );
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center text-zinc-500">
      {recovering ? "프록시로 복귀 중..." : "404 — 페이지를 찾을 수 없습니다"}
    </div>
  );
}
