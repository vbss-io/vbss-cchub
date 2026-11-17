export const DOWNLOAD_URL = "https://github.com/vbss-io/vbss-cchub/releases/latest/download/VBSS-CCHUB-Setup.msi";
export const RELEASE_API = "https://api.github.com/repos/vbss-io/vbss-cchub/releases/latest";
export const RELEASES_URL = "https://github.com/vbss-io/vbss-cchub/releases/latest";

const MAX_TITLE_LENGTH = 40;

export interface Highlight {
  title: string | null;
  text: string;
}

export interface LatestRelease {
  version: string;
  highlights: Highlight[];
  downloadUrl: string;
  publishedAt: string | null;
  url: string;
}

export type ReleaseState = { status: "loading" } | { status: "failed" } | { status: "ready"; release: LatestRelease };

interface ReleaseResponse {
  tag_name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  assets?: { name: string; browser_download_url: string }[];
}

export const splitHighlight = (line: string): Highlight => {
  const separator = line.indexOf(": ");
  if (separator <= 0 || separator > MAX_TITLE_LENGTH) return { title: null, text: line };
  const text = line.slice(separator + 2);
  return { title: line.slice(0, separator), text: `${text.charAt(0).toUpperCase()}${text.slice(1)}` };
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export const releaseDate = (iso: string | null): { iso: string; label: string } | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : { iso, label: DATE_FORMAT.format(date) };
};

export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const response = await fetch(RELEASE_API);
    if (!response.ok) return null;
    const data = (await response.json()) as ReleaseResponse;
    const version = data.tag_name?.replace(/^v/, "");
    if (!version) return null;
    const highlights = (data.body ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => splitHighlight(line.slice(2).trim()));
    const versioned = data.assets?.find((asset) => asset.name === `VBSS-CCHUB-Setup-v${version}.msi`);
    return {
      version,
      highlights,
      downloadUrl: versioned?.browser_download_url ?? DOWNLOAD_URL,
      publishedAt: data.published_at ?? null,
      url: data.html_url?.startsWith("https://github.com/") ? data.html_url : RELEASES_URL,
    };
  } catch {
    return null;
  }
}
