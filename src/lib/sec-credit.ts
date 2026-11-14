/** Shown under Top 10 and on Settings. No SEC seal, no logo. */
export const SEC_CREDIT = "Company names, exchanges, and industries come from SEC public company data. Sector is the SIC division. A company with no SIC shows an em dash.";

export const EM_DASH = "—";

export function displaySecText(value: string | null | undefined): string {
  const text = value?.trim();
  return text ? text : EM_DASH;
}
