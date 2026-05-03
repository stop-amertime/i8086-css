# Example carts

Maintained example carts shipped with the repo. Each folder here is a cart
that the builder can turn into a cabinet.

| Cart | Description | Preset |
|---|---|---|
| `rogue/` | Classic 1980 dungeon-crawler. | `dos-muslin` |

To build one:

```
node builder/build.mjs carts/rogue -o rogue.css
```

To run the cabinet:

- Start the dev server (`node web/scripts/dev.mjs`), open
  `http://localhost:5173/build.html`, point it at your cabinet, then
  click through to `calcite.html`. Pure CSS in Chrome.
- Or run it fast: `../calcite/target/release/calcite-cli -i rogue.css`.

## Adding your own

Drop a folder (or zip) containing a DOS `.COM`/`.EXE` — the builder infers
sensible defaults without a `program.json`. See `docs/cart-format.md` for
the cart schema and `docs/building.md` for the walkthrough.
