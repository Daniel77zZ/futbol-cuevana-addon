import type { Env } from "../index";
import { logError, logInfo } from "../utils/cache";

/**
 * Input names must match the `workflow_dispatch.inputs` keys declared in
 * .github/workflows/resolve-on-demand.yml. GitHub rejects the whole request
 * with 422 "Unexpected inputs provided" if any key here is not declared there,
 * so treat these names as a hard contract with that file.
 */
export interface DispatchInputs {
  /** One of the workflow's declared choices: futbol | cine | series. */
  target: string;
  id: string;
  url: string;
}

/**
 * Triggers the on-demand resolver workflow via `workflow_dispatch`.
 *
 * GitHub returns 204 No Content on success. We never throw: a failed dispatch
 * simply means the poll loop will time out and Stremio gets an empty list.
 */
export async function triggerResolveWorkflow(env: Env, inputs: DispatchInputs): Promise<boolean> {
  const ref = env.GH_REF || "main";
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;

  if (!env.GH_TOKEN) {
    logError("gh_dispatch_missing_token", { repo: env.GH_REPO });
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        // GitHub rejects requests without a User-Agent.
        "User-Agent": "futbol-cuevana-addon",
      },
      body: JSON.stringify({ ref, inputs }),
    });

    if (!res.ok) {
      logError("gh_dispatch_failed", {
        status: res.status,
        body: await res.text().catch(() => ""),
      });
      return false;
    }

    logInfo("gh_dispatch_ok", { target: inputs.target, id: inputs.id, ref });
    return true;
  } catch (err) {
    logError("gh_dispatch_exception", { error: String(err) });
    return false;
  }
}
