# Judge canary fixtures

The PNGs are the authoritative hand-labelled judge inputs. Adjacent SVGs preserve reviewable source
for the same 640 x 400 compositions; the production judge sends the PNGs through the
OpenAI-compatible `image_url` path.

- `strong`: polished, coherent dashboard with clear hierarchy.
- `middling`: complete and usable, but generic and visually flat.
- `broken-ui`: overlapping, clipped, low-quality visual output.
- `broken-functional`: credible UI paired with explicit failed functional evidence.
