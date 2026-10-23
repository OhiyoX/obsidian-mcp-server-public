# Self-hosted deployment and updates

Obsidian MCP Server runs as a Docker Compose service and stores your notes in a mounted vault directory. This guide is for people deploying the public source on their own infrastructure.

For first-time installation, see [README.md](../README.md#quick-start) and [docs/USER_CONFIGURATION.md](USER_CONFIGURATION.md). Review `.env.example` and keep actual credentials in your local, untracked `.env`.

## Before changing a running service

1. Back up the **vault** and the service's persistent `data/` directory separately. Keep a tested restore path.
2. Record the currently running revision and locally configured image/build settings.
3. Review release notes and changes between revisions, especially configuration, database state, and dependencies.
4. Check that the vault mount, persistent volumes, authentication, and HTTPS reverse-proxy configuration are correct.
5. Test upgrades against a non-production copy of your data if the change could affect writes or storage format.

## Update a source-based Compose installation

In a clean checkout intended for deployment, retrieve the revision you want to run, then rebuild and restart using Docker Compose. For example:

```sh
docker compose config
docker compose up -d --build
docker compose ps
```

The example rebuilds from the **current checkout**; it does not automatically fetch new source. Use the Git revision or immutable release reference that you explicitly selected. Avoid editing deployed source files directly or allowing two independent updaters to mutate the same deployment.

Verify the service health, login, MCP authorization, a permitted read request, and representative Web behavior. If a check fails, restore the previous known-good source/image and, if needed, the matching data backup. Reverting code is not by itself a substitute for restoring data after a schema or format migration.

## Safety

- Expose remote MCP and Web interfaces only through trusted HTTPS and appropriate authentication.
- Never commit `.env`, access keys, persistent data, vault contents, or operational logs.
- Do not assume a Git push, commit, tag, or green CI run implies anything was deployed.
- See [WEB_OPERATIONS.md](WEB_OPERATIONS.md) for Web operational behavior and [MUTATION_RECOVERY.md](MUTATION_RECOVERY.md) for write-recovery boundaries.

For project contributions rather than running your own service, see [CONTRIBUTING.md](../CONTRIBUTING.md).
