/**
 * The capture worklet is plain JS that runs in AudioWorkletGlobalScope: it
 * registers itself with `registerProcessor` and exports nothing.
 *
 * This declaration exists purely so the type-checked unit suite can import the
 * module for its side effect (see `test/capture-processor.test.ts`, which
 * installs the worklet globals and captures the class as it registers). The
 * page itself never imports it as a module — it loads it by URL through
 * `audioWorklet.addModule`.
 */
export {}
