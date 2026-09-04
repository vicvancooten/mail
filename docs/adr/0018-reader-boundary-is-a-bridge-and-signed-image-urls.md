# The reader's sandbox stays closed; links and images cross it by bridge and by signed URL

Message bodies render in an iframe sandboxed to `allow-scripts` only, with an opaque origin and a
CSP that denies everything but inline styles, nonce'd scripts and same-origin images (research note
`docs/research/0005`). Two things a mail client must do — open a link the sender wrote, and load a
remote image the User asked for — cannot happen from inside that box: the sandbox swallows
`target=_blank` clicks, and the browser withholds the `SameSite=Lax` session cookie from an
opaque-origin frame, so the authenticated image proxy answers 401. We decided to keep the sandbox
exactly as it is and cross the boundary two ways: a **click bridge**, where the nonce'd in-frame
script intercepts anchor clicks and `postMessage`s the `href` to the parent, which validates the
scheme and either opens `http(s)` with `noopener` or routes `mailto:` into the Composer; and
**signed, expiring, session-free image URLs**, where `/messages/:id/image-proxy` stops requiring a
session and trusts the HMAC it already carries over `(messageId, url)`, extended with an expiry.

## Considered Options

- **`allow-popups` + `allow-popups-to-escape-sandbox`**: the one-line fix for links. Rejected because
  it hands every click to the browser: `mailto:` leaves the app for the OS mail handler, and there
  is no seam for a hover URL preview or a "this link goes somewhere else than it says" warning later.
  The bridge costs a few dozen lines and owns the click.
- **`allow-same-origin` on the iframe**: makes the cookie flow. Rejected outright — combined with
  `allow-scripts` it lets sanitizer-evading content reach the parent's origin, which is the whole
  thing the sandbox exists to prevent.
- **`SameSite=None` on the session cookie**: makes the cookie flow everywhere. Rejected because it
  weakens the CSRF posture of every authenticated route to fix one image route.

## Consequences

- A proxy URL is a bearer token for one remote image for its lifetime. Anyone holding it can make the
  Sync Backend fetch that image; the SSRF guards still apply, and the expiry bounds the window.
  Tracking pixels fire only when a User (or someone they forwarded a URL to) asks — same as today.
- If the app is ever served from a different origin than the API, the CSP's `img-src`, pinned to
  the parent's origin because `'self'` matches nothing in an opaque frame, has to name the API
  origin instead.
- The bridge is the only script that runs in the frame; every new capability that needs the parent
  (link preview, "copy link", inline reply-to-quote) goes through it rather than through a new
  sandbox flag.
