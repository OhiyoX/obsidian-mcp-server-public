# Contributing

Thanks for helping improve Obsidian MCP Server.

**This repository is the public source snapshot and the community contribution entry point.** Maintainers review accepted changes in a private development line first, then include them in a later public snapshot. You do not need access to any other repository to contribute here.

## Issues

- Search existing issues first.
- Use the issue templates; include a minimal reproduction and the commit you
  tested.
- Never paste real tokens, vault contents, customer data, private hostnames, or
  full logs containing them.

## Pull requests

1. Open an issue for a non-trivial change so the approach can be agreed first.
2. Fork the repository and branch from `main`.
3. Keep the change focused; update tests and documentation with the code.
4. Run `npm ci --prefix app` and `npm run check --prefix app`; run the affected
   tests locally.
5. Open the pull request with the problem, the change, and the verification you
   ran.

Maintainers review accepted public changes and include them in a later public
snapshot. Attribution is recorded in the public release notes or an equivalent
public record, **not necessarily preserved as the original commit graph**.
Direct pushes to the public `main` from contributors are not accepted. A GitHub
PR being opened or reviewed does not mean it shipped.

## Licensing

By contributing, you agree that your contribution is licensed under the MIT
License in `LICENSE`.

## Data hygiene

Use reserved example values in tests and documentation. Do not add real
deployment targets, internal paths, personal email addresses, or credentials.
