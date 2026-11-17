import { useEffect, useRef } from "react";
import { startParticles } from "./particles";

export const BLOB_COUNT = 10;

const BLOBS = Array.from({ length: BLOB_COUNT }, (_, index) => index + 1);

export function ParticleField() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => startParticles({ canvas: canvas.current, track: track.current }, window), []);

  return (
    <div className="ambient" aria-hidden="true">
      <div ref={track} className="ambient__track">
        {BLOBS.map((blob) => (
          <span key={blob} className={`blob blob--${blob}`} />
        ))}
      </div>
      <canvas ref={canvas} className="particles" />
    </div>
  );
}
