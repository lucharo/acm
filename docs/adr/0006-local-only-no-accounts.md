# Local-only: no accounts, no access levels; sharing is the user's own tunnel

Remote sharing (issue #2) tempted ACM toward per-person access levels
(edit / suggest / comment-only), which means identity, login, and a
server-side permission model — an auth system. We decided against it: ACM
stays a local tool with no accounts. Sharing, when it lands, is `acm --share`
exposing the already-running local instance over the user's own tunnel
(cloudflared / tailscale), read-only by default. The trust boundary is the
tunnel URL, not an ACM permission table.

## Consequences

- No login surface, no user store, no permission checks anywhere in the
  codebase — "author" stays a self-declared label (`@name`), not an identity.
- Anyone proposing view/comment/edit link tiers should be pointed here: that
  is the rejected alternative, not an oversight.
- Remote collaboration richer than "watch, maybe comment" happens the way
  agent collaboration already does: participants run their own tools against
  a copy of the file, not privileged sessions against a shared server.
