import { createContext, useContext, type ReactNode } from "react";
import type { UiPrefs, UiPrefsPatch } from "./delegation";
import { emptyUiPrefs } from "./plugins/ui-prefs";

export interface UiPrefsContextValue {
  uiPrefs: UiPrefs;
  updateUiPrefs: (patch: UiPrefsPatch) => Promise<void>;
}

const UiPrefsContext = createContext<UiPrefsContextValue>({ uiPrefs: emptyUiPrefs(), updateUiPrefs: () => Promise.resolve() });

export function UiPrefsProvider({ value, children }: { value: UiPrefsContextValue; children: ReactNode }) {
  return <UiPrefsContext value={value}>{children}</UiPrefsContext>;
}

export const useUiPrefs = (): UiPrefsContextValue => useContext(UiPrefsContext);
