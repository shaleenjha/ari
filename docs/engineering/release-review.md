# Release review

Run before every release tag.

## Steps

1. Claude reviews the diff since the last tag, through the relay or the `@claude` flow already in this repo.
2. Each finding is triaged: fix now, fix later (issue opened), or not a problem (one line on why).
3. The fixes kept for this release land as ONE commit titled `Release review: validated fixes`. Its body groups them:

```
Release review: validated fixes

Security
- ...

Correctness
- ...

Speed
- ...

Reviewed: diff <last tag>..<this commit>. Deferred: #<issue>, ...
```

4. Tag only after the checklist below is all yes.

## Checklist

- [ ] CI is green on main, including `lint:design`.
- [ ] Design builds: checked on a real iPhone and a real Android phone.
- [ ] Migrations apply in order, each with a rollback, staging first.
- [ ] Rollback for this release is written down.
- [ ] No secrets, tokens or real lead data in the diff.
- [ ] Deploy approved by Owner.
