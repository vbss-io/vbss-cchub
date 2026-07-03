const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function openExternal(url: string): Promise<void> {
  if (inTauri()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

export const COFFEE_URL = "https://www.buymeacoffee.com/vbss.io";

export async function notify(title: string, body: string): Promise<void> {
  if (!inTauri()) return;
  const { isPermissionGranted, requestPermission, sendNotification } = await import(
    "@tauri-apps/plugin-notification"
  );
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  if (granted) sendNotification({ title, body });
}

export type SoundKind = "attention" | "idle" | "finished";

let audioContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  audioContext ??= new Ctor();
  if (audioContext.state === "suspended") void audioContext.resume();
  return audioContext;
}

export function unlockAudio(): void {
  const ctx = getContext();
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

function beep(
  ctx: AudioContext,
  freq: number,
  start: number,
  dur: number,
  peak: number,
  type: OscillatorType,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.03);
}

export async function playSound(kind: SoundKind): Promise<void> {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* ignore */
    }
  }
  const t = ctx.currentTime + 0.02;
  if (kind === "attention") {
    beep(ctx, 784, t, 0.12, 0.1, "sine");
    beep(ctx, 988, t + 0.13, 0.13, 0.1, "sine");
  } else if (kind === "idle") {
    beep(ctx, 620, t, 0.14, 0.14, "sine");
    beep(ctx, 466, t + 0.15, 0.17, 0.14, "sine");
  } else {
    beep(ctx, 880, t, 0.16, 0.3, "triangle");
    beep(ctx, 660, t + 0.19, 0.16, 0.3, "triangle");
    beep(ctx, 440, t + 0.38, 0.24, 0.32, "triangle");
  }
}
