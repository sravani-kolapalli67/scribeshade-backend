## TODO: Refactor ScribeShade /session/:id/ai-answer to single main-AI streaming path

- [ ] Add `buildDirectInferAndAnswerTask` to `src/shared/lib/prompt.ts`
- [ ] Add `buildCompactEvidencePacket` + cached/small runtime context helper to `src/features/session/session.service.ts`
- [ ] Refactor `getAIAnswer` to remove synchronous composer/question selection:
  - [ ] Stop calling `resolveAnswerSelection`
  - [ ] Stop calling `orchestrateAIContext`
  - [ ] Stop calling `decideAISessionState` / session decision precheck that blocks streaming
- [ ] Ensure main AI receives transcript evidence directly and outputs `===NO_NEW_QUESTION===` sentinel support
- [ ] Keep Composer background-only (no blocking waits in click path)
- [ ] Add/verify tests covering:
  - [ ] composer timeout does not affect click streaming
  - [ ] /ai-answer does not call `runComposerAI`
  - [ ] broken transcript candidate-only inference
  - [ ] clean current question streaming
  - [ ] multi-question transcript => multiple blocks
  - [ ] coding follow-up uses prior code memory
  - [ ] no fake fallback strings reach prompts
  - [ ] `===NO_NEW_QUESTION===` removes pending card (frontend assertion may be e2e)
- [ ] Run validation commands (backend + frontend)
