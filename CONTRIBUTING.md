# Contributing

Thanks for helping improve Obsidian MCP Server.

## Issues

- Search existing issues before opening a new one.
- Include reproduction steps, expected and actual behavior, and the version or commit you tested.
- For security vulnerabilities, use [SECURITY.md](SECURITY.md) instead of a public issue.
- Do not paste credentials, real vault contents, private hostnames, or logs containing sensitive values.

## Pull requests

1. For non-trivial changes, discuss the proposed approach in an issue.
2. Fork the repository and create a focused branch from `main`.
3. Update tests and documentation together with code changes.
4. Run `npm ci --prefix app`, `npm run check --prefix app`, and relevant tests locally.
5. Include the purpose, changes, test evidence, known limitations, and any breaking behavior in the pull request.

Maintainers review submissions and decide whether and when to incorporate changes. Contributions may need additional integration and validation before appearing in a release. Please keep the pull request available for review and attribution. Do not push directly to `main`.

## Licensing and data hygiene

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE). Use reserved example values in tests and documentation; keep real deployment paths, personal email addresses, secrets, and private customer or user data out of the repository.
