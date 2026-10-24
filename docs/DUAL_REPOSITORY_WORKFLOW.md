# Dual-repository workflow

This project is developed in a private repository. The public GitHub repository is a reviewed, sanitized **source snapshot** and the community entry point. The two repositories intentionally do not share commit SHAs or Git history.

## Publication model

- Development, review, release tags and production provenance belong to the private repository.
- Public releases are one-way snapshots of a reviewed source tree. They are not a mirror and are never a bidirectional sync.
- A public commit proves what was published, not which private commit is running in production.
- External issues and pull requests are welcome on GitHub. Accepted changes are carried into the private development line through a reviewed, attributed change and appear in a later snapshot.

## What a snapshot must pass

1. **Fixed source identity** — record the exact source tree and the intended publication scope.
2. **Explicit file allowlist** — export from a clean, isolated staging tree; unknown files are refused by default.
3. **Secret and privacy scan** — check the current tree, examples, fixtures, generated assets, source maps, logs and documentation for credentials, internal hosts, real vault content, personal data and deployment details.
4. **Public-only content review** — keep the public README, contribution guide, security policy and public documentation consistent with the snapshot.
5. **Validation** — run the relevant syntax, build and test gates on the published tree; report skipped or unavailable checks honestly.
6. **Receipt** — record source tree, public commit, file manifest, intentional differences, scan result and validation summary in the private project record.

## Boundaries

- Do not publish private Git history, branches, tags, pull-request discussions, Actions artifacts or internal review evidence.
- Do not mirror credentials, private hostnames, absolute operator paths or real vault data.
- Do not use `git push --mirror` or force-push public history as part of an ordinary publication.
- If sensitive information is published by mistake, rotate the affected credential first; a revert alone does not remove the exposure.
- Repository settings such as the About text and topics are platform metadata, not files; update and verify them separately.

## 中文摘要

私有仓负责开发、审查、发布标签与生产来源；GitHub 公开仓是经审查、脱敏的单向源码快照与社区入口，两边 SHA 与历史可以不同。每次快照都要固定来源、按白名单导出、扫描秘密与隐私、验证构建与测试，并在私有记录中保留发布回执。不镜像私有历史、分支、标签、讨论或凭据；不把 GitHub SHA 当作生产身份。
