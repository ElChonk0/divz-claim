# divz-claim

Hosting for the Divz "claim your items" page.

When someone splits a bill in Divz, they can share a QR code or link. Whoever
opens it lands on `index.html` here: they type a name and tick off what they
had, and their picks appear live on the host's phone. No app, no account.

**This is a published copy, not the source.** The original lives in the Divz
repo at `claim/index.html` — edit it there and copy the result here, so the two
don't drift.

The Supabase key in the page is the public anon key (the same one shipped in the
app). It is not a secret: row-level security and the `claim_*` SECURITY DEFINER
functions are what actually control access.
