# dos

The DOS distribution shipped with CSS-DOS. These files are auto-added
to every DOS cart's floppy by the builder.

```
dos/
  bin/
    kernel.sys    EDR-DOS kernel (SvarDOS build)
    command.com   DOS shell
```

## What's here

- **`kernel.sys`** — EDR-DOS (SvarDOS build).
- **`command.com`** — DOS shell. Added to the floppy only when a cart's
  `boot.autorun` is `null` (drop-to-prompt mode).

## What is NOT here

Earlier versions of the repo carried a menagerie: multiple kernel variants
(freedos, svardos), a checked-in `disk.img`, test floppies, miscellaneous
DOS utilities. All of that was build artifacts or experimental content.
Only the two files actually needed at build time remain.

If you need a different kernel or extra DOS utilities, the place to add
them is a cart's own files — not here.

## Updating the kernel

Ship the new `kernel.sys` in place. The builder picks it up by path; no
manifest needed. The repo's `kernel.sys` is EDR-DOS — don't swap in
FreeDOS's with the same filename without also updating the tooling that
assumes EDR-DOS's memory layout.
