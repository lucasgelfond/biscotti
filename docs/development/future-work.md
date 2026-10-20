# Future work

Things decided or scoped but not built yet, roughly in order.

## Computer use

- **Seat pairs on drawn seat maps.** `discriminative-computer-use` reads a seat map's legend colors from the page and
  clicks one open seat on a canvas reliably; picking the seat beside it isn't reliable yet. Try boxing a block of open
  seats and clicking within it, or a vision model's coordinates checked against the order summary.
- **Payment forms in iframes** (Stripe and similar): attach to child frames over DevTools so their fields are seen;
  card fields stay the vault's to fill.
- **Replaying what worked.** Save a site's successful steps and replay them, checking each control is still the same
  one, with the decision model as the fallback.
- **pi-computer-use for the task agent** (github.com/injaneity/pi-computer-use): its Linux backend (AT-SPI plus
  Chromium over DevTools) and its checked outcomes (worked / didn't / unknown, with postconditions) could replace the
  task VM's Playwright and desktop tools. Needs a trial in the VM image (its Rust helper on arm64, an AT-SPI bus).

## Look and feel

- **noVNC in the site's style.** A small page of our own on noVNC's client module (`core/rfb.js`) with the site's CSS,
  instead of noVNC's `vnc.html`: about 60 lines, a VM image change (one snapshot rebuild).

## Security

- **Card-bound encryption on the Pi.** The Pi 5's one-time-programmable key could seal biscotti's data so a removed
  card can't be read. It only helps against the card leaving the Pi (not the whole Pi), the OTP write is permanent,
  and it should cover the settings, Tailscale's state and Docker's data, not just the database.
