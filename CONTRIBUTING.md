# Contributing

This is an independently maintained local version based on tandpfun/wardrobe.
Please open issues and pull requests in dawn-yearn/wardrobe-local.

Install the locked dependencies with Node.js 22 (latest) or newer, then run:

```sh
npm ci
npm test
npm run build
```

Tests use mock providers and temporary local data. Do not make real paid AI calls
in ordinary tests or CI. The Windows launcher integration test is skipped on
other operating systems.

Keep changes focused, describe the resulting behavior, and include relevant
validation. Preserve the original MIT license and upstream attribution.

Never commit real environment files, credentials, personal photographs, wardrobe
records, generated assets, backups, or logs. Use synthetic test data and reserved
example.test addresses. Inspect the staged files before committing; ignore rules
do not remove files already in Git history.

Runtime cloud compatibility modules remain for existing tests. Normal startup
must stay local and must not reconnect to legacy cloud services.
