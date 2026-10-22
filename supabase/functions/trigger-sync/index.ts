// Manual "Sync now" trigger.
//
// The phone app only talks to Supabase, never to GitHub. This Edge Function
// lets the in-app Sync button start the AO3 sync workflow on demand: it asks
// GitHub to run .github/workflows/sync.yml via workflow_dispatch. A GET returns
// the latest sync run's status so the app can show "last synced / running".
//
// Auth: callers must present the project's anon key (default JWT verification),
// so this isn't an open trigger.
//
// Required Edge Function secrets:
//   GITHUB_DISPATCH_TOKEN   fine-grained PAT with Actions: Read and write on the repo
// Optional:
//   GITHUB_REPO             "owner/repo" (defaults to eirthae/ficstash)
//   SYNC_WORKFLOW           workflow file name (defaults to sync.yml)

const REPO = Deno.env.get("GITHUB_REPO") || "eirthae/ficstash";
const WORKFLOW = Deno.env.get("SYNC_WORKFLOW") || "sync.yml";
const TOKEN = Deno.env.get("GITHUB_DISPATCH_TOKEN") || "";

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

function gh(path: string): string {
  return `https://api.github.com/repos/${REPO}/${path}`;
}

function ghHeaders(): HeadersInit {
  return {
    "Authorization": `Bearer ${TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "FicStash/1.0 (personal use)",
  };
}

async function latestRun(): Promise<unknown> {
  const res = await fetch(
    gh(`actions/workflows/${WORKFLOW}/runs?per_page=1`),
    { headers: ghHeaders() },
  );
  if (!res.ok) return { error: `GitHub ${res.status}` };
  const data = await res.json();
  const run = data?.workflow_runs?.[0];
  if (!run) return { status: "none" };
  return {
    status: run.status, // queued | in_progress | completed
    conclusion: run.conclusion, // success | failure | null
    started_at: run.run_started_at || run.created_at,
    url: run.html_url,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (!TOKEN) {
    return json({ ok: false, error: "Sync trigger not configured (missing GITHUB_DISPATCH_TOKEN)." }, 503);
  }

  try {
    if (req.method === "GET") {
      return json({ ok: true, run: await latestRun() });
    }

    // A "saves-only" POST is a real-time Save: it runs in its own workflow lane
    // (separate concurrency group), so it fires immediately and we DON'T guard it
    // against a running full sync.
    // groupId → discovery for ONE tracked group, skipping every other pass: the
    // app's per-group Sync buttons. The phone asks the worker because the phone
    // cannot do it — on-device AO3 search is logged out and has never once
    // written a row, while this worker is logged in and searches fine.
    // allTime pairs with it for the back-catalogue catch-up.
    let savesOnly = false;
    let groupId = "";
    let allTime = false;
    try {
      const body = await req.json();
      savesOnly = !!body?.savesOnly;
      groupId = String(body?.groupId || "").trim();
      allTime = !!body?.allTime;
    } catch (_e) { /* no body */ }
    // Only ever a group id — never anything that could be smuggled into a
    // workflow input.
    if (groupId && !/^[0-9a-fA-F-]{36}$/.test(groupId)) {
      return json({ ok: false, error: "Bad groupId." }, 400);
    }

    // For a normal sync, only dispatch if one isn't already queued/in progress —
    // otherwise every pull-to-refresh / save / app-open POST piles up runs that
    // supersede (cancel) each other so none completes and works never land.
    if (!savesOnly) {
      const current = await latestRun();
      const st = (current as { status?: string } | null)?.status;
      if (st === "queued" || st === "in_progress") {
        return json({ ok: true, alreadyRunning: true, run: current });
      }
    }
    const inputs: Record<string, unknown> = savesOnly ? { saves_only: true } : {};
    if (groupId) {
      inputs.only_group = groupId;
      // A one-group run must not drag the weekly series sweep in behind it.
      inputs.series_sweep = "skip";
      if (allTime) inputs.reseed_tags = true;
    }
    const res = await fetch(gh(`actions/workflows/${WORKFLOW}/dispatches`), {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs }),
    });
    // GitHub returns 204 No Content on a successful dispatch.
    if (res.status === 204) return json({ ok: true, dispatched: true });
    const text = await res.text();
    return json({ ok: false, error: `GitHub ${res.status}: ${text}` }, 502);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
});
