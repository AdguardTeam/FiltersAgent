# Deployment

How FiltersAgent is released: what a release contains, how to cut one and how
to check it reached the public repository.

- [Deployment Summary](#deployment-summary)
- [What a Release Contains](#what-a-release-contains)
- [Release a Version](#release-a-version)
- [Verify a Release](#verify-a-release)
- [CI/CD](#cicd)

## Deployment Summary

| Parameter | Value |
| --- | --- |
| **Public repository** | `AdguardTeam/FiltersAgent` (a mirror) |
| **Release tags** | `vX.Y.Z` and the moving major tag `vX` |
| **Version source** | `CHANGELOG.md`; `package.json` has no `version` |
| **Registry** | None: workflows reference the repository by tag |
| **Runner label** | `team-filters` |

## What a Release Contains

A release is a tag. Workflows use the two actions from the public repository
at that tag:

```yaml
- uses: AdguardTeam/FiltersAgent/adguard-cli@v1
- uses: AdguardTeam/FiltersAgent@v1
```

- `AdguardTeam/FiltersAgent@vX` — the container action: `action.yml` at the
  repository root. The runner builds the image from `action.Dockerfile` at the
  tagged commit in every job that uses it; no image is published.
- `AdguardTeam/FiltersAgent/adguard-cli@vX` — the AdGuard CLI setup action:
  `adguard-cli/action.yml`. The module is generated and committed, so the tag
  carries it as built; see
  [Build the AdGuard CLI module](DEVELOPMENT.md#build-the-adguard-cli-module).

`vX` points at the latest `vX.Y.Z` release. `vX.Y.Z` pins one release.

## Release a Version

Development happens in the internal repository; the public repository is its
mirror. Create and move tags only in the internal repository. A tag pushed to
the public repository directly is overwritten by the next mirror run.

1. Pick the version from the `[Unreleased]` entries in `CHANGELOG.md`, as
   [Semantic Versioning](https://semver.org/spec/v2.0.0.html) defines it.
2. Open a pull request with its own ticket: branch
   `chore/AG-<n>-release-vX-Y-Z`, title `AG-<n> Release vX.Y.Z`. In
   `CHANGELOG.md`:
    - move the `[Unreleased]` entries under a new `## [X.Y.Z] - YYYY-MM-DD`
      heading and leave `## [Unreleased]` empty above it;
    - point `[Unreleased]` at `compare/vX.Y.Z...HEAD` and add
      `[X.Y.Z]: https://github.com/AdguardTeam/FiltersAgent/compare/vP.Q.R...vX.Y.Z`,
      where `vP.Q.R` is the previous release.
3. Merge the pull request once the `Checks` workflow passes.
4. Tag the merge commit and push the tag:

    ```bash
    git switch master
    git pull --ff-only
    git tag -a vX.Y.Z -m vX.Y.Z
    git push origin vX.Y.Z
    ```

5. Move the major tag to the same commit. Skip this step for a pre-release such
   as `vX.Y.Z-beta.1`: `vX` follows releases only.

    ```bash
    git tag -f -a vX -m vX 'vX.Y.Z^{commit}'
    git push --force origin refs/tags/vX
    ```

    `^{commit}` makes `vX` point at the commit, not at the `vX.Y.Z` tag
    object.

6. The `Mirror` workflow pushes `master` and the tags to
   `AdguardTeam/FiltersAgent`, overwriting the moved `vX` there.
7. Optionally, publish a GitHub Release in the public repository from the tag,
   with the version's `CHANGELOG.md` section as its notes:

    ```bash
    gh release create vX.Y.Z --repo AdguardTeam/FiltersAgent --verify-tag \
        --title vX.Y.Z --notes-file notes.md
    ```

    Add `--prerelease` for a pre-release.

## Verify a Release

Once the `Mirror` run finishes:

1. The public tags point at the released commit. Each command prints the commit
   on its `^{}` line; both must match `git rev-parse 'vX.Y.Z^{commit}'`:

    ```bash
    git ls-remote https://github.com/AdguardTeam/FiltersAgent \
        'refs/tags/vX.Y.Z^{}' 'refs/tags/vX^{}'
    ```

2. The tag carries both actions:

    ```bash
    for path in action.yml adguard-cli/action.yml; do
        gh api "repos/AdguardTeam/FiltersAgent/contents/$path?ref=vX" --jq .path
    done
    ```

## CI/CD

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `checks.yml` | Pull requests, pushes to `master` | Tests, lint, types, formatting, committed AdGuard CLI module |
| `action-image-check.yml` | Pull requests touching the image, manual | Build the action image |
| `mirror.yml` | Pushes to `master`, pushed `v*` tags | Mirror `master` and tags to `AdguardTeam/FiltersAgent` |

The mirror carries `master` and tags only; other branches stay internal.
Workflows are disabled in the public repository.
