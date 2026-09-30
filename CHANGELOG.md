## [1.1.9](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.8...v1.1.9) (2026-09-30)

### Bug Fixes

* stop scrubbing owner_email in preview environments ([c380e1f](https://github.com/ben-elliot-nice/webhook-listener/commit/c380e1f0c05a4f45d07ae7c417bb8147833c7cfa))

## [1.1.8](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.7...v1.1.8) (2026-09-30)

### Bug Fixes

* push WL_SESSION_SECRET and RESEND_API_KEY to every preview Worker ([8fb3c43](https://github.com/ben-elliot-nice/webhook-listener/commit/8fb3c432dd88e9c3bef349e17ce13485403da3b1))

## [1.1.7](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.6...v1.1.7) (2026-09-30)

### Documentation

* note the magic-link-send-failure lockout bug in backlog ([7861ab8](https://github.com/ben-elliot-nice/webhook-listener/commit/7861ab8df32d05c606adfbae823f16e7436a93fd))

## [1.1.6](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.5...v1.1.6) (2026-09-30)

### Bug Fixes

* point preview frontend builds at their own backend Worker ([3a28144](https://github.com/ben-elliot-nice/webhook-listener/commit/3a2814416be7e2f7419ea03545243fce61284bd9)), closes [#13](https://github.com/ben-elliot-nice/webhook-listener/issues/13)

## [1.1.5](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.4...v1.1.5) (2026-09-30)

### Documentation

* add preview environment smoke-test item to backlog ([9266fe7](https://github.com/ben-elliot-nice/webhook-listener/commit/9266fe7db0424123fad270626169e84d0539e494))

## [1.1.4](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.3...v1.1.4) (2026-09-30)

### Bug Fixes

* only write provision.mjs's final JSON line to GITHUB_OUTPUT ([597dd57](https://github.com/ben-elliot-nice/webhook-listener/commit/597dd573bfbe64a2bb2e9257c9dbd5b7760153fe)), closes [#12](https://github.com/ben-elliot-nice/webhook-listener/issues/12)

## [1.1.3](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.2...v1.1.3) (2026-09-30)

### Bug Fixes

* serialize deploy-preview and teardown per PR ([7fef031](https://github.com/ben-elliot-nice/webhook-listener/commit/7fef031cb8ee72907bb9c15527ab3be854269893))

## [1.1.2](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.1...v1.1.2) (2026-09-30)

### Bug Fixes

* point d1 migrations apply at the generated per-PR wrangler config ([8ff7859](https://github.com/ben-elliot-nice/webhook-listener/commit/8ff78592543af98ca31ca3d4ac84eae4a30442d7)), closes [#12](https://github.com/ben-elliot-nice/webhook-listener/issues/12)

## [1.1.1](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.1.0...v1.1.1) (2026-09-30)

### Bug Fixes

* import preview DB data in dependency order, after migrating ([f61ad6d](https://github.com/ben-elliot-nice/webhook-listener/commit/f61ad6dcc661cba2aa502ac85709e6d5b4a7228c))

## [1.1.0](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.0.2...v1.1.0) (2026-09-30)

### Features

* add Cloudflare D1 database lifecycle helper ([31450b8](https://github.com/ben-elliot-nice/webhook-listener/commit/31450b8686db62371403e0812fa686e98622ceec))
* add per-PR wrangler config generator ([1d844c1](https://github.com/ben-elliot-nice/webhook-listener/commit/1d844c1c89e38fbdbfd0fc1ec282ea0114fa001e))
* add PR comment upsert script for preview environments ([3e30b60](https://github.com/ben-elliot-nice/webhook-listener/commit/3e30b6005912642e1179172df6bbae4da7177dc1))
* add preview environment data scrub script ([c3c348a](https://github.com/ben-elliot-nice/webhook-listener/commit/c3c348abddd3f46f5b3fd4c16e1fb2f5d810b51e))
* add preview environment provision and teardown orchestration ([ebf80d1](https://github.com/ben-elliot-nice/webhook-listener/commit/ebf80d111555ee44c52eb1add1060f146a7e1ba9))

### Documentation

* document PR preview environments ([4c9cfe5](https://github.com/ben-elliot-nice/webhook-listener/commit/4c9cfe54ae2156d8f39aafafc1f492b42dbc5ce2))

## [1.0.2](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.0.1...v1.0.2) (2026-09-30)

### Documentation

* add PR preview environments design spec ([87f8883](https://github.com/ben-elliot-nice/webhook-listener/commit/87f8883a1af93cfa38c4934248ac05fa0b6fab0a))
* add PR preview environments implementation plan ([7aca115](https://github.com/ben-elliot-nice/webhook-listener/commit/7aca115ceb237ae1c193e0885485599b93adffc1))

## [1.0.1](https://github.com/ben-elliot-nice/webhook-listener/compare/v1.0.0...v1.0.1) (2026-09-29)

### Documentation

* note the v1.0.0 release bootstrap reconciliation ([#11](https://github.com/ben-elliot-nice/webhook-listener/issues/11)) ([001c2b9](https://github.com/ben-elliot-nice/webhook-listener/commit/001c2b9e21f2fd85cf9e78d9464cf7aebf4ac660))

## 1.0.0 (2026-09-29)

### Features

* add script to sync package versions on release ([fbd206b](https://github.com/ben-elliot-nice/webhook-listener/commit/fbd206b88c744837048322388af4a16c1303ab14))
* **backend:** add /hook/:id capture route ([cc19935](https://github.com/ben-elliot-nice/webhook-listener/commit/cc1993592b1cc46f091324d3b63b83171c740b8f))
* **backend:** add anonymous session cookie assignment ([458b495](https://github.com/ben-elliot-nice/webhook-listener/commit/458b495e1ec4ca1a0d949b32cfe89562f1659fdd))
* **backend:** add Fastify server and listener API routes ([e90e053](https://github.com/ben-elliot-nice/webhook-listener/commit/e90e05305cb22693a2c46b0cfd1721d331c22d2b))
* **backend:** add GET /api/listeners route ([33b3407](https://github.com/ben-elliot-nice/webhook-listener/commit/33b34079704df4a39e47ad3d99f4c9bc83ceea73))
* **backend:** add getListenersForOwner repository function ([01b9a53](https://github.com/ben-elliot-nice/webhook-listener/commit/01b9a53b776cbb0537b8a4ba637d045b2ebbe3f0))
* **backend:** add listener repository ([c4d2edd](https://github.com/ben-elliot-nice/webhook-listener/commit/c4d2edd0bfe747a126f68d20fbad9a5bc7130d4d))
* **backend:** add owner_session column migration ([44ad0e5](https://github.com/ben-elliot-nice/webhook-listener/commit/44ad0e5164515b5cd7e277708e699f901b34896d))
* **backend:** add owner-session repository support ([4449246](https://github.com/ben-elliot-nice/webhook-listener/commit/444924660fd314727fa2451d67ca7989cda07d27))
* **backend:** add process entrypoint and Dockerfile ([d66bd64](https://github.com/ben-elliot-nice/webhook-listener/commit/d66bd6425c2df48a5c101f9168bc811cd0ce6602))
* **backend:** add public read-only shared requests route ([16ed906](https://github.com/ben-elliot-nice/webhook-listener/commit/16ed9068ea344f82283facde70d5b7d15b4e2745))
* **backend:** add request repository with retention cap ([cd363fb](https://github.com/ben-elliot-nice/webhook-listener/commit/cd363fb5ceca90d7e58f573ede0c4d1b4b5bbf21))
* **backend:** add share link management endpoints ([ab8fbc7](https://github.com/ben-elliot-nice/webhook-listener/commit/ab8fbc7fcce372d612f10455664b23bf854d8723))
* **backend:** add share_token migration and repository functions ([69300cf](https://github.com/ben-elliot-nice/webhook-listener/commit/69300cfd58deabb35007f37e97db544aa97393a9))
* **backend:** add slug set/rotate/remove and label routes ([106c0bd](https://github.com/ben-elliot-nice/webhook-listener/commit/106c0bd379d8c63dea45103dc58db097d2f3eac9))
* **backend:** add slug, label, and token columns + repo functions ([4004d7e](https://github.com/ben-elliot-nice/webhook-listener/commit/4004d7e3b388c0379b78775115e16bd96549dc48))
* **backend:** gate owner-only listener routes by session ([46a64b1](https://github.com/ben-elliot-nice/webhook-listener/commit/46a64b18f711e341f1cf5f952f2f58bf3ce4295a))
* **backend:** gate slug-based hook capture behind X-Webhook-Token ([168d8ef](https://github.com/ben-elliot-nice/webhook-listener/commit/168d8eff68c8bc84fee9f4dfa2dd2e268f37975d))
* **backend:** port /api/listeners CRUD + share routes to Hono ([53ee048](https://github.com/ben-elliot-nice/webhook-listener/commit/53ee048061f4c098d57c8041cfe14a790cd769b6))
* **backend:** port /api/shared/:token/requests route to Hono ([ee3b793](https://github.com/ben-elliot-nice/webhook-listener/commit/ee3b7931f6a118aeaca81d2f6f4c3e209b0fdd9c))
* **backend:** port /hook/:id capture route to Hono ([d2b0159](https://github.com/ben-elliot-nice/webhook-listener/commit/d2b01596484784bf4ce27a537319dcb4537768c6))
* **backend:** scaffold project and SQLite schema ([a0d7acc](https://github.com/ben-elliot-nice/webhook-listener/commit/a0d7accd350209d201ac22dfdc0c2bf941b220b6))
* **backend:** track last-request activity, add custom ordering and list sort modes ([417852d](https://github.com/ben-elliot-nice/webhook-listener/commit/417852d5f7819503cf60a2c2f1966a7db41c98b4))
* bring shared-with-me and shared-view nav/label fixes into main ([effab84](https://github.com/ben-elliot-nice/webhook-listener/commit/effab84370da683f68e4e9e5ac90773e37246ec8)), closes [#2](https://github.com/ben-elliot-nice/webhook-listener/issues/2) [#4](https://github.com/ben-elliot-nice/webhook-listener/issues/4)
* email access gate, post-auth redirect fix, and shared-with-me ([e4e8ea0](https://github.com/ben-elliot-nice/webhook-listener/commit/e4e8ea05dad5b4e5f8838c89780689318672d918))
* **frontend:** add API client functions for slug, label, and reorder ([461dbf9](https://github.com/ben-elliot-nice/webhook-listener/commit/461dbf9512dfdf7e59455c6279ce318ba9731340))
* **frontend:** add collapsible JSON tree to request detail view ([8d92d39](https://github.com/ben-elliot-nice/webhook-listener/commit/8d92d3982ee4e6bd58dadff807e052e9615b9a35))
* **frontend:** add diff-only viewing mode ([654c465](https://github.com/ben-elliot-nice/webhook-listener/commit/654c465407a3849d85ec0a1895bbb95a7b780f01))
* **frontend:** add Dockerfile and Nginx reverse proxy config ([3e2d16f](https://github.com/ben-elliot-nice/webhook-listener/commit/3e2d16f5e2f8c2d8fe8d49f6bc9953dad3da3c77))
* **frontend:** add favicon and header logo ([59e29be](https://github.com/ben-elliot-nice/webhook-listener/commit/59e29be942de5ac498fc707d901d0028e25ded85))
* **frontend:** add formatter controls to the Settings modal ([333b19c](https://github.com/ben-elliot-nice/webhook-listener/commit/333b19ca9700bdeb9e5230e93aeff73d573e0fe5))
* **frontend:** add home page and routing ([039081b](https://github.com/ben-elliot-nice/webhook-listener/commit/039081b853e6a9bd26a6a084fc52ba6a80a1ba1f))
* **frontend:** add JSON syntax highlighting and diff-vs-previous ([bf63e0d](https://github.com/ben-elliot-nice/webhook-listener/commit/bf63e0da8640d77c46db58d7dbd5720cc558c863))
* **frontend:** add JSON/HAR history export and per-row copy shortcut ([1a67e92](https://github.com/ben-elliot-nice/webhook-listener/commit/1a67e92ecab683501f5128f2476b56011d440fe9))
* **frontend:** add label editing and custom slug management to the listener page ([a24f764](https://github.com/ben-elliot-nice/webhook-listener/commit/a24f764908dc26205bb0e301c4b88690a46f9d77))
* **frontend:** add lazy-loaded highlight theme registry ([b68e9e7](https://github.com/ben-elliot-nice/webhook-listener/commit/b68e9e7396dfd03929782fb3b8799a3449cfeacf))
* **frontend:** add listener page with polling, copy, and delete ([a08227c](https://github.com/ben-elliot-nice/webhook-listener/commit/a08227c8290d9c4c6d85f774735ae6c43135006f))
* **frontend:** add read-only shared listener page ([f820c6b](https://github.com/ben-elliot-nice/webhook-listener/commit/f820c6bd72c7526cb0831bde830a8078403f2dce))
* **frontend:** add render, wrap, and row-striping toggles to JSON tree ([0610e86](https://github.com/ben-elliot-nice/webhook-listener/commit/0610e861886ba31f1d19383b2d30244e7b336e5b))
* **frontend:** add search/filter for captured requests ([59e5f1c](https://github.com/ben-elliot-nice/webhook-listener/commit/59e5f1c92882cf1fe4a2af5660921d8e63ea7794))
* **frontend:** add settings context, provider, and dark-mode plumbing ([862c758](https://github.com/ben-elliot-nice/webhook-listener/commit/862c7582338a8db6447744ae27ee61ecb276e961))
* **frontend:** add Settings modal with theme and width controls ([9e403c2](https://github.com/ben-elliot-nice/webhook-listener/commit/9e403c2dfdf0ba71347107781cf36c56a67f5b4e))
* **frontend:** add settings storage module ([56bc3d6](https://github.com/ben-elliot-nice/webhook-listener/commit/56bc3d6bfbd4b24b3a389b3cac244b36dcee5c41))
* **frontend:** add share link API client functions ([f39e70f](https://github.com/ben-elliot-nice/webhook-listener/commit/f39e70f56e2ab93c0869be523a06383c581ca30e))
* **frontend:** add share link controls to the owner listener page ([6a5c73e](https://github.com/ben-elliot-nice/webhook-listener/commit/6a5c73ef8a6198728fc7ae2d50c9210678200055))
* **frontend:** add sort control and drag-to-reorder to the listener list ([2fe0743](https://github.com/ben-elliot-nice/webhook-listener/commit/2fe0743865cbe54d5aea20ed97a3aa6195d450b2))
* **frontend:** add stripe intensity control for row striping ([9994d3b](https://github.com/ben-elliot-nice/webhook-listener/commit/9994d3b8fdfa5ab953962a4b778df6e7cce5693a))
* **frontend:** add Tailwind-based visual pass to Home and Listener pages ([d072d99](https://github.com/ben-elliot-nice/webhook-listener/commit/d072d99470e98b92dba2c9e45ad4725ed68b11ba))
* **frontend:** point api.ts at an absolute, credentialed API base URL; add Workers static-assets config ([955729c](https://github.com/ben-elliot-nice/webhook-listener/commit/955729ce6663bf9af191af73b46ab9325c2ab63d))
* **frontend:** rebrand to NiCE Labs logo and move it into shared top bar ([6b4e520](https://github.com/ben-elliot-nice/webhook-listener/commit/6b4e520b24c90bf34a1f12602545e5f21dc38c31))
* **frontend:** render diff view through the syntax highlighter ([08f25e8](https://github.com/ben-elliot-nice/webhook-listener/commit/08f25e8e8b49880d95c371920e2e98b9bcf9e4a7))
* **frontend:** replace favicon with NiCE webhook mark ([9c9b0d7](https://github.com/ben-elliot-nice/webhook-listener/commit/9c9b0d718f0d2fa1dd8de4aa9bb4fbf5545e1a1f))
* **frontend:** retrofit dark mode and apply width setting ([16400fc](https://github.com/ben-elliot-nice/webhook-listener/commit/16400fc3d232eead43347859feee79453ea6ec00))
* **frontend:** scaffold Vite/React project and API client ([d02a8bb](https://github.com/ben-elliot-nice/webhook-listener/commit/d02a8bba514204a4b99d15602f5c9b88ca67c856))
* **frontend:** show the session's own listeners on the home page ([3352a8d](https://github.com/ben-elliot-nice/webhook-listener/commit/3352a8dd6faedc244b984a9d614bd38c661aaa29))
* **frontend:** wire highlight theme, indent, compact, and line numbers into detail view ([982c836](https://github.com/ben-elliot-nice/webhook-listener/commit/982c836c9fb2600105222fb3004d4d6bb45219ec))
* projects — create-and-send hook, frontend UI, and management (label/share/delete/manual-create/sort) ([#1](https://github.com/ben-elliot-nice/webhook-listener/issues/1)) ([3f41aff](https://github.com/ben-elliot-nice/webhook-listener/commit/3f41aff6d21443d78058f46d2bf4032c66264c5f))
* wire backend and frontend into docker-compose ([d4a2c07](https://github.com/ben-elliot-nice/webhook-listener/commit/d4a2c0758cd7e3b0a9a14fd6798f08ca23019bf0))

### Bug Fixes

* address final cross-task review findings for CF Workers migration ([3380c9b](https://github.com/ben-elliot-nice/webhook-listener/commit/3380c9bc694d073b8e8d62d45829f7841186de5e))
* **backend:** add stable tie-breaker to getListenersForOwner ordering ([dbac036](https://github.com/ben-elliot-nice/webhook-listener/commit/dbac036fcb56862d2053a5bddf67362e7a746a94))
* **backend:** augment cloudflare:test ProvidedEnv with Env + TEST_MIGRATIONS ([a8541d6](https://github.com/ben-elliot-nice/webhook-listener/commit/a8541d68c60e5eb29c5c5d7ccc1ba5efc026335e))
* **backend:** namespace session cookie, validate incoming format, correct spec ([71ff08c](https://github.com/ben-elliot-nice/webhook-listener/commit/71ff08c7d22b77c98ed18efbb071d9c437a0fd8b))
* **backend:** preserve CORS headers on unhandled errors ([a010a30](https://github.com/ben-elliot-nice/webhook-listener/commit/a010a308b91d2b5b424994286b40de83526ebdf1))
* **backend:** redact session cookie from captured webhook headers ([1ca1e64](https://github.com/ben-elliot-nice/webhook-listener/commit/1ca1e64ebb626fe3c83ec89a6f44c1adedd9abbe))
* **backend:** reject a slug that collides with another listener's UUID ([08ab22f](https://github.com/ben-elliot-nice/webhook-listener/commit/08ab22f6b56b43c8ae35019904c80dcc5bf83744))
* **backend:** restore AUTOINCREMENT on requests.id, adjust schema test ([8bd90c5](https://github.com/ben-elliot-nice/webhook-listener/commit/8bd90c507546826be76de2febfe3acefcdfb89c2))
* **backend:** scope content-type parser override to hook route, raise body limit, quiet test logging ([13872d3](https://github.com/ben-elliot-nice/webhook-listener/commit/13872d382634ba18b7ae91caf1a3c57293d2c166))
* **backend:** send magic-link emails from noreply@nice-agentic.com ([dbc1253](https://github.com/ben-elliot-nice/webhook-listener/commit/dbc12532c156bae2c4bd8f7fefa4e3fae116fc22))
* **backend:** stop declaring WL_SESSION_SECRET/RESEND_API_KEY as plaintext vars ([a0f54d9](https://github.com/ben-elliot-nice/webhook-listener/commit/a0f54d927f203af8d74c5b17992caa0a2497866d))
* commit backend half of the returnTo redirect fix ([5063d30](https://github.com/ben-elliot-nice/webhook-listener/commit/5063d300d31c8fd8204f895fb42727bb46b83990)), closes [#2](https://github.com/ben-elliot-nice/webhook-listener/issues/2)
* commit the missing [env.staging] Wrangler config ([c18b38e](https://github.com/ben-elliot-nice/webhook-listener/commit/c18b38ed606a60cf1af51595c9f447763e22a686))
* **frontend:** add error handling to mutations, fix queryParams type, reset 404 counter on id change ([4819e94](https://github.com/ben-elliot-nice/webhook-listener/commit/4819e94dd6851977eac78195d688ba126af2f29f))
* **frontend:** add missing dark-mode variants to status-color accents ([a142d71](https://github.com/ben-elliot-nice/webhook-listener/commit/a142d717e9f701e8008a89a9b4246ad403d9899f))
* **frontend:** contain JSON tree overflow and left-justify collapse arrows ([aee58b4](https://github.com/ben-elliot-nice/webhook-listener/commit/aee58b4dd9222bfc9d194c1672bbcf3e173fb8df))
* **frontend:** correct dark placeholder class in RequestFilters ([4d14a81](https://github.com/ben-elliot-nice/webhook-listener/commit/4d14a81c656c1cbc5e2d766845a25b3d634f3a60))
* **frontend:** distinctly label webhook URL vs share link boxes ([656f067](https://github.com/ben-elliot-nice/webhook-listener/commit/656f0678a8e210b23a7e4cdb13d4671a9880184d))
* **frontend:** only stop polling after repeated 404s, keep retrying on other errors ([924243e](https://github.com/ben-elliot-nice/webhook-listener/commit/924243e5423d4b7731774a6bf7929b7de93f6116))
* **frontend:** restore line-number and indent-width settings in JSON tree ([1b24161](https://github.com/ben-elliot-nice/webhook-listener/commit/1b24161f9be6f6b17204ddc642753d8837ace69a))
* **frontend:** set drag transfer data for cross-browser drag-and-drop ([eb263d5](https://github.com/ben-elliot-nice/webhook-listener/commit/eb263d51545110a8107006e2c38fe6e2fafea470))
* **frontend:** update favicon image ([b8534e6](https://github.com/ben-elliot-nice/webhook-listener/commit/b8534e6fb0203268c9510844f101e5e9323a3930))
* two-step magic-link confirmation, authError display bug, restore branding ([6a3e6ac](https://github.com/ben-elliot-nice/webhook-listener/commit/6a3e6ac41e2abe8f8e2765d76747343aa073004d))

### Documentation

* add CI and automated release management design spec ([1d6ac13](https://github.com/ben-elliot-nice/webhook-listener/commit/1d6ac131fc1946edfd8325e63316b76e972e09dc))
* add CI and automated release management implementation plan ([6e06e35](https://github.com/ben-elliot-nice/webhook-listener/commit/6e06e35273a0d7af619e75dd3baba2f4eee530ed))
* add Cloudflare Workers migration design spec ([2621559](https://github.com/ben-elliot-nice/webhook-listener/commit/2621559ee1c8f8a65422d2080c1a9d4f8ddce36e))
* add Cloudflare Workers migration implementation plan ([3e4c528](https://github.com/ben-elliot-nice/webhook-listener/commit/3e4c52896bceafa9330c9db159aa4283bc8b59a6))
* add combined settings/formatter design spec ([64994e8](https://github.com/ben-elliot-nice/webhook-listener/commit/64994e8a91a8706c6247dedc543b9d3bf4eb87c7))
* add design spec for listener slug, label, and ordering ([b2b948a](https://github.com/ben-elliot-nice/webhook-listener/commit/b2b948afc333f2add613c7fa3262015bf19c10f0))
* add design spec for settings (theme/width) and diff-only mode ([87659b5](https://github.com/ben-elliot-nice/webhook-listener/commit/87659b564f83ef3d2106f5a4c4e579853e916ccb))
* add email access gate design spec ([205937e](https://github.com/ben-elliot-nice/webhook-listener/commit/205937e17de1c6d9ff92b02f3ad6d5a239211a19))
* add home page listener list design spec ([38a6aee](https://github.com/ben-elliot-nice/webhook-listener/commit/38a6aee86702ce35656241c558579dd13f0ec5fc))
* add home page listener list implementation plan ([6be223c](https://github.com/ben-elliot-nice/webhook-listener/commit/6be223cf467dfd4d2fdcd746d7ea497f89f2a6b1))
* add implementation plan for listener slug, label, and ordering ([8a0fc7e](https://github.com/ben-elliot-nice/webhook-listener/commit/8a0fc7e2d482e1cadeb1ae58fff67580ae05f5cd))
* add projects and create-and-send hook design spec ([5cf4643](https://github.com/ben-elliot-nice/webhook-listener/commit/5cf4643bb5b9013e0da27afb23c23e60523aca74))
* add session-scoped listener ownership design spec ([20491e6](https://github.com/ben-elliot-nice/webhook-listener/commit/20491e6761ce8594e276b8f85eef7710e0ee1827))
* add session-scoped listener ownership implementation plan ([ee1f271](https://github.com/ben-elliot-nice/webhook-listener/commit/ee1f2712348c94f8757c353f29600f403283c824))
* add settings and formatter implementation plan ([fc338e2](https://github.com/ben-elliot-nice/webhook-listener/commit/fc338e246188d055eee5c5fcb4068c16002066ce))
* add shareable read-only view design spec ([09baae1](https://github.com/ben-elliot-nice/webhook-listener/commit/09baae10b9c6d93f3796520f3ddfe27f0bd14385))
* add shareable read-only view implementation plan ([66a9a6a](https://github.com/ben-elliot-nice/webhook-listener/commit/66a9a6af4a8138a6de597cf71f1f81034ce8140c))
* add webhook listener design spec ([8d2025c](https://github.com/ben-elliot-nice/webhook-listener/commit/8d2025c6d0aa6756841c49ea9ca57c1ecc2c7480))
* add webhook listener implementation plan ([9592dc0](https://github.com/ben-elliot-nice/webhook-listener/commit/9592dc0573a33b59e19424c9d02e8576ac02db05))
* document the CI/release automation pipeline ([09a1507](https://github.com/ben-elliot-nice/webhook-listener/commit/09a1507ee220e9b57de5fdbe6bb795644a15e1e2))
* fix stale session_id cookie-name references in spec ([de3cfad](https://github.com/ben-elliot-nice/webhook-listener/commit/de3cfadf82bc68b2eca756a37e8bad44d50c492e))
* narrow shareable-view security guarantee to app-generated fields ([4b654cf](https://github.com/ben-elliot-nice/webhook-listener/commit/4b654cfaf9c8862760d916ae30b2f28db368e45a))
* pin superpowers workflow stages to Sonnet, never Opus/Fable ([7c61892](https://github.com/ben-elliot-nice/webhook-listener/commit/7c6189253dc0524e607f9f52601df65067ea0bb0))
* record settings and formatter feature in handoff notes ([a8a895c](https://github.com/ben-elliot-nice/webhook-listener/commit/a8a895c4ae4ae6986661b5828d2d2aab8186f86b))
* replace stale HANDOFF.md with CLAUDE.md, STATUS.md, BACKLOG.md ([c2ee2af](https://github.com/ben-elliot-nice/webhook-listener/commit/c2ee2afc989e6884b257b651c0e5708a9b8758d5))
* restore dropped list-view-actions backlog item, add JSON tree note ([1e8588b](https://github.com/ben-elliot-nice/webhook-listener/commit/1e8588bb50fd4fb53c76a63f031910ebe77e4041))
* switch git workflow to worktree + PR/merge, retire direct-to-main ([c66508d](https://github.com/ben-elliot-nice/webhook-listener/commit/c66508dd35ec5d004ebbe8390373be3144b49fab))

### Code Refactoring

* **backend:** convert listeners.repo to async D1 calls ([13b2813](https://github.com/ben-elliot-nice/webhook-listener/commit/13b2813ce6a33437aad77158802c96bf3ddf0af9))
* **backend:** convert requests.repo to async D1 calls with batch() pruning ([50f9ab4](https://github.com/ben-elliot-nice/webhook-listener/commit/50f9ab4e43f5b91e8bcf0a7e47d4212ff6fb6be9))
* **backend:** replace Fastify server with Hono app + session/CORS middleware ([7b9ae0a](https://github.com/ben-elliot-nice/webhook-listener/commit/7b9ae0a457f8611c2561842fc6fa334f910407e5))
* **frontend:** parameterize prettyPrintBody with indent width and compact mode ([45e7850](https://github.com/ben-elliot-nice/webhook-listener/commit/45e78508d5fcdbfbc91621d0d76bc56f348d7a04))
* **frontend:** reorganize and restyle Settings modal ([3e8ce47](https://github.com/ben-elliot-nice/webhook-listener/commit/3e8ce4727504e7addfd01b487d38469af3b3e71f))
