const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The review skill opens on a second port, which a single tunnel can't follow. */
export function canOpenReviewSkill(hostname: string = window.location.hostname): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

export async function reviewSkillExists(): Promise<boolean> {
  const response = await fetch("/api/review-skill");
  return response.ok && ((await response.json()) as { exists: boolean }).exists;
}

/** Open the user's copy of the review skill in a new tab. The tab is opened before
 *  the request so the click still counts as the user's and isn't blocked as a popup. */
export async function openReviewSkill(create: boolean): Promise<void> {
  const tab = window.open("", "_blank");
  try {
    const response = await fetch(`/api/review-skill/open${create ? "?create=1" : ""}`, { method: "POST" });
    const body = (await response.json()) as { url?: string; error?: string };
    if (!response.ok || !body.url) throw new Error(body.error ?? "Could not open the skill.");
    if (!tab) throw new Error("The browser blocked the new tab. Run acm skill instead.");
    tab.location.href = body.url;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
