type LogoProps = {
  className?: string
}

/**
 * Monochrome mark: an arrow dropping into a tray, representing an
 * incoming webhook request being captured for inspection.
 */
export function Logo({ className = 'h-6 w-6' }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role="img"
      aria-label="Webhook Listener logo"
    >
      <path
        d="M12 5v9m0 0 3.5-3.5M12 14l-3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 15v2a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
