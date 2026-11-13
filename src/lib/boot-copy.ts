/**
 * First-paint chrome for the session bootstrap, including load failures.
 * Keep these strings in sync with docs/DESIGN.md §6.1.
 */
export function sessionBootstrapCopy(session: { authenticated: boolean } | null, error: string): { heading: string; error: string } {
  if (!session) return { heading: "Loading…", error };
  return { heading: "", error };
}
