export const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function restartHub(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("restart_sidecar");
}
