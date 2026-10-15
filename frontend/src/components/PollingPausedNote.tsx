export function PollingPausedNote() {
  return (
    <p
      role="status"
      className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      Live updates paused while inactive — move the mouse or press a key to
      resume.
    </p>
  )
}
