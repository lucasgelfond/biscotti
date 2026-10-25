# Future work

Things decided or scoped but not built yet, roughly in order.

## Computer use

- **Seat pairs on drawn seat maps.** `jev-quick-browse` reads a seat map's legend colors from the page and
  clicks one open seat on a canvas reliably; picking the seat beside it isn't reliable yet. Try boxing a block of open
  seats and clicking within it, or a vision model's coordinates checked against the order summary.
- **Payment forms in iframes** (Stripe and similar): attach to child frames over DevTools so their fields are seen;
  card fields stay the vault's to fill.
- **Replaying what worked.** Save a site's successful steps and replay them, checking each control is still the same
  one, with the decision model as the fallback.

## Look and feel

- **noVNC in the site's style.** A small page of our own on noVNC's client module (`core/rfb.js`) with the site's CSS,
  instead of noVNC's `vnc.html`: about 60 lines, a VM image change (one snapshot rebuild).

## Security

- **Card-bound encryption on the Pi.** The Pi 5's one-time-programmable key could seal biscotti's data so a removed
  card can't be read. It only helps against the card leaving the Pi (not the whole Pi), the OTP write is permanent,
  and it should cover the settings, Tailscale's state and Docker's data, not just the database.
