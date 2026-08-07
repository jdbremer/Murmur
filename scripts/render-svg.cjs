// Rasterise an SVG to a PNG *with its alpha intact*.
//
// This exists because `qlmanage -t` — the obvious stock choice, and what this
// repo used first — composites its preview onto white. The icon's rounded
// corners and the padding around them came out opaque white, which on a Mac
// Dock reads as a white border stuck to the app.
//
// Chromium already ships in this repo, renders SVG properly, and can capture a
// transparent window, so it is the rasteriser. No new dependency.
//
//   npx electron scripts/render-svg.cjs <in.svg> <out.png> <size>
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')

const [svgPath, outPath, sizeArg] = process.argv.slice(2)
const size = Number(sizeArg) || 1024

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  })

  // The SVG is inlined rather than loaded by URL so no file:// permissions or
  // relative-path resolution come into it. `margin: 0` and a transparent body
  // keep the capture to exactly the artwork.
  const svg = readFileSync(svgPath, 'utf8')
  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  // One frame is not always enough for the gradients to be composited.
  await new Promise((resolve) => setTimeout(resolve, 400))

  const image = await window.capturePage()
  writeFileSync(outPath, image.toPNG())
  app.exit(0)
})
