# Pull Request Template

## Description
Brief description of what this PR does.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update
- [ ] Refactoring / Code quality
- [ ] CI/CD / Deployment
- [ ] Dependency update

## Related Issues
Closes # (issue number)

## Testing
- [ ] Tested locally with `./scripts/test-local.sh`
- [ ] Tested extractors manually: `docker-compose exec extractors python -m extractors.main ...`
- [ ] Verified worker endpoints: `curl http://localhost:8787/manifest.json`
- [ ] All TypeScript types pass: `npm run typecheck` (in workers/addon)
- [ ] GitHub Actions workflows pass

## Checklist
- [ ] Code follows project style (run linters if applicable)
- [ ] Self-review completed
- [ ] Comments added for complex logic
- [ ] Documentation updated (README, code comments)
- [ ] No secrets or sensitive data committed
- [ ] Changes are minimal and focused

## Deployment Notes
Any special deployment steps? KV namespace changes? New secrets needed?

## Screenshots / Logs
If applicable, add screenshots or relevant logs.