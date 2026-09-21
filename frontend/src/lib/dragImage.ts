import type { DragEvent } from 'react'

const DEFAULT_OPACITY = 0.12

// Browsers auto-generate a drag-ghost snapshot of the dragged element at
// roughly 50% opacity, with no way to tune that directly. To make it more
// transparent, clone the element, restyle the clone, and hand it to
// dataTransfer.setDragImage — then remove the clone once the browser has
// captured its snapshot (synchronously, before this handler returns, so a
// same-tick removal would delete it too early on some browsers; deferring
// via setTimeout(0) is the standard workaround).
export function setTransparentDragImage(e: DragEvent<HTMLElement>, opacity: number = DEFAULT_OPACITY): void {
  const source = e.currentTarget
  const node = source.cloneNode(true) as HTMLElement
  node.style.position = 'absolute'
  node.style.top = '-9999px'
  node.style.left = '-9999px'
  node.style.width = `${source.offsetWidth}px`
  node.style.opacity = String(opacity)
  document.body.appendChild(node)
  e.dataTransfer.setDragImage(node, e.nativeEvent.offsetX, e.nativeEvent.offsetY)
  setTimeout(() => node.remove(), 0)
}
