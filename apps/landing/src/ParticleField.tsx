import { useEffect, useRef } from "react";
import { startParticles } from "./particles";

export function ParticleField() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => startParticles(canvas.current, window), []);

  return <canvas ref={canvas} className="particles" aria-hidden="true" />;
}
