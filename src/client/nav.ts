export const NAV = [
  { href: "/", id: "summary", label: "Account Summary" },
  { href: "/top10", id: "top10", label: "Top 10" },
  { href: "/positions", id: "positions", label: "Live Positions" },
  { href: "/simulator", id: "simulator", label: "Simulator" },
  { href: "/review", id: "review", label: "Review" },
  { href: "/rules", id: "rules", label: "Rules" },
  { href: "/settings", id: "settings", label: "Settings" },
] as const;

export type PageId = (typeof NAV)[number]["id"];

/** Settings and Review hide the account strip and the broker-gate banner. */
export const STRIP_HIDDEN: ReadonlySet<PageId> = new Set(["settings", "review"]);

export function pageFromPath(path: string): PageId {
  const hit = NAV.find((item) => item.href !== "/" && (path === item.href || path.startsWith(`${item.href}/`) || path.startsWith(item.href)));
  return hit?.id ?? "summary";
}
