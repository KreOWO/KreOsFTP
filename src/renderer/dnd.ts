/**
 * Contract for dragging entries between the two panes.
 *
 * A custom MIME type is what lets a pane tell an internal drag from a file
 * dropped off the desktop: during `dragover` the browser hides the payload for
 * security, but `dataTransfer.types` is readable, so the drop indicator can be
 * decided before anything is actually dropped.
 */
const MIME_BY_SOURCE = {
  local: 'application/x-kreosftp-local',
  remote: 'application/x-kreosftp-remote'
} as const

/**
 * The source pane is encoded in the MIME type, not the payload, because
 * `dataTransfer.getData` is blocked during `dragover`. Without this a pane
 * could not tell a drag from its neighbour apart from one of its own rows, and
 * would light up a drop indicator for a gesture it then ignores.
 */
export function dndMime(source: 'local' | 'remote'): string {
  return MIME_BY_SOURCE[source]
}

export interface DragPayload {
  source: 'local' | 'remote'
  /** Directory the names are relative to, as it was when the drag started. */
  fromPath: string
  /** Entry names being dragged. */
  names: string[]
  /** True when at least one of them is a directory — the queue expands those. */
  hasDirectories: boolean
}

/** What a pane is willing to receive. */
export interface DropAccepts {
  /** The other pane's entries, when dragged from there. */
  fromPane?: 'local' | 'remote'
  /** Files and folders dragged in from the operating system. */
  osFiles?: boolean
}

export interface DroppedTransfer {
  payload: DragPayload | null
  /** Absolute paths of files dragged in from the OS. */
  osPaths: string[]
  /** Name of the folder row under the cursor, or null when dropped on open space. */
  intoFolder: string | null
}

/** Reads `dataTransfer.types`, the only thing exposed while a drag is in flight. */
export function dragKinds(
  types: readonly string[],
  fromPane: 'local' | 'remote' | undefined
): { internal: boolean; osFiles: boolean } {
  return {
    internal: fromPane !== undefined && types.includes(dndMime(fromPane)),
    osFiles: types.includes('Files')
  }
}
