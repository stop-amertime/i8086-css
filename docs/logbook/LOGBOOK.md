# CSS-DOS Logbook

Last updated: 2026-04-23

## Current status

Zork and Montezuma's Revenge both boot and run under dos-corduroy with
autofit memory — video is good and performance is good as of just
before the memory-packing merge attempt. These are the canonical
smoke tests; carts live in `carts/`.

Non-planar video modes should be working following the recent
video-modes work.

## In flight

- **Memory packing (2 bytes per property):** ongoing, tricky.
- **Doom8088:** almost there. Boot splash (mode 13h) and text-mode
  kernel/ANSI output display correctly; hangs after the kernel DOS
  message where the game should start. Ticks continue, but execution
  has gone wrong.

## Boot sequence (dos-corduroy)

1. Mode 13h boot splash
2. Text mode — kernel message + ANSI message
3. Game starts

Full boot is typically 2–4 million ticks. "Ticks are running" is
NOT a pass — video must come out and be clearly recognisable as
the game.

## How to test

Default: dos-corduroy preset, autofit memory, via the web player.
**Ask the user how to test** for anything beyond the basic smoke test.
Log good methods here as you find them.

## Priority: unify debug + conformance infrastructure

This is a recurring pain point. The goal is one clear, well-featured
flow covering:

a) Building a cabinet from source
b) Parsing / compiling it
c) Running it with visibility into what video is being streamed out,
   plus tick-forward and path-comparison debug tools

## Model gotchas

- Don't just run ticks and call it a pass — verify video.
- Ask the user how to test rather than guessing.
- Web player and MCP debugger are for different things — pick the
  right one for the task. Log which tool fits which job here as you
  learn it.
