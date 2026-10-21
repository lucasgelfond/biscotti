# Style notes

## The architecture diagram

`site/public/architecture.svg` (and its `.png`) is the reference. Redraw it only for a major release.

- Boxes hold names only: no subtitles or taglines ("main agent · no network").
- Draw only what the code does. Check where each piece runs before placing it: crons, for one, run in the gate
  process today.
- Arrows carry no labels unless one is essential, and never implementation terms ("sockets").
- Keep the look: monospace, black on white. Solid boxes are core, dashed ones are optional (plugins and services),
  orange hatching is Firecracker.
