# The Murmur landing page

Served by GitHub Pages from this folder on `main`, at
<https://jdbremer.github.io/Murmur/>.

To publish it the first time: **Settings → Pages → Source: Deploy from a
branch → Branch: `main`, Folder: `/docs`**. There is no build step — what is in
this folder is what is served.

## What is here

| File         |                                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| `index.html` | The page.                                                                        |
| `styles.css` | Its design tokens are the app's own, from `apps/desktop/src/renderer/theme.css`. |
| `murmur.js`  | The hero's live pill, the scroll reveals, and the platform-aware download.       |
| `fonts/`     | Instrument Serif, self-hosted (SIL OFL 1.1, licence included).                   |
| `shots/`     | Screenshots of the real application.                                             |

## The screenshots are real, and none of them are anyone's dictations

They are captured from the installed, signed build, launched with
`--user-data-dir` pointing at a throwaway profile holding invented sample
content. That matters twice over: the permission grants are real, so the
dashboard shows the app genuinely ready rather than complaining about a
sandboxed dev binary — and no real transcript can end up on a public page.

To retake them after a UI change, see `scripts/` in the repository history for
the capture script, or drive `/Applications/Murmur.app` over CDP the same way:
launch it with `open` (not by spawning the binary, or macOS attributes the
Accessibility grant to the launcher and every permission reads as denied).

## Two deliberate choices

**The font is self-hosted.** A page whose headline claim is that nothing leaves
your machine should not open a connection to a third party to render that
headline.

**The download button uses the GitHub API.** One anonymous `GET` to
`/releases/latest`, purely so the button is a download rather than a trip to a
list. Every failure path — offline, rate-limited, blocked, no JavaScript —
leaves the links pointing at the releases page, which is what the markup says
before any script runs. The page also picks the right artifact per platform and
architecture, and rewrites the dictation key it shows: `fn` on macOS, right
`Ctrl` on Windows and Linux.
