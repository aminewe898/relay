# Public release checklist

- [x] Public distribution secret scan clean after packaging
- [ ] Complete Git-history scan clean, including all original refs
- [x] Environment examples sanitized
- [x] Workflow exports structurally validated and imported; credential-bound execution remains manual
- [x] Screenshots deliberately omitted
- [x] Root tests/typecheck/build pass
- [x] Frontend tests/typecheck/build/smoke pass
- [x] Migrations fresh-install tested and source checksums match
- [x] Docker Compose clean install tested from an isolated clean copy
- [x] Workflow imports verified inactive in disposable n8n
- [x] Application backup/restore tested
- [x] n8n stopped-state/key restore tested with inactive workflows; real credential decryption remains untested
- [x] No production database dumps, audio or customer data in distribution
- [x] Requested documentation drafted
- [ ] License selected and LICENSE added
- [ ] Operator README/documentation review completed
- [x] npm audits clean; newer root tooling majors explicitly deferred
- [ ] Private vulnerability reporting enabled on target repository
- [ ] Operator manual voice-to-ticket acceptance test completed using their own test bot
- [ ] Explicit public-push authorization received

Do not infer completion from this template. Consult release-report.md for evidence and unresolved gates. No production-data purge, credential rotation, workflow activation, tag or public push is authorized by this checklist.
