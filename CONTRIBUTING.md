# Contributing to Futbol Cuevana Addon

Thank you for your interest in contributing! This document outlines the process for contributing to this project.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/futbol-cuevana-addon.git
   cd futbol-cuevana-addon
   ```
3. **Set up local development**:
   ```bash
   npm run setup    # Configures secrets and KV (requires gh + wrangler CLIs)
   npm run dev      # Starts local worker with mock KV
   ```

## Development Workflow

### Making Changes

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```

2. **Make your changes** following the guidelines below

3. **Test locally**:
   ```bash
   # Run full integration test suite
   ./scripts/test-local.sh

   # Or test specific components
   npm run typecheck          # TypeScript checks (in workers/addon)
   docker-compose exec extractors python -m extractors.main --help
   ```

4. **Commit** with conventional commits:
   ```bash
   git commit -m "feat: add new host extractor for example.com"
   ```

5. **Push and create PR**:
   ```bash
   git push origin feat/your-feature-name
   ```

## Code Guidelines

### TypeScript (Worker)
- **Location**: `workers/addon/src/`
- **Style**: Strict TypeScript, ES modules
- **Run checks**: `npm run typecheck` in `workers/addon/`
- **Formatting**: 2 spaces, LF line endings (enforced by `.editorconfig`)

### Python (Extractors)
- **Location**: `extractors/`
- **Style**: Type hints, async/await, structured logging
- **Dependencies**: Defined in `extractors/requirements.txt`
- **Testing**: Manual via `docker-compose exec extractors python -m extractors.main ...`

### GitHub Actions
- **Location**: `.github/workflows/`
- **Style**: Reusable, minimal permissions, clear job names
- **Secrets**: Never hardcode; use `${{ secrets.NAME }}`

### Docker
- **Multi-stage builds** preferred for production
- **Local dev**: `docker-compose.local.yml` with hot-reload volumes
- **Security**: Non-root user, minimal base images

## Adding New Sources

See [README.md#how-to-add-new-hostssources](README.md#how-to-add-new-hostssources) for detailed instructions.

### Quick Checklist for New Extractors
- [ ] Add extractor module in `extractors/`
- [ ] Register in `extractors/main.py`
- [ ] Add to `HOST_PRIORITY` (for cuevana hosts)
- [ ] Update catalog scraper if needed
- [ ] Add workflow job in `.github/workflows/daily-catalog.yml`
- [ ] Register catalog in `workers/addon/src/manifest.ts`
- [ ] Test locally with `./scripts/test-local.sh`
- [ ] Update README with new source info

## Commit Message Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no logic change |
| `refactor` | Code restructuring |
| `perf` | Performance improvement |
| `test` | Adding tests |
| `chore` | Maintenance, deps, build |
| `ci` | CI/CD changes |

Examples:
```
feat: add support for new futbol source tvf90-mirror.com
fix: handle missing token parameter in tvf90 extraction
docs: update deployment steps for Cloudflare KV
chore(deps): update yt-dlp to 2024.11.0
```

## Pull Request Process

1. **Fill out the PR template** completely
2. **Ensure CI passes** (GitHub Actions will run automatically)
3. **Request review** from maintainers
4. **Address feedback** with follow-up commits
5. **Squash and merge** when approved

### PR Requirements
- [ ] Clear description of changes
- [ ] Related issue linked (`Closes #123`)
- [ ] Local tests pass
- [ ] No breaking changes without discussion
- [ ] Documentation updated if user-facing changes

## Reporting Issues

Use the [issue templates](.github/ISSUE_TEMPLATE/) for:
- **Bug reports** - Include logs, steps to reproduce, environment
- **Feature requests** - Describe problem, proposed solution, alternatives

## Code of Conduct

This project follows a standard open-source code of conduct. Be respectful, inclusive, and constructive in all interactions.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).