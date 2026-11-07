---
name: phone-first-pwa
description: Patterns for a no-framework, phone-first installable web app (HTML/CSS/JS) — safe areas, offline service worker, localStorage, Web Audio sound, vibration, drag gestures, reduced motion. Use when building any mobile web app that gets installed to a home screen.
---

# Phone-first static PWA (no framework)

From Evens: tested on a Samsung S22 Ultra (~412px wide, Android Chrome, installed to the home screen). All of this is plain HTML/CSS/JS served from GitHub Pages.

## Page basics
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, plus page bottom padding `calc(24px + env(safe-area-inset-bottom))`. Without both, footers sit behind the Android nav bar.
- Design tokens in `:root` at the top of the CSS; change a colour once.
- **Self-host fonts** as `.woff2` in `docs/fonts/` (OFL fonts) so the app works offline and loads fast. Include them in the service worker shell list.
- `font-variant-numeric: tabular-nums` on anything numeric so digits don't jitter.
- Big tap targets; dark by default; readable in poor light. Never carry meaning by colour alone — pair it with a symbol and words (✓ / ✗ / + / −).
- Routing by hash (`#home`, `#build`, …): no router library, back button just works.

## Offline and updates
- `manifest.webmanifest` with `display: standalone`, 192 and 512 icons, a maskable icon, and `theme_color`/`background_color` matching the app.
- Service worker: cache the shell on install; **network-first** for shell files (so updates land) with cache fallback offline; for `/data/` files fetch fresh and fall back to the last cached copy.
- **Bump `VERSION` in `sw.js` whenever any app file changes**, or phones keep serving the old shell.
- Re-fetch live data on an interval while the page is open (Evens: 90s), not just at load.

## State
- Wrap `localStorage` in `get(k, default)` / `set(k, v)` with try/catch (it can throw or come back empty); namespace the keys (`evens.prefs`, `evens.slip`).
- Keep per-user data on the phone only. Put preferences in one object and migrate by defaulting missing fields.

## Sound (no files, no library)
- Synthesise with the Web Audio API: small `tone(freq, start, dur, type, vol)` helper using an oscillator and an exponential gain ramp. Named effects (`hold`, `stop`, `jackpot`, `placed`) are just short note sequences.
- Browsers only allow audio after a gesture: call `ctx.resume()` on the first `pointerdown` anywhere (`{ once: true }`).
- Android plays web audio on the **media** volume, so silent mode doesn't mute it. Put an obvious mute button on screen and store the setting; default on only if the owner wants it.

## Vibration and motion
- `navigator.vibrate` behind a feature check and try/catch, and a settings toggle.
- Respect `prefers-reduced-motion`: skip flashing/spinning/turning, keep static equivalents.

## Gestures
- Drag controls (e.g. a lever): pointer events, `setPointerCapture` on pointerdown, `touch-action: none` on the handle, `touch-action: pan-x` where vertical swipes are used for something else. Release threshold ~70% of travel, then spring back with a small overshoot.
- Page-level horizontal swipes: **start from the middle, not the screen edge** (Android's back gesture owns the edges). Lock the gesture only when horizontal-dominant (|dx| > 1.4 × |dy| over ~10px) and only then capture the pointer, so taps and vertical gestures still work. Commit at ~70px or a quick flick, else spring back.
- Long-press and double-tap on numbers: set `user-select: none`, `-webkit-touch-callout: none`, `touch-action: manipulation`.

## Layout tests worth doing
- Check the main screen at 412×870 with the keyboard closed: the primary content and the navigation should fit without scrolling.
- Long labels: shrink font in steps to a minimum (~12px), allow up to 3 lines, then fall back to a short code. Check the narrowest case (five columns across ~412px).

## Working with a separate design chat
- Keep the design brief and handoff notes as project docs (`claude/…-handoff.md`) and the repo's `CLAUDE.md` as the build-side source of truth. The design session produces mockups; the build session owns the code.
