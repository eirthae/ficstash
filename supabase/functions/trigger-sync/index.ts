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

    // POST → dispatch the workflow.
    const res = await fetch(gh(`actions/workflows/${WORKFLOW}/dispatches`), {
      method: "POST",
      headers: { ...ghHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main" }),
    });
    // GitHub returns 204 No Content on a successful dispatch.
    if (res.status === 204) return json({ ok: true, dispatched: true });
    const text = await res.text();
    return json({ ok: false, error: `GitHub ${res.status}: ${text}` }, 502);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
});
