// AO3 tag autocomplete proxy.
//
// The phone app only talks to Supabase, never to AO3 directly. This Edge
// Function lets the in-app "add a tag" field show live AO3 suggestions: it
// forwards the typed term to AO3's own tag autocomplete and returns canonical
// tag names, so a tracked group uses the exact tags AO3 recognises (and its
// synonym wrangling applies when the worker later searches).
//
// Auth: callers must present the project's anon key (default JWT verification),
// so this isn't an open proxy.

const AO3_AUTOCOMPLETE = "https://archiveofourown.org/autocomplete/tag";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  let term = (url.searchParams.get("term") || "").trim();
  if (!term && req.method === "POST") {
    try {
      const body = await req.json();
      term = (body?.term || "").toString().trim();
    } catch (_e) { /* ignore bad bodies */ }
  }
  if (term.length < 2) return json({ tags: [] });

  const target = `${AO3_AUTOCOMPLETE}?term=${encodeURIComponent(term)}`;
  // Hard timeout so a slow / throttled AO3 can't leave the keystroke hanging for
  // many seconds (the "I type and it does nothing for ages" symptom). On timeout
  // or any error we return an EMPTY list with HTTP 200 — the app treats that as
  // "no suggestions" and stays responsive, instead of throwing / spinning.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4500);
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": "FicStash/1.0 (personal use)" },
      signal: ctrl.signal,
    });
    if (!res.ok) return json({ tags: [], error: `AO3 ${res.status}` });

    // AO3 returns [{ id, name }, ...]; normalise to a small, stable shape.
    const raw = await res.json();
    const tags = (Array.isArray(raw) ? raw : [])
      .map((t) => ({
        name: (t?.name ?? t?.id ?? "").toString(),
        id: (t?.id ?? "").toString(),
      }))
      .filter((t) => t.name.length > 0)
      .slice(0, 15);
    // Let the browser cache identical prefixes briefly — repeated keystrokes over
    // the same term don't re-hit AO3.
    return new Response(JSON.stringify({ tags }), {
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "private, max-age=120" },
    });
  } catch (e) {
    const msg = (e instanceof Error && e.name === "AbortError") ? "AO3 autocomplete timed out" : String(e);
    return json({ tags: [], error: msg });
  } finally {
    clearTimeout(timer);
  }
});
