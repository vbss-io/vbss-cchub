export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="bmRing" x1="256" y1="100" x2="256" y2="412" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8f66f7" />
          <stop offset="1" stopColor="#6321cf" />
        </linearGradient>
        <linearGradient id="bmShaft" x1="232" y1="272" x2="316" y2="188" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f59e0b" />
          <stop offset="0.42" stopColor="#9a6cf0" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <radialGradient id="bmGlow">
          <stop offset="0" stopColor="#ffd489" />
          <stop offset="0.32" stopColor="#f9a825" />
          <stop offset="0.62" stopColor="#f59e0b" stopOpacity="0.32" />
          <stop offset="1" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="256" cy="256" r="150" stroke="url(#bmRing)" strokeWidth="30" />
      <g>
        <circle cx="186" cy="268" r="18" fill="url(#bmGlow)" />
        <circle cx="210" cy="312" r="16" fill="url(#bmGlow)" />
        <circle cx="294" cy="306" r="16" fill="url(#bmGlow)" />
        <circle cx="252" cy="350" r="18" fill="url(#bmGlow)" />
        <circle cx="186" cy="268" r="7" fill="#fbb43a" />
        <circle cx="210" cy="312" r="6.5" fill="#fbb43a" />
        <circle cx="294" cy="306" r="6.5" fill="#fbb43a" />
        <circle cx="252" cy="350" r="7" fill="#fbb43a" />
      </g>
      <line x1="232" y1="272" x2="308" y2="196" stroke="url(#bmShaft)" strokeWidth="24" strokeLinecap="round" />
      <path d="M338 166 L322.5 215.5 L288.5 181.5 Z" fill="#7c3aed" />
      <circle cx="246" cy="258" r="46" fill="url(#bmGlow)" />
      <circle cx="246" cy="258" r="21" fill="#f9a825" />
      <circle cx="246" cy="258" r="21" fill="url(#bmGlow)" opacity="0.55" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wm">
      <span className="vsplit">V</span>BSS CCHUB
    </span>
  );
}
