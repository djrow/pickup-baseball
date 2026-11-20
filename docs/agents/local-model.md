# Local Model Rules (small context, slow tokens)

Setup: `ollama create qwen3-coder-32k -f docs/agents/Qwen3Coder.Modelfile`, then run `opencode` in the repo. Set `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` before `ollama serve`.

- Context is 32k: never read whole large files. Use `docs/AGENT_MAP.md` to find the symbol, then read only a line range.
- One small change at a time; finish and verify it before starting the next.
- Write the type contract and one failing test first (`docs/agents/frugality.md` §2).
- Verify with `npm run test:impact -- --run` or `VERIFY_SUITES=<name> npm run test:quiet`. Run `check:quiet` once at the end.
- Use `npm run i18n:sync` and `npm run asset:register -- --sync` instead of hand-editing locales or `sw.js`.
- Obey AGENTS.md invariants (CSP, ES6 only, parameterized SQL).
- Between waves, write a snapshot of 30 lines or fewer and start a fresh session.
