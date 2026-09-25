# Changelog

## [2.19.1](https://github.com/mintopia/harmonic/compare/v2.19.0...v2.19.1) (2026-09-24)


### Bug Fixes

* autostash a dirty worktree at Attempt-start rebase instead of auto-committing leftovers ([587088c](https://github.com/mintopia/harmonic/commit/587088c0c343ea09c3dea6ff6c5ccfb27702f3a9))
* broadcast task_changed when a Task's skip reason changes ([17fcd4d](https://github.com/mintopia/harmonic/commit/17fcd4d428860e2761443488c62d7fac0a3f7af5))
* commit leftover worktree work only after verification passes, just before merge ([98a4406](https://github.com/mintopia/harmonic/commit/98a44067ee861a71da457f32257843c8059a9867))
* extend a working Task's wall-clock budget between turns ([f3bf169](https://github.com/mintopia/harmonic/commit/f3bf1692e3c4602b8268b2b791ecefa91e1e850e))
* report unresolved autostash conflicts as a conflict on the next rebase ([a3e6890](https://github.com/mintopia/harmonic/commit/a3e689040a69fae2be38e5254262c2df53631b18))

## [2.19.0](https://github.com/mintopia/harmonic/compare/v2.18.1...v2.19.0) (2026-09-23)


### Features

* **upgrade:** boot guard, DB snapshot/restore, and version pruning (ADR-0042) ([04b9a0e](https://github.com/mintopia/harmonic/commit/04b9a0edf727e66f2f2615871e2232f5819aa9a3))
* **upgrade:** init.d boot guard, wire rollback reasons, and guardMissing banner (ADR-0042) ([4f82c89](https://github.com/mintopia/harmonic/commit/4f82c8924e4446f14b10ad2ae1ae2cf59970b287))
* **upgrade:** resolve install modes and settle upgrades on boot (ADR-0042 W1/W6) ([9232f9d](https://github.com/mintopia/harmonic/commit/9232f9d4b66892045f9ce57a24de021886b7b914))
* **upgrade:** round-based initd relauncher with boot-guard integration (W5) ([bfd8b85](https://github.com/mintopia/harmonic/commit/bfd8b85fd232c08fefa0f1858e51f5c389347a44))
* **upgrade:** swap commit order — install, verify, commit, then flip (W3) ([6c93cba](https://github.com/mintopia/harmonic/commit/6c93cba1419a59accb8c9d43b8a1e48d9db38c05))


### Bug Fixes

* age-gate the merge-worktree sweep and prune dangling registrations ([e692531](https://github.com/mintopia/harmonic/commit/e692531cd9313ed444605aac21d9b44bb3d45e53))
* block startup on an incomplete live database, deflake real-convergence test ([197d606](https://github.com/mintopia/harmonic/commit/197d60623d9932830732bc05daf0dc1d637ce5d3))
* **boot:** sync the workspace watcher from a fresh list, not the pre-sweep snapshot ([d093a56](https://github.com/mintopia/harmonic/commit/d093a563bd41be7fef0bab41742a4f14ec165200))
* log why the merge-worktree sweep's git worktree remove failed ([2212a45](https://github.com/mintopia/harmonic/commit/2212a45680787314afa8f88ac1c2d2318c320d9e))
* merge-worktree sweep prunes registrations whose temp dir is already gone ([acb03fd](https://github.com/mintopia/harmonic/commit/acb03fd6848700c1136888ff8daa876dfbe27222))
* **service:** guard init.d start, --flag=value units, and rescue-layout installs ([bf53c3e](https://github.com/mintopia/harmonic/commit/bf53c3ee8a34efc1c68f43fdb3b99d80fc749ea1))
* **service:** reuse existing systemd unit settings on reinstall ([f8bcfd9](https://github.com/mintopia/harmonic/commit/f8bcfd916c1a528fb8ad10525d83b8d2f69f67da))
* **startup:** touch progress throughout boot, not just around phases ([62ac2fd](https://github.com/mintopia/harmonic/commit/62ac2fd196a6db4468012783df73b7d603fb68db))
* **startup:** watch boot with an out-of-process watcher, not a relauncher timeout ([98aeb1f](https://github.com/mintopia/harmonic/commit/98aeb1f4c949c0cfa307df252d6b8574c8276f93))
* sweep stale harmonic-merge-* worktrees at boot ([d55143f](https://github.com/mintopia/harmonic/commit/d55143f970b26722adb572bbb51cd7c7a13ae43c))
* **test:** harden conversation_changed ordering test against a leaked listener ([3774cd2](https://github.com/mintopia/harmonic/commit/3774cd262dc3eaacf17dabb5cee62f3ef208e2cc))
* unreadable unit reports guardMissing, surface blocked rollback on matching-version boot, and fix docs (review 3, finding 5) ([167c7b1](https://github.com/mintopia/harmonic/commit/167c7b1734623c0877168863aa86da3735e3ae02))
* **upgrade:** block rollback instead of flipping when the database can't be restored ([df44ae9](https://github.com/mintopia/harmonic/commit/df44ae90ccd05b6422161f6f578bbd541064beac))
* **upgrade:** boot guard clears the WAL before restoring, reports restore failures ([e4245d3](https://github.com/mintopia/harmonic/commit/e4245d3be3555308019f9f33e6397a1c08c6cc04))
* **upgrade:** fix relauncher entry guard and add data-dir logging ([49f31b6](https://github.com/mintopia/harmonic/commit/49f31b635983502ccfa4568f70dedabbe21348dc))
* **upgrade:** gate the tracker's scheduled epic reconcile on the upgrade coordinator ([ba20a24](https://github.com/mintopia/harmonic/commit/ba20a24d223a51a0274a88734eb3b46159ceee37))
* **upgrade:** give Cancel a step-boundary token and make waitForIdle timeouts abort before commit ([20b5e68](https://github.com/mintopia/harmonic/commit/20b5e684dc79d7a50de2bfc8cfd4a041ba6508ff))
* **upgrade:** honour cancel over idle-timeout, surface failed guard self-heal, sync installed tree ([40d422d](https://github.com/mintopia/harmonic/commit/40d422db3db7ba9bdf6f669c7fac018523b25390))
* **upgrade:** install systemd self-upgrades into app/versions layout ([630364c](https://github.com/mintopia/harmonic/commit/630364cf47f31927b56e198011bffed3e385333a))
* **upgrade:** key guardMissing off which systemd unit exists, not process uid ([4710086](https://github.com/mintopia/harmonic/commit/47100862dc9329067819999d519e44b7e264e7c7))
* **upgrade:** let installVersion replace an invalid install even under app/current ([b83cfad](https://github.com/mintopia/harmonic/commit/b83cfad5a5c7233b32596a6ebc25b6e53157461d))
* **upgrade:** make update-check's version write atomic against arm/cancel ([412dc00](https://github.com/mintopia/harmonic/commit/412dc00912b2acbb2ed81a27cfe79ad072430aaa))
* **upgrade:** markHealthy uses the running process's own version, not current ([bfd8b85](https://github.com/mintopia/harmonic/commit/bfd8b85fd232c08fefa0f1858e51f5c389347a44))
* **upgrade:** preserve rollback database on failure, fsync durable writes ([180359c](https://github.com/mintopia/harmonic/commit/180359cf334cb6e355116c99c53d6cbd590df480))
* **upgrade:** recover boot-guard db preservation from fsync failures ([6c7ed06](https://github.com/mintopia/harmonic/commit/6c7ed067e6827ac52e93ddad30117ea711b8246c))
* **upgrade:** report verify import errors without console ([01a6570](https://github.com/mintopia/harmonic/commit/01a6570aa5cfda6b1d84d91e85bc4c3ddfff1630))
* **upgrade:** rescue broken 2.18.0/2.18.1 systemd self-upgrades on install ([cfa1b43](https://github.com/mintopia/harmonic/commit/cfa1b4329e447ac009d96572aab4d048593a95ea))
* **upgrade:** self-heal partial move-aside, preserve DB on same filesystem, order fsyncs, cap rolled-back retention ([7377e8b](https://github.com/mintopia/harmonic/commit/7377e8b314fbb1270f3cd9359313fd63632ad999))
* **upgrade:** startup watchdog and relauncher round-timeout kill for hung boots ([#6](https://github.com/mintopia/harmonic/issues/6)) ([ac0ab34](https://github.com/mintopia/harmonic/commit/ac0ab348e0876ca8fdd9a3368a55a9768da308a0))
* **upgrade:** stop the coordinator lock deadlocking around the swap ([70142f0](https://github.com/mintopia/harmonic/commit/70142f0ac1408ac7c61de0f566bb4a4bc3c15833))
* **upgrade:** update check follows the host's npm registry ([339d56f](https://github.com/mintopia/harmonic/commit/339d56fa36907802ab4b365c7f7c7c3d2ecc38c7))
* **web:** don't offer a copy-command button for prose upgrade instructions ([4378838](https://github.com/mintopia/harmonic/commit/4378838c8e730b7a97091cd1211f0f1cc3e4394d))
* **web:** give CopyCommandButton the app's 44px touch-target floor ([6b3b1fc](https://github.com/mintopia/harmonic/commit/6b3b1fce63a1c4f8c91c4e21801677320d896a44))
* **ws:** never send a stale task_changed after a newer one or a removal ([d64d3c3](https://github.com/mintopia/harmonic/commit/d64d3c34bcd666fb70da214c1c8435e055d8572c))
* **ws:** newest attempt_changed/conversation_changed wins per connection ([5eb1604](https://github.com/mintopia/harmonic/commit/5eb1604644457191d7de88940497818a4fd78e9b))

## [2.18.1](https://github.com/mintopia/harmonic/compare/v2.18.0...v2.18.1) (2026-09-23)


### Bug Fixes

* **service:** strip dev manifest before installing a systemd version ([e84172a](https://github.com/mintopia/harmonic/commit/e84172a8592fd02cb8282d52c605afb97373a7b4))

## [2.18.0](https://github.com/mintopia/harmonic/compare/v2.17.0...v2.18.0) (2026-09-22)


### Features

* add epic detail timeline ([062785a](https://github.com/mintopia/harmonic/commit/062785a63627f310faa0afa854ac1b68be3ff600))
* **config:** add Claude Opus 5.5 to the Claude harness catalog ([ae1c286](https://github.com/mintopia/harmonic/commit/ae1c286e0696a7676f78d45ae7bda6ab4ef8f078))
* **config:** add GPT-6 Sol and GPT-6 Luna to the Codex harness catalog ([b0fb44e](https://github.com/mintopia/harmonic/commit/b0fb44e2640cfdcd094697f78c1900ae343bf20e))
* **epics:** complete all-direct epics in place without an integration branch ([31c4bfc](https://github.com/mintopia/harmonic/commit/31c4bfce96173fbc6e893a851ebd62c420d71336))
* **escalation:** step-aware Accept and fresh-Attempt Reject (ADR-0038) ([4299984](https://github.com/mintopia/harmonic/commit/4299984de9b2faaead77a8b95ac314fb7689f4b4))
* **git-visibility:** re-enable branch retirement visibly + task-level events for no-Attempt actions ([941e9dd](https://github.com/mintopia/harmonic/commit/941e9dde675f4a1d02c6374ce72e87388a1ef240))
* **git-visibility:** record every worktree/branch/commit side effect as a lifecycle row ([8d56129](https://github.com/mintopia/harmonic/commit/8d561299d932af84824052fd62b2514af6846332))
* **merge:** reconcile a moved base instead of asserting its SHA (ADR-0040) ([3069ecb](https://github.com/mintopia/harmonic/commit/3069ecb38a4fd17a2d20e115040aeffcd3c661b8))
* show integrating epic board bands ([18ac5c1](https://github.com/mintopia/harmonic/commit/18ac5c1edbc9c38e4ec64d28d1d3fba9558e4f4c))
* surface epic integration lifecycle events ([dc1692e](https://github.com/mintopia/harmonic/commit/dc1692edc5dab81268ad5c5e1e5ad6917c9f8f02))
* **web:** filter the graph by epic ([58b2bcc](https://github.com/mintopia/harmonic/commit/58b2bccdd30a8c2deb38f688aa1bb75882255edd))


### Bug Fixes

* avoid chown in user systemd installs ([f2194ca](https://github.com/mintopia/harmonic/commit/f2194cafeb623d386ab6c622ab668b88cdd9f86b))
* **build:** accept undefined taskEvents under exactOptionalPropertyTypes ([5b82c94](https://github.com/mintopia/harmonic/commit/5b82c94c3858745657f622a214069cfd720bc6a2))
* **config:** match OpenAI's current API prices and context windows ([d7dc202](https://github.com/mintopia/harmonic/commit/d7dc202fec664954a0d672b4f74a34cb85cbe3db))
* **epics:** in-place build stage sublabel says done, not merged ([18afd93](https://github.com/mintopia/harmonic/commit/18afd93562c5c60e12b7424eab7131eaa19a9e75))
* **epics:** in-place status keys off member modes, not branch existence ([0e830f5](https://github.com/mintopia/harmonic/commit/0e830f5c87f52fa81db1d9b08e68703b91bd8ae0))
* **epics:** recheck branch retirement when an Epic integration succeeds ([2960d76](https://github.com/mintopia/harmonic/commit/2960d76ea8cdda8185668b3cc3b2343e760f2437))
* **epics:** scope isInPlace to its own Workspace's tracker refs ([82534a6](https://github.com/mintopia/harmonic/commit/82534a678db972a215b1741387c63683b99f5624))
* **epics:** scope isInPlace's caller by workspace id, not task workingDir ([2b79b86](https://github.com/mintopia/harmonic/commit/2b79b861ab6f15774e40787dca1199bb6cbd3342))
* **git:** keep the leading status column when parsing porcelain output ([a2916e9](https://github.com/mintopia/harmonic/commit/a2916e945dba80b366678352897d528dc55eda1b))
* green the test failures the build error had masked ([8d46111](https://github.com/mintopia/harmonic/commit/8d46111d3932f438b276ee68f985410facb52457))
* install systemd code through current symlink ([c468387](https://github.com/mintopia/harmonic/commit/c468387c87ea627c1ecfc89b435d13b2dde277ae))
* install versioned service package root ([d017520](https://github.com/mintopia/harmonic/commit/d0175204533078bf9e17b3a077bb4b5a7e5ce484))
* isolate epic branch retirement ([3fdd835](https://github.com/mintopia/harmonic/commit/3fdd8357e20ca7c57ca1520209aa168c4514a7eb))
* isolate merge policy worktrees ([b92f670](https://github.com/mintopia/harmonic/commit/b92f6702b29a21d45d966974a946e4646ca4aec0))
* isolate merge policy worktrees ([13eb9c3](https://github.com/mintopia/harmonic/commit/13eb9c32ebd11906fd770d1ffc5daf0c0ef7a40c))
* **merge:** escalate instead of spinning on a non-race ref-write failure ([b211b4f](https://github.com/mintopia/harmonic/commit/b211b4f193afe5ed006bf86027e7195227c6ad60))
* **merge:** fall back to keeping a path when its checkout sync fails ([9ffab2d](https://github.com/mintopia/harmonic/commit/9ffab2dbe39cbeadf6221c217c77026c1944f586))
* **merge:** sync a dirty base checkout without clobbering or blocking ([905ab56](https://github.com/mintopia/harmonic/commit/905ab564a2ebea9e2122b3811a4030fa4c3b4ac4))
* omit undefined detail in isolated merge conflict result ([a9a025b](https://github.com/mintopia/harmonic/commit/a9a025b2330856c1a53bb7582489ba3e9d26a2ed))
* preserve systemd current path detection ([0c2eee4](https://github.com/mintopia/harmonic/commit/0c2eee43a03abf6f82f0cce9fc205899bccafd3e))
* report upgrade progress from server state ([d21a5c0](https://github.com/mintopia/harmonic/commit/d21a5c08f56d16c2ff55fc06932302d2df9fa5f4))

## [2.17.0](https://github.com/mintopia/harmonic/compare/v2.16.0...v2.17.0) (2026-09-21)


### Features

* **about:** reveal a scrolling musical stave on hover ([f6c09c2](https://github.com/mintopia/harmonic/commit/f6c09c28765222ad7a80e232cb7c714a8bba80d0))
* **about:** swap easter-egg melodies to Dies Irae and Toccata ([806f383](https://github.com/mintopia/harmonic/commit/806f383be93298d93e6a93f7a937e0d8454c2a4e))


### Bug Fixes

* **execution:** keep a failed attempt's implementation step failed ([fbdb704](https://github.com/mintopia/harmonic/commit/fbdb70415ad070dc89687c80222152c4e995056b))
* **execution:** snapshot a reused worktree before rebasing ([861dc0d](https://github.com/mintopia/harmonic/commit/861dc0dd669a8c7b1e8b25102aad91e989b517ea))
* **web:** show an attempt's pinned model, not the token-dominant one ([eedacea](https://github.com/mintopia/harmonic/commit/eedacea1552783c3688bc43788f089f7a5bb6d10))

## [2.16.0](https://github.com/mintopia/harmonic/compare/v2.15.0...v2.16.0) (2026-09-20)


### Features

* **about:** float muted note motes behind the treble clef ([c6913c8](https://github.com/mintopia/harmonic/commit/c6913c846ee3f8600c6a82441f3e91b7e6d9bc2b)), closes [#680](https://github.com/mintopia/harmonic/issues/680)


### Bug Fixes

* **jev-gate:** accept a pre-joined --mode value in parseArgs ([4dbf186](https://github.com/mintopia/harmonic/commit/4dbf1861c153a1035840d77ce64b49b82992cb80))

## [2.15.0](https://github.com/mintopia/harmonic/compare/v2.14.0...v2.15.0) (2026-09-20)


### Features

* add ai_slop as a 9th Jev rubric category ([cbc8421](https://github.com/mintopia/harmonic/commit/cbc8421c2467bb1184b07b996932f046c0dccb04))
* add Jev quality gate script for the verify stage ([98337bb](https://github.com/mintopia/harmonic/commit/98337bbd92e7a453875cc2986b7a746c00c3d3dc))
* fail/warn/pass zone bands behind Jev report graphs ([dc45ad7](https://github.com/mintopia/harmonic/commit/dc45ad7c50a82986b17a4b8b83c17ebce3e57cc0))
* **jev-gate:** drop duplication, decouple confidence from scoring, redesign report ([290a505](https://github.com/mintopia/harmonic/commit/290a5054d7e0800cdd2c68ff9a054c2de557ed93))
* **jev-gate:** rewrite rubrics as single-dimension in-file questions ([ad6576a](https://github.com/mintopia/harmonic/commit/ad6576a0c64be37a58d314507df5e544128ce9c7))
* **jev-gate:** sharpen rubrics to what a single file can answer ([bcfb6f6](https://github.com/mintopia/harmonic/commit/bcfb6f698b941e84f3eab01505cb5e40e869c97c))
* **jev-gate:** split categories into sub-questions with min/mean aggregation ([7491fe2](https://github.com/mintopia/harmonic/commit/7491fe2fb20e1bd2c1d5decffe411d3f38f3ea65))
* **jev-gate:** write the HTML report by default ([71bef5b](https://github.com/mintopia/harmonic/commit/71bef5beb2608a03515e2249753b21747c203cde))
* per-metric change graphs — colour the change, grey the project ([46f3282](https://github.com/mintopia/harmonic/commit/46f3282421b78884ceaeb473bad96c0bfdb91d09))
* render Jev report scatter charts with Chart.js (CDN) ([6311aa8](https://github.com/mintopia/harmonic/commit/6311aa835d03399453ecd3b96e536272c2e28ab3))
* replace confidence weighting with an Unsure zone ([babf533](https://github.com/mintopia/harmonic/commit/babf533dc3a3a1dcdb4a602d3160b5530c393a1b))
* shared async-resource hook, migrate swallowed-fetch sites ([#654](https://github.com/mintopia/harmonic/issues/654)) ([50b0c11](https://github.com/mintopia/harmonic/commit/50b0c112e0d2caf4bb01cbde681a4f4a25c1c740))
* verifier overlays, configurable critic timeout, and Jev gate upgrades ([fd8b017](https://github.com/mintopia/harmonic/commit/fd8b0170a85f4d7fd6e53bdc9635dd6d8c6643ba))


### Bug Fixes

* bound event-loop and memory use in execution I/O ([3a0237d](https://github.com/mintopia/harmonic/commit/3a0237d66728ab97296ba8d3dea9238ea27d6e92)), closes [#652](https://github.com/mintopia/harmonic/issues/652)
* deny WebSocket write access by default, drop token-in-query-string ([3023e33](https://github.com/mintopia/harmonic/commit/3023e3351d1640b94a19651f85c1d35a621f7dc5)), closes [#648](https://github.com/mintopia/harmonic/issues/648)
* drop narration comment and correct a false doc claim ([#677](https://github.com/mintopia/harmonic/issues/677)) ([27ea2e3](https://github.com/mintopia/harmonic/commit/27ea2e3176cb020a97a62388aa9bf6da0350947d))
* drop narration comments flagged by comment-check on [#665](https://github.com/mintopia/harmonic/issues/665) refactor ([ccca1fa](https://github.com/mintopia/harmonic/commit/ccca1fad8cbc1ae955d93788936eff47f9c99304))
* eliminate silent catch blocks with a shared log-then-flag helper ([9e526ea](https://github.com/mintopia/harmonic/commit/9e526eabadc96671942758eed70c598c8d00120a)), closes [#655](https://github.com/mintopia/harmonic/issues/655)
* gate schema-sync clean-break on a real constraint violation, not any error ([1e6060d](https://github.com/mintopia/harmonic/commit/1e6060d6cce28d3dccdac4e1e13a35d3fa42df90)), closes [#650](https://github.com/mintopia/harmonic/issues/650)
* harden untrusted values reaching the filesystem and subprocesses ([7176f14](https://github.com/mintopia/harmonic/commit/7176f1434dd586cbe450804bc38d65262fa04e8f)), closes [#649](https://github.com/mintopia/harmonic/issues/649)
* human-readable settings save errors in the save bar ([adaedda](https://github.com/mintopia/harmonic/commit/adaedda21ce0c4da340bcfaea4b3c42cf4c6b430))
* Jev report uses full browser width, graphs cap at 4 per row ([2fcf381](https://github.com/mintopia/harmonic/commit/2fcf381f6fefce3f81f7aa6b0d2866583febf408))
* **jev-gate:** remediate failing baseline files and teach testability rubric production roles ([3975dc0](https://github.com/mintopia/harmonic/commit/3975dc0f52abeaf39ad49295584cfb09e6508b14))
* **jev-gate:** work the baseline warnings — logging, retry backoff, targeted refactors ([48f3543](https://github.com/mintopia/harmonic/commit/48f35431d8267dfe6b37554efbcc09531a1440ef))
* keep stats worker alive on malformed input, cap heavy-read probe ([5ba5fb1](https://github.com/mintopia/harmonic/commit/5ba5fb1b610d460b1a4b0032d921b3586bdd7dbb)), closes [#651](https://github.com/mintopia/harmonic/issues/651)
* **openapi:** make the snapshot deterministic by pinning UUID-valued defaults ([f59f365](https://github.com/mintopia/harmonic/commit/f59f36533df23db765676052134e903f1cc08cb4))
* roll back optimistic steering turns and surface fetch failures correctly ([a29c1af](https://github.com/mintopia/harmonic/commit/a29c1afbaf3270cab4479aa243091ec49bf416c5))
* stop dropping spaces in verification command args ([#677](https://github.com/mintopia/harmonic/issues/677)) ([2f8214c](https://github.com/mintopia/harmonic/commit/2f8214c341599c7c419b9ee6706063bf975f50f2))
* surface oversized files in Jev gate instead of dropping them ([#675](https://github.com/mintopia/harmonic/issues/675)) ([4be003f](https://github.com/mintopia/harmonic/commit/4be003fd5bfad25bdbb0923cf44d5d8549b2dd5f))
* surface oversized files in Jev gate instead of dropping them ([#675](https://github.com/mintopia/harmonic/issues/675)) ([7155f0f](https://github.com/mintopia/harmonic/commit/7155f0f0f3e7db422c563434d0665857caa65be5))
* tidy critic runtime-field layout (harness/model/timeout in one row) ([29e7a39](https://github.com/mintopia/harmonic/commit/29e7a39fc46ce990de70668e360d56981c93f3b5))
* type-check story API stub against the real API surface ([6357500](https://github.com/mintopia/harmonic/commit/635750025cf0e6d0200fc4e5edeff8d75e408d6d)), closes [#666](https://github.com/mintopia/harmonic/issues/666)
* update docs site logo and favicon to treble clef ([4977d05](https://github.com/mintopia/harmonic/commit/4977d0562b0ae837668d7f17d19ca710360f1517))
* update workspace verification intro copy for additive overlays (ADR-0037) ([c301b40](https://github.com/mintopia/harmonic/commit/c301b4002433dca9b86ecf3ef0577c27738ea8ce))
* zone bands follow the weighted (confidence×score) zones, not raw score ([5774f3f](https://github.com/mintopia/harmonic/commit/5774f3f6a7185e20e425f2cd552795330e0b6ef7))

## [2.14.0](https://github.com/mintopia/harmonic/compare/v2.13.0...v2.14.0) (2026-09-17)


### Features

* treble-clef logo and redesigned About dialog ([1b3b5b4](https://github.com/mintopia/harmonic/commit/1b3b5b446943125502e25fc01fde31919d7a155e))


### Bug Fixes

* correct conversation start, systemd PATH, and global running count ([d231b0d](https://github.com/mintopia/harmonic/commit/d231b0d3ae25128d5cb5e022bdc80f42d9aad155))
* operator Accept merges the candidate as-is without re-verifying ([a798997](https://github.com/mintopia/harmonic/commit/a798997d1ca4019c86fefc5d764d537087428b7a))

## [2.13.0](https://github.com/mintopia/harmonic/compare/v2.12.2...v2.13.0) (2026-09-17)


### Features

* add About overlay behind the top bar's ? icon ([a83b685](https://github.com/mintopia/harmonic/commit/a83b6851106686feec67f6163b592bcbd439e58d))


### Bug Fixes

* always offer the About overlay's upgrade regardless of banner dismissal ([bc6a92d](https://github.com/mintopia/harmonic/commit/bc6a92d9fd8c0933f10218ff35e6d50fe148b423))
* keep the global dashboard reachable with a single workspace ([832a71b](https://github.com/mintopia/harmonic/commit/832a71b0b3b3dfe9efd83f6b3eb2bdcebf030a31)), closes [#635](https://github.com/mintopia/harmonic/issues/635)
* opencode contextTokens ignores in-flight zero-token message ([da833be](https://github.com/mintopia/harmonic/commit/da833be35d7148c06b46f4476274f5400258b94a))
* put the ticket ref on the Drive Prompt's skill invocation line ([a5cf9c5](https://github.com/mintopia/harmonic/commit/a5cf9c595974951a8146ca705140d44fd067bc0e))
* restore global settings icon to the top bar ([f90b888](https://github.com/mintopia/harmonic/commit/f90b888ed2384047464437696af0b208f382f79c)), closes [#636](https://github.com/mintopia/harmonic/issues/636)

## [2.12.2](https://github.com/mintopia/harmonic/compare/v2.12.1...v2.12.2) (2026-09-16)


### Bug Fixes

* create and chown the service data directory before install ([a4fc106](https://github.com/mintopia/harmonic/commit/a4fc1062814d1d9627b4fad0257cdcd1d9085c99))
* default the homepage to the sole workspace, link dashboard workspaces ([fa9f96e](https://github.com/mintopia/harmonic/commit/fa9f96eaac53404d1b98b20e02247cade6b070c6))

## [2.12.1](https://github.com/mintopia/harmonic/compare/v2.12.0...v2.12.1) (2026-09-16)


### Bug Fixes

* don't watch the filesystem root on a fresh service install ([50538a5](https://github.com/mintopia/harmonic/commit/50538a52c3f976dd239006938e7322ff84d709eb))
* seed no Workspace on a fresh install, anchor the service cwd ([d68b8cf](https://github.com/mintopia/harmonic/commit/d68b8cf7f5f5eb12a88b1bc2de0845bf96615bad))

## [2.12.0](https://github.com/mintopia/harmonic/compare/v2.11.0...v2.12.0) (2026-09-16)


### Features

* add conversation command picker ([fb7ac2b](https://github.com/mintopia/harmonic/commit/fb7ac2b605d41851d4564224a29cb1aa8e37dde0))
* add per-harness permission mode settings ([7fd48fc](https://github.com/mintopia/harmonic/commit/7fd48fcde2dfd77ec9f08444dfa44832f3b942a0))
* audit unattended permission mode selection ([326b090](https://github.com/mintopia/harmonic/commit/326b090b6b302215751a52c402fe9c99b4134d7a))
* configure harness permission modes ([264a6a4](https://github.com/mintopia/harmonic/commit/264a6a4c4c5cc564e0764a9ea385f76f73363b44))
* expose advertised conversation commands ([72512d9](https://github.com/mintopia/harmonic/commit/72512d9c559354e66cb60dcb86cc711d4d4e1362))
* fold requeue into reject ([e59300c](https://github.com/mintopia/harmonic/commit/e59300c6c55252e77fbd44f42a36d8ce257ec5d9))
* rework workspace colour control, nav groups, and docs link ([97dfe3f](https://github.com/mintopia/harmonic/commit/97dfe3f77f0212bfaffb6cf2be6488c4b393caa7))
* warm conversation session when composer opens ([f719e20](https://github.com/mintopia/harmonic/commit/f719e203d56fc212cdab4681a13897471b32398a))


### Bug Fixes

* correct commandPrefix REST exposure, Copilot mode order, resume query ([2d7512c](https://github.com/mintopia/harmonic/commit/2d7512ca3ad8acb1f8398544f69a2528c17e6d4d))
* distinguish permission mode fallback in timeline ([656a48e](https://github.com/mintopia/harmonic/commit/656a48e98ed191cf392d17d1af7ab51e0aa506ec))
* honor install user for systemd ([a3df9ed](https://github.com/mintopia/harmonic/commit/a3df9ed79ddb36f65dd84304b58d9338442e107b))
* map Copilot ACP permission modes ([90596b9](https://github.com/mintopia/harmonic/commit/90596b97ea7ac120a96f048f51423e369f45f1d6))
* record default permission mode fallback ([ee4892b](https://github.com/mintopia/harmonic/commit/ee4892b4acaeae963cdf96bc40f5dd4ca7c2864c))
* scope activity task attempts by workspace ([696ca78](https://github.com/mintopia/harmonic/commit/696ca7834d0d5e24c6c8cef5ed43bd44d718d2e7))
* share pending conversation creation ([2e07c2f](https://github.com/mintopia/harmonic/commit/2e07c2f9f72579dcb760d32afe2dbcf3c8293a3e))

## [2.11.0](https://github.com/mintopia/harmonic/compare/v2.10.0...v2.11.0) (2026-09-15)


### Features

* add global dashboard ([c9c2b8b](https://github.com/mintopia/harmonic/commit/c9c2b8ba19af07771f89cbbcaec87c7cdc87ea63))
* add global stats workspace breakdown ([3f07daa](https://github.com/mintopia/harmonic/commit/3f07daa255724b28acbd030a67c1048eb883e952))
* add global tickets table ([d39bc1f](https://github.com/mintopia/harmonic/commit/d39bc1f55f3279e0c17fc060eafb3ed0a993e6d7))
* add global timeline view ([576ab30](https://github.com/mintopia/harmonic/commit/576ab30f9bf32f7539435ed83babcfd46f30af4e))
* add init.d service backend ([52e7772](https://github.com/mintopia/harmonic/commit/52e7772421d99fb402337ca5b25a583ce52dc596))
* add no-guidance Requeue and fix escalated-task accept UX ([4be9d22](https://github.com/mintopia/harmonic/commit/4be9d2221f6ed2e35385ecfd62ce5123c8a729e4))
* add scope path routing foundation ([831cc21](https://github.com/mintopia/harmonic/commit/831cc214ee0f1fd266c3c8e8b52c949ae3e6b9e2))
* add service manager CLI seam ([356ad04](https://github.com/mintopia/harmonic/commit/356ad04231838a47270ea4759f92c19585761646))
* add service manager CLI seam ([3a9166c](https://github.com/mintopia/harmonic/commit/3a9166c9483521bf82735e83a308d600757ae60c))
* add systemd service backend ([f478779](https://github.com/mintopia/harmonic/commit/f478779cecfb4d01dc1199a482686821b82f5e6b))
* add workspace colors and switcher badges ([0f02f0c](https://github.com/mintopia/harmonic/commit/0f02f0ca02db65e6448815e3b4258af63a953a37))
* extend the wall-clock guardrail of a running task ([9144d85](https://github.com/mintopia/harmonic/commit/9144d85ad1dfa9a6d201e18151389834f015d932))
* hand upgrades to systemd ([c66b76a](https://github.com/mintopia/harmonic/commit/c66b76abf9ce3d3e45f30888a2575657d03d3297))
* reset wall-clock guardrail on resume and allow steering a paused task ([11a9e0e](https://github.com/mintopia/harmonic/commit/11a9e0e71757e053680488073afd1c89ddb21702))
* scope activity and operations by workspace ([b7a9aa2](https://github.com/mintopia/harmonic/commit/b7a9aa2ca046cc575561a730f89b7be0c291cd0b))


### Bug Fixes

* add workspace HSL color picker ([d04fab5](https://github.com/mintopia/harmonic/commit/d04fab5d9078958c328053f32bc733831e471e05))
* await chokidar ready so the workspace watcher is live before sync returns ([10db38c](https://github.com/mintopia/harmonic/commit/10db38ca16fbc034265fab5d037e870c6ed34093))
* converge workspace color schema ([8f28cd6](https://github.com/mintopia/harmonic/commit/8f28cd6408935a8958aede7f37b3efd849e2e0a7))
* log discarded git-status and workspace-diff failures ([665b240](https://github.com/mintopia/harmonic/commit/665b2407dae5898afaee7ab28c66838bc7091c50))
* nudge dark status color collisions ([af614e3](https://github.com/mintopia/harmonic/commit/af614e383820458500bbf20942fd24ce8923fa8f))
* regenerate workspace color OpenAPI schema ([af4382e](https://github.com/mintopia/harmonic/commit/af4382e00b995170502d247408d6626b42239c32))
* serialize logged git error to a string attribute ([6263423](https://github.com/mintopia/harmonic/commit/6263423d9bf208a2293dd417cd149b4c0fa4365b))
* show onboarding empty state when a fresh instance has no workspaces ([3e2eb79](https://github.com/mintopia/harmonic/commit/3e2eb798174d7e2c0f812a04d68293349925bb4d))
* show workspace color accessibility feedback ([c6caaa2](https://github.com/mintopia/harmonic/commit/c6caaa2cd2f77b8a14dc9e6a76bfc12d80867f31))
* stabilize firehose tests against races from earlier same-type messages ([7c9aded](https://github.com/mintopia/harmonic/commit/7c9adedf9650aee99fc61e7cac50c508499a1243))
* stop UI overflow on Files and guardrail dialog at narrow widths ([da9bf09](https://github.com/mintopia/harmonic/commit/da9bf096d9909ff6360ff4a4f3f94e697d7184e4))

## [2.10.0](https://github.com/mintopia/harmonic/compare/v2.9.2...v2.10.0) (2026-09-14)


### Features

* add source control panel actions ([5787faa](https://github.com/mintopia/harmonic/commit/5787faaf51e3ed15bd7597d1f5a25b97bc712303))
* add workspace files browser ([2a91cc1](https://github.com/mintopia/harmonic/commit/2a91cc189890954a11028d92089e121932fb3549))
* colour workspace files by git status ([ace3e38](https://github.com/mintopia/harmonic/commit/ace3e38c96d28cbf4395b52fb92db8153e46678d))
* exclude workspace directories from file tree ([bee4e9c](https://github.com/mintopia/harmonic/commit/bee4e9c8ed7ee8a544aa8c196a468f7cb2e3cf87))
* make workspace files editable ([9b4c360](https://github.com/mintopia/harmonic/commit/9b4c360da8915d29625b7cdbd4e4e6f057e7d71b))
* preview workspace media files ([987c3f3](https://github.com/mintopia/harmonic/commit/987c3f38171479b2a7e60264b184ce3e6b80dba1))
* rework the Files view into a keyboard-navigable in-app IDE ([a1b5a40](https://github.com/mintopia/harmonic/commit/a1b5a40258ad1c6113df2f43a30b88ffdc20a0a1))
* watch workspace files live ([da92f25](https://github.com/mintopia/harmonic/commit/da92f25c346b59d9d16cd91ee5000b2689dc895e))


### Bug Fixes

* allow mobile pages to scroll ([ca99c7a](https://github.com/mintopia/harmonic/commit/ca99c7ac114b42bb053a2f94fe1448de066fcce7))
* harden workspace file writes ([e5150ea](https://github.com/mintopia/harmonic/commit/e5150ea8f1fd8799819048bbdd7fab5d63b7a3f5))

## [2.9.2](https://github.com/mintopia/harmonic/compare/v2.9.1...v2.9.2) (2026-09-14)


### Bug Fixes

* **timeline:** anchor zoom on the readout so live runs stay in view ([aa38fd2](https://github.com/mintopia/harmonic/commit/aa38fd27479587973dfde9e078507e7e93efa4ec))
* **timeline:** anchor zoom on the readout so live runs stay in view ([bac037a](https://github.com/mintopia/harmonic/commit/bac037a457473d4fa6d4c9ec1a1cd3427dcd096f))

## [2.9.1](https://github.com/mintopia/harmonic/compare/v2.9.0...v2.9.1) (2026-09-13)


### Bug Fixes

* **timeline:** keep the scrub surface alive when a window is empty ([ce193f0](https://github.com/mintopia/harmonic/commit/ce193f01e077a62c0aa33253278564bf26ab263c))

## [2.9.0](https://github.com/mintopia/harmonic/compare/v2.8.0...v2.9.0) (2026-09-13)


### Features

* **skills:** add /pre-release prep checklist ([d87f68f](https://github.com/mintopia/harmonic/commit/d87f68f34fb7abb684e81874e92785b923b5e1ea))
* **timeline:** zoom + pan the fleet timeline instead of fixed ranges ([887d0a8](https://github.com/mintopia/harmonic/commit/887d0a8a36b7f8607bb572de0eb973683ace11a9))
* **upgrade:** settle an armed upgrade after relaunch onto the new version ([028ccbd](https://github.com/mintopia/harmonic/commit/028ccbde5b67536c42c55a9e0aeba3d2dd2957f8))
* **web:** make the operator console usable on mobile ([be623ec](https://github.com/mintopia/harmonic/commit/be623ec139377fd75c37225f737a13a03e6c9d98))


### Bug Fixes

* **board:** decay session warmth from lastActiveAt, not now ([2a82132](https://github.com/mintopia/harmonic/commit/2a8213204ae96931ff1357b6c298f6dc9cbd4a8a))
* **conversations:** reach the resumable-ended composer, plus pre-release polish ([0ca193a](https://github.com/mintopia/harmonic/commit/0ca193a1ca227975002d301c0ef23d8a45024fb9))
* **conversations:** resume an ended conversation from its stored session ([1b28c5f](https://github.com/mintopia/harmonic/commit/1b28c5f101ff7566428ee9a53543dd661cb22fc9))
* **conversations:** show selected harness in prompt ([3b6ea81](https://github.com/mintopia/harmonic/commit/3b6ea81158ecb4519e21b17979103ead79753446))
* retain pending permission prompts for late subscribers ([cc9c13c](https://github.com/mintopia/harmonic/commit/cc9c13c966bbdf338764c4279204986cfc8c3377))
* **test:** restore COMPOSER source read dropped in epic/571 merge ([4a6eb24](https://github.com/mintopia/harmonic/commit/4a6eb248516b9945ecf41079a32f1e7b1a15f30b))
* **ui:** improve mobile conversations ([7b33b01](https://github.com/mintopia/harmonic/commit/7b33b010b3f082c33a8bfb7c063a85bf9093e319))

## [2.8.0](https://github.com/mintopia/harmonic/compare/v2.7.0...v2.8.0) (2026-09-12)


### Features

* **conversations:** match the Conversation Experience mockups ([13c45b2](https://github.com/mintopia/harmonic/commit/13c45b2c7d1cf6e98c7ff9ab754ffa212090678a))
* **settings:** ordered, named, drag-reorderable verifier lists ([046aa84](https://github.com/mintopia/harmonic/commit/046aa845aa569ed9dc341f707534a44c83e458ee))
* **ui:** add fleet Timeline, unify page headers, reorder rail ([849e232](https://github.com/mintopia/harmonic/commit/849e232ec7c8c46ce646ff95d99a58c89a440d29))
* **ui:** drop breadcrumb bar, slim conversation header ([5400733](https://github.com/mintopia/harmonic/commit/54007334beb8ab50aabf66dcaef573cfd774204e))
* **ui:** split ready hue to azure, add subtle depth, refine board cards ([437fe27](https://github.com/mintopia/harmonic/commit/437fe27bddd118ba6be3b876e1db3a2fa0824501))


### Bug Fixes

* **conversations:** tidy the new-conversation compose form ([2df5eba](https://github.com/mintopia/harmonic/commit/2df5eba3c40d8fcad5869d41339e8fbec7f42560))
* **settings:** address review of the verifier-list editors ([c24693d](https://github.com/mintopia/harmonic/commit/c24693dd5115f6273d147c3f10ae6c4761618a0e))
* **ui:** repair mobile layouts, guard verifier removal, fix stale critic test ([40c5534](https://github.com/mintopia/harmonic/commit/40c55341df383e0d0b24a3ae96f2a4979b4d5baa))

## [2.7.0](https://github.com/mintopia/harmonic/compare/v2.6.0...v2.7.0) (2026-09-11)


### Features

* add automatic conversation permissions ([2afdd4c](https://github.com/mintopia/harmonic/commit/2afdd4c810eb1cb0b007f938e31742007f759208))
* add conversations workspace view ([7d2e258](https://github.com/mintopia/harmonic/commit/7d2e258e385a8561fa7f76fb4c55d519777f39cd))
* add rich transcript tool cards ([413ff89](https://github.com/mintopia/harmonic/commit/413ff890c7ce9d75350c068eb68db8fdb965bd14))
* add scheduled npm update checks ([0116719](https://github.com/mintopia/harmonic/commit/011671901e0e79e9fe2085079dfbca6d376c871d))
* add update banner ([a6e1131](https://github.com/mintopia/harmonic/commit/a6e1131dda0dbf323d32b8f6310405011f4efe65))
* **config:** add Fable 5.1, GPT Astra, Muse Spark, DeepSeek V4.1 Flash ([3a7fcaf](https://github.com/mintopia/harmonic/commit/3a7fcaffa3064f1706d1864c1621a7439279231c))
* detect distribution mode at boot ([fdbc6f4](https://github.com/mintopia/harmonic/commit/fdbc6f428079b7ad8c5f2bab5ea4c0f095f81eec))
* perform armed in-place upgrade swap ([8388f5f](https://github.com/mintopia/harmonic/commit/8388f5f554f54207317c8dc5dca2b1df4c7fd0d4))
* render ACP edit diffs in transcripts ([ad8e400](https://github.com/mintopia/harmonic/commit/ad8e4003143e083d90253382ee72724b970f4c89))
* **resume:** move the continue-vs-fresh choice into a resume dialog ([957cd41](https://github.com/mintopia/harmonic/commit/957cd41b6ccb24f865829cc533bf1284bdd2f6df))
* **upgrade:** arm and quiesce updates ([ef6e57c](https://github.com/mintopia/harmonic/commit/ef6e57cbad4d5c851d0b8654d6d12eb16c6f9f11))
* **web:** add conversation context drawer ([d581e66](https://github.com/mintopia/harmonic/commit/d581e661fafb767a68ebad470e83d1b384ab5795))
* **web:** add favicon using the Harmonic mark ([0c6282c](https://github.com/mintopia/harmonic/commit/0c6282cd323f2f7b8eee5e70f6d2787548b7b62c))
* **web:** highlight markdown and diffs ([36ff40e](https://github.com/mintopia/harmonic/commit/36ff40e3979c6716870e21b3692e9af1ddcb8a63))


### Bug Fixes

* cold-resume conversations after restart ([3fc2509](https://github.com/mintopia/harmonic/commit/3fc25098463fcfd800ea669c1ccb98b8949403ee))
* **conversation:** use responder names in copy ([2bd6242](https://github.com/mintopia/harmonic/commit/2bd6242b5c1583954bd36d88b4129042c408684c))
* make conversation transcripts follow smartly ([660f34d](https://github.com/mintopia/harmonic/commit/660f34d509867aad5b3de3d8890c2042b38c02a8))
* **resume:** key the preview fetch on the task, not the loader identity ([f7d44a0](https://github.com/mintopia/harmonic/commit/f7d44a08afbaba6b0d4561675badd66b89d699e0))
* retain closed unintegrated epics on board ([0f18f28](https://github.com/mintopia/harmonic/commit/0f18f285cfee7c596c3b7f5c6880bd028bb89cef))
* scope conversation deep links to workspace ([25a1fc3](https://github.com/mintopia/harmonic/commit/25a1fc35298957ca5ee222abee1e3ef1c48c65d3))
* **tracker:** demote structural epic mirrors ([f2acfd1](https://github.com/mintopia/harmonic/commit/f2acfd1ef81a955b2d69c06629d4491b86a83747))
* **upgrade:** keep Update Check tests independent of the release version ([3c52a84](https://github.com/mintopia/harmonic/commit/3c52a84866adc677c0bd76fb154c1cb3835ab131))
* **upgrade:** satisfy build and OpenAPI checks ([25a3888](https://github.com/mintopia/harmonic/commit/25a38880cfcb1b91e0e9c0eabcac2ca01fae8e07))
* widen verification settings ([d50dcf5](https://github.com/mintopia/harmonic/commit/d50dcf546d4dd31931846636aa51807977f1204c))

## [2.6.0](https://github.com/mintopia/harmonic/compare/v2.5.0...v2.6.0) (2026-09-10)


### Features

* **conversation:** expose usage and command details ([f130ec0](https://github.com/mintopia/harmonic/commit/f130ec02c043c9d4856944d6094ac30b2067b4e4))


### Bug Fixes

* expose epic verification output ([f5653a1](https://github.com/mintopia/harmonic/commit/f5653a1af8e5f8bb400396bf6d7c9766ce153f3e))
* rebuild schema tables with definition drift ([3520ec0](https://github.com/mintopia/harmonic/commit/3520ec01ec212c505b3995016c1ae2da4a82e1a4))
* stream verification and steering updates ([49e8d53](https://github.com/mintopia/harmonic/commit/49e8d538fbcc3296d13d02fc226e9557d5943311))

## [2.5.0](https://github.com/mintopia/harmonic/compare/v2.4.0...v2.5.0) (2026-09-10)


### Features

* **settings:** restructure verification settings and unify prompt-editor placeholders ([5d3d258](https://github.com/mintopia/harmonic/commit/5d3d258f1a4a831e6c212d6386b17069c63449c8))


### Bug Fixes

* **test:** rename {body} to {description} in epic-resolve fixture and Drive doc ([b978e56](https://github.com/mintopia/harmonic/commit/b978e5608f1c8d6ed20f43fbc9f94362473c159d))

## [2.4.0](https://github.com/mintopia/harmonic/compare/v2.3.0...v2.4.0) (2026-09-09)


### Features

* add task critic prompt variants ([6f53546](https://github.com/mintopia/harmonic/commit/6f535466ef3e36063cb663b7b0a18c94202ecd5d))
* **epics:** add attempt ownership ([3c17d98](https://github.com/mintopia/harmonic/commit/3c17d985e35dbfe5b09738bedb1b4484f976a95b))
* **epics:** run and display epic attempts ([5a893f7](https://github.com/mintopia/harmonic/commit/5a893f7734aff69b4241d5b780520fac857481af))
* **epics:** verify and resolve in the epic worktree ([eb91bc8](https://github.com/mintopia/harmonic/commit/eb91bc85699c1d50b3672293832c3dd05c7037da))
* resume escalated epic attempts ([7980b9e](https://github.com/mintopia/harmonic/commit/7980b9e65dec49eae25ae4a9890d56d2a7218af8))
* run task verification stages in place ([ef6ee3e](https://github.com/mintopia/harmonic/commit/ef6ee3ecdc1d1c92bf6a3c770cae524dd4197efa))
* **settings:** add staged verification editors ([fe4b47c](https://github.com/mintopia/harmonic/commit/fe4b47c135b64456c4edb1da120d1d4cd4ad4044))
* show epic verifier stage status ([ef0850f](https://github.com/mintopia/harmonic/commit/ef0850f8b63f517030f6cd2a1ac76b64be72df22))
* show individual verifier steps ([3a262e9](https://github.com/mintopia/harmonic/commit/3a262e92171e1f8b507c202a489d185d2bc8ea99))
* **verification:** stage verifier configuration ([fa20b6f](https://github.com/mintopia/harmonic/commit/fa20b6fb7b004ccabba3533e22403b3bf36759bb))


### Bug Fixes

* approve conversation permissions via ACP outcome envelope ([159d3c6](https://github.com/mintopia/harmonic/commit/159d3c666ee06f21e6947a56c269a463741d5791))
* **epics:** omit absent prompt fields ([9d716b4](https://github.com/mintopia/harmonic/commit/9d716b428c59229d4a50876307f6054f6ef2a7af))
* green the staged-verification CI failures ([4f4bc76](https://github.com/mintopia/harmonic/commit/4f4bc7680c559487da363f85698dbe885b675353))
* keep single verifier tabs visible ([41a16f2](https://github.com/mintopia/harmonic/commit/41a16f2dd26acf03b41865b27d2776868beb731f))
* select verifier by step identity ([8d28693](https://github.com/mintopia/harmonic/commit/8d286932804a74ac93be3018575f2643c6a44f2c))
* **web:** close hairline gaps in lifecycle stepper connector line ([f24a66e](https://github.com/mintopia/harmonic/commit/f24a66e08f7cfd72528b3d5bc1d00dd6725783c8))
* **web:** stream attempt transcript live without a hard refresh ([06ca098](https://github.com/mintopia/harmonic/commit/06ca098f9817936fc0eb4a19b240d0296e2cb695))

## [2.3.0](https://github.com/mintopia/harmonic/compare/v2.2.0...v2.3.0) (2026-09-08)


### Features

* **cli:** add a version command ([6b8c7c4](https://github.com/mintopia/harmonic/commit/6b8c7c44a6d2b75bce27420b26023a3ea973eb7f))
* **tracker:** detect free-tier GitLab epics and blocked-by sections ([eef78c6](https://github.com/mintopia/harmonic/commit/eef78c6a0331eb91ecec7b3f02d30f0a6a3d0e8a))

## [2.2.0](https://github.com/mintopia/harmonic/compare/v2.1.0...v2.2.0) (2026-09-08)


### Features

* **conversation:** render markdown and answer agent questions in chat ([01146ba](https://github.com/mintopia/harmonic/commit/01146ba777704e8a6e7618d87e3ced6ae479ccc8))


### Bug Fixes

* **acp:** guard harness-exit promise against unhandled rejection on shutdown SIGKILL ([83da0f0](https://github.com/mintopia/harmonic/commit/83da0f0f48a7168094c22045620feb8810cce5ff))
* **conversation:** advertise elicitation form capability as an object ([5c2c3ea](https://github.com/mintopia/harmonic/commit/5c2c3ea32693aedc0b94debd0d108c128e2561db))
* **conversation:** scroll the question form body, pin its actions ([2276114](https://github.com/mintopia/harmonic/commit/2276114b18e03ce03db77ccdde2c4750b7286b6c))
* **settings:** don't dim baseline fields on the global settings surface ([5028960](https://github.com/mintopia/harmonic/commit/50289604e059bb92bf666f4c61bcec0e32b464d6))

## [2.1.0](https://github.com/mintopia/harmonic/compare/v2.0.0...v2.1.0) (2026-09-07)


### Features

* add harness discovery capabilities ([4895edf](https://github.com/mintopia/harmonic/commit/4895edf74a459c933ba46e03b465d71998e1dfeb))
* add resume warmth countdown UI ([914dd87](https://github.com/mintopia/harmonic/commit/914dd8786a443d6be8057345f84f0281174e6a8a))
* add worktree inventory API ([99c5f44](https://github.com/mintopia/harmonic/commit/99c5f444025fdcb1e87f8b6cf4757028235d0946))
* **api:** parent filter on GET /api/tasks for Epic children ([#411](https://github.com/mintopia/harmonic/issues/411)) ([f13cc07](https://github.com/mintopia/harmonic/commit/f13cc076b8a6de8345bf3dbc06e0afe96c78131e))
* **api:** resolve any epic (incl. closed) from GET /api/epics/:ref ([#409](https://github.com/mintopia/harmonic/issues/409)) ([6467e01](https://github.com/mintopia/harmonic/commit/6467e01544bf4ad1628e5b7ceb63e906f20aa3f6))
* collect OpenCode native usage ([287b04d](https://github.com/mintopia/harmonic/commit/287b04d3e82668d9b371f6e3b2c56a78b8f32170))
* **config:** add baseline config layering ([9c0cad1](https://github.com/mintopia/harmonic/commit/9c0cad1a20ccc4247953f25cc9d125fc76dc96d8))
* **config:** add per-harness model catalogs ([d46e648](https://github.com/mintopia/harmonic/commit/d46e648fbe8fbcb89dc4a08a4751fbef57557f78))
* **db,epics:** converge the schema on boot; finished Epics leave the Board ([2cad0a9](https://github.com/mintopia/harmonic/commit/2cad0a9a0b69a07729a8952bba92255c335a3304))
* **drive:** route Map-Epic children to /wayfinder {mapRef} ([#440](https://github.com/mintopia/harmonic/issues/440)) ([62a4200](https://github.com/mintopia/harmonic/commit/62a4200ebfe86fae8d90543c309d2e576dad46e3))
* **epics:** capture merge-commit + member snapshot at Epic integration ([#438](https://github.com/mintopia/harmonic/issues/438)) ([dc8072b](https://github.com/mintopia/harmonic/commit/dc8072b793550a04fa29bf89a47519fe6ee5a61b))
* **epics:** close the Epic's tracker issue on completion ([#442](https://github.com/mintopia/harmonic/issues/442)) ([60a4c2c](https://github.com/mintopia/harmonic/commit/60a4c2c8a48bdd2eb04e201606c885b1dbb781f4))
* **epics:** resolve historical Epics from the stored record ([#439](https://github.com/mintopia/harmonic/issues/439)) ([086b770](https://github.com/mintopia/harmonic/commit/086b7704414396311c1ee0c9cdca3dc9d98cec41))
* **epics:** stored Epic spine populated on scan ([#437](https://github.com/mintopia/harmonic/issues/437)) ([0958da6](https://github.com/mintopia/harmonic/commit/0958da6829f29816ed49052740191a6b8482fd28))
* **epics:** surface historical Epics on the Board and Tasks list ([#439](https://github.com/mintopia/harmonic/issues/439)) ([0613918](https://github.com/mintopia/harmonic/commit/0613918e739ac52896632828fb7e562b5c5eade3))
* **epics:** whole-Epic diff on the Epic surface ([#441](https://github.com/mintopia/harmonic/issues/441)) ([e56ab17](https://github.com/mintopia/harmonic/commit/e56ab175f024d4c22b262e1200db1bdbc722b078))
* lane subagent transcripts, name tool calls, surface verification live ([0940d53](https://github.com/mintopia/harmonic/commit/0940d53fcd4b15b898368b99a81c37c6096ef433))
* **opencode:** discover local providers and models ([ac39677](https://github.com/mintopia/harmonic/commit/ac39677af76b1afa26fc8f9e6869960da551ecfd))
* render activity as read-only fleet lanes ([744dcfe](https://github.com/mintopia/harmonic/commit/744dcfef52ded510f68d7bd12c6247084eafcf49))
* show direct subagent lanes on activity ([14c59f4](https://github.com/mintopia/harmonic/commit/14c59f47b092c59c4218e932ab6be416bc5a0e25))
* show host load average in the header ([3c5651e](https://github.com/mintopia/harmonic/commit/3c5651e3f45705c38c1112a46663364912a132b9))
* **skills:** add read-only comment-check for the critic ([4469470](https://github.com/mintopia/harmonic/commit/446947066824fae5fbfefc23a3d9ffbaa74ae3d1))
* **stats:** attempt-activity heatmap on the fleet Stats page ([1c7d746](https://github.com/mintopia/harmonic/commit/1c7d74639d801c290ee4e3efafb6be576b6db8bf))
* **stats:** epic-scoped stats aggregation ([#410](https://github.com/mintopia/harmonic/issues/410)) ([377d0b7](https://github.com/mintopia/harmonic/commit/377d0b7945c4285262ea1036e3d3db25b4d009b8))
* **stats:** flow & throughput cards on the fleet Stats page ([#402](https://github.com/mintopia/harmonic/issues/402)) ([fee23d1](https://github.com/mintopia/harmonic/commit/fee23d1659ce0dec0c0f802d344ef0db91d04ef6))
* **stats:** task-grain, verification, guardrail & per-workspace aggregates (ADR-0014) ([60486d6](https://github.com/mintopia/harmonic/commit/60486d62e7848785f1fc68ad46d34854f925fa5b)), closes [#401](https://github.com/mintopia/harmonic/issues/401)
* **stats:** Verification & escalation card on the fleet Stats page ([#403](https://github.com/mintopia/harmonic/issues/403)) ([87c3dee](https://github.com/mintopia/harmonic/commit/87c3dee3bf83e3b3b3b8d958d9fd585f68c42658))
* **stats:** warm categorical token-class colour ramp (ADR-0014, [#407](https://github.com/mintopia/harmonic/issues/407)) ([33e1653](https://github.com/mintopia/harmonic/commit/33e165378cc94c4e4f889d4f0ffe706e4f09e6ef))
* **stats:** where-the-spend-goes workspace leaderboard ([#404](https://github.com/mintopia/harmonic/issues/404)) ([04d1484](https://github.com/mintopia/harmonic/commit/04d1484dfc7772ae61e2430da1385ae5435c925f))
* surface merge status live, live-update detail pages, critic for native tasks ([4700e6e](https://github.com/mintopia/harmonic/commit/4700e6ef6da6b2ac4efdcd327fe20b2bd5b02c86))
* **tasks:** source Tasks-list epic rows from the derived-epic model ([#418](https://github.com/mintopia/harmonic/issues/418)) ([82a8689](https://github.com/mintopia/harmonic/commit/82a8689c898a8db7248088d4ee0309aa9babd8e9))
* **ticket:** add per-Attempt Output-tokens-by-tool card ([#406](https://github.com/mintopia/harmonic/issues/406)) ([3ea12eb](https://github.com/mintopia/harmonic/commit/3ea12ebcb8c8d67ffa31dc27016c097a9cab6897))
* **tracker:** epic identification = top-level container ([#416](https://github.com/mintopia/harmonic/issues/416)) ([4364778](https://github.com/mintopia/harmonic/commit/4364778c29d67729a35174af0644a2b809e5a8ab))
* **tracker:** non-tombstoning demotion of mirrored epic Tasks ([#417](https://github.com/mintopia/harmonic/issues/417)) ([f23410c](https://github.com/mintopia/harmonic/commit/f23410c4049a86b1ee023ac0980cfc566c01c88b))
* **tracker:** recognize the `epic` label as a mirror container ([#415](https://github.com/mintopia/harmonic/issues/415)) ([09da54a](https://github.com/mintopia/harmonic/commit/09da54a56991d51224c46fbc14cc32abecde7acc))
* unify manual session resume ([b088a2b](https://github.com/mintopia/harmonic/commit/b088a2bd99478a590743027cecdf5fef4d77e9a1))
* **web:** accessibility and honest-copy sweep ([#458](https://github.com/mintopia/harmonic/issues/458)) ([b4b4e4c](https://github.com/mintopia/harmonic/commit/b4b4e4c25d182fd90ec96b3c769791ff69abd6c4))
* **web:** add harness discovery model picker ([fffda9a](https://github.com/mintopia/harmonic/commit/fffda9a6a4585f9674d02b989f8c4c8dd0349f19))
* **web:** collapsible closed-tasks section in the main-board Epic band ([d13062c](https://github.com/mintopia/harmonic/commit/d13062c8496736f971fd43875b27e1b6f29a29e5))
* **web:** detail-page rails drive the URL; Epic page gets a rail ([c5ee7c8](https://github.com/mintopia/harmonic/commit/c5ee7c873e3c4a5e90096fc1ed0b7bca00f9f749))
* **web:** Epic summary page ([#412](https://github.com/mintopia/harmonic/issues/412)) ([820c6ed](https://github.com/mintopia/harmonic/commit/820c6ed1af1b2dfd93b50950ec8eaeb1a4839481))
* **web:** in-progress members + status pips inside the Epic board band ([3965c4f](https://github.com/mintopia/harmonic/commit/3965c4fab720b6fdc7074980d64a6112b7473fd7)), closes [#422](https://github.com/mintopia/harmonic/issues/422)
* **web:** keep integrating Epics on the board with integration progress bar ([e9f0885](https://github.com/mintopia/harmonic/commit/e9f08854d3d15147dd958e3761e3de6aeb18917f)), closes [#424](https://github.com/mintopia/harmonic/issues/424)
* **web:** preview the native-task critic variant in Settings ([0a907a6](https://github.com/mintopia/harmonic/commit/0a907a6d4f5336e03024d2751679fdaaa23c4093))
* **web:** rename Table→Tasks, fix Epic rows, warm Stats token breakdowns ([b55e79c](https://github.com/mintopia/harmonic/commit/b55e79c483e21e88b1b1b9b567cf27f104207cce))
* **web:** route epic navigation via a tested focusedSurface seam ([#413](https://github.com/mintopia/harmonic/issues/413)) ([228813a](https://github.com/mintopia/harmonic/commit/228813abcad2cc9617754dc0074d66ea4c1c8243))
* **web:** show the prompt sent on the Implementation and Review subpages ([2154e62](https://github.com/mintopia/harmonic/commit/2154e624a8263ea3a63f3528194a245e830fedc3))
* **web:** spanner/cog settings icons, Tasks multi-select filters + Updated column, graph fixes ([ddfbc09](https://github.com/mintopia/harmonic/commit/ddfbc09827eb2dab08ed769882ece070a14593fc))
* **web:** unify ticket identity across listing views ([#456](https://github.com/mintopia/harmonic/issues/456)) ([392e131](https://github.com/mintopia/harmonic/commit/392e131f1f4c7d1070bc37b96d48d4a6578d6874))


### Bug Fixes

* **a11y:** resolve WCAG 2.1 AA sweep from issue [#472](https://github.com/mintopia/harmonic/issues/472) ([f20f278](https://github.com/mintopia/harmonic/commit/f20f278f61e038252ee03581c9046fe5b8a535b4))
* **afk:** Accept verifies the candidate first; force-Accept as-is override ([aa4a335](https://github.com/mintopia/harmonic/commit/aa4a335741814e6b51ed0f92c9aafa11c4b9f6d1))
* **afk:** bound the ACP prompt turn so a lost response ends the turn ([1699bc3](https://github.com/mintopia/harmonic/commit/1699bc379036e1b4ec2129cee422233dffd78a4c))
* **afk:** review the candidate, not the base, in the agent critic ([3212c30](https://github.com/mintopia/harmonic/commit/3212c305288a68bf5411fdc335f88136dbdefa21))
* **afk:** settle a merged Task done at boot so it is never re-picked ([e270c27](https://github.com/mintopia/harmonic/commit/e270c270fd7444766a96e61147dde2fdf186ff38))
* clear Sessions and scheduled jobs when deleting a Workspace ([5245fde](https://github.com/mintopia/harmonic/commit/5245fdefbd97ec4a563acd36ca282bc599af041f))
* commit file-backed tracker closes to base instead of orphaning them ([35df4ef](https://github.com/mintopia/harmonic/commit/35df4ef297f0223996df64dcd3935beb5c9dde4b))
* **config:** complete model catalog migration ([caf3f5c](https://github.com/mintopia/harmonic/commit/caf3f5c6069c1592b89fbe870cc9f792c2de3bb5))
* **config:** derive session warmth from harness catalog ([e420331](https://github.com/mintopia/harmonic/commit/e420331bc245cfd630d9cb1d093f29656af8d843))
* **config:** harden per-harness model catalog ([49f9d43](https://github.com/mintopia/harmonic/commit/49f9d434b2f5282e1c6ef469146e10ab0dda5bec))
* **config:** make baseline the sole defaults source ([3323a44](https://github.com/mintopia/harmonic/commit/3323a44fc37d27d019fac7be413947439fc3803b))
* **config:** preserve Claude cache warmth ([a9beb0c](https://github.com/mintopia/harmonic/commit/a9beb0c2c2e61c8a55e2e709d3787cb8340e3638))
* **config:** read compatibility prompts from baseline ([3c2161b](https://github.com/mintopia/harmonic/commit/3c2161bc1c3adbeddf850f59eee1153f79656f8f))
* **config:** remove retired cache TTL compatibility ([02e44ef](https://github.com/mintopia/harmonic/commit/02e44ef551e799e9d9ca91a1ae23f9a26dce68c5))
* Epic 496 review follow-ups (permission alert, dock, dead code) ([34974d3](https://github.com/mintopia/harmonic/commit/34974d3a45b4d077eafbd0544eca8fd9e59add7e))
* **epic:** surface epic-refresh outcomes instead of discarding them ([5c777f3](https://github.com/mintopia/harmonic/commit/5c777f3347caf015372c84475ccdff2764de936f))
* **execution:** let the critic judge a no-change finish; show the real escalation reason ([be25c6a](https://github.com/mintopia/harmonic/commit/be25c6ae4b8e6939d0aaef1876d27d4bad818142))
* **execution:** make agent lifecycle signals terminal and prompt ([9b56a6a](https://github.com/mintopia/harmonic/commit/9b56a6aa78c0a5df751d23a8ccb538e697d24285))
* **execution:** resume a warm Session from the dispatch worktree, not task.workingDir ([4817575](https://github.com/mintopia/harmonic/commit/48175754259ba05efe3514c4ff728301b7867e8e))
* **honesty:** surface disabled verifier state, gate progress bar on attempt evidence, fire ungated warning ([#470](https://github.com/mintopia/harmonic/issues/470)) ([a0d35bf](https://github.com/mintopia/harmonic/commit/a0d35bf05f996cfc47f1d1a071d999aa5d575e74))
* include node types in web typecheck ([24cf3a0](https://github.com/mintopia/harmonic/commit/24cf3a04080120f71d177ed49d5b1d46452951f5))
* label the running critic by its own harness and weave merge steps into the timeline ([7c08650](https://github.com/mintopia/harmonic/commit/7c08650e76d39b7f94bb96877df1f2a8a61ce42c))
* launch ACP adapters via node to survive non-executable npx bins ([2203d69](https://github.com/mintopia/harmonic/commit/2203d69f155936cd5b94a34ddf20a0c16ef5e8e8))
* log unhandled 500s to the server log ([e39a96e](https://github.com/mintopia/harmonic/commit/e39a96e7f1ff20ea91016c42a9020be1c3e6b6d6))
* OpenCode unattended auto-approve and durable transcripts ([a7c406f](https://github.com/mintopia/harmonic/commit/a7c406f38f8e2f84c77b8eca4059b1b4b47a0450))
* pin compatible TypeScript compiler ([53a809e](https://github.com/mintopia/harmonic/commit/53a809e65c7c52da15b7d3cd057bc0a3a6a16ca5))
* **recovery:** finish a merged-but-`ready` Task on boot; record ADR-0020 ([9a12f3d](https://github.com/mintopia/harmonic/commit/9a12f3d04545cdca026449b9617692e7b2e21c4d))
* **reliability:** isolate harness process groups + transactional schema-sync ([#471](https://github.com/mintopia/harmonic/issues/471)) ([dadcd8d](https://github.com/mintopia/harmonic/commit/dadcd8d464407424a4b4f6ddb9bf7d4113413070))
* repair pricing import paths broken by the [#445](https://github.com/mintopia/harmonic/issues/445)/[#446](https://github.com/mintopia/harmonic/issues/446) merge ([96c4b67](https://github.com/mintopia/harmonic/commit/96c4b6761d5ab14151d43fb7c6d73372074fb8db))
* **runner:** pin resolved defaults onto a task when it is claimed ([16ccabc](https://github.com/mintopia/harmonic/commit/16ccabc40e3b6bf458c5ae4e5fb9c2fbe03adcfe)), closes [#480](https://github.com/mintopia/harmonic/issues/480)
* **ticket:** draw the agent-vs-subagent donut when no subagents ran ([fd308d4](https://github.com/mintopia/harmonic/commit/fd308d45f6722d1d16bebf737fcaab5f64f24688))
* **ticket:** show all planned Attempt Step tabs before they start ([f8ce9af](https://github.com/mintopia/harmonic/commit/f8ce9af6e113a0c78a2b7ba56dd2f5b1d6716ec2))
* **ticket:** show the critic session by default on the Review tab ([103e145](https://github.com/mintopia/harmonic/commit/103e1456c6772b343165c9318861c4104f8c21d9))
* **tracker:** stop mirrored re-polls firing a task_changed firehose ([44a6be7](https://github.com/mintopia/harmonic/commit/44a6be7e703dfe6e1bcc6a7643685ee213bed1c4))
* **ui:** unify state colour so done stops rendering two greens ([#454](https://github.com/mintopia/harmonic/issues/454)) ([e1bb9ca](https://github.com/mintopia/harmonic/commit/e1bb9cad391413cef867c3f0bab3264ea933ec2b))
* **verification:** critic reads the ticket first, judges a no-change finish on it ([5ebbc3a](https://github.com/mintopia/harmonic/commit/5ebbc3a8cf3e764713d151c897d72e180c98183a))
* **verify:** provision node_modules in the detached verify worktree ([0f76cd7](https://github.com/mintopia/harmonic/commit/0f76cd7176ecb73f170f160a072702724e5ddc59))
* **verify:** restore dependencies in disposable worktrees ([c860d1a](https://github.com/mintopia/harmonic/commit/c860d1adb35ab70639e9959ce7a8192439eb393e))
* **verify:** symlink node_modules in disposable worktrees ([36f1661](https://github.com/mintopia/harmonic/commit/36f166100d50e0110e630584716bab2a9a6fb71b))
* **web:** count changed lines from --numstat, not the --stat bar graph ([38543d2](https://github.com/mintopia/harmonic/commit/38543d230cf5ce347629a650ed8b3260de93a33e))
* **web:** don't present keyboard-unreachable Board cards as clickable ([5fa135f](https://github.com/mintopia/harmonic/commit/5fa135f43780def832ec35f6f3e3291f22dc3ad1))
* **web:** full closed-ticket cards, uniform Epic pips, ready≠merged colour ([372e6b2](https://github.com/mintopia/harmonic/commit/372e6b24398251780da3b6509b987674c18521d7))
* **web:** give the Tasks-list ID column room for the dual ticket identity ([c3749e7](https://github.com/mintopia/harmonic/commit/c3749e7716e4b83f480d3dacdb39eff244bf5928))
* **web:** render EpicIntegrationBar in the board Epic band, not a missing component ([fd0d61a](https://github.com/mintopia/harmonic/commit/fd0d61a8d245162c43f2c028efebfb5c899c0cb1)), closes [#424](https://github.com/mintopia/harmonic/issues/424)
* **web:** resume-offer gating, paused status colour, pause controls polish ([55b806c](https://github.com/mintopia/harmonic/commit/55b806cce1c9ad5bfd24253beb1709322a7a0426))
* **web:** retire board epic-focus, make the Epic summary page the one Epic surface (ADR-0017) ([2613c0b](https://github.com/mintopia/harmonic/commit/2613c0b098a4bec83f0942f804a332b75fd89f16))
* **web:** silence exhaustive-deps in useScrollToPanel ([3203870](https://github.com/mintopia/harmonic/commit/32038701cf8a0b180940c6fc976bf84cbd91c43d))
* **ws:** restore mount-time load for firehose subscribers ([3a69187](https://github.com/mintopia/harmonic/commit/3a691874dc2e5388753cf01a3a4cf074636bafd8))
