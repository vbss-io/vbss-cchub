interface ChangelogEntry {
  version: string;
  date: string;
  highlights: string[];
}

declare const __APP_VERSION__: string;
declare const __CHANGELOG__: ChangelogEntry[];
