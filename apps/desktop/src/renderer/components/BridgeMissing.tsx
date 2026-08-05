/**
 * Shown when `window.murmur` is absent — i.e. the preload script failed to
 * load. Without the bridge a renderer can do nothing at all, so say so plainly
 * rather than rendering a UI where every control silently fails.
 */
export function BridgeMissing({ window: name }: { window: string }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-8 text-center">
      <div className="max-w-md">
        <h1 className="text-lg font-semibold text-ink">{name} could not start</h1>
        <p className="mt-2 text-sm text-ink-muted">
          The preload bridge (<code className="font-mono">window.murmur</code>) is not available, so
          this window cannot reach the main process. Check the main-process console for a preload
          error.
        </p>
      </div>
    </div>
  )
}
