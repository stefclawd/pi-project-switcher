# Tasks: offer-create-project-on-unknown

## 1. Name parsing & safety validation

- [ ] In `index.ts` command handler: strip trailing `!` as explicit create
      opt-in; keep a flag `createOptIn`.
- [ ] Add `isSafeProjectName(name)` helper: reject names containing `/` or
      `\`, containing `..`, absolute paths, and names starting with `.`;
      reject empty and `.`/`!`-only.

## 2. Unknown-project branch: offer, create, switch

- [ ] When project missing AND name is safe:
      - if `createOptIn` → create directly;
      - else if `ctx.hasUI` → `ctx.ui.confirm("Create project?", …)`
        with the absolute path in the message; use the boolean result;
      - else → keep current warning (headless, no opt-in).
- [ ] On confirm/opt-in: `mkdirSync(join(baseDir, name), { recursive: false })`,
      catch errors → notify error, state unchanged.
- [ ] Notify `Created project folder: <abs path>`, then fall through into
      the existing switch flow (first-session path).
- [ ] Unsafe names skip the offer entirely → existing warning.

## 3. Tests

- [ ] `/project newproj` with confirm mocked to `true` → folder created,
      switch notifications as on first-session path (workdir + first
      session + continuing session).
- [ ] confirm mocked to `false` → warning, no folder, state unchanged.
- [ ] `/project newproj!` headless (`hasUI: false`) → created + switched
      without dialog.
- [ ] `/project newproj!` with unsafe name (`../x!`, `a/b!`, `.hidden!`)
      → warning, no creation.
- [ ] `/project name!` where mkdir fails (pre-create a FILE of that name)
      → error notification, state unchanged.
- [ ] Headless without `!` → old warning, no creation.
- [ ] `npx vitest run` green; `npx tsc --noEmit` clean.

## 4. Docs & Release

- [ ] README: document the creation offer and the `!` opt-in.
- [ ] Archive the change (delta into main spec), bump version to 0.5.0,
      commit, tag `v0.5.0`, push — trusted publishing publishes.
- [ ] Confirm npm `latest` + provenance attestations; update the
      installed copy in `~/.pi/agent/git/…` afterwards.
