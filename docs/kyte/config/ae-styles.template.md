# AE styles (template for the private plans/copy-lab/ae-styles.md)

The real file named real AEs and customers, so it stayed private. Recreate it with this shape. `scripts/copy_check.py` enforces the same rules using `config/seller.private.json`, so keep the two in step.

## Shared rules (every AE)
- Point first: the point as a statement (their product or workflow + the exact sensitive data + where it bites), what we do in under 10 words, optional one short proof, one closed ask. The ask is the only question mark.
- Lengths: DM1 under 45 words, DM2 under 40, DM3 under 35 (style B allows DM1 up to 50).
- Openers: DM1 "Thanks for connecting, <First>." or "<First>, quick one." DM2 "<First>, following up on <the DM1 point in a few words>." DM3 "<First>, last one from me on <the thread's point>." then "If <the concrete stall> comes up, happy to show how (<customer> handles it)." then "Worth a quick call?"
- Never: open questions, "curious", "wondering", "the reason I asked", "I'm assuming", "Most <peers> we talk to", "swap notes", hype words, dashes, links, explaining how it works, offering guides or documents.
- A trigger only when it is real and dated on file, worked into the statement.
- DM2 and DM3 reuse a concrete word from what was already sent.

## Style A (<AE key>, default)
- Ask: "Worth 15 minutes?"
- Proof: may name any customer in `allowed_customers`.

## Style B (<AE key>)
- Ask: "Worth 20 minutes?"
- Proof: names `style_b_customer` only, never a competitor.

## Never name
- `never_name` in any draft for any AE.

## Connect notes (off by default, note_mode none)
- Under 200 characters, no link, opens "Hi <First>,", ends "Worth connecting?". One proof line for style A; "Teams like <style_b_customer> use it." for style B.
